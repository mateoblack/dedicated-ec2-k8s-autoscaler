import * as cdk from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as kms from 'aws-cdk-lib/aws-kms';
import { Construct } from 'constructs';

export interface DatabaseStackProps {
  readonly clusterName: string;
  readonly kmsKey: kms.IKey;
}

export class DatabaseStack extends Construct {
  public readonly bootstrapLockTable: dynamodb.Table;
  public readonly etcdMemberTable: dynamodb.Table;
  public readonly bootstrapBucket: s3.Bucket;
  public readonly oidcBucket: s3.Bucket;
  public readonly etcdBackupBucket: s3.Bucket;

  constructor(scope: Construct, id: string, props: DatabaseStackProps) {
    super(scope, id);

    // Bootstrap lock table for leader election
    this.bootstrapLockTable = new dynamodb.Table(this, "BootstrapLockTable", {
      tableName: `${props.clusterName}-bootstrap-lock`,
      partitionKey: {
        name: "LockName",
        type: dynamodb.AttributeType.STRING
      },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.CUSTOMER_MANAGED,
      encryptionKey: props.kmsKey,
      pointInTimeRecovery: true,
      timeToLiveAttribute: "ExpiresAt",
      removalPolicy: cdk.RemovalPolicy.DESTROY
    });

    // Etcd member tracking table
    this.etcdMemberTable = new dynamodb.Table(this, "EtcdMemberTable", {
      tableName: `${props.clusterName}-etcd-members`,
      partitionKey: {
        name: "ClusterId",
        type: dynamodb.AttributeType.STRING
      },
      sortKey: {
        name: "MemberId",
        type: dynamodb.AttributeType.STRING
      },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.CUSTOMER_MANAGED,
      encryptionKey: props.kmsKey,
      pointInTimeRecovery: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY
    });

    // Global secondary indexes
    this.etcdMemberTable.addGlobalSecondaryIndex({
      indexName: "InstanceIdIndex",
      partitionKey: {
        name: "InstanceId",
        type: dynamodb.AttributeType.STRING
      },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    this.etcdMemberTable.addGlobalSecondaryIndex({
      indexName: "IpAddressIndex",
      partitionKey: {
        name: "PrivateIp",
        type: dynamodb.AttributeType.STRING,
      },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // S3 bucket for bootstrap manifests
    this.bootstrapBucket = new s3.Bucket(this, "BootstrapBucket", {
      bucketName: `${props.clusterName}-bootstrap-${this.node.addr.slice(-8)}`,
      encryption: s3.BucketEncryption.KMS,
      encryptionKey: props.kmsKey,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      versioned: true,
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      lifecycleRules: [{
        id: 'DeleteOldVersions',
        enabled: true,
        noncurrentVersionExpiration: cdk.Duration.days(30)
      }]
    });

    // S3 bucket for OIDC discovery documents (IRSA)
    // This bucket must allow public read for AWS STS to validate tokens
    // Bucket name must be deterministic so IAM stack can construct the correct OIDC URL
    this.oidcBucket = new s3.Bucket(this, "OidcBucket", {
      bucketName: `${props.clusterName}-oidc-${cdk.Stack.of(this).account}`,
      encryption: s3.BucketEncryption.S3_MANAGED, // Use S3 managed encryption for public read compatibility
      blockPublicAccess: new s3.BlockPublicAccess({
        blockPublicAcls: true,
        ignorePublicAcls: true,
        blockPublicPolicy: false, // Allow public bucket policy for OIDC discovery
        restrictPublicBuckets: false
      }),
      versioned: false,
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true
    });

    // Allow public read access to OIDC discovery documents
    this.oidcBucket.addToResourcePolicy(new cdk.aws_iam.PolicyStatement({
      actions: ['s3:GetObject'],
      resources: [`${this.oidcBucket.bucketArn}/.well-known/*`, `${this.oidcBucket.bucketArn}/keys.json`],
      principals: [new cdk.aws_iam.AnyPrincipal()]
    }));

    // S3 bucket for etcd backups
    this.etcdBackupBucket = new s3.Bucket(this, "EtcdBackupBucket", {
      bucketName: `${props.clusterName}-etcd-backup-${this.node.addr.slice(-8)}`,
      encryption: s3.BucketEncryption.KMS,
      encryptionKey: props.kmsKey,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      versioned: true,
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      lifecycleRules: [
        {
          id: 'DeleteOldBackups',
          enabled: true,
          expiration: cdk.Duration.days(30), // Keep backups for 30 days
        },
        {
          id: 'TransitionToInfrequentAccess',
          enabled: true,
          transitions: [
            {
              storageClass: s3.StorageClass.INFREQUENT_ACCESS,
              transitionAfter: cdk.Duration.days(7) // Move to IA after 7 days
            }
          ]
        }
      ]
    });

    // Note: Permissions are granted in the IAM stack to avoid circular dependencies
  }
}
