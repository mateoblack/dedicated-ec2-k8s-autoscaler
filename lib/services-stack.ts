import * as cdk from 'aws-cdk-lib';
import * as kms from 'aws-cdk-lib/aws-kms';
import { Construct } from 'constructs';

export interface ServicesStackProps extends cdk.StackProps {
  readonly clusterName: string;
  readonly kmsKey?: kms.IKey;
}

export class ServicesStack extends cdk.Stack {
  public readonly workerJoinParameterName: string;
  public readonly controlPlaneJoinParameter: string;
  public readonly oidcIssuerParameterName: string;

  constructor(scope: Construct, id: string, props: ServicesStackProps) {
    super(scope, id, props);

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
    this.oidcIssuerParameterName = `/${props.clusterName}/kubeadm/oidc-issuer`;
  }
}
