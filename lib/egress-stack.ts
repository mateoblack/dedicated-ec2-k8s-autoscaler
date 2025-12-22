import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { NetworkStack } from './network-stack';
import { Construct } from 'constructs';

export interface EgressStackProps extends cdk.StackProps {
  readonly vpc: ec2.Vpc;
  readonly clusterName: string;
}

export class EgressStack extends cdk.Stack {
  public readonly natGateway: ec2.CfnNatGateway;

  constructor(scope: Construct, id: string, props: EgressStackProps) {
    super(scope, id, props);

    // Create single public subnet for NAT Gateway only
    const publicSubnet = new ec2.CfnSubnet(this, 'NATGatewaySubnet', {
      vpcId: props.vpc.vpcId,
      cidrBlock: '10.0.100.0/24',
      availabilityZone: cdk.Stack.of(this).availabilityZones[0],
      mapPublicIpOnLaunch: false,
      tags: [{ key: 'Name', value: 'NAT-Gateway-Subnet' }]
    });

    // Create route table for public subnet
    const publicRouteTable = new ec2.CfnRouteTable(this, 'PublicRouteTable', {
      vpcId: props.vpc.vpcId,
      tags: [{ key: 'Name', value: 'NAT-Gateway-RouteTable' }]
    });

    // Associate route table with subnet
    new ec2.CfnSubnetRouteTableAssociation(this, 'PublicSubnetAssociation', {
      subnetId: publicSubnet.ref,
      routeTableId: publicRouteTable.ref
    });

    // Create Internet Gateway (if not exists)
    const igw = new ec2.CfnInternetGateway(this, 'InternetGateway');
    
    new ec2.CfnVPCGatewayAttachment(this, 'IGWAttachment', {
      vpcId: props.vpc.vpcId,
      internetGatewayId: igw.ref
    });

    // Add route to IGW only for NAT Gateway subnet
    new ec2.CfnRoute(this, 'NATGatewayRoute', {
      routeTableId: publicRouteTable.ref,
      destinationCidrBlock: '0.0.0.0/0',
      gatewayId: igw.ref
    });

    // Create NAT Gateway in public subnet
    const eip = new ec2.CfnEIP(this, 'NATGatewayEIP', {
      domain: 'vpc'
    });

    const natGateway = new ec2.CfnNatGateway(this, 'NATGateway', {
      subnetId: publicSubnet.ref,
      allocationId: eip.attrAllocationId
    });

    this.natGateway = natGateway as any;

    // Add routes from private subnets to NAT Gateway
    const privateSubnets = props.vpc.privateSubnets;
    
    // Try to get specific subnet groups if they exist, otherwise use all private subnets
    try {
      const controlPlaneSubnets = props.vpc.selectSubnets({ subnetGroupName: 'ControlPlane' }).subnets;
      const dataPlaneSubnets = props.vpc.selectSubnets({ subnetGroupName: 'DataPlane' }).subnets;
      const managementSubnets = props.vpc.selectSubnets({ subnetGroupName: 'Management' }).subnets;
      privateSubnets.push(...controlPlaneSubnets, ...dataPlaneSubnets, ...managementSubnets);
    } catch {
      // Use existing private subnets if specific groups don't exist
    }

    privateSubnets.forEach((subnet, index) => {
      new ec2.CfnRoute(this, `PrivateRoute${index + 1}`, {
        routeTableId: subnet.routeTable.routeTableId,
        destinationCidrBlock: '0.0.0.0/0',
        natGatewayId: natGateway.ref
      });
    });
  }
}
