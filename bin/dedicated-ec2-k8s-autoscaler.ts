#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { DedicatedEc2K8sAutoscalerStack } from '../lib/dedicated-ec2-k8s-autoscaler-stack';

const app = new cdk.App();
 
// Default Option: 
// KMS Behavior: KMS is created by AWS 
new DedicatedEc2K8sAutoscalerStack(app, 'DedicatedEc2K8sAutoscalerStack', {
    clusterName: 'my-cluster'
});

// Option 2: Provide your own
// KMS Behavior: KMS is provided by customer

// Provide your own KMS key
// const myKey = new cdk.aws_kms.Key(app,'DevCluster', {
//  enabledKeyRotation: true, 
// });

// Provide your own KMS key 
// const cluster = new cdk.aws_kms.Key(app, 'MyKey', {
//  clusterName: 'dev-k8s',
//  kmsKey: myKey, // use my existing key 
// });