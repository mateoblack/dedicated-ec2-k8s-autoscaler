import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as autoscaling from 'aws-cdk-lib/aws-autoscaling';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import { Construct } from 'constructs';

export interface ComputeStackProps {
  readonly clusterName: string;
  readonly controlPlaneRole: iam.Role;
  readonly workerNodeRole: iam.Role;
  readonly kmsKey: kms.IKey;
  readonly controlPlaneSecurityGroup: ec2.SecurityGroup;
  readonly workerSecurityGroup: ec2.SecurityGroup;
  readonly controlPlaneLoadBalancer: elbv2.NetworkLoadBalancer;
  readonly controlPlaneTargetGroup: elbv2.NetworkTargetGroup;
  readonly controlPlaneSubnets: ec2.ISubnet[];
  readonly workerSubnets: ec2.ISubnet[];
  readonly vpc: ec2.IVpc;
  readonly kubeletVersionParameter: ssm.StringParameter;
  readonly kubernetesVersionParameter: ssm.StringParameter;
  readonly containerRuntimeParameter: ssm.StringParameter;
  readonly clusterEndpointParameter: ssm.StringParameter;
  readonly joinTokenParameter: ssm.StringParameter;
  readonly clusterCaCertHashParameter: ssm.StringParameter;
  readonly clusterInitializedParameter: ssm.StringParameter;
  readonly etcdMemberTable: dynamodb.Table;
  readonly oidcProviderArn: string;
  readonly oidcBucketName: string;
}

export class ComputeStack extends Construct {
  public readonly controlPlaneLaunchTemplate: ec2.LaunchTemplate;
  public readonly controlPlaneAutoScalingGroup: autoscaling.AutoScalingGroup;
  public readonly workerLaunchTemplate: ec2.LaunchTemplate;
  public readonly workerAutoScalingGroup: autoscaling.AutoScalingGroup;
  public readonly etcdLifecycleLambda: lambda.Function;

  constructor(scope: Construct, id: string, props: ComputeStackProps) {
    super(scope, id);

    // Create instance profile for control plane role
    const controlPlaneInstanceProfile = new iam.InstanceProfile(this, 'ControlPlaneInstanceProfile', {
      role: props.controlPlaneRole,
      instanceProfileName: `${props.clusterName}-control-plane-profile`
    });

    // Control plane launch template
    const controlPlaneAmiId = ssm.StringParameter.valueFromLookup(this, '/k8s-cluster/control-plane-ami-id');
    
    this.controlPlaneLaunchTemplate = new ec2.LaunchTemplate(this, 'ControlPlaneLaunchTemplate', {
      launchTemplateName: `${props.clusterName}-control-plane`,
      machineImage: ec2.MachineImage.genericLinux({
        [cdk.Stack.of(this).region]: controlPlaneAmiId,
      }),
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.M5, ec2.InstanceSize.LARGE), // K8s recommendation
      securityGroup: props.controlPlaneSecurityGroup,
      role: props.controlPlaneRole,
      userData: ec2.UserData.forLinux({
        shebang: '#!/bin/bash'
      }),
      blockDevices: [{
        deviceName: '/dev/xvda',
        volume: ec2.BlockDeviceVolume.ebs(150, {
          volumeType: ec2.EbsDeviceVolumeType.GP3,
          encrypted: true,
          kmsKey: props.kmsKey
        })
      }],
      requireImdsv2: true,
      detailedMonitoring: true
    });

    // Add control plane bootstrap script
    this.controlPlaneLaunchTemplate.userData?.addCommands(
      this.createControlPlaneBootstrapScript(props.clusterName, props.oidcProviderArn, props.oidcBucketName)
    );

    // Set dedicated tenancy and fix IMDS configuration
    const cfnLaunchTemplate = this.controlPlaneLaunchTemplate.node.defaultChild as ec2.CfnLaunchTemplate;
    cfnLaunchTemplate.addPropertyOverride('LaunchTemplateData.Placement.Tenancy', 'dedicated');
    cfnLaunchTemplate.addPropertyOverride('LaunchTemplateData.IamInstanceProfile.Name', controlPlaneInstanceProfile.instanceProfileName);
    cfnLaunchTemplate.addPropertyOverride('LaunchTemplateData.MetadataOptions.HttpPutResponseHopLimit', 2);

    // Create VPC from subnets
    const vpc = props.vpc;

    // Control plane Auto Scaling Group
    this.controlPlaneAutoScalingGroup = new autoscaling.AutoScalingGroup(this, 'ControlPlaneAutoScalingGroup', {
      vpc,
      vpcSubnets: { subnets: props.controlPlaneSubnets },
      launchTemplate: this.controlPlaneLaunchTemplate,
      minCapacity: 3,
      maxCapacity: 10,
      autoScalingGroupName: `${props.clusterName}-control-plane`,
      defaultInstanceWarmup: cdk.Duration.minutes(15)
    });

