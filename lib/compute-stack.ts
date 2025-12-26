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

export interface ComputeStackProps extends cdk.StackProps {
  readonly clusterName: string;
  readonly controlPlaneRole: iam.Role;
  readonly workerNodeRole: iam.Role;
  readonly kmsKey: kms.IKey;
  readonly controlPlaneSecurityGroup: ec2.SecurityGroup;
  readonly workerSecurityGroup: ec2.SecurityGroup;
  readonly controlPlaneLoadBalancer: elbv2.NetworkLoadBalancer;
  readonly controlPlaneSubnets: ec2.ISubnet[];
  readonly workerSubnets: ec2.ISubnet[];
  readonly vpc: ec2.IVpc;
  readonly kubeletVersionParameter: ssm.StringParameter;
  readonly kubernetesVersionParameter: ssm.StringParameter;
  readonly containerRuntimeParameter: ssm.StringParameter;
  readonly etcdMemberTable: dynamodb.Table;
}

export class ComputeStack extends cdk.Stack {
  public readonly controlPlaneLaunchTemplate: ec2.LaunchTemplate;
  public readonly controlPlaneAutoScalingGroup: autoscaling.AutoScalingGroup;
  public readonly workerLaunchTemplate: ec2.LaunchTemplate;
  public readonly workerAutoScalingGroup: autoscaling.AutoScalingGroup;
  public readonly etcdLifecycleLambda: lambda.Function;

