import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { createTestStack } from './test-helper';

describe('IRSA Support', () => {
  test('Cluster autoscaler IRSA role is created', () => {
    const { template } = createTestStack();
    
    template.hasResourceProperties('AWS::IAM::Role', {
      RoleName: 'my-cluster-cluster-autoscaler-irsa'
    });
  });

  test('Cluster autoscaler role has autoscaling permissions', () => {
    const { template } = createTestStack();
    
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: Match.arrayWith([
              'autoscaling:DescribeAutoScalingGroups',
              'autoscaling:SetDesiredCapacity'
            ]),
            Effect: 'Allow'
          })
        ])
      }
    });
  });
});
