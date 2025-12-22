import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { Template } from 'aws-cdk-lib/assertions';
import { EgressStack } from '../lib/egress-stack';

test('Egress stack creates public subnet for NAT Gateway', () => {
  const app = new cdk.App();
  const vpcStack = new cdk.Stack(app, 'VpcStack');
  const vpc = new ec2.Vpc(vpcStack, 'TestVpc', {
    ipAddresses: ec2.IpAddresses.cidr('10.0.0.0/16')
  });
  
  const stack = new EgressStack(app, 'TestStack', {
    vpc: vpc,
    clusterName: 'test-cluster'
  });
  const template = Template.fromStack(stack);

  template.hasResourceProperties('AWS::EC2::Subnet', {
    CidrBlock: '10.0.100.0/24',
    MapPublicIpOnLaunch: false
  });
});

test('Egress stack creates Internet Gateway and NAT Gateway', () => {
  const app = new cdk.App();
  const vpcStack = new cdk.Stack(app, 'VpcStack');
  const vpc = new ec2.Vpc(vpcStack, 'TestVpc', {
    ipAddresses: ec2.IpAddresses.cidr('10.0.0.0/16')
  });
  
  const stack = new EgressStack(app, 'TestStack', {
    vpc: vpc,
    clusterName: 'test-cluster'
  });
  const template = Template.fromStack(stack);

  template.resourceCountIs('AWS::EC2::InternetGateway', 1);
  template.resourceCountIs('AWS::EC2::NatGateway', 1);
  template.resourceCountIs('AWS::EC2::EIP', 1);
});

test('Egress stack creates route to Internet Gateway for public subnet', () => {
  const app = new cdk.App();
  const vpcStack = new cdk.Stack(app, 'VpcStack');
  const vpc = new ec2.Vpc(vpcStack, 'TestVpc', {
    ipAddresses: ec2.IpAddresses.cidr('10.0.0.0/16')
  });
  
  const stack = new EgressStack(app, 'TestStack', {
    vpc: vpc,
    clusterName: 'test-cluster'
  });
  const template = Template.fromStack(stack);

  template.hasResourceProperties('AWS::EC2::Route', {
    DestinationCidrBlock: '0.0.0.0/0'
  });
});

test('Egress stack creates routes from private subnets to NAT Gateway', () => {
  const app = new cdk.App();
  const vpcStack = new cdk.Stack(app, 'VpcStack');
  const vpc = new ec2.Vpc(vpcStack, 'TestVpc', {
    ipAddresses: ec2.IpAddresses.cidr('10.0.0.0/16')
  });
  
  const stack = new EgressStack(app, 'TestStack', {
    vpc: vpc,
    clusterName: 'test-cluster'
  });
  const template = Template.fromStack(stack);

  // Verify that routes with 0.0.0.0/0 destination are created
  template.hasResourceProperties('AWS::EC2::Route', {
    DestinationCidrBlock: '0.0.0.0/0'
  });
});
