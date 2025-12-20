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
