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

  describe('Lock Release on SSM Parameter Update Failure', () => {
    // If SSM parameter updates fail AFTER kubeadm init succeeds,
    // the lock must still be released to prevent permanent blocking

    test('has function to release init lock explicitly', () => {
      // Should have a dedicated function to release the lock
      expect(controlPlaneUserData).toContain('release_init_lock');
    });

    test('release function deletes lock from DynamoDB', () => {
      // The release function should actually delete from DynamoDB
      expect(controlPlaneUserData).toMatch(/release_init_lock.*delete-item|delete-item.*release_init_lock/s);
    });

    test('calls release function when setting CLUSTER_LOCK_HELD to false', () => {
      // When CLUSTER_LOCK_HELD is set to false, the lock should actually be deleted
      // Not just the variable set - must delete from DynamoDB
      expect(controlPlaneUserData).toMatch(/CLUSTER_LOCK_HELD=false.*release_init_lock|release_init_lock.*CLUSTER_LOCK_HELD=false/s);
    });

    test('handles SSM parameter update failures with lock release', () => {
      // If retry_command fails for SSM, the lock should be released
      expect(controlPlaneUserData).toMatch(/ssm.*fail.*release|release.*ssm.*fail|param.*fail.*release/i);
    });

    test('exits with error code when critical SSM updates fail', () => {
      // Script should exit with non-zero when SSM parameters cannot be set
      // This ensures cleanup_on_failure is triggered
      expect(controlPlaneUserData).toMatch(/ssm.*exit 1|param.*fail.*exit|critical.*exit/i);
    });

    test('logs when releasing lock due to failure', () => {
      // Should log that lock is being released due to failure
      expect(controlPlaneUserData).toMatch(/releas.*lock.*fail|fail.*releas.*lock/i);
    });
  });
});
