import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { ComputeStack } from '../lib/compute-stack';
import { NetworkStack } from '../lib/network-stack';
import { IamStack } from '../lib/iam-stack';
import { ServicesStack } from '../lib/services-stack';
import { DatabaseStack } from '../lib/database-stack';

function createTestStack() {
  const app = new cdk.App();
  const iamStack = new IamStack(app, 'IamStack', {
    clusterName: 'test-cluster'
  });
  const networkStack = new NetworkStack(app, 'NetworkStack', {
    clusterName: 'test-cluster'
  });
  const servicesStack = new ServicesStack(app, 'ServicesStack', {
    clusterName: 'test-cluster'
  });
  const databaseStack = new DatabaseStack(app, 'DatabaseStack', {
    clusterName: 'test-cluster',
    kmsKey: iamStack.kmsKey
  });
  const stack = new ComputeStack(app, 'TestStack', {
    clusterName: 'test-cluster',
    controlPlaneRole: iamStack.controlPlaneRole,
    workerNodeRole: iamStack.workerNodeRole,
    kmsKey: iamStack.kmsKey,
    controlPlaneSecurityGroup: networkStack.controlPlaneSecurityGroup,
    workerSecurityGroup: networkStack.workerSecurityGroup,
    controlPlaneLoadBalancer: networkStack.controlPlaneLoadBalancer,
    controlPlaneSubnets: networkStack.controlPlaneSubnets,
    workerSubnets: networkStack.vpc.selectSubnets({ subnetGroupName: 'DataPlane' }).subnets,
    vpc: networkStack.vpc,
    kubeletVersionParameter: servicesStack.kubeletVersionParameter,
    kubernetesVersionParameter: servicesStack.kubernetesVersionParameter,
    containerRuntimeParameter: servicesStack.containerRuntimeParameter,
    etcdMemberTable: databaseStack.etcdMemberTable
  });
  return { stack, template: Template.fromStack(stack) };
}

describe('Worker ASG Cluster Autoscaler Tags', () => {
  test('Worker ASG has cluster-autoscaler enabled tag', () => {
    const { template } = createTestStack();
    template.hasResourceProperties('AWS::AutoScaling::AutoScalingGroup', {
      AutoScalingGroupName: 'test-cluster-worker',
      Tags: Match.arrayWith([
        Match.objectLike({
          Key: 'k8s.io/cluster-autoscaler/enabled',
          Value: 'true',
          PropagateAtLaunch: false
        })
      ])
    });
  });

  test('Worker ASG has cluster-autoscaler ownership tag', () => {
    const { template } = createTestStack();
    template.hasResourceProperties('AWS::AutoScaling::AutoScalingGroup', {
      AutoScalingGroupName: 'test-cluster-worker',
      Tags: Match.arrayWith([
        Match.objectLike({
          Key: 'k8s.io/cluster-autoscaler/test-cluster',
          Value: 'owned',
          PropagateAtLaunch: false
        })
      ])
    });
  });

  test('Control plane ASG does not have cluster-autoscaler tags', () => {
    const { template } = createTestStack();
    
    // Control plane ASG should exist
    template.hasResourceProperties('AWS::AutoScaling::AutoScalingGroup', {
      AutoScalingGroupName: 'test-cluster-control-plane'
    });
    
    // But should not have cluster-autoscaler tags
    template.hasResourceProperties('AWS::AutoScaling::AutoScalingGroup', {
      AutoScalingGroupName: 'test-cluster-control-plane',
      Tags: Match.absent()
    });
  });
});
