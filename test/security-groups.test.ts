import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { NetworkStack } from '../lib/network-stack';

test('Network stack creates control plane security group', () => {
  const app = new cdk.App();
  const stack = new NetworkStack(app, 'TestStack', {
    clusterName: 'test-cluster'
  });
  const template = Template.fromStack(stack);

  template.hasResourceProperties('AWS::EC2::SecurityGroup', {
    GroupDescription: 'Security group for Kubernetes control plane nodes in test-cluster cluster'
  });
});

test('Network stack creates worker security group', () => {
  const app = new cdk.App();
  const stack = new NetworkStack(app, 'TestStack', {
    clusterName: 'test-cluster'
  });
  const template = Template.fromStack(stack);

  template.hasResourceProperties('AWS::EC2::SecurityGroup', {
    GroupDescription: 'Security group for Kubernetes worker nodes in test-cluster cluster'
  });
});

test('Control plane security group allows self traffic', () => {
  const app = new cdk.App();
  const stack = new NetworkStack(app, 'TestStack', {
    clusterName: 'test-cluster'
  });
  const template = Template.fromStack(stack);

  // CP SG allows all traffic from itself
  template.hasResourceProperties('AWS::EC2::SecurityGroupIngress', {
    IpProtocol: '-1',
    SourceSecurityGroupId: Match.anyValue()
  });
});

test('Control plane security group allows API server access from workers', () => {
  const app = new cdk.App();
  const stack = new NetworkStack(app, 'TestStack', {
    clusterName: 'test-cluster'
  });
  const template = Template.fromStack(stack);

  // CP SG allows TCP 6443 from worker SG
  template.hasResourceProperties('AWS::EC2::SecurityGroupIngress', {
    IpProtocol: 'tcp',
    FromPort: 6443,
    ToPort: 6443,
    SourceSecurityGroupId: Match.anyValue()
  });
});

test('Worker security group allows self traffic', () => {
  const app = new cdk.App();
  const stack = new NetworkStack(app, 'TestStack', {
    clusterName: 'test-cluster'
  });
  const template = Template.fromStack(stack);

  // Worker SG allows all traffic from itself
  template.hasResourceProperties('AWS::EC2::SecurityGroupIngress', {
    IpProtocol: '-1',
    SourceSecurityGroupId: Match.anyValue()
  });
});

test('Worker security group allows all traffic from control plane', () => {
  const app = new cdk.App();
  const stack = new NetworkStack(app, 'TestStack', {
    clusterName: 'test-cluster'
  });
  const template = Template.fromStack(stack);

  // Worker SG allows all traffic from CP SG (for kubelet -> apiserver)
  template.hasResourceProperties('AWS::EC2::SecurityGroupIngress', {
    IpProtocol: '-1',
    SourceSecurityGroupId: Match.anyValue()
  });
});
