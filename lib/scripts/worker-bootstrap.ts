import * as cdk from 'aws-cdk-lib';
import { getBashRetryFunctions } from './bash-retry';
import { getBashLoggingFunctions } from './bash-logging';

/**
 * Creates the worker node bootstrap script for joining an existing Kubernetes cluster.
 *
 * This script:
 * - Waits for cluster initialization via SSM parameter
 * - Gets join token and CA cert hash from SSM
 * - Configures containerd and kubelet
 * - Joins the cluster using kubeadm
 * - Handles token refresh if the token is near expiry
 *
 * @param clusterName - The name of the Kubernetes cluster
 * @param stack - The CDK stack (used to get the region)
 * @returns The bootstrap script as a string
 */
export function createWorkerBootstrapScript(clusterName: string, stack: cdk.Stack): string {
  const region = stack.region;
  return `
# Worker bootstrap script - Join cluster using pre-installed packages
echo "Starting worker node bootstrap for cluster: ${clusterName}"

# Retry configuration
MAX_RETRIES=5
RETRY_DELAY=5

# WHY BOOTSTRAP_STAGE: cleanup_on_failure uses this to determine what needs cleanup.
# Worker bootstrap is simpler than control-plane, but stage tracking enables targeted
# cleanup (e.g., only reset kubeadm if we got that far).
BOOTSTRAP_STAGE="init"

# Cleanup function for failed bootstrap
cleanup_on_failure() {
    local exit_code=\$?
    if [ \$exit_code -eq 0 ]; then
        return 0
    fi

    echo "Worker bootstrap failed at stage: \$BOOTSTRAP_STAGE (exit code: \$exit_code)"
    echo "Running cleanup..."

    # Reset kubeadm state
    echo "Resetting kubeadm state..."
    kubeadm reset -f 2>/dev/null || true

    # Stop kubelet
    systemctl stop kubelet 2>/dev/null || true

    echo "Cleanup completed. Worker will need manual intervention or termination."

    # Signal unhealthy to ASG (optional - causes replacement)
    # Uncomment to auto-terminate failed instances:
    # aws autoscaling set-instance-health --instance-id \$INSTANCE_ID --health-status Unhealthy --region \$REGION 2>/dev/null || true

    exit \$exit_code
}

# WHY trap EXIT not ERR: EXIT fires on ALL exits including set -e failures and explicit
# exit calls. ERR only catches simple command failures but misses other termination paths.
trap cleanup_on_failure EXIT

${getBashRetryFunctions()}

${getBashLoggingFunctions()}

# Get instance metadata (with IMDSv2 support)
get_instance_metadata() {
    local path="$1"
    local token
    token=$(curl -s -X PUT "http://169.254.169.254/latest/api/token" -H "X-aws-ec2-metadata-token-ttl-seconds: 300" 2>/dev/null)
    if [ -n "$token" ]; then
        curl -s -H "X-aws-ec2-metadata-token: $token" "http://169.254.169.254/latest/meta-data/$path"
    else
        curl -s "http://169.254.169.254/latest/meta-data/$path"
    fi
}

INSTANCE_ID=$(get_instance_metadata "instance-id")
PRIVATE_IP=$(get_instance_metadata "local-ipv4")
REGION=${region}

# Verify we got instance metadata
if [ -z "$INSTANCE_ID" ] || [ -z "$PRIVATE_IP" ]; then
    log_error "Failed to get instance metadata"
    exit 1
fi

log_info "Instance metadata retrieved" "instance_id=$INSTANCE_ID" "private_ip=$PRIVATE_IP" "cluster=${clusterName}" "node_type=worker"

# Wait for cluster to be initialized
log_info "Waiting for cluster to be initialized"
for i in {1..60}; do
    CLUSTER_INITIALIZED=$(retry_command_output aws ssm get-parameter --name '/${clusterName}/cluster/initialized' --query 'Parameter.Value' --output text --region $REGION || echo "false")
    if [ "$CLUSTER_INITIALIZED" = "true" ]; then
        log_info "Cluster is initialized, proceeding with worker join"
        break
    fi
    log_info "Waiting for cluster initialization" "attempt=$i" "max_attempts=60"
    sleep 10
done

if [ "$CLUSTER_INITIALIZED" != "true" ]; then
    log_error "Timeout waiting for cluster initialization"
    exit 1
fi

BOOTSTRAP_STAGE="get-join-params"

# Function to request a fresh join token from a control plane node
request_new_token() {
    log_info "Requesting new join token from control plane"

    # Find a healthy control plane instance
    CONTROL_PLANE_INSTANCE=$(aws ec2 describe-instances \
        --filters "Name=tag:aws:autoscaling:groupName,Values=${clusterName}-control-plane" \
                  "Name=instance-state-name,Values=running" \
        --query 'Reservations[0].Instances[0].InstanceId' \
        --output text --region $REGION 2>/dev/null)

    if [ -z "$CONTROL_PLANE_INSTANCE" ] || [ "$CONTROL_PLANE_INSTANCE" = "None" ]; then
        log_error "No healthy control plane instance found"
        return 1
    fi

    log_info "Found control plane instance" "instance_id=$CONTROL_PLANE_INSTANCE"

    # Create script to generate new token on control plane
    local token_script='
export KUBECONFIG=/etc/kubernetes/admin.conf
NEW_TOKEN=$(kubeadm token create --ttl 24h 2>/dev/null)
if [ -n "$NEW_TOKEN" ]; then
    aws ssm put-parameter --name "/'${clusterName}'/cluster/join-token" \
        --value "$NEW_TOKEN" --type "SecureString" --overwrite --region '$REGION'
    aws ssm put-parameter --name "/'${clusterName}'/cluster/join-token-updated" \
        --value "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --type "String" --overwrite --region '$REGION'
    echo "TOKEN_REFRESH_SUCCESS"
else
    echo "TOKEN_REFRESH_FAILED"
fi
'

    # Execute via SSM Run Command
    local command_id
    command_id=$(aws ssm send-command \
        --instance-ids "$CONTROL_PLANE_INSTANCE" \
        --document-name "AWS-RunShellScript" \
        --parameters commands="$token_script" \
        --query 'Command.CommandId' \
        --output text --region "$REGION" 2>/dev/null)

    if [ -z "$command_id" ] || [ "$command_id" = "None" ]; then
        log_error "Failed to send SSM command"
        return 1
    fi

    log_info "SSM command sent" "command_id=$command_id"

    # Wait for command completion
    local max_wait=60
    local elapsed=0
    local status
    local output
    while [ $elapsed -lt $max_wait ]; do
        sleep 5
        elapsed=$((elapsed + 5))

        status=$(aws ssm get-command-invocation \
            --command-id "$command_id" \
            --instance-id "$CONTROL_PLANE_INSTANCE" \
            --query 'Status' --output text --region "$REGION" 2>/dev/null)

        if [ "$status" = "Success" ]; then
            output=$(aws ssm get-command-invocation \
                --command-id "$command_id" \
                --instance-id "$CONTROL_PLANE_INSTANCE" \
                --query 'StandardOutputContent' --output text --region "$REGION" 2>/dev/null)

            if echo "$output" | grep -q "TOKEN_REFRESH_SUCCESS"; then
                log_info "Token refresh successful"
                return 0
            else
                log_error "Token refresh command did not succeed"
                return 1
            fi
        elif [ "$status" = "Failed" ] || [ "$status" = "Cancelled" ] || [ "$status" = "TimedOut" ]; then
            log_error "SSM command failed" "status=$status"
            return 1
        fi
    done

    log_error "Timeout waiting for token refresh"
    return 1
}

# Function to check if token is likely expired (older than 20 hours)
check_token_age() {
    local token_updated
    token_updated=$(aws ssm get-parameter \
        --name "/${clusterName}/cluster/join-token-updated" \
        --query 'Parameter.Value' --output text --region "$REGION" 2>/dev/null)

    if [ -z "$token_updated" ] || [ "$token_updated" = "None" ]; then
        # No timestamp, check when the token parameter was last modified
        token_updated=$(aws ssm get-parameter \
            --name "/${clusterName}/cluster/join-token" \
            --query 'Parameter.LastModifiedDate' --output text --region "$REGION" 2>/dev/null)
    fi

    if [ -z "$token_updated" ] || [ "$token_updated" = "None" ]; then
        echo "unknown"
        return
    fi

    # Convert to epoch
    local token_epoch
    local now_epoch
    token_epoch=$(date -d "$token_updated" +%s 2>/dev/null || date -jf "%Y-%m-%dT%H:%M:%S" "$token_updated" +%s 2>/dev/null)
    now_epoch=$(date +%s)

    if [ -z "$token_epoch" ]; then
        echo "unknown"
        return
    fi

    local age_hours=$(( (now_epoch - token_epoch) / 3600 ))
    echo "$age_hours"
}

# Get configuration from SSM parameters (with retries)
KUBERNETES_VERSION=$(retry_command_output aws ssm get-parameter --name '/${clusterName}/kubernetes/version' --query 'Parameter.Value' --output text --region $REGION)
CLUSTER_ENDPOINT=$(retry_command_output aws ssm get-parameter --name '/${clusterName}/cluster/endpoint' --query 'Parameter.Value' --output text --region $REGION)
CA_CERT_HASH=$(retry_command_output aws ssm get-parameter --name '/${clusterName}/cluster/ca-cert-hash' --query 'Parameter.Value' --output text --region $REGION)

# Check token age and refresh if needed
TOKEN_AGE=$(check_token_age)
log_info "Join token age" "age_hours=$TOKEN_AGE"

if [ "$TOKEN_AGE" != "unknown" ] && [ "$TOKEN_AGE" -ge 20 ]; then
    log_info "Token is near expiry, requesting refresh" "age_hours=$TOKEN_AGE"
    if request_new_token; then
        log_info "Token refreshed successfully"
    else
        log_warn "Token refresh failed, will try existing token"
    fi
fi

# Get join token (might be freshly refreshed)
JOIN_TOKEN=$(retry_command_output aws ssm get-parameter --name '/${clusterName}/cluster/join-token' --with-decryption --query 'Parameter.Value' --output text --region $REGION)

# WHY validate_ssm_params: SSM parameters are created with placeholder values during CDK deploy.
# The first control plane updates them with real values after kubeadm init. Workers starting
# before control plane completes would fail confusingly without this early validation.
validate_ssm_params() {
    local has_error=false

    if [ "$CLUSTER_ENDPOINT" = "PENDING_INITIALIZATION" ] || [ "$CLUSTER_ENDPOINT" = "placeholder" ]; then
        log_error "Cluster endpoint not initialized - cluster may not be ready"
        has_error=true
    fi

    if [ "$CA_CERT_HASH" = "PENDING_INITIALIZATION" ] || [ "$CA_CERT_HASH" = "placeholder" ]; then
        log_error "CA certificate hash not initialized - cluster may not be ready"
        has_error=true
    fi

    if [ "$JOIN_TOKEN" = "PENDING_INITIALIZATION" ] || [ "$JOIN_TOKEN" = "placeholder" ]; then
        log_error "Join token not initialized - cluster may not be ready"
        has_error=true
    fi

    if [ "$has_error" = "true" ]; then
        log_error "SSM parameters contain uninitialized values - control plane may not have completed initialization"
        exit 1
    fi
}

validate_ssm_params

log_info "Cluster configuration retrieved" "kubernetes_version=$KUBERNETES_VERSION" "cluster_endpoint=$CLUSTER_ENDPOINT"

# Configure containerd (already installed in AMI)
systemctl enable containerd
systemctl start containerd

# Configure kubelet using pre-installed binary
mkdir -p /etc/kubernetes/kubelet
cat > /etc/kubernetes/kubelet/kubelet-config.yaml << 'EOF'
kind: KubeletConfiguration
apiVersion: kubelet.config.k8s.io/v1beta1
address: 0.0.0.0
port: 10250
readOnlyPort: 0
cgroupDriver: systemd
cgroupsPerQOS: true
enforceNodeAllocatable: ["pods"]
authentication:
  anonymous:
    enabled: false
  webhook:
    enabled: true
  x509:
    clientCAFile: "/etc/kubernetes/pki/ca.crt"
authorization:
  mode: Webhook
clusterDomain: "cluster.local"
clusterDNS: ["10.96.0.10"]
runtimeRequestTimeout: "15m"
kubeReserved:
  cpu: 100m
  memory: 128Mi
systemReserved:
  cpu: 100m
  memory: 128Mi
maxPods: 110
# Certificate rotation settings
rotateCertificates: true
serverTLSBootstrap: true
EOF

# Create kubelet systemd service using pre-installed binary
cat > /etc/systemd/system/kubelet.service << 'EOF'
[Unit]
Description=kubelet: The Kubernetes Node Agent
Documentation=https://kubernetes.io/docs/home/
Wants=network-online.target
After=network-online.target

[Service]
ExecStart=/usr/bin/kubelet \\
  --config=/etc/kubernetes/kubelet/kubelet-config.yaml \\
  --container-runtime-endpoint=unix:///run/containerd/containerd.sock \\
  --kubeconfig=/etc/kubernetes/kubelet.conf \\
  --bootstrap-kubeconfig=/etc/kubernetes/bootstrap-kubelet.conf \\
  --v=2
Restart=always
StartLimitInterval=0
RestartSec=10

[Install]
WantedBy=multi-user.target
EOF

# Enable kubelet service
systemctl daemon-reload
systemctl enable kubelet

# Function to attempt cluster join
attempt_join() {
    local token="$1"
    local node_name
    node_name=$(hostname -f)
    log_info "Attempting to join cluster with token"
    kubeadm join "$CLUSTER_ENDPOINT" \
        --token "$token" \
        --discovery-token-ca-cert-hash "$CA_CERT_HASH" \
        --node-name "$node_name"
    return $?
}

BOOTSTRAP_STAGE="kubeadm-join"

# Join cluster using pre-installed kubeadm
if [ -n "$CLUSTER_ENDPOINT" ] && [ -n "$JOIN_TOKEN" ] && [ -n "$CA_CERT_HASH" ]; then
    log_info "Joining cluster using kubeadm"

    if attempt_join "$JOIN_TOKEN"; then
        log_info "Successfully joined cluster as worker node"
        BOOTSTRAP_STAGE="complete"
    else
        log_info "First join attempt failed, requesting fresh token"

        # Try to get a fresh token
        if request_new_token; then
            # Get the new token
            NEW_JOIN_TOKEN=$(retry_command_output aws ssm get-parameter --name '/${clusterName}/cluster/join-token' --with-decryption --query 'Parameter.Value' --output text --region $REGION)

            if [ -n "$NEW_JOIN_TOKEN" ] && [ "$NEW_JOIN_TOKEN" != "$JOIN_TOKEN" ]; then
                log_info "Got fresh token, retrying join"
                # Reset kubeadm state before retry
                kubeadm reset -f 2>/dev/null || true

                if attempt_join "$NEW_JOIN_TOKEN"; then
                    log_info "Successfully joined cluster with fresh token"
                    BOOTSTRAP_STAGE="complete"
                else
                    log_error "Join failed even with fresh token"
                    exit 1
                fi
            else
                log_error "Could not get a different token"
                exit 1
            fi
        else
            log_error "Token refresh failed"
            exit 1
        fi
    fi
else
    log_error "Missing required join parameters from SSM"
    exit 1
fi

# Disable cleanup trap on successful completion
trap - EXIT
BOOTSTRAP_STAGE="complete"

log_info "Worker node bootstrap completed successfully"
`;
}
