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
  public readonly kubernetesVersionParameter: ssm.StringParameter;
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


    this.kubernetesVersionParameter = new ssm.StringParameter(this, 'KubernetesVersion', {
      parameterName: `/${props.clusterName}/kubernetes/version`,
      stringValue: '1.29.0',
      description: 'Kubernetes version for cluster init'
    });

    // Cluster communication parameters
    // These are initialized with PENDING_INITIALIZATION and updated by the first control plane node
    // Bootstrap scripts validate these values before attempting to join
    this.clusterEndpointParameter = new ssm.StringParameter(this, 'ClusterEndpoint', {
      parameterName: `/${props.clusterName}/cluster/endpoint`,
      stringValue: 'PENDING_INITIALIZATION',
      description: 'Kubernetes API server endpoint URL'
    });

    this.joinTokenParameter = new ssm.StringParameter(this, 'JoinToken', {
      parameterName: `/${props.clusterName}/cluster/join-token`,
      stringValue: 'PENDING_INITIALIZATION',
      description: 'Kubeadm join token for nodes (updated to SecureString by bootstrap)'
    });

    this.clusterCaCertHashParameter = new ssm.StringParameter(this, 'ClusterCaCertHash', {
      parameterName: `/${props.clusterName}/cluster/ca-cert-hash`,
      stringValue: 'PENDING_INITIALIZATION',
      description: 'Cluster CA certificate hash for secure join'
    });

    this.clusterInitializedParameter = new ssm.StringParameter(this, 'ClusterInitialized', {
      parameterName: `/${props.clusterName}/cluster/initialized`,
      stringValue: 'false',
      description: 'Flag indicating if cluster has been initialized'
    });
  }
}
