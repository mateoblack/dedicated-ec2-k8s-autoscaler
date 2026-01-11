/**
 * Lambda code generation for cluster health monitoring.
 * Monitors cluster health and triggers auto-recovery when needed.
 */

export function createClusterHealthLambdaCode(clusterName: string, backupBucket: string): string {
  return `
import json
import boto3
import os
import logging
from datetime import datetime

logger = logging.getLogger()
logger.setLevel(logging.INFO)

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
    cluster_name = os.environ['CLUSTER_NAME']
    region = os.environ['REGION']
    threshold = int(os.environ.get('UNHEALTHY_THRESHOLD', '3'))

    try:
        logger.info(f"Running health check for cluster {cluster_name}")

        # Check for healthy control plane instances
        healthy_count = get_healthy_instance_count()
        logger.info(f"Healthy control plane instances: {healthy_count}")

        # Get current failure count from SSM
        failure_count = get_failure_count(cluster_name, region)

        if healthy_count == 0:
            # No healthy instances - increment failure counter
            failure_count += 1
            logger.warning(f"No healthy instances! Failure count: {failure_count}/{threshold}")

            if failure_count >= threshold:
                # Check if we have a backup to restore from
                latest_backup = get_latest_backup()
                if latest_backup:
                    logger.error(f"TRIGGERING AUTO-RECOVERY - {failure_count} consecutive failures")
                    logger.info(f"Latest backup available: {latest_backup}")
                    trigger_restore_mode(cluster_name, region, latest_backup)
                    return {
                        'statusCode': 200,
                        'body': f'Restore mode triggered, backup: {latest_backup}'
                    }
                else:
                    logger.error("No backup available for restore!")
                    set_failure_count(cluster_name, region, failure_count)
                    return {
                        'statusCode': 500,
                        'body': 'Cluster unhealthy but no backup available'
                    }
            else:
                set_failure_count(cluster_name, region, failure_count)
                return {
                    'statusCode': 200,
                    'body': f'Unhealthy, failure count: {failure_count}/{threshold}'
                }
        else:
            # Cluster is healthy
            if failure_count > 0:
                logger.info("Cluster recovered, resetting failure count")
                set_failure_count(cluster_name, region, 0)

                # Clear restore mode if it was set
                clear_restore_mode(cluster_name, region)

            return {
                'statusCode': 200,
                'body': f'Healthy, {healthy_count} instances'
            }

    except Exception as e:
        logger.error(f"Health check error: {str(e)}", exc_info=True)
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
        logger.error(f"Error getting instance count: {str(e)}")
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
        logger.error(f"Error getting failure count: {str(e)}")
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
        logger.error(f"Error setting failure count: {str(e)}")


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
        logger.info(f"Latest backup: {latest}, modified: {objects[0]['LastModified']}")
        return latest

    except Exception as e:
        logger.error(f"Error listing backups: {str(e)}")
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

        logger.info(f"Restore mode triggered with backup: {backup_key}")

    except Exception as e:
        logger.error(f"Error triggering restore mode: {str(e)}")
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

        logger.info("Restore mode cleared - cluster recovered")

    except Exception as e:
        logger.error(f"Error clearing restore mode: {str(e)}")
`;
}
