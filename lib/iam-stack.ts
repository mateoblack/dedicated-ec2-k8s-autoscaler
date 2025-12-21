import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import { Construct } from 'constructs';

export interface IamStackProps extends cdk.StackProps {
  readonly clusterName: string;
  readonly kmsKey?: kms.IKey;
}

export class IamStack extends cdk.Stack {
  public readonly nodeRole: iam.Role;
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

    // IAM role for Kubernetes nodes
    this.nodeRole = new iam.Role(this, "NodeRole", {
      roleName: `${props.clusterName}-node-role`,
      description: `IAM role for Kubernetes nodes in ${props.clusterName} cluster`,
      assumedBy: new iam.ServicePrincipal("ec2.amazonaws.com"),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName("AmazonSSMManagedInstanceCore"),
      ]
    });

    // Grant KMS permissions
    this.kmsKey.grantEncryptDecrypt(this.nodeRole);

    // SSM parameter permissions
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

    // CloudWatch Logs permissions
    this.nodeRole.addToPolicy(new iam.PolicyStatement({
      actions: [
        "logs:CreateLogGroup",
        "logs:CreateLogStream",
        "logs:PutLogEvents",
        "logs:DescribeLogStreams"
      ],
      resources: [
        `arn:aws:logs:${this.region}:${this.account}:log-group:/aws/kubernetes/${props.clusterName}`
      ]
    }));

    // DynamoDB permissions for bootstrap and etcd member tables
    this.nodeRole.addToPolicy(new iam.PolicyStatement({
      actions: [
        "dynamodb:GetItem",
        "dynamodb:PutItem",
        "dynamodb:UpdateItem",
        "dynamodb:DeleteItem",
        "dynamodb:Query",
        "dynamodb:Scan"
      ],
      resources: [
        `arn:aws:dynamodb:${this.region}:${this.account}:table/${props.clusterName}-bootstrap-lock`,
        `arn:aws:dynamodb:${this.region}:${this.account}:table/${props.clusterName}-etcd-members`,
        `arn:aws:dynamodb:${this.region}:${this.account}:table/${props.clusterName}-etcd-members/index/*`
      ]
    }));

    // S3 permissions for bootstrap bucket
    this.nodeRole.addToPolicy(new iam.PolicyStatement({
      actions: [
        "s3:GetObject",
        "s3:PutObject",
        "s3:DeleteObject",
        "s3:ListBucket"
      ],
      resources: [
        `arn:aws:s3:::${props.clusterName}-bootstrap-*`,
        `arn:aws:s3:::${props.clusterName}-bootstrap-*/*`
      ]
    }));

    

  }
}
