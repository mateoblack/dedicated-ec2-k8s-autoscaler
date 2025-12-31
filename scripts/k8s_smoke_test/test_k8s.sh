#!/bin/bash
#
# Kubernetes Cluster Smoke Tests
# Run after cluster deployment to verify everything works
#
# Usage: ./test_k8s.sh <cluster-name> [kubeconfig-path]
#
# Exit codes:
#   0 - All tests passed
#   1 - One or more tests failed
#

set -o pipefail

#######################################
# Configuration
#######################################
CLUSTER_NAME="${1:-}"
KUBECONFIG_PATH="${2:-$HOME/.kube/config}"
REGION="${AWS_REGION:-us-gov-west-1}"

# Test timeouts (seconds)
TIMEOUT_NODES_READY=300
TIMEOUT_POD_RUNNING=120
TIMEOUT_IRSA_TEST=60

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

#######################################
# Helper functions
#######################################
TESTS_RUN=0
TESTS_PASSED=0
TESTS_FAILED=0

log_info() {
    echo -e "${NC}[INFO] $1${NC}"
}

log_pass() {
    echo -e "${GREEN}[PASS] $1${NC}"
    ((TESTS_PASSED++))
}

log_fail() {
    echo -e "${RED}[FAIL] $1${NC}"
    ((TESTS_FAILED++))
}

log_warn() {
    echo -e "${YELLOW}[WARN] $1${NC}"
}

run_test() {
    local test_name="$1"
    local test_func="$2"

    ((TESTS_RUN++))
    echo ""
    echo "========================================"
    echo "TEST: $test_name"
    echo "========================================"

    if $test_func; then
        log_pass "$test_name"
        return 0
    else
        log_fail "$test_name"
        return 1
    fi
}

wait_for_condition() {
    local description="$1"
    local condition_cmd="$2"
    local timeout="$3"
    local interval="${4:-5}"

    local elapsed=0
    log_info "Waiting for: $description (timeout: ${timeout}s)"

    while [ $elapsed -lt $timeout ]; do
        if eval "$condition_cmd" > /dev/null 2>&1; then
            return 0
        fi
        sleep $interval
        elapsed=$((elapsed + interval))
        echo -n "."
    done
    echo ""
    return 1
}

kubectl_cmd() {
    kubectl --kubeconfig="$KUBECONFIG_PATH" "$@"
}

#######################################
# Pre-flight checks
#######################################
preflight_checks() {
    log_info "Running pre-flight checks..."

    if [ -z "$CLUSTER_NAME" ]; then
        echo "Usage: $0 <cluster-name> [kubeconfig-path]"
        echo ""
        echo "Example: $0 my-cluster ~/.kube/config"
        exit 1
    fi

    # Check kubectl is installed
    if ! command -v kubectl &> /dev/null; then
        log_fail "kubectl not found in PATH"
        exit 1
    fi

    # Check aws cli is installed
    if ! command -v aws &> /dev/null; then
        log_fail "aws cli not found in PATH"
        exit 1
    fi

    # Check kubeconfig exists
    if [ ! -f "$KUBECONFIG_PATH" ]; then
        log_fail "Kubeconfig not found: $KUBECONFIG_PATH"
        exit 1
    fi

    # Check we can connect to the cluster
    if ! kubectl_cmd cluster-info &> /dev/null; then
        log_fail "Cannot connect to cluster. Check kubeconfig."
        exit 1
    fi

    log_info "Pre-flight checks passed"
    echo ""
}

#######################################
# Test: Cluster connectivity
#######################################
test_cluster_connectivity() {
    kubectl_cmd cluster-info
    return $?
}

#######################################
# Test: Control plane nodes ready
#######################################
test_control_plane_nodes() {
    local ready_count

    # Wait for at least 3 control plane nodes to be Ready
    if ! wait_for_condition \
        "3 control plane nodes to be Ready" \
        "[ \$(kubectl_cmd get nodes -l node-role.kubernetes.io/control-plane --no-headers 2>/dev/null | grep -c ' Ready') -ge 3 ]" \
        "$TIMEOUT_NODES_READY"; then
        log_warn "Timeout waiting for control plane nodes"
        kubectl_cmd get nodes -l node-role.kubernetes.io/control-plane
        return 1
    fi

    echo ""
    ready_count=$(kubectl_cmd get nodes -l node-role.kubernetes.io/control-plane --no-headers | grep -c ' Ready')
    log_info "Control plane nodes ready: $ready_count"
    kubectl_cmd get nodes -l node-role.kubernetes.io/control-plane

    [ "$ready_count" -ge 3 ]
}

