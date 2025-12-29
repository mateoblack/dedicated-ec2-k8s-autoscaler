#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { K8sClusterStack } from '../lib/k8s-cluster-stack';

const app = new cdk.App();

// Default Option: KMS is created automatically
new K8sClusterStack(app, 'K8sClusterStack', {
  clusterName: 'my-cluster',
  env: {
    account: '<your-account-number>',
    region: 'us-gov-west-1', // GovCloud region
  },
});

// Option 2: Provide your own KMS key
// const myKey = new cdk.aws_kms.Key(app, 'MyKey', {
//   enableKeyRotation: true,
// });
// 
// new K8sClusterStack(app, 'K8sClusterStack', {
//   clusterName: 'dev-k8s',
//   kmsKey: myKey
// });