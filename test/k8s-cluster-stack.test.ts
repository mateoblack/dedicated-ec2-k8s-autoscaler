import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { K8sClusterStack } from '../lib/k8s-cluster-stack';

test('K8s cluster stack creates all nested stacks', () => {
  const app = new cdk.App();
  const stack = new K8sClusterStack(app, 'TestStack', {
    clusterName: 'test-cluster'
  });

  // Verify all nested stacks are created
  expect(stack.servicesStack).toBeDefined();
  expect(stack.networkStack).toBeDefined();
  expect(stack.iamStack).toBeDefined();
  expect(stack.databaseStack).toBeDefined();
});

test('Services stack validation', () => {
  const app = new cdk.App();
  const stack = new K8sClusterStack(app, 'TestStack', {
    clusterName: 'test-cluster'
  });
  const template = Template.fromStack(stack.servicesStack);

  // Test parameter names are set correctly
  expect(stack.servicesStack.workerJoinParameterName).toBe('/test-cluster/kubeadm/worker-join');
  expect(stack.servicesStack.controlPlaneJoinParameter).toBe('/test-cluster/kubeadm/control-plane-join');
  expect(stack.servicesStack.oidcIssuerParameterName).toBe('/test-cluster/kubeadm/oidc-issuer');
});

test('Network stack VPC and endpoints', () => {
  const app = new cdk.App();
  const stack = new K8sClusterStack(app, 'TestStack', {
    clusterName: 'test-cluster'
  });
  const template = Template.fromStack(stack.networkStack);

  // Test VPC with dedicated tenancy
  template.hasResourceProperties('AWS::EC2::VPC', {
    CidrBlock: '10.0.0.0/16',
    InstanceTenancy: 'dedicated'
  });

  // Test VPC endpoints
  template.resourceCountIs('AWS::EC2::VPCEndpoint', 4);
});

test('IAM stack node role and KMS', () => {
  const app = new cdk.App();
  const stack = new K8sClusterStack(app, 'TestStack', {
    clusterName: 'test-cluster'
  });
  const template = Template.fromStack(stack.iamStack);

  // Test KMS key
  template.hasResourceProperties('AWS::KMS::Key', {
    EnableKeyRotation: true,
    Description: 'CMK KMS for DedicatedEc2K8s: test-cluster'
  });

  // Test IAM roles
  template.hasResourceProperties('AWS::IAM::Role', {
    RoleName: 'test-cluster-control-plane-role',
    Description: 'IAM role for Kubernetes control plane nodes in test-cluster cluster'
  });

  template.hasResourceProperties('AWS::IAM::Role', {
    RoleName: 'test-cluster-worker-node-role',
    Description: 'IAM role for Kubernetes worker nodes in test-cluster cluster'
  });

  // Test DynamoDB permissions
  template.hasResourceProperties('AWS::IAM::Policy', {
    PolicyDocument: {
      Statement: Match.arrayWith([
        Match.objectLike({
          Action: [
            "dynamodb:GetItem",
            "dynamodb:PutItem", 
            "dynamodb:UpdateItem",
            "dynamodb:DeleteItem",
            "dynamodb:Query",
            "dynamodb:Scan"
          ],
          Resource: Match.arrayWith([
            Match.objectLike({
              "Fn::Join": Match.anyValue()
            })
          ])
        })
      ])
    }
  });

  // Test S3 permissions
  template.hasResourceProperties('AWS::IAM::Policy', {
    PolicyDocument: {
      Statement: Match.arrayWith([
        Match.objectLike({
          Action: [
            "s3:GetObject",
            "s3:PutObject",
            "s3:DeleteObject", 
            "s3:ListBucket"
          ],
          Resource: [
            "arn:aws:s3:::test-cluster-bootstrap-*",
            "arn:aws:s3:::test-cluster-bootstrap-*/*"
          ]
        })
      ])
    }
  });
});

test('Database stack tables and bucket', () => {
  const app = new cdk.App();
  const stack = new K8sClusterStack(app, 'TestStack', {
    clusterName: 'test-cluster'
  });
  const template = Template.fromStack(stack.databaseStack);

  // Test DynamoDB tables
  template.hasResourceProperties('AWS::DynamoDB::Table', {
    TableName: 'test-cluster-bootstrap-lock'
  });

  template.hasResourceProperties('AWS::DynamoDB::Table', {
    TableName: 'test-cluster-etcd-members'
  });

  // Test S3 bucket
  template.resourceCountIs('AWS::S3::Bucket', 1);
});

test('Cluster name validation', () => {
  const app = new cdk.App();

  // Test invalid cluster names
  expect(() => {
    new K8sClusterStack(app, 'TestStack1', {
      clusterName: 'ab' // Too short
    });
  }).toThrow('clusterName must be at least 3 characters');

  expect(() => {
    new K8sClusterStack(app, 'TestStack2', {
      clusterName: 'Invalid_Name' // Contains underscore
    });
  }).toThrow('clustername must only contain lowercase letters, numbers and hyphens');
});
