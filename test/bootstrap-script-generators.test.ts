/**
 * Unit tests for bootstrap script generator functions.
 *
 * These tests validate that the bootstrap script generators produce correct Bash
 * code with proper parameter interpolation, expected Bash structure, required
 * patterns, and retry utility inclusion.
 */

import * as cdk from 'aws-cdk-lib';
import { createWorkerBootstrapScript } from '../lib/scripts/worker-bootstrap';
import { createControlPlaneBootstrapScript } from '../lib/scripts/control-plane-bootstrap';

describe('Bootstrap Script Generators', () => {
  let stack: cdk.Stack;

  beforeAll(() => {
    const app = new cdk.App();
    stack = new cdk.Stack(app, 'TestStack', {
      env: { account: '123456789012', region: 'us-west-2' }
    });
  });

  describe('createWorkerBootstrapScript', () => {
    const clusterName = 'test-worker-cluster';
    let script: string;

    beforeAll(() => {
      script = createWorkerBootstrapScript(clusterName, stack);
    });

    describe('parameter interpolation', () => {
      test('cluster name appears in output', () => {
        expect(script).toContain(clusterName);
      });

      test('region appears in output', () => {
        expect(script).toContain('us-west-2');
      });

      test('SSM parameter paths include cluster name', () => {
        expect(script).toContain(`/${clusterName}/cluster/initialized`);
        expect(script).toContain(`/${clusterName}/cluster/endpoint`);
        expect(script).toContain(`/${clusterName}/cluster/join-token`);
        expect(script).toContain(`/${clusterName}/cluster/ca-cert-hash`);
        expect(script).toContain(`/${clusterName}/kubernetes/version`);
      });
    });

    describe('Bash structure validation', () => {
      test('contains clear script start with comment', () => {
        // Script is embedded in userdata, starts with a comment describing purpose
        expect(script).toContain('# Worker bootstrap script');
      });

      test('contains error handling with set -e or trap', () => {
        expect(script).toContain('trap');
      });

      test('contains cleanup_on_failure function', () => {
        expect(script).toContain('cleanup_on_failure()');
      });

      test('contains kubeadm reset in cleanup', () => {
        expect(script).toContain('kubeadm reset -f');
      });

      test('contains retry configuration variables', () => {
        expect(script).toContain('MAX_RETRIES=');
        expect(script).toContain('RETRY_DELAY=');
      });

      test('contains bootstrap stage tracking', () => {
        expect(script).toContain('BOOTSTRAP_STAGE=');
      });
    });

    describe('required patterns', () => {
      test('contains SSM parameter reads for cluster endpoint', () => {
        expect(script).toContain('aws ssm get-parameter');
        expect(script).toContain('cluster/endpoint');
      });

      test('contains kubeadm join logic', () => {
        expect(script).toContain('kubeadm join');
      });

      test('contains worker node configuration', () => {
        expect(script).toContain('kubelet');
        expect(script).toContain('containerd');
      });

      test('contains kubelet configuration file', () => {
        expect(script).toContain('kubelet-config.yaml');
        expect(script).toContain('KubeletConfiguration');
      });

      test('contains systemd service setup', () => {
        expect(script).toContain('systemctl');
        expect(script).toContain('systemd');
      });

      test('contains instance metadata retrieval', () => {
        expect(script).toContain('169.254.169.254');
        expect(script).toContain('instance-id');
        expect(script).toContain('local-ipv4');
      });

      test('contains IMDSv2 token handling', () => {
        expect(script).toContain('X-aws-ec2-metadata-token');
      });

      test('contains join token refresh logic', () => {
        expect(script).toContain('request_new_token');
        expect(script).toContain('TOKEN_REFRESH_SUCCESS');
      });
    });

    describe('retry utility inclusion', () => {
      test('contains retry_command function', () => {
        expect(script).toContain('retry_command()');
      });

      test('contains retry_command_output function', () => {
        expect(script).toContain('retry_command_output()');
      });

      test('uses argument expansion pattern for command execution', () => {
        // Per 05-01 eval removal, retry functions use "$@" not eval
        // The pattern appears as if "$@"; in the retry_command function
        expect(script).toMatch(/if\s+"\$@"/);
      });

      test('does not use eval for command execution in retry', () => {
        // The retry functions should not use eval "$*"
        // Looking for the specific problematic pattern
        expect(script).not.toMatch(/eval\s+"\$[*@]/);
      });
    });
  });

  describe('createControlPlaneBootstrapScript', () => {
    const clusterName = 'test-cp-cluster';
    const oidcProviderArn = 'arn:aws:iam::123456789012:oidc-provider/s3.us-west-2.amazonaws.com/oidc-bucket';
    const oidcBucketName = 'test-oidc-bucket';
    const etcdBackupBucketName = 'test-etcd-backup-bucket';
    let script: string;

    beforeAll(() => {
      script = createControlPlaneBootstrapScript(
        clusterName,
        oidcProviderArn,
        oidcBucketName,
        etcdBackupBucketName,
        stack
      );
    });

    describe('parameter interpolation', () => {
      test('cluster name appears in output', () => {
        expect(script).toContain(clusterName);
      });

      test('oidcProviderArn appears in output', () => {
        expect(script).toContain(oidcProviderArn);
      });

      test('oidcBucketName appears in output', () => {
        expect(script).toContain(oidcBucketName);
      });

      test('etcdBackupBucketName appears in output', () => {
        expect(script).toContain(etcdBackupBucketName);
      });

      test('region appears in output', () => {
        expect(script).toContain('us-west-2');
      });

      test('SSM parameter paths include cluster name', () => {
        expect(script).toContain(`/${clusterName}/cluster/initialized`);
        expect(script).toContain(`/${clusterName}/cluster/endpoint`);
        expect(script).toContain(`/${clusterName}/cluster/join-token`);
        expect(script).toContain(`/${clusterName}/cluster/ca-cert-hash`);
        expect(script).toContain(`/${clusterName}/kubernetes/version`);
        expect(script).toContain(`/${clusterName}/cluster/certificate-key`);
      });
    });

    describe('Bash structure validation', () => {
      test('contains shebang or clear script start marker', () => {
        expect(script).toMatch(/^#|#!/);
      });

      test('contains error handling with trap', () => {
        expect(script).toContain('trap cleanup_on_failure EXIT');
      });

      test('contains cleanup_on_failure function', () => {
        expect(script).toContain('cleanup_on_failure()');
      });

      test('contains retry configuration variables', () => {
        expect(script).toContain('MAX_RETRIES=');
        expect(script).toContain('RETRY_DELAY=');
      });

      test('contains bootstrap stage tracking', () => {
        expect(script).toContain('BOOTSTRAP_STAGE=');
        expect(script).toContain('"init"');
        expect(script).toContain('"complete"');
      });

      test('contains etcd registration tracking', () => {
        expect(script).toContain('ETCD_REGISTERED=');
      });

      test('contains load balancer registration tracking', () => {
        expect(script).toContain('LB_REGISTERED=');
      });
    });

    describe('DynamoDB bootstrap lock logic', () => {
      test('contains DynamoDB put-item for lock acquisition', () => {
        expect(script).toContain('dynamodb put-item');
      });

      test('contains condition expression for lock', () => {
        expect(script).toContain('condition-expression');
        expect(script).toContain('attribute_not_exists');
      });

      test('contains cluster-init lock name', () => {
        expect(script).toContain('cluster-init');
      });

      test('contains bootstrap-lock table name', () => {
        expect(script).toContain(`${clusterName}-bootstrap-lock`);
      });

      test('contains lock release on failure', () => {
        expect(script).toContain('dynamodb delete-item');
      });
    });

    describe('etcd member registration', () => {
      test('contains register_etcd_member function', () => {
        expect(script).toContain('register_etcd_member()');
      });

      test('contains etcd-members table reference', () => {
        expect(script).toContain(`${clusterName}-etcd-members`);
      });

      test('contains etcdctl member list command', () => {
        expect(script).toContain('etcdctl');
        expect(script).toContain('member list');
      });

      test('contains etcd health check', () => {
        expect(script).toContain('endpoint health');
      });

      test('contains etcd certificate paths', () => {
        expect(script).toContain('/etc/kubernetes/pki/etcd/ca.crt');
        expect(script).toContain('/etc/kubernetes/pki/etcd/server.crt');
        expect(script).toContain('/etc/kubernetes/pki/etcd/server.key');
      });
    });

    describe('kubeadm init and join logic', () => {
      test('contains kubeadm init', () => {
        expect(script).toContain('kubeadm init');
      });

      test('contains kubeadm join', () => {
        expect(script).toContain('kubeadm join');
      });

      test('contains control plane join flag', () => {
        expect(script).toContain('--control-plane');
      });

      test('contains certificate key handling', () => {
        expect(script).toContain('--certificate-key');
        expect(script).toContain('kubeadm certs certificate-key');
      });

      test('contains upload-certs flag', () => {
        expect(script).toContain('--upload-certs');
      });
    });

    describe('SSM parameter writes', () => {
      test('contains SSM put-parameter for cluster endpoint', () => {
        expect(script).toContain('ssm put-parameter');
        expect(script).toContain('cluster/endpoint');
      });

      test('contains SSM put-parameter for join token', () => {
        expect(script).toContain('cluster/join-token');
      });

      test('contains SSM put-parameter for CA cert hash', () => {
        expect(script).toContain('cluster/ca-cert-hash');
      });

      test('contains SSM put-parameter for initialized flag', () => {
        expect(script).toContain('cluster/initialized');
      });

      test('contains SSM put-parameter for certificate key', () => {
        expect(script).toContain('cluster/certificate-key');
      });
    });

    describe('disaster recovery / restore logic', () => {
      test('contains restore mode check', () => {
        expect(script).toContain('RESTORE_MODE');
        expect(script).toContain('cluster/restore-mode');
      });

      test('contains restore_from_backup function', () => {
        expect(script).toContain('restore_from_backup()');
      });

      test('contains etcdctl snapshot restore', () => {
        expect(script).toContain('etcdctl snapshot restore');
      });

      test('contains S3 backup download', () => {
        expect(script).toContain('s3 cp');
        expect(script).toContain(etcdBackupBucketName);
      });

      test('contains restore lock handling', () => {
        expect(script).toContain('restore-lock');
      });
    });

    describe('OIDC setup for IRSA', () => {
      test('contains OIDC issuer configuration', () => {
        expect(script).toContain('OIDC_ISSUER');
        expect(script).toContain('service-account-issuer');
      });

      test('contains OIDC bucket reference', () => {
        // The OIDC bucket name is interpolated in the script
        expect(script).toContain(oidcBucketName);
        expect(script).toContain('OIDC_BUCKET=');
      });

      test('contains JWKS generation', () => {
        expect(script).toContain('keys.json');
        expect(script).toContain('openid-configuration');
      });

      test('contains S3 upload for OIDC documents', () => {
        expect(script).toContain('.well-known/openid-configuration');
      });

      test('contains IAM OIDC provider update', () => {
        expect(script).toContain('update-open-id-connect-provider-thumbprint');
      });
    });

    describe('cluster components installation', () => {
      test('contains Cilium CNI installation', () => {
        expect(script).toContain('cilium');
      });

      test('contains cluster-autoscaler installation', () => {
        expect(script).toContain('cluster-autoscaler');
      });

      test('contains CSR auto-approver installation', () => {
        expect(script).toContain('kubelet-csr-approver');
      });
    });

    describe('certificate rotation setup', () => {
      test('contains certificate renewal script', () => {
        expect(script).toContain('k8s-cert-renewal');
      });

      test('contains systemd timer for certificate renewal', () => {
        expect(script).toContain('k8s-cert-renewal.timer');
      });

      test('contains kubeadm certs renew command', () => {
        expect(script).toContain('kubeadm certs renew all');
      });
    });

    describe('load balancer registration', () => {
      test('contains target group registration', () => {
        expect(script).toContain('elbv2 register-targets');
      });

      test('contains target group lookup', () => {
        expect(script).toContain('elbv2 describe-target-groups');
        expect(script).toContain(`${clusterName}-control-plane-tg`);
      });

      test('contains deregistration on cleanup', () => {
        expect(script).toContain('elbv2 deregister-targets');
      });
    });

    describe('retry utility inclusion', () => {
      test('contains retry_command function', () => {
        expect(script).toContain('retry_command()');
      });

      test('contains retry_command_output function', () => {
        expect(script).toContain('retry_command_output()');
      });

      test('uses argument expansion pattern for command execution', () => {
        // Per 05-01 eval removal, retry functions use "$@" not eval
        // The pattern appears as if "$@"; in the retry_command function
        expect(script).toMatch(/if\s+"\$@"/);
      });

      test('does not use eval for command execution in retry', () => {
        // The retry functions should not use eval "$*"
        expect(script).not.toMatch(/eval\s+"\$[*@]/);
      });
    });

    describe('audit logging configuration', () => {
      test('contains audit policy file', () => {
        expect(script).toContain('audit-policy.yaml');
      });

      test('contains audit log configuration', () => {
        expect(script).toContain('audit-log-path');
        expect(script).toContain('audit-log-maxage');
        expect(script).toContain('audit-log-maxsize');
      });
    });

    describe('trace ID initialization', () => {
      test('contains init_trace_id call', () => {
        expect(script).toContain('init_trace_id');
      });

      test('includes trace_id in log messages', () => {
        expect(script).toContain('trace_id=$TRACE_ID');
      });
    });
  });
});
