import * as cdk from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';

export interface DatabaseStackProps extends cdk.StackProps {
  readonly clusterName: string;
  readonly kmsKey: kms.IKey;
  readonly nodeRole: iam.Role;
}

export class DatabaseStack extends cdk.Stack {
  public readonly bootstrapLockTable: dynamodb.Table;
  public readonly etcdMemberTable: dynamodb.Table;
  public readonly bootstrapBucket: s3.Bucket;

  constructor(scope: Construct, id: string, props: DatabaseStackProps) {
    super(scope, id, props);

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

    // Note: Permissions are granted in the IAM stack to avoid circular dependencies
  }
}
