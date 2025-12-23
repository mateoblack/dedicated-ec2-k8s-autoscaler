import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { ComputeStack } from '../lib/compute-stack';
import { NetworkStack } from '../lib/network-stack';
import { IamStack } from '../lib/iam-stack';
import { ServicesStack } from '../lib/services-stack';
import { DatabaseStack } from '../lib/database-stack';

describe('SSM Permissions for etcd Lifecycle Lambda', () => {
  let template: Template;

  beforeAll(() => {
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
    
    const computeStack = new ComputeStack(app, 'TestComputeStack', {
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

    template = Template.fromStack(computeStack);
  });

  test('Lambda execution role has SSM send command permissions', () => {
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Effect: 'Allow',
            Action: Match.arrayWith([
              'ssm:SendCommand'
            ])
          })
        ])
      }
    });
  });

  test('Lambda execution role has SSM get command invocation permissions', () => {
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Effect: 'Allow',
            Action: Match.arrayWith([
              'ssm:GetCommandInvocation'
            ])
          })
        ])
      }
    });
  });
});
