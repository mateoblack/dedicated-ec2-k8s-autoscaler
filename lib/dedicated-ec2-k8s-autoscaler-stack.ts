import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';

export interface DedicatedEc2K8sAutoscalerProps {
  readonly clusterName: string;
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
  public readonly nodeRole: iam.Role;
  public readonly bootstrapBucket: s3.Bucket;

  constructor(scope: Construct, id: string, props: DedicatedEc2K8sAutoscalerProps) {
    super(scope, id);

    // IMPORTANT self-healing parameters used by SSM 
    this.workerJoinParameterName = `/${props.clusterName}/kubeadm/worker-join`;
    this.controlPlaneJoinParameter = `/${props.clusterName}/kubeadm/control-plane-join`;
    this.oidcIssuerParameterName = `/${props.clusterName}/kubeadm/oidc-issuer`;

    // Pre-req section

    // things nodes could do so, a very important security item which should be reviewed
    this.nodeRole = new iam.Role(this,"NodeRole",{
      roleName: `${props.clusterName}-node-role`,
      description: `IAM role for Kubernetes nodes in ${props.clusterName} cluster`,
      assumedBy: new iam.ServicePrincipal("ec2.amazonaws.com"),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName("AmazonSSMManagedInstanceCore"),
      ]
    });

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

    // KMS Section 
    
    // Create or use provided kms key
    this.kmsKey = props.kmsKey ?? new kms.Key(this, "ClusterCMK", {
      enableKeyRotation: true,
      description: `CMK KMS for DedicatedEc2K8s: ${props.clusterName}`,
      alias: `alias/${props.clusterName}`,
      removalPolicy: cdk.RemovalPolicy.RETAIN, //IMPORTANT: Don't delete key on stack deletion
    });

    // Permissions 
    // nodes can encrypt/decrypt a important security consideration 
    this.kmsKey.grantEncryptDecrypt(this.nodeRole);

    // Nodes can DescribeKey a imporant security consideration 
    this.nodeRole.addToPolicy(new iam.PolicyStatement({
      actions: [
        "ssm:GetParameter",
        "ssm:GetParameters",
        "ssm:PutParameter",
        "ssm:DeletedParameter",
        "ssm:DescribedParameters",
      ],
      resources: [
        `arn:aws:ssm:${this.region}:${this.account}:parameter/${props.clusterName}/*`
      ]
    }));


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

    // S3 Bucket Section

    // nodes can read from s3 

    // s3 bucket for manifest files
    this.bootstrapBucket = new s3.Bucket(this, "BootstrapBucket", {
      bucketName: `${props.clusterName}-bootstrap-${this.node.addr.slice(-8)}`,
      encryption: s3.BucketEncryption.KMS,
      encryptionKey: this.kmsKey,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      versioned: true,
      enforceSSL: true, 
      removalPolicy: cdk.RemovalPolicy.DESTROY, // IMPORTANT In prod, consider RETAIN
      lifecycleRules: [{
        noncurrentVersionExpiration: cdk.Duration.days(90),
      },
    ],
    });

    // grant nodes read permissions to bootstrap bucket a security consideration
    this.bootstrapBucket.grantRead(this.nodeRole);

    // Leader needs write access to upload generated configs a important security consideration
    this.bootstrapBucket.grantWrite(this.nodeRole);


    // SSM Section 

    // Permissions 

    // Let nodes modify SSM. Another imporant security item
    this.nodeRole.addToPolicy(new iam.PolicyStatement({
      sid: "SsmParameterAccess",
      effect: iam.Effect.ALLOW,
      actions: [
        "ssm:GetParameter",
        "ssm:GetParameter",
        "ssm:PutParameter",
        "ssm:DeleteParameter",
        "ssm:DescribeParameters",
      ],
      resources: [
        `arn:aws:ssm:${this.region}:${this.account}:parameter/${props.clusterName}/*`
      ],
    }));

    // EC2 Section

    // Permissions

    // allow nodes to describe things 
    this.nodeRole.addToPolicy(new iam.PolicyStatement({
      actions: [
        "ec2:DescribeInstances",
        "ec2:DecsribeInstanceTypes",
        "ec2:DescribeRegions",
        "ec2:DescribeAvailabilityZones",
        "ec2:DescribeTags",
      ],
      resources: ["*"],
    }));

    // nodes can attach/detach ebs volumes for EBS CSI driver if not using COMMENT OUT 
    this.nodeRole.addToPolicy(new iam.PolicyStatement({
      actions: [
        "ec2:AttachVolume",
        "ec2:DetechVolume",
        "ec2:DescribeVolumes",
        "ec2:DescribeVolumeStatus",
        "ec2:CreateVolume",
        "ec2:DeleteVolume",
        "ec2:CreateTags",
      ],
      resources: ["*"],
      conditions: {
        StringEquals: {
          "ec2:ResourceTags/kubernetes.io/cluster/${props.clusterName}":"owned",
        },
      },
    }));

    // AutoScaling Permissions 

    // Nodes need to query there own ASGs for metadata
    this.nodeRole.addToPolicy(new iam.PolicyStatement({
      actions: [
        "autoscaling:DescribeAutoScalingGroups",
        "autoscaling:DescribeAutoScalingInstances",
        "autoscaling:DescribeLaunchConfigurations",
        "autoscaling:DescribeTags",
      ],
      resources: ["*"],
    }));

    // ECR Section

    // Permissions 

    // If using ECR for private Containers otherwise COMMENT OUT
    this.nodeRole.addToPolicy(new iam.PolicyStatement({
      actions: [
        "ecr:GetAuthorizationToken",
        "ecr:BatchCheckLayerAvailability",
        "ecr:GetDownloadUrlForLayer",
        "ecr:BatchGetImage",
      ],
      resources: ["*"],
    }));

    // CloudWatch Logs Section

    // Permissisons 

    this.nodeRole.addToPolicy(new iam.PolicyStatement({
      actions: [
        "logs:CreateLogGroup",
        "logs:CreateLogStream",
        "logs:PutLogEvents",
        "logs:DescribeLogStreams",
      ],
      resources:[
        `arn:aws:logs:${this.region}:${this.account}:log-group:/aws/kubernetes/${[props.clusterName]}`
      ]
    }
    ));

    // Permissions - Grant access after resources are created
    // Grant read/write to bootstrap lock table
    this.bootstrapLockTable.grantReadWriteData(this.nodeRole);

    // Grant read/write to etcd member table 
    this.etcdMemberTable.grantReadWriteData(this.nodeRole);

  }
}
