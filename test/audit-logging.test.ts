import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { K8sClusterStack } from '../lib/k8s-cluster-stack';

describe('Kubernetes Audit Logging', () => {
  let template: Template;
  let templateJson: any;

  beforeAll(() => {
    const app = new cdk.App();
    const stack = new K8sClusterStack(app, 'TestStack', {
      clusterName: 'test-cluster',
      env: { account: '123456789012', region: 'us-west-2' }
    });
    template = Template.fromStack(stack);
    templateJson = template.toJSON();
  });

  // Helper to extract user data from control plane launch template
  function getControlPlaneUserData(): string {
    const resources = templateJson.Resources;
    for (const key of Object.keys(resources)) {
      const resource = resources[key];
      if (resource.Type === 'AWS::EC2::LaunchTemplate') {
        const name = resource.Properties?.LaunchTemplateName;
        if (name && name.includes('control-plane')) {
          const userData = resource.Properties?.LaunchTemplateData?.UserData;
          if (userData && userData['Fn::Base64']) {
            const joinData = userData['Fn::Base64']['Fn::Join'];
            if (joinData && Array.isArray(joinData[1])) {
              return joinData[1].join('');
            }
          }
        }
      }
    }
    return '';
  }

  describe('Audit Policy Configuration', () => {
    test('creates audit policy file before kubeadm init', () => {
      const userData = getControlPlaneUserData();
      // Should create audit policy file
      expect(userData).toContain('/etc/kubernetes/audit-policy.yaml');
    });

    test('audit policy includes metadata level for most requests', () => {
      const userData = getControlPlaneUserData();
      // Should have metadata level logging
      expect(userData).toMatch(/level:\s*Metadata/);
    });

    test('audit policy logs authentication failures at RequestResponse level', () => {
      const userData = getControlPlaneUserData();
      // Should log auth failures with full request/response
      expect(userData).toMatch(/level:\s*RequestResponse/);
    });

    test('audit policy excludes high-volume read-only endpoints', () => {
      const userData = getControlPlaneUserData();
      // Should exclude noisy endpoints like health checks
      expect(userData).toContain('/healthz');
      expect(userData).toContain('/readyz');
      expect(userData).toContain('/livez');
    });

    test('kubeadm init includes audit configuration', () => {
      const userData = getControlPlaneUserData();
      // kubeadm config should reference audit policy
      expect(userData).toContain('audit-policy-file');
      expect(userData).toContain('audit-log-path');
    });

    test('audit logs are written to file for CloudWatch agent pickup', () => {
      const userData = getControlPlaneUserData();
      // Audit logs should go to a file path
      expect(userData).toContain('/var/log/kubernetes/audit');
    });

    test('audit log rotation is configured', () => {
      const userData = getControlPlaneUserData();
      // Should have log rotation settings
      expect(userData).toContain('audit-log-maxage');
      expect(userData).toContain('audit-log-maxbackup');
      expect(userData).toContain('audit-log-maxsize');
    });
  });
});
