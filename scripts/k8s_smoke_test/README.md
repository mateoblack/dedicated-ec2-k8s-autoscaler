# Kubernetes Smoke Tests

Post-deployment smoke tests to verify cluster health.

## Usage

```bash
./test_k8s.sh <cluster-name> [kubeconfig-path]
```

### Examples

```bash
# Using default kubeconfig (~/.kube/config)
./test_k8s.sh my-cluster

# With custom kubeconfig
./test_k8s.sh my-cluster /path/to/kubeconfig

# With custom region
AWS_REGION=us-west-2 ./test_k8s.sh my-cluster
```

## Prerequisites

- `kubectl` installed and in PATH
- `aws` CLI installed and configured
- Valid kubeconfig with cluster access
- AWS credentials with SSM read permissions

## Tests Performed

| Test | Description |
|------|-------------|
| Cluster Connectivity | Verify kubectl can reach the API server |
| Control Plane Nodes | Check 3+ control plane nodes are Ready |
| Worker Nodes | Check 1+ worker nodes are Ready |
| System Pods | Verify kube-apiserver, etcd, coredns, etc. are running |
| CNI (Cilium) | Verify Cilium pods are running |
| etcd Health | Check etcd cluster has 3+ members |
| Pod Creation | Create and run a test pod |
| DNS Resolution | Verify cluster DNS works |
| SSM Parameters | Check cluster config stored in SSM |
| IRSA/OIDC | Verify OIDC discovery endpoint is accessible |
| Cluster Autoscaler | Check autoscaler is deployed |

## Exit Codes

- `0` - All tests passed
- `1` - One or more tests failed

## Timeouts

Configurable via environment or edit the script:

- `TIMEOUT_NODES_READY=300` - Wait for nodes (5 min)
- `TIMEOUT_POD_RUNNING=120` - Wait for test pod (2 min)
- `TIMEOUT_IRSA_TEST=60` - IRSA validation (1 min)
