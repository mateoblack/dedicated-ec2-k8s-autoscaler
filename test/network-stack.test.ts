import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { NetworkStack } from '../lib/network-stack';

test('Network stack creates VPC with dedicated tenancy', () => {
  const app = new cdk.App();
  const stack = new NetworkStack(app, 'TestStack', {
    clusterName: 'test-cluster'
  });
  const template = Template.fromStack(stack);

  template.hasResourceProperties('AWS::EC2::VPC', {
    CidrBlock: '10.0.0.0/16',
    InstanceTenancy: 'dedicated'
  });
});

test('Network stack creates VPC endpoints', () => {
  const app = new cdk.App();
  const stack = new NetworkStack(app, 'TestStack', {
    clusterName: 'test-cluster'
  });
  const template = Template.fromStack(stack);

  template.resourceCountIs('AWS::EC2::VPCEndpoint', 4);
});
