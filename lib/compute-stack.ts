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
        `#!/bin/bash
# Download and execute bootstrap script from SSM
aws ssm get-parameter --name "${bootstrapScript.parameterName}" --query "Parameter.Value" --output text --region ${this.region} > /tmp/bootstrap.sh
chmod +x /tmp/bootstrap.sh
/tmp/bootstrap.sh`
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
      autoScalingGroupName: `${props.clusterName}-control-plane`
    });
  }

  private createControlPlaneBootstrapScript(clusterName: string, nlbDnsName: string): string {
    return `#!/bin/bash
set -e

# Control plane bootstrap script for ${clusterName}
echo "Starting control plane bootstrap for cluster: ${clusterName}"

# Update system
yum update -y

# Install required packages
yum install -y docker kubelet kubeadm kubectl

# Configure Docker
systemctl enable docker
systemctl start docker

# Configure kubelet
systemctl enable kubelet

# Initialize or join control plane
CONTROL_PLANE_ENDPOINT="${nlbDnsName}:6443"

echo "Control plane endpoint: $CONTROL_PLANE_ENDPOINT"
echo "Bootstrap script completed"
`;
  }
}
