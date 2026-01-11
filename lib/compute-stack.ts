import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as autoscaling from 'aws-cdk-lib/aws-autoscaling';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import { Construct } from 'constructs';
import {
  createEtcdLifecycleLambdaCode,
  createEtcdBackupLambdaCode,
  createClusterHealthLambdaCode,
  createWorkerBootstrapScript,
  createControlPlaneBootstrapScript
} from './scripts';

export interface ComputeStackProps {
  readonly clusterName: string;
  readonly controlPlaneRole: iam.Role;
  readonly workerNodeRole: iam.Role;
  readonly kmsKey: kms.IKey;
  readonly controlPlaneSecurityGroup: ec2.SecurityGroup;
  readonly workerSecurityGroup: ec2.SecurityGroup;
  readonly controlPlaneLoadBalancer: elbv2.NetworkLoadBalancer;
  readonly controlPlaneTargetGroup: elbv2.NetworkTargetGroup;
  readonly controlPlaneSubnets: ec2.ISubnet[];
  readonly workerSubnets: ec2.ISubnet[];
  readonly vpc: ec2.IVpc;
  readonly kubernetesVersionParameter: ssm.StringParameter;
  readonly clusterEndpointParameter: ssm.StringParameter;
  readonly joinTokenParameter: ssm.StringParameter;
  readonly clusterCaCertHashParameter: ssm.StringParameter;
  readonly clusterInitializedParameter: ssm.StringParameter;
  readonly etcdMemberTable: dynamodb.Table;
  readonly oidcProviderArn: string;
  readonly oidcBucketName: string;
  readonly etcdBackupBucketName: string;
}

export class ComputeStack extends Construct {
  public readonly controlPlaneLaunchTemplate: ec2.LaunchTemplate;
  public readonly controlPlaneAutoScalingGroup: autoscaling.AutoScalingGroup;
  public readonly workerLaunchTemplate: ec2.LaunchTemplate;
  public readonly workerAutoScalingGroup: autoscaling.AutoScalingGroup;
  public readonly etcdLifecycleLambda: lambda.Function;
  public readonly etcdBackupLambda: lambda.Function;
  public readonly clusterHealthLambda: lambda.Function;

  constructor(scope: Construct, id: string, props: ComputeStackProps) {
    super(scope, id);

    // Create instance profile for control plane role
    const controlPlaneInstanceProfile = new iam.InstanceProfile(this, 'ControlPlaneInstanceProfile', {
      role: props.controlPlaneRole,
      instanceProfileName: `${props.clusterName}-control-plane-profile`
    });

    // Control plane launch template
    const controlPlaneAmiId = ssm.StringParameter.valueFromLookup(this, '/k8s-cluster/control-plane-ami-id');
    
    this.controlPlaneLaunchTemplate = new ec2.LaunchTemplate(this, 'ControlPlaneLaunchTemplate', {
      launchTemplateName: `${props.clusterName}-control-plane`,
      machineImage: ec2.MachineImage.genericLinux({
        [cdk.Stack.of(this).region]: controlPlaneAmiId,
      }),
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.M5, ec2.InstanceSize.LARGE), // K8s recommendation
      securityGroup: props.controlPlaneSecurityGroup,
      role: props.controlPlaneRole,
      userData: ec2.UserData.forLinux({
        shebang: '#!/bin/bash'
      }),
      blockDevices: [{
        deviceName: '/dev/xvda',
        volume: ec2.BlockDeviceVolume.ebs(150, {
          volumeType: ec2.EbsDeviceVolumeType.GP3,
          encrypted: true,
          kmsKey: props.kmsKey
        })
      }],
      requireImdsv2: true,
      detailedMonitoring: true
    });

    // Add control plane bootstrap script
    this.controlPlaneLaunchTemplate.userData?.addCommands(
      createControlPlaneBootstrapScript(props.clusterName, props.oidcProviderArn, props.oidcBucketName, props.etcdBackupBucketName, cdk.Stack.of(this))
    );

    // Set dedicated tenancy and fix IMDS configuration
    const cfnLaunchTemplate = this.controlPlaneLaunchTemplate.node.defaultChild as ec2.CfnLaunchTemplate;
    cfnLaunchTemplate.addPropertyOverride('LaunchTemplateData.Placement.Tenancy', 'dedicated');
    cfnLaunchTemplate.addPropertyOverride('LaunchTemplateData.IamInstanceProfile.Name', controlPlaneInstanceProfile.instanceProfileName);
    cfnLaunchTemplate.addPropertyOverride('LaunchTemplateData.MetadataOptions.HttpPutResponseHopLimit', 2);

    // Create VPC from subnets
    const vpc = props.vpc;

    // Control plane Auto Scaling Group
    this.controlPlaneAutoScalingGroup = new autoscaling.AutoScalingGroup(this, 'ControlPlaneAutoScalingGroup', {
      vpc,
      vpcSubnets: { subnets: props.controlPlaneSubnets },
      launchTemplate: this.controlPlaneLaunchTemplate,
      minCapacity: 3,
      maxCapacity: 10,
      autoScalingGroupName: `${props.clusterName}-control-plane`,
      defaultInstanceWarmup: cdk.Duration.minutes(15)
    });

