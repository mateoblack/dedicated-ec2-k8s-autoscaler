import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { createTestStack } from './test-helper';

describe('SSM Permissions', () => {
  test('Control plane role has SSM permissions', () => {
    const { template } = createTestStack();
    
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: Match.arrayWith([
              'ssm:GetParameter',
              'ssm:GetParameters',
              'ssm:PutParameter'
            ]),
            Effect: 'Allow',
            Resource: Match.stringLikeRegexp('arn:aws:ssm:.*:parameter/my-cluster/.*')
          })
        ])
      }
    });
  });

  test('Worker node role has SSM permissions', () => {
    const { template } = createTestStack();
    
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: Match.arrayWith([
              'ssm:GetParameter',
              'ssm:GetParameters'
            ]),
            Effect: 'Allow',
            Resource: Match.stringLikeRegexp('arn:aws:ssm:.*:parameter/my-cluster/.*')
          })
        ])
      }
    });
  });
});
