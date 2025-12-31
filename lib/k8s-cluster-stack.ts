import * as cdk from 'aws-cdk-lib';
import * as kms from 'aws-cdk-lib/aws-kms';
import { Construct } from 'constructs';
import { ServicesStack } from './services-stack';
import { NetworkStack } from './network-stack';
import { IamStack } from './iam-stack';
import { DatabaseStack } from './database-stack';
import { ComputeStack } from './compute-stack';

export interface K8sClusterStackProps extends cdk.StackProps {
  readonly clusterName: string;
  readonly kmsKey?: kms.IKey;
}

export class K8sClusterStack extends cdk.Stack {
  public readonly servicesStack: ServicesStack;
  public readonly networkStack: NetworkStack;
  public readonly iamStack: IamStack;
  public readonly databaseStack: DatabaseStack;
  public readonly computeStack: ComputeStack;

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
      kmsKey: this.iamStack.kmsKey
    });

    // Grant control plane write access to OIDC bucket
    this.databaseStack.oidcBucket.grantReadWrite(this.iamStack.controlPlaneRole);

    // Grant control plane write access to etcd backup bucket
    this.databaseStack.etcdBackupBucket.grantReadWrite(this.iamStack.controlPlaneRole);

    // Compute stack (launch templates, auto scaling groups)
    this.computeStack = new ComputeStack(this, 'Compute', {
      clusterName: props.clusterName,
      controlPlaneRole: this.iamStack.controlPlaneRole,
      workerNodeRole: this.iamStack.workerNodeRole,
      kmsKey: this.iamStack.kmsKey,
      controlPlaneSecurityGroup: this.networkStack.controlPlaneSecurityGroup,
      workerSecurityGroup: this.networkStack.workerSecurityGroup,
      controlPlaneLoadBalancer: this.networkStack.controlPlaneLoadBalancer,
      controlPlaneTargetGroup: this.networkStack.controlPlaneTargetGroup,
      controlPlaneSubnets: this.networkStack.controlPlaneSubnets,
      workerSubnets: this.networkStack.vpc.selectSubnets({ subnetGroupName: 'DataPlane' }).subnets,
      vpc: this.networkStack.vpc,
      kubernetesVersionParameter: this.servicesStack.kubernetesVersionParameter,
      clusterEndpointParameter: this.servicesStack.clusterEndpointParameter,
      joinTokenParameter: this.servicesStack.joinTokenParameter,
      clusterCaCertHashParameter: this.servicesStack.clusterCaCertHashParameter,
      clusterInitializedParameter: this.servicesStack.clusterInitializedParameter,
      etcdMemberTable: this.databaseStack.etcdMemberTable,
      oidcProviderArn: this.iamStack.oidcProvider.openIdConnectProviderArn,
      oidcBucketName: this.databaseStack.oidcBucket.bucketName,
      etcdBackupBucketName: this.databaseStack.etcdBackupBucket.bucketName,
    });
  }
}
