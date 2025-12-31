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
  ./build-k8s-ami-imagebuilder.sh --region <your-region>
  ```
- The `--region` parameter is **required** - the script will error if not provided
- Supports both commercial AWS regions (e.g., `us-west-2`) and GovCloud regions (e.g., `us-gov-west-1`)
- The script automatically detects the AWS partition based on the region
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

## Testing

### Unit Tests (CDK Infrastructure)

Run infrastructure tests without AWS credentials:

```bash
npm run test:code
```

**Test coverage (194 tests across 22 files):**

| Test File | Coverage |
|-----------|----------|
| `ssm-control-plane-access.test.ts` | SSM Session Manager access to control plane nodes |
| `control-plane-launch-template.test.ts` | Control plane EC2 configuration |
| `worker-launch-template.test.ts` | Worker node EC2 configuration |
| `iam-stack.test.ts` | IAM roles, KMS, and permissions |
| `iam-least-privilege.test.ts` | Least privilege IAM policy scoping |
| `network-stack.test.ts` | VPC, subnets, and load balancer |
| `database-stack.test.ts` | DynamoDB tables and S3 buckets |
| `security-groups.test.ts` | Security group rules |
| `etcd-lifecycle-management.test.ts` | Lambda and lifecycle hooks |
| `etcd-backup-lambda.test.ts` | Scheduled etcd backup Lambda, S3 upload, scheduling |
| `cluster-health-lambda.test.ts` | Cluster health monitoring, restore triggering, recovery logic |
| `irsa-support.test.ts` | OIDC provider for IAM Roles for Service Accounts |
| `cluster-autoscaler-tags.test.ts` | ASG tags for cluster-autoscaler discovery |
| `certificate-rotation.test.ts` | Automatic certificate rotation configuration |
| `monitoring-stack.test.ts` | CloudWatch alarms and dashboard |
| `ha-system-components.test.ts` | High availability for system components |
| `audit-logging.test.ts` | API server audit logging configuration |

### Integration Tests (Requires AWS)

Full CDK synth + tests (requires AWS credentials and SSM parameters):

```bash
npm test
```

### Smoke Tests (Post-Deployment)

After deploying the cluster, run smoke tests to verify everything works:

```bash
./scripts/k8s_smoke_test/test_k8s.sh <cluster-name> [kubeconfig-path]
```

**Smoke tests verify:**
- Cluster connectivity
- Control plane nodes ready (3+)
- Worker nodes ready (1+)
- System pods running (apiserver, etcd, coredns)
- CNI (Cilium) working
- Pod creation and scheduling
- DNS resolution
- SSM parameters populated
- IRSA/OIDC configuration
- Cluster autoscaler deployed

---

## Cluster Management

### Accessing Control Plane Nodes

Control plane nodes are accessible via AWS Systems Manager Session Manager (no SSH required):

```bash
# List control plane instances
aws ec2 describe-instances \
  --filters "Name=tag:aws:autoscaling:groupName,Values=<cluster-name>-control-plane" \
  --query 'Reservations[].Instances[].[InstanceId,PrivateIpAddress,State.Name]' \
  --output table

# Connect to a control plane node
aws ssm start-session --target <instance-id>
```

**Why SSM instead of SSH:**
- No need to manage SSH keys
- No inbound security group rules required
- All access is logged in CloudTrail
- Works in private subnets without bastion hosts

### Required VPC Endpoints for SSM

The cluster automatically creates these VPC endpoints for SSM access in isolated environments:

| Endpoint | Purpose |
|----------|---------|
| `ssm` | Systems Manager API |
| `ssmmessages` | Session Manager connections |
| `ec2messages` | Run Command messaging |
| `kms` | Encryption for SecureString parameters |

---

## Disaster Recovery

### Automatic etcd Backups

The cluster automatically creates etcd snapshots every 6 hours:

- **Backup Location**: `s3://<cluster-name>-etcd-backup-*/`
- **Retention**: 30 days (moves to Infrequent Access after 7 days)
- **Format**: `<cluster-name>/etcd-snapshot-YYYYMMDD-HHMMSS.db`

### Automatic Recovery

If all control plane nodes fail simultaneously, the cluster will automatically recover:

