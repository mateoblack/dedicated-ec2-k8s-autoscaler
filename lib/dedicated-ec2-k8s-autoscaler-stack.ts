import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as sms from 'aws-cdk-lib/aws-ssm';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';

export interface DedicatedEc2K8sAutoscalerProps {
  /** 
   *  Name of the K8s cluser (used for tagging, naming resources)
   *  Must be DNS-compatible (lowercase, numbers, hypens only)
   *  @example "production-cluster" or "dev-k8s"
   */

  readonly clusterName: string;

  // Optional: Allow a user to provide their own KMS key
  /** *
   *  KMS key for encrypting all resources
   *  If not provided, a new kms will be created automatically
   *  @default - A new KMS key is created with enabled 
   * 
  */

  readonly kmsKey?: kms.IKey;

}

export class DedicatedEc2K8sAutoscalerStack extends cdk.Stack {
  public readonly vpc: ec2.Vpc;
  public readonly kmsKey: kms.IKey;
  public readonly ssmSecurityGroup: ec2.SecurityGroup;
  public readonly bootstrapLockTable: cdk.aws_dynamodb.Table;
  public readonly etcdMemberTable: cdk.aws_dynamodb.Table;
  public readonly workerJoinParameterName: string;
  public readonly controlPlaneJoinParameter: string;
  public readonly oidcIssuerParameterName: string;

