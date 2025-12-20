import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import * as DedicatedEc2K8sAutoscaler from '../lib/dedicated-ec2-k8s-autoscaler-stack';

test('VPC with dedicated tenancy and CIDR configuration', () => {
  const app = new cdk.App();
  const stack = new DedicatedEc2K8sAutoscaler.DedicatedEc2K8sAutoscalerStack(app, 'TestStack');
  const template = Template.fromStack(stack);

  // Test VPC with primary CIDR and dedicated tenancy
  template.hasResourceProperties('AWS::EC2::VPC', {
    CidrBlock: '10.0.0.0/16',
    InstanceTenancy: 'dedicated'
  });

  // Test secondary CIDR block for pod communication
  template.hasResourceProperties('AWS::EC2::VPCCidrBlock', {
    CidrBlock: '10.1.0.0/16'
  });

  // Test total subnets (6 primary + 2 pod communication = 8, limited by AZs)
  template.resourceCountIs('AWS::EC2::Subnet', 8);

  // Test primary subnet CIDRs
  template.hasResourceProperties('AWS::EC2::Subnet', {
    CidrBlock: '10.0.0.0/24'
  });
  template.hasResourceProperties('AWS::EC2::Subnet', {
    CidrBlock: '10.0.1.0/24'
  });

  // Test pod communication subnet CIDRs
  template.hasResourceProperties('AWS::EC2::Subnet', {
    CidrBlock: '10.1.0.0/24'
  });
  template.hasResourceProperties('AWS::EC2::Subnet', {
    CidrBlock: '10.1.1.0/24'
  });
});

test('KMS CMK exists with rotation enabled', () => {
  const app = new cdk.App();
  const stack = new DedicatedEc2K8sAutoscaler.DedicatedEc2K8sAutoscalerStack(app, 'TestStack');
  const template = Template.fromStack(stack);

  // Test KMS key exists
  template.resourceCountIs('AWS::KMS::Key', 1);

  // Test KMS key has rotation enabled
  template.hasResourceProperties('AWS::KMS::Key', {
    EnableKeyRotation: true,
    Description: 'KMS key for K8s autoscaler encryption'
  });
});

test('SSM VPC endpoints and security groups configured', () => {
  const app = new cdk.App();
  const stack = new DedicatedEc2K8sAutoscaler.DedicatedEc2K8sAutoscalerStack(app, 'TestStack');
  const template = Template.fromStack(stack);

  // Test VPC endpoints exist (4 endpoints: SSM, SSM Messages, EC2 Messages, KMS)
  template.resourceCountIs('AWS::EC2::VPCEndpoint', 4);

  // Test security group exists with correct description
  template.hasResourceProperties('AWS::EC2::SecurityGroup', {
    GroupDescription: 'Security group for SSM endpoints'
  });

  // Test security group has ingress rule on port 443
  template.hasResourceProperties('AWS::EC2::SecurityGroup', {
    SecurityGroupIngress: Match.arrayWith([
      Match.objectLike({
        FromPort: 443,
        ToPort: 443,
        IpProtocol: 'tcp'
      })
    ])
  });

  // Test VPC endpoints are interface type with security groups
  template.hasResourceProperties('AWS::EC2::VPCEndpoint', {
    VpcEndpointType: 'Interface',
    SecurityGroupIds: Match.anyValue()
  });
});
