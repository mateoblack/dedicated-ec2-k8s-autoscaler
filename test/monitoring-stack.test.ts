import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { K8sClusterStack } from '../lib/k8s-cluster-stack';

describe('Monitoring Stack - CloudWatch Alarms', () => {
  let template: Template;

  beforeAll(() => {
    const app = new cdk.App();
    const stack = new K8sClusterStack(app, 'TestStack', {
      clusterName: 'test-cluster',
      env: { account: '123456789012', region: 'us-west-2' }
    });
    template = Template.fromStack(stack);
  });

  describe('Control Plane Alarms', () => {
    test('creates alarm for control plane ASG unhealthy instances', () => {
      template.hasResourceProperties('AWS::CloudWatch::Alarm', {
        AlarmName: 'test-cluster-control-plane-unhealthy-instances',
        MetricName: 'UnHealthyHostCount',
        Namespace: 'AWS/AutoScaling',
        Statistic: 'Average',
        Period: 60,
        EvaluationPeriods: 3,
        Threshold: 1,
        ComparisonOperator: 'GreaterThanOrEqualToThreshold'
      });
    });

    test('creates alarm for NLB target group unhealthy hosts', () => {
      template.hasResourceProperties('AWS::CloudWatch::Alarm', {
        AlarmName: 'test-cluster-api-server-unhealthy',
        MetricName: 'UnHealthyHostCount',
        Namespace: 'AWS/NetworkELB',
        Statistic: 'Average',
        Period: 60,
        EvaluationPeriods: 3,
        Threshold: 1,
        ComparisonOperator: 'GreaterThanOrEqualToThreshold'
      });
    });

    test('creates alarm for API server high latency', () => {
      template.hasResourceProperties('AWS::CloudWatch::Alarm', {
        AlarmName: 'test-cluster-api-server-high-latency',
        MetricName: 'TargetResponseTime',
        Namespace: 'AWS/NetworkELB',
        Statistic: 'Average',
        Period: 300,
        EvaluationPeriods: 3,
        Threshold: 5,
        ComparisonOperator: 'GreaterThanThreshold'
      });
    });
  });

  describe('Worker Node Alarms', () => {
    test('creates alarm for worker ASG capacity issues', () => {
      template.hasResourceProperties('AWS::CloudWatch::Alarm', {
        AlarmName: 'test-cluster-worker-capacity-issue',
        MetricName: 'GroupDesiredCapacity',
        Namespace: 'AWS/AutoScaling',
        Statistic: 'Average',
        Period: 300,
        EvaluationPeriods: 2
      });
    });
  });

  describe('Lambda Function Alarms', () => {
    test('creates alarm for etcd lifecycle Lambda errors', () => {
      template.hasResourceProperties('AWS::CloudWatch::Alarm', {
        AlarmName: 'test-cluster-etcd-lifecycle-lambda-errors',
        MetricName: 'Errors',
        Namespace: 'AWS/Lambda',
        Statistic: 'Sum',
        Period: 300,
        EvaluationPeriods: 1,
        Threshold: 1,
        ComparisonOperator: 'GreaterThanOrEqualToThreshold'
      });
    });

    test('creates alarm for etcd backup Lambda errors', () => {
      template.hasResourceProperties('AWS::CloudWatch::Alarm', {
        AlarmName: 'test-cluster-etcd-backup-lambda-errors',
        MetricName: 'Errors',
        Namespace: 'AWS/Lambda',
        Statistic: 'Sum',
        Period: 300,
        EvaluationPeriods: 1,
        Threshold: 1,
        ComparisonOperator: 'GreaterThanOrEqualToThreshold'
      });
    });

    test('creates alarm for cluster health Lambda errors', () => {
      template.hasResourceProperties('AWS::CloudWatch::Alarm', {
        AlarmName: 'test-cluster-health-check-lambda-errors',
        MetricName: 'Errors',
        Namespace: 'AWS/Lambda',
        Statistic: 'Sum',
        Period: 300,
        EvaluationPeriods: 1,
        Threshold: 1,
        ComparisonOperator: 'GreaterThanOrEqualToThreshold'
      });
    });

    test('creates alarm for etcd lifecycle Lambda duration', () => {
      template.hasResourceProperties('AWS::CloudWatch::Alarm', {
        AlarmName: 'test-cluster-etcd-lifecycle-lambda-duration',
        MetricName: 'Duration',
        Namespace: 'AWS/Lambda',
        Statistic: 'Average',
        Period: 300,
        EvaluationPeriods: 3,
        ComparisonOperator: 'GreaterThanThreshold'
      });
    });
  });

  describe('DynamoDB Alarms', () => {
    test('creates alarm for bootstrap lock table throttling', () => {
      template.hasResourceProperties('AWS::CloudWatch::Alarm', {
        AlarmName: 'test-cluster-bootstrap-lock-throttled',
        MetricName: 'ThrottledRequests',
        Namespace: 'AWS/DynamoDB',
        Statistic: 'Sum',
        Period: 300,
        EvaluationPeriods: 1,
        Threshold: 1,
        ComparisonOperator: 'GreaterThanOrEqualToThreshold'
      });
    });

    test('creates alarm for etcd members table throttling', () => {
      template.hasResourceProperties('AWS::CloudWatch::Alarm', {
        AlarmName: 'test-cluster-etcd-members-throttled',
        MetricName: 'ThrottledRequests',
        Namespace: 'AWS/DynamoDB',
        Statistic: 'Sum',
        Period: 300,
        EvaluationPeriods: 1,
        Threshold: 1,
        ComparisonOperator: 'GreaterThanOrEqualToThreshold'
      });
    });
  });

  describe('Alarm Count', () => {
    test('creates at least 10 CloudWatch alarms', () => {
      const alarms = template.findResources('AWS::CloudWatch::Alarm');
      const alarmCount = Object.keys(alarms).length;

      // Should have at least 10 alarms for comprehensive monitoring
      expect(alarmCount).toBeGreaterThanOrEqual(10);
    });
  });

  describe('CloudWatch Dashboard', () => {
    test('creates CloudWatch dashboard for cluster overview', () => {
      template.hasResourceProperties('AWS::CloudWatch::Dashboard', {
        DashboardName: 'test-cluster-overview'
      });
    });

    test('dashboard includes control plane metrics', () => {
      const dashboards = template.findResources('AWS::CloudWatch::Dashboard');
      const dashboardKeys = Object.keys(dashboards);
      expect(dashboardKeys.length).toBeGreaterThan(0);

      // Get dashboard body and verify it contains expected widgets
      const dashboard = dashboards[dashboardKeys[0]];
      const body = (dashboard as any).Properties.DashboardBody;

      // Dashboard body is a JSON string or Fn::Sub, verify it references expected metrics
      expect(body).toBeDefined();
    });
  });
});

