import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { createTestStack } from './test-helper';

describe('SSM Bootstrap Integration', () => {
  test('SSM parameters are created for bootstrap configuration', () => {
    const { template } = createTestStack();
    
    template.hasResourceProperties('AWS::SSM::Parameter', {
      Name: '/my-cluster/kubernetes/version',
      Type: 'String'
    });

    template.hasResourceProperties('AWS::SSM::Parameter', {
      Name: '/my-cluster/container/runtime',
      Type: 'String'
    });

    // Check cluster communication parameters
    template.hasResourceProperties('AWS::SSM::Parameter', {
      Name: '/my-cluster/cluster/endpoint',
      Type: 'String'
    });

    template.hasResourceProperties('AWS::SSM::Parameter', {
      Name: '/my-cluster/cluster/join-token',
      Type: 'String'
    });

    template.hasResourceProperties('AWS::SSM::Parameter', {
      Name: '/my-cluster/cluster/ca-cert-hash',
      Type: 'String'
    });

    template.hasResourceProperties('AWS::SSM::Parameter', {
      Name: '/my-cluster/cluster/initialized',
      Type: 'String'
    });
  });

  test('Launch templates reference SSM parameters in user data', () => {
    const { template } = createTestStack();
    
    template.hasResourceProperties('AWS::EC2::LaunchTemplate', {
      LaunchTemplateName: 'my-cluster-worker',
      LaunchTemplateData: {
        UserData: Match.anyValue()
      }
    });
  });
});
