import { Match } from 'aws-cdk-lib/assertions';
import { createTestStack } from './test-helper';

describe('SSM Control Plane Access', () => {
  const { template } = createTestStack();

  test('Control plane role has SSM managed policy for Session Manager access', () => {
    template.hasResourceProperties('AWS::IAM::Role', {
      RoleName: 'my-cluster-control-plane-role',
      ManagedPolicyArns: Match.arrayWith([
        Match.objectLike({
          'Fn::Join': Match.arrayWith([
            '',
            Match.arrayWith([
              Match.stringLikeRegexp('.*AmazonSSMManagedInstanceCore')
            ])
          ])
        })
      ])
    });
  });

  test('VPC has SSM endpoint for private access', () => {
    template.hasResourceProperties('AWS::EC2::VPCEndpoint', {
      ServiceName: 'com.amazonaws.us-west-2.ssm',
      VpcEndpointType: 'Interface',
      PrivateDnsEnabled: true
    });
  });

  test('VPC has SSM Messages endpoint for Session Manager', () => {
    template.hasResourceProperties('AWS::EC2::VPCEndpoint', {
      ServiceName: 'com.amazonaws.us-west-2.ssmmessages',
      VpcEndpointType: 'Interface',
      PrivateDnsEnabled: true
    });
  });

  test('VPC has EC2 Messages endpoint for SSM Run Command', () => {
    template.hasResourceProperties('AWS::EC2::VPCEndpoint', {
      ServiceName: 'com.amazonaws.us-west-2.ec2messages',
      VpcEndpointType: 'Interface',
      PrivateDnsEnabled: true
    });
  });

  test('VPC endpoints have security group restricting to VPC CIDR on port 443', () => {
    template.hasResourceProperties('AWS::EC2::SecurityGroup', {
      GroupDescription: 'Security group for SSM endpoints',
      SecurityGroupIngress: [
        {
          FromPort: 443,
          ToPort: 443,
          IpProtocol: 'tcp',
          Description: 'Allow HTTPS from VPC CIDR'
        }
      ]
    });
  });

  test('Control plane instances use launch template with IMDSv2 required', () => {
    template.hasResourceProperties('AWS::EC2::LaunchTemplate', {
      LaunchTemplateName: 'my-cluster-control-plane',
      LaunchTemplateData: {
        MetadataOptions: {
          HttpTokens: 'required'
        }
      }
    });
  });

  test('All required VPC endpoints exist for SSM Session Manager', () => {
    // SSM Session Manager requires: ssm, ssmmessages, ec2messages
    template.resourceCountIs('AWS::EC2::VPCEndpoint', 4); // ssm, ssmmessages, ec2messages, kms
  });
});
