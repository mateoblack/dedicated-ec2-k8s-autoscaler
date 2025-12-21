import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import { Construct } from 'constructs';

export interface NetworkStackProps extends cdk.StackProps {
  readonly clusterName: string;
}

export class NetworkStack extends cdk.Stack {
  public readonly vpc: ec2.Vpc;
  public readonly ssmSecurityGroup: ec2.SecurityGroup;
  public readonly controlPlaneSecurityGroup: ec2.SecurityGroup;
  public readonly workerSecurityGroup: ec2.SecurityGroup;
  public readonly controlPlaneLoadBalancer: elbv2.NetworkLoadBalancer;
  public readonly controlPlaneTargetGroup: elbv2.NetworkTargetGroup;

  constructor(scope: Construct, id: string, props: NetworkStackProps) {
    super(scope, id, props);

    // Create VPC with dedicated tenancy
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

    this.vpc.addInterfaceEndpoint('SSMMessagesEndpoint', {
      service: ec2.InterfaceVpcEndpointAwsService.SSM_MESSAGES,
      securityGroups: [this.ssmSecurityGroup]
    });

    this.vpc.addInterfaceEndpoint('EC2MessagesEndpoint', {
      service: ec2.InterfaceVpcEndpointAwsService.EC2_MESSAGES,
      securityGroups: [this.ssmSecurityGroup]
    });

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

    // Kubernetes security groups
    this.controlPlaneSecurityGroup = new ec2.SecurityGroup(this, 'ControlPlaneSecurityGroup', {
      vpc: this.vpc,
      description: `Security group for Kubernetes control plane nodes in ${props.clusterName} cluster`,
      allowAllOutbound: true
    });

    this.workerSecurityGroup = new ec2.SecurityGroup(this, 'WorkerSecurityGroup', {
      vpc: this.vpc,
      description: `Security group for Kubernetes worker nodes in ${props.clusterName} cluster`,
      allowAllOutbound: true
    });

    // Control plane security group rules
    // CP SG allows all traffic from itself (using CfnSecurityGroupIngress to avoid circular dependency)
    new ec2.CfnSecurityGroupIngress(this, 'ControlPlaneSelfIngress', {
      groupId: this.controlPlaneSecurityGroup.securityGroupId,
      sourceSecurityGroupId: this.controlPlaneSecurityGroup.securityGroupId,
      ipProtocol: '-1',
      description: 'Allow all traffic from control plane nodes'
    });

    // CP SG allows TCP 6443 from worker SG (using CfnSecurityGroupIngress to avoid circular dependency)
    new ec2.CfnSecurityGroupIngress(this, 'ControlPlaneApiServerIngress', {
      groupId: this.controlPlaneSecurityGroup.securityGroupId,
      sourceSecurityGroupId: this.workerSecurityGroup.securityGroupId,
      ipProtocol: 'tcp',
      fromPort: 6443,
      toPort: 6443,
      description: 'Allow API server access from worker nodes'
    });

    // Worker security group rules
    // Worker SG allows all traffic from itself (using CfnSecurityGroupIngress to avoid circular dependency)
    new ec2.CfnSecurityGroupIngress(this, 'WorkerSelfIngress', {
      groupId: this.workerSecurityGroup.securityGroupId,
      sourceSecurityGroupId: this.workerSecurityGroup.securityGroupId,
      ipProtocol: '-1',
      description: 'Allow all traffic from worker nodes'
    });

    // Worker SG allows all traffic from CP SG (using CfnSecurityGroupIngress to avoid circular dependency)
    new ec2.CfnSecurityGroupIngress(this, 'WorkerFromControlPlaneIngress', {
      groupId: this.workerSecurityGroup.securityGroupId,
      sourceSecurityGroupId: this.controlPlaneSecurityGroup.securityGroupId,
      ipProtocol: '-1',
      description: 'Allow all traffic from control plane nodes'
    });

    // Control plane load balancer (internal NLB)
    this.controlPlaneLoadBalancer = new elbv2.NetworkLoadBalancer(this, 'ControlPlaneLoadBalancer', {
      vpc: this.vpc,
      internetFacing: false,
      vpcSubnets: {
        subnetGroupName: 'ControlPlane'
      }
    });

    // Target group for control plane nodes
    this.controlPlaneTargetGroup = new elbv2.NetworkTargetGroup(this, 'ControlPlaneTargetGroup', {
      port: 6443,
      protocol: elbv2.Protocol.TCP,
      targetType: elbv2.TargetType.INSTANCE,
      vpc: this.vpc,
      healthCheck: {
        protocol: elbv2.Protocol.TCP,
        port: '6443',
        interval: cdk.Duration.seconds(30)
      }
    });

    // Listener for API server
    this.controlPlaneLoadBalancer.addListener('ControlPlaneListener', {
      port: 6443,
      protocol: elbv2.Protocol.TCP,
      defaultTargetGroups: [this.controlPlaneTargetGroup]
    });
  }
}
