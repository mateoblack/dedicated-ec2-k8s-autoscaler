import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { K8sClusterStack } from '../lib/k8s-cluster-stack';

describe('High Availability - System Components', () => {
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

  // Helper to extract user data from launch template
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

  describe('Cluster Autoscaler HA', () => {
    test('cluster-autoscaler has 2 replicas for high availability', () => {
      const userData = getControlPlaneUserData();
      // Check that cluster-autoscaler deployment has replicas: 2
      expect(userData).toMatch(/cluster-autoscaler[\s\S]*?replicas:\s*2/);
    });

    test('cluster-autoscaler has pod anti-affinity for spread across nodes', () => {
      const userData = getControlPlaneUserData();
      // Check for anti-affinity configuration
      expect(userData).toContain('podAntiAffinity');
    });

    test('cluster-autoscaler has leader election enabled', () => {
      const userData = getControlPlaneUserData();
      // Check for leader election flag
      expect(userData).toContain('--leader-elect=true');
    });
  });

  describe('CSR Approver HA', () => {
    test('kubelet-csr-approver has 2 replicas for high availability', () => {
      const userData = getControlPlaneUserData();
      // Check that CSR approver deployment has replicas: 2
      expect(userData).toMatch(/kubelet-csr-approver[\s\S]*?replicas:\s*2/);
    });

    test('kubelet-csr-approver has pod anti-affinity for spread across nodes', () => {
      const userData = getControlPlaneUserData();
      // The CSR approver Deployment section should have anti-affinity
      // Look for the Deployment kind followed by kubelet-csr-approver and then podAntiAffinity
      expect(userData).toMatch(/kind: Deployment[\s\S]*?name: kubelet-csr-approver[\s\S]*?podAntiAffinity/);
    });
  });

  describe('Pod Disruption Budgets', () => {
    test('cluster-autoscaler has PodDisruptionBudget', () => {
      const userData = getControlPlaneUserData();
      expect(userData).toContain('PodDisruptionBudget');
      expect(userData).toMatch(/cluster-autoscaler[\s\S]*?minAvailable:\s*1/);
    });
  });
});
