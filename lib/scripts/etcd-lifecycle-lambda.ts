/**
 * Lambda code generation for etcd lifecycle management.
 * Handles EC2 instance termination lifecycle hooks for safe etcd member removal.
 */

import { getPythonRetryUtils } from './python-retry';
import { getPythonLoggingSetup } from './python-logging';
import { getPythonMetricsSetup } from './python-metrics';

export function createEtcdLifecycleLambdaCode(clusterName: string): string {
  return `
import json
import boto3
import os
import time

\${getPythonLoggingSetup()}

\${getPythonMetricsSetup()}

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

${getPythonRetryUtils()}

def handler(event, context):
    """
    Handle EC2 instance termination lifecycle hook for etcd cluster management.

    Ensures etcd member is safely removed before instance termination.
    If removal fails, we ABANDON the termination to protect cluster quorum.
    """
    logger = setup_logging(context)
    lifecycle_params = None
    start_time = time.time() * 1000  # For duration tracking
    metrics = create_metrics_logger('K8sCluster/EtcdLifecycle', context)

    try:
        logger.info("Received lifecycle event", extra={'event': event})

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
            try:
                metrics.flush()
            except Exception:
                pass
            return {'statusCode': 400, 'body': 'No instance ID'}

        instance_id = lifecycle_params['instance_id']
        logger.info("Processing instance termination", extra={'instance_id': instance_id})

        # Get instance details
        instance_info = get_instance_info(instance_id)
        if not instance_info:
            logger.warning("Instance not found - may already be terminated", extra={'instance_id': instance_id})
            complete_lifecycle_action(lifecycle_params, 'CONTINUE')
            try:
                metrics.flush()
            except Exception:
                pass
            return {'statusCode': 200, 'body': 'Instance not found, continuing'}

        private_ip = instance_info.get('PrivateIpAddress')

        # Look up etcd member in DynamoDB
        member_info = lookup_etcd_member(instance_id)

        if not member_info:
            logger.info("No etcd member record - not a control plane node or already removed", extra={'instance_id': instance_id})
            complete_lifecycle_action(lifecycle_params, 'CONTINUE')
            try:
                metrics.flush()
            except Exception:
                pass
            return {'statusCode': 200, 'body': 'Not an etcd member, continuing'}

        etcd_member_id = member_info.get('EtcdMemberId')
        if not etcd_member_id:
            logger.warning("Instance has member record but no EtcdMemberId", extra={'instance_id': instance_id})
            complete_lifecycle_action(lifecycle_params, 'CONTINUE')
            try:
                metrics.flush()
            except Exception:
                pass
            return {'statusCode': 200, 'body': 'No etcd member ID, continuing'}

        # Check quorum safety before proceeding
        check_quorum_safety(instance_id)

        # Get node name for drain operation (hostname from DynamoDB or derive from private IP)
        node_name = member_info.get('Hostname') or private_ip

        # Step 1: Drain the node (cordon + evict pods)
        logger.info("Draining node before removal", extra={'node_name': node_name, 'instance_id': instance_id})
        drain_success = drain_node_with_retry(node_name, instance_id)
        if drain_success:
            try:
                metrics.put_metric('NodeDrainSuccess', 1, COUNT)
            except Exception:
                pass
        else:
            logger.warning("Node drain failed, continuing with etcd removal", extra={'node_name': node_name})
            try:
                metrics.put_metric('NodeDrainFailure', 1, COUNT)
            except Exception:
                pass
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
            logger.info("Successfully removed etcd member", extra={'etcd_member_id': etcd_member_id, 'instance_id': instance_id})
            complete_lifecycle_action(lifecycle_params, 'CONTINUE')
            try:
                metrics.put_metric('EtcdMemberRemovalSuccess', 1, COUNT)
                duration_ms = time.time() * 1000 - start_time
                metrics.put_metric('LifecycleHandlerDuration', duration_ms, MILLISECONDS)
                metrics.flush()
            except Exception:
                pass
            return {'statusCode': 200, 'body': 'Success'}
        else:
            # Removal failed after all retries - ABANDON to protect cluster
            logger.error("Failed to remove etcd member after retries", extra={
                'etcd_member_id': etcd_member_id,
                'max_retries': MAX_RETRIES,
                'check': 'Verify etcd cluster health with etcdctl endpoint health and check SSM command history',
                'possible_causes': 'etcd cluster unhealthy, network issues, certificate problems, or SSM agent not running'
            })
            update_member_status(member_info, 'REMOVAL_FAILED', context.aws_request_id)
            complete_lifecycle_action(lifecycle_params, 'ABANDON')
            try:
                metrics.put_metric('EtcdMemberRemovalFailure', 1, COUNT)
                duration_ms = time.time() * 1000 - start_time
                metrics.put_metric('LifecycleHandlerDuration', duration_ms, MILLISECONDS)
                metrics.flush()
            except Exception:
                pass
            return {'statusCode': 500, 'body': 'etcd removal failed, abandoning termination'}

    except QuorumRiskError as e:
        logger.error("Quorum risk detected", extra={
            'error': str(e),
            'error_type': type(e).__name__,
            'check': 'Verify ASG health in EC2 console and review CloudWatch etcd metrics',
            'possible_causes': 'Multiple instances unhealthy, ASG scaling issues, or recent terminations'
        })
        if lifecycle_params:
            complete_lifecycle_action(lifecycle_params, 'ABANDON')
        try:
            metrics.put_metric('QuorumRiskDetected', 1, COUNT)
            duration_ms = time.time() * 1000 - start_time
            metrics.put_metric('LifecycleHandlerDuration', duration_ms, MILLISECONDS)
            metrics.flush()
        except Exception:
            pass
        return {'statusCode': 409, 'body': f'Quorum risk: {str(e)}'}

    except Exception as e:
        logger.error("Unexpected error during lifecycle handling", extra={
            'error': str(e),
            'error_type': type(e).__name__,
            'check': 'Review Lambda logs and check IAM permissions for EC2, SSM, DynamoDB, and ASG APIs',
            'possible_causes': 'IAM permission issues, network connectivity, or AWS service errors'
        }, exc_info=True)
        # On unexpected errors, ABANDON to be safe
        if lifecycle_params:
            complete_lifecycle_action(lifecycle_params, 'ABANDON')
        try:
            duration_ms = time.time() * 1000 - start_time
            metrics.put_metric('LifecycleHandlerDuration', duration_ms, MILLISECONDS)
            metrics.flush()
        except Exception:
            pass
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
        logger.error("Failed to update member status in DynamoDB", extra={
            'error': str(e),
            'member_id': member_info.get('MemberId'),
            'check': 'Verify DynamoDB table exists and Lambda has write permissions',
            'possible_causes': 'DynamoDB access denied, table not found, or network issues'
        })
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

    logger.info("Healthy control plane instances count", extra={'healthy_count': healthy_count, 'terminating_instance_id': terminating_instance_id})

    if healthy_count < MIN_HEALTHY_NODES_FOR_REMOVAL:
        raise QuorumRiskError(
            f"Only {healthy_count} healthy nodes remaining. "
            f"Need at least {MIN_HEALTHY_NODES_FOR_REMOVAL} to safely remove a member. "
            f"Check ASG health in EC2 console, verify instances are InService, and review CloudWatch etcd metrics."
        )


def drain_node_with_retry(node_name, terminating_instance_id):
    """Attempt to drain node with retries."""
    result = retry_with_backoff(
        lambda: drain_node(node_name, terminating_instance_id) or True,
        f"drain node {node_name}",
        max_retries=MAX_RETRIES,
        base_delay=RETRY_DELAY_SECONDS,
        retriable_exceptions=(NodeDrainError,)
    )
    return result is not None


def drain_node(node_name, terminating_instance_id):
    """
    Drain a Kubernetes node using kubectl via SSM.
    This cordons the node and evicts all pods gracefully.
    """
    logger.info("Starting node drain", extra={'node_name': node_name})

    # Find healthy control plane instance to execute kubectl on
    healthy_instances = get_healthy_control_plane_instances(exclude_instance=terminating_instance_id)

    if not healthy_instances:
        raise NodeDrainError(
            "No healthy control plane instances available for drain. "
            "All instances may be unhealthy or terminating. "
            "Check ASG status in EC2 console and verify instances are InService and passing health checks.",
            is_retriable=True
        )

    target_instance = healthy_instances[0]
    logger.info("Executing kubectl drain via SSM", extra={'target_instance': target_instance, 'node_name': node_name})

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
        logger.info("SSM drain command sent", extra={'command_id': command_id, 'target_instance': target_instance})
    except Exception as e:
        raise NodeDrainError(
            f"Failed to send SSM drain command: {str(e)}. "
            f"SSM agent may not be running or instance may be unreachable. "
            f"Check SSM agent status and IAM role permissions on the target instance.",
            is_retriable=True
        )

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
            logger.info("Drain command invocation not ready yet", extra={'command_id': command_id})
            continue

        status = result['Status']

        if status == 'Success':
            stdout = result.get('StandardOutputContent', '')
            logger.info("Drain command succeeded", extra={'command_id': command_id, 'output': stdout[:500] if stdout else ''})
            return

        elif status == 'InProgress' or status == 'Pending':
            continue

        elif status in ['Failed', 'Cancelled', 'TimedOut']:
            stderr = result.get('StandardErrorContent', '')
            stdout = result.get('StandardOutputContent', '')
            error_msg = stderr or stdout or 'Unknown error'

            # Check if node was not found (not an error)
            if 'not found' in error_msg.lower() or 'not found' in stdout.lower():
                logger.info("Node not found in cluster, treating as success", extra={'command_id': command_id})
                return

            raise NodeDrainError(
                f"kubectl drain failed with status {status}: {error_msg}. "
                f"Common causes: PodDisruptionBudgets blocking eviction, stuck pods, or unresponsive nodes. "
                f"Check pod status and PDB configurations in the cluster.",
                is_retriable=(status == 'TimedOut')
            )

    raise NodeDrainError(
        f"SSM drain command timed out after {DRAIN_TIMEOUT}s waiting for response. "
        f"Drain operation may be slow due to many pods or PodDisruptionBudgets. "
        f"Check pod eviction status and consider increasing DRAIN_TIMEOUT.",
        is_retriable=True
    )


def remove_etcd_member_with_retry(member_id, private_ip, terminating_instance_id):
    """Attempt to remove etcd member with retries."""
    result = retry_with_backoff(
        lambda: remove_etcd_member(member_id, private_ip, terminating_instance_id) or True,
        f"remove etcd member {member_id}",
        max_retries=MAX_RETRIES,
        base_delay=RETRY_DELAY_SECONDS,
        retriable_exceptions=(EtcdRemovalError,)
    )
    return result is not None


def remove_etcd_member(member_id, private_ip, terminating_instance_id):
    """Remove member from etcd cluster using etcdctl via SSM"""
    logger.info("Removing etcd member", extra={'member_id': member_id, 'private_ip': private_ip})

    # Find healthy control plane instance to execute etcdctl on
    healthy_instances = get_healthy_control_plane_instances(exclude_instance=terminating_instance_id)

    if not healthy_instances:
        raise EtcdRemovalError(
            "No healthy control plane instances available for etcd member removal. "
            "All instances may be unhealthy or terminating. "
            "Check ASG status in EC2 console and verify instances are InService and passing health checks.",
            is_retriable=True
        )

    target_instance = healthy_instances[0]
    logger.info("Executing etcdctl via SSM", extra={'target_instance': target_instance, 'member_id': member_id})

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
        logger.info("SSM command sent", extra={'command_id': command_id, 'target_instance': target_instance})
    except Exception as e:
        raise EtcdRemovalError(
            f"Failed to send SSM command for etcd removal: {str(e)}. "
            f"SSM agent may not be running or instance may be unreachable. "
            f"Check SSM agent status and IAM role permissions on the target instance.",
            is_retriable=True
        )

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
            logger.info("Command invocation not ready yet", extra={'command_id': command_id})
            continue

        status = result['Status']

        if status == 'Success':
            stdout = result.get('StandardOutputContent', '')
            logger.info("Command succeeded", extra={'command_id': command_id, 'output': stdout[:500] if stdout else ''})
            return

        elif status == 'InProgress' or status == 'Pending':
            continue

        elif status in ['Failed', 'Cancelled', 'TimedOut']:
            stderr = result.get('StandardErrorContent', '')
            stdout = result.get('StandardOutputContent', '')
            error_msg = stderr or stdout or 'Unknown error'

            # Check if member was already removed (not an error)
            if 'not found' in error_msg.lower() or 'already be removed' in stdout.lower():
                logger.info("Member already removed, treating as success", extra={'command_id': command_id})
                return

            raise EtcdRemovalError(
                f"etcdctl member remove failed with status {status}: {error_msg}. "
                f"Common causes: network issues between etcd members, certificate problems, or etcd cluster not healthy. "
                f"Check etcd endpoint health and verify certificates in /etc/kubernetes/pki/etcd/.",
                is_retriable=(status == 'TimedOut')
            )

    raise EtcdRemovalError(
        f"SSM command timed out after {SSM_COMMAND_TIMEOUT}s waiting for response. "
        f"etcd operation may be slow due to cluster state or network latency. "
        f"Check etcd cluster health and network connectivity between nodes.",
        is_retriable=True
    )


def get_healthy_control_plane_instances(exclude_instance=None):
    """Get list of healthy control plane instances, optionally excluding one"""
    asg_name = os.environ.get('CONTROL_PLANE_ASG_NAME')
    if not asg_name:
        logger.error("CONTROL_PLANE_ASG_NAME environment variable not set", extra={
            'check': 'Verify Lambda environment variables are configured in CDK stack',
            'possible_causes': 'Missing environment variable configuration in ControlPlaneStack'
        })
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

        logger.info("Found healthy control plane instances", extra={'healthy_count': len(healthy_instances)})
        return healthy_instances

    except Exception as e:
        logger.error("Error finding healthy control plane instances", extra={
            'error': str(e),
            'check': 'Verify ASG exists and Lambda has ec2:DescribeInstances and autoscaling:DescribeAutoScalingGroups permissions',
            'possible_causes': 'ASG not found, IAM permission issues, or AWS API errors'
        })
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
        logger.info("Completed lifecycle action", extra={'instance_id': params['instance_id'], 'result': result})
    except Exception as e:
        # This is critical - if we can't complete the action, the instance hangs
        logger.error("CRITICAL: Failed to complete lifecycle action", extra={
            'error': str(e),
            'instance_id': params['instance_id'],
            'check': 'Verify Lambda has autoscaling:CompleteLifecycleAction permission and lifecycle hook exists',
            'possible_causes': 'Lifecycle hook timeout exceeded, IAM permission issues, or invalid hook token'
        })

        # Try one more time with just instance ID (without token)
        try:
            autoscaling.complete_lifecycle_action(
                LifecycleHookName=params['hook_name'],
                AutoScalingGroupName=params['asg_name'],
                InstanceId=params['instance_id'],
                LifecycleActionResult=result
            )
            logger.info("Completed lifecycle action on retry (without token)", extra={'instance_id': params['instance_id']})
        except Exception as e2:
            logger.error("CRITICAL: Retry also failed - instance will hang until lifecycle hook timeout", extra={
                'error': str(e2),
                'instance_id': params['instance_id'],
                'check': 'Check ASG lifecycle hook configuration and Lambda IAM role',
                'possible_causes': 'Lifecycle hook may have already timed out or been completed by another process'
            })
            # At this point, the instance will time out based on the lifecycle hook timeout
`;
}
