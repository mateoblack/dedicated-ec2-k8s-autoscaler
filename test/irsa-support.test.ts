import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { IamStack } from '../lib/iam-stack';

function createTestStack() {
  const app = new cdk.App();
  const stack = new IamStack(app, 'TestStack', {
    clusterName: 'test-cluster'
  });
  return { stack, template: Template.fromStack(stack) };
}

describe('IRSA (IAM Roles for Service Accounts) Support', () => {
  test('IAM stack creates OIDC identity provider', () => {
    const { template } = createTestStack();
    
    // Check for custom resource that creates OIDC provider for self-managed cluster
    template.hasResourceProperties('Custom::AWSCDKOpenIdConnectProvider', {
      Url: 'https://kubernetes.test-cluster.local',
      ClientIDList: ['sts.amazonaws.com'],
      ThumbprintList: ['9e99a48a9960b14926bb7f3b02e22da2b0ab7280']
    });
  });

  test('IAM stack creates cluster autoscaler IRSA role', () => {
    const { template } = createTestStack();
    template.hasResourceProperties('AWS::IAM::Role', {
      RoleName: 'test-cluster-cluster-autoscaler-irsa',
      AssumeRolePolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Effect: 'Allow',
            Principal: {
              Federated: { Ref: Match.stringLikeRegexp('OIDCProvider.*') }
            },
            Action: 'sts:AssumeRoleWithWebIdentity',
            Condition: Match.anyValue() // CfnJson reference for dynamic conditions
          })
        ])
      }
    });
  });

  test('Cluster autoscaler IRSA role has autoscaling permissions', () => {
    const { template } = createTestStack();
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Effect: 'Allow',
            Action: Match.arrayWith([
              'autoscaling:DescribeAutoScalingGroups',
              'autoscaling:DescribeAutoScalingInstances',
              'autoscaling:SetDesiredCapacity',
              'autoscaling:TerminateInstanceInAutoScalingGroup'
            ])
          })
        ])
      }
    });
  });
});