#######################################
# Test: Worker nodes ready
#######################################
test_worker_nodes() {
    local ready_count

    # Wait for at least 1 worker node to be Ready
    if ! wait_for_condition \
        "at least 1 worker node to be Ready" \
        "[ \$(kubectl_cmd get nodes --no-headers 2>/dev/null | grep -v control-plane | grep -c ' Ready') -ge 1 ]" \
        "$TIMEOUT_NODES_READY"; then
        log_warn "Timeout waiting for worker nodes"
        kubectl_cmd get nodes
        return 1
    fi

    echo ""
    ready_count=$(kubectl_cmd get nodes --no-headers | grep -v control-plane | grep -c ' Ready' || echo 0)
    log_info "Worker nodes ready: $ready_count"
    kubectl_cmd get nodes

    [ "$ready_count" -ge 1 ]
}

#######################################
# Test: Core system pods running
#######################################
test_system_pods() {
    local critical_pods=("kube-apiserver" "kube-controller-manager" "kube-scheduler" "etcd" "coredns")
    local all_running=true

    log_info "Checking critical system pods..."

    for pod_prefix in "${critical_pods[@]}"; do
        local running_count
        running_count=$(kubectl_cmd get pods -n kube-system --no-headers 2>/dev/null | grep "^${pod_prefix}" | grep -c "Running" || echo 0)

        if [ "$running_count" -gt 0 ]; then
            log_info "  $pod_prefix: $running_count running"
        else
            log_warn "  $pod_prefix: NOT RUNNING"
            all_running=false
        fi
    done

    echo ""
    kubectl_cmd get pods -n kube-system

    $all_running
}

#######################################
# Test: CNI (Cilium) is working
#######################################
test_cni_cilium() {
    local cilium_pods

    log_info "Checking Cilium CNI..."

    # Check cilium pods exist and are running
    cilium_pods=$(kubectl_cmd get pods -n kube-system -l k8s-app=cilium --no-headers 2>/dev/null | grep -c "Running" || echo 0)

    if [ "$cilium_pods" -eq 0 ]; then
        # Maybe cilium is in a different namespace or has different labels
        cilium_pods=$(kubectl_cmd get pods -A --no-headers 2>/dev/null | grep -i cilium | grep -c "Running" || echo 0)
    fi

    log_info "Cilium pods running: $cilium_pods"
    kubectl_cmd get pods -n kube-system -l k8s-app=cilium 2>/dev/null || kubectl_cmd get pods -A | grep -i cilium

    [ "$cilium_pods" -gt 0 ]
}

#######################################
# Test: Can create and run a pod
#######################################
test_pod_creation() {
    local test_ns="smoke-test-$$"
    local test_pod="smoke-test-pod"
    local result=0

    log_info "Creating test namespace and pod..."

    # Create namespace
    kubectl_cmd create namespace "$test_ns" || return 1

    # Create a simple pod
    kubectl_cmd run "$test_pod" \
        --namespace="$test_ns" \
        --image=busybox:latest \
        --restart=Never \
        --command -- sleep 30 || {
        kubectl_cmd delete namespace "$test_ns" --ignore-not-found
        return 1
    }

    # Wait for pod to be running
    if wait_for_condition \
        "test pod to be Running" \
        "[ \"\$(kubectl_cmd get pod $test_pod -n $test_ns -o jsonpath='{.status.phase}' 2>/dev/null)\" = 'Running' ]" \
        "$TIMEOUT_POD_RUNNING"; then
        log_info "Test pod is running"
        kubectl_cmd get pod "$test_pod" -n "$test_ns"
        result=0
    else
        log_warn "Test pod did not reach Running state"
        kubectl_cmd describe pod "$test_pod" -n "$test_ns"
        result=1
    fi

    # Cleanup
    log_info "Cleaning up test resources..."
    kubectl_cmd delete namespace "$test_ns" --ignore-not-found

    return $result
}

#######################################
# Test: DNS resolution works
#######################################
test_dns_resolution() {
    local test_ns="dns-test-$$"
    local result=0

    log_info "Testing DNS resolution..."

    # Create namespace
    kubectl_cmd create namespace "$test_ns" || return 1

    # Run a pod that does DNS lookup
    if kubectl_cmd run dns-test \
        --namespace="$test_ns" \
        --image=busybox:latest \
        --restart=Never \
        --rm -i --wait \
        --timeout=60s \
        --command -- nslookup kubernetes.default.svc.cluster.local; then
        log_info "DNS resolution successful"
        result=0
    else
        log_warn "DNS resolution failed"
        result=1
    fi

    # Cleanup
    kubectl_cmd delete namespace "$test_ns" --ignore-not-found

    return $result
}

