import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { K8sClusterStack } from '../lib/k8s-cluster-stack';

export function createTestStack() {
  const app = new cdk.App();
  const stack = new K8sClusterStack(app, 'TestStack', {
    clusterName: 'my-cluster',
    env: { account: '123456789012', region: 'us-west-2' }
  });
  return { stack, template: Template.fromStack(stack) };
}
