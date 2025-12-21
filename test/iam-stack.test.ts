import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { IamStack } from '../lib/iam-stack';

test('IAM stack creates KMS key and roles', () => {
  const app = new cdk.App();
  const stack = new IamStack(app, 'TestStack', {
    clusterName: 'test-cluster'
  });
  const template = Template.fromStack(stack);

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
});

test('IAM stack creates DynamoDB permissions', () => {
  const app = new cdk.App();
  const stack = new IamStack(app, 'TestStack', {
    clusterName: 'test-cluster'
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
            Match.objectLike({
              "Fn::Join": Match.anyValue()
            })
          ])
        })
      ])
    }
  });
});

test('IAM stack creates S3 permissions', () => {
  const app = new cdk.App();
  const stack = new IamStack(app, 'TestStack', {
    clusterName: 'test-cluster'
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
            "arn:aws:s3:::test-cluster-bootstrap-*",
            "arn:aws:s3:::test-cluster-bootstrap-*/*"
          ]
        })
      ])
    }
  });
});
