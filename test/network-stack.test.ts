import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { K8sClusterStack } from '../lib/k8s-cluster-stack';

test('Network stack creates VPC with dedicated tenancy', () => {
  const app = new cdk.App();
  const stack = new K8sClusterStack(app, 'TestStack', {
    clusterName: 'test-cluster',
    env: { account: '123456789012', region: 'us-west-2' }
  });
  const template = Template.fromStack(stack);

  template.hasResourceProperties('AWS::EC2::VPC', {
    CidrBlock: '10.0.0.0/16',
    InstanceTenancy: 'dedicated'
  });
});

test('Network stack creates VPC endpoints', () => {
  const app = new cdk.App();
  const stack = new K8sClusterStack(app, 'TestStack', {
    clusterName: 'test-cluster',
    env: { account: '123456789012', region: 'us-west-2' }
  });
  const template = Template.fromStack(stack);

  template.resourceCountIs('AWS::EC2::VPCEndpoint', 4);
});

test('Network stack creates control plane load balancer', () => {
  const app = new cdk.App();
  const stack = new K8sClusterStack(app, 'TestStack', {
    clusterName: 'test-cluster',
    env: { account: '123456789012', region: 'us-west-2' }
  });
  const template = Template.fromStack(stack);

  // Test internal NLB
  template.hasResourceProperties('AWS::ElasticLoadBalancingV2::LoadBalancer', {
    Type: 'network',
    Scheme: 'internal'
  });

  // Test target group with explicit name (required for bootstrap script discovery)
  template.hasResourceProperties('AWS::ElasticLoadBalancingV2::TargetGroup', {
    Name: 'test-cluster-control-plane-tg',
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
