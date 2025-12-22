import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { ServicesStack } from '../lib/services-stack';

test('Services stack validates cluster name', () => {
  const app = new cdk.App();

  // Test invalid cluster names
  expect(() => {
    new ServicesStack(app, 'TestStack1', {
      clusterName: 'ab' // Too short
    });
  }).toThrow('clusterName must be at least 3 characters');

  expect(() => {
    new ServicesStack(app, 'TestStack2', {
      clusterName: 'Invalid_Name' // Contains underscore
    });
  }).toThrow('clustername must only contain lowercase letters, numbers and hyphens');
});

test('Services stack sets parameter names correctly', () => {
  const app = new cdk.App();
  const stack = new ServicesStack(app, 'TestStack', {
    clusterName: 'test-cluster'
  });

  expect(stack.workerJoinParameterName).toBe('/test-cluster/kubeadm/worker-join');
  expect(stack.controlPlaneJoinParameter).toBe('/test-cluster/kubeadm/control-plane-join');
});
