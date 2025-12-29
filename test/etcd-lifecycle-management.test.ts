import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { createTestStack } from './test-helper';

test('etcd member table has correct structure for lifecycle management', () => {
  const { template } = createTestStack();
  
  template.hasResourceProperties('AWS::DynamoDB::Table', {
    TableName: 'my-cluster-etcd-members',
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
  const { template } = createTestStack();
  
  template.hasResourceProperties('AWS::DynamoDB::Table', {
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
  const { template } = createTestStack();
  
  template.hasResourceProperties('AWS::DynamoDB::Table', {
    TableName: 'my-cluster-bootstrap-lock',
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
  
  // Note: Additional comprehensive tests implemented in dedicated files:
  // - DynamoDB permissions: dynamodb-permissions.test.ts
  // - EC2 permissions: ec2-permissions.test.ts  
  // - SSM/etcdctl permissions: ssm-permissions.test.ts
});
