import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { K8sClusterStack } from '../lib/k8s-cluster-stack';

test('Database stack creates DynamoDB tables', () => {
  const app = new cdk.App();
  const stack = new K8sClusterStack(app, 'TestStack', {
    clusterName: 'test-cluster',
    env: { account: '123456789012', region: 'us-west-2' }
  });
  const template = Template.fromStack(stack);

  template.hasResourceProperties('AWS::DynamoDB::Table', {
    TableName: 'test-cluster-bootstrap-lock'
  });

  template.hasResourceProperties('AWS::DynamoDB::Table', {
    TableName: 'test-cluster-etcd-members'
  });
});

test('Database stack creates S3 buckets', () => {
  const app = new cdk.App();
  const stack = new K8sClusterStack(app, 'TestStack', {
    clusterName: 'test-cluster',
    env: { account: '123456789012', region: 'us-west-2' }
  });
  const template = Template.fromStack(stack);

  // Bootstrap bucket (private, KMS encrypted) + OIDC bucket (public read for IRSA)
  template.resourceCountIs('AWS::S3::Bucket', 2);
});
