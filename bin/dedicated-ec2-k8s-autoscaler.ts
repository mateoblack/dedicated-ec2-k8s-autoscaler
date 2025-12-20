#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { DedicatedEc2K8sAutoscalerStack } from '../lib/dedicated-ec2-k8s-autoscaler-stack';

const app = new cdk.App();
new DedicatedEc2K8sAutoscalerStack(app, 'DedicatedEc2K8sAutoscalerStack', {});
