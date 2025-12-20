import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as kms from 'aws-cdk-lib/aws-kms';
import { Construct } from 'constructs';

export class DedicatedEc2K8sAutoscalerStack extends cdk.Stack {
  public readonly vpc: ec2.Vpc;
  public readonly kmsKey: kms.Key;
  public readonly ssmSecurityGroup: ec2.SecurityGroup;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Pre-req: KMS CMK with rotation enabled
    this.kmsKey = new kms.Key(this, 'K8sAutoscalerKey', {
      description: 'KMS key for K8s autoscaler encryption',
      enableKeyRotation: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY
    });

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
  }
}
