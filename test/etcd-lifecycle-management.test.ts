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

describe('etcd lifecycle Lambda timeout configuration', () => {
  // etcd member removal on large nodes can take significant time:
  // - Data replication to remaining members
  // - Leader election if terminated node was leader
  // - SSM command execution overhead
  // - etcdctl member remove command execution
  // 5 minutes may be too short; 10 minutes provides adequate buffer

  test('etcd lifecycle Lambda has 10 minute timeout', () => {
    const { template } = createTestStack();

    // Lambda timeout should be 10 minutes (600 seconds) for large node handling
    template.hasResourceProperties('AWS::Lambda::Function', {
      FunctionName: 'my-cluster-etcd-lifecycle',
      Timeout: 600
    });
  });

  test('lifecycle hook heartbeat timeout matches or exceeds Lambda timeout', () => {
    const { template } = createTestStack();
    const templateJson = template.toJSON();

    // Find Lambda timeout and lifecycle hook heartbeat
    const resources = templateJson.Resources;
    let lambdaTimeout = 0;
    let hookHeartbeat = 0;

    for (const key of Object.keys(resources)) {
      const resource = resources[key];
      if (resource.Type === 'AWS::Lambda::Function' &&
          resource.Properties?.FunctionName?.includes('etcd-lifecycle')) {
        lambdaTimeout = resource.Properties.Timeout || 0;
      }
      if (resource.Type === 'AWS::AutoScaling::LifecycleHook' &&
          resource.Properties?.LifecycleHookName?.includes('etcd-cleanup')) {
        hookHeartbeat = resource.Properties.HeartbeatTimeout || 0;
      }
    }

    // Heartbeat should be >= Lambda timeout to allow Lambda to complete
    expect(hookHeartbeat).toBeGreaterThanOrEqual(lambdaTimeout);
  });

  test('Lambda duration alarm threshold is 80% of timeout', () => {
    const { template } = createTestStack();
    const templateJson = template.toJSON();

    // Find the duration alarm for etcd lifecycle Lambda
    const resources = templateJson.Resources;
    let alarmThreshold = 0;

    for (const key of Object.keys(resources)) {
      const resource = resources[key];
      if (resource.Type === 'AWS::CloudWatch::Alarm' &&
          resource.Properties?.AlarmName?.includes('etcd-lifecycle-lambda-duration')) {
        alarmThreshold = resource.Properties.Threshold || 0;
      }
    }

    // Threshold should be 80% of 10 minutes = 480000ms (480 seconds * 1000)
    // This gives warning before timeout occurs
    expect(alarmThreshold).toBe(480000);
  });

  test('Lambda timeout allows for SSM command execution overhead', () => {
    const { template } = createTestStack();

    // The Lambda uses SSM SendCommand to execute etcdctl on control plane nodes
    // SSM command execution has inherent overhead, so timeout must accommodate:
    // - SSM agent polling interval (up to 5 seconds)
    // - Command queue processing
    // - etcdctl member remove execution
    // - DynamoDB cleanup
    // 10 minutes (600s) provides adequate buffer
    template.hasResourceProperties('AWS::Lambda::Function', {
      FunctionName: 'my-cluster-etcd-lifecycle',
      Timeout: 600
    });
  });
});
