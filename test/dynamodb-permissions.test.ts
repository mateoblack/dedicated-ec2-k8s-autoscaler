import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { createTestStack } from './test-helper';

describe('DynamoDB Permissions', () => {
  test('Control plane role has DynamoDB permissions', () => {
    const { template } = createTestStack();
    
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: Match.arrayWith([
              'dynamodb:GetItem',
              'dynamodb:PutItem',
              'dynamodb:UpdateItem',
              'dynamodb:DeleteItem',
              'dynamodb:Query',
              'dynamodb:Scan'
            ]),
            Effect: 'Allow',
            Resource: Match.arrayWith([
              Match.stringLikeRegexp('arn:aws:dynamodb:.*:table/my-cluster-.*')
            ])
          })
        ])
      }
    });
  });

  test('Worker node role has DynamoDB permissions', () => {
    const { template } = createTestStack();
    
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: Match.arrayWith([
              'dynamodb:GetItem',
              'dynamodb:PutItem',
              'dynamodb:UpdateItem'
            ]),
            Effect: 'Allow',
            Resource: Match.arrayWith([
              Match.stringLikeRegexp('arn:aws:dynamodb:.*:table/my-cluster-.*')
            ])
          })
        ])
      }
    });
  });
});
