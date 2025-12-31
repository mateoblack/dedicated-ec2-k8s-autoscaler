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
      this.createControlPlaneBootstrapScript(props.clusterName)
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
# Worker bootstrap script - Join cluster using pre-installed packages
echo "Starting worker node bootstrap for cluster: ${clusterName}"

# Get instance metadata
INSTANCE_ID=$(curl -s http://169.254.169.254/latest/meta-data/instance-id)
PRIVATE_IP=$(curl -s http://169.254.169.254/latest/meta-data/local-ipv4)
REGION=${cdk.Stack.of(this).region}

echo "Instance ID: $INSTANCE_ID"
echo "Private IP: $PRIVATE_IP"

# Wait for cluster to be initialized
echo "Waiting for cluster to be initialized..."
for i in {1..60}; do
    CLUSTER_INITIALIZED=$(aws ssm get-parameter --name "/${clusterName}/cluster/initialized" --query 'Parameter.Value' --output text --region $REGION 2>/dev/null || echo "false")
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

# Get configuration from SSM parameters
KUBERNETES_VERSION=$(aws ssm get-parameter --name "/${clusterName}/kubernetes/version" --query 'Parameter.Value' --output text --region $REGION)
CLUSTER_ENDPOINT=$(aws ssm get-parameter --name "/${clusterName}/cluster/endpoint" --query 'Parameter.Value' --output text --region $REGION)
JOIN_TOKEN=$(aws ssm get-parameter --name "/${clusterName}/cluster/join-token" --with-decryption --query 'Parameter.Value' --output text --region $REGION)
CA_CERT_HASH=$(aws ssm get-parameter --name "/${clusterName}/cluster/ca-cert-hash" --query 'Parameter.Value' --output text --region $REGION)

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

# Join cluster using pre-installed kubeadm
if [ -n "$CLUSTER_ENDPOINT" ] && [ -n "$JOIN_TOKEN" ] && [ -n "$CA_CERT_HASH" ]; then
    echo "Joining cluster using kubeadm..."
    kubeadm join $CLUSTER_ENDPOINT \\
        --token $JOIN_TOKEN \\
        --discovery-token-ca-cert-hash $CA_CERT_HASH \\
        --node-name $(hostname -f)
    
    if [ $? -eq 0 ]; then
        echo "Successfully joined cluster as worker node"
    else
        echo "Failed to join cluster, falling back to kubelet bootstrap..."
        
        # Create bootstrap kubeconfig for kubelet
        cat > /etc/kubernetes/bootstrap-kubelet.conf << EOF
apiVersion: v1
kind: Config
clusters:
- cluster:
    server: https://$CLUSTER_ENDPOINT
    insecure-skip-tls-verify: true
  name: bootstrap
contexts:
- context:
    cluster: bootstrap
    user: kubelet-bootstrap
  name: bootstrap
current-context: bootstrap
users:
- name: kubelet-bootstrap
  user:
    token: $JOIN_TOKEN
EOF
        
        # Start kubelet which will bootstrap and join the cluster
        systemctl start kubelet
    fi
else
    echo "Missing required join parameters from SSM"
    exit 1
fi

echo "Worker node bootstrap completed successfully!"
`;
  }

  private createControlPlaneBootstrapScript(clusterName: string): string {
    return `
# Control plane bootstrap script - Cluster initialization and joining
echo "Starting control plane bootstrap for cluster: ${clusterName}"

# Get instance metadata
INSTANCE_ID=$(curl -s http://169.254.169.254/latest/meta-data/instance-id)
PRIVATE_IP=$(curl -s http://169.254.169.254/latest/meta-data/local-ipv4)
REGION=${cdk.Stack.of(this).region}

# Get cluster configuration from SSM
KUBERNETES_VERSION=$(aws ssm get-parameter --name "/${clusterName}/kubernetes/version" --query 'Parameter.Value' --output text --region $REGION)
CLUSTER_ENDPOINT=$(aws ssm get-parameter --name "/${clusterName}/cluster/endpoint" --query 'Parameter.Value' --output text --region $REGION 2>/dev/null || echo "")
CLUSTER_INITIALIZED=$(aws ssm get-parameter --name "/${clusterName}/cluster/initialized" --query 'Parameter.Value' --output text --region $REGION 2>/dev/null || echo "false")

echo "Instance ID: $INSTANCE_ID"
echo "Private IP: $PRIVATE_IP"
echo "Kubernetes Version: $KUBERNETES_VERSION"
echo "Cluster Initialized: $CLUSTER_INITIALIZED"

# Configure containerd (already installed in AMI)
systemctl enable containerd
systemctl start containerd

# Configure kubelet (already installed in AMI)
systemctl enable kubelet

# Check if this should be the first control plane node
if [ "$CLUSTER_INITIALIZED" = "false" ]; then
    echo "Attempting to initialize cluster as first control plane node..."
    
    # Try to acquire cluster initialization lock using DynamoDB
    if aws dynamodb put-item \\
        --table-name "${clusterName}-etcd-members" \\
        --item '{"ClusterId":{"S":"'${clusterName}'"},"MemberId":{"S":"cluster-init-lock"},"InstanceId":{"S":"'$INSTANCE_ID'"},"Status":{"S":"INITIALIZING"},"CreatedAt":{"S":"'$(date -u +%Y-%m-%dT%H:%M:%SZ)'"}}' \\
        --condition-expression "attribute_not_exists(ClusterId)" \\
        --region $REGION 2>/dev/null; then
        
        echo "Acquired initialization lock - initializing cluster..."
        
        # Initialize cluster with kubeadm
        kubeadm init \\
            --kubernetes-version=v$KUBERNETES_VERSION \\
            --pod-network-cidr=10.244.0.0/16 \\
            --service-cidr=10.96.0.0/12 \\
            --apiserver-advertise-address=$PRIVATE_IP \\
            --control-plane-endpoint="${clusterName}-cp-lb.internal:6443" \\
            --upload-certs
        
        if [ $? -eq 0 ]; then
            echo "Cluster initialization successful!"
            
            # Configure kubectl for root user
            mkdir -p /root/.kube
            cp -i /etc/kubernetes/admin.conf /root/.kube/config
            chown root:root /root/.kube/config
            
            # Get join token and CA cert hash
            JOIN_TOKEN=$(kubeadm token list | grep -v TOKEN | head -1 | awk '{print $1}')
            CA_CERT_HASH=$(openssl x509 -pubkey -in /etc/kubernetes/pki/ca.crt | openssl rsa -pubin -outform der 2>/dev/null | openssl dgst -sha256 -hex | sed 's/^.* //')
            
            # Store cluster information in SSM
            aws ssm put-parameter --name "/${clusterName}/cluster/endpoint" --value "${clusterName}-cp-lb.internal:6443" --type "String" --overwrite --region $REGION
            aws ssm put-parameter --name "/${clusterName}/cluster/join-token" --value "$JOIN_TOKEN" --type "SecureString" --overwrite --region $REGION
            aws ssm put-parameter --name "/${clusterName}/cluster/ca-cert-hash" --value "sha256:$CA_CERT_HASH" --type "String" --overwrite --region $REGION
            aws ssm put-parameter --name "/${clusterName}/cluster/initialized" --value "true" --type "String" --overwrite --region $REGION
            
            # Install CNI plugin (Cilium)
            echo "Installing Cilium CNI plugin..."
            kubectl apply -f https://raw.githubusercontent.com/cilium/cilium/v1.14.5/install/kubernetes/quick-install.yaml
            
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
            
            # Register this instance with load balancer target group
            aws elbv2 register-targets \\
                --target-group-arn $(aws elbv2 describe-target-groups --names "${clusterName}-control-plane-tg" --query 'TargetGroups[0].TargetGroupArn' --output text --region $REGION) \\
                --targets Id=$INSTANCE_ID,Port=6443 \\
                --region $REGION
            
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

# Join existing cluster as additional control plane node
if [ "$CLUSTER_INITIALIZED" = "true" ] && [ ! -f /etc/kubernetes/admin.conf ]; then
    echo "Joining existing cluster as additional control plane node..."
    
    # Get join information from SSM
    JOIN_TOKEN=$(aws ssm get-parameter --name "/${clusterName}/cluster/join-token" --with-decryption --query 'Parameter.Value' --output text --region $REGION)
    CA_CERT_HASH=$(aws ssm get-parameter --name "/${clusterName}/cluster/ca-cert-hash" --query 'Parameter.Value' --output text --region $REGION)
    CLUSTER_ENDPOINT=$(aws ssm get-parameter --name "/${clusterName}/cluster/endpoint" --query 'Parameter.Value' --output text --region $REGION)
    
    if [ -n "$JOIN_TOKEN" ] && [ -n "$CA_CERT_HASH" ] && [ -n "$CLUSTER_ENDPOINT" ]; then
        # Join as control plane node
        kubeadm join $CLUSTER_ENDPOINT \\
            --token $JOIN_TOKEN \\
            --discovery-token-ca-cert-hash $CA_CERT_HASH \\
            --control-plane \\
            --apiserver-advertise-address=$PRIVATE_IP
        
        if [ $? -eq 0 ]; then
            echo "Successfully joined cluster as control plane node"
            
            # Configure kubectl for root user
            mkdir -p /root/.kube
            cp -i /etc/kubernetes/admin.conf /root/.kube/config
            chown root:root /root/.kube/config
            
            # Register this instance with load balancer target group
            aws elbv2 register-targets \\
                --target-group-arn $(aws elbv2 describe-target-groups --names "${clusterName}-control-plane-tg" --query 'TargetGroups[0].TargetGroupArn' --output text --region $REGION) \\
                --targets Id=$INSTANCE_ID,Port=6443 \\
                --region $REGION
        else
            echo "Failed to join cluster as control plane node"
            exit 1
        fi
    else
        echo "Missing join information in SSM parameters"
        exit 1
    fi
fi

echo "Control plane bootstrap completed successfully!"
`;
  }
}
