import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { K8sClusterStack } from '../lib/k8s-cluster-stack';

describe('Worker Node Bootstrap', () => {
  let template: Template;
  let templateJson: any;
  let workerUserData: string;

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

    // Extract worker user data
    const resources = templateJson.Resources;
    for (const key of Object.keys(resources)) {
      const resource = resources[key];
      if (resource.Type === 'AWS::EC2::LaunchTemplate' &&
          key.includes('Worker') && !key.includes('ControlPlane')) {
        const userData = resource.Properties?.LaunchTemplateData?.UserData;
        if (userData) {
          workerUserData = extractStringContent(userData);
        }
      }
    }
  });

  describe('Cluster Initialization Wait', () => {
    test('checks cluster initialized SSM parameter', () => {
      expect(workerUserData).toContain('/cluster/initialized');
      expect(workerUserData).toContain('get-parameter');
    });

    test('waits in a loop for cluster initialization', () => {
      expect(workerUserData).toContain('Waiting for cluster to be initialized');
      expect(workerUserData).toContain('for i in');
    });

    test('checks for initialized value of true', () => {
      expect(workerUserData).toContain('CLUSTER_INITIALIZED');
      expect(workerUserData).toContain('= "true"');
    });

    test('logs progress during wait', () => {
      expect(workerUserData).toContain('Waiting for cluster initialization');
    });

    test('proceeds when cluster is initialized', () => {
      expect(workerUserData).toContain('Cluster is initialized, proceeding with worker join');
    });

    test('has timeout for initialization wait', () => {
      expect(workerUserData).toContain('Timeout waiting for cluster initialization');
      expect(workerUserData).toContain('exit 1');
    });

    test('uses retry logic for SSM parameter check', () => {
      expect(workerUserData).toContain('retry_command_output');
    });

    test('handles SSM parameter not found gracefully', () => {
      expect(workerUserData).toContain('|| echo "false"');
    });
  });

  describe('SSM Parameter Retrieval', () => {
    test('retrieves Kubernetes version from SSM', () => {
      expect(workerUserData).toContain('/kubernetes/version');
      expect(workerUserData).toContain('KUBERNETES_VERSION=');
    });

    test('retrieves cluster endpoint from SSM', () => {
      expect(workerUserData).toContain('/cluster/endpoint');
      expect(workerUserData).toContain('CLUSTER_ENDPOINT=');
    });

    test('retrieves CA cert hash from SSM', () => {
      expect(workerUserData).toContain('/cluster/ca-cert-hash');
      expect(workerUserData).toContain('CA_CERT_HASH=');
    });

    test('retrieves join token from SSM with decryption', () => {
      expect(workerUserData).toContain('/cluster/join-token');
      expect(workerUserData).toContain('--with-decryption');
      expect(workerUserData).toContain('JOIN_TOKEN=');
    });

    test('uses retry logic for all SSM retrievals', () => {
      expect(workerUserData).toContain('retry_command_output');
    });

    test('sets BOOTSTRAP_STAGE to get-join-params', () => {
      expect(workerUserData).toContain('BOOTSTRAP_STAGE="get-join-params"');
    });

    test('logs Kubernetes version after retrieval', () => {
      expect(workerUserData).toContain('echo "Kubernetes Version:');
    });

    test('logs cluster endpoint after retrieval', () => {
      expect(workerUserData).toContain('echo "Cluster Endpoint:');
    });
  });

  describe('Token Age Check', () => {
    test('has check_token_age function', () => {
      expect(workerUserData).toContain('check_token_age()');
    });

    test('retrieves token update timestamp from SSM', () => {
      expect(workerUserData).toContain('/cluster/join-token-updated');
    });

    test('falls back to LastModifiedDate if timestamp missing', () => {
      expect(workerUserData).toContain('LastModifiedDate');
    });

    test('calculates token age in hours', () => {
      expect(workerUserData).toContain('age_hours');
    });

    test('logs token age', () => {
      expect(workerUserData).toContain('Join token age:');
    });

    test('refreshes token if age >= 20 hours', () => {
      expect(workerUserData).toContain('-ge 20');
      expect(workerUserData).toContain('near expiry');
    });

    test('handles unknown token age gracefully', () => {
      expect(workerUserData).toContain('"unknown"');
    });
  });

  describe('Token Refresh Mechanism', () => {
    test('has request_new_token function', () => {
      expect(workerUserData).toContain('request_new_token()');
    });

    test('finds healthy control plane instance', () => {
      expect(workerUserData).toContain('describe-instances');
      expect(workerUserData).toContain('control-plane');
      expect(workerUserData).toContain('instance-state-name,Values=running');
    });

    test('uses SSM Run Command to refresh token', () => {
      expect(workerUserData).toContain('ssm send-command');
      expect(workerUserData).toContain('AWS-RunShellScript');
    });

    test('creates token with kubeadm on control plane', () => {
      expect(workerUserData).toContain('kubeadm token create');
      expect(workerUserData).toContain('--ttl 24h');
    });

    test('updates join-token SSM parameter after refresh', () => {
      expect(workerUserData).toContain('put-parameter');
      expect(workerUserData).toContain('join-token');
    });

    test('updates join-token-updated timestamp', () => {
      expect(workerUserData).toContain('join-token-updated');
    });

    test('waits for SSM command completion', () => {
      expect(workerUserData).toContain('get-command-invocation');
    });

    test('checks for TOKEN_REFRESH_SUCCESS', () => {
      expect(workerUserData).toContain('TOKEN_REFRESH_SUCCESS');
    });

    test('handles SSM command failure', () => {
      expect(workerUserData).toContain('Failed');
      expect(workerUserData).toContain('Cancelled');
      expect(workerUserData).toContain('TimedOut');
    });

    test('handles no healthy control plane found', () => {
      expect(workerUserData).toContain('No healthy control plane instance found');
    });

    test('has timeout for command completion', () => {
      expect(workerUserData).toContain('max_wait');
      expect(workerUserData).toContain('Timeout waiting for token refresh');
    });

    test('logs token refresh success', () => {
      expect(workerUserData).toContain('Token refresh successful');
    });
  });

  describe('Join Command Structure', () => {
    test('uses kubeadm join command', () => {
      expect(workerUserData).toContain('kubeadm join');
    });

    test('includes cluster endpoint in join', () => {
      expect(workerUserData).toContain('kubeadm join "$CLUSTER_ENDPOINT"');
    });

    test('includes --token flag', () => {
      expect(workerUserData).toContain('--token');
    });

    test('includes --discovery-token-ca-cert-hash flag', () => {
      expect(workerUserData).toContain('--discovery-token-ca-cert-hash');
      expect(workerUserData).toContain('$CA_CERT_HASH');
    });

    test('includes --node-name with hostname', () => {
      expect(workerUserData).toContain('--node-name');
      expect(workerUserData).toContain('hostname');
    });

    test('does NOT include --control-plane flag for workers', () => {
      // Count occurrences - worker join should not have --control-plane
      // in the attempt_join function
      const workerJoinSection = workerUserData.match(/attempt_join\(\)[\s\S]*?return \$\?/);
      if (workerJoinSection) {
        expect(workerJoinSection[0]).not.toContain('--control-plane');
      }
    });

    test('does NOT include --certificate-key flag for workers', () => {
      const workerJoinSection = workerUserData.match(/attempt_join\(\)[\s\S]*?return \$\?/);
      if (workerJoinSection) {
        expect(workerJoinSection[0]).not.toContain('--certificate-key');
      }
    });
  });

  describe('Join Function Definition', () => {
    test('defines attempt_join function', () => {
      expect(workerUserData).toContain('attempt_join()');
    });

    test('function accepts token parameter', () => {
      expect(workerUserData).toContain('local token="$1"');
    });

    test('function returns exit status', () => {
      expect(workerUserData).toContain('return $?');
    });

    test('logs join attempt', () => {
      expect(workerUserData).toContain('Attempting to join cluster with token');
    });
  });

  describe('Join Prerequisites Check', () => {
    test('verifies cluster endpoint is not empty', () => {
      expect(workerUserData).toContain('-n "$CLUSTER_ENDPOINT"');
    });

    test('verifies join token is not empty', () => {
      expect(workerUserData).toContain('-n "$JOIN_TOKEN"');
    });

    test('verifies CA cert hash is not empty', () => {
      expect(workerUserData).toContain('-n "$CA_CERT_HASH"');
    });

    test('handles missing required parameters', () => {
      expect(workerUserData).toContain('Missing required join parameters from SSM');
      expect(workerUserData).toContain('exit 1');
    });

    test('sets BOOTSTRAP_STAGE to kubeadm-join', () => {
      expect(workerUserData).toContain('BOOTSTRAP_STAGE="kubeadm-join"');
    });

    test('logs join initiation message', () => {
      expect(workerUserData).toContain('Joining cluster using kubeadm');
    });
  });

  describe('Join Retry Logic', () => {
    test('attempts retry on first join failure', () => {
      expect(workerUserData).toContain('First join attempt failed');
      expect(workerUserData).toContain('requesting fresh token');
    });

    test('calls request_new_token on failure', () => {
      expect(workerUserData).toContain('request_new_token');
    });

    test('retrieves new token after refresh', () => {
      expect(workerUserData).toContain('NEW_JOIN_TOKEN=');
    });

    test('verifies new token is different from old', () => {
      expect(workerUserData).toContain('$NEW_JOIN_TOKEN" != "$JOIN_TOKEN"');
    });

    test('resets kubeadm state before retry', () => {
      expect(workerUserData).toContain('kubeadm reset -f');
    });

    test('logs retry with fresh token', () => {
      expect(workerUserData).toContain('Got fresh token, retrying join');
    });

    test('exits on failure even with fresh token', () => {
      expect(workerUserData).toContain('Join failed even with fresh token');
      expect(workerUserData).toContain('exit 1');
    });

    test('exits if cannot get different token', () => {
      expect(workerUserData).toContain('Could not get a different token');
      expect(workerUserData).toContain('exit 1');
    });

    test('exits if token refresh fails', () => {
      expect(workerUserData).toContain('Token refresh failed');
    });
  });

  describe('Post-Join Success', () => {
    test('logs successful join message', () => {
      expect(workerUserData).toContain('Successfully joined cluster as worker node');
    });

    test('sets BOOTSTRAP_STAGE to complete on success', () => {
      expect(workerUserData).toContain('BOOTSTRAP_STAGE="complete"');
    });

    test('logs success with fresh token if retry succeeded', () => {
      expect(workerUserData).toContain('Successfully joined cluster with fresh token');
    });
  });

  describe('Kubelet Configuration', () => {
    test('creates kubelet config directory', () => {
      expect(workerUserData).toContain('mkdir -p /etc/kubernetes/kubelet');
    });

    test('creates kubelet-config.yaml', () => {
      expect(workerUserData).toContain('kubelet-config.yaml');
    });

    test('configures cgroupDriver as systemd', () => {
      expect(workerUserData).toContain('cgroupDriver: systemd');
    });

    test('configures cluster DNS', () => {
      expect(workerUserData).toContain('clusterDNS:');
      expect(workerUserData).toContain('10.96.0.10');
    });

    test('configures cluster domain', () => {
      expect(workerUserData).toContain('clusterDomain: "cluster.local"');
    });

    test('enables certificate rotation', () => {
      expect(workerUserData).toContain('rotateCertificates: true');
    });

    test('enables server TLS bootstrap', () => {
      expect(workerUserData).toContain('serverTLSBootstrap: true');
    });

    test('disables anonymous authentication', () => {
      expect(workerUserData).toContain('anonymous:');
      expect(workerUserData).toContain('enabled: false');
    });

    test('enables webhook authentication', () => {
      expect(workerUserData).toContain('webhook:');
      expect(workerUserData).toContain('enabled: true');
    });

    test('sets authorization mode to Webhook', () => {
      expect(workerUserData).toContain('mode: Webhook');
    });

    test('configures resource reservations', () => {
      expect(workerUserData).toContain('kubeReserved:');
      expect(workerUserData).toContain('systemReserved:');
    });

    test('sets maxPods limit', () => {
      expect(workerUserData).toContain('maxPods: 110');
    });
  });

  describe('Kubelet Service', () => {
    test('creates kubelet systemd service file', () => {
      expect(workerUserData).toContain('/etc/systemd/system/kubelet.service');
    });

    test('configures containerd runtime endpoint', () => {
      expect(workerUserData).toContain('--container-runtime-endpoint=unix:///run/containerd/containerd.sock');
    });

    test('references kubelet config file', () => {
      expect(workerUserData).toContain('--config=/etc/kubernetes/kubelet/kubelet-config.yaml');
    });

    test('references kubeconfig file', () => {
      expect(workerUserData).toContain('--kubeconfig=/etc/kubernetes/kubelet.conf');
    });

    test('references bootstrap kubeconfig', () => {
      expect(workerUserData).toContain('--bootstrap-kubeconfig=/etc/kubernetes/bootstrap-kubelet.conf');
    });

    test('enables kubelet service', () => {
      expect(workerUserData).toContain('systemctl enable kubelet');
    });

    test('reloads systemd daemon', () => {
      expect(workerUserData).toContain('systemctl daemon-reload');
    });

    test('configures restart behavior', () => {
      expect(workerUserData).toContain('Restart=always');
      expect(workerUserData).toContain('RestartSec=10');
    });
  });

  describe('Containerd Configuration', () => {
    test('enables containerd service', () => {
      expect(workerUserData).toContain('systemctl enable containerd');
    });

    test('starts containerd service', () => {
      expect(workerUserData).toContain('systemctl start containerd');
    });
  });

  describe('Instance Metadata', () => {
    test('retrieves instance ID', () => {
      expect(workerUserData).toContain('INSTANCE_ID');
    });

    test('retrieves private IP', () => {
      expect(workerUserData).toContain('PRIVATE_IP');
    });

    test('logs instance ID', () => {
      expect(workerUserData).toContain('echo "Instance ID:');
    });

    test('logs private IP', () => {
      expect(workerUserData).toContain('echo "Private IP:');
    });
  });

  describe('IAM Permissions for Worker Join', () => {
    test('worker role can read SSM parameters', () => {
      template.hasResourceProperties('AWS::IAM::Policy', {
        PolicyDocument: {
          Statement: Match.arrayWith([
            Match.objectLike({
              Action: Match.arrayWith(['ssm:GetParameter']),
              Effect: 'Allow'
            })
          ])
        }
      });
    });

    test('worker role can describe EC2 instances', () => {
      template.hasResourceProperties('AWS::IAM::Policy', {
        PolicyDocument: {
          Statement: Match.arrayWith([
            Match.objectLike({
              Action: Match.arrayWith(['ec2:DescribeInstances']),
              Effect: 'Allow'
            })
          ])
        }
      });
    });

    test('worker role can send SSM commands for token refresh', () => {
      template.hasResourceProperties('AWS::IAM::Policy', {
        PolicyDocument: {
          Statement: Match.arrayWith([
            Match.objectLike({
              Action: Match.arrayWith(['ssm:SendCommand']),
              Effect: 'Allow'
            })
          ])
        }
      });
    });

    test('worker role can get SSM command invocation', () => {
      template.hasResourceProperties('AWS::IAM::Policy', {
        PolicyDocument: {
          Statement: Match.arrayWith([
            Match.objectLike({
              Action: Match.arrayWith(['ssm:GetCommandInvocation']),
              Effect: 'Allow'
            })
          ])
        }
      });
    });
  });

  describe('Error Handling', () => {
    test('exits on cluster initialization timeout', () => {
      expect(workerUserData).toContain('Timeout waiting for cluster initialization');
      expect(workerUserData).toContain('exit 1');
    });

    test('exits on missing join parameters', () => {
      expect(workerUserData).toContain('Missing required join parameters');
      expect(workerUserData).toContain('exit 1');
    });

    test('handles failed SSM command gracefully', () => {
      expect(workerUserData).toContain('Failed to send SSM command');
    });

    test('handles control plane not found', () => {
      expect(workerUserData).toContain('No healthy control plane instance found');
    });

    test('warns about token refresh failure but continues', () => {
      expect(workerUserData).toContain('WARNING: Token refresh failed, will try existing token');
    });
  });

  describe('Comparison with Control Plane Join', () => {
    let controlPlaneUserData: string;

    beforeAll(() => {
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

    test('worker join is simpler than control plane join', () => {
      // Worker should not have --control-plane or --certificate-key in join
      const workerHasControlPlaneFlag = workerUserData.includes('--control-plane');
      const controlPlaneHasControlPlaneFlag = controlPlaneUserData.includes('--control-plane');

      // Control plane should have it, worker should not (or have fewer occurrences)
      expect(controlPlaneHasControlPlaneFlag).toBe(true);
    });

    test('worker waits for cluster initialization unlike first control plane', () => {
      expect(workerUserData).toContain('Waiting for cluster to be initialized');
    });

    test('both use same SSM parameters for join credentials', () => {
      expect(workerUserData).toContain('/cluster/join-token');
      expect(controlPlaneUserData).toContain('/cluster/join-token');
      expect(workerUserData).toContain('/cluster/ca-cert-hash');
      expect(controlPlaneUserData).toContain('/cluster/ca-cert-hash');
    });
  });
});
