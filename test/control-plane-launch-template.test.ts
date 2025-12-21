import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { ComputeStack } from '../lib/compute-stack';
import { NetworkStack } from '../lib/network-stack';
import { IamStack } from '../lib/iam-stack';

test('Compute stack creates control plane launch template', () => {
  const app = new cdk.App();
  const iamStack = new IamStack(app, 'IamStack', {
    clusterName: 'test-cluster'
  });
  const networkStack = new NetworkStack(app, 'NetworkStack', {
    clusterName: 'test-cluster'
  });
  const stack = new ComputeStack(app, 'TestStack', {
    clusterName: 'test-cluster',
    controlPlaneRole: iamStack.controlPlaneRole,
    kmsKey: iamStack.kmsKey,
    controlPlaneSecurityGroup: networkStack.controlPlaneSecurityGroup,
    controlPlaneLoadBalancer: networkStack.controlPlaneLoadBalancer
  });
  const template = Template.fromStack(stack);

  template.hasResourceProperties('AWS::EC2::LaunchTemplate', {
    LaunchTemplateName: 'test-cluster-control-plane'
  });
});

test('Control plane launch template uses Amazon Linux 2023', () => {
  const app = new cdk.App();
  const iamStack = new IamStack(app, 'IamStack', {
    clusterName: 'test-cluster'
  });
  const networkStack = new NetworkStack(app, 'NetworkStack', {
    clusterName: 'test-cluster'
  });
  const stack = new ComputeStack(app, 'TestStack', {
    clusterName: 'test-cluster',
    controlPlaneRole: iamStack.controlPlaneRole,
    kmsKey: iamStack.kmsKey,
    controlPlaneSecurityGroup: networkStack.controlPlaneSecurityGroup,
    controlPlaneLoadBalancer: networkStack.controlPlaneLoadBalancer
  });
  const template = Template.fromStack(stack);

  template.hasResourceProperties('AWS::EC2::LaunchTemplate', {
    LaunchTemplateData: {
      ImageId: Match.anyValue() // AL2023 AMI ID
    }
  });
});

test('Control plane launch template has dedicated tenancy', () => {
  const app = new cdk.App();
  const iamStack = new IamStack(app, 'IamStack', {
    clusterName: 'test-cluster'
  });
  const networkStack = new NetworkStack(app, 'NetworkStack', {
    clusterName: 'test-cluster'
  });
  const stack = new ComputeStack(app, 'TestStack', {
    clusterName: 'test-cluster',
    controlPlaneRole: iamStack.controlPlaneRole,
    kmsKey: iamStack.kmsKey,
    controlPlaneSecurityGroup: networkStack.controlPlaneSecurityGroup,
    controlPlaneLoadBalancer: networkStack.controlPlaneLoadBalancer
  });
  const template = Template.fromStack(stack);

  template.hasResourceProperties('AWS::EC2::LaunchTemplate', {
    LaunchTemplateData: {
      Placement: {
        Tenancy: 'dedicated'
      }
    }
  });
});

test('Control plane launch template has correct security group and IAM role', () => {
  const app = new cdk.App();
  const iamStack = new IamStack(app, 'IamStack', {
    clusterName: 'test-cluster'
  });
  const networkStack = new NetworkStack(app, 'NetworkStack', {
    clusterName: 'test-cluster'
  });
  const stack = new ComputeStack(app, 'TestStack', {
    clusterName: 'test-cluster',
    controlPlaneRole: iamStack.controlPlaneRole,
    kmsKey: iamStack.kmsKey,
    controlPlaneSecurityGroup: networkStack.controlPlaneSecurityGroup,
    controlPlaneLoadBalancer: networkStack.controlPlaneLoadBalancer
  });
  const template = Template.fromStack(stack);

  template.hasResourceProperties('AWS::EC2::LaunchTemplate', {
    LaunchTemplateData: {
      SecurityGroupIds: Match.anyValue(),
      IamInstanceProfile: {
        Name: Match.anyValue()
      }
    }
  });
});

test('Control plane launch template requires IMDSv2', () => {
  const app = new cdk.App();
  const iamStack = new IamStack(app, 'IamStack', {
    clusterName: 'test-cluster'
  });
  const networkStack = new NetworkStack(app, 'NetworkStack', {
    clusterName: 'test-cluster'
  });
  const stack = new ComputeStack(app, 'TestStack', {
    clusterName: 'test-cluster',
    controlPlaneRole: iamStack.controlPlaneRole,
    kmsKey: iamStack.kmsKey,
    controlPlaneSecurityGroup: networkStack.controlPlaneSecurityGroup,
    controlPlaneLoadBalancer: networkStack.controlPlaneLoadBalancer
  });
  const template = Template.fromStack(stack);

  template.hasResourceProperties('AWS::EC2::LaunchTemplate', {
    LaunchTemplateData: {
      MetadataOptions: {
        HttpTokens: 'required',
        HttpPutResponseHopLimit: 2
      }
    }
  });
});

test('Control plane launch template has encrypted EBS volume', () => {
  const app = new cdk.App();
  const iamStack = new IamStack(app, 'IamStack', {
    clusterName: 'test-cluster'
  });
  const networkStack = new NetworkStack(app, 'NetworkStack', {
    clusterName: 'test-cluster'
  });
  const stack = new ComputeStack(app, 'TestStack', {
    clusterName: 'test-cluster',
    controlPlaneRole: iamStack.controlPlaneRole,
    kmsKey: iamStack.kmsKey,
    controlPlaneSecurityGroup: networkStack.controlPlaneSecurityGroup,
    controlPlaneLoadBalancer: networkStack.controlPlaneLoadBalancer
  });
  const template = Template.fromStack(stack);

  template.hasResourceProperties('AWS::EC2::LaunchTemplate', {
    LaunchTemplateData: {
      BlockDeviceMappings: [
        {
          DeviceName: '/dev/xvda',
          Ebs: {
            VolumeSize: 150,
            VolumeType: 'gp3',
            Encrypted: true,
            KmsKeyId: Match.anyValue()
          }
        }
      ]
    }
  });
});

test('Control plane launch template has user data with bootstrap script', () => {
  const app = new cdk.App();
  const iamStack = new IamStack(app, 'IamStack', {
    clusterName: 'test-cluster'
  });
  const networkStack = new NetworkStack(app, 'NetworkStack', {
    clusterName: 'test-cluster'
  });
  const stack = new ComputeStack(app, 'TestStack', {
    clusterName: 'test-cluster',
    controlPlaneRole: iamStack.controlPlaneRole,
    kmsKey: iamStack.kmsKey,
    controlPlaneSecurityGroup: networkStack.controlPlaneSecurityGroup,
    controlPlaneLoadBalancer: networkStack.controlPlaneLoadBalancer
  });
  const template = Template.fromStack(stack);

  template.hasResourceProperties('AWS::EC2::LaunchTemplate', {
    LaunchTemplateData: {
      UserData: Match.anyValue()
    }
  });
});
