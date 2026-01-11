/**
 * Lambda code generation for etcd backup operations.
 * Creates periodic etcd snapshots and uploads to S3.
 */

import { getPythonRetryUtils } from './python-retry';
import { getPythonLoggingSetup } from './python-logging';
import { getPythonMetricsSetup } from './python-metrics';

export function createEtcdBackupLambdaCode(clusterName: string, backupBucket: string): string {
  return `
import json
import boto3
import os
import time

\${getPythonLoggingSetup()}

\${getPythonMetricsSetup()}

ec2 = boto3.client('ec2')
autoscaling = boto3.client('autoscaling')
ssm = boto3.client('ssm')
s3 = boto3.client('s3')

# Configuration
SSM_COMMAND_TIMEOUT = 120
MAX_RETRIES = 3
RETRY_DELAY_SECONDS = 5

class BackupError(Exception):
    """Raised when backup fails"""
    def __init__(self, message, is_retriable=True):
        super().__init__(message)
        self.is_retriable = is_retriable

# Global trace ID for correlation across SSM commands
_trace_id = None

${getPythonRetryUtils()}

def handler(event, context):
    """
    Scheduled handler to create etcd snapshots and upload to S3.
    Runs every 6 hours via EventBridge schedule.
    """
    global _trace_id
    trace_id = uuid.uuid4().hex[:16]
    _trace_id = trace_id
    logger = setup_logging(context, trace_id)
    cluster_name = os.environ['CLUSTER_NAME']
    start_time = time.time() * 1000  # For duration tracking
    metrics = create_metrics_logger('K8sCluster/EtcdBackup', context)

    try:
        logger.info("Starting scheduled etcd backup", extra={'cluster_name': cluster_name})

        # Find a healthy control plane instance
        healthy_instances = get_healthy_control_plane_instances()

        if not healthy_instances:
            logger.error("No healthy control plane instances found for backup", extra={
                'check': 'Verify ASG health in EC2 console and check instance lifecycle states',
                'possible_causes': 'All instances unhealthy, ASG scaling to zero, or instances still launching'
            })
            try:
                metrics.put_metric('BackupFailure', 1, COUNT)
                duration_ms = time.time() * 1000 - start_time
                metrics.put_metric('BackupDuration', duration_ms, MILLISECONDS)
                metrics.flush()
            except Exception:
                pass
            return {'statusCode': 500, 'body': 'No healthy instances'}

        target_instance = healthy_instances[0]
        logger.info("Using instance for backup", extra={'instance_id': target_instance})

        # Create backup with retries using shared utility
        backup_result = retry_with_backoff(
            lambda: create_etcd_backup(target_instance),
            "create etcd backup",
            max_retries=MAX_RETRIES,
            base_delay=RETRY_DELAY_SECONDS,
            jitter_factor=0.3,
            retriable_exceptions=(BackupError,)
        )

        if backup_result:
            backup_key = backup_result.get('key') if isinstance(backup_result, dict) else backup_result
            backup_size = backup_result.get('size') if isinstance(backup_result, dict) else None
            logger.info("Backup completed successfully", extra={'backup_key': backup_key, 'backup_size': backup_size})
            try:
                metrics.put_metric('BackupSuccess', 1, COUNT)
                duration_ms = time.time() * 1000 - start_time
                metrics.put_metric('BackupDuration', duration_ms, MILLISECONDS)
                if backup_size is not None:
                    metrics.put_metric('BackupSizeBytes', backup_size, BYTES)
                metrics.flush()
            except Exception:
                pass
            return {'statusCode': 200, 'body': f'Backup created: {backup_key}'}
        else:
            try:
                metrics.put_metric('BackupFailure', 1, COUNT)
                duration_ms = time.time() * 1000 - start_time
                metrics.put_metric('BackupDuration', duration_ms, MILLISECONDS)
                metrics.flush()
            except Exception:
                pass
            return {'statusCode': 500, 'body': 'Backup failed after all retries'}

    except Exception as e:
        logger.error("Backup failed", extra={
            'error': str(e),
            'error_type': type(e).__name__,
            'check': 'Check etcd health on control plane nodes and verify S3 bucket permissions',
            'possible_causes': 'etcd unhealthy, disk space issues, S3 access denied, or SSM command failures'
        }, exc_info=True)
        try:
            metrics.put_metric('BackupFailure', 1, COUNT)
            duration_ms = time.time() * 1000 - start_time
            metrics.put_metric('BackupDuration', duration_ms, MILLISECONDS)
            metrics.flush()
        except Exception:
            pass
        return {'statusCode': 500, 'body': f'Backup failed: {str(e)}'}


def get_healthy_control_plane_instances():
    """Get list of healthy control plane instances"""
    asg_name = os.environ.get('CONTROL_PLANE_ASG_NAME')
    if not asg_name:
        logger.error("CONTROL_PLANE_ASG_NAME environment variable not set", extra={
            'check': 'Verify Lambda environment variables are configured in CDK stack',
            'possible_causes': 'Missing environment variable configuration in ControlPlaneStack'
        })
        return []

    try:
        response = autoscaling.describe_auto_scaling_groups(
            AutoScalingGroupNames=[asg_name]
        )

        if not response['AutoScalingGroups']:
            return []

        asg = response['AutoScalingGroups'][0]
        instance_ids = [
            i['InstanceId'] for i in asg['Instances']
            if i['LifecycleState'] == 'InService'
        ]

        if not instance_ids:
            return []

        # Verify instances are actually running
        response = ec2.describe_instances(InstanceIds=instance_ids)

        healthy_instances = []
        for reservation in response['Reservations']:
            for instance in reservation['Instances']:
                if instance['State']['Name'] == 'running':
                    healthy_instances.append(instance['InstanceId'])

        logger.info("Found healthy control plane instances", extra={'healthy_count': len(healthy_instances)})
        return healthy_instances

    except Exception as e:
        logger.error("Error finding healthy control plane instances", extra={
            'error': str(e),
            'check': 'Verify ASG exists and Lambda has ec2:DescribeInstances and autoscaling:DescribeAutoScalingGroups permissions',
            'possible_causes': 'ASG not found, IAM permission issues, or AWS API errors'
        })
        return []


def create_etcd_backup(instance_id):
    """
    Create etcd snapshot via SSM and upload to S3.
    Returns the S3 key of the backup.
    """
    cluster_name = os.environ['CLUSTER_NAME']
    bucket_name = os.environ['BACKUP_BUCKET']
    region = os.environ['REGION']
    timestamp = datetime.utcnow().strftime('%Y%m%d-%H%M%S')
    backup_filename = f"etcd-snapshot-{timestamp}.db"
    s3_key = f"{cluster_name}/{backup_filename}"

    # Script to create snapshot and upload to S3
    command = f\"\"\"
set -e
export TRACE_ID="{_trace_id}"

# Create snapshot directory
BACKUP_DIR="/tmp/etcd-backup"
mkdir -p $BACKUP_DIR
SNAPSHOT_FILE="$BACKUP_DIR/{backup_filename}"

# Export etcd environment
export ETCDCTL_API=3
export ETCDCTL_ENDPOINTS=https://127.0.0.1:2379
export ETCDCTL_CACERT=/etc/kubernetes/pki/etcd/ca.crt
export ETCDCTL_CERT=/etc/kubernetes/pki/etcd/server.crt
export ETCDCTL_KEY=/etc/kubernetes/pki/etcd/server.key

# Check etcd health first
echo "Checking etcd health..."
if ! etcdctl endpoint health; then
    echo "ERROR: etcd is not healthy. Check etcd pod status with 'kubectl get pods -n kube-system' and verify certificates in /etc/kubernetes/pki/etcd/. Common causes: etcd container crashed, disk full, or certificate expiration."
    exit 1
fi

# Create snapshot
echo "Creating etcd snapshot..."
etcdctl snapshot save "$SNAPSHOT_FILE"

# Verify snapshot integrity using JSON output for structured data
echo "Verifying snapshot integrity..."
SNAPSHOT_STATUS=$(etcdctl snapshot status "$SNAPSHOT_FILE" --write-out=json)

# Extract hash from snapshot status for integrity verification
SNAPSHOT_HASH=$(echo "$SNAPSHOT_STATUS" | grep -o '"hash":[0-9]*' | cut -d: -f2)
SNAPSHOT_REVISION=$(echo "$SNAPSHOT_STATUS" | grep -o '"revision":[0-9]*' | cut -d: -f2)

# Validate snapshot integrity - hash must be present and non-zero
if [ -z "$SNAPSHOT_HASH" ] || [ "$SNAPSHOT_HASH" = "0" ]; then
    echo "ERROR: Snapshot integrity check failed - invalid or corrupt snapshot. The etcdctl snapshot status returned an invalid hash which indicates data corruption. Try running 'etcdctl endpoint health' to verify etcd cluster state. Recovery may require restoring from a previous backup."
    echo "Snapshot status: $SNAPSHOT_STATUS"
    exit 1
fi

echo "Snapshot integrity verified - Hash: $SNAPSHOT_HASH, Revision: $SNAPSHOT_REVISION"

# Get snapshot size
SNAPSHOT_SIZE=$(stat -c%s "$SNAPSHOT_FILE" 2>/dev/null || stat -f%z "$SNAPSHOT_FILE")
echo "Snapshot size: $SNAPSHOT_SIZE bytes"

# Upload to S3 with metadata for audit trail
echo "Uploading to S3..."
aws s3 cp "$SNAPSHOT_FILE" "s3://{bucket_name}/{s3_key}" --region {region} \\
    --metadata "hash=$SNAPSHOT_HASH,revision=$SNAPSHOT_REVISION,size=$SNAPSHOT_SIZE"

# Cleanup
rm -f "$SNAPSHOT_FILE"

echo "BACKUP_SUCCESS key={s3_key} size=$SNAPSHOT_SIZE hash=$SNAPSHOT_HASH"
\"\"\"

    try:
        response = ssm.send_command(
            InstanceIds=[instance_id],
            DocumentName='AWS-RunShellScript',
            Parameters={{'commands': [command]}},
            TimeoutSeconds=SSM_COMMAND_TIMEOUT
        )
        command_id = response['Command']['CommandId']
        logger.info("SSM backup command sent", extra={'command_id': command_id, 'instance_id': instance_id, 'trace_id': _trace_id})
    except Exception as e:
        raise BackupError(
            f"Failed to send SSM backup command: {str(e)}. "
            f"SSM agent may not be running or instance may be unreachable. "
            f"Check SSM agent status and IAM role permissions on the target instance.",
            is_retriable=True
        )

    # Wait for command completion
    return wait_for_backup_command(command_id, instance_id, s3_key)


def wait_for_backup_command(command_id, instance_id, s3_key):
    """Wait for SSM backup command to complete"""
    max_wait = SSM_COMMAND_TIMEOUT + 30
    poll_interval = 5
    elapsed = 0

    while elapsed < max_wait:
        time.sleep(poll_interval)
        elapsed += poll_interval

        try:
            result = ssm.get_command_invocation(
                CommandId=command_id,
                InstanceId=instance_id
            )
        except ssm.exceptions.InvocationDoesNotExist:
            logger.info("Backup command invocation not ready yet", extra={'command_id': command_id})
            continue

        status = result['Status']

        if status == 'Success':
            stdout = result.get('StandardOutputContent', '')
            logger.info("Backup command succeeded", extra={'command_id': command_id, 's3_key': s3_key})
            # Extract backup info from output
            if 'BACKUP_SUCCESS' in stdout:
                # Parse backup size from output: "BACKUP_SUCCESS key=... size=12345 hash=..."
                backup_size = None
                try:
                    import re
                    size_match = re.search(r'size=(\\d+)', stdout)
                    if size_match:
                        backup_size = int(size_match.group(1))
                except Exception:
                    pass
                return {'key': s3_key, 'size': backup_size}
            raise BackupError(
                "Backup command succeeded but no success marker (BACKUP_SUCCESS) found in output. "
                "The backup script may have completed without writing to S3. "
                "Check SSM command output logs and verify S3 bucket write permissions."
            )

        elif status == 'InProgress' or status == 'Pending':
            continue

        elif status in ['Failed', 'Cancelled', 'TimedOut']:
            stderr = result.get('StandardErrorContent', '')
            stdout = result.get('StandardOutputContent', '')
            error_msg = stderr or stdout or 'Unknown error'
            raise BackupError(
                f"Backup command failed with status {status}: {error_msg}. "
                f"Common causes: etcd unhealthy, insufficient disk space, S3 upload failed, or certificate issues. "
                f"Check etcd endpoint health and verify /tmp has sufficient space.",
                is_retriable=(status == 'TimedOut')
            )

    raise BackupError(
        f"SSM backup command timed out after {SSM_COMMAND_TIMEOUT}s waiting for response. "
        f"Backup may be slow due to large etcd database or slow S3 upload. "
        f"Check SSM command status in AWS console and consider increasing SSM_COMMAND_TIMEOUT.",
        is_retriable=True
    )
`;
}
