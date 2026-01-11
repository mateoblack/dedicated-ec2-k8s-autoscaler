import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { K8sClusterStack } from '../lib/k8s-cluster-stack';

describe('Before Terminate Lifecycle Hook', () => {
  let template: Template;
  let templateJson: any;
  let lifecycleLambdaCode: string;

  beforeAll(() => {
    const app = new cdk.App();
    const stack = new K8sClusterStack(app, 'TestStack', {
      clusterName: 'test-cluster',
      env: { account: '123456789012', region: 'us-west-2' }
    });
    template = Template.fromStack(stack);
    templateJson = template.toJSON();

    // Extract lifecycle Lambda code
    const resources = templateJson.Resources;
    for (const key of Object.keys(resources)) {
      const resource = resources[key];
      if (resource.Type === 'AWS::Lambda::Function' &&
          resource.Properties?.FunctionName?.includes('etcd-lifecycle')) {
        const code = resource.Properties?.Code?.ZipFile;
        if (code) {
          lifecycleLambdaCode = code;
        }
      }
    }
  });

  describe('Lifecycle Hook Configuration', () => {
    test('lifecycle hook exists for control plane ASG', () => {
      template.hasResourceProperties('AWS::AutoScaling::LifecycleHook', {
        LifecycleHookName: 'test-cluster-etcd-cleanup'
      });
    });

    test('lifecycle hook triggers on INSTANCE_TERMINATING', () => {
      template.hasResourceProperties('AWS::AutoScaling::LifecycleHook', {
        LifecycleTransition: 'autoscaling:EC2_INSTANCE_TERMINATING'
      });
    });

    test('lifecycle hook has heartbeat timeout', () => {
      template.hasResourceProperties('AWS::AutoScaling::LifecycleHook', {
        HeartbeatTimeout: Match.anyValue()
      });
    });

    test('lifecycle hook has default result configured', () => {
      // Default is CONTINUE - Lambda handles ABANDON logic for quorum safety
      template.hasResourceProperties('AWS::AutoScaling::LifecycleHook', {
        DefaultResult: 'CONTINUE'
      });
    });
  });

  describe('Lifecycle Lambda Function', () => {
    test('etcd lifecycle Lambda exists', () => {
      template.hasResourceProperties('AWS::Lambda::Function', {
        FunctionName: 'test-cluster-etcd-lifecycle'
      });
    });

    test('Lambda uses Python runtime', () => {
      template.hasResourceProperties('AWS::Lambda::Function', {
        Runtime: Match.stringLikeRegexp('python.*')
      });
    });

    test('Lambda has appropriate timeout', () => {
      template.hasResourceProperties('AWS::Lambda::Function', {
        Timeout: Match.anyValue()
      });
    });

    test('Lambda has CLUSTER_NAME environment variable', () => {
      template.hasResourceProperties('AWS::Lambda::Function', {
        Environment: {
          Variables: Match.objectLike({
            CLUSTER_NAME: 'test-cluster'
          })
        }
      });
    });

    test('Lambda has ETCD_TABLE_NAME environment variable', () => {
      template.hasResourceProperties('AWS::Lambda::Function', {
        Environment: {
          Variables: Match.objectLike({
            ETCD_TABLE_NAME: Match.anyValue()
          })
        }
      });
    });
  });

  describe('EventBridge Rule', () => {
    test('EventBridge rule exists for lifecycle events', () => {
      template.hasResourceProperties('AWS::Events::Rule', {
        Name: 'test-cluster-etcd-lifecycle-rule'
      });
    });

    test('EventBridge rule targets lifecycle Lambda', () => {
      template.hasResourceProperties('AWS::Events::Rule', {
        Targets: Match.arrayWith([
          Match.objectLike({
            Arn: Match.anyValue()
          })
        ])
      });
    });
  });

  describe('Node Drain Logic', () => {
    test('has drain timeout constant', () => {
      expect(lifecycleLambdaCode).toContain('DRAIN_TIMEOUT');
    });

    test('has NodeDrainError exception class', () => {
      expect(lifecycleLambdaCode).toContain('class NodeDrainError');
    });

    test('NodeDrainError has is_retriable flag', () => {
      expect(lifecycleLambdaCode).toContain('is_retriable');
    });

    test('has drain_node_with_retry function', () => {
      expect(lifecycleLambdaCode).toContain('def drain_node_with_retry');
    });

    test('has drain_node function', () => {
      expect(lifecycleLambdaCode).toContain('def drain_node');
    });

    test('drains node before etcd removal', () => {
      expect(lifecycleLambdaCode).toContain('Draining node');
      expect(lifecycleLambdaCode).toContain('before removal');
    });

    test('continues with etcd removal even if drain fails', () => {
      expect(lifecycleLambdaCode).toContain('drain failed');
      expect(lifecycleLambdaCode).toContain('continuing with etcd removal');
    });
  });

  describe('Kubectl Drain Command', () => {
    test('uses kubectl cordon before drain', () => {
      expect(lifecycleLambdaCode).toContain('kubectl cordon');
    });

    test('uses kubectl drain command', () => {
      expect(lifecycleLambdaCode).toContain('kubectl drain');
    });

    test('drain uses --ignore-daemonsets flag', () => {
      expect(lifecycleLambdaCode).toContain('--ignore-daemonsets');
    });

    test('drain uses --delete-emptydir-data flag', () => {
      expect(lifecycleLambdaCode).toContain('--delete-emptydir-data');
    });

    test('drain uses --force flag', () => {
      expect(lifecycleLambdaCode).toContain('--force');
    });

    test('drain has timeout configured', () => {
      expect(lifecycleLambdaCode).toContain('--timeout');
    });

    test('logs successful drain', () => {
      expect(lifecycleLambdaCode).toContain('Successfully drained node');
    });
  });

  describe('Drain Retry Logic', () => {
    test('has MAX_RETRIES constant', () => {
      expect(lifecycleLambdaCode).toContain('MAX_RETRIES');
    });

    test('has RETRY_DELAY_SECONDS constant', () => {
      expect(lifecycleLambdaCode).toContain('RETRY_DELAY_SECONDS');
    });

    test('logs retry attempts', () => {
      expect(lifecycleLambdaCode).toContain('Attempt');
      expect(lifecycleLambdaCode).toContain('to drain node');
    });

    test('checks if error is retriable', () => {
      expect(lifecycleLambdaCode).toContain('is_retriable');
    });

    test('uses exponential backoff', () => {
      // Shared retry utility documents exponential backoff formula
      expect(lifecycleLambdaCode).toContain('base_delay * (2 ** (attempt - 1))');
    });

    test('logs all retries failed', () => {
      // Shared retry utility logs failures generically
      expect(lifecycleLambdaCode).toContain('attempts failed');
    });
  });

  describe('SSM Drain Command Execution', () => {
    test('executes drain via SSM Run Command', () => {
      expect(lifecycleLambdaCode).toContain('send_command');
      expect(lifecycleLambdaCode).toContain('AWS-RunShellScript');
    });

    test('has wait_for_drain_command function', () => {
      expect(lifecycleLambdaCode).toContain('def wait_for_drain_command');
    });

    test('logs SSM drain command sent', () => {
      expect(lifecycleLambdaCode).toContain('SSM drain command sent');
    });

    test('handles SSM command send failure', () => {
      expect(lifecycleLambdaCode).toContain('Failed to send SSM drain command');
    });

    test('checks if node is already cordoned', () => {
      expect(lifecycleLambdaCode).toContain('Node is cordoned');
    });
  });

  describe('Control Plane Instance Selection for Drain', () => {
    test('finds healthy control plane instances', () => {
      expect(lifecycleLambdaCode).toContain('get_healthy_control_plane_instances');
    });

    test('excludes terminating instance from selection', () => {
      expect(lifecycleLambdaCode).toContain('exclude_instance');
    });

    test('handles no healthy instances for drain', () => {
      expect(lifecycleLambdaCode).toContain('No healthy control plane instances available');
    });

    test('logs target instance for drain execution', () => {
      expect(lifecycleLambdaCode).toContain('Executing kubectl drain on instance');
    });
  });

  describe('etcd Member Removal', () => {
    test('has EtcdRemovalError exception class', () => {
      expect(lifecycleLambdaCode).toContain('class EtcdRemovalError');
    });

    test('has remove_etcd_member_with_retry function', () => {
      expect(lifecycleLambdaCode).toContain('def remove_etcd_member_with_retry');
    });

    test('has remove_etcd_member function', () => {
      expect(lifecycleLambdaCode).toContain('def remove_etcd_member');
    });

    test('uses etcdctl to remove member', () => {
      expect(lifecycleLambdaCode).toContain('etcdctl member remove');
    });

    test('sets ETCDCTL_API to version 3', () => {
      expect(lifecycleLambdaCode).toContain('ETCDCTL_API=3');
    });

    test('configures etcdctl with certificates', () => {
      expect(lifecycleLambdaCode).toContain('ETCDCTL_CACERT');
      expect(lifecycleLambdaCode).toContain('ETCDCTL_CERT');
      expect(lifecycleLambdaCode).toContain('ETCDCTL_KEY');
    });

    test('verifies etcd health before removal', () => {
      expect(lifecycleLambdaCode).toContain('etcdctl endpoint health');
    });

    test('checks if member exists before removal', () => {
      expect(lifecycleLambdaCode).toContain('etcdctl member list');
    });

    test('handles member already removed', () => {
      expect(lifecycleLambdaCode).toContain('may already be removed');
    });

    test('logs successful member removal', () => {
      expect(lifecycleLambdaCode).toContain('Successfully removed member');
    });
  });

  describe('Quorum Safety Check', () => {
    test('has QuorumRiskError exception class', () => {
      expect(lifecycleLambdaCode).toContain('class QuorumRiskError');
    });

    test('has MIN_HEALTHY_NODES_FOR_REMOVAL constant', () => {
      expect(lifecycleLambdaCode).toContain('MIN_HEALTHY_NODES_FOR_REMOVAL');
    });

    test('checks quorum safety before proceeding', () => {
      expect(lifecycleLambdaCode).toContain('check_quorum_safety');
    });

    test('abandons on quorum risk', () => {
      expect(lifecycleLambdaCode).toContain('QuorumRiskError');
      expect(lifecycleLambdaCode).toContain('ABANDON');
    });
  });

  describe('Lifecycle Action Completion', () => {
    test('has complete_lifecycle_action function', () => {
      expect(lifecycleLambdaCode).toContain('def complete_lifecycle_action');
    });

    test('completes with CONTINUE on success', () => {
      expect(lifecycleLambdaCode).toContain("'CONTINUE'");
    });

    test('completes with ABANDON on failure', () => {
      expect(lifecycleLambdaCode).toContain("'ABANDON'");
    });

    test('uses autoscaling complete_lifecycle_action API', () => {
      expect(lifecycleLambdaCode).toContain('complete_lifecycle_action');
    });

    test('logs lifecycle action completion', () => {
      expect(lifecycleLambdaCode).toContain('Completed lifecycle action');
    });

    test('handles lifecycle action completion failure', () => {
      expect(lifecycleLambdaCode).toContain('Failed to complete lifecycle action');
    });

    test('retries without token on failure', () => {
      expect(lifecycleLambdaCode).toContain('without token');
    });
  });

  describe('DynamoDB Member Lookup', () => {
    test('has lookup_etcd_member function', () => {
      expect(lifecycleLambdaCode).toContain('def lookup_etcd_member');
    });

    test('queries DynamoDB by instance ID', () => {
      expect(lifecycleLambdaCode).toContain('InstanceIdIndex');
      expect(lifecycleLambdaCode).toContain('InstanceId');
    });

    test('handles instance not being an etcd member', () => {
      expect(lifecycleLambdaCode).toContain('not a control plane node');
    });

    test('handles missing etcd member ID', () => {
      expect(lifecycleLambdaCode).toContain('no EtcdMemberId');
    });
  });

  describe('DynamoDB Member Status Update', () => {
    test('has update_member_status function', () => {
      expect(lifecycleLambdaCode).toContain('def update_member_status');
    });

    test('updates status to REMOVED on success', () => {
      expect(lifecycleLambdaCode).toContain("'REMOVED'");
    });

    test('updates status to REMOVAL_FAILED on failure', () => {
      expect(lifecycleLambdaCode).toContain("'REMOVAL_FAILED'");
    });
  });

  describe('Instance Info Retrieval', () => {
    test('has get_instance_info function', () => {
      expect(lifecycleLambdaCode).toContain('def get_instance_info');
    });

    test('uses EC2 describe_instances', () => {
      expect(lifecycleLambdaCode).toContain('describe_instances');
    });

    test('handles instance not found', () => {
      expect(lifecycleLambdaCode).toContain('InvalidInstanceID');
    });

    test('retrieves private IP from instance', () => {
      expect(lifecycleLambdaCode).toContain('PrivateIpAddress');
    });
  });

  describe('Event Parsing', () => {
    test('parses lifecycle hook event', () => {
      expect(lifecycleLambdaCode).toContain("event.get('detail'");
    });

    test('extracts EC2InstanceId from event', () => {
      expect(lifecycleLambdaCode).toContain('EC2InstanceId');
    });

    test('extracts LifecycleHookName from event', () => {
      expect(lifecycleLambdaCode).toContain('LifecycleHookName');
    });

    test('extracts AutoScalingGroupName from event', () => {
      expect(lifecycleLambdaCode).toContain('AutoScalingGroupName');
    });

    test('extracts LifecycleActionToken from event', () => {
      expect(lifecycleLambdaCode).toContain('LifecycleActionToken');
    });

    test('handles missing instance ID', () => {
      expect(lifecycleLambdaCode).toContain('No instance ID found');
    });
  });

  describe('Logging', () => {
    test('logs received event', () => {
      expect(lifecycleLambdaCode).toContain('Received event');
    });

    test('logs processing termination', () => {
      expect(lifecycleLambdaCode).toContain('Processing termination for instance');
    });

    test('logs instance not found', () => {
      expect(lifecycleLambdaCode).toContain('may already be terminated');
    });

    test('logs drain attempts', () => {
      expect(lifecycleLambdaCode).toContain('to drain node');
    });

    test('logs etcd removal attempts', () => {
      expect(lifecycleLambdaCode).toContain('to remove etcd member');
    });

    test('logs unexpected errors', () => {
      expect(lifecycleLambdaCode).toContain('Unexpected error');
    });
  });

  describe('Error Handling', () => {
    test('abandons on unexpected errors for safety', () => {
      expect(lifecycleLambdaCode).toContain('Exception');
      expect(lifecycleLambdaCode).toContain('ABANDON');
    });

    test('returns appropriate status codes', () => {
      expect(lifecycleLambdaCode).toContain('statusCode');
      expect(lifecycleLambdaCode).toContain('200');
      expect(lifecycleLambdaCode).toContain('400');
      expect(lifecycleLambdaCode).toContain('500');
    });

    test('returns body with error message', () => {
      expect(lifecycleLambdaCode).toContain("'body'");
    });

    test('abandons on etcd removal failure', () => {
      expect(lifecycleLambdaCode).toContain('etcd removal failed');
      expect(lifecycleLambdaCode).toContain('abandoning termination');
    });
  });

  describe('SSM Command Handling', () => {
    test('has wait_for_ssm_command function', () => {
      expect(lifecycleLambdaCode).toContain('def wait_for_ssm_command');
    });

    test('has SSM_COMMAND_TIMEOUT constant', () => {
      expect(lifecycleLambdaCode).toContain('SSM_COMMAND_TIMEOUT');
    });

    test('polls for command completion', () => {
      expect(lifecycleLambdaCode).toContain('poll_interval');
    });

    test('checks command status', () => {
      expect(lifecycleLambdaCode).toContain('get_command_invocation');
    });
  });

  describe('IAM Permissions for Lifecycle Lambda', () => {
    test('Lambda role can complete lifecycle actions', () => {
      template.hasResourceProperties('AWS::IAM::Policy', {
        PolicyDocument: {
          Statement: Match.arrayWith([
            Match.objectLike({
              Action: Match.arrayWith(['autoscaling:CompleteLifecycleAction']),
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

    test('Lambda role can query DynamoDB', () => {
      template.hasResourceProperties('AWS::IAM::Policy', {
        PolicyDocument: {
          Statement: Match.arrayWith([
            Match.objectLike({
              Action: Match.arrayWith(['dynamodb:Query']),
              Effect: 'Allow'
            })
          ])
        }
      });
    });

    test('Lambda role can update DynamoDB', () => {
      template.hasResourceProperties('AWS::IAM::Policy', {
        PolicyDocument: {
          Statement: Match.arrayWith([
            Match.objectLike({
              Action: Match.arrayWith(['dynamodb:UpdateItem']),
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
              Action: Match.arrayWith(['ssm:SendCommand']),
              Effect: 'Allow'
            })
          ])
        }
      });
    });

    test('Lambda role can get SSM command invocation', () => {
      template.hasResourceProperties('AWS::IAM::Policy', {
        PolicyDocument: {
          Statement: Match.arrayWith([
            Match.objectLike({
              Action: Match.arrayWith(['ssm:GetCommandInvocation']),
              Effect: 'Allow'
            })
          ])
        }
      });
    });
  });

  describe('Handler Function', () => {
    test('has handler function', () => {
      expect(lifecycleLambdaCode).toContain('def handler');
    });

    test('handler accepts event and context', () => {
      expect(lifecycleLambdaCode).toContain('def handler(event, context)');
    });

    test('handler has docstring explaining purpose', () => {
      expect(lifecycleLambdaCode).toContain('Handle EC2 instance termination lifecycle hook');
    });

    test('handler mentions etcd cluster management', () => {
      expect(lifecycleLambdaCode).toContain('etcd cluster management');
    });

    test('handler ensures safe etcd member removal', () => {
      expect(lifecycleLambdaCode).toContain('safely removed before instance termination');
    });
  });

  describe('Node Name Resolution', () => {
    test('gets node name from DynamoDB hostname', () => {
      expect(lifecycleLambdaCode).toContain('Hostname');
    });

    test('falls back to private IP for node name', () => {
      expect(lifecycleLambdaCode).toContain('private_ip');
    });
  });
});
