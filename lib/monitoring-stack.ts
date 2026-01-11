import * as cdk from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as autoscaling from 'aws-cdk-lib/aws-autoscaling';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import { Construct } from 'constructs';

export interface MonitoringStackProps {
  readonly clusterName: string;
  readonly controlPlaneAutoScalingGroup: autoscaling.AutoScalingGroup;
  readonly workerAutoScalingGroup: autoscaling.AutoScalingGroup;
  readonly controlPlaneTargetGroup: elbv2.NetworkTargetGroup;
  readonly controlPlaneLoadBalancer: elbv2.NetworkLoadBalancer;
  readonly etcdLifecycleLambda: lambda.Function;
  readonly etcdBackupLambda: lambda.Function;
  readonly clusterHealthLambda: lambda.Function;
  readonly bootstrapLockTable: dynamodb.Table;
  readonly etcdMemberTable: dynamodb.Table;
}

export class MonitoringStack extends Construct {
  public readonly dashboard: cloudwatch.Dashboard;
  public readonly alarms: cloudwatch.Alarm[];

  constructor(scope: Construct, id: string, props: MonitoringStackProps) {
    super(scope, id);

    // Create all alarms
    this.alarms = this.createAlarms(props);

    // Create CloudWatch Dashboard
    this.dashboard = this.createDashboard(props, this.alarms);
  }

