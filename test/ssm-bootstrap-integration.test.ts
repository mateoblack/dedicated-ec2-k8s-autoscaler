import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { createTestStack } from './test-helper';

// Helper to extract string content from CloudFormation intrinsic functions
function extractStringContent(obj: any): string {
  if (typeof obj === 'string') return obj;
  if (Array.isArray(obj)) return obj.map(extractStringContent).join('');
  if (obj && typeof obj === 'object') {
    if (obj['Fn::Join']) {
      const [separator, parts] = obj['Fn::Join'];
      return parts.map(extractStringContent).join(separator);
    }
    if (obj['Fn::Base64']) return extractStringContent(obj['Fn::Base64']);
    if (obj['Ref']) return `\${${obj['Ref']}}`;
    if (obj['Fn::GetAtt']) return `\${${obj['Fn::GetAtt'].join('.')}}`;
  }
  return '';
}

describe('SSM Bootstrap Integration', () => {
  test('SSM parameters are created for bootstrap configuration', () => {
    const { template } = createTestStack();

    template.hasResourceProperties('AWS::SSM::Parameter', {
      Name: '/my-cluster/kubernetes/version',
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

  describe('SSM Parameter Initial Values', () => {
    test('cluster endpoint is initialized with PENDING_INITIALIZATION', () => {
      const { template } = createTestStack();
      template.hasResourceProperties('AWS::SSM::Parameter', {
        Name: '/my-cluster/cluster/endpoint',
        Value: 'PENDING_INITIALIZATION'
      });
    });

    test('join token is initialized with PENDING_INITIALIZATION', () => {
      const { template } = createTestStack();
      template.hasResourceProperties('AWS::SSM::Parameter', {
        Name: '/my-cluster/cluster/join-token',
        Value: 'PENDING_INITIALIZATION'
      });
    });

    test('CA cert hash is initialized with PENDING_INITIALIZATION', () => {
      const { template } = createTestStack();
      template.hasResourceProperties('AWS::SSM::Parameter', {
        Name: '/my-cluster/cluster/ca-cert-hash',
        Value: 'PENDING_INITIALIZATION'
      });
    });

    test('cluster initialized flag starts as false', () => {
      const { template } = createTestStack();
      template.hasResourceProperties('AWS::SSM::Parameter', {
        Name: '/my-cluster/cluster/initialized',
        Value: 'false'
      });
    });
  });

  describe('Bootstrap Parameter Validation', () => {
    let workerUserData: string;
    let controlPlaneUserData: string;

    beforeAll(() => {
      const { template } = createTestStack();
      const templateJson = template.toJSON();
      const resources = templateJson.Resources;

      for (const key of Object.keys(resources)) {
        const resource = resources[key];
        if (resource.Type === 'AWS::EC2::LaunchTemplate') {
          const userData = resource.Properties?.LaunchTemplateData?.UserData;
          if (userData) {
            const content = extractStringContent(userData);
            if (key.includes('Worker')) {
              workerUserData = content;
            } else if (key.includes('ControlPlane')) {
              controlPlaneUserData = content;
            }
          }
        }
      }
    });

    test('worker bootstrap validates SSM parameters', () => {
      expect(workerUserData).toContain('validate_ssm_params');
    });

    test('worker bootstrap checks for PENDING_INITIALIZATION', () => {
      expect(workerUserData).toContain('PENDING_INITIALIZATION');
    });

    test('worker bootstrap fails fast on uninitialized parameters', () => {
      expect(workerUserData).toContain('exit 1');
      expect(workerUserData).toContain('SSM parameters contain uninitialized values');
    });

    test('control plane join validates SSM parameters', () => {
      expect(controlPlaneUserData).toContain('validate_join_params');
    });

    test('control plane join checks for PENDING_INITIALIZATION', () => {
      expect(controlPlaneUserData).toContain('PENDING_INITIALIZATION');
    });
  });
});