  constructor(scope: Construct, id: string, props: ComputeStackProps) {
    super(scope, id, props);

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
        [this.region]: controlPlaneAmiId,
      }),
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.M5, ec2.InstanceSize.LARGE), // K8s recommendation
      securityGroup: props.controlPlaneSecurityGroup,
      role: props.controlPlaneRole,
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
    this.etcdLifecycleLambda = new lambda.Function(this, 'EtcdLifecycleLambda', {
      functionName: `${props.clusterName}-etcd-lifecycle`,
      runtime: lambda.Runtime.PYTHON_3_11,
      handler: 'index.handler',
      code: lambda.Code.fromInline(this.createEtcdLifecycleLambdaCode(props.clusterName)),
      timeout: cdk.Duration.minutes(5),
      environment: {
        CLUSTER_NAME: props.clusterName,
        ETCD_TABLE_NAME: props.etcdMemberTable.tableName,
        REGION: this.region,
        CONTROL_PLANE_ASG_NAME: `${props.clusterName}-control-plane`
      }
    });

    // Grant Lambda permissions
    props.etcdMemberTable.grantReadWriteData(this.etcdLifecycleLambda);
    props.kmsKey.grantDecrypt(this.etcdLifecycleLambda);
    
    this.etcdLifecycleLambda.addToRolePolicy(new iam.PolicyStatement({
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
    const lifecycleHook = new autoscaling.LifecycleHook(this, 'EtcdLifecycleHook', {
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
    const workerConfigHash = cdk.Fn.join('', [
      props.kubeletVersionParameter.parameterName,
      props.kubernetesVersionParameter.parameterName,
      props.containerRuntimeParameter.parameterName
    ]);

    this.workerLaunchTemplate = new ec2.LaunchTemplate(this, 'WorkerLaunchTemplate', {
      launchTemplateName: `${props.clusterName}-worker`,
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.M5, ec2.InstanceSize.LARGE),
      machineImage: ec2.MachineImage.genericLinux({
        [this.region]: workerAmiId,
      }),
      role: props.workerNodeRole,
      securityGroup: props.workerSecurityGroup,
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

logger = logging.getLogger()
logger.setLevel(logging.INFO)

dynamodb = boto3.resource('dynamodb')
ec2 = boto3.client('ec2')
autoscaling = boto3.client('autoscaling')

def handler(event, context):
    try:
        logger.info(f"Received event: {json.dumps(event)}")
        
        # Parse lifecycle hook event
        detail = event.get('detail', {})
        instance_id = detail.get('EC2InstanceId')
        lifecycle_hook_name = detail.get('LifecycleHookName')
        auto_scaling_group_name = detail.get('AutoScalingGroupName')
        lifecycle_action_token = detail.get('LifecycleActionToken')
        
        if not instance_id:
            logger.error("No instance ID found in event")
            return {'statusCode': 400, 'body': 'No instance ID'}
        
        logger.info(f"Processing termination for instance: {instance_id}")
        
        # Get instance details
        response = ec2.describe_instances(InstanceIds=[instance_id])
        if not response['Reservations']:
            logger.error(f"Instance {instance_id} not found")
            complete_lifecycle_action(auto_scaling_group_name, lifecycle_hook_name, 
                                    lifecycle_action_token, instance_id, 'CONTINUE')
            return {'statusCode': 404, 'body': 'Instance not found'}
        
        instance = response['Reservations'][0]['Instances'][0]
        private_ip = instance.get('PrivateIpAddress')
        
        # Look up etcd member in DynamoDB
        table = dynamodb.Table(os.environ['ETCD_TABLE_NAME'])
        
        try:
            # Query by instance ID using GSI
            response = table.query(
                IndexName='InstanceIdIndex',
                KeyConditionExpression='InstanceId = :iid',
                ExpressionAttributeValues={':iid': instance_id}
            )
            
            if response['Items']:
                member = response['Items'][0]
                etcd_member_id = member.get('EtcdMemberId')
                
                if etcd_member_id:
                    # Remove from etcd cluster
                    remove_etcd_member(etcd_member_id, private_ip)
                    
                    # Update DynamoDB record
                    table.update_item(
                        Key={
                            'ClusterId': member['ClusterId'],
                            'MemberId': member['MemberId']
                        },
                        UpdateExpression='SET #status = :status, RemovedAt = :timestamp',
                        ExpressionAttributeNames={'#status': 'Status'},
                        ExpressionAttributeValues={
                            ':status': 'REMOVED',
                            ':timestamp': context.aws_request_id
                        }
                    )
                    
                    logger.info(f"Successfully removed etcd member {etcd_member_id}")
                else:
                    logger.warning(f"No etcd member ID found for instance {instance_id}")
            else:
                logger.warning(f"No etcd member record found for instance {instance_id}")
        
        except Exception as e:
            logger.error(f"Error processing etcd member removal: {str(e)}")
        
        # Complete lifecycle action
        complete_lifecycle_action(auto_scaling_group_name, lifecycle_hook_name, 
                                lifecycle_action_token, instance_id, 'CONTINUE')
        
        return {'statusCode': 200, 'body': 'Success'}
        
    except Exception as e:
        logger.error(f"Unexpected error: {str(e)}")
        return {'statusCode': 500, 'body': f'Error: {str(e)}'}

def remove_etcd_member(member_id, private_ip):
    """Remove member from etcd cluster using etcdctl via SSM"""
    try:
        logger.info(f"Removing etcd member {member_id} with IP {private_ip}")
        
        # Find healthy control plane instances to execute etcdctl on
        healthy_instances = get_healthy_control_plane_instances()
        
        if not healthy_instances:
            logger.error("No healthy control plane instances found")
            raise Exception("No healthy control plane instances available")
        
        # Use the first healthy instance to execute etcdctl
        target_instance = healthy_instances[0]
        logger.info(f"Executing etcdctl on instance {target_instance}")
        
        # Execute etcdctl member remove via SSM
        ssm = boto3.client('ssm')
        
        command = f"""
        export ETCDCTL_API=3
        export ETCDCTL_ENDPOINTS=https://127.0.0.1:2379
        export ETCDCTL_CACERT=/etc/kubernetes/pki/etcd/ca.crt
        export ETCDCTL_CERT=/etc/kubernetes/pki/etcd/server.crt
        export ETCDCTL_KEY=/etc/kubernetes/pki/etcd/server.key
        
        etcdctl member remove {member_id}
        """
        
        response = ssm.send_command(
            InstanceIds=[target_instance],
            DocumentName='AWS-RunShellScript',
            Parameters={
                'commands': [command]
            },
            TimeoutSeconds=60
        )
        
        command_id = response['Command']['CommandId']
        logger.info(f"SSM command sent: {command_id}")
        
        # Wait for command completion
        import time
        for _ in range(12):  # Wait up to 60 seconds
            time.sleep(5)
            result = ssm.get_command_invocation(
                CommandId=command_id,
                InstanceId=target_instance
            )
            
            status = result['Status']
            if status == 'Success':
                logger.info(f"Successfully removed etcd member {member_id}")
                return
            elif status in ['Failed', 'Cancelled', 'TimedOut']:
                error_msg = result.get('StandardErrorContent', 'Unknown error')
                logger.error(f"etcdctl command failed: {error_msg}")
                raise Exception(f"etcdctl member remove failed: {error_msg}")
        
        raise Exception("etcdctl command timed out")
        
    except Exception as e:
        logger.error(f"Failed to remove etcd member {member_id}: {str(e)}")
        raise

def get_healthy_control_plane_instances():
    """Get list of healthy control plane instances"""
    try:
        # Get all instances in the control plane ASG
        asg_name = os.environ.get('CONTROL_PLANE_ASG_NAME')
        if not asg_name:
            logger.error("CONTROL_PLANE_ASG_NAME environment variable not set")
            return []
        
        autoscaling = boto3.client('autoscaling')
        response = autoscaling.describe_auto_scaling_groups(
            AutoScalingGroupNames=[asg_name]
        )
        
        if not response['AutoScalingGroups']:
            return []
        
        asg = response['AutoScalingGroups'][0]
        instance_ids = [i['InstanceId'] for i in asg['Instances'] 
                       if i['LifecycleState'] == 'InService']
        
        if not instance_ids:
            return []
        
        # Check instance health via EC2
        ec2 = boto3.client('ec2')
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

def complete_lifecycle_action(asg_name, hook_name, token, instance_id, result):
    """Complete the lifecycle action"""
    try:
        autoscaling.complete_lifecycle_action(
            LifecycleHookName=hook_name,
            AutoScalingGroupName=asg_name,
            LifecycleActionToken=token,
            InstanceId=instance_id,
            LifecycleActionResult=result
        )
        logger.info(f"Completed lifecycle action for {instance_id} with result {result}")
    except Exception as e:
        logger.error(f"Failed to complete lifecycle action: {str(e)}")
`;
  }

  private createWorkerBootstrapScript(clusterName: string): string {
    return `
# Get SSM parameters
KUBELET_VERSION=$(aws ssm get-parameter --name "/${clusterName}/kubelet/version" --query 'Parameter.Value' --output text --region ${this.region})
KUBERNETES_VERSION=$(aws ssm get-parameter --name "/${clusterName}/kubernetes/version" --query 'Parameter.Value' --output text --region ${this.region})
CONTAINER_RUNTIME=$(aws ssm get-parameter --name "/${clusterName}/container/runtime" --query 'Parameter.Value' --output text --region ${this.region})

# Download binaries with S3 fallback
download_binary() {
    local binary_name=$1
    local version=$2
    local s3_bucket="${clusterName}-bootstrap-${this.account}"
    
    # Try S3 first
    if aws s3 cp "s3://$s3_bucket/binaries/$binary_name-$version" "/usr/local/bin/$binary_name" 2>/dev/null; then
        echo "Downloaded $binary_name from S3"
    else
        echo "S3 download failed, trying public repository"
        case $binary_name in
            kubelet)
                curl -L "https://dl.k8s.io/release/v$version/bin/linux/amd64/kubelet" -o "/usr/local/bin/kubelet"
                ;;
            kubectl)
                curl -L "https://dl.k8s.io/release/v$version/bin/linux/amd64/kubectl" -o "/usr/local/bin/kubectl"
                ;;
        esac
    fi
    chmod +x "/usr/local/bin/$binary_name"
}

# Install container runtime
if [ "$CONTAINER_RUNTIME" = "containerd" ]; then
    yum install -y containerd
    systemctl enable containerd
    systemctl start containerd
fi

# Download Kubernetes binaries
download_binary "kubelet" "$KUBELET_VERSION"
download_binary "kubectl" "$KUBERNETES_VERSION"

# Configure kubelet for worker node
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
EOF

# Create kubelet systemd service
cat > /etc/systemd/system/kubelet.service << 'EOF'
[Unit]
Description=kubelet: The Kubernetes Node Agent
Documentation=https://kubernetes.io/docs/home/
Wants=network-online.target
After=network-online.target

[Service]
ExecStart=/usr/local/bin/kubelet \\
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

# Enable kubelet (will start after joining cluster)
systemctl daemon-reload
systemctl enable kubelet

echo "Worker node bootstrap completed"
`;
  }
}
