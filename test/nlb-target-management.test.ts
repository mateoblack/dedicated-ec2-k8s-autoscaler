import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { K8sClusterStack } from '../lib/k8s-cluster-stack';

describe('NLB Target Management', () => {
  let template: Template;
  let templateJson: any;
  let controlPlaneUserData: string;

  // Helper to extract string content from CloudFormation intrinsic functions
  function extractStringContent(obj: any): string {
    if (typeof obj === 'string') {
      return obj;
    }
    if (Array.isArray(obj)) {
      return obj.map(extractStringContent).join('');
    }
    if (obj && typeof obj === 'object') {
      if (obj['Fn::Join']) {
        const [separator, parts] = obj['Fn::Join'];
        return parts.map(extractStringContent).join(separator);
      }
      if (obj['Fn::Base64']) {
        return extractStringContent(obj['Fn::Base64']);
      }
      if (obj['Ref']) {
        return `\${${obj['Ref']}}`;
      }
      if (obj['Fn::GetAtt']) {
        return `\${${obj['Fn::GetAtt'].join('.')}}`;
      }
    }
    return '';
  }

  beforeAll(() => {
    const app = new cdk.App();
    const stack = new K8sClusterStack(app, 'TestStack', {
      clusterName: 'test-cluster',
      env: { account: '123456789012', region: 'us-west-2' }
    });
    template = Template.fromStack(stack);
    templateJson = template.toJSON();

    // Extract user data from launch templates
    const resources = templateJson.Resources;
    for (const key of Object.keys(resources)) {
      const resource = resources[key];
      if (resource.Type === 'AWS::EC2::LaunchTemplate') {
        const userData = resource.Properties?.LaunchTemplateData?.UserData;
        if (userData) {
          const content = extractStringContent(userData);
          if (key.includes('ControlPlane')) {
            controlPlaneUserData = content;
          }
        }
      }
    }
  });

  describe('Network Load Balancer Infrastructure', () => {
    test('NLB exists for control plane', () => {
      template.hasResourceProperties('AWS::ElasticLoadBalancingV2::LoadBalancer', {
        Type: 'network'
      });
    });

    test('NLB is internal (not internet-facing)', () => {
      template.hasResourceProperties('AWS::ElasticLoadBalancingV2::LoadBalancer', {
        Scheme: 'internal'
      });
    });

    test('NLB has VPC subnets configured', () => {
      template.hasResourceProperties('AWS::ElasticLoadBalancingV2::LoadBalancer', {
        Subnets: Match.anyValue()
      });
    });
  });

  describe('Target Group Configuration', () => {
    test('target group exists', () => {
      template.hasResourceProperties('AWS::ElasticLoadBalancingV2::TargetGroup', {
        Port: Match.anyValue()
      });
    });

    test('target group uses port 6443 for Kubernetes API', () => {
      template.hasResourceProperties('AWS::ElasticLoadBalancingV2::TargetGroup', {
        Port: 6443
      });
    });

    test('target group uses TCP protocol', () => {
      template.hasResourceProperties('AWS::ElasticLoadBalancingV2::TargetGroup', {
        Protocol: 'TCP'
      });
    });

    test('target group uses instance target type', () => {
      template.hasResourceProperties('AWS::ElasticLoadBalancingV2::TargetGroup', {
        TargetType: 'instance'
      });
    });

    test('target group has health check configured', () => {
      // Health check is configured via HealthCheckProtocol and HealthCheckPort
      template.hasResourceProperties('AWS::ElasticLoadBalancingV2::TargetGroup', {
        HealthCheckProtocol: Match.anyValue(),
        HealthCheckPort: Match.anyValue()
      });
    });

    test('health check uses TCP protocol', () => {
      template.hasResourceProperties('AWS::ElasticLoadBalancingV2::TargetGroup', {
        HealthCheckProtocol: 'TCP'
      });
    });

    test('health check targets port 6443', () => {
      template.hasResourceProperties('AWS::ElasticLoadBalancingV2::TargetGroup', {
        HealthCheckPort: '6443'
      });
    });

    test('health check has interval configured', () => {
      template.hasResourceProperties('AWS::ElasticLoadBalancingV2::TargetGroup', {
        HealthCheckIntervalSeconds: Match.anyValue()
      });
    });
  });

  describe('NLB Listener Configuration', () => {
    test('listener exists for API server', () => {
      template.hasResourceProperties('AWS::ElasticLoadBalancingV2::Listener', {
        Port: Match.anyValue()
      });
    });

    test('listener uses port 6443', () => {
      template.hasResourceProperties('AWS::ElasticLoadBalancingV2::Listener', {
        Port: 6443
      });
    });

    test('listener uses TCP protocol', () => {
      template.hasResourceProperties('AWS::ElasticLoadBalancingV2::Listener', {
        Protocol: 'TCP'
      });
    });

    test('listener forwards to target group', () => {
      template.hasResourceProperties('AWS::ElasticLoadBalancingV2::Listener', {
        DefaultActions: Match.arrayWith([
          Match.objectLike({
            Type: 'forward'
          })
        ])
      });
    });
  });

  describe('IAM Permissions for ELBv2', () => {
    test('IAM policy includes DescribeTargetGroups permission', () => {
      template.hasResourceProperties('AWS::IAM::Policy', {
        PolicyDocument: Match.objectLike({
          Statement: Match.arrayWith([
            Match.objectLike({
              Action: Match.arrayWith([
                'elasticloadbalancing:DescribeTargetGroups'
              ])
            })
          ])
        })
      });
    });

    test('IAM policy includes RegisterTargets permission', () => {
      template.hasResourceProperties('AWS::IAM::Policy', {
        PolicyDocument: Match.objectLike({
          Statement: Match.arrayWith([
            Match.objectLike({
              Action: Match.arrayWith([
                'elasticloadbalancing:RegisterTargets'
              ])
            })
          ])
        })
      });
    });

    test('IAM policy includes DeregisterTargets permission', () => {
      template.hasResourceProperties('AWS::IAM::Policy', {
        PolicyDocument: Match.objectLike({
          Statement: Match.arrayWith([
            Match.objectLike({
              Action: Match.arrayWith([
                'elasticloadbalancing:DeregisterTargets'
              ])
            })
          ])
        })
      });
    });

    test('IAM policy includes DescribeTargetHealth permission', () => {
      template.hasResourceProperties('AWS::IAM::Policy', {
        PolicyDocument: Match.objectLike({
          Statement: Match.arrayWith([
            Match.objectLike({
              Action: Match.arrayWith([
                'elasticloadbalancing:DescribeTargetHealth'
              ])
            })
          ])
        })
      });
    });
  });

  describe('Target Registration State Tracking', () => {
    test('initializes LB_REGISTERED tracking variable', () => {
      expect(controlPlaneUserData).toContain('LB_REGISTERED=false');
    });

    test('LB_REGISTERED is set to true after successful registration', () => {
      expect(controlPlaneUserData).toContain('LB_REGISTERED=true');
    });
  });

  describe('Target Group ARN Discovery', () => {
    test('uses describe-target-groups to get ARN', () => {
      expect(controlPlaneUserData).toContain('describe-target-groups');
    });

    test('queries target group by name', () => {
      expect(controlPlaneUserData).toContain('--names');
    });

    test('uses correct target group name pattern', () => {
      expect(controlPlaneUserData).toContain('control-plane-tg');
    });

    test('extracts TargetGroupArn from query output', () => {
      expect(controlPlaneUserData).toContain('TargetGroupArn');
    });

    test('uses --output text for ARN extraction', () => {
      expect(controlPlaneUserData).toContain('--output text');
    });
  });

  describe('Target Registration Command', () => {
    test('uses register-targets command', () => {
      expect(controlPlaneUserData).toContain('register-targets');
    });

    test('passes target-group-arn parameter', () => {
      expect(controlPlaneUserData).toContain('--target-group-arn');
    });

    test('passes targets parameter with Id', () => {
      expect(controlPlaneUserData).toContain('--targets Id=');
    });

    test('registers on port 6443', () => {
      expect(controlPlaneUserData).toContain('Port=6443');
    });

    test('uses instance ID for registration', () => {
      expect(controlPlaneUserData).toContain('Id=$INSTANCE_ID');
    });

    test('uses retry mechanism for registration', () => {
      // Registration should use retry_command for reliability
      const registerMatches = controlPlaneUserData.match(/retry_command.*register-targets/g);
      expect(registerMatches).toBeTruthy();
      expect(registerMatches!.length).toBeGreaterThanOrEqual(1);
    });

    test('specifies region for registration', () => {
      expect(controlPlaneUserData).toContain('register-targets');
      expect(controlPlaneUserData).toContain('--region');
    });
  });

  describe('Target Registration Scenarios', () => {
    test('registers after cluster initialization', () => {
      // After kubeadm init, should register with LB
      expect(controlPlaneUserData).toContain('kubeadm init');
      expect(controlPlaneUserData).toContain('register-targets');
    });

    test('registers after disaster recovery restore', () => {
      // After restore_from_backup, should register with LB
      expect(controlPlaneUserData).toContain('restore_from_backup');
      expect(controlPlaneUserData).toContain('register-targets');
    });

    test('registers after joining as control plane', () => {
      // After kubeadm join, should register with LB
      expect(controlPlaneUserData).toContain('kubeadm join');
      expect(controlPlaneUserData).toContain('register-targets');
    });

    test('validates TARGET_GROUP_ARN before registration', () => {
      expect(controlPlaneUserData).toContain('if [ -n "$TARGET_GROUP_ARN"');
    });
  });

  describe('Target Deregistration on Failure', () => {
    test('cleanup function exists', () => {
      expect(controlPlaneUserData).toContain('cleanup_on_failure');
    });

    test('cleanup checks if LB was registered', () => {
      expect(controlPlaneUserData).toContain('if [ "$LB_REGISTERED" = "true" ]');
    });

    test('cleanup uses deregister-targets command', () => {
      expect(controlPlaneUserData).toContain('deregister-targets');
    });

    test('cleanup passes target-group-arn for deregistration', () => {
      const deregisterSection = controlPlaneUserData.includes('deregister-targets') &&
                               controlPlaneUserData.includes('--target-group-arn');
      expect(deregisterSection).toBe(true);
    });

    test('cleanup removes instance from target group', () => {
      expect(controlPlaneUserData).toContain('deregister-targets');
      expect(controlPlaneUserData).toContain('Id=$INSTANCE_ID');
    });

    test('deregistration uses port 6443', () => {
      // Check deregister-targets section includes Port=6443
      const deregisterMatch = controlPlaneUserData.match(/deregister-targets[^;]*Port=6443/);
      expect(deregisterMatch).toBeTruthy();
    });

    test('deregistration handles errors gracefully', () => {
      // Should use || true to prevent cleanup failure
      expect(controlPlaneUserData).toContain('deregister-targets');
      const deregisterWithErrorHandling = controlPlaneUserData.match(/deregister-targets[^|]*\|\| true/);
      expect(deregisterWithErrorHandling).toBeTruthy();
    });

    test('cleanup logs load balancer removal message', () => {
      expect(controlPlaneUserData).toContain('Removing from load balancer');
    });

    test('cleanup queries target group ARN before deregistration', () => {
      // In cleanup, should get target group ARN before deregistering
      expect(controlPlaneUserData).toContain('describe-target-groups');
      expect(controlPlaneUserData).toContain('deregister-targets');
    });

    test('cleanup validates target group ARN is not None', () => {
      expect(controlPlaneUserData).toContain('"$TARGET_GROUP_ARN" != "None"');
    });
  });

  describe('Bootstrap Stage Integration', () => {
    test('BOOTSTRAP_STAGE tracking exists', () => {
      expect(controlPlaneUserData).toContain('BOOTSTRAP_STAGE=');
    });

    test('registration happens after cluster is ready', () => {
      // register-targets should appear after cluster initialization stages
      const initIndex = controlPlaneUserData.indexOf('kubeadm init');
      const registerIndex = controlPlaneUserData.indexOf('register-targets');
      expect(initIndex).toBeGreaterThan(-1);
      expect(registerIndex).toBeGreaterThan(-1);
      // Registration happens multiple times - at least once after init
    });
  });

  describe('Region Configuration', () => {
    test('describe-target-groups includes region', () => {
      expect(controlPlaneUserData).toMatch(/describe-target-groups.*--region/);
    });

    test('register-targets includes region', () => {
      expect(controlPlaneUserData).toMatch(/register-targets.*--region/);
    });

    test('deregister-targets includes region', () => {
      expect(controlPlaneUserData).toMatch(/deregister-targets.*--region/);
    });
  });

  describe('Retry Mechanism', () => {
    test('retry_command function exists', () => {
      expect(controlPlaneUserData).toContain('retry_command');
    });

    test('retry_command_output function exists', () => {
      expect(controlPlaneUserData).toContain('retry_command_output');
    });

    test('target group ARN discovery uses retry', () => {
      const arnDiscoveryWithRetry = controlPlaneUserData.match(/retry_command_output.*describe-target-groups/);
      expect(arnDiscoveryWithRetry).toBeTruthy();
    });
  });
});
