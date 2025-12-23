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
    kmsKey: iamStack.kmsKey,
    controlPlaneSecurityGroup: networkStack.controlPlaneSecurityGroup,
    controlPlaneLoadBalancer: networkStack.controlPlaneLoadBalancer,
    controlPlaneSubnets: networkStack.controlPlaneSubnets,
    vpc: networkStack.vpc,
    kubeletVersionParameter: servicesStack.kubeletVersionParameter,
    kubernetesVersionParameter: servicesStack.kubernetesVersionParameter,
    containerRuntimeParameter: servicesStack.containerRuntimeParameter,
    etcdMemberTable: databaseStack.etcdMemberTable
  });
  return { stack, template: Template.fromStack(stack) };
}

test('Compute stack creates control plane launch template', () => {
  const { template } = createTestStack();
  template.hasResourceProperties('AWS::EC2::LaunchTemplate', {
    LaunchTemplateName: 'test-cluster-control-plane'
  });
});

test('Control plane launch template uses Amazon Linux 2023', () => {
  const { template } = createTestStack();
  template.hasResourceProperties('AWS::EC2::LaunchTemplate', {
    LaunchTemplateData: {
      ImageId: Match.anyValue()
    }
  });
});

test('Control plane launch template has dedicated tenancy', () => {
  const { template } = createTestStack();
  template.hasResourceProperties('AWS::EC2::LaunchTemplate', {
    LaunchTemplateData: {
      Placement: {
        Tenancy: 'dedicated'
      }
    }
  });
});

test('Control plane launch template has correct security group and IAM role', () => {
  const { template } = createTestStack();
  template.hasResourceProperties('AWS::EC2::LaunchTemplate', {
    LaunchTemplateData: {
      SecurityGroupIds: Match.anyValue(),
      IamInstanceProfile: {
        Name: Match.anyValue()
      }
    }
  });
});

test('Control plane launch template requires IMDSv2', () => {
  const { template } = createTestStack();
  template.hasResourceProperties('AWS::EC2::LaunchTemplate', {
    LaunchTemplateData: {
      MetadataOptions: {
        HttpTokens: 'required',
        HttpPutResponseHopLimit: 2
      }
    }
  });
});

test('Control plane launch template has encrypted EBS volume', () => {
  const { template } = createTestStack();
  template.hasResourceProperties('AWS::EC2::LaunchTemplate', {
    LaunchTemplateData: {
      BlockDeviceMappings: [
        {
          DeviceName: '/dev/xvda',
          Ebs: {
            VolumeSize: 150,
            VolumeType: 'gp3',
            Encrypted: true,
            KmsKeyId: Match.anyValue()
          }
        }
      ]
    }
  });
});

test('Control plane launch template has user data with bootstrap script', () => {
  const { template } = createTestStack();
  template.hasResourceProperties('AWS::EC2::LaunchTemplate', {
    LaunchTemplateData: {
      UserData: Match.anyValue()
    }
  });
});

test('Control plane Auto Scaling Group has correct configuration', () => {
  const { template } = createTestStack();
  template.hasResourceProperties('AWS::AutoScaling::AutoScalingGroup', {
    AutoScalingGroupName: 'test-cluster-control-plane',
    MinSize: '3',
    MaxSize: '10',
    DesiredCapacity: '3'
  });
});

test('etcd lifecycle Lambda function is created', () => {
  const { template } = createTestStack();
  template.hasResourceProperties('AWS::Lambda::Function', {
    FunctionName: 'test-cluster-etcd-lifecycle',
    Runtime: 'python3.11',
    Handler: 'index.handler',
    Environment: {
      Variables: {
        CLUSTER_NAME: 'test-cluster',
        ETCD_TABLE_NAME: {
          'Fn::ImportValue': Match.stringLikeRegexp('EtcdMemberTable')
        }
      }
    }
  });
});

test('AutoScaling Group has lifecycle hook for etcd cleanup', () => {
  const { template } = createTestStack();
  template.hasResourceProperties('AWS::AutoScaling::LifecycleHook', {
    LifecycleHookName: 'test-cluster-etcd-cleanup',
    LifecycleTransition: 'autoscaling:EC2_INSTANCE_TERMINATING',
    DefaultResult: 'CONTINUE',
    HeartbeatTimeout: 600
  });
});

test('EventBridge rule triggers Lambda on lifecycle events', () => {
  const { template } = createTestStack();
  template.hasResourceProperties('AWS::Events::Rule', {
    Name: 'test-cluster-etcd-lifecycle-rule',
    EventPattern: {
      source: ['aws.autoscaling'],
      'detail-type': ['EC2 Instance-terminate Lifecycle Action'],
      detail: {
        AutoScalingGroupName: [{
          'Ref': Match.stringLikeRegexp('ControlPlaneAutoScalingGroup')
        }]
      }
    }
  });
});