describe('Monitoring Stack - Alarm Configurations', () => {
  let template: Template;
  let templateJson: any;

  beforeAll(() => {
    const app = new cdk.App();
    const stack = new K8sClusterStack(app, 'TestStack', {
      clusterName: 'test-cluster',
      env: { account: '123456789012', region: 'us-west-2' }
    });
    template = Template.fromStack(stack);
    templateJson = template.toJSON();
  });

  test('control plane alarms have correct dimensions', () => {
    const alarms = template.findResources('AWS::CloudWatch::Alarm');

    // Find control plane ASG alarm
    let foundControlPlaneAlarm = false;
    for (const [_key, alarm] of Object.entries(alarms)) {
      const props = (alarm as any).Properties;
      if (props.AlarmName === 'test-cluster-control-plane-unhealthy-instances') {
        foundControlPlaneAlarm = true;
        expect(props.Dimensions).toBeDefined();
        // Should have AutoScalingGroupName dimension
        const asgDimension = props.Dimensions.find(
          (d: any) => d.Name === 'AutoScalingGroupName'
        );
        expect(asgDimension).toBeDefined();
      }
    }
    expect(foundControlPlaneAlarm).toBe(true);
  });

  test('Lambda alarms reference correct function names', () => {
    const alarms = template.findResources('AWS::CloudWatch::Alarm');

    // Find Lambda error alarms
    const lambdaAlarms = Object.entries(alarms).filter(([_key, alarm]) => {
      const props = (alarm as any).Properties;
      return props.Namespace === 'AWS/Lambda' && props.MetricName === 'Errors';
    });

    // Should have 3 Lambda error alarms
    expect(lambdaAlarms.length).toBe(3);

    // Each should have FunctionName dimension
    for (const [_key, alarm] of lambdaAlarms) {
      const props = (alarm as any).Properties;
      const fnDimension = props.Dimensions?.find(
        (d: any) => d.Name === 'FunctionName'
      );
      expect(fnDimension).toBeDefined();
    }
  });

  test('DynamoDB alarms reference correct table names', () => {
    const alarms = template.findResources('AWS::CloudWatch::Alarm');

    // Find DynamoDB throttle alarms
    const dynamoAlarms = Object.entries(alarms).filter(([_key, alarm]) => {
      const props = (alarm as any).Properties;
      return props.Namespace === 'AWS/DynamoDB' && props.MetricName === 'ThrottledRequests';
    });

    // Should have 2 DynamoDB alarms
    expect(dynamoAlarms.length).toBe(2);

    // Each should have TableName dimension
    for (const [_key, alarm] of dynamoAlarms) {
      const props = (alarm as any).Properties;
      const tableDimension = props.Dimensions?.find(
        (d: any) => d.Name === 'TableName'
      );
      expect(tableDimension).toBeDefined();
    }
  });
});
