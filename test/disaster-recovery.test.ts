import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { K8sClusterStack } from '../lib/k8s-cluster-stack';

describe('Disaster Recovery', () => {
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

    // Extract control plane user data for testing restore logic
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

  describe('Restore Mode Detection', () => {
    test('checks SSM parameter for restore-mode flag', () => {
      expect(controlPlaneUserData).toContain('/cluster/restore-mode');
      expect(controlPlaneUserData).toContain('get-parameter');
    });

    test('checks SSM parameter for restore-backup key', () => {
      expect(controlPlaneUserData).toContain('/cluster/restore-backup');
    });

    test('handles restore-mode SSM parameter not found gracefully', () => {
      expect(controlPlaneUserData).toContain('|| echo "false"');
    });

    test('handles restore-backup SSM parameter not found gracefully', () => {
      expect(controlPlaneUserData).toContain('|| echo ""');
    });

    test('only triggers restore when both restore-mode is true AND backup key exists', () => {
      expect(controlPlaneUserData).toContain('RESTORE_MODE');
      expect(controlPlaneUserData).toContain('RESTORE_BACKUP');
      expect(controlPlaneUserData).toContain('= "true"');
      expect(controlPlaneUserData).toContain('-n "$RESTORE_BACKUP"');
    });

    test('logs restore mode detection message', () => {
      expect(controlPlaneUserData).toContain('RESTORE MODE DETECTED');
    });

    test('logs backup key being restored', () => {
      // With structured logging, backup key is logged as a context parameter
      expect(controlPlaneUserData).toContain('backup=');
    });
  });

  describe('Restore Lock Mechanism', () => {
    test('acquires restore lock via DynamoDB conditional write', () => {
      expect(controlPlaneUserData).toContain('restore-lock');
      expect(controlPlaneUserData).toContain('dynamodb put-item');
      expect(controlPlaneUserData).toContain('condition-expression');
      expect(controlPlaneUserData).toContain('attribute_not_exists');
    });

    test('restore lock includes instance ID for tracking', () => {
      expect(controlPlaneUserData).toContain('InstanceId');
      expect(controlPlaneUserData).toContain('$INSTANCE_ID');
    });

    test('restore lock has RESTORING status', () => {
      expect(controlPlaneUserData).toContain('"Status":{"S":"RESTORING"}');
    });

    test('restore lock includes timestamp', () => {
      expect(controlPlaneUserData).toContain('CreatedAt');
    });

    test('releases restore lock after successful restoration', () => {
      expect(controlPlaneUserData).toContain('dynamodb delete-item');
      expect(controlPlaneUserData).toContain('restore-lock');
    });

    test('releases restore lock on restoration failure', () => {
      // Check that lock is released in failure path too
      // delete-item and restore-lock are on separate lines due to shell line continuations
      const deleteItemCount = (controlPlaneUserData.match(/dynamodb delete-item/g) || []).length;
      const restoreLockCount = (controlPlaneUserData.match(/"restore-lock"/g) || []).length;
      // Should have at least 2 delete-item calls that reference restore-lock (success + failure paths)
      expect(deleteItemCount).toBeGreaterThanOrEqual(2);
      expect(restoreLockCount).toBeGreaterThanOrEqual(2);
    });

    test('allows other nodes to join when restore lock is held', () => {
      expect(controlPlaneUserData).toContain('Another node is handling restoration');
      expect(controlPlaneUserData).toContain('waiting for cluster to be ready');
    });
  });

  describe('Restore Lock TTL/Stale Lock Handling', () => {
    // If a node crashes during restore, the lock remains in DynamoDB permanently
    // This blocks all future restore attempts (disaster recovery becomes impossible)
    // The solution is to check if existing locks are stale and override them

    test('checks for existing restore lock before acquiring', () => {
      // Should query for existing lock to check its age
      expect(controlPlaneUserData).toContain('get-item');
      expect(controlPlaneUserData).toMatch(/restore-lock.*get-item|get-item.*restore-lock/s);
    });

    test('retrieves CreatedAt timestamp from existing lock', () => {
      // Need to check when the existing lock was created
      expect(controlPlaneUserData).toContain('existing_lock');
      expect(controlPlaneUserData).toContain('CreatedAt');
    });

    test('has stale lock threshold defined (30 minutes)', () => {
      // Restore should complete within 30 minutes; locks older than this are stale
      // 1800 seconds = 30 minutes
      expect(controlPlaneUserData).toMatch(/1800|30.*minute|RESTORE_LOCK_TTL/i);
    });

    test('calculates age of existing restore lock', () => {
      // Should calculate how old the lock is
      expect(controlPlaneUserData).toContain('lock_age');
    });

    test('force-removes stale restore lock', () => {
      // If lock is older than threshold, delete it before trying to acquire
      expect(controlPlaneUserData).toMatch(/stale.*lock|lock.*stale|expired.*lock|lock.*expired/i);
      expect(controlPlaneUserData).toContain('delete-item');
    });

    test('logs when overriding stale restore lock', () => {
      // Should log that a stale lock was found and removed
      expect(controlPlaneUserData).toMatch(/stale.*restore.*lock|removing.*stale|override.*lock/i);
    });

    test('includes lock holder instance ID in stale lock detection', () => {
      // When removing stale lock, log which instance held it
      expect(controlPlaneUserData).toContain('lock_holder');
    });
  });

  describe('Backup Download', () => {
    test('downloads backup from S3 bucket', () => {
      expect(controlPlaneUserData).toContain('aws s3 cp');
      expect(controlPlaneUserData).toContain('$backup_key');
    });

    test('downloads to temporary file location', () => {
      expect(controlPlaneUserData).toContain('/tmp/etcd-restore.db');
    });

    test('uses retry logic for S3 download', () => {
      expect(controlPlaneUserData).toContain('retry_command');
      expect(controlPlaneUserData).toContain('s3 cp');
    });

    test('handles S3 download failure gracefully', () => {
      expect(controlPlaneUserData).toContain('Failed to download backup from S3');
      expect(controlPlaneUserData).toContain('return 1');
    });

    test('logs successful backup download', () => {
      expect(controlPlaneUserData).toContain('Backup downloaded successfully');
    });

    test('sets BOOTSTRAP_STAGE to restore-download during download', () => {
      expect(controlPlaneUserData).toContain('BOOTSTRAP_STAGE="restore-download"');
    });

    test('cleans up backup file after restore', () => {
      expect(controlPlaneUserData).toContain('rm -f $backup_file');
    });
  });

  describe('etcd Snapshot Restore', () => {
    test('uses etcdctl to restore snapshot', () => {
      expect(controlPlaneUserData).toContain('etcdctl snapshot restore');
    });

    test('sets ETCDCTL_API to version 3', () => {
      expect(controlPlaneUserData).toContain('ETCDCTL_API=3');
    });

    test('restores to temporary directory first', () => {
      expect(controlPlaneUserData).toContain('/var/lib/etcd-restore');
    });

    test('creates restore directory fresh by removing existing', () => {
      expect(controlPlaneUserData).toContain('rm -rf $restore_dir');
      expect(controlPlaneUserData).toContain('mkdir -p $restore_dir');
    });

    test('configures etcd name from hostname', () => {
      expect(controlPlaneUserData).toContain('--name=$(hostname)');
    });

    test('configures initial cluster with private IP', () => {
      expect(controlPlaneUserData).toContain('--initial-cluster=');
      expect(controlPlaneUserData).toContain('$PRIVATE_IP:2380');
    });

    test('uses restored cluster token', () => {
      expect(controlPlaneUserData).toContain('--initial-cluster-token=');
      expect(controlPlaneUserData).toContain('-restored');
    });

    test('configures initial advertise peer URLs', () => {
      expect(controlPlaneUserData).toContain('--initial-advertise-peer-urls=');
    });

    test('handles etcd restore failure', () => {
      expect(controlPlaneUserData).toContain('etcd restore failed');
    });

    test('moves restored data to final etcd directory', () => {
      expect(controlPlaneUserData).toContain('rm -rf /var/lib/etcd');
      expect(controlPlaneUserData).toContain('mv $restore_dir /var/lib/etcd');
    });

    test('sets proper ownership on etcd data', () => {
      expect(controlPlaneUserData).toContain('chown -R root:root /var/lib/etcd');
    });

    test('sets BOOTSTRAP_STAGE to restore-etcd during restore', () => {
      expect(controlPlaneUserData).toContain('BOOTSTRAP_STAGE="restore-etcd"');
    });

    test('logs successful etcd snapshot restoration', () => {
      expect(controlPlaneUserData).toContain('etcd snapshot restored');
    });
  });

  describe('Cluster Re-initialization', () => {
    test('creates kubeadm restore config file', () => {
      expect(controlPlaneUserData).toContain('kubeadm-restore-config.yaml');
    });

    test('kubeadm config includes InitConfiguration', () => {
      expect(controlPlaneUserData).toContain('kind: InitConfiguration');
    });

    test('kubeadm config includes ClusterConfiguration', () => {
      expect(controlPlaneUserData).toContain('kind: ClusterConfiguration');
    });

    test('kubeadm config sets advertise address from private IP', () => {
      expect(controlPlaneUserData).toContain('advertiseAddress: $PRIVATE_IP');
    });

    test('kubeadm config uses load balancer endpoint', () => {
      expect(controlPlaneUserData).toContain('controlPlaneEndpoint:');
      expect(controlPlaneUserData).toContain('-cp-lb.internal:6443');
    });

    test('kubeadm config sets pod subnet', () => {
      expect(controlPlaneUserData).toContain('podSubnet: 10.244.0.0/16');
    });

    test('kubeadm config sets service subnet', () => {
      expect(controlPlaneUserData).toContain('serviceSubnet: 10.96.0.0/12');
    });

    test('kubeadm config references etcd data directory', () => {
      expect(controlPlaneUserData).toContain('dataDir: /var/lib/etcd');
    });

    test('runs kubeadm init with restore config', () => {
      expect(controlPlaneUserData).toContain('kubeadm init');
      expect(controlPlaneUserData).toContain('--config=/tmp/kubeadm-restore-config.yaml');
    });

    test('ignores etcd directory preflight error for restore', () => {
      expect(controlPlaneUserData).toContain('--ignore-preflight-errors=DirAvailable--var-lib-etcd');
    });

    test('uploads certs during restore init', () => {
      expect(controlPlaneUserData).toContain('--upload-certs');
    });

    test('handles kubeadm init failure after restore', () => {
      expect(controlPlaneUserData).toContain('kubeadm init after restore failed');
    });

    test('logs successful cluster restoration', () => {
      expect(controlPlaneUserData).toContain('Cluster restored successfully');
    });

    test('sets BOOTSTRAP_STAGE to restore-kubeadm during init', () => {
      expect(controlPlaneUserData).toContain('BOOTSTRAP_STAGE="restore-kubeadm"');
    });
  });

  describe('Audit Logging in Restore', () => {
    test('creates audit policy directory in restore path', () => {
      expect(controlPlaneUserData).toContain('mkdir -p /etc/kubernetes');
    });

    test('creates audit log directory in restore path', () => {
      expect(controlPlaneUserData).toContain('mkdir -p /var/log/kubernetes/audit');
    });

    test('restore creates audit policy file', () => {
      expect(controlPlaneUserData).toContain('AUDITPOLICYRESTORE');
    });

    test('restore config includes audit policy file reference', () => {
      expect(controlPlaneUserData).toContain('audit-policy-file: /etc/kubernetes/audit-policy.yaml');
    });

    test('restore config includes audit log path', () => {
      expect(controlPlaneUserData).toContain('audit-log-path: /var/log/kubernetes/audit/audit.log');
    });

    test('restore config includes audit volume mounts', () => {
      expect(controlPlaneUserData).toContain('name: audit-policy');
      expect(controlPlaneUserData).toContain('name: audit-logs');
    });
  });

  describe('Post-Restore Setup', () => {
    test('configures kubectl after restore', () => {
      expect(controlPlaneUserData).toContain('mkdir -p /root/.kube');
      expect(controlPlaneUserData).toContain('cp -i /etc/kubernetes/admin.conf /root/.kube/config');
    });

    test('generates new certificate key after restore', () => {
      expect(controlPlaneUserData).toContain('kubeadm certs certificate-key');
    });

    test('uploads new certificates after restore', () => {
      expect(controlPlaneUserData).toContain('kubeadm init phase upload-certs');
    });

    test('creates new join token after restore', () => {
      expect(controlPlaneUserData).toContain('kubeadm token create');
    });

    test('generates CA certificate hash after restore', () => {
      expect(controlPlaneUserData).toContain('openssl x509 -pubkey');
      expect(controlPlaneUserData).toContain('openssl dgst -sha256');
    });

    test('updates cluster endpoint SSM parameter', () => {
      expect(controlPlaneUserData).toContain('/cluster/endpoint');
      expect(controlPlaneUserData).toContain('put-parameter');
    });

    test('updates join token SSM parameter', () => {
      expect(controlPlaneUserData).toContain('/cluster/join-token');
    });

    test('updates CA cert hash SSM parameter', () => {
      expect(controlPlaneUserData).toContain('/cluster/ca-cert-hash');
    });

    test('updates certificate key SSM parameter', () => {
      expect(controlPlaneUserData).toContain('/cluster/certificate-key');
    });

    test('marks cluster as initialized after restore', () => {
      expect(controlPlaneUserData).toContain('/cluster/initialized');
      expect(controlPlaneUserData).toContain("--value 'true'");
    });

    test('clears restore mode SSM parameter after successful restore', () => {
      expect(controlPlaneUserData).toContain('/cluster/restore-mode');
      expect(controlPlaneUserData).toContain("--value 'false'");
    });

    test('registers etcd member after restore', () => {
      expect(controlPlaneUserData).toContain('register_etcd_member');
    });

    test('registers with load balancer after restore', () => {
      expect(controlPlaneUserData).toContain('register-targets');
      expect(controlPlaneUserData).toContain('TARGET_GROUP_ARN');
    });

    test('logs disaster recovery completion', () => {
      expect(controlPlaneUserData).toContain('Disaster recovery completed successfully');
    });

    test('logs control plane bootstrap restore completion', () => {
      expect(controlPlaneUserData).toContain('Control plane bootstrap (restore) completed');
    });
  });

  describe('IRSA Support in Restore', () => {
    test('restore config includes service account issuer', () => {
      expect(controlPlaneUserData).toContain('service-account-issuer:');
    });

    test('service account issuer uses S3 URL format', () => {
      expect(controlPlaneUserData).toContain('s3.');
      expect(controlPlaneUserData).toContain('.amazonaws.com');
    });
  });

  describe('Restore Function Definition', () => {
    test('restore_from_backup function is defined', () => {
      expect(controlPlaneUserData).toContain('restore_from_backup()');
    });

    test('restore function accepts backup key parameter', () => {
      expect(controlPlaneUserData).toContain('local backup_key="$1"');
    });

    test('restore function logs the backup being restored', () => {
      // With structured logging, uses log_info with backup_key parameter
      expect(controlPlaneUserData).toContain('Restoring cluster from backup');
    });

    test('restore function returns 0 on success implied by structure', () => {
      // The function doesn't explicitly return 0, but exits successfully through normal flow
      // We check that error cases return 1
      expect(controlPlaneUserData).toContain('return 1');
    });
  });

  describe('Error Handling in Restore', () => {
    test('exits with error code 1 on restore failure', () => {
      expect(controlPlaneUserData).toContain('Disaster recovery failed');
      expect(controlPlaneUserData).toContain('exit 1');
    });

    test('handles missing backup gracefully', () => {
      expect(controlPlaneUserData).toContain('Failed to download backup from S3');
    });

    test('handles etcd restore failure', () => {
      expect(controlPlaneUserData).toContain('etcd restore failed');
    });

    test('handles kubeadm init failure after restore', () => {
      expect(controlPlaneUserData).toContain('kubeadm init after restore failed');
    });

    test('cleans up restore lock on failure', () => {
      // Check that there's lock cleanup in the failure path
      expect(controlPlaneUserData).toContain('dynamodb delete-item');
    });
  });

  describe('Restore Prerequisites', () => {
    test('etcd backup bucket exists for restore source', () => {
      template.hasResourceProperties('AWS::S3::Bucket', {
        BucketName: Match.stringLikeRegexp('.*etcd-backup.*')
      });
    });

    test('DynamoDB table exists for restore lock', () => {
      template.hasResourceProperties('AWS::DynamoDB::Table', {
        TableName: 'test-cluster-etcd-members'
      });
    });

    test('SSM parameters can store restore state', () => {
      // Verify control plane role has SSM permissions
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

    test('control plane role has S3 read access for backup download', () => {
      template.hasResourceProperties('AWS::IAM::Policy', {
        PolicyDocument: {
          Statement: Match.arrayWith([
            Match.objectLike({
              Action: Match.arrayWith(['s3:GetObject']),
              Effect: 'Allow'
            })
          ])
        }
      });
    });
  });

  describe('Integration with Health Lambda', () => {
    test('health Lambda can trigger restore mode', () => {
      // Verify cluster health Lambda exists
      template.hasResourceProperties('AWS::Lambda::Function', {
        FunctionName: 'test-cluster-cluster-health'
      });
    });

    test('health Lambda has SSM write permission for restore-mode', () => {
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

    test('health Lambda has S3 read access to check backups', () => {
      template.hasResourceProperties('AWS::IAM::Policy', {
        PolicyDocument: {
          Statement: Match.arrayWith([
            Match.objectLike({
              Action: Match.arrayWith(['s3:ListBucket']),
              Effect: 'Allow'
            })
          ])
        }
      });
    });
  });

  describe('restore_from_backup Function', () => {
    test('function is properly defined with parameter', () => {
      expect(controlPlaneUserData).toContain('restore_from_backup() {');
      expect(controlPlaneUserData).toContain('local backup_key="$1"');
    });

    test('function downloads backup to temp location', () => {
      expect(controlPlaneUserData).toContain('local backup_file="/tmp/etcd-restore.db"');
    });

    test('function creates restore directory', () => {
      expect(controlPlaneUserData).toContain('local restore_dir="/var/lib/etcd-restore"');
    });
  });
});
