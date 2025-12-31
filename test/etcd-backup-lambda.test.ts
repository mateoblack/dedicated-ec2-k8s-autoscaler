import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { K8sClusterStack } from '../lib/k8s-cluster-stack';

describe('etcd Backup Lambda', () => {
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
    test('etcd backup Lambda function exists with correct name', () => {
      template.hasResourceProperties('AWS::Lambda::Function', {
        FunctionName: 'test-cluster-etcd-backup'
      });
    });

    test('Lambda uses Python 3.11 runtime', () => {
      template.hasResourceProperties('AWS::Lambda::Function', {
        FunctionName: 'test-cluster-etcd-backup',
        Runtime: 'python3.11'
      });
    });

    test('Lambda has 5-minute timeout for long-running backups', () => {
      template.hasResourceProperties('AWS::Lambda::Function', {
        FunctionName: 'test-cluster-etcd-backup',
        Timeout: 300
      });
    });

    test('Lambda has correct environment variables', () => {
      template.hasResourceProperties('AWS::Lambda::Function', {
        FunctionName: 'test-cluster-etcd-backup',
        Environment: {
          Variables: {
            CLUSTER_NAME: 'test-cluster',
            REGION: 'us-west-2',
            CONTROL_PLANE_ASG_NAME: 'test-cluster-control-plane'
          }
        }
      });
    });

    test('Lambda environment has BACKUP_BUCKET variable set', () => {
      // Verify the Lambda has the backup bucket environment variable
      const resources = templateJson.Resources;
      let found = false;
      for (const key of Object.keys(resources)) {
        const resource = resources[key];
        if (resource.Type === 'AWS::Lambda::Function' &&
            resource.Properties?.FunctionName === 'test-cluster-etcd-backup') {
          const env = resource.Properties?.Environment?.Variables;
          if (env && env.BACKUP_BUCKET) {
            found = true;
            expect(env.BACKUP_BUCKET).toBeDefined();
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

    test('Lambda role can send SSM commands', () => {
      template.hasResourceProperties('AWS::IAM::Policy', {
        PolicyDocument: {
          Statement: Match.arrayWith([
            Match.objectLike({
              Action: Match.arrayWith(['ssm:SendCommand', 'ssm:GetCommandInvocation']),
              Effect: 'Allow'
            })
          ])
        }
      });
    });

    test('Lambda role can write to S3 backup bucket', () => {
      // Check that there's a policy with S3 PutObject permission for the backup bucket
      const resources = templateJson.Resources;
      let foundS3PutPolicy = false;

      for (const key of Object.keys(resources)) {
        const resource = resources[key];
        if (resource.Type === 'AWS::IAM::Policy' && key.includes('EtcdBackup')) {
          const statements = resource.Properties?.PolicyDocument?.Statement || [];
          for (const stmt of statements) {
            if (stmt.Action && stmt.Action.includes('s3:PutObject')) {
              foundS3PutPolicy = true;
              // Verify resource references the EtcdBackupBucket
              expect(JSON.stringify(stmt.Resource)).toContain('EtcdBackupBucket');
            }
          }
        }
      }
      expect(foundS3PutPolicy).toBe(true);
    });

    test('Lambda role can read from S3 backup bucket', () => {
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

    test('Lambda role has KMS permissions for encrypted backups', () => {
      template.hasResourceProperties('AWS::IAM::Policy', {
        PolicyDocument: {
          Statement: Match.arrayWith([
            Match.objectLike({
              Action: Match.arrayWith(['kms:Decrypt', 'kms:Encrypt']),
              Effect: 'Allow'
            })
          ])
        }
      });
    });
  });

  describe('Backup Scheduling', () => {
    test('EventBridge rule exists for backup schedule', () => {
      template.hasResourceProperties('AWS::Events::Rule', {
        Name: 'test-cluster-etcd-backup-schedule'
      });
    });

    test('Backup runs every 6 hours', () => {
      template.hasResourceProperties('AWS::Events::Rule', {
        Name: 'test-cluster-etcd-backup-schedule',
        ScheduleExpression: 'rate(6 hours)'
      });
    });

    test('EventBridge rule targets the backup Lambda', () => {
      template.hasResourceProperties('AWS::Events::Rule', {
        Name: 'test-cluster-etcd-backup-schedule',
        Targets: Match.arrayWith([
          Match.objectLike({
            Arn: Match.objectLike({
              'Fn::GetAtt': Match.arrayWith([Match.stringLikeRegexp('.*EtcdBackupLambda.*')])
            })
          })
        ])
      });
    });
  });

  describe('Lambda Code Logic', () => {
    test('Lambda code finds healthy control plane instances from ASG', () => {
      const code = getLambdaCode('etcd-backup');
      expect(code).toContain('get_healthy_control_plane_instances');
      expect(code).toContain('describe_auto_scaling_groups');
    });

    test('Lambda code filters for InService instances', () => {
      const code = getLambdaCode('etcd-backup');
      expect(code).toContain("LifecycleState");
      expect(code).toContain("InService");
    });

    test('Lambda code verifies instances are running', () => {
      const code = getLambdaCode('etcd-backup');
      expect(code).toContain('describe_instances');
      expect(code).toContain("'running'");
    });

    test('Lambda code creates etcd snapshot using etcdctl', () => {
      const code = getLambdaCode('etcd-backup');
      expect(code).toContain('etcdctl snapshot save');
    });

    test('Lambda code verifies snapshot after creation', () => {
      const code = getLambdaCode('etcd-backup');
      expect(code).toContain('etcdctl snapshot status');
    });

    test('Lambda code checks etcd health before backup', () => {
      const code = getLambdaCode('etcd-backup');
      expect(code).toContain('etcdctl endpoint health');
    });

    test('Lambda code uploads backup to S3', () => {
      const code = getLambdaCode('etcd-backup');
      expect(code).toContain('aws s3 cp');
      expect(code).toContain('BACKUP_BUCKET');
    });

    test('Lambda code cleans up temp files after upload', () => {
      const code = getLambdaCode('etcd-backup');
      expect(code).toContain('rm -f');
      expect(code).toContain('SNAPSHOT_FILE');
    });

    test('Lambda code has retry logic with MAX_RETRIES', () => {
      const code = getLambdaCode('etcd-backup');
      expect(code).toContain('MAX_RETRIES');
      expect(code).toContain('for attempt in range');
    });

    test('Lambda code has configurable retry delay', () => {
      const code = getLambdaCode('etcd-backup');
      expect(code).toContain('RETRY_DELAY_SECONDS');
    });

    test('Lambda code has BackupError exception class', () => {
      const code = getLambdaCode('etcd-backup');
      expect(code).toContain('class BackupError');
      expect(code).toContain('is_retriable');
    });

    test('Lambda code handles SSM command timeout', () => {
      const code = getLambdaCode('etcd-backup');
      expect(code).toContain('SSM_COMMAND_TIMEOUT');
      expect(code).toContain('TimedOut');
    });

    test('Lambda code uses proper etcd TLS certificates', () => {
      const code = getLambdaCode('etcd-backup');
      expect(code).toContain('ETCDCTL_CACERT=/etc/kubernetes/pki/etcd/ca.crt');
      expect(code).toContain('ETCDCTL_CERT=/etc/kubernetes/pki/etcd/server.crt');
      expect(code).toContain('ETCDCTL_KEY=/etc/kubernetes/pki/etcd/server.key');
    });

    test('Lambda code generates timestamped backup filenames', () => {
      const code = getLambdaCode('etcd-backup');
      expect(code).toContain('etcd-snapshot-');
      expect(code).toContain('strftime');
    });

    test('Lambda code returns S3 key on success', () => {
      const code = getLambdaCode('etcd-backup');
      expect(code).toContain('BACKUP_SUCCESS');
      expect(code).toContain('return s3_key');
    });

    test('Lambda code logs backup success with key and size', () => {
      const code = getLambdaCode('etcd-backup');
      expect(code).toContain('BACKUP_SUCCESS key=');
      expect(code).toContain('size=');
    });
  });

  describe('Error Handling', () => {
    test('Lambda handles no healthy instances gracefully', () => {
      const code = getLambdaCode('etcd-backup');
      expect(code).toContain('No healthy control plane instances');
      expect(code).toContain("'statusCode': 500");
    });

    test('Lambda handles SSM command failures', () => {
      const code = getLambdaCode('etcd-backup');
      expect(code).toContain('Failed to send SSM command');
    });

    test('Lambda handles backup verification failures', () => {
      const code = getLambdaCode('etcd-backup');
      expect(code).toContain('etcd is not healthy');
    });

    test('Lambda distinguishes retriable vs non-retriable errors', () => {
      const code = getLambdaCode('etcd-backup');
      expect(code).toContain('is_retriable=True');
      expect(code).toContain('is_retriable');
    });
  });
});
