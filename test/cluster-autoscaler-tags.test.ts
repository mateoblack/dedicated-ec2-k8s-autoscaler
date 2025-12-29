import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { createTestStack } from './test-helper';

describe('Cluster Autoscaler Tags', () => {
  test('Worker Auto Scaling Group has cluster autoscaler tags', () => {
    const { template } = createTestStack();
    
    template.hasResourceProperties('AWS::AutoScaling::AutoScalingGroup', {
      AutoScalingGroupName: 'my-cluster-worker',
      Tags: Match.arrayWith([
        Match.objectLike({
          Key: 'k8s.io/cluster-autoscaler/enabled',
          Value: 'true',
          PropagateAtLaunch: false
        }),
        Match.objectLike({
          Key: 'k8s.io/cluster-autoscaler/my-cluster',
          Value: 'owned',
          PropagateAtLaunch: false
        })
      ])
    });
  });

  test('Control plane Auto Scaling Group does not have cluster autoscaler tags', () => {
    const { template } = createTestStack();
    
    template.hasResourceProperties('AWS::AutoScaling::AutoScalingGroup', {
      AutoScalingGroupName: 'my-cluster-control-plane'
    });
    
    // Verify it doesn't have cluster autoscaler tags
    const asgResources = template.findResources('AWS::AutoScaling::AutoScalingGroup');
    const controlPlaneAsg = Object.values(asgResources).find((asg: any) => 
      asg.Properties?.AutoScalingGroupName === 'my-cluster-control-plane'
    );
    
    expect(controlPlaneAsg?.Properties?.Tags).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          Key: 'k8s.io/cluster-autoscaler/enabled'
        })
      ])
    );
  });
});
