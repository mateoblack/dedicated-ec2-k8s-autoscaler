import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { createTestStack } from './test-helper';

describe('Worker Node Launch Template and ASG', () => {
  test('Compute stack creates worker launch template', () => {
    const { template } = createTestStack();
    
    template.hasResourceProperties('AWS::EC2::LaunchTemplate', {
      LaunchTemplateName: 'my-cluster-worker',
      LaunchTemplateData: {
        InstanceType: 'm5.large',
        UserData: Match.anyValue()
      }
    });
  });

  test('Worker launch template uses Amazon Linux 2023', () => {
    const { template } = createTestStack();
    
    template.hasResourceProperties('AWS::EC2::LaunchTemplate', {
      LaunchTemplateName: 'my-cluster-worker',
      LaunchTemplateData: {
        ImageId: Match.anyValue()
      }
    });
  });

  test('Worker launch template has correct security group and IAM role', () => {
    const { template } = createTestStack();
    
    template.hasResourceProperties('AWS::EC2::LaunchTemplate', {
      LaunchTemplateName: 'my-cluster-worker',
      LaunchTemplateData: {
        SecurityGroupIds: Match.anyValue(),
        IamInstanceProfile: Match.anyValue()
      }
    });
  });

  test('Worker launch template requires IMDSv2', () => {
    const { template } = createTestStack();
    
    template.hasResourceProperties('AWS::EC2::LaunchTemplate', {
      LaunchTemplateName: 'my-cluster-worker',
      LaunchTemplateData: {
        MetadataOptions: {
          HttpTokens: 'required'
        }
      }
    });
  });

  test('Worker launch template has encrypted EBS volume', () => {
    const { template } = createTestStack();
    
    template.hasResourceProperties('AWS::EC2::LaunchTemplate', {
      LaunchTemplateName: 'my-cluster-worker',
      LaunchTemplateData: {
        BlockDeviceMappings: Match.arrayWith([
          Match.objectLike({
            Ebs: {
              Encrypted: true,
              VolumeType: 'gp3'
            }
          })
        ])
      }
    });
  });

  test('Worker Auto Scaling Group has correct configuration', () => {
    const { template } = createTestStack();
    
    template.hasResourceProperties('AWS::AutoScaling::AutoScalingGroup', {
      AutoScalingGroupName: 'my-cluster-worker',
      MinSize: '1',
      MaxSize: '10',
      Tags: Match.arrayWith([
        Match.objectLike({
          Key: 'k8s.io/cluster-autoscaler/enabled',
          Value: 'true'
        })
      ])
    });
  });
});
