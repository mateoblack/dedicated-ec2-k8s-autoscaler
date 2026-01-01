import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { K8sClusterStack } from '../lib/k8s-cluster-stack';

describe('Cluster Init Lock', () => {
  let template: Template;
  let templateJson: any;
  let controlPlaneUserData: string;

  // Helper to extract string content from CloudFormation intrinsic functions
  function extractStringContent(obj: any): string {
    if (typeof obj === 'string') {
      return obj;
    }
    if (Array.isArray(obj)) {
      return obj.map(extractStringContent).join('');
    }
    if (obj && typeof obj === 'object') {
      if (obj['Fn::Join']) {
        const [separator, parts] = obj['Fn::Join'];
        return parts.map(extractStringContent).join(separator);
      }
      if (obj['Fn::Base64']) {
        return extractStringContent(obj['Fn::Base64']);
      }
      if (obj['Ref']) {
        return `\${${obj['Ref']}}`;
      }
      if (obj['Fn::GetAtt']) {
        return `\${${obj['Fn::GetAtt'].join('.')}}`;
      }
    }
    return '';
  }

  beforeAll(() => {
    const app = new cdk.App();
    const stack = new K8sClusterStack(app, 'TestStack', {
      clusterName: 'test-cluster',
      env: { account: '123456789012', region: 'us-west-2' }
    });
    template = Template.fromStack(stack);
    templateJson = template.toJSON();

    // Extract control plane user data
    const resources = templateJson.Resources;
    for (const key of Object.keys(resources)) {
      const resource = resources[key];
      if (resource.Type === 'AWS::EC2::LaunchTemplate' &&
          key.includes('ControlPlane')) {
        const userData = resource.Properties?.LaunchTemplateData?.UserData;
        if (userData) {
          controlPlaneUserData = extractStringContent(userData);
        }
      }
    }
  });

  describe('Bootstrap Lock Table Usage', () => {
    test('uses bootstrap-lock table for cluster initialization lock', () => {
      // Verify the bootstrap-lock table is used
      expect(controlPlaneUserData).toContain('test-cluster-bootstrap-lock');
    });

    test('uses LockName key schema for bootstrap lock', () => {
      // The key should be {"LockName":{"S":"cluster-init"}}
      expect(controlPlaneUserData).toContain('LockName');
      expect(controlPlaneUserData).toContain('cluster-init');
    });

    test('does not use etcd-members table for init lock', () => {
      // Ensure we're not incorrectly using etcd-members for the init lock
      // The init lock pattern should only appear with bootstrap-lock table
      const lines = controlPlaneUserData.split('\n');

      let foundEtcdMembersWithInitLock = false;
      for (const line of lines) {
        // Check if any line uses etcd-members AND cluster-init-lock together
        if (line.includes('etcd-members') && line.includes('cluster-init-lock')) {
          foundEtcdMembersWithInitLock = true;
        }
      }

      expect(foundEtcdMembersWithInitLock).toBe(false);
    });

    test('uses condition-expression to prevent race conditions', () => {
      // The put-item should use condition-expression to ensure only one node wins
      expect(controlPlaneUserData).toContain('condition-expression');
      expect(controlPlaneUserData).toContain('attribute_not_exists(LockName)');
    });
  });

  describe('Lock Cleanup on Failure', () => {
    test('releases lock on cluster initialization failure', () => {
      expect(controlPlaneUserData).toContain('Releasing cluster initialization lock');
      expect(controlPlaneUserData).toContain('delete-item');
    });

    test('cleanup uses correct bootstrap-lock table', () => {
      // Find delete-item commands that reference bootstrap-lock
      const deleteItemPattern = /delete-item.*bootstrap-lock/;
      expect(deleteItemPattern.test(controlPlaneUserData)).toBe(true);
    });
  });

  describe('Lock Acquisition', () => {
    test('tracks lock holder instance ID', () => {
      // The put-item should include InstanceId for tracking who holds the lock
      expect(controlPlaneUserData).toContain('InstanceId');
    });

    test('includes status in lock item', () => {
      // The lock should track status (INITIALIZING)
      expect(controlPlaneUserData).toContain('INITIALIZING');
    });

    test('includes timestamp in lock item', () => {
      // The lock should have a CreatedAt timestamp
      expect(controlPlaneUserData).toContain('CreatedAt');
    });
  });
});
