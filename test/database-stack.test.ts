import * as cdk from 'aws-cdk-lib';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Template } from 'aws-cdk-lib/assertions';
import { DatabaseStack } from '../lib/database-stack';

test('Database stack creates DynamoDB tables', () => {
  const app = new cdk.App();
  const keyStack = new cdk.Stack(app, 'KeyStack');
  const kmsKey = new kms.Key(keyStack, 'TestKey');
  
  const stack = new DatabaseStack(app, 'TestStack', {
    clusterName: 'test-cluster',
    kmsKey: kmsKey
  });
  const template = Template.fromStack(stack);

  template.hasResourceProperties('AWS::DynamoDB::Table', {
    TableName: 'test-cluster-bootstrap-lock'
  });

  template.hasResourceProperties('AWS::DynamoDB::Table', {
    TableName: 'test-cluster-etcd-members'
  });
});

test('Database stack creates S3 bucket', () => {
  const app = new cdk.App();
  const keyStack = new cdk.Stack(app, 'KeyStack');
  const kmsKey = new kms.Key(keyStack, 'TestKey');
  
  const stack = new DatabaseStack(app, 'TestStack', {
    clusterName: 'test-cluster',
    kmsKey: kmsKey
  });
  const template = Template.fromStack(stack);

  template.resourceCountIs('AWS::S3::Bucket', 1);
});
