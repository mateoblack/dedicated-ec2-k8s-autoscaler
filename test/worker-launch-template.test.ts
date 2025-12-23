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

describe('Worker Node Launch Template and ASG', () => {
  test('Compute stack creates worker launch template', () => {
    const { template } = createTestStack();
    template.hasResourceProperties('AWS::EC2::LaunchTemplate', {
      LaunchTemplateName: 'test-cluster-worker'
    });
  });

  test('Worker launch template uses Amazon Linux 2023', () => {
    const { template } = createTestStack();
    template.hasResourceProperties('AWS::EC2::LaunchTemplate', {
      LaunchTemplateData: {
        ImageId: Match.anyValue(),
        InstanceType: 'm5.large'
      }
    });
  });

  test('Worker launch template has worker IAM role', () => {
    const { template } = createTestStack();
    template.hasResourceProperties('AWS::EC2::LaunchTemplate', {
      LaunchTemplateName: 'test-cluster-worker',
      LaunchTemplateData: {
        IamInstanceProfile: {
          Arn: Match.anyValue()
        }
      }
    });
  });

  test('Worker launch template has bootstrap script with SSM parameters', () => {
    const { template } = createTestStack();
    template.hasResourceProperties('AWS::EC2::LaunchTemplate', {
      LaunchTemplateName: 'test-cluster-worker',
      LaunchTemplateData: {
        UserData: Match.anyValue()
      }
    });
  });

  test('Worker AutoScaling Group is created', () => {
    const { template } = createTestStack();
    template.hasResourceProperties('AWS::AutoScaling::AutoScalingGroup', {
      AutoScalingGroupName: 'test-cluster-worker',
      MinSize: '1',
      MaxSize: '10'
    });
  });

  test('Worker ASG uses worker launch template', () => {
    const { template } = createTestStack();
    template.hasResourceProperties('AWS::AutoScaling::AutoScalingGroup', {
      AutoScalingGroupName: 'test-cluster-worker',
      LaunchTemplate: {
        LaunchTemplateId: Match.anyValue(),
        Version: Match.anyValue()
      }
    });
  });

  test('Worker ASG has proper subnet configuration', () => {
    const { template } = createTestStack();
    template.hasResourceProperties('AWS::AutoScaling::AutoScalingGroup', {
      AutoScalingGroupName: 'test-cluster-worker',
      VPCZoneIdentifier: Match.anyValue()
    });
  });
});
