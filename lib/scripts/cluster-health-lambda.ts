/**
 * Lambda code generation for cluster health monitoring.
 * Monitors cluster health and triggers auto-recovery when needed.
 */

import { getPythonLoggingSetup } from './python-logging';
import { getPythonMetricsSetup } from './python-metrics';

export function createClusterHealthLambdaCode(clusterName: string, backupBucket: string): string {
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

def handler(event, context):
    """
    Scheduled health check for cluster auto-recovery.

    Checks:
    1. Are there any healthy control plane instances in the ASG?
    2. If 0 healthy instances for UNHEALTHY_THRESHOLD consecutive checks, trigger restore mode.

    This enables automatic disaster recovery when all control plane nodes fail.
    """
    logger = setup_logging(context)
    cluster_name = os.environ['CLUSTER_NAME']
    region = os.environ['REGION']
    threshold = int(os.environ.get('UNHEALTHY_THRESHOLD', '3'))
    start_time = time.time() * 1000  # For duration tracking
    metrics = create_metrics_logger('K8sCluster/Health', context)

    try:
        logger.info("Running health check", extra={'cluster_name': cluster_name, 'component': 'health-check'})

        # Check for healthy control plane instances
        healthy_count = get_healthy_instance_count()
        logger.info("Healthy control plane instances count", extra={'healthy_count': healthy_count, 'component': 'control-plane'})

        # Get current failure count from SSM
        failure_count = get_failure_count(cluster_name, region)

        # Emit health metrics on every invocation
        try:
            metrics.put_metric('HealthyControlPlaneInstances', healthy_count, COUNT)
            metrics.put_metric('ConsecutiveHealthFailures', failure_count, COUNT)
        except Exception:
            pass

        if healthy_count == 0:
            # No healthy instances - increment failure counter
            failure_count += 1
            logger.warning("No healthy instances", extra={'failure_count': failure_count, 'threshold': threshold, 'status': 'unhealthy'})

            if failure_count >= threshold:
                # Check if we have a backup to restore from
                latest_backup = get_latest_backup()
                if latest_backup:
                    logger.error("TRIGGERING AUTO-RECOVERY", extra={
                        'failure_count': failure_count,
                        'backup_key': latest_backup,
                        'check': 'Monitor new instance launch in EC2 console and check bootstrap logs in CloudWatch',
                        'possible_causes': 'All control plane instances failed health checks for consecutive intervals'
                    })
                    logger.info("Latest backup available", extra={'backup_key': latest_backup})
                    trigger_restore_mode(cluster_name, region, latest_backup)
                    try:
                        metrics.put_metric('AutoRecoveryTriggered', 1, COUNT)
                        duration_ms = time.time() * 1000 - start_time
                        metrics.put_metric('HealthCheckDuration', duration_ms, MILLISECONDS)
                        metrics.flush()
                    except Exception:
                        pass
                    return {
                        'statusCode': 200,
                        'body': f'Restore mode triggered, backup: {latest_backup}'
                    }
                else:
                    logger.error("No backup available for restore", extra={
                        'status': 'critical',
                        'check': 'Verify S3 backup bucket has recent backups and check etcd-backup Lambda execution logs',
                        'possible_causes': 'Backup Lambda not running, S3 bucket empty, or backup schedule not configured'
                    })
                    set_failure_count(cluster_name, region, failure_count)
                    try:
                        duration_ms = time.time() * 1000 - start_time
                        metrics.put_metric('HealthCheckDuration', duration_ms, MILLISECONDS)
                        metrics.flush()
                    except Exception:
                        pass
                    return {
                        'statusCode': 500,
                        'body': 'Cluster unhealthy but no backup available'
                    }
            else:
                set_failure_count(cluster_name, region, failure_count)
                try:
                    duration_ms = time.time() * 1000 - start_time
                    metrics.put_metric('HealthCheckDuration', duration_ms, MILLISECONDS)
                    metrics.flush()
                except Exception:
                    pass
                return {
                    'statusCode': 200,
                    'body': f'Unhealthy, failure count: {failure_count}/{threshold}'
                }
        else:
            # Cluster is healthy
            if failure_count > 0:
                logger.info("Cluster recovered, resetting failure count", extra={'status': 'recovered'})
                set_failure_count(cluster_name, region, 0)

                # Clear restore mode if it was set
                clear_restore_mode(cluster_name, region)

                try:
                    metrics.put_metric('ClusterRecovered', 1, COUNT)
                except Exception:
                    pass

            try:
                duration_ms = time.time() * 1000 - start_time
                metrics.put_metric('HealthCheckDuration', duration_ms, MILLISECONDS)
                metrics.flush()
            except Exception:
                pass
            return {
                'statusCode': 200,
                'body': f'Healthy, {healthy_count} instances'
            }

    except Exception as e:
        logger.error("Health check error", extra={
            'error': str(e),
            'error_type': type(e).__name__,
            'check': 'Review Lambda logs and verify IAM permissions for EC2, ASG, S3, and SSM APIs',
            'possible_causes': 'IAM permission issues, network connectivity, or AWS service errors'
        }, exc_info=True)
        try:
            duration_ms = time.time() * 1000 - start_time
            metrics.put_metric('HealthCheckDuration', duration_ms, MILLISECONDS)
            metrics.flush()
        except Exception:
            pass
        return {'statusCode': 500, 'body': f'Error: {str(e)}'}


def get_healthy_instance_count():
    """Count healthy control plane instances in ASG"""
    asg_name = os.environ.get('CONTROL_PLANE_ASG_NAME')

    try:
        response = autoscaling.describe_auto_scaling_groups(
            AutoScalingGroupNames=[asg_name]
        )

        if not response['AutoScalingGroups']:
            return 0

        asg = response['AutoScalingGroups'][0]

        # Get instances that are InService
        in_service_ids = [
            i['InstanceId'] for i in asg['Instances']
            if i['LifecycleState'] == 'InService'
        ]

        if not in_service_ids:
            return 0

        # Verify they're actually running
        response = ec2.describe_instances(InstanceIds=in_service_ids)

        running_count = 0
        for reservation in response['Reservations']:
            for instance in reservation['Instances']:
                if instance['State']['Name'] == 'running':
                    running_count += 1

        return running_count

    except Exception as e:
        logger.error("Error getting instance count from ASG", extra={
            'error': str(e),
            'check': 'Verify ASG exists and Lambda has ec2:DescribeInstances and autoscaling:DescribeAutoScalingGroups permissions',
            'possible_causes': 'ASG not found, IAM permission issues, or AWS API errors'
        })
        return 0


def get_failure_count(cluster_name, region):
    """Get consecutive failure count from SSM"""
    try:
        response = ssm.get_parameter(
            Name=f'/{cluster_name}/health/failure-count'
        )
        return int(response['Parameter']['Value'])
    except ssm.exceptions.ParameterNotFound:
        return 0
    except Exception as e:
        logger.error("Error getting failure count from SSM", extra={
            'error': str(e),
            'cluster_name': cluster_name,
            'check': 'Verify SSM parameter exists and Lambda has ssm:GetParameter permission',
            'possible_causes': 'SSM access denied, parameter path incorrect, or network issues'
        })
        return 0


def set_failure_count(cluster_name, region, count):
    """Set consecutive failure count in SSM"""
    try:
        ssm.put_parameter(
            Name=f'/{cluster_name}/health/failure-count',
            Value=str(count),
            Type='String',
            Overwrite=True
        )
    except Exception as e:
        logger.error("Error setting failure count in SSM", extra={
            'error': str(e),
            'cluster_name': cluster_name,
            'count': count,
            'check': 'Verify Lambda has ssm:PutParameter permission for /{cluster_name}/health/* path',
            'possible_causes': 'SSM access denied, IAM policy too restrictive, or network issues'
        })


def get_latest_backup():
    """Get the latest backup file from S3"""
    bucket = os.environ['BACKUP_BUCKET']
    cluster_name = os.environ['CLUSTER_NAME']
    prefix = f"{cluster_name}/"

    try:
        response = s3.list_objects_v2(
            Bucket=bucket,
            Prefix=prefix
        )

        if 'Contents' not in response or not response['Contents']:
            return None

        # Sort by LastModified descending
        objects = sorted(
            response['Contents'],
            key=lambda x: x['LastModified'],
            reverse=True
        )

        # Return the most recent backup
        latest = objects[0]['Key']
        logger.info("Found latest backup", extra={'backup_key': latest, 'modified': str(objects[0]['LastModified'])})
        return latest

    except Exception as e:
        logger.error("Error listing backups from S3", extra={
            'error': str(e),
            'bucket': bucket,
            'check': 'Verify S3 bucket exists and Lambda has s3:ListBucket permission',
            'possible_causes': 'S3 access denied, bucket not found, or bucket policy restrictions'
        })
        return None


def trigger_restore_mode(cluster_name, region, backup_key):
    """Set restore mode flag in SSM to trigger recovery on next bootstrap"""
    try:
        # Set restore mode with backup location
        ssm.put_parameter(
            Name=f'/{cluster_name}/cluster/restore-mode',
            Value='true',
            Type='String',
            Overwrite=True
        )

        ssm.put_parameter(
            Name=f'/{cluster_name}/cluster/restore-backup',
            Value=backup_key,
            Type='String',
            Overwrite=True
        )

        ssm.put_parameter(
            Name=f'/{cluster_name}/cluster/restore-triggered-at',
            Value=datetime.utcnow().isoformat(),
            Type='String',
            Overwrite=True
        )

        # Mark cluster as NOT initialized so new nodes will attempt init/restore
        ssm.put_parameter(
            Name=f'/{cluster_name}/cluster/initialized',
            Value='false',
            Type='String',
            Overwrite=True
        )

        logger.info("Restore mode triggered", extra={'backup_key': backup_key, 'cluster_name': cluster_name})

    except Exception as e:
        logger.error("Error triggering restore mode via SSM", extra={
            'error': str(e),
            'backup_key': backup_key,
            'check': 'Verify Lambda has ssm:PutParameter permission for /{cluster_name}/cluster/* path',
            'possible_causes': 'SSM access denied, IAM policy too restrictive, or network issues'
        })
        raise


def clear_restore_mode(cluster_name, region):
    """Clear restore mode flag after successful recovery"""
    try:
        # Check if restore mode is set
        try:
            response = ssm.get_parameter(Name=f'/{cluster_name}/cluster/restore-mode')
            if response['Parameter']['Value'] != 'true':
                return
        except ssm.exceptions.ParameterNotFound:
            return

        # Clear restore mode
        ssm.put_parameter(
            Name=f'/{cluster_name}/cluster/restore-mode',
            Value='false',
            Type='String',
            Overwrite=True
        )

        # Reset failure count
        set_failure_count(cluster_name, region, 0)

        logger.info("Restore mode cleared - cluster recovered", extra={'cluster_name': cluster_name, 'status': 'recovered'})

    except Exception as e:
        logger.error("Error clearing restore mode via SSM", extra={
            'error': str(e),
            'cluster_name': cluster_name,
            'check': 'Verify Lambda has ssm:PutParameter permission for /{cluster_name}/cluster/* path',
            'possible_causes': 'SSM access denied, IAM policy too restrictive, or network issues'
        })
`;
}
