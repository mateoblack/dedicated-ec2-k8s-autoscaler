import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { K8sClusterStack } from '../lib/k8s-cluster-stack';

test('Services stack validates cluster name', () => {
  const app = new cdk.App();

  // Test invalid cluster names
  expect(() => {
    new K8sClusterStack(app, 'TestStack1', {
      clusterName: 'ab', // Too short
      env: { account: '123456789012', region: 'us-west-2' }
    });
  }).toThrow('clusterName must be at least 3 characters');

  expect(() => {
    new K8sClusterStack(app, 'TestStack2', {
      clusterName: 'Invalid_Name', // Contains underscore
      env: { account: '123456789012', region: 'us-west-2' }
    });
  }).toThrow('clustername must only contain lowercase letters, numbers and hyphens');
});

test('Services stack sets parameter names correctly', () => {
  const app = new cdk.App();
  const stack = new K8sClusterStack(app, 'TestStack', {
    clusterName: 'test-cluster',
    env: { account: '123456789012', region: 'us-west-2' }
  });

  expect(stack.servicesStack.workerJoinParameterName).toBe('/test-cluster/kubeadm/worker-join');
  expect(stack.servicesStack.controlPlaneJoinParameter).toBe('/test-cluster/kubeadm/control-plane-join');
});
