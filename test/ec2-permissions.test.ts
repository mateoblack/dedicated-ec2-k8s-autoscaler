import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { createTestStack } from './test-helper';

describe('EC2 Permissions', () => {
  test('Control plane role has EC2 permissions', () => {
    const { template } = createTestStack();
    
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: Match.arrayWith([
              'ec2:DescribeInstances',
              'ec2:DescribeRegions'
            ]),
            Effect: 'Allow',
            Resource: '*'
          })
        ])
      }
    });
  });

  test('Worker node role has EC2 permissions', () => {
    const { template } = createTestStack();
    
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: Match.arrayWith([
              'ec2:DescribeInstances'
            ]),
            Effect: 'Allow',
            Resource: '*'
          })
        ])
      }
    });
  });
});