**How it works:**
1. Health check Lambda runs every 5 minutes
2. Checks for healthy control plane instances in ASG
3. If 0 healthy instances for 3 consecutive checks (15 min):
   - Triggers "restore mode" via SSM parameter
   - Sets `/<cluster>/cluster/initialized` to `false`
4. When ASG launches new control plane instances:
   - Bootstrap script detects restore mode
   - Downloads latest backup from S3
   - Restores etcd from snapshot
   - Reinitializes Kubernetes control plane
   - Clears restore mode flag

**Safeguards:**
- Only triggers when **0 healthy instances** (ASG normally maintains 3)
- Requires 3 consecutive failed checks (15 minutes) to avoid false positives
- Uses DynamoDB lock to prevent multiple nodes from restoring simultaneously
- Verifies backup exists before triggering restore

### Manual Recovery

If automatic recovery fails or you need to restore a specific backup:

```bash
# List available backups
aws s3 ls s3://<cluster>-etcd-backup-<suffix>/<cluster>/

# Trigger manual restore
aws ssm put-parameter --name "/<cluster>/cluster/restore-mode" --value "true" --type String --overwrite
aws ssm put-parameter --name "/<cluster>/cluster/restore-backup" --value "<cluster>/etcd-snapshot-YYYYMMDD-HHMMSS.db" --type String --overwrite
aws ssm put-parameter --name "/<cluster>/cluster/initialized" --value "false" --type String --overwrite

# Terminate existing control plane instances to trigger new ones
aws autoscaling set-desired-capacity --auto-scaling-group-name <cluster>-control-plane --desired-capacity 0
sleep 60
aws autoscaling set-desired-capacity --auto-scaling-group-name <cluster>-control-plane --desired-capacity 3
```

### Limitations

- **Data loss window**: Up to 6 hours (backup interval) of cluster state may be lost
- **Workloads**: Running pods are not backed up - only cluster state (deployments, services, etc.)
- **PersistentVolumes**: PV data is NOT included in etcd backups - use separate backup strategy

---

## Certificate Rotation

### Automatic Certificate Management

The cluster automatically manages Kubernetes certificate rotation to prevent expiration:

**Kubelet Certificates (Workers & Control Plane):**
- Client certificates rotate automatically via kubelet's built-in rotation
- Server certificates use bootstrap with automatic CSR approval
- Settings: `rotateCertificates: true`, `serverTLSBootstrap: true`

**Control Plane Certificates (kubeadm-managed):**
- Daily check via systemd timer (`k8s-cert-renewal.timer`)
- Certificates renewed when < 30 days until expiration
- Control plane components automatically restarted after renewal

### CSR Auto-Approver

A lightweight controller runs on the cluster to approve kubelet serving certificate CSRs:

- Only approves CSRs with signer `kubernetes.io/kubelet-serving`
- Validates requestor is a legitimate node (`system:node:*`)
- Runs as a deployment in `kube-system` namespace

### Manual Certificate Operations

```bash
# Check certificate expiration dates
kubeadm certs check-expiration

# Manually renew all certificates
kubeadm certs renew all

# View renewal timer status
systemctl status k8s-cert-renewal.timer

# View renewal logs
journalctl -u k8s-cert-renewal.service

# Check pending CSRs
kubectl get csr
```

### Certificate Lifecycle

| Certificate Type | Rotation Method | Frequency |
|-----------------|-----------------|-----------|
| Kubelet client | Automatic (kubelet) | Before expiration |
| Kubelet server | CSR + auto-approve | Before expiration |
| API server, etcd, etc. | kubeadm renewal | 30 days before expiration |
| CA certificates | Manual (10 year validity) | As needed |

**Note:** CA certificates are not automatically rotated and have 10-year validity by default. Plan for manual rotation before expiration.

---

## CloudWatch Monitoring

### Automatic Monitoring

The cluster automatically creates CloudWatch alarms and a dashboard for operational visibility:

**CloudWatch Dashboard:** `<cluster-name>-overview`
- Control plane health (healthy/unhealthy hosts)
- API server response time
- ASG capacity (control plane and workers)
- Lambda function invocations, errors, and duration
- DynamoDB read/write capacity and throttling

