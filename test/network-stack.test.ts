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

test('Network stack creates control plane load balancer', () => {
  const app = new cdk.App();
  const stack = new NetworkStack(app, 'TestStack', {
    clusterName: 'test-cluster'
  });
  const template = Template.fromStack(stack);

  // Test internal NLB
  template.hasResourceProperties('AWS::ElasticLoadBalancingV2::LoadBalancer', {
    Type: 'network',
    Scheme: 'internal'
  });

  // Test target group
  template.hasResourceProperties('AWS::ElasticLoadBalancingV2::TargetGroup', {
    Port: 6443,
    Protocol: 'TCP',
    TargetType: 'instance'
  });

  // Test listener
  template.hasResourceProperties('AWS::ElasticLoadBalancingV2::Listener', {
    Port: 6443,
    Protocol: 'TCP'
  });
});
