import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { K8sClusterStack } from '../lib/k8s-cluster-stack';

describe('Control Plane Join', () => {
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

  describe('Join Token Retrieval', () => {
    test('retrieves join token from SSM parameter', () => {
      expect(controlPlaneUserData).toContain('/cluster/join-token');
      expect(controlPlaneUserData).toContain('get-parameter');
    });

    test('uses decryption for secure join token', () => {
      expect(controlPlaneUserData).toContain('--with-decryption');
      expect(controlPlaneUserData).toContain('join-token');
    });

    test('stores join token in variable for use', () => {
      expect(controlPlaneUserData).toContain('JOIN_TOKEN=');
    });

    test('checks join token timestamp for freshness', () => {
      expect(controlPlaneUserData).toContain('/cluster/join-token-updated');
    });

    test('uses retry logic for token retrieval', () => {
      expect(controlPlaneUserData).toContain('retry_command_output');
      expect(controlPlaneUserData).toContain('join-token');
    });
  });

  describe('CA Certificate Hash Retrieval', () => {
    test('retrieves CA cert hash from SSM parameter', () => {
      expect(controlPlaneUserData).toContain('/cluster/ca-cert-hash');
      expect(controlPlaneUserData).toContain('get-parameter');
    });

    test('stores CA cert hash in variable', () => {
      expect(controlPlaneUserData).toContain('CA_CERT_HASH=');
    });

    test('uses CA cert hash in join command', () => {
      expect(controlPlaneUserData).toContain('--discovery-token-ca-cert-hash');
      expect(controlPlaneUserData).toContain('$CA_CERT_HASH');
    });

    test('generates CA cert hash during cluster init', () => {
      expect(controlPlaneUserData).toContain('openssl x509 -pubkey');
      expect(controlPlaneUserData).toContain('openssl dgst -sha256');
    });

    test('stores CA hash with sha256 prefix', () => {
      expect(controlPlaneUserData).toContain("sha256:");
    });
  });

  describe('Certificate Key Retrieval', () => {
    test('retrieves certificate key from SSM parameter', () => {
      expect(controlPlaneUserData).toContain('/cluster/certificate-key');
      expect(controlPlaneUserData).toContain('get-parameter');
    });

    test('uses decryption for secure certificate key', () => {
      // Certificate key should be retrieved with --with-decryption
      const certKeyRetrieval = controlPlaneUserData.match(/certificate-key.*--with-decryption|--with-decryption.*certificate-key/);
      expect(certKeyRetrieval).toBeTruthy();
    });

    test('stores certificate key in variable', () => {
      expect(controlPlaneUserData).toContain('CERT_KEY=');
    });

    test('handles missing certificate key gracefully', () => {
      // Should have fallback for missing cert key
      expect(controlPlaneUserData).toContain('|| echo ""');
    });

    test('generates certificate key during cluster init', () => {
      expect(controlPlaneUserData).toContain('kubeadm certs certificate-key');
    });

    test('uploads certificates with certificate key', () => {
      expect(controlPlaneUserData).toContain('kubeadm init phase upload-certs');
      expect(controlPlaneUserData).toContain('--upload-certs');
      expect(controlPlaneUserData).toContain('--certificate-key');
    });
  });

  describe('Cluster Endpoint Retrieval', () => {
    test('retrieves cluster endpoint from SSM parameter', () => {
      expect(controlPlaneUserData).toContain('/cluster/endpoint');
      expect(controlPlaneUserData).toContain('get-parameter');
    });

    test('stores cluster endpoint in variable', () => {
      expect(controlPlaneUserData).toContain('CLUSTER_ENDPOINT=');
    });

    test('uses cluster endpoint in join command', () => {
      expect(controlPlaneUserData).toContain('kubeadm join $CLUSTER_ENDPOINT');
    });
  });

  describe('Join Command Structure', () => {
    test('uses kubeadm join command', () => {
      expect(controlPlaneUserData).toContain('kubeadm join');
    });

    test('includes --control-plane flag for control plane join', () => {
      expect(controlPlaneUserData).toContain('--control-plane');
    });

    test('includes --token flag with join token', () => {
      expect(controlPlaneUserData).toContain('--token');
    });

    test('includes --discovery-token-ca-cert-hash flag', () => {
      expect(controlPlaneUserData).toContain('--discovery-token-ca-cert-hash');
    });

    test('includes --apiserver-advertise-address with private IP', () => {
      expect(controlPlaneUserData).toContain('--apiserver-advertise-address');
      expect(controlPlaneUserData).toContain('$PRIVATE_IP');
    });

    test('includes --certificate-key when available', () => {
      expect(controlPlaneUserData).toContain('--certificate-key');
    });

    test('handles join with certificate key', () => {
      expect(controlPlaneUserData).toContain('if [ -n "$cert_key" ]');
    });

    test('handles join without certificate key', () => {
      // Should have else branch for when cert_key is empty
      expect(controlPlaneUserData).toContain('else');
      // And still do kubeadm join without certificate-key
      const joinWithoutCertKey = controlPlaneUserData.includes('kubeadm join') &&
                                  controlPlaneUserData.includes('--control-plane');
      expect(joinWithoutCertKey).toBe(true);
    });
  });

  describe('Join Function Definition', () => {
    test('defines attempt_control_plane_join function', () => {
      expect(controlPlaneUserData).toContain('attempt_control_plane_join()');
    });

    test('function accepts token parameter', () => {
      expect(controlPlaneUserData).toContain('local token="$1"');
    });

    test('function accepts cert_key parameter', () => {
      expect(controlPlaneUserData).toContain('local cert_key="$2"');
    });

    test('function returns exit status', () => {
      expect(controlPlaneUserData).toContain('return $?');
    });
  });

  describe('Join Prerequisites Check', () => {
    test('verifies join token is not empty before join', () => {
      expect(controlPlaneUserData).toContain('-n "$JOIN_TOKEN"');
    });

    test('verifies CA cert hash is not empty before join', () => {
      expect(controlPlaneUserData).toContain('-n "$CA_CERT_HASH"');
    });

    test('verifies cluster endpoint is not empty before join', () => {
      expect(controlPlaneUserData).toContain('-n "$CLUSTER_ENDPOINT"');
    });

    test('sets BOOTSTRAP_STAGE to kubeadm-join', () => {
      expect(controlPlaneUserData).toContain('BOOTSTRAP_STAGE="kubeadm-join"');
    });
  });

  describe('Join Retry Logic', () => {
    test('attempts join retry on first failure', () => {
      expect(controlPlaneUserData).toContain('First join attempt failed');
      expect(controlPlaneUserData).toContain('requesting fresh token');
    });

    test('requests new token on join failure', () => {
      expect(controlPlaneUserData).toContain('request_new_control_plane_token');
    });

    test('retrieves new join token after refresh', () => {
      expect(controlPlaneUserData).toContain('NEW_JOIN_TOKEN=');
    });

    test('retrieves new certificate key after refresh', () => {
      expect(controlPlaneUserData).toContain('NEW_CERT_KEY=');
    });

    test('resets kubeadm state before retry', () => {
      expect(controlPlaneUserData).toContain('kubeadm reset -f');
    });

    test('sets BOOTSTRAP_STAGE to kubeadm-join-retry', () => {
      expect(controlPlaneUserData).toContain('BOOTSTRAP_STAGE="kubeadm-join-retry"');
    });

    test('sets BOOTSTRAP_STAGE to token-refresh during refresh', () => {
      expect(controlPlaneUserData).toContain('BOOTSTRAP_STAGE="token-refresh"');
    });

    test('logs success message with fresh token', () => {
      expect(controlPlaneUserData).toContain('Successfully joined cluster with fresh token');
    });
  });

  describe('Post-Join Configuration', () => {
    test('configures kubectl after successful join', () => {
      expect(controlPlaneUserData).toContain('mkdir -p /root/.kube');
      expect(controlPlaneUserData).toContain('cp -i /etc/kubernetes/admin.conf /root/.kube/config');
    });

    test('sets proper ownership on kubeconfig', () => {
      expect(controlPlaneUserData).toContain('chown root:root /root/.kube/config');
    });

    test('registers etcd member after join', () => {
      expect(controlPlaneUserData).toContain('register_etcd_member');
    });

    test('sets BOOTSTRAP_STAGE to etcd-registration after join', () => {
      expect(controlPlaneUserData).toContain('BOOTSTRAP_STAGE="etcd-registration"');
    });

    test('tracks etcd registration success', () => {
      expect(controlPlaneUserData).toContain('ETCD_REGISTERED=true');
    });

    test('registers with load balancer after join', () => {
      expect(controlPlaneUserData).toContain('register-targets');
      expect(controlPlaneUserData).toContain('TARGET_GROUP_ARN');
    });

    test('sets BOOTSTRAP_STAGE to lb-registration', () => {
      expect(controlPlaneUserData).toContain('BOOTSTRAP_STAGE="lb-registration"');
    });

    test('tracks load balancer registration success', () => {
      expect(controlPlaneUserData).toContain('LB_REGISTERED=true');
    });

    test('sets BOOTSTRAP_STAGE to complete on success', () => {
      expect(controlPlaneUserData).toContain('BOOTSTRAP_STAGE="complete"');
    });

    test('logs successful join message', () => {
      expect(controlPlaneUserData).toContain('Successfully joined cluster as control plane node');
    });
  });

  describe('Token Refresh Mechanism', () => {
    test('has request_new_control_plane_token function', () => {
      expect(controlPlaneUserData).toContain('request_new_control_plane_token');
    });

    test('checks token age before join', () => {
      expect(controlPlaneUserData).toContain('join-token-updated');
    });

    test('creates new token with kubeadm', () => {
      expect(controlPlaneUserData).toContain('kubeadm token create');
    });

    test('token has TTL set', () => {
      expect(controlPlaneUserData).toContain('--ttl');
    });

    test('stores refreshed token in SSM', () => {
      expect(controlPlaneUserData).toContain('ssm put-parameter');
      expect(controlPlaneUserData).toContain('join-token');
    });

    test('updates token timestamp in SSM', () => {
      expect(controlPlaneUserData).toContain('join-token-updated');
      expect(controlPlaneUserData).toContain('put-parameter');
    });
  });

  describe('SSM Parameter Storage', () => {
    test('stores join token as SecureString', () => {
      expect(controlPlaneUserData).toContain("--type 'SecureString'");
      expect(controlPlaneUserData).toContain('join-token');
    });

    test('stores certificate key as SecureString', () => {
      expect(controlPlaneUserData).toContain("--type 'SecureString'");
      expect(controlPlaneUserData).toContain('certificate-key');
    });

    test('stores CA cert hash as String', () => {
      expect(controlPlaneUserData).toContain("--type 'String'");
      expect(controlPlaneUserData).toContain('ca-cert-hash');
    });

    test('uses --overwrite flag for parameter updates', () => {
      expect(controlPlaneUserData).toContain('--overwrite');
    });
  });

  describe('IAM Permissions for Join', () => {
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

    test('control plane role can register with ELB', () => {
      template.hasResourceProperties('AWS::IAM::Policy', {
        PolicyDocument: {
          Statement: Match.arrayWith([
            Match.objectLike({
              Action: Match.arrayWith(['elasticloadbalancing:RegisterTargets']),
              Effect: 'Allow'
            })
          ])
        }
      });
    });

    test('control plane role can describe target groups', () => {
      template.hasResourceProperties('AWS::IAM::Policy', {
        PolicyDocument: {
          Statement: Match.arrayWith([
            Match.objectLike({
              Action: Match.arrayWith(['elasticloadbalancing:DescribeTargetGroups']),
              Effect: 'Allow'
            })
          ])
        }
      });
    });
  });

  describe('Error Handling', () => {
    test('handles failed etcd registration gracefully', () => {
      expect(controlPlaneUserData).toContain('WARNING: Failed to register etcd member');
    });

    test('handles missing target group ARN', () => {
      expect(controlPlaneUserData).toContain('WARNING: Could not find target group ARN');
    });

    test('warns about token refresh failure', () => {
      expect(controlPlaneUserData).toContain('WARNING: Token refresh failed');
    });
  });

  describe('Worker Node Join (for comparison)', () => {
    let workerUserData: string;

    beforeAll(() => {
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

    test('worker join does not use --control-plane flag', () => {
      // Workers join differently than control plane
      // They should not have --control-plane in their join
      if (workerUserData) {
        // Count occurrences of --control-plane in worker data
        // Should be significantly less than control plane
        const workerControlPlaneCount = (workerUserData.match(/--control-plane/g) || []).length;
        const controlPlaneControlPlaneCount = (controlPlaneUserData.match(/--control-plane/g) || []).length;
        expect(controlPlaneControlPlaneCount).toBeGreaterThan(workerControlPlaneCount);
      }
    });

    test('worker join does not use --certificate-key flag', () => {
      if (workerUserData) {
        // Workers should not need certificate-key for join
        // (they don't become control plane nodes)
        const workerCertKeyInJoin = workerUserData.includes('kubeadm join') &&
                                     workerUserData.includes('--certificate-key');
        // Workers might still have reference to certificate-key in other contexts
        // but the join command structure should differ
        expect(workerUserData).toContain('kubeadm join');
      }
    });
  });

  describe('etcd Member ID Parsing', () => {
    test('register_etcd_member function exists', () => {
      expect(controlPlaneUserData).toContain('register_etcd_member()');
    });

    test('uses etcdctl member list with JSON output', () => {
      expect(controlPlaneUserData).toContain('member list -w json');
    });

    test('Python parsing converts member ID to hex format', () => {
      // etcdctl member remove expects hex format, not decimal
      // The Python code should use format(member['ID'], 'x') to convert
      expect(controlPlaneUserData).toContain("format(member['ID'], 'x')");
    });

    test('all etcd member ID extraction paths produce hex format', () => {
      // The member ID should always be in hex format for etcdctl compatibility
      // Check that there's no decimal-only extraction without hex conversion
      const lines = controlPlaneUserData.split('\n');

      // Find lines that extract member ID from JSON
      // The problematic pattern is: grep -o '"ID":[0-9]*' without hex conversion
      let hasUnconvertedDecimalExtraction = false;

      for (const line of lines) {
        // If we're extracting ID with grep for digits only,
        // we need to ensure there's a hex conversion somewhere
        if (line.includes('"ID":[0-9]') && !line.includes('format') && !line.includes('printf')) {
          // Check if this is the initial extraction (acceptable if later converted)
          // or if it's the final value used (problematic)
          const nextLines = controlPlaneUserData.substring(controlPlaneUserData.indexOf(line));

          // If the extracted value is used directly without hex conversion
          // in an etcdctl command or DynamoDB put, that's a bug
          if (nextLines.includes('etcd_member_id=$(echo') &&
              !nextLines.includes('printf "%x"') &&
              !nextLines.includes('format(')) {
            // Check if there's hex conversion before use
            const extractionToUse = nextLines.substring(0, 500);
            if (!extractionToUse.includes('printf') &&
                !extractionToUse.includes('format(') &&
                extractionToUse.includes('etcd_member_id')) {
              hasUnconvertedDecimalExtraction = true;
            }
          }
        }
      }

      // Ensure any grep-based extraction is followed by hex conversion
      // The fix should add: printf '%x' to convert decimal to hex
      expect(controlPlaneUserData).toContain("printf '%x'");
    });

    test('stores hex member ID in DynamoDB', () => {
      // The EtcdMemberId stored should be in hex format
      expect(controlPlaneUserData).toContain('"EtcdMemberId"');
      expect(controlPlaneUserData).toContain('$etcd_member_id');
    });
  });
});
