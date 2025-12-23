import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as autoscaling from 'aws-cdk-lib/aws-autoscaling';
import { Construct } from 'constructs';

export interface ComputeStackProps extends cdk.StackProps {
  readonly clusterName: string;
  readonly controlPlaneRole: iam.Role;
  readonly kmsKey: kms.IKey;
  readonly controlPlaneSecurityGroup: ec2.SecurityGroup;
  readonly controlPlaneLoadBalancer: elbv2.NetworkLoadBalancer;
  readonly controlPlaneSubnets: ec2.ISubnet[];
  readonly vpc: ec2.IVpc;
  readonly kubeletVersionParameter: ssm.StringParameter;
  readonly kubernetesVersionParameter: ssm.StringParameter;
  readonly containerRuntimeParameter: ssm.StringParameter;
}

export class ComputeStack extends cdk.Stack {
  public readonly controlPlaneLaunchTemplate: ec2.LaunchTemplate;
  public readonly controlPlaneAutoScalingGroup: autoscaling.AutoScalingGroup;

  constructor(scope: Construct, id: string, props: ComputeStackProps) {
    super(scope, id, props);

    // Create instance profile for control plane role
    const controlPlaneInstanceProfile = new iam.InstanceProfile(this, 'ControlPlaneInstanceProfile', {
      role: props.controlPlaneRole,
      instanceProfileName: `${props.clusterName}-control-plane-profile`
    });

    // Store bootstrap script in SSM Parameter
    const bootstrapScript = new ssm.StringParameter(this, 'ControlPlaneBootstrapScript', {
      parameterName: `/${props.clusterName}/bootstrap/control-plane`,
      stringValue: this.createControlPlaneBootstrapScript(props.clusterName, props.controlPlaneLoadBalancer.loadBalancerDnsName),
      description: `Bootstrap script for ${props.clusterName} control plane nodes`
    });

    // Control plane launch template
    this.controlPlaneLaunchTemplate = new ec2.LaunchTemplate(this, 'ControlPlaneLaunchTemplate', {
      launchTemplateName: `${props.clusterName}-control-plane`,
      machineImage: ec2.MachineImage.latestAmazonLinux2023(),
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.M5, ec2.InstanceSize.LARGE), // K8s recommendation
      securityGroup: props.controlPlaneSecurityGroup,
      role: props.controlPlaneRole,
      userData: ec2.UserData.custom(
        cdk.Fn.join('', [
          '#!/bin/bash\n',
          '# Config hash: ', props.kubeletVersionParameter.stringValue, '-', props.kubernetesVersionParameter.stringValue, '-', props.containerRuntimeParameter.stringValue, '\n',
          '# Download and execute bootstrap script from SSM\n',
          'aws ssm get-parameter --name "', bootstrapScript.parameterName, '" --query "Parameter.Value" --output text --region ', this.region, ' > /tmp/bootstrap.sh\n',
          'chmod +x /tmp/bootstrap.sh\n',
          '/tmp/bootstrap.sh'
        ])
      ),
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
      desiredCapacity: 3,
      autoScalingGroupName: `${props.clusterName}-control-plane`,
      defaultInstanceWarmup: cdk.Duration.minutes(15)
    });
  }

  private createControlPlaneBootstrapScript(clusterName: string, nlbDnsName: string): string {
    return `#!/bin/bash
set -e

# Control plane bootstrap script for ${clusterName}
echo "Starting control plane bootstrap for cluster: ${clusterName}"

# Get configuration from SSM parameters
KUBELET_VERSION=$(aws ssm get-parameter --name "/${clusterName}/control/kubelet/version" --query 'Parameter.Value' --output text --region ${this.region})
K8S_VERSION=$(aws ssm get-parameter --name "/${clusterName}/control/kubernetes/version" --query 'Parameter.Value' --output text --region ${this.region})
CONTAINER_RUNTIME=$(aws ssm get-parameter --name "/${clusterName}/control/container/runtime" --query 'Parameter.Value' --output text --region ${this.region})

echo "Kubelet version: $KUBELET_VERSION"
echo "Kubernetes version: $K8S_VERSION"
echo "Container runtime: $CONTAINER_RUNTIME"

# Update system
yum update -y

# Function to download binary from S3 or fallback to public
download_k8s_binary() {
    local binary_name=$1
    local version=$2
    local s3_bucket="${clusterName}-bootstrap"
    
    echo "Downloading $binary_name version $version"
    
    # Try S3 first
    if aws s3 cp "s3://$s3_bucket/binaries/$binary_name-$version" "/usr/bin/$binary_name" --region ${this.region} 2>/dev/null; then
        echo "Downloaded $binary_name from S3"
    else
        echo "S3 download failed, downloading from public repository"
        # Fallback to public Kubernetes release
        if curl -L "https://dl.k8s.io/release/v$version/bin/linux/amd64/$binary_name" -o "/usr/bin/$binary_name"; then
            echo "Downloaded $binary_name from public repository"
        else
            echo "ERROR: Failed to download $binary_name from both S3 and public repository"
            exit 1
        fi
    fi
    
    # Verify download and set permissions
    if [ ! -f "/usr/bin/$binary_name" ] || [ ! -s "/usr/bin/$binary_name" ]; then
        echo "ERROR: $binary_name download failed or file is empty"
        exit 1
    fi
    
    chmod +x "/usr/bin/$binary_name"
    echo "Successfully installed $binary_name"
}

# Download Kubernetes binaries (kubelet, kubeadm, kubectl should all use same version)
download_k8s_binary "kubelet" "$KUBELET_VERSION"
download_k8s_binary "kubeadm" "$KUBELET_VERSION"
download_k8s_binary "kubectl" "$KUBELET_VERSION"

# Install and configure container runtime
if [ "$CONTAINER_RUNTIME" = "containerd" ]; then
    yum install -y containerd
    systemctl enable containerd
    systemctl start containerd
    
    # Configure containerd for Kubernetes
    mkdir -p /etc/containerd
    containerd config default > /etc/containerd/config.toml
    sed -i 's/SystemdCgroup = false/SystemdCgroup = true/' /etc/containerd/config.toml
    systemctl restart containerd
else
    # Fallback to Docker
    yum install -y docker
    systemctl enable docker
    systemctl start docker
fi

# Configure kubelet
systemctl enable kubelet

# Initialize or join control plane
CONTROL_PLANE_ENDPOINT="${nlbDnsName}:6443"

echo "Control plane endpoint: $CONTROL_PLANE_ENDPOINT"
echo "Bootstrap script completed"
`;
  }
}
