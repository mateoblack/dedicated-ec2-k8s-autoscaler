/**
 * Lambda code generation for etcd lifecycle management.
 * Handles EC2 instance termination lifecycle hooks for safe etcd member removal.
 */

export function createEtcdLifecycleLambdaCode(clusterName: string): string {
  return `
import json
import boto3
import os
import logging
import time
from datetime import datetime

logger = logging.getLogger()
logger.setLevel(logging.INFO)

dynamodb = boto3.resource('dynamodb')
ec2 = boto3.client('ec2')
autoscaling = boto3.client('autoscaling')
ssm = boto3.client('ssm')

# Configuration
MAX_RETRIES = 3
RETRY_DELAY_SECONDS = 5
SSM_COMMAND_TIMEOUT = 60
DRAIN_TIMEOUT = 120  # Timeout for node drain operation
MIN_HEALTHY_NODES_FOR_REMOVAL = 2  # Need at least 2 healthy nodes to safely remove one

class NodeDrainError(Exception):
    """Raised when node drain fails"""
    def __init__(self, message, is_retriable=True):
        super().__init__(message)
        self.is_retriable = is_retriable

class EtcdRemovalError(Exception):
    """Raised when etcd member removal fails"""
    def __init__(self, message, is_retriable=True):
        super().__init__(message)
        self.is_retriable = is_retriable

class QuorumRiskError(Exception):
    """Raised when removal would risk etcd quorum"""
    pass

def handler(event, context):
    """
    Handle EC2 instance termination lifecycle hook for etcd cluster management.

    Ensures etcd member is safely removed before instance termination.
    If removal fails, we ABANDON the termination to protect cluster quorum.
    """
    lifecycle_params = None

    try:
        logger.info(f"Received event: {json.dumps(event)}")

        # Parse lifecycle hook event
        detail = event.get('detail', {})
        lifecycle_params = {
            'instance_id': detail.get('EC2InstanceId'),
            'hook_name': detail.get('LifecycleHookName'),
            'asg_name': detail.get('AutoScalingGroupName'),
            'token': detail.get('LifecycleActionToken')
        }

        if not lifecycle_params['instance_id']:
            logger.error("No instance ID found in event")
            return {'statusCode': 400, 'body': 'No instance ID'}

        instance_id = lifecycle_params['instance_id']
        logger.info(f"Processing termination for instance: {instance_id}")

        # Get instance details
        instance_info = get_instance_info(instance_id)
        if not instance_info:
            logger.warning(f"Instance {instance_id} not found - may already be terminated")
            complete_lifecycle_action(lifecycle_params, 'CONTINUE')
            return {'statusCode': 200, 'body': 'Instance not found, continuing'}

        private_ip = instance_info.get('PrivateIpAddress')

        # Look up etcd member in DynamoDB
        member_info = lookup_etcd_member(instance_id)

        if not member_info:
            logger.info(f"No etcd member record for instance {instance_id} - not a control plane node or already removed")
            complete_lifecycle_action(lifecycle_params, 'CONTINUE')
            return {'statusCode': 200, 'body': 'Not an etcd member, continuing'}

        etcd_member_id = member_info.get('EtcdMemberId')
        if not etcd_member_id:
            logger.warning(f"Instance {instance_id} has member record but no EtcdMemberId")
            complete_lifecycle_action(lifecycle_params, 'CONTINUE')
            return {'statusCode': 200, 'body': 'No etcd member ID, continuing'}

        # Check quorum safety before proceeding
        check_quorum_safety(instance_id)

        # Get node name for drain operation (hostname from DynamoDB or derive from private IP)
        node_name = member_info.get('Hostname') or private_ip

        # Step 1: Drain the node (cordon + evict pods)
        logger.info(f"Draining node {node_name} before removal...")
        drain_success = drain_node_with_retry(node_name, instance_id)
        if not drain_success:
            logger.warning(f"Node drain failed for {node_name}, continuing with etcd removal anyway")
            # We continue with etcd removal even if drain fails - better to remove the node
            # than leave it in a partially drained state

        # Step 2: Remove etcd member
        removal_success = remove_etcd_member_with_retry(
            etcd_member_id,
            private_ip,
            instance_id
        )

        if removal_success:
            # Update DynamoDB record
            update_member_status(member_info, 'REMOVED', context.aws_request_id)
            logger.info(f"Successfully removed etcd member {etcd_member_id}")
            complete_lifecycle_action(lifecycle_params, 'CONTINUE')
            return {'statusCode': 200, 'body': 'Success'}
        else:
            # Removal failed after all retries - ABANDON to protect cluster
            logger.error(f"Failed to remove etcd member {etcd_member_id} after {MAX_RETRIES} attempts")
            update_member_status(member_info, 'REMOVAL_FAILED', context.aws_request_id)
            complete_lifecycle_action(lifecycle_params, 'ABANDON')
            return {'statusCode': 500, 'body': 'etcd removal failed, abandoning termination'}

    except QuorumRiskError as e:
        logger.error(f"Quorum risk detected: {str(e)}")
        if lifecycle_params:
            complete_lifecycle_action(lifecycle_params, 'ABANDON')
        return {'statusCode': 409, 'body': f'Quorum risk: {str(e)}'}

    except Exception as e:
        logger.error(f"Unexpected error: {str(e)}", exc_info=True)
        # On unexpected errors, ABANDON to be safe
        if lifecycle_params:
            complete_lifecycle_action(lifecycle_params, 'ABANDON')
        return {'statusCode': 500, 'body': f'Error: {str(e)}'}


def get_instance_info(instance_id):
    """Get EC2 instance details"""
    try:
        response = ec2.describe_instances(InstanceIds=[instance_id])
        if response['Reservations']:
            return response['Reservations'][0]['Instances'][0]
        return None
    except ec2.exceptions.ClientError as e:
        if 'InvalidInstanceID' in str(e):
            return None
        raise


def lookup_etcd_member(instance_id):
    """Look up etcd member info from DynamoDB"""
    table = dynamodb.Table(os.environ['ETCD_TABLE_NAME'])

    response = table.query(
        IndexName='InstanceIdIndex',
        KeyConditionExpression='InstanceId = :iid',
        ExpressionAttributeValues={':iid': instance_id}
    )

    if response['Items']:
        return response['Items'][0]
    return None


def update_member_status(member_info, status, request_id):
    """Update etcd member status in DynamoDB"""
    table = dynamodb.Table(os.environ['ETCD_TABLE_NAME'])

    try:
        table.update_item(
            Key={
                'ClusterId': member_info['ClusterId'],
                'MemberId': member_info['MemberId']
            },
            UpdateExpression='SET #status = :status, UpdatedAt = :timestamp, RequestId = :rid',
            ExpressionAttributeNames={'#status': 'Status'},
            ExpressionAttributeValues={
                ':status': status,
                ':timestamp': datetime.utcnow().isoformat(),
                ':rid': request_id
            }
        )
    except Exception as e:
        logger.error(f"Failed to update member status: {str(e)}")
        # Don't raise - status update failure shouldn't block the operation


def check_quorum_safety(terminating_instance_id):
    """
    Check if removing this instance would risk etcd quorum.

    etcd requires a majority (n/2 + 1) of members to be healthy.
    For a 3-node cluster: need 2 healthy
    For a 5-node cluster: need 3 healthy
    """
    healthy_instances = get_healthy_control_plane_instances(exclude_instance=terminating_instance_id)
    healthy_count = len(healthy_instances)

    logger.info(f"Healthy control plane instances (excluding terminating): {healthy_count}")

    if healthy_count < MIN_HEALTHY_NODES_FOR_REMOVAL:
        raise QuorumRiskError(
            f"Only {healthy_count} healthy nodes remaining. "
            f"Need at least {MIN_HEALTHY_NODES_FOR_REMOVAL} to safely remove a member."
        )


def drain_node_with_retry(node_name, terminating_instance_id):
    """
    Attempt to drain node with retries.
    Returns True on success, False on failure.
    """
    last_error = None

    for attempt in range(1, MAX_RETRIES + 1):
        try:
            logger.info(f"Attempt {attempt}/{MAX_RETRIES} to drain node {node_name}")
            drain_node(node_name, terminating_instance_id)
            return True

        except NodeDrainError as e:
            last_error = e
            logger.warning(f"Drain attempt {attempt} failed: {str(e)}")

            if not e.is_retriable:
                logger.error("Drain error is not retriable, giving up")
                break

            if attempt < MAX_RETRIES:
                delay = RETRY_DELAY_SECONDS * (2 ** (attempt - 1))
                logger.info(f"Waiting {delay}s before retry...")
                time.sleep(delay)

        except Exception as e:
            last_error = e
            logger.error(f"Unexpected error draining node on attempt {attempt}: {str(e)}")

            if attempt < MAX_RETRIES:
                time.sleep(RETRY_DELAY_SECONDS)

    logger.error(f"All {MAX_RETRIES} drain attempts failed. Last error: {str(last_error)}")
    return False


def drain_node(node_name, terminating_instance_id):
    """
    Drain a Kubernetes node using kubectl via SSM.
    This cordons the node and evicts all pods gracefully.
    """
    logger.info(f"Draining node {node_name}")

    # Find healthy control plane instance to execute kubectl on
    healthy_instances = get_healthy_control_plane_instances(exclude_instance=terminating_instance_id)

    if not healthy_instances:
        raise NodeDrainError("No healthy control plane instances available for drain", is_retriable=True)

    target_instance = healthy_instances[0]
    logger.info(f"Executing kubectl drain on instance {target_instance}")

    # Execute kubectl drain via SSM
    # --ignore-daemonsets: DaemonSets can't be evicted
    # --delete-emptydir-data: Allow deletion of pods using emptyDir
    # --force: Force drain even if there are standalone pods
    # --grace-period=30: Give pods 30 seconds to terminate gracefully
    # --timeout=90s: Total timeout for the drain operation
    command = f\"\"\"
    set -e
    export KUBECONFIG=/etc/kubernetes/admin.conf

    # First check if the node exists
    if ! kubectl get node {node_name} &>/dev/null; then
        echo "Node {node_name} not found in cluster - may already be removed"
        exit 0
    fi

    # Cordon the node first (prevent new pods from being scheduled)
    echo "Cordoning node {node_name}..."
    kubectl cordon {node_name} || true

    # Drain the node (evict pods gracefully)
    echo "Draining node {node_name}..."
    kubectl drain {node_name} \\
        --ignore-daemonsets \\
        --delete-emptydir-data \\
        --force \\
        --grace-period=30 \\
        --timeout=90s || {{
            echo "Drain command returned non-zero, checking node status..."
            # Check if node is already drained/cordoned
            if kubectl get node {node_name} -o jsonpath='{{.spec.unschedulable}}' 2>/dev/null | grep -q "true"; then
                echo "Node is cordoned, drain may have partially succeeded"
                exit 0
            fi
            exit 1
        }}

    echo "Successfully drained node {node_name}"
    \"\"\"

    try:
        response = ssm.send_command(
            InstanceIds=[target_instance],
            DocumentName='AWS-RunShellScript',
            Parameters={{'commands': [command]}},
            TimeoutSeconds=DRAIN_TIMEOUT
        )
        command_id = response['Command']['CommandId']
        logger.info(f"SSM drain command sent: {command_id}")
    except Exception as e:
        raise NodeDrainError(f"Failed to send SSM drain command: {str(e)}", is_retriable=True)

    # Wait for command completion
    return wait_for_drain_command(command_id, target_instance)


def wait_for_drain_command(command_id, instance_id):
    """Wait for SSM drain command to complete"""
    max_wait = DRAIN_TIMEOUT + 30
    poll_interval = 5
    elapsed = 0

    while elapsed < max_wait:
        time.sleep(poll_interval)
        elapsed += poll_interval

        try:
            result = ssm.get_command_invocation(
                CommandId=command_id,
                InstanceId=instance_id
            )
        except ssm.exceptions.InvocationDoesNotExist:
            logger.info("Drain command invocation not ready yet...")
            continue

        status = result['Status']

        if status == 'Success':
            stdout = result.get('StandardOutputContent', '')
            logger.info(f"Drain command succeeded: {stdout}")
            return

        elif status == 'InProgress' or status == 'Pending':
            continue

        elif status in ['Failed', 'Cancelled', 'TimedOut']:
            stderr = result.get('StandardErrorContent', '')
            stdout = result.get('StandardOutputContent', '')
            error_msg = stderr or stdout or 'Unknown error'

            # Check if node was not found (not an error)
            if 'not found' in error_msg.lower() or 'not found' in stdout.lower():
                logger.info("Node not found in cluster, treating as success")
                return

            raise NodeDrainError(
                f"kubectl drain failed with status {status}: {error_msg}",
                is_retriable=(status == 'TimedOut')
            )

    raise NodeDrainError("SSM drain command timed out waiting for response", is_retriable=True)


def remove_etcd_member_with_retry(member_id, private_ip, terminating_instance_id):
    """
    Attempt to remove etcd member with retries and exponential backoff.
    Returns True on success, False on failure.
    """
    last_error = None

    for attempt in range(1, MAX_RETRIES + 1):
        try:
            logger.info(f"Attempt {attempt}/{MAX_RETRIES} to remove etcd member {member_id}")
            remove_etcd_member(member_id, private_ip, terminating_instance_id)
            return True

        except EtcdRemovalError as e:
            last_error = e
            logger.warning(f"Attempt {attempt} failed: {str(e)}")

            if not e.is_retriable:
                logger.error("Error is not retriable, giving up")
                break

            if attempt < MAX_RETRIES:
                delay = RETRY_DELAY_SECONDS * (2 ** (attempt - 1))  # Exponential backoff
                logger.info(f"Waiting {delay}s before retry...")
                time.sleep(delay)

        except Exception as e:
            last_error = e
            logger.error(f"Unexpected error on attempt {attempt}: {str(e)}")

            if attempt < MAX_RETRIES:
                time.sleep(RETRY_DELAY_SECONDS)

    logger.error(f"All {MAX_RETRIES} attempts failed. Last error: {str(last_error)}")
    return False


def remove_etcd_member(member_id, private_ip, terminating_instance_id):
    """Remove member from etcd cluster using etcdctl via SSM"""
    logger.info(f"Removing etcd member {member_id} with IP {private_ip}")

    # Find healthy control plane instance to execute etcdctl on
    healthy_instances = get_healthy_control_plane_instances(exclude_instance=terminating_instance_id)

    if not healthy_instances:
        raise EtcdRemovalError("No healthy control plane instances available", is_retriable=True)

    target_instance = healthy_instances[0]
    logger.info(f"Executing etcdctl on instance {target_instance}")

    # Execute etcdctl member remove via SSM
    command = f\"\"\"
    set -e
    export ETCDCTL_API=3
    export ETCDCTL_ENDPOINTS=https://127.0.0.1:2379
    export ETCDCTL_CACERT=/etc/kubernetes/pki/etcd/ca.crt
    export ETCDCTL_CERT=/etc/kubernetes/pki/etcd/server.crt
    export ETCDCTL_KEY=/etc/kubernetes/pki/etcd/server.key

    # Verify etcd is healthy before attempting removal
    if ! etcdctl endpoint health; then
        echo "ERROR: etcd endpoint not healthy"
        exit 1
    fi

    # Check if member exists
    if ! etcdctl member list | grep -q {member_id}; then
        echo "Member {member_id} not found - may already be removed"
        exit 0
    fi

    # Remove the member
    etcdctl member remove {member_id}
    echo "Successfully removed member {member_id}"
    \"\"\"

    try:
        response = ssm.send_command(
            InstanceIds=[target_instance],
            DocumentName='AWS-RunShellScript',
            Parameters={'commands': [command]},
            TimeoutSeconds=SSM_COMMAND_TIMEOUT
        )
        command_id = response['Command']['CommandId']
        logger.info(f"SSM command sent: {command_id}")
    except Exception as e:
        raise EtcdRemovalError(f"Failed to send SSM command: {str(e)}", is_retriable=True)

    # Wait for command completion
    return wait_for_ssm_command(command_id, target_instance)


def wait_for_ssm_command(command_id, instance_id):
    """Wait for SSM command to complete and handle result"""
    max_wait = SSM_COMMAND_TIMEOUT + 10
    poll_interval = 3
    elapsed = 0

    while elapsed < max_wait:
        time.sleep(poll_interval)
        elapsed += poll_interval

        try:
            result = ssm.get_command_invocation(
                CommandId=command_id,
                InstanceId=instance_id
            )
        except ssm.exceptions.InvocationDoesNotExist:
            logger.info("Command invocation not ready yet...")
            continue

        status = result['Status']

        if status == 'Success':
            stdout = result.get('StandardOutputContent', '')
            logger.info(f"Command succeeded: {stdout}")
            return

        elif status == 'InProgress' or status == 'Pending':
            continue

        elif status in ['Failed', 'Cancelled', 'TimedOut']:
            stderr = result.get('StandardErrorContent', '')
            stdout = result.get('StandardOutputContent', '')
            error_msg = stderr or stdout or 'Unknown error'

            # Check if member was already removed (not an error)
            if 'not found' in error_msg.lower() or 'already be removed' in stdout.lower():
                logger.info("Member already removed, treating as success")
                return

            raise EtcdRemovalError(
                f"etcdctl failed with status {status}: {error_msg}",
                is_retriable=(status == 'TimedOut')
            )

    raise EtcdRemovalError("SSM command timed out waiting for response", is_retriable=True)


def get_healthy_control_plane_instances(exclude_instance=None):
    """Get list of healthy control plane instances, optionally excluding one"""
    asg_name = os.environ.get('CONTROL_PLANE_ASG_NAME')
    if not asg_name:
        logger.error("CONTROL_PLANE_ASG_NAME environment variable not set")
        return []

    try:
        response = autoscaling.describe_auto_scaling_groups(
            AutoScalingGroupNames=[asg_name]
        )

        if not response['AutoScalingGroups']:
            return []

        asg = response['AutoScalingGroups'][0]
        instance_ids = [
            i['InstanceId'] for i in asg['Instances']
            if i['LifecycleState'] == 'InService' and i['InstanceId'] != exclude_instance
        ]

        if not instance_ids:
            return []

        # Verify instances are actually running
        response = ec2.describe_instances(InstanceIds=instance_ids)

        healthy_instances = []
        for reservation in response['Reservations']:
            for instance in reservation['Instances']:
                if instance['State']['Name'] == 'running':
                    healthy_instances.append(instance['InstanceId'])

        logger.info(f"Found {len(healthy_instances)} healthy control plane instances")
        return healthy_instances

    except Exception as e:
        logger.error(f"Error finding healthy instances: {str(e)}")
        return []


def complete_lifecycle_action(params, result):
    """
    Complete the lifecycle action. This MUST succeed or the instance will hang.

    Args:
        params: Dict with asg_name, hook_name, token, instance_id
        result: 'CONTINUE' to proceed with termination, 'ABANDON' to cancel
    """
    try:
        autoscaling.complete_lifecycle_action(
            LifecycleHookName=params['hook_name'],
            AutoScalingGroupName=params['asg_name'],
            LifecycleActionToken=params['token'],
            InstanceId=params['instance_id'],
            LifecycleActionResult=result
        )
        logger.info(f"Completed lifecycle action for {params['instance_id']} with result {result}")
    except Exception as e:
        # This is critical - if we can't complete the action, the instance hangs
        logger.error(f"CRITICAL: Failed to complete lifecycle action: {str(e)}")

        # Try one more time with just instance ID (without token)
        try:
            autoscaling.complete_lifecycle_action(
                LifecycleHookName=params['hook_name'],
                AutoScalingGroupName=params['asg_name'],
                InstanceId=params['instance_id'],
                LifecycleActionResult=result
            )
            logger.info(f"Completed lifecycle action on retry (without token)")
        except Exception as e2:
            logger.error(f"CRITICAL: Retry also failed: {str(e2)}")
            # At this point, the instance will time out based on the lifecycle hook timeout
`;
}
