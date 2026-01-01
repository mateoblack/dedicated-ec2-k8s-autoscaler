import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { K8sClusterStack } from '../lib/k8s-cluster-stack';

describe('Cluster Health Lambda', () => {
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

  // Helper to get Lambda function code
  function getLambdaCode(functionNamePattern: string): string {
    const resources = templateJson.Resources;
    for (const key of Object.keys(resources)) {
      const resource = resources[key];
      if (resource.Type === 'AWS::Lambda::Function') {
        const name = resource.Properties?.FunctionName;
        if (name && name.includes(functionNamePattern)) {
          const code = resource.Properties?.Code?.ZipFile;
          return code || '';
        }
      }
    }
    return '';
  }

  describe('Lambda Function Configuration', () => {
    test('cluster health Lambda function exists with correct name', () => {
      template.hasResourceProperties('AWS::Lambda::Function', {
        FunctionName: 'test-cluster-cluster-health'
      });
    });

    test('Lambda uses Python 3.11 runtime', () => {
      template.hasResourceProperties('AWS::Lambda::Function', {
        FunctionName: 'test-cluster-cluster-health',
        Runtime: 'python3.11'
      });
    });

    test('Lambda has 2-minute timeout for health checks', () => {
      template.hasResourceProperties('AWS::Lambda::Function', {
        FunctionName: 'test-cluster-cluster-health',
        Timeout: 120
      });
    });

    test('Lambda has CLUSTER_NAME environment variable', () => {
      template.hasResourceProperties('AWS::Lambda::Function', {
        FunctionName: 'test-cluster-cluster-health',
        Environment: {
          Variables: Match.objectLike({
            CLUSTER_NAME: 'test-cluster'
          })
        }
      });
    });

    test('Lambda has CONTROL_PLANE_ASG_NAME environment variable', () => {
      template.hasResourceProperties('AWS::Lambda::Function', {
        FunctionName: 'test-cluster-cluster-health',
        Environment: {
          Variables: Match.objectLike({
            CONTROL_PLANE_ASG_NAME: 'test-cluster-control-plane'
          })
        }
      });
    });

    test('Lambda has UNHEALTHY_THRESHOLD environment variable set to 3', () => {
      template.hasResourceProperties('AWS::Lambda::Function', {
        FunctionName: 'test-cluster-cluster-health',
        Environment: {
          Variables: Match.objectLike({
            UNHEALTHY_THRESHOLD: '3'
          })
        }
      });
    });

    test('Lambda has BACKUP_BUCKET environment variable', () => {
      const resources = templateJson.Resources;
      let found = false;
      for (const key of Object.keys(resources)) {
        const resource = resources[key];
        if (resource.Type === 'AWS::Lambda::Function' &&
            resource.Properties?.FunctionName === 'test-cluster-cluster-health') {
          const env = resource.Properties?.Environment?.Variables;
          if (env && env.BACKUP_BUCKET) {
            found = true;
          }
        }
      }
      expect(found).toBe(true);
    });
  });

  describe('Lambda IAM Permissions', () => {
    test('Lambda role can describe Auto Scaling Groups', () => {
      template.hasResourceProperties('AWS::IAM::Policy', {
        PolicyDocument: {
          Statement: Match.arrayWith([
            Match.objectLike({
              Action: Match.arrayWith(['autoscaling:DescribeAutoScalingGroups']),
              Effect: 'Allow'
            })
          ])
        }
      });
    });

    test('Lambda role can describe EC2 instances', () => {
      template.hasResourceProperties('AWS::IAM::Policy', {
        PolicyDocument: {
          Statement: Match.arrayWith([
            Match.objectLike({
              Action: Match.arrayWith(['ec2:DescribeInstances']),
              Effect: 'Allow'
            })
          ])
        }
      });
    });

    test('Lambda role can read SSM parameters for failure count', () => {
      template.hasResourceProperties('AWS::IAM::Policy', {
        PolicyDocument: {
          Statement: Match.arrayWith([
            Match.objectLike({
              Action: Match.arrayWith(['ssm:GetParameter']),
              Effect: 'Allow',
              Resource: Match.stringLikeRegexp('arn:aws:ssm:.*:parameter/test-cluster/.*')
            })
          ])
        }
      });
    });

    test('Lambda role can write SSM parameters for restore mode', () => {
      template.hasResourceProperties('AWS::IAM::Policy', {
        PolicyDocument: {
          Statement: Match.arrayWith([
            Match.objectLike({
              Action: Match.arrayWith(['ssm:PutParameter']),
              Effect: 'Allow',
              Resource: Match.stringLikeRegexp('arn:aws:ssm:.*:parameter/test-cluster/.*')
            })
          ])
        }
      });
    });

    test('Lambda role can list S3 backup bucket', () => {
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

    test('Lambda role can read S3 backup objects', () => {
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

    test('Lambda role has KMS decrypt permission for encrypted backups', () => {
      template.hasResourceProperties('AWS::IAM::Policy', {
        PolicyDocument: {
          Statement: Match.arrayWith([
            Match.objectLike({
              Action: Match.arrayWith(['kms:Decrypt']),
              Effect: 'Allow'
            })
          ])
        }
      });
    });

    test('Lambda role can read from etcd-members DynamoDB table', () => {
      // The health Lambda needs to read etcd member information for cluster state
      const resources = templateJson.Resources;
      let foundDynamoDBReadPolicy = false;

      for (const key of Object.keys(resources)) {
        const resource = resources[key];
        if (resource.Type === 'AWS::IAM::Policy' && key.includes('ClusterHealth')) {
          const statements = resource.Properties?.PolicyDocument?.Statement || [];
          for (const stmt of statements) {
            const actions = stmt.Action || [];
            const hasGetItem = actions.includes('dynamodb:GetItem') || actions.includes('dynamodb:Query');
            const resource = JSON.stringify(stmt.Resource || '');
            const referencesEtcdTable = resource.includes('etcd-members') || resource.includes('EtcdMemberTable');

            if (hasGetItem && referencesEtcdTable) {
              foundDynamoDBReadPolicy = true;
            }
          }
        }
      }
      expect(foundDynamoDBReadPolicy).toBe(true);
    });
  });

  describe('Health Check Scheduling', () => {
    test('EventBridge rule exists for health check schedule', () => {
      template.hasResourceProperties('AWS::Events::Rule', {
        Name: 'test-cluster-cluster-health-schedule'
      });
    });

    test('Health check runs every 5 minutes', () => {
      template.hasResourceProperties('AWS::Events::Rule', {
        Name: 'test-cluster-cluster-health-schedule',
        ScheduleExpression: 'rate(5 minutes)'
      });
    });

    test('EventBridge rule targets the health Lambda', () => {
      template.hasResourceProperties('AWS::Events::Rule', {
        Name: 'test-cluster-cluster-health-schedule',
        Targets: Match.arrayWith([
          Match.objectLike({
            Arn: Match.objectLike({
              'Fn::GetAtt': Match.arrayWith([Match.stringLikeRegexp('.*ClusterHealthLambda.*')])
            })
          })
        ])
      });
    });
  });

  describe('Health Check Logic', () => {
    test('Lambda checks for healthy instances in ASG', () => {
      const code = getLambdaCode('cluster-health');
      expect(code).toContain('get_healthy_instance_count');
      expect(code).toContain('describe_auto_scaling_groups');
    });

    test('Lambda filters for InService instances', () => {
      const code = getLambdaCode('cluster-health');
      expect(code).toContain("LifecycleState");
      expect(code).toContain("InService");
    });

    test('Lambda verifies instances are actually running', () => {
      const code = getLambdaCode('cluster-health');
      expect(code).toContain('describe_instances');
      expect(code).toContain("'running'");
    });

    test('Lambda tracks consecutive failure count', () => {
      const code = getLambdaCode('cluster-health');
      expect(code).toContain('get_failure_count');
      expect(code).toContain('set_failure_count');
      expect(code).toContain('failure_count');
    });

    test('Lambda stores failure count in SSM parameter', () => {
      const code = getLambdaCode('cluster-health');
      expect(code).toContain('/health/failure-count');
    });

    test('Lambda resets failure count when cluster is healthy', () => {
      const code = getLambdaCode('cluster-health');
      expect(code).toContain('Cluster recovered');
      expect(code).toContain('set_failure_count(cluster_name, region, 0)');
    });

    test('Lambda returns healthy status with instance count', () => {
      const code = getLambdaCode('cluster-health');
      expect(code).toContain("'statusCode': 200");
      expect(code).toContain('Healthy');
    });
  });

  describe('Restore Trigger Conditions', () => {
    test('Lambda uses configurable UNHEALTHY_THRESHOLD', () => {
      const code = getLambdaCode('cluster-health');
      expect(code).toContain('UNHEALTHY_THRESHOLD');
      expect(code).toContain("int(os.environ.get('UNHEALTHY_THRESHOLD'");
    });

    test('Lambda triggers restore when failure count reaches threshold', () => {
      const code = getLambdaCode('cluster-health');
      expect(code).toContain('if failure_count >= threshold');
      expect(code).toContain('TRIGGERING AUTO-RECOVERY');
    });

    test('Lambda checks for available backup before triggering restore', () => {
      const code = getLambdaCode('cluster-health');
      expect(code).toContain('get_latest_backup');
      expect(code).toContain('if latest_backup');
    });

    test('Lambda finds latest backup from S3 by LastModified', () => {
      const code = getLambdaCode('cluster-health');
      expect(code).toContain('list_objects_v2');
      expect(code).toContain('LastModified');
      expect(code).toContain('reverse=True');
    });

    test('Lambda sets restore-mode SSM parameter when triggering', () => {
      const code = getLambdaCode('cluster-health');
      expect(code).toContain('trigger_restore_mode');
      expect(code).toContain('/cluster/restore-mode');
      expect(code).toContain("Value='true'");
    });

    test('Lambda stores backup key in SSM for restore', () => {
      const code = getLambdaCode('cluster-health');
      expect(code).toContain('/cluster/restore-backup');
      expect(code).toContain('Value=backup_key');
    });

    test('Lambda records restore trigger timestamp', () => {
      const code = getLambdaCode('cluster-health');
      expect(code).toContain('/cluster/restore-triggered-at');
      expect(code).toContain('datetime.utcnow().isoformat()');
    });

    test('Lambda marks cluster as NOT initialized to enable restore', () => {
      const code = getLambdaCode('cluster-health');
      expect(code).toContain('/cluster/initialized');
      expect(code).toContain("Value='false'");
    });

    test('Lambda handles case when no backup is available', () => {
      const code = getLambdaCode('cluster-health');
      expect(code).toContain('No backup available for restore');
      expect(code).toContain("'statusCode': 500");
    });

    test('Lambda logs failure count progression', () => {
      const code = getLambdaCode('cluster-health');
      expect(code).toContain('No healthy instances! Failure count:');
      expect(code).toContain('/{threshold}');
    });
  });

  describe('Recovery Logic', () => {
    test('Lambda clears restore mode when cluster recovers', () => {
      const code = getLambdaCode('cluster-health');
      expect(code).toContain('clear_restore_mode');
    });

    test('Lambda checks if restore mode is currently set before clearing', () => {
      const code = getLambdaCode('cluster-health');
      expect(code).toContain("get_parameter(Name=f'/{cluster_name}/cluster/restore-mode')");
      expect(code).toContain("!= 'true'");
    });

    test('Lambda resets failure count on recovery', () => {
      const code = getLambdaCode('cluster-health');
      expect(code).toContain('resetting failure count');
      expect(code).toContain('Restore mode cleared - cluster recovered');
    });
  });

  describe('Error Handling', () => {
    test('Lambda handles ASG describe errors gracefully', () => {
      const code = getLambdaCode('cluster-health');
      expect(code).toContain('Error getting instance count');
      expect(code).toContain('return 0');
    });

    test('Lambda handles SSM parameter not found', () => {
      const code = getLambdaCode('cluster-health');
      expect(code).toContain('ParameterNotFound');
    });

    test('Lambda handles S3 listing errors', () => {
      const code = getLambdaCode('cluster-health');
      expect(code).toContain('Error listing backups');
      expect(code).toContain('return None');
    });

    test('Lambda handles restore trigger errors', () => {
      const code = getLambdaCode('cluster-health');
      expect(code).toContain('Error triggering restore mode');
    });

    test('Lambda returns error status on exception', () => {
      const code = getLambdaCode('cluster-health');
      expect(code).toContain('Health check error');
      expect(code).toContain("'statusCode': 500");
    });
  });

  describe('Safeguards', () => {
    test('requires 3 consecutive failures before triggering restore (default threshold)', () => {
      template.hasResourceProperties('AWS::Lambda::Function', {
        FunctionName: 'test-cluster-cluster-health',
        Environment: {
          Variables: Match.objectLike({
            UNHEALTHY_THRESHOLD: '3'
          })
        }
      });
    });

    test('Lambda only triggers restore when exactly 0 healthy instances', () => {
      const code = getLambdaCode('cluster-health');
      expect(code).toContain('if healthy_count == 0');
    });

    test('Lambda requires backup to exist before triggering restore', () => {
      const code = getLambdaCode('cluster-health');
      expect(code).toContain('if latest_backup');
      expect(code).toContain('else:');
      expect(code).toContain('No backup available');
    });
  });
});
