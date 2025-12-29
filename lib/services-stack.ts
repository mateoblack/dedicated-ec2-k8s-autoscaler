import * as cdk from 'aws-cdk-lib';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';

export interface ServicesStackProps {
  readonly clusterName: string;
  readonly kmsKey?: kms.IKey;
}

export class ServicesStack extends Construct {
  public readonly workerJoinParameterName: string;
  public readonly controlPlaneJoinParameter: string;
  public readonly kubeletVersionParameter: ssm.StringParameter;
  public readonly kubernetesVersionParameter: ssm.StringParameter;
  public readonly containerRuntimeParameter: ssm.StringParameter;

  constructor(scope: Construct, id: string, props: ServicesStackProps) {
    super(scope, id);

    // Validate cluster name
    if (!props.clusterName || props.clusterName.length < 3) {
      throw new Error("clusterName must be at least 3 characters");
    }

    if (!/^[a-z0-9-]+$/.test(props.clusterName)) {
      throw new Error(
        "clustername must only contain lowercase letters, numbers and hyphens"
      );
    }

    // SSM parameter names for kubeadm join commands
    this.workerJoinParameterName = `/${props.clusterName}/kubeadm/worker-join`;
    this.controlPlaneJoinParameter = `/${props.clusterName}/kubeadm/control-plane-join`;

    // Bootstrap configuration parameters
    this.kubeletVersionParameter = new ssm.StringParameter(this, 'KubeletVersion', {
      parameterName: `/${props.clusterName}/control/kubelet/version`,
      stringValue: '1.28.2',
      description: 'Kubelet version for cluster nodes'
    });

    this.kubernetesVersionParameter = new ssm.StringParameter(this, 'KubernetesVersion', {
      parameterName: `/${props.clusterName}/control/kubernetes/version`,
      stringValue: '1.28.2',
      description: 'Kubernetes version for cluster'
    });

    this.containerRuntimeParameter = new ssm.StringParameter(this, 'ContainerRuntime', {
      parameterName: `/${props.clusterName}/control/container/runtime`,
      stringValue: 'containerd',
      description: 'Container runtime for cluster nodes'
    });

    
  }
}
