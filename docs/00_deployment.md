# docs/00_deployment.md

This doc will describe how to deploy this 

## Requirements 

CDK

## Deployement Steps

### 1. AMI Preparation (Internet-Connected Environment)

This deployment will be a two-phase approach in GovCloud. 

**Phase 1:** Build Kubernetes AMI (Commercial AWS Region)
- Run scripts/build-k8s-ami.sh from an internet-connected system
- Script uses Packer to create Amazon Linux 2023 AMI containing:
  - Kubernetes 1.29.0 (kubelet, kubeadm, kubectl)
  - containerd runtime with systemd cgroup driver
  - Cilium 1.14.5 CNI (CLI + pre-pulled images)
  - CNI plugins and networking configuration
  - Pre-pulled Kubernetes control plane images
- Outputs AMI ID for use in GovCloud deployment

Phase 2: Deploy to GovCloud
- Copy/share the AMI to your GovCloud region
- Use the AMI ID in your CDK deployment for control plane instances
- All dependencies are pre-installed, eliminating internet requirements during cluster bootstrap

This approach ensures your GovCloud Kubernetes cluster can deploy without external internet 
dependencies while maintaining security compliance.

2. `cdk deploy IamStack`
 