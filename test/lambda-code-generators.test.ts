/**
 * Unit tests for Lambda code generator functions.
 *
 * These tests validate that the Lambda code generators produce correct Python
 * code with proper parameter interpolation, expected handler functions,
 * error classes, and retry patterns.
 */

import { createEtcdLifecycleLambdaCode } from '../lib/scripts/etcd-lifecycle-lambda';
import { createEtcdBackupLambdaCode } from '../lib/scripts/etcd-backup-lambda';
import { createClusterHealthLambdaCode } from '../lib/scripts/cluster-health-lambda';

describe('Lambda Code Generators', () => {
  describe('createEtcdLifecycleLambdaCode', () => {
    const clusterName = 'test-cluster';
    let code: string;

    beforeAll(() => {
      code = createEtcdLifecycleLambdaCode(clusterName);
    });

    describe('Python structure', () => {
      test('contains handler function', () => {
        expect(code).toContain('def handler(event, context):');
      });

      test('contains required imports', () => {
        expect(code).toContain('import json');
        expect(code).toContain('import boto3');
        expect(code).toContain('import os');
        expect(code).toContain('import time');
      });

      test('contains AWS client initializations', () => {
        expect(code).toContain("dynamodb = boto3.resource('dynamodb')");
        expect(code).toContain("ec2 = boto3.client('ec2')");
        expect(code).toContain("autoscaling = boto3.client('autoscaling')");
        expect(code).toContain("ssm = boto3.client('ssm')");
      });

      test('configures structured logging', () => {
        expect(code).toContain('getPythonLoggingSetup()');
        // setup_logging may include optional trace_id parameter
        expect(code).toContain('logger = setup_logging(context');
      });
    });

    describe('error classes', () => {
      test('defines NodeDrainError class', () => {
        expect(code).toContain('class NodeDrainError(Exception):');
        expect(code).toContain('"""Raised when node drain fails"""');
      });

      test('defines EtcdRemovalError class', () => {
        expect(code).toContain('class EtcdRemovalError(Exception):');
        expect(code).toContain('"""Raised when etcd member removal fails"""');
      });

      test('defines QuorumRiskError class', () => {
        expect(code).toContain('class QuorumRiskError(Exception):');
        expect(code).toContain('"""Raised when removal would risk etcd quorum"""');
      });

      test('error classes have is_retriable attribute', () => {
        expect(code).toContain('self.is_retriable = is_retriable');
      });
    });

    describe('retry utility inclusion', () => {
      test('includes retry_with_backoff function', () => {
        expect(code).toContain('def retry_with_backoff(');
      });

      test('retry function has expected parameters', () => {
        expect(code).toContain('operation,');
        expect(code).toContain('operation_name,');
        expect(code).toContain('max_retries=3,');
        expect(code).toContain('base_delay=5,');
        expect(code).toContain('retriable_exceptions=(Exception,)');
      });

      test('uses retry for drain operation', () => {
        expect(code).toContain('drain_node_with_retry');
        expect(code).toContain('retriable_exceptions=(NodeDrainError,)');
      });

      test('uses retry for etcd removal operation', () => {
        expect(code).toContain('remove_etcd_member_with_retry');
        expect(code).toContain('retriable_exceptions=(EtcdRemovalError,)');
      });
    });

    describe('environment variable references', () => {
      test('references ETCD_TABLE_NAME environment variable', () => {
        expect(code).toContain("os.environ['ETCD_TABLE_NAME']");
      });

      test('references CONTROL_PLANE_ASG_NAME environment variable', () => {
        expect(code).toContain("os.environ.get('CONTROL_PLANE_ASG_NAME')");
      });
    });

    describe('core functions', () => {
      test('defines get_instance_info function', () => {
        expect(code).toContain('def get_instance_info(instance_id):');
      });

      test('defines lookup_etcd_member function', () => {
        expect(code).toContain('def lookup_etcd_member(instance_id):');
      });

      test('defines check_quorum_safety function', () => {
        expect(code).toContain('def check_quorum_safety(terminating_instance_id):');
      });

      test('defines complete_lifecycle_action function', () => {
        expect(code).toContain('def complete_lifecycle_action(params, result):');
      });

      test('defines get_healthy_control_plane_instances function', () => {
        expect(code).toContain('def get_healthy_control_plane_instances(exclude_instance=None):');
      });
    });

    describe('quorum safety critical path', () => {
      test('checks healthy count against minimum threshold', () => {
        expect(code).toContain('healthy_count < MIN_HEALTHY_NODES_FOR_REMOVAL');
      });

      test('raises QuorumRiskError when insufficient healthy nodes', () => {
        expect(code).toContain('raise QuorumRiskError(');
      });

      test('queries control plane ASG excluding terminating instance', () => {
        expect(code).toContain('get_healthy_control_plane_instances(exclude_instance=terminating_instance_id)');
      });
    });

    describe('lifecycle action completion critical path', () => {
      test('completes lifecycle action with CONTINUE for success', () => {
        expect(code).toContain("complete_lifecycle_action(lifecycle_params, 'CONTINUE')");
      });

      test('completes lifecycle action with ABANDON for failure', () => {
        expect(code).toContain("complete_lifecycle_action(lifecycle_params, 'ABANDON')");
      });

      test('has fallback retry path without token', () => {
        // Critical: If completion fails, retry without token to prevent instance hang
        expect(code).toContain('Completed lifecycle action on retry (without token)');
      });
    });

    describe('node drain timeout handling critical path', () => {
      test('polls SSM command with max_wait timeout', () => {
        expect(code).toContain('while elapsed < max_wait:');
      });

      test('handles InProgress and Pending status during polling', () => {
        expect(code).toContain("status == 'InProgress' or status == 'Pending'");
      });

      test('handles node not found as success (already removed)', () => {
        expect(code).toContain("'not found' in error_msg.lower()");
      });
    });
  });

  describe('createEtcdBackupLambdaCode', () => {
    const clusterName = 'backup-cluster';
    const backupBucket = 'my-backup-bucket';
    let code: string;

    beforeAll(() => {
      code = createEtcdBackupLambdaCode(clusterName, backupBucket);
    });

    describe('parameter interpolation', () => {
      test('bucket name is read from environment variable at runtime', () => {
        // The backup bucket is not interpolated at generation time
        // Instead, it is read from os.environ['BACKUP_BUCKET'] at runtime
        // This allows the same Lambda code to work with different buckets
        expect(code).toContain("bucket_name = os.environ['BACKUP_BUCKET']");
        expect(code).toContain("s3://{bucket_name}/{s3_key}");
      });
    });

    describe('Python structure', () => {
      test('contains handler function', () => {
        expect(code).toContain('def handler(event, context):');
      });

      test('contains required imports', () => {
        expect(code).toContain('import json');
        expect(code).toContain('import boto3');
        expect(code).toContain('import os');
        expect(code).toContain('import time');
      });

      test('contains AWS client initializations', () => {
        expect(code).toContain("ec2 = boto3.client('ec2')");
        expect(code).toContain("autoscaling = boto3.client('autoscaling')");
        expect(code).toContain("ssm = boto3.client('ssm')");
        expect(code).toContain("s3 = boto3.client('s3')");
      });

      test('configures structured logging', () => {
        expect(code).toContain('getPythonLoggingSetup()');
        // setup_logging may include optional trace_id parameter
        expect(code).toContain('logger = setup_logging(context');
      });
    });

    describe('error classes', () => {
      test('defines BackupError class', () => {
        expect(code).toContain('class BackupError(Exception):');
        expect(code).toContain('"""Raised when backup fails"""');
      });

      test('BackupError has is_retriable attribute', () => {
        expect(code).toContain('self.is_retriable = is_retriable');
      });

      test('does NOT define NodeDrainError (lifecycle-specific)', () => {
        expect(code).not.toContain('class NodeDrainError(Exception):');
      });

      test('does NOT define EtcdRemovalError (lifecycle-specific)', () => {
        expect(code).not.toContain('class EtcdRemovalError(Exception):');
      });
    });

    describe('retry utility inclusion', () => {
      test('includes retry_with_backoff function', () => {
        expect(code).toContain('def retry_with_backoff(');
      });

      test('uses retry for backup operation', () => {
        expect(code).toContain('retry_with_backoff(');
        expect(code).toContain('lambda: create_etcd_backup(target_instance)');
        expect(code).toContain('retriable_exceptions=(BackupError,)');
      });
    });

    describe('environment variable references', () => {
      test('references CLUSTER_NAME environment variable', () => {
        expect(code).toContain("os.environ['CLUSTER_NAME']");
      });

      test('references CONTROL_PLANE_ASG_NAME environment variable', () => {
        expect(code).toContain("os.environ.get('CONTROL_PLANE_ASG_NAME')");
      });

      test('references BACKUP_BUCKET environment variable', () => {
        expect(code).toContain("os.environ['BACKUP_BUCKET']");
      });

      test('references REGION environment variable', () => {
        expect(code).toContain("os.environ['REGION']");
      });
    });

    describe('core functions', () => {
      test('defines get_healthy_control_plane_instances function', () => {
        expect(code).toContain('def get_healthy_control_plane_instances():');
      });

      test('defines create_etcd_backup function', () => {
        expect(code).toContain('def create_etcd_backup(instance_id):');
      });

      test('defines wait_for_backup_command function', () => {
        expect(code).toContain('def wait_for_backup_command(command_id, instance_id, s3_key):');
      });
    });

    describe('backup script content', () => {
      test('creates snapshot using etcdctl', () => {
        expect(code).toContain('etcdctl snapshot save');
      });

      test('verifies snapshot integrity', () => {
        expect(code).toContain('etcdctl snapshot status');
      });

      test('uploads to S3', () => {
        expect(code).toContain('aws s3 cp');
      });

      test('sets etcdctl environment variables', () => {
        expect(code).toContain('export ETCDCTL_API=3');
        expect(code).toContain('export ETCDCTL_ENDPOINTS=https://127.0.0.1:2379');
        expect(code).toContain('export ETCDCTL_CACERT=/etc/kubernetes/pki/etcd/ca.crt');
        expect(code).toContain('export ETCDCTL_CERT=/etc/kubernetes/pki/etcd/server.crt');
        expect(code).toContain('export ETCDCTL_KEY=/etc/kubernetes/pki/etcd/server.key');
      });
    });

    describe('snapshot integrity validation critical path', () => {
      test('extracts hash from etcdctl snapshot status JSON output', () => {
        expect(code).toContain('SNAPSHOT_HASH=$(echo "$SNAPSHOT_STATUS"');
        expect(code).toContain('"hash"');
      });

      test('validates hash is not zero (corrupt snapshot detection)', () => {
        expect(code).toContain('$SNAPSHOT_HASH" = "0"');
      });

      test('extracts revision for backup metadata', () => {
        expect(code).toContain('SNAPSHOT_REVISION=$(echo "$SNAPSHOT_STATUS"');
        expect(code).toContain('"revision"');
      });

      test('uploads with hash and revision in S3 metadata', () => {
        expect(code).toContain('--metadata "hash=$SNAPSHOT_HASH,revision=$SNAPSHOT_REVISION');
      });
    });

    describe('backup success detection critical path', () => {
      test('checks for BACKUP_SUCCESS marker in output', () => {
        expect(code).toContain("'BACKUP_SUCCESS' in stdout");
      });

      test('extracts backup size using regex pattern', () => {
        expect(code).toContain("re.search(r'size=(\\d+)', stdout)");
      });

      test('returns S3 key on success', () => {
        expect(code).toContain("return {'key': s3_key, 'size': backup_size}");
      });
    });

    describe('SSM command polling critical path', () => {
      test('polls with elapsed time tracking against max_wait', () => {
        expect(code).toContain('while elapsed < max_wait:');
      });

      test('handles InProgress and Pending status during polling', () => {
        expect(code).toContain("status == 'InProgress' or status == 'Pending'");
      });

      test('handles InvocationDoesNotExist exception', () => {
        expect(code).toContain('ssm.exceptions.InvocationDoesNotExist');
      });
    });
  });

  describe('createClusterHealthLambdaCode', () => {
    const clusterName = 'health-cluster';
    const backupBucket = 'health-backup-bucket';
    let code: string;

    beforeAll(() => {
      code = createClusterHealthLambdaCode(clusterName, backupBucket);
    });

    describe('Python structure', () => {
      test('contains handler function', () => {
        expect(code).toContain('def handler(event, context):');
      });

      test('contains required imports', () => {
        expect(code).toContain('import json');
        expect(code).toContain('import boto3');
        expect(code).toContain('import os');
      });

      test('contains AWS client initializations', () => {
        expect(code).toContain("ec2 = boto3.client('ec2')");
        expect(code).toContain("autoscaling = boto3.client('autoscaling')");
        expect(code).toContain("ssm = boto3.client('ssm')");
        expect(code).toContain("s3 = boto3.client('s3')");
      });

      test('configures structured logging', () => {
        expect(code).toContain('getPythonLoggingSetup()');
        // setup_logging may include optional trace_id parameter
        expect(code).toContain('logger = setup_logging(context');
      });
    });

    describe('error classes', () => {
      test('does NOT define custom exception classes', () => {
        // Cluster health Lambda does not need custom exceptions
        expect(code).not.toContain('class BackupError(Exception):');
        expect(code).not.toContain('class NodeDrainError(Exception):');
        expect(code).not.toContain('class EtcdRemovalError(Exception):');
        expect(code).not.toContain('class QuorumRiskError(Exception):');
      });
    });

    describe('retry utility', () => {
      test('does NOT include retry_with_backoff function', () => {
        // Cluster health Lambda does not use retry utility
        expect(code).not.toContain('def retry_with_backoff(');
      });
    });

    describe('environment variable references', () => {
      test('references CLUSTER_NAME environment variable', () => {
        expect(code).toContain("os.environ['CLUSTER_NAME']");
      });

      test('references REGION environment variable', () => {
        expect(code).toContain("os.environ['REGION']");
      });

      test('references CONTROL_PLANE_ASG_NAME environment variable', () => {
        expect(code).toContain("os.environ.get('CONTROL_PLANE_ASG_NAME')");
      });

      test('references UNHEALTHY_THRESHOLD environment variable', () => {
        expect(code).toContain("os.environ.get('UNHEALTHY_THRESHOLD'");
      });

      test('references BACKUP_BUCKET environment variable', () => {
        expect(code).toContain("os.environ['BACKUP_BUCKET']");
      });
    });

    describe('core functions', () => {
      test('defines get_healthy_instance_count function', () => {
        expect(code).toContain('def get_healthy_instance_count():');
      });

      test('defines get_failure_count function', () => {
        expect(code).toContain('def get_failure_count(cluster_name, region):');
      });

      test('defines set_failure_count function', () => {
        expect(code).toContain('def set_failure_count(cluster_name, region, count):');
      });

      test('defines get_latest_backup function', () => {
        expect(code).toContain('def get_latest_backup():');
      });

      test('defines trigger_restore_mode function', () => {
        expect(code).toContain('def trigger_restore_mode(cluster_name, region, backup_key):');
      });

      test('defines clear_restore_mode function', () => {
        expect(code).toContain('def clear_restore_mode(cluster_name, region):');
      });
    });

    describe('health check logic', () => {
      test('tracks consecutive failure count', () => {
        expect(code).toContain('failure_count += 1');
      });

      test('checks against threshold before triggering recovery', () => {
        expect(code).toContain('if failure_count >= threshold:');
      });

      test('resets failure count on recovery', () => {
        expect(code).toContain('set_failure_count(cluster_name, region, 0)');
      });
    });

    describe('restore mode SSM parameters', () => {
      test('sets restore-mode parameter', () => {
        expect(code).toContain("/cluster/restore-mode'");
      });

      test('sets restore-backup parameter', () => {
        expect(code).toContain("/cluster/restore-backup'");
      });

      test('sets restore-triggered-at parameter', () => {
        expect(code).toContain("/cluster/restore-triggered-at'");
      });

      test('sets initialized parameter to false for recovery', () => {
        expect(code).toContain("/cluster/initialized'");
        expect(code).toContain("Value='false'");
      });
    });

    describe('restore trigger conditions critical path', () => {
      test('compares failure count against configurable threshold', () => {
        expect(code).toContain('if failure_count >= threshold:');
      });

      test('calls trigger_restore_mode with backup key', () => {
        expect(code).toContain('trigger_restore_mode(cluster_name, region, latest_backup)');
      });

      test('sets all required SSM parameters for restore', () => {
        // All four SSM parameters must be set atomically for restore to work
        expect(code).toContain("Name=f'/{cluster_name}/cluster/restore-mode'");
        expect(code).toContain("Name=f'/{cluster_name}/cluster/restore-backup'");
        expect(code).toContain("Name=f'/{cluster_name}/cluster/restore-triggered-at'");
        expect(code).toContain("Name=f'/{cluster_name}/cluster/initialized'");
      });
    });

    describe('latest backup selection critical path', () => {
      test('lists S3 objects with cluster-specific prefix', () => {
        expect(code).toContain('s3.list_objects_v2(');
        expect(code).toContain('Prefix=prefix');
      });

      test('sorts by LastModified descending to get latest', () => {
        expect(code).toContain("key=lambda x: x['LastModified']");
        expect(code).toContain('reverse=True');
      });

      test('handles empty or missing Contents gracefully', () => {
        expect(code).toContain("if 'Contents' not in response or not response['Contents']:");
      });
    });

    describe('failure count state machine critical path', () => {
      test('handles ParameterNotFound when count does not exist', () => {
        expect(code).toContain('ssm.exceptions.ParameterNotFound');
      });

      test('returns zero when parameter not found (initial state)', () => {
        expect(code).toContain('except ssm.exceptions.ParameterNotFound:');
        // Should return 0, not raise
        expect(code).toMatch(/except ssm\.exceptions\.ParameterNotFound:\s*\n\s*return 0/);
      });

      test('increments failure count when unhealthy', () => {
        expect(code).toContain('failure_count += 1');
      });
    });
  });
});
