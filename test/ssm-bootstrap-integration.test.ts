import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { ComputeStack } from '../lib/compute-stack';
import { NetworkStack } from '../lib/network-stack';
import { IamStack } from '../lib/iam-stack';
import { ServicesStack } from '../lib/services-stack';

function createTestStacks() {
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
  const computeStack = new ComputeStack(app, 'ComputeStack', {
    clusterName: 'test-cluster',
    controlPlaneRole: iamStack.controlPlaneRole,
    kmsKey: iamStack.kmsKey,
    controlPlaneSecurityGroup: networkStack.controlPlaneSecurityGroup,
    controlPlaneLoadBalancer: networkStack.controlPlaneLoadBalancer,
    controlPlaneSubnets: networkStack.controlPlaneSubnets,
    vpc: networkStack.vpc
  });
  return { 
    computeStack, 
    servicesStack,
    computeTemplate: Template.fromStack(computeStack),
    servicesTemplate: Template.fromStack(servicesStack)
  };
}

test('Bootstrap script SSM parameter is created', () => {
  const { computeTemplate } = createTestStacks();
  
  computeTemplate.hasResourceProperties('AWS::SSM::Parameter', {
    Name: '/test-cluster/bootstrap/control-plane',
    Type: 'String',
    Description: 'Bootstrap script for test-cluster control plane nodes'
  });
});

test('Configuration SSM parameters are created with correct values', () => {
  const { servicesTemplate } = createTestStacks();
  
  servicesTemplate.hasResourceProperties('AWS::SSM::Parameter', {
    Name: '/test-cluster/control/kubelet/version',
    Value: '1.28.2',
    Description: 'Kubelet version for cluster nodes'
  });
  
  servicesTemplate.hasResourceProperties('AWS::SSM::Parameter', {
    Name: '/test-cluster/control/kubernetes/version',
    Value: '1.28.2',
    Description: 'Kubernetes version for cluster'
  });
  
  servicesTemplate.hasResourceProperties('AWS::SSM::Parameter', {
    Name: '/test-cluster/control/container/runtime',
    Value: 'containerd',
    Description: 'Container runtime for cluster nodes'
  });
});

test('Bootstrap script parameter contains CloudFormation function for dynamic content', () => {
  const { computeTemplate } = createTestStacks();
  
  computeTemplate.hasResourceProperties('AWS::SSM::Parameter', {
    Name: '/test-cluster/bootstrap/control-plane',
    Value: {
      'Fn::Join': Match.anyValue()
    }
  });
});
