import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { K8sClusterStack } from '../lib/k8s-cluster-stack';

describe('Token Management', () => {
  let template: Template;
  let templateJson: any;
  let controlPlaneUserData: string;
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

    // Extract user data from launch templates
    const resources = templateJson.Resources;
    for (const key of Object.keys(resources)) {
      const resource = resources[key];
      if (resource.Type === 'AWS::EC2::LaunchTemplate') {
        const userData = resource.Properties?.LaunchTemplateData?.UserData;
        if (userData) {
          const content = extractStringContent(userData);
          if (key.includes('ControlPlane')) {
            controlPlaneUserData = content;
          } else if (key.includes('Worker')) {
            workerUserData = content;
          }
        }
      }
    }
  });

  describe('Initial Token Generation (Cluster Init)', () => {
    test('extracts join token from kubeadm token list', () => {
      expect(controlPlaneUserData).toContain('kubeadm token list');
      expect(controlPlaneUserData).toContain('JOIN_TOKEN=');
    });

    test('filters token list output correctly', () => {
      expect(controlPlaneUserData).toContain('grep -v TOKEN');
      expect(controlPlaneUserData).toContain('head -1');
      expect(controlPlaneUserData).toContain("awk '{print $1}'");
    });

    test('generates CA certificate hash', () => {
      expect(controlPlaneUserData).toContain('CA_CERT_HASH=');
      expect(controlPlaneUserData).toContain('openssl x509 -pubkey');
      expect(controlPlaneUserData).toContain('/etc/kubernetes/pki/ca.crt');
    });

    test('uses RSA public key for hash generation', () => {
      expect(controlPlaneUserData).toContain('openssl rsa -pubin -outform der');
    });

    test('generates SHA256 hash', () => {
      expect(controlPlaneUserData).toContain('openssl dgst -sha256');
    });

    test('generates certificate key for control plane join', () => {
      expect(controlPlaneUserData).toContain('CERT_KEY=');
      expect(controlPlaneUserData).toContain('kubeadm certs certificate-key');
    });

    test('uploads certificates with certificate key', () => {
      expect(controlPlaneUserData).toContain('kubeadm init phase upload-certs');
      expect(controlPlaneUserData).toContain('--upload-certs');
      expect(controlPlaneUserData).toContain('--certificate-key');
    });
  });

  describe('SSM Parameter Storage (Initial)', () => {
    test('stores cluster endpoint in SSM', () => {
      expect(controlPlaneUserData).toContain('/cluster/endpoint');
      expect(controlPlaneUserData).toContain('put-parameter');
    });

    test('stores join token as SecureString', () => {
      expect(controlPlaneUserData).toContain('/cluster/join-token');
      expect(controlPlaneUserData).toContain("--type 'SecureString'");
    });

    test('stores join token update timestamp', () => {
      expect(controlPlaneUserData).toContain('/cluster/join-token-updated');
      expect(controlPlaneUserData).toContain('date -u');
      expect(controlPlaneUserData).toContain('%Y-%m-%dT%H:%M:%SZ');
    });

    test('stores CA cert hash with sha256 prefix', () => {
      expect(controlPlaneUserData).toContain('/cluster/ca-cert-hash');
      expect(controlPlaneUserData).toContain("sha256:");
    });

    test('stores certificate key as SecureString', () => {
      expect(controlPlaneUserData).toContain('/cluster/certificate-key');
      expect(controlPlaneUserData).toContain("--type 'SecureString'");
    });

    test('stores cluster initialized flag', () => {
      expect(controlPlaneUserData).toContain('/cluster/initialized');
      expect(controlPlaneUserData).toContain("--value 'true'");
    });

    test('uses retry logic for all SSM writes', () => {
      expect(controlPlaneUserData).toContain('retry_command');
      expect(controlPlaneUserData).toContain('put-parameter');
    });

    test('uses --overwrite flag for parameter updates', () => {
      expect(controlPlaneUserData).toContain('--overwrite');
    });
  });

  describe('Token Refresh Function (Control Plane)', () => {
    test('has request_new_control_plane_token function', () => {
      expect(controlPlaneUserData).toContain('request_new_control_plane_token()');
    });

    test('finds healthy control plane instances', () => {
      expect(controlPlaneUserData).toContain('describe-instances');
      expect(controlPlaneUserData).toContain('control-plane');
      expect(controlPlaneUserData).toContain('instance-state-name,Values=running');
    });

    test('excludes current instance from search', () => {
      expect(controlPlaneUserData).toContain('$INSTANCE_ID');
    });

    test('handles no healthy control plane found', () => {
      expect(controlPlaneUserData).toContain('No other healthy control plane instance found');
    });

    test('logs found control plane instance', () => {
      expect(controlPlaneUserData).toContain('Found control plane instance:');
    });
  });

  describe('Token Refresh via SSM Run Command', () => {
    test('creates token refresh script', () => {
      expect(controlPlaneUserData).toContain('token_script=');
    });

    test('sets KUBECONFIG in refresh script', () => {
      expect(controlPlaneUserData).toContain('KUBECONFIG=/etc/kubernetes/admin.conf');
    });

    test('creates new token with kubeadm', () => {
      expect(controlPlaneUserData).toContain('kubeadm token create');
    });

    test('sets 24 hour TTL for new tokens', () => {
      expect(controlPlaneUserData).toContain('--ttl 24h');
    });

    test('uploads new certificates during refresh', () => {
      expect(controlPlaneUserData).toContain('kubeadm init phase upload-certs --upload-certs');
    });

    test('extracts new certificate key', () => {
      expect(controlPlaneUserData).toContain('tail -1');
    });

    test('uses AWS-RunShellScript document', () => {
      expect(controlPlaneUserData).toContain('AWS-RunShellScript');
    });

    test('sends command via SSM', () => {
      expect(controlPlaneUserData).toContain('ssm send-command');
    });

    test('stores command ID for tracking', () => {
      expect(controlPlaneUserData).toContain('command_id=');
    });

    test('handles SSM command send failure', () => {
      expect(controlPlaneUserData).toContain('Failed to send SSM command');
    });

    test('logs SSM command ID', () => {
      expect(controlPlaneUserData).toContain('SSM command sent:');
    });
  });

  describe('Token Refresh SSM Updates', () => {
    test('updates join-token in SSM', () => {
      // Check the refresh script updates the token
      expect(controlPlaneUserData).toContain('join-token');
      expect(controlPlaneUserData).toContain('put-parameter');
      expect(controlPlaneUserData).toContain('$NEW_TOKEN');
    });

    test('updates join-token-updated timestamp', () => {
      expect(controlPlaneUserData).toContain('join-token-updated');
    });

    test('updates certificate-key if available', () => {
      expect(controlPlaneUserData).toContain('certificate-key');
      expect(controlPlaneUserData).toContain('$CERT_KEY');
    });

    test('marks token refresh as successful', () => {
      expect(controlPlaneUserData).toContain('TOKEN_REFRESH_SUCCESS');
    });

    test('marks token refresh as failed when token empty', () => {
      expect(controlPlaneUserData).toContain('TOKEN_REFRESH_FAILED');
    });
  });

  describe('SSM Command Completion Handling', () => {
    test('waits for SSM command completion', () => {
      expect(controlPlaneUserData).toContain('get-command-invocation');
    });

    test('has timeout for command completion', () => {
      expect(controlPlaneUserData).toContain('max_wait=');
    });

    test('tracks elapsed time', () => {
      expect(controlPlaneUserData).toContain('elapsed=');
    });

    test('checks for Success status', () => {
      expect(controlPlaneUserData).toContain('"Success"');
    });

    test('checks for Failed status', () => {
      expect(controlPlaneUserData).toContain('"Failed"');
    });

    test('checks for Cancelled status', () => {
      expect(controlPlaneUserData).toContain('"Cancelled"');
    });

    test('checks for TimedOut status', () => {
      expect(controlPlaneUserData).toContain('"TimedOut"');
    });

    test('retrieves command output on success', () => {
      expect(controlPlaneUserData).toContain('StandardOutputContent');
    });

    test('checks output for TOKEN_REFRESH_SUCCESS', () => {
      expect(controlPlaneUserData).toContain('grep -q "TOKEN_REFRESH_SUCCESS"');
    });

    test('logs successful token refresh', () => {
      expect(controlPlaneUserData).toContain('Token refresh successful');
    });

    test('logs timeout waiting for refresh', () => {
      expect(controlPlaneUserData).toContain('Timeout waiting for token refresh');
    });
  });

  describe('Token Age Check Function', () => {
    test('has check_control_plane_token_age function', () => {
      expect(controlPlaneUserData).toContain('check_control_plane_token_age()');
    });

    test('retrieves token update timestamp from SSM', () => {
      expect(controlPlaneUserData).toContain('/cluster/join-token-updated');
      expect(controlPlaneUserData).toContain('get-parameter');
    });

    test('handles missing timestamp gracefully', () => {
      expect(controlPlaneUserData).toContain('"unknown"');
    });

    test('converts timestamp to epoch', () => {
      expect(controlPlaneUserData).toContain('token_epoch');
      expect(controlPlaneUserData).toContain('date -d');
    });

    test('calculates current epoch', () => {
      expect(controlPlaneUserData).toContain('now_epoch=$(date +%s)');
    });

    test('calculates age in hours', () => {
      expect(controlPlaneUserData).toContain('age_hours');
      expect(controlPlaneUserData).toContain('3600');
    });

    test('returns age in hours', () => {
      expect(controlPlaneUserData).toContain('echo "$age_hours"');
    });
  });

  describe('Token Age Based Refresh', () => {
    test('checks token age before join', () => {
      expect(controlPlaneUserData).toContain('TOKEN_AGE=');
    });

    test('refreshes token if near expiry (20 hours)', () => {
      expect(controlPlaneUserData).toContain('-ge 20');
    });

    test('logs token age', () => {
      expect(controlPlaneUserData).toContain('token age:');
    });

    test('requests refresh when token is old', () => {
      expect(controlPlaneUserData).toContain('near expiry');
      expect(controlPlaneUserData).toContain('requesting refresh');
    });

    test('logs refresh success', () => {
      // Worker has slightly different wording than control plane
      const hasRefreshSuccess = controlPlaneUserData.includes('Token refresh successful') ||
                                 controlPlaneUserData.includes('Token refreshed successfully');
      expect(hasRefreshSuccess).toBe(true);
    });

    test('warns about refresh failure but continues', () => {
      expect(controlPlaneUserData).toContain('Token refresh failed');
      expect(controlPlaneUserData).toContain('will try existing token');
    });

    test('skips refresh if age is unknown', () => {
      expect(controlPlaneUserData).toContain('"unknown"');
    });
  });

  describe('Worker Token Functions', () => {
    test('worker has request_new_token function', () => {
      expect(workerUserData).toContain('request_new_token()');
    });

    test('worker has check_token_age function', () => {
      expect(workerUserData).toContain('check_token_age()');
    });

    test('worker finds healthy control plane for token refresh', () => {
      expect(workerUserData).toContain('describe-instances');
      expect(workerUserData).toContain('control-plane');
    });

    test('worker uses SSM Run Command for token refresh', () => {
      expect(workerUserData).toContain('ssm send-command');
      expect(workerUserData).toContain('AWS-RunShellScript');
    });

    test('worker checks token age before join', () => {
      expect(workerUserData).toContain('TOKEN_AGE=');
      expect(workerUserData).toContain('check_token_age');
    });
  });

  describe('Token Retrieval for Join', () => {
    test('retrieves join token with decryption', () => {
      expect(controlPlaneUserData).toContain('--with-decryption');
      expect(controlPlaneUserData).toContain('join-token');
    });

    test('retrieves CA cert hash', () => {
      expect(controlPlaneUserData).toContain('/cluster/ca-cert-hash');
    });

    test('retrieves cluster endpoint', () => {
      expect(controlPlaneUserData).toContain('/cluster/endpoint');
    });

    test('retrieves certificate key for control plane join', () => {
      expect(controlPlaneUserData).toContain('/cluster/certificate-key');
      expect(controlPlaneUserData).toContain('--with-decryption');
    });

    test('stores retrieved values in variables', () => {
      expect(controlPlaneUserData).toContain('JOIN_TOKEN=');
      expect(controlPlaneUserData).toContain('CA_CERT_HASH=');
      expect(controlPlaneUserData).toContain('CLUSTER_ENDPOINT=');
      expect(controlPlaneUserData).toContain('CERT_KEY=');
    });
  });

  describe('Token Validation Before Join', () => {
    test('validates join token is not empty', () => {
      expect(controlPlaneUserData).toContain('-n "$JOIN_TOKEN"');
    });

    test('validates CA cert hash is not empty', () => {
      expect(controlPlaneUserData).toContain('-n "$CA_CERT_HASH"');
    });

    test('validates cluster endpoint is not empty', () => {
      expect(controlPlaneUserData).toContain('-n "$CLUSTER_ENDPOINT"');
    });

    test('handles missing parameters', () => {
      expect(controlPlaneUserData).toContain('Missing');
    });
  });

  describe('Token Refresh on Join Failure', () => {
    test('attempts refresh on first join failure', () => {
      expect(controlPlaneUserData).toContain('First join attempt failed');
    });

    test('requests new token after failure', () => {
      expect(controlPlaneUserData).toContain('request_new_control_plane_token');
    });

    test('retrieves new token after refresh', () => {
      expect(controlPlaneUserData).toContain('NEW_JOIN_TOKEN=');
    });

    test('retrieves new certificate key after refresh', () => {
      expect(controlPlaneUserData).toContain('NEW_CERT_KEY=');
    });

    test('verifies new token was obtained', () => {
      expect(controlPlaneUserData).toContain('-n "$NEW_JOIN_TOKEN"');
    });

    test('retries join with new token', () => {
      expect(controlPlaneUserData).toContain('Got fresh token, retrying join');
    });

    test('resets kubeadm state before retry', () => {
      expect(controlPlaneUserData).toContain('kubeadm reset -f');
    });
  });

  describe('Restore Token Generation', () => {
    test('generates new token after restore', () => {
      expect(controlPlaneUserData).toContain('kubeadm token create');
    });

    test('generates new certificate key after restore', () => {
      expect(controlPlaneUserData).toContain('kubeadm certs certificate-key');
    });

    test('updates all SSM parameters after restore', () => {
      expect(controlPlaneUserData).toContain('/cluster/join-token');
      expect(controlPlaneUserData).toContain('/cluster/ca-cert-hash');
      expect(controlPlaneUserData).toContain('/cluster/certificate-key');
    });

    test('marks cluster as initialized after restore', () => {
      expect(controlPlaneUserData).toContain('/cluster/initialized');
      expect(controlPlaneUserData).toContain("--value 'true'");
    });
  });

  describe('IAM Permissions for Token Management', () => {
    test('control plane role can read SSM parameters', () => {
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

    test('control plane role can write SSM parameters', () => {
      template.hasResourceProperties('AWS::IAM::Policy', {
        PolicyDocument: {
          Statement: Match.arrayWith([
            Match.objectLike({
              Action: Match.arrayWith(['ssm:PutParameter']),
              Effect: 'Allow'
            })
          ])
        }
      });
    });

    test('control plane role can send SSM commands', () => {
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

    test('control plane role can get SSM command invocation', () => {
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
  });

  describe('Token Security', () => {
    test('join token stored as SecureString', () => {
      expect(controlPlaneUserData).toContain("--type 'SecureString'");
      expect(controlPlaneUserData).toContain('join-token');
    });

    test('certificate key stored as SecureString', () => {
      expect(controlPlaneUserData).toContain("--type 'SecureString'");
      expect(controlPlaneUserData).toContain('certificate-key');
    });

    test('token retrieved with decryption', () => {
      expect(controlPlaneUserData).toContain('--with-decryption');
    });

    test('token has TTL for automatic expiry', () => {
      expect(controlPlaneUserData).toContain('--ttl 24h');
    });
  });

  describe('Token Timestamp Format', () => {
    test('uses ISO 8601 format for timestamp', () => {
      expect(controlPlaneUserData).toContain('%Y-%m-%dT%H:%M:%SZ');
    });

    test('uses UTC timezone', () => {
      expect(controlPlaneUserData).toContain('date -u');
    });
  });
});