  private createAlarms(props: MonitoringStackProps): cloudwatch.Alarm[] {
    const alarms: cloudwatch.Alarm[] = [];

    // === Control Plane Alarms ===

    // Control plane ASG unhealthy instances
    alarms.push(new cloudwatch.Alarm(this, 'ControlPlaneUnhealthyAlarm', {
      alarmName: `${props.clusterName}-control-plane-unhealthy-instances`,
      alarmDescription: 'Control plane Auto Scaling Group has unhealthy instances',
      metric: new cloudwatch.Metric({
        namespace: 'AWS/AutoScaling',
        metricName: 'UnHealthyHostCount',
        dimensionsMap: {
          AutoScalingGroupName: props.controlPlaneAutoScalingGroup.autoScalingGroupName
        },
        statistic: 'Average',
        period: cdk.Duration.seconds(60)
      }),
      threshold: 1,
      evaluationPeriods: 3,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING
    }));

    // NLB target group unhealthy hosts (API server)
    alarms.push(new cloudwatch.Alarm(this, 'ApiServerUnhealthyAlarm', {
      alarmName: `${props.clusterName}-api-server-unhealthy`,
      alarmDescription: 'API server target group has unhealthy hosts',
      metric: new cloudwatch.Metric({
        namespace: 'AWS/NetworkELB',
        metricName: 'UnHealthyHostCount',
        dimensionsMap: {
          TargetGroup: props.controlPlaneTargetGroup.targetGroupFullName,
          LoadBalancer: props.controlPlaneLoadBalancer.loadBalancerFullName
        },
        statistic: 'Average',
        period: cdk.Duration.seconds(60)
      }),
      threshold: 1,
      evaluationPeriods: 3,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING
    }));

    // API server high latency
    alarms.push(new cloudwatch.Alarm(this, 'ApiServerLatencyAlarm', {
      alarmName: `${props.clusterName}-api-server-high-latency`,
      alarmDescription: 'API server response time is high',
      metric: new cloudwatch.Metric({
        namespace: 'AWS/NetworkELB',
        metricName: 'TargetResponseTime',
        dimensionsMap: {
          TargetGroup: props.controlPlaneTargetGroup.targetGroupFullName,
          LoadBalancer: props.controlPlaneLoadBalancer.loadBalancerFullName
        },
        statistic: 'Average',
        period: cdk.Duration.seconds(300)
      }),
      threshold: 5,
      evaluationPeriods: 3,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING
    }));

    // === Worker Node Alarms ===

    // Worker ASG capacity issues
    alarms.push(new cloudwatch.Alarm(this, 'WorkerCapacityAlarm', {
      alarmName: `${props.clusterName}-worker-capacity-issue`,
      alarmDescription: 'Worker Auto Scaling Group has capacity issues',
      metric: new cloudwatch.Metric({
        namespace: 'AWS/AutoScaling',
        metricName: 'GroupDesiredCapacity',
        dimensionsMap: {
          AutoScalingGroupName: props.workerAutoScalingGroup.autoScalingGroupName
        },
        statistic: 'Average',
        period: cdk.Duration.seconds(300)
      }),
      threshold: 0,
      evaluationPeriods: 2,
      comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.BREACHING
    }));

    // === Lambda Function Alarms ===

    // etcd lifecycle Lambda errors
    alarms.push(new cloudwatch.Alarm(this, 'EtcdLifecycleLambdaErrorsAlarm', {
      alarmName: `${props.clusterName}-etcd-lifecycle-lambda-errors`,
      alarmDescription: 'etcd lifecycle Lambda function has errors',
      metric: props.etcdLifecycleLambda.metricErrors({
        statistic: 'Sum',
        period: cdk.Duration.seconds(300)
      }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING
    }));

    // etcd backup Lambda errors
    alarms.push(new cloudwatch.Alarm(this, 'EtcdBackupLambdaErrorsAlarm', {
      alarmName: `${props.clusterName}-etcd-backup-lambda-errors`,
      alarmDescription: 'etcd backup Lambda function has errors',
      metric: props.etcdBackupLambda.metricErrors({
        statistic: 'Sum',
        period: cdk.Duration.seconds(300)
      }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING
    }));

    // Cluster health Lambda errors
    alarms.push(new cloudwatch.Alarm(this, 'ClusterHealthLambdaErrorsAlarm', {
      alarmName: `${props.clusterName}-health-check-lambda-errors`,
      alarmDescription: 'Cluster health check Lambda function has errors',
      metric: props.clusterHealthLambda.metricErrors({
        statistic: 'Sum',
        period: cdk.Duration.seconds(300)
      }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING
    }));

    // etcd lifecycle Lambda duration (timeout warning)
    alarms.push(new cloudwatch.Alarm(this, 'EtcdLifecycleLambdaDurationAlarm', {
      alarmName: `${props.clusterName}-etcd-lifecycle-lambda-duration`,
      alarmDescription: 'etcd lifecycle Lambda function duration is high',
      metric: props.etcdLifecycleLambda.metricDuration({
        statistic: 'Average',
        period: cdk.Duration.seconds(300)
      }),
      threshold: 480000, // 480 seconds (80% of 10 min timeout)
      evaluationPeriods: 3,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING
    }));

    // === DynamoDB Alarms ===

    // Bootstrap lock table throttling
    alarms.push(new cloudwatch.Alarm(this, 'BootstrapLockThrottledAlarm', {
      alarmName: `${props.clusterName}-bootstrap-lock-throttled`,
      alarmDescription: 'Bootstrap lock DynamoDB table is being throttled',
      metric: new cloudwatch.Metric({
        namespace: 'AWS/DynamoDB',
        metricName: 'ThrottledRequests',
        dimensionsMap: {
          TableName: props.bootstrapLockTable.tableName
        },
        statistic: 'Sum',
        period: cdk.Duration.seconds(300)
      }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING
    }));

    // etcd members table throttling
    alarms.push(new cloudwatch.Alarm(this, 'EtcdMembersThrottledAlarm', {
      alarmName: `${props.clusterName}-etcd-members-throttled`,
      alarmDescription: 'etcd members DynamoDB table is being throttled',
      metric: new cloudwatch.Metric({
        namespace: 'AWS/DynamoDB',
        metricName: 'ThrottledRequests',
        dimensionsMap: {
          TableName: props.etcdMemberTable.tableName
        },
        statistic: 'Sum',
        period: cdk.Duration.seconds(300)
      }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING
    }));

    return alarms;
  }

  private createDashboard(props: MonitoringStackProps, alarms: cloudwatch.Alarm[]): cloudwatch.Dashboard {
    const dashboard = new cloudwatch.Dashboard(this, 'ClusterDashboard', {
      dashboardName: `${props.clusterName}-overview`
    });

    // Row 1: Alarm Status
    dashboard.addWidgets(
      new cloudwatch.AlarmStatusWidget({
        title: 'Cluster Alarm Status',
        alarms: alarms,
        width: 24,
        height: 4
      })
    );

    // Row 2: Control Plane Health
    dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'Control Plane - Healthy Hosts',
        left: [
          new cloudwatch.Metric({
            namespace: 'AWS/NetworkELB',
            metricName: 'HealthyHostCount',
            dimensionsMap: {
              TargetGroup: props.controlPlaneTargetGroup.targetGroupFullName,
              LoadBalancer: props.controlPlaneLoadBalancer.loadBalancerFullName
            },
            statistic: 'Average',
            period: cdk.Duration.seconds(60)
          }),
          new cloudwatch.Metric({
            namespace: 'AWS/NetworkELB',
            metricName: 'UnHealthyHostCount',
            dimensionsMap: {
              TargetGroup: props.controlPlaneTargetGroup.targetGroupFullName,
              LoadBalancer: props.controlPlaneLoadBalancer.loadBalancerFullName
            },
            statistic: 'Average',
            period: cdk.Duration.seconds(60)
          })
        ],
        width: 8,
        height: 6
      }),
      new cloudwatch.GraphWidget({
        title: 'API Server Response Time',
        left: [
          new cloudwatch.Metric({
            namespace: 'AWS/NetworkELB',
            metricName: 'TargetResponseTime',
            dimensionsMap: {
              TargetGroup: props.controlPlaneTargetGroup.targetGroupFullName,
              LoadBalancer: props.controlPlaneLoadBalancer.loadBalancerFullName
            },
            statistic: 'Average',
            period: cdk.Duration.seconds(60)
          })
        ],
        width: 8,
        height: 6
      }),
      new cloudwatch.GraphWidget({
        title: 'Control Plane ASG Capacity',
        left: [
          new cloudwatch.Metric({
            namespace: 'AWS/AutoScaling',
            metricName: 'GroupDesiredCapacity',
            dimensionsMap: {
              AutoScalingGroupName: props.controlPlaneAutoScalingGroup.autoScalingGroupName
            },
            statistic: 'Average',
            period: cdk.Duration.seconds(60)
          }),
          new cloudwatch.Metric({
            namespace: 'AWS/AutoScaling',
            metricName: 'GroupInServiceInstances',
            dimensionsMap: {
              AutoScalingGroupName: props.controlPlaneAutoScalingGroup.autoScalingGroupName
            },
            statistic: 'Average',
            period: cdk.Duration.seconds(60)
          })
        ],
        width: 8,
        height: 6
      })
    );

    // Row 3: Worker Nodes
    dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'Worker ASG Capacity',
        left: [
          new cloudwatch.Metric({
            namespace: 'AWS/AutoScaling',
            metricName: 'GroupDesiredCapacity',
            dimensionsMap: {
              AutoScalingGroupName: props.workerAutoScalingGroup.autoScalingGroupName
            },
            statistic: 'Average',
            period: cdk.Duration.seconds(60)
          }),
          new cloudwatch.Metric({
            namespace: 'AWS/AutoScaling',
            metricName: 'GroupInServiceInstances',
            dimensionsMap: {
              AutoScalingGroupName: props.workerAutoScalingGroup.autoScalingGroupName
            },
            statistic: 'Average',
            period: cdk.Duration.seconds(60)
          }),
          new cloudwatch.Metric({
            namespace: 'AWS/AutoScaling',
            metricName: 'GroupPendingInstances',
            dimensionsMap: {
              AutoScalingGroupName: props.workerAutoScalingGroup.autoScalingGroupName
            },
            statistic: 'Average',
            period: cdk.Duration.seconds(60)
          })
        ],
        width: 12,
        height: 6
      }),
      new cloudwatch.GraphWidget({
        title: 'Worker ASG Activities',
        left: [
          new cloudwatch.Metric({
            namespace: 'AWS/AutoScaling',
            metricName: 'GroupTerminatingInstances',
            dimensionsMap: {
              AutoScalingGroupName: props.workerAutoScalingGroup.autoScalingGroupName
            },
            statistic: 'Average',
            period: cdk.Duration.seconds(60)
          })
        ],
        width: 12,
        height: 6
      })
    );