  constructor(scope: Construct, id: string, props: DedicatedEc2K8sAutoscalerProps) {
    super(scope, id);

    // IMPORTANT self-healing parameters. 
    this.workerJoinParameterName = `/${props.clusterName}/kubeadm/worker-join`;
    this.controlPlaneJoinParameter = `/${props.clusterName}/kubeadm/control-plane-join`;
    this.oidcIssuerParameterName = `/${props.clusterName}/kubeadm/oidc-issuer`;

    // Pre-req section

    // Validate Cluster Name 
    if (!props.clusterName || props.clusterName.length < 3) {
      throw new Error("clusterName must be at least 3 charaters")
    }

    // Validate DNS-compatiable Clustername
    if (!/^[a-z0-9-]+$/.test(props.clusterName)) {
      throw new Error(
        "clustername must only lowercase letters numbers and hyphens"
      );
    }

    // Create or use provided kms key
    this.kmsKey = props.kmsKey ?? new kms.Key(this, "ClusterCMK", {
      enableKeyRotation: true,
      description: `CMK KMS for DedicatedEc2K8s: ${props.clusterName}`,
      alias: `alias/${props.clusterName}`,
      removalPolicy: cdk.RemovalPolicy.RETAIN, //IMPORTANT: Don't delete key on stack deletion
    });

    // VPC Infra Section
    // 1. Create the VPC
    this.vpc = new ec2.Vpc(this, 'DedicatedVpc', {
      ipAddresses: ec2.IpAddresses.cidr('10.0.0.0/16'),
      defaultInstanceTenancy: ec2.DefaultInstanceTenancy.DEDICATED,
      subnetConfiguration: [
        {
          cidrMask: 24,
          name: 'ControlPlane',
          subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
        },
        {
          cidrMask: 24,
          name: 'DataPlane',
          subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
        },
        {
          cidrMask: 24,
          name: 'Management',
          subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
        }
      ],
      maxAzs: 3
    });

    // Security group for SSM access
    this.ssmSecurityGroup = new ec2.SecurityGroup(this, 'SSMSecurityGroup', {
      vpc: this.vpc,
      description: 'Security group for SSM endpoints',
      allowAllOutbound: false
    });

    this.ssmSecurityGroup.addIngressRule(
      ec2.Peer.ipv4(this.vpc.vpcCidrBlock),
      ec2.Port.tcp(443),
      'Allow HTTPS from VPC CIDR'
    );

    // VPC Endpoints for SSM
    this.vpc.addInterfaceEndpoint('SSMEndpoint', {
      service: ec2.InterfaceVpcEndpointAwsService.SSM,
      securityGroups: [this.ssmSecurityGroup]
    });

    // VPC Endpoints for SSM Messages
    this.vpc.addInterfaceEndpoint('SSMMessagesEndpoint', {
      service: ec2.InterfaceVpcEndpointAwsService.SSM_MESSAGES,
      securityGroups: [this.ssmSecurityGroup]
    });

    // VPC Endpoints for EC2 Messages
    this.vpc.addInterfaceEndpoint('EC2MessagesEndpoint', {
      service: ec2.InterfaceVpcEndpointAwsService.EC2_MESSAGES,
      securityGroups: [this.ssmSecurityGroup]
    });

    // VPC Endpoints for KMS Messages
    this.vpc.addInterfaceEndpoint('KMSEndpoint', {
      service: ec2.InterfaceVpcEndpointAwsService.KMS,
      securityGroups: [this.ssmSecurityGroup]
    });

    // Add secondary CIDR for pod communication
    const secondaryCidr = new ec2.CfnVPCCidrBlock(this, 'PodCommunicationCidr', {
      vpcId: this.vpc.vpcId,
      cidrBlock: '10.1.0.0/16'
    });

    // Create subnets in secondary CIDR for pod communication
    const azs = cdk.Stack.of(this).availabilityZones.slice(0, 3);
    azs.forEach((az, index) => {
      new ec2.CfnSubnet(this, `PodCommunicationSubnet${index + 1}`, {
        vpcId: this.vpc.vpcId,
        cidrBlock: `10.1.${index}.0/24`,
        availabilityZone: az,
        tags: [{ key: 'Name', value: `PodCommunication-${index + 1}` }]
      }).addDependency(secondaryCidr);
    });

    // Dynamodb Infra Section 

    // BootStrapLockTable 
    // needed for electing a k8 leader
    this.bootstrapLockTable = new cdk.aws_dynamodb.Table(this, "BootstrapLockTable",{
      tableName: `${props.clusterName}-bootstrap-lock`,
      partitionKey : {
        name: "LockName",
        type: cdk.aws_dynamodb.AttributeType.STRING
      },
      billingMode: cdk.aws_dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: cdk.aws_dynamodb.TableEncryption.CUSTOMER_MANAGED,
      encryptionKey: this.kmsKey,
      pointInTimeRecovery: true, 
      timeToLiveAttribute: "ExpiresAt",
      removalPolicy: cdk.RemovalPolicy.DESTROY // IMPORTANT In prod, consider RETAIN 
    });

    this.etcdMemberTable = new cdk.aws_dynamodb.Table(this, "EtcdMemberTable", {
      tableName: `${props.clusterName}-etcd-memebers`,
      partitionKey: {
        name: "Cluster Id",
        type: cdk.aws_dynamodb.AttributeType.STRING
      },
      sortKey: {
        name: "MemberId",
        type: cdk.aws_dynamodb.AttributeType.STRING
      },
      billingMode: cdk.aws_dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: cdk.aws_dynamodb.TableEncryption.CUSTOMER_MANAGED,
      encryptionKey: this.kmsKey,
      pointInTimeRecovery: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY, // IMPORTANT In prod, consider RETAIN
    });

    this.etcdMemberTable.addGlobalSecondaryIndex({
      indexName: "InstanceIdIndex",
      partitionKey: {
        name: "InstanceId",
        type: cdk.aws_dynamodb.AttributeType.STRING
      },
      projectionType: cdk.aws_dynamodb.ProjectionType.ALL,
    });

    this.etcdMemberTable.addGlobalSecondaryIndex({
      indexName: "IpAddressIndex",
      partitionKey: {
        name: "PrivateIp",
        type: cdk.aws_dynamodb.AttributeType.STRING,
      },
      projectionType: cdk.aws_dynamodb.ProjectionType.ALL,
    });
  }
}