### Alarms Created

| Alarm | Triggers When |
|-------|---------------|
| `<cluster>-control-plane-unhealthy-instances` | Control plane ASG has unhealthy instances |
| `<cluster>-api-server-unhealthy` | NLB target group has unhealthy hosts |
| `<cluster>-api-server-high-latency` | API server response time > 5 seconds |
| `<cluster>-worker-capacity-issue` | Worker ASG desired capacity is 0 |
| `<cluster>-etcd-lifecycle-lambda-errors` | etcd lifecycle Lambda errors |
| `<cluster>-etcd-backup-lambda-errors` | etcd backup Lambda errors |
| `<cluster>-health-check-lambda-errors` | Cluster health Lambda errors |
| `<cluster>-etcd-lifecycle-lambda-duration` | Lambda duration approaching timeout |
| `<cluster>-bootstrap-lock-throttled` | Bootstrap DynamoDB table throttled |
| `<cluster>-etcd-members-throttled` | etcd members DynamoDB table throttled |

### Configuring Notifications

Alarms are created without notification actions by default. To receive alerts, add an SNS topic subscription to your alarms:

```bash
# Create SNS topic
aws sns create-topic --name my-cluster-alerts

# Subscribe email
aws sns subscribe \
  --topic-arn arn:aws:sns:us-west-2:123456789012:my-cluster-alerts \
  --protocol email \
  --notification-endpoint your@email.com

# Add alarm action (repeat for each alarm)
aws cloudwatch put-metric-alarm \
  --alarm-name my-cluster-control-plane-unhealthy-instances \
  --alarm-actions arn:aws:sns:us-west-2:123456789012:my-cluster-alerts
```

### Viewing the Dashboard

```bash
# Open dashboard in AWS Console
echo "https://console.aws.amazon.com/cloudwatch/home?region=us-west-2#dashboards:name=<cluster-name>-overview"
```

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

## Customer Responsibilities

This project provides the core infrastructure for a self-managed Kubernetes cluster. The following items are **intentionally left to customers** to configure based on their specific requirements:

### Security (Customer-Configured)

| Item | Description | Example Provided |
|------|-------------|------------------|
| **Network Policies** | Default-deny policies, pod-to-pod restrictions | `examples/network-policies.yaml` |
| **Pod Security Standards** | Namespace-level security restrictions | `examples/pod-security-standards.yaml` |
| **Resource Quotas** | Namespace resource limits | No (workload-specific) |
| **Egress Controls** | Outbound traffic restrictions | Included in network-policies.yaml |

### Operations (Customer-Configured)

| Item | Description | Notes |
|------|-------------|-------|
| **SNS Notifications** | Alert destinations for CloudWatch alarms | See CloudWatch Monitoring section |
| **Cross-Region Backups** | Replicate etcd backups to another region | Use S3 replication rules |
| **Upgrade Automation** | Kubernetes version upgrades | Recommend blue/green deployments |
| **Custom Monitoring** | Application-specific metrics | Integrate with your observability stack |

### Applying Security Examples

```bash
# Apply network policies to a namespace
kubectl apply -f examples/network-policies.yaml -n my-namespace

# Apply pod security labels to a namespace
kubectl label namespace my-namespace \
  pod-security.kubernetes.io/enforce=baseline \
  pod-security.kubernetes.io/warn=restricted
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
- ✅ IRSA (IAM Roles for Service Accounts) via S3-hosted OIDC
- ✅ SSM Session Manager access to control plane nodes
- ✅ Graceful node draining before termination
- ✅ Automatic etcd backups to S3 (every 6 hours)
- ✅ Automatic disaster recovery from backups
- ✅ Automatic certificate rotation (kubelet + control plane)
- ✅ CloudWatch alarms and dashboard for monitoring
- ✅ HA system components (cluster-autoscaler, CSR-approver with 2 replicas)
- ✅ Least privilege IAM policies (workers read-only, scoped resources)
- ✅ API server audit logging (security events logged to /var/log/kubernetes/audit)
- ✅ Comprehensive test coverage (149 tests)

In progress:
- Testing of edge cases and failure scenarios 

---

## License

Apache 2.0