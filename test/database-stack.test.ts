import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { K8sClusterStack } from '../lib/k8s-cluster-stack';

describe('Database Stack', () => {
  let template: Template;
  let templateJson: any;

  beforeAll(() => {
    const app = new cdk.App();
    const stack = new K8sClusterStack(app, 'TestStack', {
      clusterName: 'test-cluster',
      env: { account: '123456789012', region: 'us-west-2' }
    });
    template = Template.fromStack(stack);
    templateJson = template.toJSON();
  });

  describe('DynamoDB Tables', () => {
    test('creates bootstrap lock table', () => {
      template.hasResourceProperties('AWS::DynamoDB::Table', {
        TableName: 'test-cluster-bootstrap-lock'
      });
    });

    test('creates etcd members table', () => {
      template.hasResourceProperties('AWS::DynamoDB::Table', {
        TableName: 'test-cluster-etcd-members'
      });
    });

    test('bootstrap lock table has correct partition key', () => {
      template.hasResourceProperties('AWS::DynamoDB::Table', {
        TableName: 'test-cluster-bootstrap-lock',
        KeySchema: Match.arrayWith([
          Match.objectLike({
            AttributeName: 'LockName',
            KeyType: 'HASH'
          })
        ])
      });
    });

    test('etcd members table has composite primary key', () => {
      template.hasResourceProperties('AWS::DynamoDB::Table', {
        TableName: 'test-cluster-etcd-members',
        KeySchema: Match.arrayWith([
          Match.objectLike({
            AttributeName: 'ClusterId',
            KeyType: 'HASH'
          }),
          Match.objectLike({
            AttributeName: 'MemberId',
            KeyType: 'RANGE'
          })
        ])
      });
    });

    test('tables use PAY_PER_REQUEST billing mode', () => {
      template.hasResourceProperties('AWS::DynamoDB::Table', {
        TableName: 'test-cluster-bootstrap-lock',
        BillingMode: 'PAY_PER_REQUEST'
      });

      template.hasResourceProperties('AWS::DynamoDB::Table', {
        TableName: 'test-cluster-etcd-members',
        BillingMode: 'PAY_PER_REQUEST'
      });
    });
  });

  describe('DynamoDB Encryption', () => {
    test('bootstrap lock table uses customer-managed KMS encryption', () => {
      template.hasResourceProperties('AWS::DynamoDB::Table', {
        TableName: 'test-cluster-bootstrap-lock',
        SSESpecification: {
          SSEEnabled: true,
          SSEType: 'KMS',
          KMSMasterKeyId: Match.anyValue()
        }
      });
    });

    test('etcd members table uses customer-managed KMS encryption', () => {
      template.hasResourceProperties('AWS::DynamoDB::Table', {
        TableName: 'test-cluster-etcd-members',
        SSESpecification: {
          SSEEnabled: true,
          SSEType: 'KMS',
          KMSMasterKeyId: Match.anyValue()
        }
      });
    });

    test('KMS key is referenced for table encryption', () => {
      // Find tables and verify they reference a KMS key
      const resources = templateJson.Resources;
      let foundKmsReference = false;

      for (const key of Object.keys(resources)) {
        const resource = resources[key];
        if (resource.Type === 'AWS::DynamoDB::Table') {
          const kmsKeyId = resource.Properties?.SSESpecification?.KMSMasterKeyId;
          if (kmsKeyId && (kmsKeyId['Fn::GetAtt'] || kmsKeyId['Ref'])) {
            foundKmsReference = true;
            break;
          }
        }
      }
      expect(foundKmsReference).toBe(true);
    });
  });

  describe('DynamoDB Point-in-Time Recovery', () => {
    test('bootstrap lock table has point-in-time recovery enabled', () => {
      template.hasResourceProperties('AWS::DynamoDB::Table', {
        TableName: 'test-cluster-bootstrap-lock',
        PointInTimeRecoverySpecification: {
          PointInTimeRecoveryEnabled: true
        }
      });
    });

    test('etcd members table has point-in-time recovery enabled', () => {
      template.hasResourceProperties('AWS::DynamoDB::Table', {
        TableName: 'test-cluster-etcd-members',
        PointInTimeRecoverySpecification: {
          PointInTimeRecoveryEnabled: true
        }
      });
    });
  });

  describe('DynamoDB TTL', () => {
    test('bootstrap lock table has TTL attribute configured', () => {
      template.hasResourceProperties('AWS::DynamoDB::Table', {
        TableName: 'test-cluster-bootstrap-lock',
        TimeToLiveSpecification: {
          AttributeName: 'ExpiresAt',
          Enabled: true
        }
      });
    });
  });

  describe('DynamoDB Global Secondary Indexes', () => {
    test('etcd members table has InstanceIdIndex GSI', () => {
      template.hasResourceProperties('AWS::DynamoDB::Table', {
        TableName: 'test-cluster-etcd-members',
        GlobalSecondaryIndexes: Match.arrayWith([
          Match.objectLike({
            IndexName: 'InstanceIdIndex',
            KeySchema: Match.arrayWith([
              Match.objectLike({
                AttributeName: 'InstanceId',
                KeyType: 'HASH'
              })
            ]),
            Projection: {
              ProjectionType: 'ALL'
            }
          })
        ])
      });
    });

    test('etcd members table has IpAddressIndex GSI', () => {
      template.hasResourceProperties('AWS::DynamoDB::Table', {
        TableName: 'test-cluster-etcd-members',
        GlobalSecondaryIndexes: Match.arrayWith([
          Match.objectLike({
            IndexName: 'IpAddressIndex',
            KeySchema: Match.arrayWith([
              Match.objectLike({
                AttributeName: 'PrivateIp',
                KeyType: 'HASH'
              })
            ]),
            Projection: {
              ProjectionType: 'ALL'
            }
          })
        ])
      });
    });

    test('etcd members table has required attribute definitions for GSIs', () => {
      template.hasResourceProperties('AWS::DynamoDB::Table', {
        TableName: 'test-cluster-etcd-members',
        AttributeDefinitions: Match.arrayWith([
          Match.objectLike({
            AttributeName: 'InstanceId',
            AttributeType: 'S'
          }),
          Match.objectLike({
            AttributeName: 'PrivateIp',
            AttributeType: 'S'
          })
        ])
      });
    });

    test('GSIs use ALL projection type for complete data access', () => {
      const resources = templateJson.Resources;
      for (const key of Object.keys(resources)) {
        const resource = resources[key];
        if (resource.Type === 'AWS::DynamoDB::Table' &&
            resource.Properties?.TableName === 'test-cluster-etcd-members') {
          const gsis = resource.Properties?.GlobalSecondaryIndexes || [];
          for (const gsi of gsis) {
            expect(gsi.Projection?.ProjectionType).toBe('ALL');
          }
        }
      }
    });
  });

  describe('S3 Buckets', () => {
    test('creates four S3 buckets', () => {
      // Bootstrap bucket + OIDC bucket + etcd backup bucket + access logs bucket
      template.resourceCountIs('AWS::S3::Bucket', 4);
    });

    test('bootstrap bucket exists with correct name pattern', () => {
      template.hasResourceProperties('AWS::S3::Bucket', {
        BucketName: Match.stringLikeRegexp('test-cluster-bootstrap-.*')
      });
    });

    test('OIDC bucket exists with correct name pattern', () => {
      template.hasResourceProperties('AWS::S3::Bucket', {
        BucketName: Match.stringLikeRegexp('test-cluster-oidc-.*')
      });
    });

    test('etcd backup bucket exists with correct name pattern', () => {
      template.hasResourceProperties('AWS::S3::Bucket', {
        BucketName: Match.stringLikeRegexp('test-cluster-etcd-backup-.*')
      });
    });
  });

  describe('S3 Encryption', () => {
    test('bootstrap bucket uses KMS encryption', () => {
      template.hasResourceProperties('AWS::S3::Bucket', {
        BucketName: Match.stringLikeRegexp('test-cluster-bootstrap-.*'),
        BucketEncryption: {
          ServerSideEncryptionConfiguration: Match.arrayWith([
            Match.objectLike({
              ServerSideEncryptionByDefault: {
                SSEAlgorithm: 'aws:kms',
                KMSMasterKeyID: Match.anyValue()
              }
            })
          ])
        }
      });
    });

    test('etcd backup bucket uses KMS encryption', () => {
      template.hasResourceProperties('AWS::S3::Bucket', {
        BucketName: Match.stringLikeRegexp('test-cluster-etcd-backup-.*'),
        BucketEncryption: {
          ServerSideEncryptionConfiguration: Match.arrayWith([
            Match.objectLike({
              ServerSideEncryptionByDefault: {
                SSEAlgorithm: 'aws:kms',
                KMSMasterKeyID: Match.anyValue()
              }
            })
          ])
        }
      });
    });

    test('OIDC bucket uses S3-managed encryption for public read compatibility', () => {
      template.hasResourceProperties('AWS::S3::Bucket', {
        BucketName: Match.stringLikeRegexp('test-cluster-oidc-.*'),
        BucketEncryption: {
          ServerSideEncryptionConfiguration: Match.arrayWith([
            Match.objectLike({
              ServerSideEncryptionByDefault: {
                SSEAlgorithm: 'AES256'
              }
            })
          ])
        }
      });
    });
  });

  describe('S3 Public Access Configuration', () => {
    test('bootstrap bucket blocks all public access', () => {
      template.hasResourceProperties('AWS::S3::Bucket', {
        BucketName: Match.stringLikeRegexp('test-cluster-bootstrap-.*'),
        PublicAccessBlockConfiguration: {
          BlockPublicAcls: true,
          BlockPublicPolicy: true,
          IgnorePublicAcls: true,
          RestrictPublicBuckets: true
        }
      });
    });

    test('etcd backup bucket blocks all public access', () => {
      template.hasResourceProperties('AWS::S3::Bucket', {
        BucketName: Match.stringLikeRegexp('test-cluster-etcd-backup-.*'),
        PublicAccessBlockConfiguration: {
          BlockPublicAcls: true,
          BlockPublicPolicy: true,
          IgnorePublicAcls: true,
          RestrictPublicBuckets: true
        }
      });
    });

    test('OIDC bucket allows public bucket policy for OIDC discovery', () => {
      template.hasResourceProperties('AWS::S3::Bucket', {
        BucketName: Match.stringLikeRegexp('test-cluster-oidc-.*'),
        PublicAccessBlockConfiguration: {
          BlockPublicAcls: true,
          BlockPublicPolicy: false,
          IgnorePublicAcls: true,
          RestrictPublicBuckets: false
        }
      });
    });
  });

  describe('S3 Versioning', () => {
    test('bootstrap bucket has versioning enabled', () => {
      template.hasResourceProperties('AWS::S3::Bucket', {
        BucketName: Match.stringLikeRegexp('test-cluster-bootstrap-.*'),
        VersioningConfiguration: {
          Status: 'Enabled'
        }
      });
    });

    test('etcd backup bucket has versioning enabled', () => {
      template.hasResourceProperties('AWS::S3::Bucket', {
        BucketName: Match.stringLikeRegexp('test-cluster-etcd-backup-.*'),
        VersioningConfiguration: {
          Status: 'Enabled'
        }
      });
    });

    test('OIDC bucket has versioning enabled for security', () => {
      // OIDC bucket contains public keys for IRSA token validation
      // Versioning protects against accidental deletion/corruption
      template.hasResourceProperties('AWS::S3::Bucket', {
        BucketName: Match.stringLikeRegexp('test-cluster-oidc-.*'),
        VersioningConfiguration: {
          Status: 'Enabled'
        }
      });
    });
  });

  describe('S3 Server Access Logging', () => {
    test('access logging bucket exists', () => {
      // A dedicated bucket for storing S3 access logs
      template.hasResourceProperties('AWS::S3::Bucket', {
        BucketName: Match.stringLikeRegexp('test-cluster-access-logs-.*')
      });
    });

    test('access logging bucket blocks all public access', () => {
      template.hasResourceProperties('AWS::S3::Bucket', {
        BucketName: Match.stringLikeRegexp('test-cluster-access-logs-.*'),
        PublicAccessBlockConfiguration: {
          BlockPublicAcls: true,
          BlockPublicPolicy: true,
          IgnorePublicAcls: true,
          RestrictPublicBuckets: true
        }
      });
    });

    test('OIDC bucket has server access logging enabled', () => {
      // Server access logging tracks all requests to the OIDC bucket
      // This is important for security auditing of IRSA token validation
      const resources = templateJson.Resources;
      let foundOidcLogging = false;

      for (const key of Object.keys(resources)) {
        const resource = resources[key];
        if (resource.Type === 'AWS::S3::Bucket' &&
            resource.Properties?.BucketName?.includes('oidc')) {
          const loggingConfig = resource.Properties?.LoggingConfiguration;
          if (loggingConfig && loggingConfig.DestinationBucketName) {
            foundOidcLogging = true;
          }
        }
      }
      expect(foundOidcLogging).toBe(true);
    });

    test('OIDC bucket logs have prefix for organization', () => {
      const resources = templateJson.Resources;
      let foundLogPrefix = false;

      for (const key of Object.keys(resources)) {
        const resource = resources[key];
        if (resource.Type === 'AWS::S3::Bucket' &&
            resource.Properties?.BucketName?.includes('oidc')) {
          const loggingConfig = resource.Properties?.LoggingConfiguration;
          if (loggingConfig?.LogFilePrefix) {
            // Prefix should identify the source bucket
            foundLogPrefix = loggingConfig.LogFilePrefix.includes('oidc');
          }
        }
      }
      expect(foundLogPrefix).toBe(true);
    });
  });

  describe('S3 Lifecycle Rules', () => {
    test('bootstrap bucket has lifecycle rule for old versions', () => {
      template.hasResourceProperties('AWS::S3::Bucket', {
        BucketName: Match.stringLikeRegexp('test-cluster-bootstrap-.*'),
        LifecycleConfiguration: {
          Rules: Match.arrayWith([
            Match.objectLike({
              Id: 'DeleteOldVersions',
              Status: 'Enabled',
              NoncurrentVersionExpiration: {
                NoncurrentDays: 30
              }
            })
          ])
        }
      });
    });

    test('etcd backup bucket has expiration lifecycle rule', () => {
      template.hasResourceProperties('AWS::S3::Bucket', {
        BucketName: Match.stringLikeRegexp('test-cluster-etcd-backup-.*'),
        LifecycleConfiguration: {
          Rules: Match.arrayWith([
            Match.objectLike({
              Id: 'DeleteOldBackups',
              Status: 'Enabled',
              ExpirationInDays: 30
            })
          ])
        }
      });
    });

    test('etcd backup bucket has transition to infrequent access rule', () => {
      template.hasResourceProperties('AWS::S3::Bucket', {
        BucketName: Match.stringLikeRegexp('test-cluster-etcd-backup-.*'),
        LifecycleConfiguration: {
          Rules: Match.arrayWith([
            Match.objectLike({
              Id: 'TransitionToInfrequentAccess',
              Status: 'Enabled',
              Transitions: Match.arrayWith([
                Match.objectLike({
                  StorageClass: 'STANDARD_IA',
                  TransitionInDays: 7
                })
              ])
            })
          ])
        }
      });
    });

    test('etcd backup lifecycle optimizes storage costs', () => {
      // Verify the transition happens before expiration
      const resources = templateJson.Resources;
      for (const key of Object.keys(resources)) {
        const resource = resources[key];
        if (resource.Type === 'AWS::S3::Bucket' &&
            resource.Properties?.BucketName?.includes('etcd-backup')) {
          const rules = resource.Properties?.LifecycleConfiguration?.Rules || [];

          let transitionDays = 0;
          let expirationDays = 0;

          for (const rule of rules) {
            if (rule.Transitions) {
              transitionDays = rule.Transitions[0]?.TransitionInDays || 0;
            }
            if (rule.ExpirationInDays) {
              expirationDays = rule.ExpirationInDays;
            }
          }

          // Objects should transition to IA before they expire
          expect(transitionDays).toBeLessThan(expirationDays);
          expect(transitionDays).toBe(7);
          expect(expirationDays).toBe(30);
        }
      }
    });
  });

  describe('S3 SSL Enforcement', () => {
    test('bootstrap bucket enforces SSL', () => {
      // Check for bucket policy that denies non-SSL requests
      template.hasResourceProperties('AWS::S3::BucketPolicy', {
        PolicyDocument: Match.objectLike({
          Statement: Match.arrayWith([
            Match.objectLike({
              Effect: 'Deny',
              Condition: {
                Bool: {
                  'aws:SecureTransport': 'false'
                }
              }
            })
          ])
        })
      });
    });
  });

  describe('OIDC Bucket Policy', () => {
    test('OIDC bucket allows public read for discovery documents', () => {
      // Principal can be either "*" or {"AWS": "*"}
      template.hasResourceProperties('AWS::S3::BucketPolicy', {
        PolicyDocument: Match.objectLike({
          Statement: Match.arrayWith([
            Match.objectLike({
              Effect: 'Allow',
              Action: 's3:GetObject',
              Principal: Match.objectLike({
                AWS: '*'
              })
            })
          ])
        })
      });
    });

    test('OIDC bucket policy restricts to well-known and keys paths', () => {
      // Find OIDC bucket policy and check resource restrictions
      const resources = templateJson.Resources;
      let foundCorrectPolicy = false;

      for (const key of Object.keys(resources)) {
        const resource = resources[key];
        if (resource.Type === 'AWS::S3::BucketPolicy') {
          const statements = resource.Properties?.PolicyDocument?.Statement || [];
          for (const statement of statements) {
            // Principal can be "*" or {"AWS": "*"}
            const principalIsPublic = statement.Principal === '*' ||
              (statement.Principal?.AWS === '*');
            if (statement.Effect === 'Allow' && principalIsPublic) {
              const resourceArn = JSON.stringify(statement.Resource);
              if (resourceArn.includes('.well-known') || resourceArn.includes('keys.json')) {
                foundCorrectPolicy = true;
              }
            }
          }
        }
      }
      expect(foundCorrectPolicy).toBe(true);
    });
  });

  describe('Resource Removal Policies', () => {
    test('all DynamoDB tables have DESTROY removal policy', () => {
      const resources = templateJson.Resources;
      for (const key of Object.keys(resources)) {
        const resource = resources[key];
        if (resource.Type === 'AWS::DynamoDB::Table') {
          // CDK sets DeletionPolicy for removal policy
          expect(resource.DeletionPolicy).toBe('Delete');
        }
      }
    });

    test('all S3 buckets have DESTROY removal policy', () => {
      const resources = templateJson.Resources;
      for (const key of Object.keys(resources)) {
        const resource = resources[key];
        if (resource.Type === 'AWS::S3::Bucket') {
          expect(resource.DeletionPolicy).toBe('Delete');
        }
      }
    });
  });

  describe('Auto Delete Objects', () => {
    test('auto-delete custom resources exist for buckets', () => {
      // Verify custom resource exists for S3 auto-delete
      const resources = templateJson.Resources;
      let autoDeleteResourceCount = 0;

      for (const key of Object.keys(resources)) {
        const resource = resources[key];
        if (resource.Type === 'Custom::S3AutoDeleteObjects') {
          autoDeleteResourceCount++;
        }
      }
      // Should have auto-delete for OIDC and etcd backup buckets
      expect(autoDeleteResourceCount).toBeGreaterThanOrEqual(2);
    });

    test('auto-delete provider Lambda exists', () => {
      // The CDK creates a custom resource provider for auto-delete
      const resources = templateJson.Resources;
      let foundAutoDeleteProvider = false;

      for (const key of Object.keys(resources)) {
        const resource = resources[key];
        if (resource.Type === 'AWS::Lambda::Function' &&
            key.includes('AutoDeleteObjects')) {
          foundAutoDeleteProvider = true;
        }
      }
      expect(foundAutoDeleteProvider).toBe(true);
    });
  });
});