    // Lambda function for etcd member lifecycle management
    const etcdLifecycleRole = new iam.Role(this, 'EtcdLifecycleRole', {
      roleName: `${props.clusterName}-etcd-lifecycle-role`,
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole')
      ]
    });

    this.etcdLifecycleLambda = new lambda.Function(this, 'EtcdLifecycleLambda', {
      functionName: `${props.clusterName}-etcd-lifecycle`,
      runtime: lambda.Runtime.PYTHON_3_11,
      handler: 'index.handler',
      code: lambda.Code.fromInline(createEtcdLifecycleLambdaCode(props.clusterName)),
      // 10 minute timeout for large nodes where etcd member removal may take longer:
      // - Data replication to remaining members
      // - Leader election if terminated node was leader
      // - SSM command execution overhead
      timeout: cdk.Duration.minutes(10),
      role: etcdLifecycleRole,
      environment: {
        CLUSTER_NAME: props.clusterName,
        ETCD_TABLE_NAME: props.etcdMemberTable.tableName,
        REGION: cdk.Stack.of(this).region,
        CONTROL_PLANE_ASG_NAME: `${props.clusterName}-control-plane`
      }
    });

    // Grant Lambda permissions
    props.etcdMemberTable.grantReadWriteData(etcdLifecycleRole);
    props.kmsKey.grantDecrypt(etcdLifecycleRole);
    
    etcdLifecycleRole.addToPolicy(new iam.PolicyStatement({
      actions: [
        'autoscaling:CompleteLifecycleAction',
        'ec2:DescribeInstances'
      ],
      resources: ['*']
    }));

    // Grant SSM permissions for etcdctl execution
    this.etcdLifecycleLambda.addToRolePolicy(new iam.PolicyStatement({
      actions: [
        'ssm:SendCommand',
        'ssm:GetCommandInvocation'
      ],
      resources: ['*']
    }));

    // Lifecycle hook for etcd member cleanup
    new autoscaling.LifecycleHook(this, 'EtcdLifecycleHook', {
      autoScalingGroup: this.controlPlaneAutoScalingGroup,
      lifecycleTransition: autoscaling.LifecycleTransition.INSTANCE_TERMINATING,
      defaultResult: autoscaling.DefaultResult.CONTINUE,
      heartbeatTimeout: cdk.Duration.minutes(10),
      lifecycleHookName: `${props.clusterName}-etcd-cleanup`
    });

    // EventBridge rule to trigger Lambda on lifecycle events
    new events.Rule(this, 'EtcdLifecycleRule', {
      ruleName: `${props.clusterName}-etcd-lifecycle-rule`,
      eventPattern: {
        source: ['aws.autoscaling'],
        detailType: ['EC2 Instance-terminate Lifecycle Action'],
        detail: {
          AutoScalingGroupName: [this.controlPlaneAutoScalingGroup.autoScalingGroupName]
        }
      },
      targets: [new targets.LambdaFunction(this.etcdLifecycleLambda)]
    });

    // Lambda function for scheduled etcd backups
    const etcdBackupRole = new iam.Role(this, 'EtcdBackupRole', {
      roleName: `${props.clusterName}-etcd-backup-role`,
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole')
      ]
    });

    this.etcdBackupLambda = new lambda.Function(this, 'EtcdBackupLambda', {
      functionName: `${props.clusterName}-etcd-backup`,
      runtime: lambda.Runtime.PYTHON_3_11,
      handler: 'index.handler',
      code: lambda.Code.fromInline(createEtcdBackupLambdaCode(props.clusterName, props.etcdBackupBucketName)),
      timeout: cdk.Duration.minutes(5),
      role: etcdBackupRole,
      environment: {
        CLUSTER_NAME: props.clusterName,
        BACKUP_BUCKET: props.etcdBackupBucketName,
        REGION: cdk.Stack.of(this).region,
        CONTROL_PLANE_ASG_NAME: `${props.clusterName}-control-plane`
      }
    });

    // Grant backup Lambda permissions
    etcdBackupRole.addToPolicy(new iam.PolicyStatement({
      actions: [
        'autoscaling:DescribeAutoScalingGroups',
        'ec2:DescribeInstances'
      ],
      resources: ['*']
    }));

    etcdBackupRole.addToPolicy(new iam.PolicyStatement({
      actions: [
        'ssm:SendCommand',
        'ssm:GetCommandInvocation'
      ],
      resources: ['*']
    }));

    etcdBackupRole.addToPolicy(new iam.PolicyStatement({
      actions: [
        's3:PutObject',
        's3:GetObject',
        's3:ListBucket'
      ],
      resources: [
        `arn:aws:s3:::${props.etcdBackupBucketName}`,
        `arn:aws:s3:::${props.etcdBackupBucketName}/*`
      ]
    }));

    props.kmsKey.grantEncryptDecrypt(etcdBackupRole);

    // Grant read access to etcd member table for instance lookups
    props.etcdMemberTable.grantReadData(etcdBackupRole);

    // Scheduled rule to run backup every 6 hours
    new events.Rule(this, 'EtcdBackupSchedule', {
      ruleName: `${props.clusterName}-etcd-backup-schedule`,
      schedule: events.Schedule.rate(cdk.Duration.hours(6)),
      targets: [new targets.LambdaFunction(this.etcdBackupLambda)]
    });

    // Lambda function for cluster health monitoring and auto-recovery
    const clusterHealthRole = new iam.Role(this, 'ClusterHealthRole', {
      roleName: `${props.clusterName}-cluster-health-role`,
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole')
      ]
    });

    this.clusterHealthLambda = new lambda.Function(this, 'ClusterHealthLambda', {
      functionName: `${props.clusterName}-cluster-health`,
      runtime: lambda.Runtime.PYTHON_3_11,
      handler: 'index.handler',
      code: lambda.Code.fromInline(createClusterHealthLambdaCode(props.clusterName, props.etcdBackupBucketName)),
      timeout: cdk.Duration.minutes(2),
      role: clusterHealthRole,
      environment: {
        CLUSTER_NAME: props.clusterName,
        BACKUP_BUCKET: props.etcdBackupBucketName,
        REGION: cdk.Stack.of(this).region,
        CONTROL_PLANE_ASG_NAME: `${props.clusterName}-control-plane`,
        UNHEALTHY_THRESHOLD: '3' // Number of consecutive failures before triggering restore
      }
    });

    // Grant health check Lambda permissions
    clusterHealthRole.addToPolicy(new iam.PolicyStatement({
      actions: [
        'autoscaling:DescribeAutoScalingGroups',
        'ec2:DescribeInstances'
      ],
      resources: ['*']
    }));

    clusterHealthRole.addToPolicy(new iam.PolicyStatement({
      actions: [
        'ssm:GetParameter',
        'ssm:PutParameter'
      ],
      resources: [
        `arn:aws:ssm:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:parameter/${props.clusterName}/*`
      ]
    }));

    clusterHealthRole.addToPolicy(new iam.PolicyStatement({
      actions: [
        's3:ListBucket',
        's3:GetObject'
      ],
      resources: [
        `arn:aws:s3:::${props.etcdBackupBucketName}`,
        `arn:aws:s3:::${props.etcdBackupBucketName}/*`
      ]
    }));

    props.kmsKey.grantDecrypt(clusterHealthRole);

    // Grant read access to etcd member table for cluster state queries
    props.etcdMemberTable.grantReadData(clusterHealthRole);

    // Scheduled rule to check cluster health every 5 minutes
    new events.Rule(this, 'ClusterHealthSchedule', {
      ruleName: `${props.clusterName}-cluster-health-schedule`,
      schedule: events.Schedule.rate(cdk.Duration.minutes(5)),
      targets: [new targets.LambdaFunction(this.clusterHealthLambda)]
    });

    // Worker node launch template
    const workerAmiId = ssm.StringParameter.valueFromLookup(this, '/k8s-cluster/worker-ami-id');

    this.workerLaunchTemplate = new ec2.LaunchTemplate(this, 'WorkerLaunchTemplate', {
      launchTemplateName: `${props.clusterName}-worker`,
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.M5, ec2.InstanceSize.LARGE),
      machineImage: ec2.MachineImage.genericLinux({
        [cdk.Stack.of(this).region]: workerAmiId,
      }),
      role: props.workerNodeRole,
      securityGroup: props.workerSecurityGroup,
      userData: ec2.UserData.forLinux({
        shebang: '#!/bin/bash'
      }),
      requireImdsv2: true,
      detailedMonitoring: true,
      blockDevices: [{
        deviceName: '/dev/xvda',
        volume: ec2.BlockDeviceVolume.ebs(20, {
          volumeType: ec2.EbsDeviceVolumeType.GP3,
          encrypted: true,
          kmsKey: props.kmsKey
        })
      }]
    });

    // Add worker bootstrap script
    this.workerLaunchTemplate.userData?.addCommands(
      createWorkerBootstrapScript(props.clusterName, cdk.Stack.of(this))
    );

    // Worker AutoScaling Group
    this.workerAutoScalingGroup = new autoscaling.AutoScalingGroup(this, 'WorkerAutoScalingGroup', {
      autoScalingGroupName: `${props.clusterName}-worker`,
      launchTemplate: this.workerLaunchTemplate,
      vpc: props.vpc,
      vpcSubnets: { subnets: props.workerSubnets },
      minCapacity: 1,
      maxCapacity: 10,
      healthCheck: autoscaling.HealthCheck.ec2({ grace: cdk.Duration.minutes(5) }),
      updatePolicy: autoscaling.UpdatePolicy.rollingUpdate()
    });

    // Add cluster-autoscaler tags to worker ASG
    cdk.Tags.of(this.workerAutoScalingGroup).add('k8s.io/cluster-autoscaler/enabled', 'true', {
      applyToLaunchedInstances: false
    });
    cdk.Tags.of(this.workerAutoScalingGroup).add(`k8s.io/cluster-autoscaler/${props.clusterName}`, 'owned', {
      applyToLaunchedInstances: false
    });
  }
}
