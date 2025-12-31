# Self-Managed Kubernetes on Dedicated Instances (CDK)

> **Experimental**

> A dedicated-instance, self-healing Kubernetes 
controlplane on EC2

## What This Is 

This project creates a fully self-managed Kubernetes cluster on AWS using EC2 dedicated instances, deployed with AWS CDK. The cluster uses **immutable infrastructure principles** where:

- Kubernetes packages are pre-baked into AMIs using AWS Image Builder
- No runtime package installation occurs on EC2 instances
- Bootstrap scripts only handle configuration and cluster joining
- Nodes are completely replaceable without manual intervention

This is a self-managed Kubernetes cluster that you own and control, with automated deployment, self-healing capabilities, and proper etcd lifecycle management.

---

## Requirements 

- **AWS CDK v2** - For infrastructure deployment
- **AWS Image Builder permissions** - Required for AMI creation:
  - `imagebuilder:*`
  - `ec2:CreateImage`, `ec2:DescribeImages`
  - `ssm:PutParameter`, `ssm:GetParameter`
  - `iam:PassRole` for Image Builder service role
- **Node.js 18+** - For CDK and project dependencies
- **AWS CLI configured** - With appropriate region and credentials
- **Docker** - For CDK asset building (if using custom constructs)

## Deployment Steps

### 1. Prerequisites

Ensure you have the following installed and configured:
- AWS CLI configured with appropriate permissions
- AWS CDK v2 (`npm install -g aws-cdk`)
- Node.js 18+
- Docker (for CDK asset building)

### 2. AMI Preparation (Internet-Connected Environment)

**Step 2.1:** Build Kubernetes AMI using AWS Image Builder
- **IMPORTANT:** Run this command from the `scripts/` directory:
  ```bash
  cd scripts/
  ./build-k8s-ami-imagebuilder.sh
  ```
- This creates pre-baked AMIs with Kubernetes packages (kubeadm, kubelet, kubectl, containerd)
- AMI IDs are stored in SSM Parameter Store for the CDK deployment to reference

### 3. CDK Deployment

The project uses nested stacks that deploy in the correct dependency order automatically:

```bash
# Install dependencies
npm install

# Bootstrap CDK (first time only)
cdk bootstrap

# Deploy the complete Kubernetes cluster
cdk deploy K8sClusterStack
```

**Stack Deployment Order (Automatic):**
1. **IAM Stack** - Creates roles, policies, and KMS key
2. **Services Stack** - Creates SSM parameters for cluster configuration
3. **Network Stack** - Creates VPC, subnets, security groups, and load balancer
4. **Database Stack** - Creates DynamoDB table for etcd member tracking
5. **Compute Stack** - Creates launch templates and Auto Scaling Groups

### 4. Post-Deployment

After successful deployment:
- Control plane nodes will automatically bootstrap the cluster
- Worker nodes will join the cluster automatically
- The cluster will be accessible via the Network Load Balancer endpoint

**Verify cluster status:**
```bash
# Get the cluster endpoint from AWS Console or CLI
kubectl get nodes --kubeconfig /path/to/your/kubeconfig
```

This approach ensures your Kubernetes cluster deploys without external internet dependencies while maintaining security compliance.

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

### Cluster Architecture

The cluster uses a multi-stack architecture with clear separation of concerns:

- **IAM Stack**: Manages all security roles and KMS encryption
- **Services Stack**: Handles cluster configuration via SSM parameters
- **Network Stack**: Creates isolated VPC with dedicated subnets and load balancing
- **Database Stack**: Provides DynamoDB for etcd member coordination
- **Compute Stack**: Manages EC2 instances via Auto Scaling Groups

### Cluster Creation

* CDK creates networking, AutoScaling Groups, and supporting AWS resources 

* Three control plane instances start simultaneously using pre-baked AMIs

* **Cluster Initialization Process:**
  1. First control plane node uses DynamoDB lock to become cluster initializer
  2. Initializes Kubernetes cluster with `kubeadm init`
  3. Stores join tokens and cluster CA certificate hash in SSM Parameter Store
  4. Installs CNI plugin (Cilium) and cluster-autoscaler
  5. Registers with Network Load Balancer target group

* **Additional Control Plane Nodes:**
  1. Wait for cluster initialization to complete
  2. Retrieve join parameters from SSM
  3. Join cluster using `kubeadm join` with proper CA certificate validation

* **Worker Nodes:**
  1. Wait for cluster to be ready
  2. Retrieve join parameters from SSM
  3. Join cluster as worker nodes using `kubeadm join`

### Node Communication

* All nodes use pre-installed Kubernetes packages from AMIs (no runtime installation)
* Bootstrap scripts only handle configuration and cluster joining
* Nodes communicate via the Network Load Balancer for API server access
* CNI plugin (Cilium) handles pod-to-pod networking
* etcd cluster runs on control plane nodes with automated member management 

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

## Troubleshooting

### Common Issues

**AMI not found:**
- Ensure the Image Builder script completed successfully
- Check that AMI IDs are stored in SSM Parameter Store
- Verify you're deploying in the same region where AMIs were built

**Cluster nodes not joining:**
- Check CloudWatch logs for bootstrap script execution
- Verify security groups allow communication between nodes
- Ensure SSM parameters are populated correctly

**etcd issues:**
- Monitor DynamoDB table for member tracking
- Check control plane node logs for etcd cluster health
- Verify KMS key permissions for etcd encryption

### Accessing Logs

```bash
# View bootstrap logs on instances
sudo journalctl -u cloud-final -f

# Check Kubernetes component logs
sudo journalctl -u kubelet -f
sudo journalctl -u containerd -f
```

---

## Status 

Active development under test phase, graduated from build

Key completed features:
- ✅ Immutable AMI-based deployments
- ✅ Automated cluster initialization and node joining
- ✅ Self-healing control plane with etcd lifecycle management
- ✅ CNI networking with Cilium
- ✅ Cluster autoscaling support
- ✅ Comprehensive test coverage
- NOT DONE - Testing of edge cases and 

---

## License

Apache 2.0