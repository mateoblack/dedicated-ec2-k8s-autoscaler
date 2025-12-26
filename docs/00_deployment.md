# docs/00_deployment.md

This doc will describe how to deploy this 

## Requirements 

CDK

## Deployement Steps

### 1. AMI Preparation (Internet-Connected Environment)

This deployment will be a three-phase approach in GovCloud. 

**Phase 1:** Build Kubernetes AMI (Commercial AWS Region)
- Run `CONTROL_AMI=$(./scripts/build-k8s-ami.sh)` and `WORKER_AMI=$(./scripts/build-k8s-worker-ami.sh)` from an internet-connected system
- Script uses Packer to create Amazon Linux 2023 AMI containing:
  - Kubernetes 1.29.0 (kubelet, kubeadm, kubectl)
  - containerd runtime with systemd cgroup driver
  - Cilium 1.14.5 CNI (CLI + pre-pulled images)
  - CNI plugins and networking configuration
  - Kubernetes AutoScaler
  - Pre-pulled Kubernetes control plane and worker node images
- Outputs AMI ID for use in GovCloud deployment

**Phase 2:** In your region, put the AMIs in SSM.

```
# 2. Store in SSM
aws ssm put-parameter \
  --name "/k8s-cluster/control-plane-ami-id" \
  --value "$CONTROL_AMI" \
  --type "String" \
  --overwrite

aws ssm put-parameter \
  --name "/k8s-cluster/worker-ami-id" \
  --value "$WORKER_AMI" \
  --type "String" \
  --overwrite
```

**Phase 3:** Deploy to GovCloud
- Copy/share the AMI to your region
- Use the AMI ID in your CDK deployment for control plane instances
- All dependencies are pre-installed, eliminating internet requirements during cluster bootstrap

This approach ensures your GovCloud Kubernetes cluster can deploy without external internet 
dependencies while maintaining security compliance.

##

2. `cdk deploy IamStack`
 