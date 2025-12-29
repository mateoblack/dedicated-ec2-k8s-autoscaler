import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { K8sClusterStack } from '../lib/k8s-cluster-stack';

test('IAM stack creates KMS key and roles', () => {
  const app = new cdk.App();
  const stack = new K8sClusterStack(app, 'TestStack', {
    clusterName: 'my-cluster',
    env: { account: '123456789012', region: 'us-west-2' }
  });
  const template = Template.fromStack(stack);

  // Test KMS key
  template.hasResourceProperties('AWS::KMS::Key', {
    EnableKeyRotation: true,
    Description: 'CMK KMS for DedicatedEc2K8s: my-cluster'
  });

  // Test IAM roles
  template.hasResourceProperties('AWS::IAM::Role', {
    RoleName: 'my-cluster-control-plane-role',
    Description: 'IAM role for Kubernetes control plane nodes in my-cluster cluster'
  });

  template.hasResourceProperties('AWS::IAM::Role', {
    RoleName: 'my-cluster-worker-node-role',
    Description: 'IAM role for Kubernetes worker nodes in my-cluster cluster'
  });
});

test('IAM stack creates DynamoDB permissions', () => {
  const app = new cdk.App();
  const stack = new K8sClusterStack(app, 'TestStack', {
    clusterName: 'my-cluster',
    env: { account: '123456789012', region: 'us-west-2' }
  });
  const template = Template.fromStack(stack);

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
            Match.stringLikeRegexp('arn:aws:dynamodb:.*:table/my-cluster-.*')
          ])
        })
      ])
    }
  });
});

test('IAM stack creates S3 permissions', () => {
  const app = new cdk.App();
  const stack = new K8sClusterStack(app, 'TestStack', {
    clusterName: 'my-cluster',
    env: { account: '123456789012', region: 'us-west-2' }
  });
  const template = Template.fromStack(stack);

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
            "arn:aws:s3:::my-cluster-bootstrap-*",
            "arn:aws:s3:::my-cluster-bootstrap-*/*"
          ]
        })
      ])
    }
  });
});
