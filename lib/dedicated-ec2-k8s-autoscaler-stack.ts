import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { Construct } from 'constructs';

export class DedicatedEc2K8sAutoscalerStack extends cdk.Stack {
  public readonly vpc: ec2.Vpc;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

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
