import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import * as DedicatedEc2K8sAutoscaler from '../lib/dedicated-ec2-k8s-autoscaler-stack';

test('Empty Stack', () => {
  const app = new cdk.App();
  const stack = new DedicatedEc2K8sAutoscaler.DedicatedEc2K8sAutoscalerStack(app, 'MyTestStack');
  const template = Template.fromStack(stack);

  template.templateMatches({
    "Resources": {}
  });
});
