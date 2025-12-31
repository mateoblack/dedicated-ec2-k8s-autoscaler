import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { K8sClusterStack } from '../lib/k8s-cluster-stack';

describe('IAM Least Privilege', () => {
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

  // Helper to find policies attached to a specific role
  function getPoliciesForRole(roleName: string): any[] {
    const resources = templateJson.Resources;
    const policies: any[] = [];

    for (const key of Object.keys(resources)) {
      const resource = resources[key];
      if (resource.Type === 'AWS::IAM::Policy') {
        const roles = resource.Properties?.Roles;
        if (roles && Array.isArray(roles)) {
          for (const role of roles) {
            // Check if role reference matches our target role
            if (role.Ref) {
              const refResource = resources[role.Ref];
              if (refResource?.Properties?.RoleName === roleName) {
                policies.push(resource.Properties.PolicyDocument);
              }
            }
          }
        }
      }
    }
    return policies;
  }

  // Helper to check if any policy contains specific action
  function policyContainsAction(policies: any[], action: string): boolean {
    for (const policy of policies) {
      for (const statement of policy.Statement || []) {
        const actions = Array.isArray(statement.Action) ? statement.Action : [statement.Action];
        if (actions.includes(action)) {
          return true;
        }
      }
    }
    return false;
  }

  describe('Worker Node SSM Permissions - Read Only', () => {
    test('worker nodes have SSM GetParameter permission', () => {
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

    test('worker nodes do NOT have SSM PutParameter permission', () => {
      const workerPolicies = getPoliciesForRole('test-cluster-worker-node-role');
      expect(policyContainsAction(workerPolicies, 'ssm:PutParameter')).toBe(false);
    });

    test('worker nodes do NOT have SSM DeleteParameter permission', () => {
      const workerPolicies = getPoliciesForRole('test-cluster-worker-node-role');
      expect(policyContainsAction(workerPolicies, 'ssm:DeleteParameter')).toBe(false);
    });
  });

  describe('Worker Node DynamoDB Permissions - Limited', () => {
    test('worker nodes have DynamoDB GetItem permission', () => {
      template.hasResourceProperties('AWS::IAM::Policy', {
        PolicyDocument: {
          Statement: Match.arrayWith([
            Match.objectLike({
              Action: Match.arrayWith(['dynamodb:GetItem']),
              Effect: 'Allow'
            })
          ])
        }
      });
    });

    test('worker nodes do NOT have DynamoDB DeleteItem permission', () => {
      const workerPolicies = getPoliciesForRole('test-cluster-worker-node-role');
      expect(policyContainsAction(workerPolicies, 'dynamodb:DeleteItem')).toBe(false);
    });

    test('worker nodes do NOT have DynamoDB Scan permission', () => {
      const workerPolicies = getPoliciesForRole('test-cluster-worker-node-role');
      expect(policyContainsAction(workerPolicies, 'dynamodb:Scan')).toBe(false);
    });
  });

  describe('Worker Node S3 Permissions - Read Only', () => {
    test('worker nodes have S3 GetObject permission', () => {
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

    test('worker nodes do NOT have S3 PutObject permission', () => {
      const workerPolicies = getPoliciesForRole('test-cluster-worker-node-role');
      expect(policyContainsAction(workerPolicies, 's3:PutObject')).toBe(false);
    });

    test('worker nodes do NOT have S3 DeleteObject permission', () => {
      const workerPolicies = getPoliciesForRole('test-cluster-worker-node-role');
      expect(policyContainsAction(workerPolicies, 's3:DeleteObject')).toBe(false);
    });
  });

  describe('Control Plane ELB Permissions - Explicit Actions', () => {
    test('control plane does NOT use elasticloadbalancing:* wildcard', () => {
      const controlPlanePolicies = getPoliciesForRole('test-cluster-control-plane-role');
      expect(policyContainsAction(controlPlanePolicies, 'elasticloadbalancing:*')).toBe(false);
    });

    test('control plane has specific ELB describe actions', () => {
      template.hasResourceProperties('AWS::IAM::Policy', {
        PolicyDocument: {
          Statement: Match.arrayWith([
            Match.objectLike({
              Action: Match.arrayWith([
                'elasticloadbalancing:DescribeLoadBalancers',
                'elasticloadbalancing:DescribeTargetGroups'
              ]),
              Effect: 'Allow'
            })
          ])
        }
      });
    });

    test('control plane has specific ELB modification actions', () => {
      template.hasResourceProperties('AWS::IAM::Policy', {
        PolicyDocument: {
          Statement: Match.arrayWith([
            Match.objectLike({
              Action: Match.arrayWith([
                'elasticloadbalancing:RegisterTargets',
                'elasticloadbalancing:DeregisterTargets'
              ]),
              Effect: 'Allow'
            })
          ])
        }
      });
    });
  });

  describe('Cluster Autoscaler IRSA - Scoped Resources', () => {
    test('cluster autoscaler IRSA role exists with proper name', () => {
      template.hasResourceProperties('AWS::IAM::Role', {
        RoleName: 'test-cluster-cluster-autoscaler-irsa'
      });
    });

    test('cluster autoscaler has SetDesiredCapacity action', () => {
      template.hasResourceProperties('AWS::IAM::Policy', {
        PolicyDocument: {
          Statement: Match.arrayWith([
            Match.objectLike({
              Action: Match.arrayWith([
                'autoscaling:SetDesiredCapacity',
                'autoscaling:TerminateInstanceInAutoScalingGroup'
              ]),
              Effect: 'Allow'
            })
          ])
        }
      });
    });

    test('cluster autoscaler modification actions are scoped to cluster ASGs', () => {
      template.hasResourceProperties('AWS::IAM::Policy', {
        PolicyDocument: {
          Statement: Match.arrayWith([
            Match.objectLike({
              Action: Match.arrayWith([
                'autoscaling:SetDesiredCapacity',
                'autoscaling:TerminateInstanceInAutoScalingGroup'
              ]),
              Effect: 'Allow',
              Resource: Match.stringLikeRegexp('arn:aws:autoscaling:.*:autoScalingGroup:.*:autoScalingGroupName/test-cluster-.*')
            })
          ])
        }
      });
    });
  });

  describe('Control Plane vs Worker Permission Separation', () => {
    test('only control plane has autoscaling modification permissions', () => {
      const workerPolicies = getPoliciesForRole('test-cluster-worker-node-role');
      expect(policyContainsAction(workerPolicies, 'autoscaling:SetDesiredCapacity')).toBe(false);
      expect(policyContainsAction(workerPolicies, 'autoscaling:TerminateInstanceInAutoScalingGroup')).toBe(false);
    });

    test('only control plane has EC2 modification permissions', () => {
      const workerPolicies = getPoliciesForRole('test-cluster-worker-node-role');
      expect(policyContainsAction(workerPolicies, 'ec2:CreateSecurityGroup')).toBe(false);
      expect(policyContainsAction(workerPolicies, 'ec2:CreateVolume')).toBe(false);
      expect(policyContainsAction(workerPolicies, 'ec2:DeleteVolume')).toBe(false);
    });
  });
});
