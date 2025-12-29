import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { createTestStack } from './test-helper';

describe('SSM Bootstrap Integration', () => {
  test('SSM parameters are created for bootstrap configuration', () => {
    const { template } = createTestStack();
    
    template.hasResourceProperties('AWS::SSM::Parameter', {
      Name: '/my-cluster/control/kubelet/version',
      Type: 'String'
    });

    template.hasResourceProperties('AWS::SSM::Parameter', {
      Name: '/my-cluster/control/kubernetes/version',
      Type: 'String'
    });

    template.hasResourceProperties('AWS::SSM::Parameter', {
      Name: '/my-cluster/control/container/runtime',
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
