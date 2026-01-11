import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import { Construct } from 'constructs';

export interface IamStackProps {
  readonly clusterName: string;
  readonly kmsKey?: kms.IKey;
}

export class IamStack extends Construct {
  public readonly controlPlaneRole: iam.Role;
  public readonly workerNodeRole: iam.Role;
  public readonly kmsKey: kms.IKey;
  public readonly oidcProvider: iam.OpenIdConnectProvider;
  public readonly clusterAutoscalerIrsaRole: iam.Role;

  constructor(scope: Construct, id: string, props: IamStackProps) {
    super(scope, id);

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

    // SSM permissions - control plane needs read/write, workers only need read
    this.addSSMPermissions(this.controlPlaneRole, props.clusterName, true);
    this.addSSMPermissions(this.workerNodeRole, props.clusterName, false);

    this.addCloudWatchPermissions(this.controlPlaneRole, props.clusterName);
    this.addCloudWatchPermissions(this.workerNodeRole, props.clusterName);

    // DynamoDB permissions - control plane needs full access, workers only need limited
    this.addDynamoDBPermissions(this.controlPlaneRole, props.clusterName, true);
    this.addDynamoDBPermissions(this.workerNodeRole, props.clusterName, false);

    // S3 permissions - control plane needs read/write, workers only need read
    this.addS3Permissions(this.controlPlaneRole, props.clusterName, true);
    this.addS3Permissions(this.workerNodeRole, props.clusterName, false);

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
        // ELB permissions - scoped to specific actions instead of wildcard
        "elasticloadbalancing:DescribeLoadBalancers",
        "elasticloadbalancing:DescribeLoadBalancerAttributes",
        "elasticloadbalancing:DescribeListeners",
        "elasticloadbalancing:DescribeListenerCertificates",
        "elasticloadbalancing:DescribeSSLPolicies",
        "elasticloadbalancing:DescribeRules",
        "elasticloadbalancing:DescribeTargetGroups",
        "elasticloadbalancing:DescribeTargetGroupAttributes",
        "elasticloadbalancing:DescribeTargetHealth",
        "elasticloadbalancing:DescribeTags",
        "elasticloadbalancing:CreateLoadBalancer",
        "elasticloadbalancing:CreateTargetGroup",
        "elasticloadbalancing:CreateListener",
        "elasticloadbalancing:CreateRule",
        "elasticloadbalancing:DeleteLoadBalancer",
        "elasticloadbalancing:DeleteTargetGroup",
        "elasticloadbalancing:DeleteListener",
        "elasticloadbalancing:DeleteRule",
        "elasticloadbalancing:ModifyLoadBalancerAttributes",
        "elasticloadbalancing:ModifyTargetGroup",
        "elasticloadbalancing:ModifyTargetGroupAttributes",
        "elasticloadbalancing:ModifyListener",
        "elasticloadbalancing:ModifyRule",
        "elasticloadbalancing:RegisterTargets",
        "elasticloadbalancing:DeregisterTargets",
        "elasticloadbalancing:SetIpAddressType",
        "elasticloadbalancing:SetSecurityGroups",
        "elasticloadbalancing:SetSubnets",
        "elasticloadbalancing:AddTags",
        "elasticloadbalancing:RemoveTags"
      ],
      resources: ["*"],
      conditions: {
        StringEquals: {
          "aws:RequestedRegion": cdk.Stack.of(this).region
        }
      }
    }));

    // Create OIDC Identity Provider for IRSA (self-managed cluster)
    // For self-managed K8s with S3-hosted OIDC discovery, the URL must match
    // the --service-account-issuer used by the API server (set in compute-stack bootstrap)
    const oidcBucketName = `${props.clusterName}-oidc-${cdk.Stack.of(this).account}`;
    const oidcUrl = `https://s3.${cdk.Stack.of(this).region}.amazonaws.com/${oidcBucketName}`;

    this.oidcProvider = new iam.OpenIdConnectProvider(this, 'OIDCProvider', {
      url: oidcUrl,
      clientIds: ['sts.amazonaws.com'],
      // S3 TLS certificate thumbprint (Amazon Trust Services)
      thumbprints: ['9e99a48a9960b14926bb7f3b02e22da2b0ab7280']
    });

    // Create IRSA role for cluster-autoscaler without conditions first
    this.clusterAutoscalerIrsaRole = new iam.Role(this, 'ClusterAutoscalerIrsaRole', {
      roleName: `${props.clusterName}-cluster-autoscaler-irsa`,
      description: `IRSA role for cluster-autoscaler in ${props.clusterName} cluster`,
      assumedBy: new iam.WebIdentityPrincipal(this.oidcProvider.openIdConnectProviderArn)
    });

    // Override assume role policy with CfnJson for proper token resolution
    const cfnRole = this.clusterAutoscalerIrsaRole.node.defaultChild as iam.CfnRole;
    const conditionJson = new cdk.CfnJson(this, 'IrsaCondition', {
      value: {
        StringEquals: {
          [`${oidcUrl}:aud`]: 'sts.amazonaws.com',
          [`${oidcUrl}:sub`]: 'system:serviceaccount:kube-system:cluster-autoscaler'
        }
      }
    });

    cfnRole.assumeRolePolicyDocument = {
      Version: '2012-10-17',
      Statement: [{
        Effect: 'Allow',
        Principal: {
          Federated: this.oidcProvider.openIdConnectProviderArn
        },
        Action: 'sts:AssumeRoleWithWebIdentity',
        Condition: conditionJson
      }]
    };

    // Add cluster-autoscaler permissions to IRSA role
    // Describe actions require resource: * (AWS API limitation)
    this.clusterAutoscalerIrsaRole.addToPolicy(new iam.PolicyStatement({
      actions: [
        'autoscaling:DescribeAutoScalingGroups',
        'autoscaling:DescribeAutoScalingInstances',
        'autoscaling:DescribeLaunchConfigurations',
        'autoscaling:DescribeTags',
        'ec2:DescribeInstances',
        'ec2:DescribeLaunchTemplateVersions'
      ],
      resources: ['*']
    }));

    // Modification actions scoped to worker ASG only
    // Control plane ASG should never be scaled by the cluster autoscaler
    this.clusterAutoscalerIrsaRole.addToPolicy(new iam.PolicyStatement({
      actions: [
        'autoscaling:SetDesiredCapacity',
        'autoscaling:TerminateInstanceInAutoScalingGroup'
      ],
      resources: [
        `arn:aws:autoscaling:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:autoScalingGroup:*:autoScalingGroupName/${props.clusterName}-worker`
      ]
    }));

    // Control plane needs permission to update OIDC provider after cluster init
    this.controlPlaneRole.addToPolicy(new iam.PolicyStatement({
      actions: [
        'iam:UpdateOpenIDConnectProviderThumbprint',
        'iam:AddClientIDToOpenIDConnectProvider',
        'iam:GetOpenIDConnectProvider'
      ],
      resources: [this.oidcProvider.openIdConnectProviderArn]
    }));
  }

  private addSSMPermissions(role: iam.Role, clusterName: string, isControlPlane: boolean) {
    // Workers only need read access to SSM parameters
    const actions = isControlPlane
      ? [
          "ssm:GetParameter",
          "ssm:GetParameters",
          "ssm:PutParameter",
          "ssm:DeleteParameter",
          "ssm:DescribeParameters",
        ]
      : [
          "ssm:GetParameter",
          "ssm:GetParameters",
        ];

    role.addToPolicy(new iam.PolicyStatement({
      actions,
      resources: [
        `arn:aws:ssm:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:parameter/${clusterName}/*`
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
        `arn:aws:logs:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:log-group:/aws/kubernetes/${clusterName}/*`
      ]
    }));

    // PutMetricData requires resource: * (doesn't support resource-level permissions)
    role.addToPolicy(new iam.PolicyStatement({
      actions: [
        "cloudwatch:PutMetricData"
      ],
      resources: ["*"],
      conditions: {
        StringEquals: {
          "cloudwatch:namespace": `K8sCluster/${clusterName}`
        }
      }
    }));
  }

  private addDynamoDBPermissions(role: iam.Role, clusterName: string, isControlPlane: boolean) {
    // Workers only need limited DynamoDB access for bootstrap coordination
    // Control plane needs full access for etcd member management
    const actions = isControlPlane
      ? [
          "dynamodb:GetItem",
          "dynamodb:PutItem",
          "dynamodb:UpdateItem",
          "dynamodb:DeleteItem",
          "dynamodb:Query",
          "dynamodb:Scan"
        ]
      : [
          "dynamodb:GetItem",
          "dynamodb:PutItem",
          "dynamodb:UpdateItem",
          "dynamodb:Query"
        ];

    role.addToPolicy(new iam.PolicyStatement({
      actions,
      resources: [
        `arn:aws:dynamodb:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:table/${clusterName}-bootstrap-lock`,
        `arn:aws:dynamodb:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:table/${clusterName}-etcd-members`,
        `arn:aws:dynamodb:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:table/${clusterName}-etcd-members/index/*`
      ]
    }));
  }

  private addS3Permissions(role: iam.Role, clusterName: string, isControlPlane: boolean) {
    // Workers only need read access to S3 buckets
    // Control plane needs full access for OIDC and backups
    const actions = isControlPlane
      ? [
          "s3:GetObject",
          "s3:PutObject",
          "s3:DeleteObject",
          "s3:ListBucket"
        ]
      : [
          "s3:GetObject",
          "s3:ListBucket"
        ];

    // Bootstrap bucket access
    role.addToPolicy(new iam.PolicyStatement({
      actions,
      resources: [
        `arn:aws:s3:::${clusterName}-bootstrap-*`,
        `arn:aws:s3:::${clusterName}-bootstrap-*/*`
      ]
    }));

    // OIDC bucket access for IRSA token validation
    // Workers need read access to validate service account tokens
    role.addToPolicy(new iam.PolicyStatement({
      actions: [
        "s3:GetObject",
        "s3:ListBucket"
      ],
      resources: [
        `arn:aws:s3:::${clusterName}-oidc-*`,
        `arn:aws:s3:::${clusterName}-oidc-*/*`
      ]
    }));
  }
}
