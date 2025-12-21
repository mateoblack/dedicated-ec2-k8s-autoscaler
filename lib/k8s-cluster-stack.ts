import * as cdk from 'aws-cdk-lib';
import * as kms from 'aws-cdk-lib/aws-kms';
import { Construct } from 'constructs';
import { ServicesStack } from './services-stack';
import { NetworkStack } from './network-stack';
import { IamStack } from './iam-stack';
import { DatabaseStack } from './database-stack';

export interface K8sClusterStackProps extends cdk.StackProps {
  readonly clusterName: string;
  readonly kmsKey?: kms.IKey;
}

export class K8sClusterStack extends cdk.Stack {
  public readonly servicesStack: ServicesStack;
  public readonly networkStack: NetworkStack;
  public readonly iamStack: IamStack;
  public readonly databaseStack: DatabaseStack;

  constructor(scope: Construct, id: string, props: K8sClusterStackProps) {
    super(scope, id, props);

    // IAM stack (roles, policies, KMS) - deployed first
    this.iamStack = new IamStack(this, 'IAM', {
      clusterName: props.clusterName,
      kmsKey: props.kmsKey
    });

    // Services stack (validation, parameters)
    this.servicesStack = new ServicesStack(this, 'Services', {
      clusterName: props.clusterName
    });

    // Network stack (VPC, subnets, endpoints)
    this.networkStack = new NetworkStack(this, 'Network', {
      clusterName: props.clusterName
    });

    // Database stack (DynamoDB, S3)
    this.databaseStack = new DatabaseStack(this, 'Database', {
      clusterName: props.clusterName,
      kmsKey: this.iamStack.kmsKey,
      nodeRole: this.iamStack.nodeRole
    });
  }
}