    // Row 4: Lambda Functions
    dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'Lambda Invocations',
        left: [
          props.etcdLifecycleLambda.metricInvocations({ period: cdk.Duration.seconds(300) }),
          props.etcdBackupLambda.metricInvocations({ period: cdk.Duration.seconds(300) }),
          props.clusterHealthLambda.metricInvocations({ period: cdk.Duration.seconds(300) })
        ],
        width: 8,
        height: 6
      }),
      new cloudwatch.GraphWidget({
        title: 'Lambda Errors',
        left: [
          props.etcdLifecycleLambda.metricErrors({ period: cdk.Duration.seconds(300) }),
          props.etcdBackupLambda.metricErrors({ period: cdk.Duration.seconds(300) }),
          props.clusterHealthLambda.metricErrors({ period: cdk.Duration.seconds(300) })
        ],
        width: 8,
        height: 6
      }),
      new cloudwatch.GraphWidget({
        title: 'Lambda Duration',
        left: [
          props.etcdLifecycleLambda.metricDuration({ period: cdk.Duration.seconds(300) }),
          props.etcdBackupLambda.metricDuration({ period: cdk.Duration.seconds(300) }),
          props.clusterHealthLambda.metricDuration({ period: cdk.Duration.seconds(300) })
        ],
        width: 8,
        height: 6
      })
    );

    // Row 5: Custom Metrics (from Phase 10)
    dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'Bootstrap Operations',
        left: [
          new cloudwatch.Metric({
            namespace: `K8sCluster/${props.clusterName}`,
            metricName: 'BootstrapSuccess',
            dimensionsMap: { ClusterName: props.clusterName },
            statistic: 'Sum',
            period: cdk.Duration.hours(1)
          }),
          new cloudwatch.Metric({
            namespace: `K8sCluster/${props.clusterName}`,
            metricName: 'BootstrapFailure',
            dimensionsMap: { ClusterName: props.clusterName },
            statistic: 'Sum',
            period: cdk.Duration.hours(1)
          })
        ],
        width: 8,
        height: 6
      }),
      new cloudwatch.GraphWidget({
        title: 'etcd Operations',
        left: [
          new cloudwatch.Metric({
            namespace: 'K8sCluster/EtcdLifecycle',
            metricName: 'EtcdMemberRemovalSuccess',
            dimensionsMap: { ClusterName: props.clusterName },
            statistic: 'Sum',
            period: cdk.Duration.hours(1)
          }),
          new cloudwatch.Metric({
            namespace: 'K8sCluster/EtcdLifecycle',
            metricName: 'EtcdMemberRemovalFailure',
            dimensionsMap: { ClusterName: props.clusterName },
            statistic: 'Sum',
            period: cdk.Duration.hours(1)
          }),
          new cloudwatch.Metric({
            namespace: 'K8sCluster/EtcdBackup',
            metricName: 'BackupSuccess',
            dimensionsMap: { ClusterName: props.clusterName },
            statistic: 'Sum',
            period: cdk.Duration.hours(6)
          })
        ],
        width: 8,
        height: 6
      }),
      new cloudwatch.GraphWidget({
        title: 'Cluster Health Metrics',
        left: [
          new cloudwatch.Metric({
            namespace: 'K8sCluster/Health',
            metricName: 'HealthyControlPlaneInstances',
            dimensionsMap: { ClusterName: props.clusterName },
            statistic: 'Average',
            period: cdk.Duration.minutes(5)
          }),
          new cloudwatch.Metric({
            namespace: 'K8sCluster/Health',
            metricName: 'AutoRecoveryTriggered',
            dimensionsMap: { ClusterName: props.clusterName },
            statistic: 'Sum',
            period: cdk.Duration.hours(1)
          })
        ],
        width: 8,
        height: 6
      })
    );

    // Row 6: Operation Durations
    dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'Bootstrap Duration',
        left: [
          new cloudwatch.Metric({
            namespace: `K8sCluster/${props.clusterName}`,
            metricName: 'BootstrapDuration',
            dimensionsMap: { ClusterName: props.clusterName },
            statistic: 'Average',
            period: cdk.Duration.hours(1)
          })
        ],
        width: 8,
        height: 6
      }),
      new cloudwatch.GraphWidget({
        title: 'etcd Backup Size',
        left: [
          new cloudwatch.Metric({
            namespace: 'K8sCluster/EtcdBackup',
            metricName: 'BackupSizeBytes',
            dimensionsMap: { ClusterName: props.clusterName },
            statistic: 'Average',
            period: cdk.Duration.hours(6)
          })
        ],
        width: 8,
        height: 6
      }),
      new cloudwatch.GraphWidget({
        title: 'Lambda Durations (Custom)',
        left: [
          new cloudwatch.Metric({
            namespace: 'K8sCluster/EtcdLifecycle',
            metricName: 'LifecycleHandlerDuration',
            dimensionsMap: { ClusterName: props.clusterName },
            statistic: 'Average',
            period: cdk.Duration.hours(1)
          }),
          new cloudwatch.Metric({
            namespace: 'K8sCluster/EtcdBackup',
            metricName: 'BackupDuration',
            dimensionsMap: { ClusterName: props.clusterName },
            statistic: 'Average',
            period: cdk.Duration.hours(6)
          })
        ],
        width: 8,
        height: 6
      })
    );

    // Row 7: DynamoDB
    dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'DynamoDB Read/Write Capacity',
        left: [
          new cloudwatch.Metric({
            namespace: 'AWS/DynamoDB',
            metricName: 'ConsumedReadCapacityUnits',
            dimensionsMap: { TableName: props.bootstrapLockTable.tableName },
            statistic: 'Sum',
            period: cdk.Duration.seconds(300)
          }),
          new cloudwatch.Metric({
            namespace: 'AWS/DynamoDB',
            metricName: 'ConsumedWriteCapacityUnits',
            dimensionsMap: { TableName: props.bootstrapLockTable.tableName },
            statistic: 'Sum',
            period: cdk.Duration.seconds(300)
          }),
          new cloudwatch.Metric({
            namespace: 'AWS/DynamoDB',
            metricName: 'ConsumedReadCapacityUnits',
            dimensionsMap: { TableName: props.etcdMemberTable.tableName },
            statistic: 'Sum',
            period: cdk.Duration.seconds(300)
          }),
          new cloudwatch.Metric({
            namespace: 'AWS/DynamoDB',
            metricName: 'ConsumedWriteCapacityUnits',
            dimensionsMap: { TableName: props.etcdMemberTable.tableName },
            statistic: 'Sum',
            period: cdk.Duration.seconds(300)
          })
        ],
        width: 12,
        height: 6
      }),
      new cloudwatch.GraphWidget({
        title: 'DynamoDB Throttled Requests',
        left: [
          new cloudwatch.Metric({
            namespace: 'AWS/DynamoDB',
            metricName: 'ThrottledRequests',
            dimensionsMap: { TableName: props.bootstrapLockTable.tableName },
            statistic: 'Sum',
            period: cdk.Duration.seconds(300)
          }),
          new cloudwatch.Metric({
            namespace: 'AWS/DynamoDB',
            metricName: 'ThrottledRequests',
            dimensionsMap: { TableName: props.etcdMemberTable.tableName },
            statistic: 'Sum',
            period: cdk.Duration.seconds(300)
          })
        ],
        width: 12,
        height: 6
      })
    );

    return dashboard;
  }
}
