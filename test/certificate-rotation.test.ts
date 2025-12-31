import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { K8sClusterStack } from '../lib/k8s-cluster-stack';

describe('Certificate Rotation Configuration', () => {
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
  function getLaunchTemplateUserData(templateName: string): string {
    const resources = templateJson.Resources;
    for (const key of Object.keys(resources)) {
      const resource = resources[key];
      if (resource.Type === 'AWS::EC2::LaunchTemplate') {
        const name = resource.Properties?.LaunchTemplateName;
        if (name && name.includes(templateName)) {
          const userData = resource.Properties?.LaunchTemplateData?.UserData;
          if (userData && userData['Fn::Base64']) {
            const joinData = userData['Fn::Base64']['Fn::Join'];
            if (joinData && Array.isArray(joinData[1])) {
              return joinData[1].join('');
            }
            // Handle case where it's just a string
            if (typeof userData['Fn::Base64'] === 'string') {
              return userData['Fn::Base64'];
            }
          }
        }
      }
    }
    return '';
  }

  test('Worker kubelet config includes certificate rotation settings', () => {
    const userData = getLaunchTemplateUserData('worker');
    expect(userData).toContain('rotateCertificates: true');
  });

  test('Worker kubelet config includes server TLS bootstrap', () => {
    const userData = getLaunchTemplateUserData('worker');
    expect(userData).toContain('serverTLSBootstrap: true');
  });

  test('Control plane includes certificate renewal script', () => {
    const userData = getLaunchTemplateUserData('control-plane');
    expect(userData).toContain('k8s-cert-renewal.sh');
  });

  test('Control plane includes systemd timer for certificate renewal', () => {
    const userData = getLaunchTemplateUserData('control-plane');
    expect(userData).toContain('k8s-cert-renewal.timer');
  });

  test('Certificate renewal checks expiration before renewing', () => {
    const userData = getLaunchTemplateUserData('control-plane');
    expect(userData).toContain('kubeadm certs check-expiration');
    expect(userData).toContain('kubeadm certs renew all');
  });

  test('Certificate renewal restarts control plane components', () => {
    const userData = getLaunchTemplateUserData('control-plane');
    expect(userData).toContain('/etc/kubernetes/manifests');
  });

  test('Control plane includes CSR auto-approver deployment', () => {
    const userData = getLaunchTemplateUserData('control-plane');
    expect(userData).toContain('kubelet-csr-approver');
  });

  test('CSR approver only approves kubelet-serving certificates', () => {
    const userData = getLaunchTemplateUserData('control-plane');
    expect(userData).toContain('kubernetes.io/kubelet-serving');
    expect(userData).toContain('system:node:');
  });

  test('CSR approver has correct RBAC permissions', () => {
    const userData = getLaunchTemplateUserData('control-plane');
    expect(userData).toContain('ClusterRole');
    expect(userData).toContain('certificatesigningrequests');
    expect(userData).toContain('certificatesigningrequests/approval');
  });

  test('Renewal threshold is 30 days', () => {
    const userData = getLaunchTemplateUserData('control-plane');
    expect(userData).toContain('RENEWAL_THRESHOLD_DAYS=30');
  });
});
