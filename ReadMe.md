# Self-Managed Kubernetes on Dedicated Instances (CDK)

> **Experimental**

> A dedicated-instance, self-healing Kubernetes 
controlplane on EC2

## What This Is 

This project creates a fully self-managed Kubernetes
cluster on AWS using EC2 dedicated instances, deployed and reconciled with AWS CDK 

This is an **experimental** Kubernetes you own, automated to deploy in 
AWS.

---

## Requirements 

- AWS CDK v2
- Image builder permissions 
- Node.js 18+

## Deployment Steps

### 1. AMI Preparation (Internet-Connected Environment)

**Step 1.1:** Build Kubernetes AMI 
- **IMPORTANT:** Run these commands from the `scripts/` directory to avoid cluttering your project root:
  ```bash
  cd scripts/
  build-k8s-ami-imagebuilder.sh
  ```

### 2. CDK Deployment

```bash
# Deploy IAM resources first
cdk deploy IamStack

# Deploy the Kubernetes cluster
cdk deploy K8sClusterStack
```

This approach ensures your Kubernetes cluster can deploy without external internet dependencies while maintaining security compliance.

---

## Core Characteristics 

**Self-healing control plane**
* Control plane and workers can run on isolated EC2 capacity (no shared tenancy)

**High-availability etcd (by default)**
* Control plane nodes are managed by AutoScaling Groups and safely replaced without breaking etcd quorum.

**Self-healing control plane**
* Three control plane nodes with automated member tracking and cleanup using lambda 

**Immutable by design**
* Nodes are never fixed in place - They are replaceable 

**CDK-native**

---

## What Problems This Solves 

Running fully distributed Kubernetes control plane yourself can be complex. EKS solves this problem but, for highly restrictive environments full control over the cluster will be required so, in this use case using EKS is not possible.

The hardest part being **etcd lifecycle management** in the K8 control plane nodes

---

## How it Works (High Level)

### Cluster Creation

* CDK creates networking, AutoScaling Groups, and supporting AWS resources 

* Three control plane instances start at once

* One instance bootstraps the cluster 

* Others join automatically 

* Workers join as stateless nodes 

### Node Replacement 

* If a control plane instance is terminated 
    * A lifecycle hook pauses termination 
    * A lambda function removes the instance from etcd safely 
    * The instance is terminated 
    * A replacement joins cleanly
* Worker nodes are replaced normally 

**Results**

* The cluster survives unlimited node replacement without manual intervention. 

---

### Upgrade Philosophy 

* Default: in-place upgrades via node replacement 
* Optional: blue/green clusters for major version changes
* Not required: new VPCs or CIDR ranges
* Features: delivered as additional infrastructure in the same CIDRs ranges

**Infrastructure** is reconciled - not recreated

---

## What This Is Not 

* Not a managed kubernetes service. Just self healing. You'll need a system admin for kubernetes.

---

## Status 

Active development and not ready for production use

---

## License

Apache 2.0