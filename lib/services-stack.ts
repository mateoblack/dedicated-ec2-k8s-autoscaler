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
  public readonly clusterEndpointParameter: ssm.StringParameter;
  public readonly joinTokenParameter: ssm.StringParameter;
  public readonly clusterCaCertHashParameter: ssm.StringParameter;
  public readonly clusterInitializedParameter: ssm.StringParameter;

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
      parameterName: `/${props.clusterName}/kubernetes/version`,
      stringValue: '1.29.0',
      description: 'Kubernetes version for cluster'
    });

    this.kubernetesVersionParameter = new ssm.StringParameter(this, 'KubernetesVersion', {
      parameterName: `/${props.clusterName}/kubernetes/version`,
      stringValue: '1.29.0',
      description: 'Kubernetes version for cluster'
    });

    this.containerRuntimeParameter = new ssm.StringParameter(this, 'ContainerRuntime', {
      parameterName: `/${props.clusterName}/container/runtime`,
      stringValue: 'containerd',
      description: 'Container runtime for cluster nodes'
    });

    // Cluster communication parameters
    this.clusterEndpointParameter = new ssm.StringParameter(this, 'ClusterEndpoint', {
      parameterName: `/${props.clusterName}/cluster/endpoint`,
      stringValue: 'placeholder',
      description: 'Kubernetes API server endpoint URL'
    });

    this.joinTokenParameter = new ssm.StringParameter(this, 'JoinToken', {
      parameterName: `/${props.clusterName}/cluster/join-token`,
      stringValue: 'placeholder',
      description: 'Kubeadm join token for nodes'
    });

    this.clusterCaCertHashParameter = new ssm.StringParameter(this, 'ClusterCaCertHash', {
      parameterName: `/${props.clusterName}/cluster/ca-cert-hash`,
      stringValue: 'placeholder',
      description: 'Cluster CA certificate hash for secure join'
    });

    this.clusterInitializedParameter = new ssm.StringParameter(this, 'ClusterInitialized', {
      parameterName: `/${props.clusterName}/cluster/initialized`,
      stringValue: 'false',
      description: 'Flag indicating if cluster has been initialized'
    });
  }
}
