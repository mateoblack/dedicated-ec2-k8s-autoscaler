import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import { Construct } from 'constructs';

export interface IamStackProps extends cdk.StackProps {
  readonly clusterName: string;
  readonly kmsKey?: kms.IKey;
}

export class IamStack extends cdk.Stack {
  public readonly controlPlaneRole: iam.Role;
  public readonly workerNodeRole: iam.Role;
  public readonly kmsKey: kms.IKey;

  constructor(scope: Construct, id: string, props: IamStackProps) {
    super(scope, id, props);

    // Create or use provided KMS key
    this.kmsKey = props.kmsKey ?? new kms.Key(this, "ClusterCMK", {
      enableKeyRotation: true,
      description: `CMK KMS for DedicatedEc2K8s: ${props.clusterName}`,
      alias: `alias/${props.clusterName}`,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // Control plane role - can autoscale workers
    this.controlPlaneRole = new iam.Role(this, "ControlPlaneRole", {
      roleName: `${props.clusterName}-control-plane-role`,
      description: `IAM role for Kubernetes control plane nodes in ${props.clusterName} cluster`,
      assumedBy: new iam.ServicePrincipal("ec2.amazonaws.com"),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName("AmazonSSMManagedInstanceCore"),
      ]
    });

    // Worker node role - no autoscaling permissions
    this.workerNodeRole = new iam.Role(this, "WorkerNodeRole", {
      roleName: `${props.clusterName}-worker-node-role`,
      description: `IAM role for Kubernetes worker nodes in ${props.clusterName} cluster`,
      assumedBy: new iam.ServicePrincipal("ec2.amazonaws.com"),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName("AmazonSSMManagedInstanceCore"),
      ]
    });

    // Shared permissions for both roles
    this.kmsKey.grantEncryptDecrypt(this.controlPlaneRole);
    this.kmsKey.grantEncryptDecrypt(this.workerNodeRole);

    this.addSSMPermissions(this.controlPlaneRole, props.clusterName);
    this.addSSMPermissions(this.workerNodeRole, props.clusterName);

    this.addCloudWatchPermissions(this.controlPlaneRole, props.clusterName);
    this.addCloudWatchPermissions(this.workerNodeRole, props.clusterName);

    // DynamoDB permissions for bootstrap and etcd member tables (both roles need access)
    this.addDynamoDBPermissions(this.controlPlaneRole, props.clusterName);
    this.addDynamoDBPermissions(this.workerNodeRole, props.clusterName);

    // S3 permissions for bootstrap bucket (both roles need access)
    this.addS3Permissions(this.controlPlaneRole, props.clusterName);
    this.addS3Permissions(this.workerNodeRole, props.clusterName);

    // Control plane specific permissions - can autoscale workers
    this.controlPlaneRole.addToPolicy(new iam.PolicyStatement({
      actions: [
        "autoscaling:DescribeAutoScalingGroups",
        "autoscaling:DescribeAutoScalingInstances",
        "autoscaling:DescribeLaunchConfigurations",
        "autoscaling:DescribeTags",
        "autoscaling:SetDesiredCapacity",
        "autoscaling:TerminateInstanceInAutoScalingGroup",
        "ec2:DescribeInstances",
        "ec2:DescribeRegions",
        "ec2:DescribeRouteTables",
        "ec2:DescribeSecurityGroups",
        "ec2:DescribeSubnets",
        "ec2:DescribeVolumes",
        "ec2:CreateSecurityGroup",
        "ec2:CreateTags",
        "ec2:CreateVolume",
        "ec2:ModifyInstanceAttribute",
        "ec2:ModifyVolume",
        "ec2:AttachVolume",
        "ec2:AuthorizeSecurityGroupIngress",
        "ec2:CreateRoute",
        "ec2:DeleteRoute",
        "ec2:DeleteSecurityGroup",
        "ec2:DeleteVolume",
        "ec2:DetachVolume",
        "ec2:RevokeSecurityGroupIngress",
        "ec2:DescribeVpcs",
        "elasticloadbalancing:*"
      ],
      resources: ["*"],
      conditions: {
        StringEquals: {
          "aws:RequestedRegion": this.region
        }
      }
    }));
  }

  private addSSMPermissions(role: iam.Role, clusterName: string) {
    role.addToPolicy(new iam.PolicyStatement({
      actions: [
        "ssm:GetParameter",
        "ssm:GetParameters",
        "ssm:PutParameter",
        "ssm:DeleteParameter",
        "ssm:DescribeParameters",
      ],
      resources: [
        `arn:aws:ssm:${this.region}:${this.account}:parameter/${clusterName}/*`
      ]
    }));
  }

  private addCloudWatchPermissions(role: iam.Role, clusterName: string) {
    role.addToPolicy(new iam.PolicyStatement({
      actions: [
        "logs:CreateLogGroup",
        "logs:CreateLogStream",
        "logs:PutLogEvents",
        "logs:DescribeLogStreams"
      ],
      resources: [
        `arn:aws:logs:${this.region}:${this.account}:log-group:/aws/kubernetes/${clusterName}/*`
      ]
    }));
  }

  private addDynamoDBPermissions(role: iam.Role, clusterName: string) {
    role.addToPolicy(new iam.PolicyStatement({
      actions: [
        "dynamodb:GetItem",
        "dynamodb:PutItem",
        "dynamodb:UpdateItem",
        "dynamodb:DeleteItem",
        "dynamodb:Query",
        "dynamodb:Scan"
      ],
      resources: [
        `arn:aws:dynamodb:${this.region}:${this.account}:table/${clusterName}-bootstrap-lock`,
        `arn:aws:dynamodb:${this.region}:${this.account}:table/${clusterName}-etcd-members`,
        `arn:aws:dynamodb:${this.region}:${this.account}:table/${clusterName}-etcd-members/index/*`
      ]
    }));
  }

  private addS3Permissions(role: iam.Role, clusterName: string) {
    role.addToPolicy(new iam.PolicyStatement({
      actions: [
        "s3:GetObject",
        "s3:PutObject",
        "s3:DeleteObject",
        "s3:ListBucket"
      ],
      resources: [
        `arn:aws:s3:::${clusterName}-bootstrap-*`,
        `arn:aws:s3:::${clusterName}-bootstrap-*/*`
      ]
    }));
  }
}
