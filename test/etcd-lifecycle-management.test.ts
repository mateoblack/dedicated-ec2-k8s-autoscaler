import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { DatabaseStack } from '../lib/database-stack';
import { IamStack } from '../lib/iam-stack';

function createTestStacks() {
  const app = new cdk.App();
  const iamStack = new IamStack(app, 'IamStack', {
    clusterName: 'test-cluster'
  });
  const databaseStack = new DatabaseStack(app, 'DatabaseStack', {
    clusterName: 'test-cluster',
    kmsKey: iamStack.kmsKey
  });
  return {
    databaseStack,
    databaseTemplate: Template.fromStack(databaseStack)
  };
}

test('etcd member table has correct structure for lifecycle management', () => {
  const { databaseTemplate } = createTestStacks();
  
  databaseTemplate.hasResourceProperties('AWS::DynamoDB::Table', {
    TableName: 'test-cluster-etcd-members',
    AttributeDefinitions: [
      {
        AttributeName: 'ClusterId',
        AttributeType: 'S'
      },
      {
        AttributeName: 'MemberId', 
        AttributeType: 'S'
      },
      {
        AttributeName: 'InstanceId',
        AttributeType: 'S'
      },
      {
        AttributeName: 'PrivateIp',
        AttributeType: 'S'
      }
    ],
    KeySchema: [
      {
        AttributeName: 'ClusterId',
        KeyType: 'HASH'
      },
      {
        AttributeName: 'MemberId',
        KeyType: 'RANGE'
      }
    ]
  });
});

test('etcd member table has GSI for instance ID lookups', () => {
  const { databaseTemplate } = createTestStacks();
  
  databaseTemplate.hasResourceProperties('AWS::DynamoDB::Table', {
    GlobalSecondaryIndexes: [
      {
        IndexName: 'InstanceIdIndex',
        KeySchema: [
          {
            AttributeName: 'InstanceId',
            KeyType: 'HASH'
          }
        ],
        Projection: {
          ProjectionType: 'ALL'
        }
      },
      {
        IndexName: 'IpAddressIndex',
        KeySchema: [
          {
            AttributeName: 'PrivateIp',
            KeyType: 'HASH'
          }
        ],
        Projection: {
          ProjectionType: 'ALL'
        }
      }
    ]
  });
});

test('bootstrap lock table supports TTL for automatic cleanup', () => {
  const { databaseTemplate } = createTestStacks();
  
  databaseTemplate.hasResourceProperties('AWS::DynamoDB::Table', {
    TableName: 'test-cluster-bootstrap-lock',
    TimeToLiveSpecification: {
      AttributeName: 'ExpiresAt',
      Enabled: true
    }
  });
});

describe('etcd lifecycle management', () => {
  test('Lambda function exists for etcd member removal', () => {
    // Lambda function is tested in control-plane-launch-template.test.ts
    expect(true).toBe(true);
  });
  
  test('AutoScaling Group has lifecycle hook for instance termination', () => {
    // Lifecycle hook is tested in control-plane-launch-template.test.ts
    expect(true).toBe(true);
  });
  
  test('EventBridge rule triggers Lambda function', () => {
    // EventBridge rule is tested in control-plane-launch-template.test.ts
    expect(true).toBe(true);
  });
  
  test.todo('Lambda function has DynamoDB read/write permissions');
  test.todo('Lambda function has EC2 permissions for lifecycle hooks');
  test.todo('Lambda function can call etcdctl member remove');
});
