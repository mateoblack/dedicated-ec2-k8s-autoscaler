import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { createTestStack } from './test-helper';

describe('Security Groups', () => {
  test('Network stack creates control plane security group', () => {
    const { template } = createTestStack();
    template.hasResourceProperties('AWS::EC2::SecurityGroup', {
      GroupDescription: 'Security group for Kubernetes control plane nodes in my-cluster cluster'
    });
  });

  test('Network stack creates worker security group', () => {
    const { template } = createTestStack();
    template.hasResourceProperties('AWS::EC2::SecurityGroup', {
      GroupDescription: 'Security group for Kubernetes worker nodes in my-cluster cluster'
    });
  });

  test('Control plane security group allows self traffic', () => {
    const { template } = createTestStack();
    template.hasResourceProperties('AWS::EC2::SecurityGroupIngress', {
      IpProtocol: '-1',
      SourceSecurityGroupId: Match.anyValue()
    });
  });

  test('Control plane security group allows API server access from workers', () => {
    const { template } = createTestStack();
    template.hasResourceProperties('AWS::EC2::SecurityGroupIngress', {
      IpProtocol: 'tcp',
      FromPort: 6443,
      ToPort: 6443,
      SourceSecurityGroupId: Match.anyValue()
    });
  });

  test('Control plane security group allows NLB health checks from VPC CIDR', () => {
    const { template } = createTestStack();
    // CidrIp is dynamically resolved from VPC CIDR block
    template.hasResourceProperties('AWS::EC2::SecurityGroupIngress', {
      IpProtocol: 'tcp',
      FromPort: 6443,
      ToPort: 6443,
      CidrIp: Match.anyValue(),
      Description: 'Allow NLB health checks from VPC CIDR'
    });
  });

  test('Worker security group allows self traffic', () => {
    const { template } = createTestStack();
    template.hasResourceProperties('AWS::EC2::SecurityGroupIngress', {
      IpProtocol: '-1',
      SourceSecurityGroupId: Match.anyValue()
    });
  });

  test('Network stack creates control plane load balancer', () => {
    const { template } = createTestStack();
    template.hasResourceProperties('AWS::ElasticLoadBalancingV2::LoadBalancer', {
      Type: 'network',
      Scheme: 'internal'
    });

    template.hasResourceProperties('AWS::ElasticLoadBalancingV2::TargetGroup', {
      Port: 6443,
      Protocol: 'TCP',
      TargetType: 'instance'
    });
  });
});