#######################################
# Test: IRSA / OIDC is configured
#######################################
test_irsa_configuration() {
    log_info "Checking IRSA/OIDC configuration..."

    # Check OIDC issuer is stored in SSM
    local oidc_issuer
    oidc_issuer=$(aws ssm get-parameter \
        --name "/${CLUSTER_NAME}/oidc/issuer" \
        --query 'Parameter.Value' \
        --output text \
        --region "$REGION" 2>/dev/null)

    if [ -z "$oidc_issuer" ] || [ "$oidc_issuer" = "None" ]; then
        log_warn "OIDC issuer not found in SSM"
        return 1
    fi

    log_info "OIDC Issuer: $oidc_issuer"

    # Check OIDC discovery endpoint is accessible
    local discovery_url="${oidc_issuer}/.well-known/openid-configuration"
    log_info "Checking OIDC discovery: $discovery_url"

    if curl -sf "$discovery_url" > /dev/null 2>&1; then
        log_info "OIDC discovery endpoint is accessible"
        curl -s "$discovery_url" | head -20
        return 0
    else
        log_warn "OIDC discovery endpoint not accessible"
        return 1
    fi
}

#######################################
# Test: Cluster autoscaler is running
#######################################
test_cluster_autoscaler() {
    local ca_pods

    log_info "Checking cluster-autoscaler..."

    ca_pods=$(kubectl_cmd get pods -n kube-system -l app=cluster-autoscaler --no-headers 2>/dev/null | grep -c "Running" || echo 0)

    if [ "$ca_pods" -gt 0 ]; then
        log_info "Cluster autoscaler is running"
        kubectl_cmd get pods -n kube-system -l app=cluster-autoscaler
        return 0
    else
        log_warn "Cluster autoscaler not found or not running"
        kubectl_cmd get pods -n kube-system | grep -i autoscaler || true
        return 1
    fi
}

#######################################
# Test: etcd cluster health
#######################################
test_etcd_health() {
    log_info "Checking etcd cluster health..."

    # Get a control plane node
    local cp_node
    cp_node=$(kubectl_cmd get nodes -l node-role.kubernetes.io/control-plane -o jsonpath='{.items[0].metadata.name}' 2>/dev/null)

    if [ -z "$cp_node" ]; then
        log_warn "No control plane node found"
        return 1
    fi

    # Check etcd pods
    local etcd_pods
    etcd_pods=$(kubectl_cmd get pods -n kube-system -l component=etcd --no-headers 2>/dev/null | grep -c "Running" || echo 0)

    log_info "etcd pods running: $etcd_pods"
    kubectl_cmd get pods -n kube-system -l component=etcd

    [ "$etcd_pods" -ge 3 ]
}

#######################################
# Test: SSM parameters are populated
#######################################
test_ssm_parameters() {
    log_info "Checking SSM parameters..."

    local params=("cluster/endpoint" "cluster/initialized" "kubernetes/version")
    local all_found=true

    for param in "${params[@]}"; do
        local value
        value=$(aws ssm get-parameter \
            --name "/${CLUSTER_NAME}/${param}" \
            --query 'Parameter.Value' \
            --output text \
            --region "$REGION" 2>/dev/null)

        if [ -n "$value" ] && [ "$value" != "None" ] && [ "$value" != "placeholder" ]; then
            log_info "  /${CLUSTER_NAME}/${param}: $value"
        else
            log_warn "  /${CLUSTER_NAME}/${param}: NOT SET or placeholder"
            all_found=false
        fi
    done

    $all_found
}

#######################################
# Main
#######################################
main() {
    echo ""
    echo "=============================================="
    echo "  Kubernetes Cluster Smoke Tests"
    echo "  Cluster: $CLUSTER_NAME"
    echo "  Region:  $REGION"
    echo "=============================================="
    echo ""

    preflight_checks

    # Run all tests
    run_test "Cluster Connectivity" test_cluster_connectivity
    run_test "Control Plane Nodes Ready" test_control_plane_nodes
    run_test "Worker Nodes Ready" test_worker_nodes
    run_test "System Pods Running" test_system_pods
    run_test "CNI (Cilium) Working" test_cni_cilium
    run_test "etcd Cluster Health" test_etcd_health
    run_test "Pod Creation" test_pod_creation
    run_test "DNS Resolution" test_dns_resolution
    run_test "SSM Parameters" test_ssm_parameters
    run_test "IRSA/OIDC Configuration" test_irsa_configuration
    run_test "Cluster Autoscaler" test_cluster_autoscaler

    # Summary
    echo ""
    echo "=============================================="
    echo "  Test Summary"
    echo "=============================================="
    echo -e "  Total:  $TESTS_RUN"
    echo -e "  ${GREEN}Passed: $TESTS_PASSED${NC}"
    echo -e "  ${RED}Failed: $TESTS_FAILED${NC}"
    echo "=============================================="
    echo ""

    if [ "$TESTS_FAILED" -gt 0 ]; then
        exit 1
    fi
    exit 0
}

main "$@"