    // Lambda function for etcd member lifecycle management
    const etcdLifecycleRole = new iam.Role(this, 'EtcdLifecycleRole', {
      roleName: `${props.clusterName}-etcd-lifecycle-role`,
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole')
      ]
    });

    this.etcdLifecycleLambda = new lambda.Function(this, 'EtcdLifecycleLambda', {
      functionName: `${props.clusterName}-etcd-lifecycle`,
      runtime: lambda.Runtime.PYTHON_3_11,
      handler: 'index.handler',
      code: lambda.Code.fromInline(this.createEtcdLifecycleLambdaCode(props.clusterName)),
      timeout: cdk.Duration.minutes(5),
      role: etcdLifecycleRole,
      environment: {
        CLUSTER_NAME: props.clusterName,
        ETCD_TABLE_NAME: props.etcdMemberTable.tableName,
        REGION: cdk.Stack.of(this).region,
        CONTROL_PLANE_ASG_NAME: `${props.clusterName}-control-plane`
      }
    });

    // Grant Lambda permissions
    props.etcdMemberTable.grantReadWriteData(etcdLifecycleRole);
    props.kmsKey.grantDecrypt(etcdLifecycleRole);
    
    etcdLifecycleRole.addToPolicy(new iam.PolicyStatement({
      actions: [
        'autoscaling:CompleteLifecycleAction',
        'ec2:DescribeInstances'
      ],
      resources: ['*']
    }));

    // Grant SSM permissions for etcdctl execution
    this.etcdLifecycleLambda.addToRolePolicy(new iam.PolicyStatement({
      actions: [
        'ssm:SendCommand',
        'ssm:GetCommandInvocation'
      ],
      resources: ['*']
    }));

    // Lifecycle hook for etcd member cleanup
    new autoscaling.LifecycleHook(this, 'EtcdLifecycleHook', {
      autoScalingGroup: this.controlPlaneAutoScalingGroup,
      lifecycleTransition: autoscaling.LifecycleTransition.INSTANCE_TERMINATING,
      defaultResult: autoscaling.DefaultResult.CONTINUE,
      heartbeatTimeout: cdk.Duration.minutes(10),
      lifecycleHookName: `${props.clusterName}-etcd-cleanup`
    });

    // EventBridge rule to trigger Lambda on lifecycle events
    new events.Rule(this, 'EtcdLifecycleRule', {
      ruleName: `${props.clusterName}-etcd-lifecycle-rule`,
      eventPattern: {
        source: ['aws.autoscaling'],
        detailType: ['EC2 Instance-terminate Lifecycle Action'],
        detail: {
          AutoScalingGroupName: [this.controlPlaneAutoScalingGroup.autoScalingGroupName]
        }
      },
      targets: [new targets.LambdaFunction(this.etcdLifecycleLambda)]
    });

    // Worker node launch template
    const workerAmiId = ssm.StringParameter.valueFromLookup(this, '/k8s-cluster/worker-ami-id');

    this.workerLaunchTemplate = new ec2.LaunchTemplate(this, 'WorkerLaunchTemplate', {
      launchTemplateName: `${props.clusterName}-worker`,
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.M5, ec2.InstanceSize.LARGE),
      machineImage: ec2.MachineImage.genericLinux({
        [cdk.Stack.of(this).region]: workerAmiId,
      }),
      role: props.workerNodeRole,
      securityGroup: props.workerSecurityGroup,
      userData: ec2.UserData.forLinux({
        shebang: '#!/bin/bash'
      }),
      requireImdsv2: true,
      detailedMonitoring: true,
      blockDevices: [{
        deviceName: '/dev/xvda',
        volume: ec2.BlockDeviceVolume.ebs(20, {
          volumeType: ec2.EbsDeviceVolumeType.GP3,
          encrypted: true,
          kmsKey: props.kmsKey
        })
      }]
    });

    // Add worker bootstrap script
    this.workerLaunchTemplate.userData?.addCommands(
      this.createWorkerBootstrapScript(props.clusterName)
    );

    // Worker AutoScaling Group
    this.workerAutoScalingGroup = new autoscaling.AutoScalingGroup(this, 'WorkerAutoScalingGroup', {
      autoScalingGroupName: `${props.clusterName}-worker`,
      launchTemplate: this.workerLaunchTemplate,
      vpc: props.vpc,
      vpcSubnets: { subnets: props.workerSubnets },
      minCapacity: 1,
      maxCapacity: 10,
      healthCheck: autoscaling.HealthCheck.ec2({ grace: cdk.Duration.minutes(5) }),
      updatePolicy: autoscaling.UpdatePolicy.rollingUpdate()
    });

    // Add cluster-autoscaler tags to worker ASG
    cdk.Tags.of(this.workerAutoScalingGroup).add('k8s.io/cluster-autoscaler/enabled', 'true', {
      applyToLaunchedInstances: false
    });
    cdk.Tags.of(this.workerAutoScalingGroup).add(`k8s.io/cluster-autoscaler/${props.clusterName}`, 'owned', {
      applyToLaunchedInstances: false
    });
  }


  private createEtcdLifecycleLambdaCode(clusterName: string): string {
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
MIN_HEALTHY_NODES_FOR_REMOVAL = 2  # Need at least 2 healthy nodes to safely remove one

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

        # Attempt to remove etcd member with retries
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

  private createWorkerBootstrapScript(clusterName: string): string {
    return `
# Worker bootstrap script - Join cluster using pre-installed packages
echo "Starting worker node bootstrap for cluster: ${clusterName}"

# Retry configuration
MAX_RETRIES=5
RETRY_DELAY=5

# Track bootstrap state for cleanup
BOOTSTRAP_STAGE="init"

# Cleanup function for failed bootstrap
cleanup_on_failure() {
    local exit_code=\$?
    if [ \$exit_code -eq 0 ]; then
        return 0
    fi

    echo "Worker bootstrap failed at stage: \$BOOTSTRAP_STAGE (exit code: \$exit_code)"
    echo "Running cleanup..."

    # Reset kubeadm state
    echo "Resetting kubeadm state..."
    kubeadm reset -f 2>/dev/null || true

    # Stop kubelet
    systemctl stop kubelet 2>/dev/null || true

    echo "Cleanup completed. Worker will need manual intervention or termination."

    # Signal unhealthy to ASG (optional - causes replacement)
    # Uncomment to auto-terminate failed instances:
    # aws autoscaling set-instance-health --instance-id \$INSTANCE_ID --health-status Unhealthy --region \$REGION 2>/dev/null || true

    exit \$exit_code
}

# Set trap for cleanup on error
trap cleanup_on_failure EXIT

# Retry helper that captures output
retry_command_output() {
    local cmd="$1"
    local attempt=1
    local delay=$RETRY_DELAY
    local output=""

    while [ $attempt -le $MAX_RETRIES ]; do
        output=$(eval "$cmd" 2>/dev/null)
        if [ $? -eq 0 ] && [ -n "$output" ]; then
            echo "$output"
            return 0
        fi

        if [ $attempt -lt $MAX_RETRIES ]; then
            sleep $delay
            delay=$((delay * 2))
        fi

        attempt=$((attempt + 1))
    done

    return 1
}

# Get instance metadata (with IMDSv2 support)
get_instance_metadata() {
    local path="$1"
    local token=$(curl -s -X PUT "http://169.254.169.254/latest/api/token" -H "X-aws-ec2-metadata-token-ttl-seconds: 300" 2>/dev/null)
    if [ -n "$token" ]; then
        curl -s -H "X-aws-ec2-metadata-token: $token" "http://169.254.169.254/latest/meta-data/$path"
    else
        curl -s "http://169.254.169.254/latest/meta-data/$path"
    fi
}

INSTANCE_ID=$(get_instance_metadata "instance-id")
PRIVATE_IP=$(get_instance_metadata "local-ipv4")
REGION=${cdk.Stack.of(this).region}

# Verify we got instance metadata
if [ -z "$INSTANCE_ID" ] || [ -z "$PRIVATE_IP" ]; then
    echo "ERROR: Failed to get instance metadata"
    exit 1
fi

echo "Instance ID: $INSTANCE_ID"
echo "Private IP: $PRIVATE_IP"

# Wait for cluster to be initialized
echo "Waiting for cluster to be initialized..."
for i in {1..60}; do
    CLUSTER_INITIALIZED=$(retry_command_output "aws ssm get-parameter --name '/${clusterName}/cluster/initialized' --query 'Parameter.Value' --output text --region $REGION" || echo "false")
    if [ "$CLUSTER_INITIALIZED" = "true" ]; then
        echo "Cluster is initialized, proceeding with worker join"
        break
    fi
    echo "Waiting for cluster initialization... ($i/60)"
    sleep 10
done

if [ "$CLUSTER_INITIALIZED" != "true" ]; then
    echo "Timeout waiting for cluster initialization"
    exit 1
fi

BOOTSTRAP_STAGE="get-join-params"

# Function to request a fresh join token from a control plane node
request_new_token() {
    echo "Requesting new join token from control plane..."

    # Find a healthy control plane instance
    CONTROL_PLANE_INSTANCE=$(aws ec2 describe-instances \
        --filters "Name=tag:aws:autoscaling:groupName,Values=${clusterName}-control-plane" \
                  "Name=instance-state-name,Values=running" \
        --query 'Reservations[0].Instances[0].InstanceId' \
        --output text --region $REGION 2>/dev/null)

    if [ -z "$CONTROL_PLANE_INSTANCE" ] || [ "$CONTROL_PLANE_INSTANCE" = "None" ]; then
        echo "ERROR: No healthy control plane instance found"
        return 1
    fi

    echo "Found control plane instance: $CONTROL_PLANE_INSTANCE"

    # Create script to generate new token on control plane
    local token_script='
export KUBECONFIG=/etc/kubernetes/admin.conf
NEW_TOKEN=$(kubeadm token create --ttl 24h 2>/dev/null)
if [ -n "$NEW_TOKEN" ]; then
    aws ssm put-parameter --name "/'${clusterName}'/cluster/join-token" \
        --value "$NEW_TOKEN" --type "SecureString" --overwrite --region '$REGION'
    aws ssm put-parameter --name "/'${clusterName}'/cluster/join-token-updated" \
        --value "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --type "String" --overwrite --region '$REGION'
    echo "TOKEN_REFRESH_SUCCESS"
else
    echo "TOKEN_REFRESH_FAILED"
fi
'

    # Execute via SSM Run Command
    local command_id=$(aws ssm send-command \
        --instance-ids "$CONTROL_PLANE_INSTANCE" \
        --document-name "AWS-RunShellScript" \
        --parameters "commands=[\"$token_script\"]" \
        --query 'Command.CommandId' \
        --output text --region $REGION 2>/dev/null)

    if [ -z "$command_id" ] || [ "$command_id" = "None" ]; then
        echo "ERROR: Failed to send SSM command"
        return 1
    fi

    echo "SSM command sent: $command_id"

    # Wait for command completion
    local max_wait=60
    local elapsed=0
    while [ $elapsed -lt $max_wait ]; do
        sleep 5
        elapsed=$((elapsed + 5))

        local status=$(aws ssm get-command-invocation \
            --command-id "$command_id" \
            --instance-id "$CONTROL_PLANE_INSTANCE" \
            --query 'Status' --output text --region $REGION 2>/dev/null)

        if [ "$status" = "Success" ]; then
            local output=$(aws ssm get-command-invocation \
                --command-id "$command_id" \
                --instance-id "$CONTROL_PLANE_INSTANCE" \
                --query 'StandardOutputContent' --output text --region $REGION 2>/dev/null)

            if echo "$output" | grep -q "TOKEN_REFRESH_SUCCESS"; then
                echo "Token refresh successful"
                return 0
            else
                echo "Token refresh command did not succeed"
                return 1
            fi
        elif [ "$status" = "Failed" ] || [ "$status" = "Cancelled" ] || [ "$status" = "TimedOut" ]; then
            echo "SSM command failed with status: $status"
            return 1
        fi
    done

    echo "Timeout waiting for token refresh"
    return 1
}

# Function to check if token is likely expired (older than 20 hours)
check_token_age() {
    local token_updated=$(aws ssm get-parameter \
        --name "/${clusterName}/cluster/join-token-updated" \
        --query 'Parameter.Value' --output text --region $REGION 2>/dev/null)

    if [ -z "$token_updated" ] || [ "$token_updated" = "None" ]; then
        # No timestamp, check when the token parameter was last modified
        token_updated=$(aws ssm get-parameter \
            --name "/${clusterName}/cluster/join-token" \
            --query 'Parameter.LastModifiedDate' --output text --region $REGION 2>/dev/null)
    fi

    if [ -z "$token_updated" ] || [ "$token_updated" = "None" ]; then
        echo "unknown"
        return
    fi

    # Convert to epoch
    local token_epoch=$(date -d "$token_updated" +%s 2>/dev/null || date -jf "%Y-%m-%dT%H:%M:%S" "$token_updated" +%s 2>/dev/null)
    local now_epoch=$(date +%s)

    if [ -z "$token_epoch" ]; then
        echo "unknown"
        return
    fi

    local age_hours=$(( (now_epoch - token_epoch) / 3600 ))
    echo "$age_hours"
}

# Get configuration from SSM parameters (with retries)
KUBERNETES_VERSION=$(retry_command_output "aws ssm get-parameter --name '/${clusterName}/kubernetes/version' --query 'Parameter.Value' --output text --region $REGION")
CLUSTER_ENDPOINT=$(retry_command_output "aws ssm get-parameter --name '/${clusterName}/cluster/endpoint' --query 'Parameter.Value' --output text --region $REGION")
CA_CERT_HASH=$(retry_command_output "aws ssm get-parameter --name '/${clusterName}/cluster/ca-cert-hash' --query 'Parameter.Value' --output text --region $REGION")

# Check token age and refresh if needed
TOKEN_AGE=$(check_token_age)
echo "Join token age: $TOKEN_AGE hours"

if [ "$TOKEN_AGE" != "unknown" ] && [ "$TOKEN_AGE" -ge 20 ]; then
    echo "Token is $TOKEN_AGE hours old (near expiry), requesting refresh..."
    if request_new_token; then
        echo "Token refreshed successfully"
    else
        echo "WARNING: Token refresh failed, will try existing token"
    fi
fi

# Get join token (might be freshly refreshed)
JOIN_TOKEN=$(retry_command_output "aws ssm get-parameter --name '/${clusterName}/cluster/join-token' --with-decryption --query 'Parameter.Value' --output text --region $REGION")

echo "Kubernetes Version: $KUBERNETES_VERSION"
echo "Cluster Endpoint: $CLUSTER_ENDPOINT"

# Configure containerd (already installed in AMI)
systemctl enable containerd
systemctl start containerd

# Configure kubelet using pre-installed binary
mkdir -p /etc/kubernetes/kubelet
cat > /etc/kubernetes/kubelet/kubelet-config.yaml << 'EOF'
kind: KubeletConfiguration
apiVersion: kubelet.config.k8s.io/v1beta1
address: 0.0.0.0
port: 10250
readOnlyPort: 0
cgroupDriver: systemd
cgroupsPerQOS: true
enforceNodeAllocatable: ["pods"]
authentication:
  anonymous:
    enabled: false
  webhook:
    enabled: true
  x509:
    clientCAFile: "/etc/kubernetes/pki/ca.crt"
authorization:
  mode: Webhook
clusterDomain: "cluster.local"
clusterDNS: ["10.96.0.10"]
runtimeRequestTimeout: "15m"
kubeReserved:
  cpu: 100m
  memory: 128Mi
systemReserved:
  cpu: 100m
  memory: 128Mi
maxPods: 110
EOF

# Create kubelet systemd service using pre-installed binary
cat > /etc/systemd/system/kubelet.service << 'EOF'
[Unit]
Description=kubelet: The Kubernetes Node Agent
Documentation=https://kubernetes.io/docs/home/
Wants=network-online.target
After=network-online.target

[Service]
ExecStart=/usr/bin/kubelet \\
  --config=/etc/kubernetes/kubelet/kubelet-config.yaml \\
  --container-runtime-endpoint=unix:///run/containerd/containerd.sock \\
  --kubeconfig=/etc/kubernetes/kubelet.conf \\
  --bootstrap-kubeconfig=/etc/kubernetes/bootstrap-kubelet.conf \\
  --v=2
Restart=always
StartLimitInterval=0
RestartSec=10

[Install]
WantedBy=multi-user.target
EOF

# Enable kubelet service
systemctl daemon-reload
systemctl enable kubelet

# Function to attempt cluster join
attempt_join() {
    local token="$1"
    echo "Attempting to join cluster with token..."
    kubeadm join $CLUSTER_ENDPOINT \
        --token "$token" \
        --discovery-token-ca-cert-hash $CA_CERT_HASH \
        --node-name $(hostname -f)
    return $?
}

BOOTSTRAP_STAGE="kubeadm-join"

# Join cluster using pre-installed kubeadm
if [ -n "$CLUSTER_ENDPOINT" ] && [ -n "$JOIN_TOKEN" ] && [ -n "$CA_CERT_HASH" ]; then
    echo "Joining cluster using kubeadm..."

    if attempt_join "$JOIN_TOKEN"; then
        echo "Successfully joined cluster as worker node"
        BOOTSTRAP_STAGE="complete"
    else
        echo "First join attempt failed, requesting fresh token..."

        # Try to get a fresh token
        if request_new_token; then
            # Get the new token
            NEW_JOIN_TOKEN=$(retry_command_output "aws ssm get-parameter --name '/${clusterName}/cluster/join-token' --with-decryption --query 'Parameter.Value' --output text --region $REGION")

            if [ -n "$NEW_JOIN_TOKEN" ] && [ "$NEW_JOIN_TOKEN" != "$JOIN_TOKEN" ]; then
                echo "Got fresh token, retrying join..."
                # Reset kubeadm state before retry
                kubeadm reset -f 2>/dev/null || true

                if attempt_join "$NEW_JOIN_TOKEN"; then
                    echo "Successfully joined cluster with fresh token"
                    BOOTSTRAP_STAGE="complete"
                else
                    echo "Join failed even with fresh token"
                    exit 1
                fi
            else
                echo "Could not get a different token"
                exit 1
            fi
        else
            echo "Token refresh failed"
            exit 1
        fi
    fi
else
    echo "Missing required join parameters from SSM"
    exit 1
fi

# Disable cleanup trap on successful completion
trap - EXIT
BOOTSTRAP_STAGE="complete"

echo "Worker node bootstrap completed successfully!"
`;
  }

  private createControlPlaneBootstrapScript(clusterName: string, oidcProviderArn: string, oidcBucketName: string): string {
    return `
# Control plane bootstrap script - Cluster initialization and joining
echo "Starting control plane bootstrap for cluster: ${clusterName}"

# Retry configuration
MAX_RETRIES=5
RETRY_DELAY=5

# Track bootstrap state for cleanup
BOOTSTRAP_STAGE="init"
ETCD_REGISTERED=false
LB_REGISTERED=false
CLUSTER_LOCK_HELD=false

# Cleanup function for failed bootstrap
cleanup_on_failure() {
    local exit_code=\$?
    if [ \$exit_code -eq 0 ]; then
        return 0
    fi

    echo "Bootstrap failed at stage: \$BOOTSTRAP_STAGE (exit code: \$exit_code)"
    echo "Running cleanup..."

    # Remove from load balancer if registered
    if [ "\$LB_REGISTERED" = "true" ]; then
        echo "Removing from load balancer target group..."
        TARGET_GROUP_ARN=$(aws elbv2 describe-target-groups --names '${clusterName}-control-plane-tg' --query 'TargetGroups[0].TargetGroupArn' --output text --region $REGION 2>/dev/null)
        if [ -n "\$TARGET_GROUP_ARN" ] && [ "\$TARGET_GROUP_ARN" != "None" ]; then
            aws elbv2 deregister-targets --target-group-arn "\$TARGET_GROUP_ARN" --targets Id=\$INSTANCE_ID,Port=6443 --region $REGION 2>/dev/null || true
        fi
    fi

    # Remove etcd member registration from DynamoDB if registered
    if [ "\$ETCD_REGISTERED" = "true" ]; then
        echo "Removing etcd member registration from DynamoDB..."
        # We stored it with MemberId = etcd_member_id, need to find and delete
        aws dynamodb query \
            --table-name "${clusterName}-etcd-members" \
            --index-name "InstanceIdIndex" \
            --key-condition-expression "InstanceId = :iid" \
            --expression-attribute-values '{":iid":{"S":"'\$INSTANCE_ID'"}}' \
            --query 'Items[0]' \
            --output json --region $REGION 2>/dev/null | \
        python3 -c "
import sys, json
try:
    item = json.load(sys.stdin)
    if item:
        print(item.get('ClusterId', {}).get('S', ''))
        print(item.get('MemberId', {}).get('S', ''))
except:
    pass
" | {
            read cluster_id
            read member_id
            if [ -n "\$cluster_id" ] && [ -n "\$member_id" ]; then
                aws dynamodb delete-item \
                    --table-name "${clusterName}-etcd-members" \
                    --key '{"ClusterId":{"S":"'\$cluster_id'"},"MemberId":{"S":"'\$member_id'"}}' \
                    --region $REGION 2>/dev/null || true
            fi
        }
    fi

    # Release cluster init lock if we held it
    if [ "\$CLUSTER_LOCK_HELD" = "true" ]; then
        echo "Releasing cluster initialization lock..."
        aws dynamodb delete-item \
            --table-name "${clusterName}-etcd-members" \
            --key '{"ClusterId":{"S":"'${clusterName}'"},"MemberId":{"S":"cluster-init-lock"}}' \
            --region $REGION 2>/dev/null || true
    fi

    # Reset kubeadm state
    echo "Resetting kubeadm state..."
    kubeadm reset -f 2>/dev/null || true

    # Stop kubelet
    systemctl stop kubelet 2>/dev/null || true

    echo "Cleanup completed. Instance will need manual intervention or termination."

    # Signal unhealthy to ASG (optional - causes replacement)
    # Uncomment to auto-terminate failed instances:
    # aws autoscaling set-instance-health --instance-id \$INSTANCE_ID --health-status Unhealthy --region $REGION 2>/dev/null || true

    exit \$exit_code
}

# Set trap for cleanup on error
trap cleanup_on_failure EXIT

# Retry helper function with exponential backoff
# Usage: retry_command <command>
# Returns: 0 on success, 1 on failure after all retries
retry_command() {
    local cmd="$1"
    local attempt=1
    local delay=$RETRY_DELAY

    while [ $attempt -le $MAX_RETRIES ]; do
        echo "Executing (attempt $attempt/$MAX_RETRIES): $cmd"

        if eval "$cmd"; then
            return 0
        fi

        if [ $attempt -lt $MAX_RETRIES ]; then
            echo "Command failed, retrying in \${delay}s..."
            sleep $delay
            delay=$((delay * 2))  # Exponential backoff
        fi

        attempt=$((attempt + 1))
    done

    echo "ERROR: Command failed after $MAX_RETRIES attempts: $cmd"
    return 1
}

# Retry helper that captures output
# Usage: result=$(retry_command_output <command>)
retry_command_output() {
    local cmd="$1"
    local attempt=1
    local delay=$RETRY_DELAY
    local output=""

    while [ $attempt -le $MAX_RETRIES ]; do
        output=$(eval "$cmd" 2>/dev/null)
        if [ $? -eq 0 ] && [ -n "$output" ]; then
            echo "$output"
            return 0
        fi

        if [ $attempt -lt $MAX_RETRIES ]; then
            sleep $delay
            delay=$((delay * 2))
        fi

        attempt=$((attempt + 1))
    done

    return 1
}

# Get instance metadata (with retries for IMDS)
get_instance_metadata() {
    local path="$1"
    local token=$(curl -s -X PUT "http://169.254.169.254/latest/api/token" -H "X-aws-ec2-metadata-token-ttl-seconds: 300" 2>/dev/null)
    if [ -n "$token" ]; then
        curl -s -H "X-aws-ec2-metadata-token: $token" "http://169.254.169.254/latest/meta-data/$path"
    else
        curl -s "http://169.254.169.254/latest/meta-data/$path"
    fi
}

INSTANCE_ID=$(get_instance_metadata "instance-id")
PRIVATE_IP=$(get_instance_metadata "local-ipv4")
REGION=${cdk.Stack.of(this).region}

# Verify we got instance metadata
if [ -z "$INSTANCE_ID" ] || [ -z "$PRIVATE_IP" ]; then
    echo "ERROR: Failed to get instance metadata"
    exit 1
fi

# Get cluster configuration from SSM (with retries)
KUBERNETES_VERSION=$(retry_command_output "aws ssm get-parameter --name '/${clusterName}/kubernetes/version' --query 'Parameter.Value' --output text --region $REGION")
CLUSTER_ENDPOINT=$(retry_command_output "aws ssm get-parameter --name '/${clusterName}/cluster/endpoint' --query 'Parameter.Value' --output text --region $REGION" || echo "")
CLUSTER_INITIALIZED=$(retry_command_output "aws ssm get-parameter --name '/${clusterName}/cluster/initialized' --query 'Parameter.Value' --output text --region $REGION" || echo "false")

echo "Instance ID: $INSTANCE_ID"
echo "Private IP: $PRIVATE_IP"
echo "Kubernetes Version: $KUBERNETES_VERSION"
echo "Cluster Initialized: $CLUSTER_INITIALIZED"

# Configure containerd (already installed in AMI)
systemctl enable containerd
systemctl start containerd

# Configure kubelet (already installed in AMI)
systemctl enable kubelet

# Function to register etcd member in DynamoDB for lifecycle management
register_etcd_member() {
    echo "Registering etcd member in DynamoDB..."

    # Wait for etcd to be ready
    local max_attempts=30
    local attempt=1
    while [ $attempt -le $max_attempts ]; do
        if ETCDCTL_API=3 etcdctl \\
            --endpoints=https://127.0.0.1:2379 \\
            --cacert=/etc/kubernetes/pki/etcd/ca.crt \\
            --cert=/etc/kubernetes/pki/etcd/server.crt \\
            --key=/etc/kubernetes/pki/etcd/server.key \\
            endpoint health &>/dev/null; then
            echo "etcd is healthy"
            break
        fi
        echo "Waiting for etcd to be ready... (attempt $attempt/$max_attempts)"
        sleep 5
        attempt=$((attempt + 1))
    done

    if [ $attempt -gt $max_attempts ]; then
        echo "ERROR: etcd did not become healthy in time"
        return 1
    fi

    # Get etcd member ID for this node
    # The member name matches the hostname
    local hostname=$(hostname)
    local member_info=$(ETCDCTL_API=3 etcdctl \\
        --endpoints=https://127.0.0.1:2379 \\
        --cacert=/etc/kubernetes/pki/etcd/ca.crt \\
        --cert=/etc/kubernetes/pki/etcd/server.crt \\
        --key=/etc/kubernetes/pki/etcd/server.key \\
        member list -w json 2>/dev/null)

    if [ -z "$member_info" ]; then
        echo "ERROR: Failed to get etcd member list"
        return 1
    fi

    # Parse member ID - look for member with matching name or peerURL containing our IP
    local etcd_member_id=$(echo "$member_info" | grep -o '"ID":[0-9]*' | head -1 | cut -d: -f2)

    # Try to find by peer URL matching our IP
    local member_by_ip=$(echo "$member_info" | python3 -c "
import sys, json
try:
    data = json.load(sys.stdin)
    for member in data.get('members', []):
        for url in member.get('peerURLs', []):
            if '$PRIVATE_IP' in url:
                print(format(member['ID'], 'x'))
                sys.exit(0)
    # If not found by IP, try by name
    for member in data.get('members', []):
        if member.get('name') == '$hostname':
            print(format(member['ID'], 'x'))
            sys.exit(0)
except:
    pass
" 2>/dev/null)

    if [ -n "$member_by_ip" ]; then
        etcd_member_id="$member_by_ip"
    fi

    if [ -z "$etcd_member_id" ]; then
        echo "ERROR: Could not determine etcd member ID for this node"
        return 1
    fi

    echo "Found etcd member ID: $etcd_member_id"

    # Register in DynamoDB
    aws dynamodb put-item \\
        --table-name "${clusterName}-etcd-members" \\
        --item '{
            "ClusterId": {"S": "'${clusterName}'"},
            "MemberId": {"S": "'$etcd_member_id'"},
            "InstanceId": {"S": "'$INSTANCE_ID'"},
            "PrivateIp": {"S": "'$PRIVATE_IP'"},
            "EtcdMemberId": {"S": "'$etcd_member_id'"},
            "Hostname": {"S": "'$hostname'"},
            "Status": {"S": "ACTIVE"},
            "CreatedAt": {"S": "'$(date -u +%Y-%m-%dT%H:%M:%SZ)'"}
        }' \\
        --region $REGION

    if [ $? -eq 0 ]; then
        echo "Successfully registered etcd member $etcd_member_id in DynamoDB"
        return 0
    else
        echo "ERROR: Failed to register etcd member in DynamoDB"
        return 1
    fi
}

# Check if this should be the first control plane node
if [ "$CLUSTER_INITIALIZED" = "false" ]; then
    echo "Attempting to initialize cluster as first control plane node..."
    
    BOOTSTRAP_STAGE="acquiring-lock"

    # Try to acquire cluster initialization lock using DynamoDB
    if aws dynamodb put-item \\
        --table-name "${clusterName}-etcd-members" \\
        --item '{"ClusterId":{"S":"'${clusterName}'"},"MemberId":{"S":"cluster-init-lock"},"InstanceId":{"S":"'$INSTANCE_ID'"},"Status":{"S":"INITIALIZING"},"CreatedAt":{"S":"'$(date -u +%Y-%m-%dT%H:%M:%SZ)'"}}' \\
        --condition-expression "attribute_not_exists(ClusterId)" \\
        --region $REGION 2>/dev/null; then

        CLUSTER_LOCK_HELD=true
        BOOTSTRAP_STAGE="kubeadm-init"
        echo "Acquired initialization lock - initializing cluster..."

        # Set OIDC issuer URL for IRSA (before kubeadm init)
        OIDC_BUCKET="${oidcBucketName}"
        OIDC_ISSUER="https://s3.$REGION.amazonaws.com/$OIDC_BUCKET"

        # Generate certificate key for control plane join (before kubeadm init)
        # This key allows additional control plane nodes to download certs
        CERT_KEY=$(kubeadm certs certificate-key)

        # Initialize cluster with kubeadm
        # The service-account-issuer must match the OIDC issuer URL for IRSA to work
        # --upload-certs uploads control plane certs to kubeadm-certs secret (encrypted with CERT_KEY)
        kubeadm init \\
            --kubernetes-version=v$KUBERNETES_VERSION \\
            --pod-network-cidr=10.244.0.0/16 \\
            --service-cidr=10.96.0.0/12 \\
            --apiserver-advertise-address=$PRIVATE_IP \\
            --control-plane-endpoint="${clusterName}-cp-lb.internal:6443" \\
            --service-account-issuer=$OIDC_ISSUER \\
            --upload-certs \\
            --certificate-key=$CERT_KEY
        
        if [ $? -eq 0 ]; then
            echo "Cluster initialization successful!"
            
            # Configure kubectl for root user
            mkdir -p /root/.kube
            cp -i /etc/kubernetes/admin.conf /root/.kube/config
            chown root:root /root/.kube/config
            
            # Get join token and CA cert hash
            JOIN_TOKEN=$(kubeadm token list | grep -v TOKEN | head -1 | awk '{print $1}')
            CA_CERT_HASH=$(openssl x509 -pubkey -in /etc/kubernetes/pki/ca.crt | openssl rsa -pubin -outform der 2>/dev/null | openssl dgst -sha256 -hex | sed 's/^.* //')
            
            # Store cluster information in SSM (with retries)
            retry_command "aws ssm put-parameter --name '/${clusterName}/cluster/endpoint' --value '${clusterName}-cp-lb.internal:6443' --type 'String' --overwrite --region $REGION"
            retry_command "aws ssm put-parameter --name '/${clusterName}/cluster/join-token' --value '\$JOIN_TOKEN' --type 'SecureString' --overwrite --region $REGION"
            retry_command "aws ssm put-parameter --name '/${clusterName}/cluster/join-token-updated' --value '\$(date -u +%Y-%m-%dT%H:%M:%SZ)' --type 'String' --overwrite --region $REGION"
            retry_command "aws ssm put-parameter --name '/${clusterName}/cluster/ca-cert-hash' --value 'sha256:\$CA_CERT_HASH' --type 'String' --overwrite --region $REGION"
            retry_command "aws ssm put-parameter --name '/${clusterName}/cluster/certificate-key' --value '\$CERT_KEY' --type 'SecureString' --overwrite --region $REGION"
            retry_command "aws ssm put-parameter --name '/${clusterName}/cluster/initialized' --value 'true' --type 'String' --overwrite --region $REGION"

            # Register this node's etcd member in DynamoDB for lifecycle management
            BOOTSTRAP_STAGE="etcd-registration"
            if register_etcd_member; then
                ETCD_REGISTERED=true
            else
                echo "WARNING: Failed to register etcd member, lifecycle cleanup may not work"
            fi

            # Install CNI plugin (Cilium)
            echo "Installing Cilium CNI plugin..."
            kubectl apply -f https://raw.githubusercontent.com/cilium/cilium/v1.14.5/install/kubernetes/quick-install.yaml

            # Setup OIDC for IRSA (IAM Roles for Service Accounts)
            echo "Setting up OIDC discovery for IRSA..."
            OIDC_PROVIDER_ARN="${oidcProviderArn}"
            # OIDC_BUCKET and OIDC_ISSUER were set before kubeadm init

            # Extract the service account signing key from the cluster
            # The API server uses this key to sign ServiceAccount tokens
            SA_SIGNING_KEY_FILE="/etc/kubernetes/pki/sa.pub"

            if [ -f "$SA_SIGNING_KEY_FILE" ]; then
                echo "Generating OIDC discovery documents..."

                # Create OIDC discovery document
                cat > /tmp/openid-configuration.json <<OIDCEOF
{
    "issuer": "$OIDC_ISSUER",
    "jwks_uri": "$OIDC_ISSUER/keys.json",
    "authorization_endpoint": "urn:kubernetes:programmatic_authorization",
    "response_types_supported": ["id_token"],
    "subject_types_supported": ["public"],
    "id_token_signing_alg_values_supported": ["RS256"],
    "claims_supported": ["sub", "iss"]
}
OIDCEOF

                # Convert the SA public key to JWKS format
                # Extract modulus and exponent from the RSA public key
                SA_PUB_KEY=$(cat $SA_SIGNING_KEY_FILE)

                # Use openssl to get the key components and convert to JWK
                # Get the modulus (n) and exponent (e) in base64url format
                MODULUS=$(openssl rsa -pubin -in $SA_SIGNING_KEY_FILE -modulus -noout 2>/dev/null | cut -d= -f2 | xxd -r -p | base64 -w0 | tr '+/' '-_' | tr -d '=')

                # RSA public exponent is typically 65537 (AQAB in base64url)
                EXPONENT="AQAB"

                # Generate key ID (kid) from the key fingerprint
                KID=$(openssl rsa -pubin -in $SA_SIGNING_KEY_FILE -outform DER 2>/dev/null | openssl dgst -sha256 -binary | base64 -w0 | tr '+/' '-_' | tr -d '=' | cut -c1-16)

                # Create JWKS document
                cat > /tmp/keys.json <<JWKSEOF
{
    "keys": [
        {
            "kty": "RSA",
            "alg": "RS256",
            "use": "sig",
            "kid": "$KID",
            "n": "$MODULUS",
            "e": "$EXPONENT"
        }
    ]
}
JWKSEOF

                # Upload OIDC documents to S3 (with retries)
                echo "Uploading OIDC discovery documents to S3..."
                retry_command "aws s3 cp /tmp/openid-configuration.json s3://\$OIDC_BUCKET/.well-known/openid-configuration --content-type application/json --region $REGION"
                retry_command "aws s3 cp /tmp/keys.json s3://\$OIDC_BUCKET/keys.json --content-type application/json --region $REGION"

                # Get the S3 TLS certificate thumbprint for the AWS OIDC provider
                # AWS S3 uses Amazon Trust Services certificates
                # The thumbprint for s3.amazonaws.com is well-known
                S3_THUMBPRINT="9e99a48a9960b14926bb7f3b02e22da2b0ab7280"

                # For regional S3 endpoints, we need to get the actual thumbprint
                S3_ENDPOINT="s3.$REGION.amazonaws.com"
                ACTUAL_THUMBPRINT=$(echo | openssl s_client -servername \$S3_ENDPOINT -connect \$S3_ENDPOINT:443 2>/dev/null | openssl x509 -fingerprint -sha1 -noout | cut -d= -f2 | tr -d ':' | tr '[:upper:]' '[:lower:]')

                if [ -n "\$ACTUAL_THUMBPRINT" ]; then
                    S3_THUMBPRINT=\$ACTUAL_THUMBPRINT
                fi

                echo "S3 TLS Thumbprint: \$S3_THUMBPRINT"

                # Update the AWS OIDC provider with the correct thumbprint (with retries)
                echo "Updating AWS OIDC provider thumbprint..."
                retry_command "aws iam update-open-id-connect-provider-thumbprint --open-id-connect-provider-arn \$OIDC_PROVIDER_ARN --thumbprint-list \$S3_THUMBPRINT --region $REGION"

                # Store OIDC issuer URL in SSM for reference (with retries)
                retry_command "aws ssm put-parameter --name '/${clusterName}/oidc/issuer' --value '\$OIDC_ISSUER' --type 'String' --overwrite --region $REGION"

                echo "OIDC setup completed successfully!"
            else
                echo "WARNING: Service account signing key not found. OIDC setup skipped."
            fi

            # Install cluster-autoscaler
            echo "Installing cluster-autoscaler..."
            cat <<EOF | kubectl apply -f -
apiVersion: apps/v1
kind: Deployment
metadata:
  name: cluster-autoscaler
  namespace: kube-system
  labels:
    app: cluster-autoscaler
spec:
  selector:
    matchLabels:
      app: cluster-autoscaler
  replicas: 1
  template:
    metadata:
      labels:
        app: cluster-autoscaler
    spec:
      serviceAccountName: cluster-autoscaler
      containers:
      - image: registry.k8s.io/autoscaling/cluster-autoscaler:v1.29.0
        name: cluster-autoscaler
        resources:
          limits:
            cpu: 100m
            memory: 300Mi
          requests:
            cpu: 100m
            memory: 300Mi
        command:
        - ./cluster-autoscaler
        - --v=4
        - --stderrthreshold=info
        - --cloud-provider=aws
        - --skip-nodes-with-local-storage=false
        - --expander=least-waste
        - --node-group-auto-discovery=asg:tag=k8s.io/cluster-autoscaler/enabled,k8s.io/cluster-autoscaler/${clusterName}
        - --balance-similar-node-groups
        - --skip-nodes-with-system-pods=false
        env:
        - name: AWS_REGION
          value: $REGION
EOF

            # Register this instance with load balancer target group (with retries)
            BOOTSTRAP_STAGE="lb-registration"
            TARGET_GROUP_ARN=$(retry_command_output "aws elbv2 describe-target-groups --names '${clusterName}-control-plane-tg' --query 'TargetGroups[0].TargetGroupArn' --output text --region $REGION")
            if [ -n "\$TARGET_GROUP_ARN" ]; then
                if retry_command "aws elbv2 register-targets --target-group-arn \$TARGET_GROUP_ARN --targets Id=\$INSTANCE_ID,Port=6443 --region $REGION"; then
                    LB_REGISTERED=true
                fi
            else
                echo "WARNING: Could not find target group ARN"
            fi

            # Release the init lock since we're done
            CLUSTER_LOCK_HELD=false
            BOOTSTRAP_STAGE="complete"

            echo "First control plane node setup completed successfully!"
        else
            echo "Cluster initialization failed!"
            # Release the lock
            aws dynamodb delete-item \\
                --table-name "${clusterName}-etcd-members" \\
                --key '{"ClusterId":{"S":"'${clusterName}'"},"MemberId":{"S":"cluster-init-lock"}}' \\
                --region $REGION
            exit 1
        fi
    else
        echo "Another node is initializing the cluster, waiting..."
        # Wait for cluster to be initialized by another node
        for i in {1..30}; do
            sleep 10
            CLUSTER_INITIALIZED=$(aws ssm get-parameter --name "/${clusterName}/cluster/initialized" --query 'Parameter.Value' --output text --region $REGION 2>/dev/null || echo "false")
            if [ "$CLUSTER_INITIALIZED" = "true" ]; then
                echo "Cluster has been initialized by another node"
                break
            fi
            echo "Waiting for cluster initialization... ($i/30)"
        done
        
        if [ "$CLUSTER_INITIALIZED" != "true" ]; then
            echo "Timeout waiting for cluster initialization"
            exit 1
        fi
    fi
fi

# Function to request a fresh join token from another control plane node
request_new_control_plane_token() {
    echo "Requesting new join token from existing control plane node..."

    # Find a healthy control plane instance (not ourselves)
    CONTROL_PLANE_INSTANCE=$(aws ec2 describe-instances \
        --filters "Name=tag:aws:autoscaling:groupName,Values=${clusterName}-control-plane" \
                  "Name=instance-state-name,Values=running" \
        --query "Reservations[].Instances[?InstanceId!='\$INSTANCE_ID'].InstanceId | [0]" \
        --output text --region $REGION 2>/dev/null)

    if [ -z "\$CONTROL_PLANE_INSTANCE" ] || [ "\$CONTROL_PLANE_INSTANCE" = "None" ]; then
        echo "ERROR: No other healthy control plane instance found"
        return 1
    fi

    echo "Found control plane instance: \$CONTROL_PLANE_INSTANCE"

    # Create script to generate new token on control plane (with certificate-key for control plane join)
    local token_script='
export KUBECONFIG=/etc/kubernetes/admin.conf
NEW_TOKEN=$(kubeadm token create --ttl 24h 2>/dev/null)
CERT_KEY=$(kubeadm init phase upload-certs --upload-certs 2>/dev/null | tail -1)
if [ -n "$NEW_TOKEN" ]; then
    aws ssm put-parameter --name "/'${clusterName}'/cluster/join-token" \
        --value "$NEW_TOKEN" --type "SecureString" --overwrite --region '$REGION'
    aws ssm put-parameter --name "/'${clusterName}'/cluster/join-token-updated" \
        --value "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --type "String" --overwrite --region '$REGION'
    if [ -n "$CERT_KEY" ]; then
        aws ssm put-parameter --name "/'${clusterName}'/cluster/certificate-key" \
            --value "$CERT_KEY" --type "SecureString" --overwrite --region '$REGION'
    fi
    echo "TOKEN_REFRESH_SUCCESS"
else
    echo "TOKEN_REFRESH_FAILED"
fi
'

    # Execute via SSM Run Command
    local command_id=$(aws ssm send-command \
        --instance-ids "\$CONTROL_PLANE_INSTANCE" \
        --document-name "AWS-RunShellScript" \
        --parameters "commands=[\"\$token_script\"]" \
        --query 'Command.CommandId' \
        --output text --region $REGION 2>/dev/null)

    if [ -z "\$command_id" ] || [ "\$command_id" = "None" ]; then
        echo "ERROR: Failed to send SSM command"
        return 1
    fi

    echo "SSM command sent: \$command_id"

    # Wait for command completion
    local max_wait=90
    local elapsed=0
    while [ \$elapsed -lt \$max_wait ]; do
        sleep 5
        elapsed=\$((elapsed + 5))

        local status=$(aws ssm get-command-invocation \
            --command-id "\$command_id" \
            --instance-id "\$CONTROL_PLANE_INSTANCE" \
            --query 'Status' --output text --region $REGION 2>/dev/null)

        if [ "\$status" = "Success" ]; then
            local output=$(aws ssm get-command-invocation \
                --command-id "\$command_id" \
                --instance-id "\$CONTROL_PLANE_INSTANCE" \
                --query 'StandardOutputContent' --output text --region $REGION 2>/dev/null)

            if echo "\$output" | grep -q "TOKEN_REFRESH_SUCCESS"; then
                echo "Token refresh successful"
                return 0
            else
                echo "Token refresh command did not succeed"
                return 1
            fi
        elif [ "\$status" = "Failed" ] || [ "\$status" = "Cancelled" ] || [ "\$status" = "TimedOut" ]; then
            echo "SSM command failed with status: \$status"
            return 1
        fi
    done

    echo "Timeout waiting for token refresh"
    return 1
}

# Function to check if token is likely expired (older than 20 hours)
check_control_plane_token_age() {
    local token_updated=$(aws ssm get-parameter \
        --name "/${clusterName}/cluster/join-token-updated" \
        --query 'Parameter.Value' --output text --region $REGION 2>/dev/null)

    if [ -z "\$token_updated" ] || [ "\$token_updated" = "None" ]; then
        echo "unknown"
        return
    fi

    # Convert to epoch (Linux date format)
    local token_epoch=$(date -d "\$token_updated" +%s 2>/dev/null)
    local now_epoch=$(date +%s)

    if [ -z "\$token_epoch" ]; then
        echo "unknown"
        return
    fi

    local age_hours=\$(( (now_epoch - token_epoch) / 3600 ))
    echo "\$age_hours"
}

# Function to check etcd cluster health via an existing control plane node
check_etcd_health() {
    echo "Checking etcd cluster health before joining..."

    # Find a healthy control plane instance
    CONTROL_PLANE_INSTANCE=$(aws ec2 describe-instances \
        --filters "Name=tag:aws:autoscaling:groupName,Values=${clusterName}-control-plane" \
                  "Name=instance-state-name,Values=running" \
        --query 'Reservations[0].Instances[0].InstanceId' \
        --output text --region $REGION 2>/dev/null)

    if [ -z "\$CONTROL_PLANE_INSTANCE" ] || [ "\$CONTROL_PLANE_INSTANCE" = "None" ]; then
        echo "WARNING: No control plane instance found to check etcd health"
        return 0  # Allow join attempt anyway
    fi

    echo "Checking etcd via instance: \$CONTROL_PLANE_INSTANCE"

    # Check etcd health via SSM
    local health_script='
export ETCDCTL_API=3
export ETCDCTL_ENDPOINTS=https://127.0.0.1:2379
export ETCDCTL_CACERT=/etc/kubernetes/pki/etcd/ca.crt
export ETCDCTL_CERT=/etc/kubernetes/pki/etcd/server.crt
export ETCDCTL_KEY=/etc/kubernetes/pki/etcd/server.key

# Check endpoint health
if etcdctl endpoint health --cluster 2>&1; then
    # Also check that we have quorum
    MEMBER_COUNT=$(etcdctl member list 2>/dev/null | wc -l)
    if [ "$MEMBER_COUNT" -ge 1 ]; then
        echo "ETCD_HEALTHY members=$MEMBER_COUNT"
    else
        echo "ETCD_NO_MEMBERS"
    fi
else
    echo "ETCD_UNHEALTHY"
fi
'

    # Execute via SSM Run Command
    local command_id=$(aws ssm send-command \
        --instance-ids "\$CONTROL_PLANE_INSTANCE" \
        --document-name "AWS-RunShellScript" \
        --parameters "commands=[\"\$health_script\"]" \
        --query 'Command.CommandId' \
        --output text --region $REGION 2>/dev/null)

    if [ -z "\$command_id" ] || [ "\$command_id" = "None" ]; then
        echo "WARNING: Failed to send health check command"
        return 0  # Allow join attempt anyway
    fi

    # Wait for command completion
    local max_wait=60
    local elapsed=0
    while [ \$elapsed -lt \$max_wait ]; do
        sleep 5
        elapsed=\$((elapsed + 5))

        local status=$(aws ssm get-command-invocation \
            --command-id "\$command_id" \
            --instance-id "\$CONTROL_PLANE_INSTANCE" \
            --query 'Status' --output text --region $REGION 2>/dev/null)

        if [ "\$status" = "Success" ]; then
            local output=$(aws ssm get-command-invocation \
                --command-id "\$command_id" \
                --instance-id "\$CONTROL_PLANE_INSTANCE" \
                --query 'StandardOutputContent' --output text --region $REGION 2>/dev/null)

            if echo "\$output" | grep -q "ETCD_HEALTHY"; then
                local member_count=$(echo "\$output" | grep "ETCD_HEALTHY" | sed 's/.*members=//')
                echo "etcd cluster is healthy with \$member_count members"
                return 0
            elif echo "\$output" | grep -q "ETCD_NO_MEMBERS"; then
                echo "WARNING: etcd cluster has no members - this is unexpected"
                return 1
            else
                echo "WARNING: etcd cluster may be unhealthy"
                return 1
            fi
        elif [ "\$status" = "Failed" ] || [ "\$status" = "Cancelled" ] || [ "\$status" = "TimedOut" ]; then
            echo "WARNING: Health check command failed"
            return 0  # Allow join attempt anyway
        fi
    done

    echo "WARNING: Timeout waiting for health check"
    return 0  # Allow join attempt anyway
}

# Join existing cluster as additional control plane node
if [ "\$CLUSTER_INITIALIZED" = "true" ] && [ ! -f /etc/kubernetes/admin.conf ]; then
    echo "Joining existing cluster as additional control plane node..."

    # Check etcd health before attempting to join
    ETCD_HEALTHY=true
    if ! check_etcd_health; then
        echo "WARNING: etcd cluster may not be healthy. Waiting before join attempt..."
        # Wait and retry health check
        sleep 30
        if ! check_etcd_health; then
            echo "ERROR: etcd cluster still unhealthy after waiting. Aborting join."
            exit 1
        fi
    fi

    # Check token age and refresh if needed
    TOKEN_AGE=$(check_control_plane_token_age)
    echo "Join token age: \$TOKEN_AGE hours"

    if [ "\$TOKEN_AGE" != "unknown" ] && [ "\$TOKEN_AGE" -ge 20 ]; then
        echo "Token is \$TOKEN_AGE hours old (near expiry), requesting refresh..."
        request_new_control_plane_token || echo "WARNING: Token refresh failed, will try existing token"
    fi

    # Get join information from SSM (with retries)
    JOIN_TOKEN=$(retry_command_output "aws ssm get-parameter --name '/${clusterName}/cluster/join-token' --with-decryption --query 'Parameter.Value' --output text --region $REGION")
    CA_CERT_HASH=$(retry_command_output "aws ssm get-parameter --name '/${clusterName}/cluster/ca-cert-hash' --query 'Parameter.Value' --output text --region $REGION")
    CLUSTER_ENDPOINT=$(retry_command_output "aws ssm get-parameter --name '/${clusterName}/cluster/endpoint' --query 'Parameter.Value' --output text --region $REGION")
    CERT_KEY=$(retry_command_output "aws ssm get-parameter --name '/${clusterName}/cluster/certificate-key' --with-decryption --query 'Parameter.Value' --output text --region $REGION" || echo "")

    # Function to attempt control plane join
    attempt_control_plane_join() {
        local token="\$1"
        local cert_key="\$2"

        if [ -n "\$cert_key" ]; then
            kubeadm join \$CLUSTER_ENDPOINT \
                --token "\$token" \
                --discovery-token-ca-cert-hash \$CA_CERT_HASH \
                --control-plane \
                --certificate-key "\$cert_key" \
                --apiserver-advertise-address=\$PRIVATE_IP
        else
            kubeadm join \$CLUSTER_ENDPOINT \
                --token "\$token" \
                --discovery-token-ca-cert-hash \$CA_CERT_HASH \
                --control-plane \
                --apiserver-advertise-address=\$PRIVATE_IP
        fi
        return \$?
    }

    if [ -n "\$JOIN_TOKEN" ] && [ -n "\$CA_CERT_HASH" ] && [ -n "\$CLUSTER_ENDPOINT" ]; then
        BOOTSTRAP_STAGE="kubeadm-join"

        # First attempt
        if attempt_control_plane_join "\$JOIN_TOKEN" "\$CERT_KEY"; then
            echo "Successfully joined cluster as control plane node"

            # Configure kubectl for root user
            mkdir -p /root/.kube
            cp -i /etc/kubernetes/admin.conf /root/.kube/config
            chown root:root /root/.kube/config

            # Register this node's etcd member in DynamoDB for lifecycle management
            BOOTSTRAP_STAGE="etcd-registration"
            if register_etcd_member; then
                ETCD_REGISTERED=true
            else
                echo "WARNING: Failed to register etcd member, lifecycle cleanup may not work"
            fi

            # Register this instance with load balancer target group (with retries)
            BOOTSTRAP_STAGE="lb-registration"
            TARGET_GROUP_ARN=$(retry_command_output "aws elbv2 describe-target-groups --names '${clusterName}-control-plane-tg' --query 'TargetGroups[0].TargetGroupArn' --output text --region $REGION")
            if [ -n "\$TARGET_GROUP_ARN" ]; then
                if retry_command "aws elbv2 register-targets --target-group-arn \$TARGET_GROUP_ARN --targets Id=\$INSTANCE_ID,Port=6443 --region $REGION"; then
                    LB_REGISTERED=true
                fi
            else
                echo "WARNING: Could not find target group ARN"
            fi

            BOOTSTRAP_STAGE="complete"
        else
            echo "First join attempt failed, requesting fresh token..."

            # Try to get a fresh token
            BOOTSTRAP_STAGE="token-refresh"
            if request_new_control_plane_token; then
                # Get the new token
                NEW_JOIN_TOKEN=$(retry_command_output "aws ssm get-parameter --name '/${clusterName}/cluster/join-token' --with-decryption --query 'Parameter.Value' --output text --region $REGION")
                NEW_CERT_KEY=$(retry_command_output "aws ssm get-parameter --name '/${clusterName}/cluster/certificate-key' --with-decryption --query 'Parameter.Value' --output text --region $REGION" || echo "")

                if [ -n "\$NEW_JOIN_TOKEN" ]; then
                    echo "Got fresh token, retrying join..."
                    # Reset kubeadm state before retry
                    kubeadm reset -f 2>/dev/null || true

                    BOOTSTRAP_STAGE="kubeadm-join-retry"
                    if attempt_control_plane_join "\$NEW_JOIN_TOKEN" "\$NEW_CERT_KEY"; then
                        echo "Successfully joined cluster with fresh token"

                        mkdir -p /root/.kube
                        cp -i /etc/kubernetes/admin.conf /root/.kube/config
                        chown root:root /root/.kube/config

                        BOOTSTRAP_STAGE="etcd-registration"
                        if register_etcd_member; then
                            ETCD_REGISTERED=true
                        else
                            echo "WARNING: Failed to register etcd member"
                        fi

                        BOOTSTRAP_STAGE="lb-registration"
                        TARGET_GROUP_ARN=$(retry_command_output "aws elbv2 describe-target-groups --names '${clusterName}-control-plane-tg' --query 'TargetGroups[0].TargetGroupArn' --output text --region $REGION")
                        if [ -n "\$TARGET_GROUP_ARN" ]; then
                            if retry_command "aws elbv2 register-targets --target-group-arn \$TARGET_GROUP_ARN --targets Id=\$INSTANCE_ID,Port=6443 --region $REGION"; then
                                LB_REGISTERED=true
                            fi
                        fi

                        BOOTSTRAP_STAGE="complete"
                    else
                        echo "Join failed even with fresh token"
                        exit 1
                    fi
                else
                    echo "Could not get a new token"
                    exit 1
                fi
            else
                echo "Token refresh failed"
                exit 1
            fi
        fi
    else
        echo "Missing join information in SSM parameters"
        exit 1
    fi
fi

# Disable cleanup trap on successful completion
trap - EXIT
BOOTSTRAP_STAGE="complete"

echo "Control plane bootstrap completed successfully!"
`;
  }
}
