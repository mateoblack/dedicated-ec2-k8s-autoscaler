import * as cdk from 'aws-cdk-lib';
import { getBashRetryFunctions } from './bash-retry';

/**
 * Creates the control plane bootstrap script for Kubernetes cluster initialization and joining.
 *
 * This script handles:
 * - First control plane: Initializes cluster with kubeadm, sets up OIDC for IRSA,
 *   installs CNI (Cilium), cluster-autoscaler, and CSR auto-approver
 * - Additional control planes: Joins existing cluster as control plane node
 * - Disaster recovery: Restores from etcd backup when in restore mode
 * - Registers etcd members in DynamoDB for lifecycle management
 * - Registers with load balancer target group
 * - Sets up automatic certificate rotation
 *
 * @param clusterName - The name of the Kubernetes cluster
 * @param oidcProviderArn - ARN of the OIDC provider for IRSA
 * @param oidcBucketName - S3 bucket name for OIDC discovery documents
 * @param etcdBackupBucketName - S3 bucket name for etcd backups
 * @param stack - The CDK stack (used to get the region)
 * @returns The bootstrap script as a string
 */
export function createControlPlaneBootstrapScript(
  clusterName: string,
  oidcProviderArn: string,
  oidcBucketName: string,
  etcdBackupBucketName: string,
  stack: cdk.Stack
): string {
  const region = stack.region;
  return `
# Control plane bootstrap script - Cluster initialization and joining
echo "Starting control plane bootstrap for cluster: ${clusterName}"

# Retry configuration
MAX_RETRIES=5
RETRY_DELAY=5

# WHY BOOTSTRAP_STAGE: cleanup_on_failure needs to know how far bootstrap progressed.
# Different stages require different cleanup: early failures only reset kubeadm, while
# later failures may need to deregister from LB, remove etcd member, and release locks.
BOOTSTRAP_STAGE="init"
ETCD_REGISTERED=false
LB_REGISTERED=false
CLUSTER_LOCK_HELD=false

# Cleanup function for failed bootstrap
cleanup_on_failure() {
    local exit_code=\$?
    if [ \$exit_code -eq 0 ]; then
        return 0
    fi

    echo "Bootstrap failed at stage: \$BOOTSTRAP_STAGE (exit code: \$exit_code)"
    echo "Running cleanup..."

    # Remove from load balancer if registered
    if [ "\$LB_REGISTERED" = "true" ]; then
        echo "Removing from load balancer target group..."
        TARGET_GROUP_ARN=$(aws elbv2 describe-target-groups --names '${clusterName}-control-plane-tg' --query 'TargetGroups[0].TargetGroupArn' --output text --region $REGION 2>/dev/null)
        if [ -n "\$TARGET_GROUP_ARN" ] && [ "\$TARGET_GROUP_ARN" != "None" ]; then
            aws elbv2 deregister-targets --target-group-arn "\$TARGET_GROUP_ARN" --targets Id=\$INSTANCE_ID,Port=6443 --region $REGION 2>/dev/null || true
        fi
    fi

    # Remove etcd member registration from DynamoDB if registered
    if [ "\$ETCD_REGISTERED" = "true" ]; then
        echo "Removing etcd member registration from DynamoDB..."
        # Get member info from DynamoDB
        member_info=\$(aws dynamodb query \
            --table-name "${clusterName}-etcd-members" \
            --index-name "InstanceIdIndex" \
            --key-condition-expression "InstanceId = :iid" \
            --expression-attribute-values '{":iid":{"S":"'\$INSTANCE_ID'"}}' \
            --query 'Items[0]' \
            --output json --region $REGION 2>/dev/null || echo "{}")

        # WHY process substitution < <(...): A pipe creates a subshell for the read command.
        # Variables set in a subshell don't propagate to the parent shell, so cluster_id
        # and member_id would be empty after the pipe. Process substitution keeps read
        # in the parent shell while still feeding it Python's output.
        read cluster_id member_id < <(echo "\$member_info" | python3 -c "
import sys, json
try:
    item = json.load(sys.stdin)
    if item:
        print(item.get('ClusterId', {}).get('S', ''), item.get('MemberId', {}).get('S', ''))
except:
    print('', '')
")

        # Delete if we got valid IDs
        if [ -n "\$cluster_id" ] && [ -n "\$member_id" ]; then
            aws dynamodb delete-item \
                --table-name "${clusterName}-etcd-members" \
                --key '{"ClusterId":{"S":"'\$cluster_id'"},"MemberId":{"S":"'\$member_id'"}}' \
                --region $REGION 2>/dev/null || true
        fi
    fi

    # Release cluster init lock if we held it
    if [ "\$CLUSTER_LOCK_HELD" = "true" ]; then
        echo "Releasing cluster initialization lock..."
        aws dynamodb delete-item \
            --table-name "${clusterName}-bootstrap-lock" \
            --key '{"LockName":{"S":"cluster-init"}}' \
            --region $REGION 2>/dev/null || true
    fi

    # Reset kubeadm state
    echo "Resetting kubeadm state..."
    kubeadm reset -f 2>/dev/null || true

    # Stop kubelet
    systemctl stop kubelet 2>/dev/null || true

    echo "Cleanup completed. Instance will need manual intervention or termination."

    # Signal unhealthy to ASG (optional - causes replacement)
    # Uncomment to auto-terminate failed instances:
    # aws autoscaling set-instance-health --instance-id \$INSTANCE_ID --health-status Unhealthy --region $REGION 2>/dev/null || true

    exit \$exit_code
}

# WHY trap EXIT not ERR: EXIT fires on ALL script terminations including set -e failures,
# explicit exit calls, and normal completion. ERR only catches simple command failures
# but misses exits from subshells or explicit exit statements.
trap cleanup_on_failure EXIT

# WHY release_init_lock function: Lock must be explicitly deleted from DynamoDB.
# Clearing CLUSTER_LOCK_HELD only prevents cleanup_on_failure from releasing it;
# the lock item still exists and blocks other nodes. Both success and failure paths
# need to call this to ensure the lock is properly released.
release_init_lock() {
    if [ "\$CLUSTER_LOCK_HELD" = "true" ]; then
        echo "Releasing cluster initialization lock from DynamoDB..."
        aws dynamodb delete-item \
            --table-name "${clusterName}-bootstrap-lock" \
            --key '{"LockName":{"S":"cluster-init"}}' \
            --region $REGION 2>/dev/null || true
        CLUSTER_LOCK_HELD=false
        echo "Cluster init lock released"
    fi
}

${getBashRetryFunctions()}

# Get instance metadata (with retries for IMDS)
get_instance_metadata() {
    local path="$1"
    local token=$(curl -s -X PUT "http://169.254.169.254/latest/api/token" -H "X-aws-ec2-metadata-token-ttl-seconds: 300" 2>/dev/null)
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
    echo "ERROR: Failed to get instance metadata"
    exit 1
fi

# Get cluster configuration from SSM (with retries)
KUBERNETES_VERSION=$(retry_command_output aws ssm get-parameter --name '/${clusterName}/kubernetes/version' --query 'Parameter.Value' --output text --region $REGION)
CLUSTER_ENDPOINT=$(retry_command_output aws ssm get-parameter --name '/${clusterName}/cluster/endpoint' --query 'Parameter.Value' --output text --region $REGION || echo "")
CLUSTER_INITIALIZED=$(retry_command_output aws ssm get-parameter --name '/${clusterName}/cluster/initialized' --query 'Parameter.Value' --output text --region $REGION || echo "false")

echo "Instance ID: $INSTANCE_ID"
echo "Private IP: $PRIVATE_IP"
echo "Kubernetes Version: $KUBERNETES_VERSION"
echo "Cluster Initialized: $CLUSTER_INITIALIZED"

# Configure containerd (already installed in AMI)
systemctl enable containerd
systemctl start containerd

# Configure kubelet (already installed in AMI)
systemctl enable kubelet

# Function to register etcd member in DynamoDB for lifecycle management
register_etcd_member() {
    echo "Registering etcd member in DynamoDB..."

    # Wait for etcd to be ready
    local max_attempts=30
    local attempt=1
    while [ $attempt -le $max_attempts ]; do
        if ETCDCTL_API=3 etcdctl \\
            --endpoints=https://127.0.0.1:2379 \\
            --cacert=/etc/kubernetes/pki/etcd/ca.crt \\
            --cert=/etc/kubernetes/pki/etcd/server.crt \\
            --key=/etc/kubernetes/pki/etcd/server.key \\
            endpoint health &>/dev/null; then
            echo "etcd is healthy"
            break
        fi
        echo "Waiting for etcd to be ready... (attempt $attempt/$max_attempts)"
        sleep 5
        attempt=$((attempt + 1))
    done

    if [ $attempt -gt $max_attempts ]; then
        echo "ERROR: etcd did not become healthy in time"
        return 1
    fi

    # Get etcd member ID for this node
    # The member name matches the hostname
    local hostname=$(hostname)
    local member_info=$(ETCDCTL_API=3 etcdctl \\
        --endpoints=https://127.0.0.1:2379 \\
        --cacert=/etc/kubernetes/pki/etcd/ca.crt \\
        --cert=/etc/kubernetes/pki/etcd/server.crt \\
        --key=/etc/kubernetes/pki/etcd/server.key \\
        member list -w json 2>/dev/null)

    if [ -z "$member_info" ]; then
        echo "ERROR: Failed to get etcd member list"
        return 1
    fi

    # WHY decimal to hex conversion: etcdctl member list returns ID as decimal in JSON,
    # but etcdctl member remove/update commands expect hex format (e.g., "1234" → "4d2").
    local decimal_id=$(echo "$member_info" | grep -o '"ID":[0-9]*' | head -1 | cut -d: -f2)
    local etcd_member_id=""
    if [ -n "$decimal_id" ]; then
        etcd_member_id=$(printf '%x' "$decimal_id" 2>/dev/null || echo "")
    fi

    # WHY search by IP then name: Some etcd versions (or newly joined members) don't set
    # the member name immediately. IP-based lookup is more reliable for fresh joins.
    local member_by_ip=$(echo "$member_info" | python3 -c "
import sys, json
try:
    data = json.load(sys.stdin)
    for member in data.get('members', []):
        for url in member.get('peerURLs', []):
            if '$PRIVATE_IP' in url:
                print(format(member['ID'], 'x'))
                sys.exit(0)
    # If not found by IP, try by name
    for member in data.get('members', []):
        if member.get('name') == '$hostname':
            print(format(member['ID'], 'x'))
            sys.exit(0)
except:
    pass
" 2>/dev/null)

    if [ -n "$member_by_ip" ]; then
        etcd_member_id="$member_by_ip"
    fi

    if [ -z "$etcd_member_id" ]; then
        echo "ERROR: Could not determine etcd member ID for this node"
        return 1
    fi

    echo "Found etcd member ID: $etcd_member_id"

    # Register in DynamoDB
    aws dynamodb put-item \\
        --table-name "${clusterName}-etcd-members" \\
        --item '{
            "ClusterId": {"S": "'${clusterName}'"},
            "MemberId": {"S": "'$etcd_member_id'"},
            "InstanceId": {"S": "'$INSTANCE_ID'"},
            "PrivateIp": {"S": "'$PRIVATE_IP'"},
            "EtcdMemberId": {"S": "'$etcd_member_id'"},
            "Hostname": {"S": "'$hostname'"},
            "Status": {"S": "ACTIVE"},
            "CreatedAt": {"S": "'$(date -u +%Y-%m-%dT%H:%M:%SZ)'"}
        }' \\
        --region $REGION

    if [ $? -eq 0 ]; then
        echo "Successfully registered etcd member $etcd_member_id in DynamoDB"
        return 0
    else
        echo "ERROR: Failed to register etcd member in DynamoDB"
        return 1
    fi
}

# Function to restore etcd from backup
restore_from_backup() {
    local backup_key="$1"
    echo "Restoring cluster from backup: $backup_key"

    BOOTSTRAP_STAGE="restore-download"

    # Download backup from S3
    local backup_file="/tmp/etcd-restore.db"
    if ! retry_command aws s3 cp s3://${etcdBackupBucketName}/\$backup_key \$backup_file --region $REGION; then
        echo "ERROR: Failed to download backup from S3"
        return 1
    fi

    echo "Backup downloaded successfully"

    BOOTSTRAP_STAGE="restore-etcd"

    # Create data directory for restored etcd
    local restore_dir="/var/lib/etcd-restore"
    rm -rf \$restore_dir
    mkdir -p \$restore_dir

    # Restore etcd snapshot
    # Note: We use a new data directory and will configure etcd to use it
    ETCDCTL_API=3 etcdctl snapshot restore \$backup_file \\
        --data-dir=\$restore_dir \\
        --name=$(hostname) \\
        --initial-cluster=$(hostname)=https://\$PRIVATE_IP:2380 \\
        --initial-cluster-token=${clusterName}-restored \\
        --initial-advertise-peer-urls=https://\$PRIVATE_IP:2380

    if [ \$? -ne 0 ]; then
        echo "ERROR: etcd restore failed"
        return 1
    fi

    echo "etcd snapshot restored to \$restore_dir"

    # Move restored data to etcd data directory
    rm -rf /var/lib/etcd
    mv \$restore_dir /var/lib/etcd

    # Set proper ownership
    chown -R root:root /var/lib/etcd

    # Clean up
    rm -f \$backup_file

    BOOTSTRAP_STAGE="restore-kubeadm"

    # Initialize kubeadm with the restored etcd
    # Use kubeadm init phase to set up control plane components
    # but skip etcd since we restored it

    # Ensure audit policy and log directory exist for restore case
    mkdir -p /etc/kubernetes
    mkdir -p /var/log/kubernetes/audit
    cat > /etc/kubernetes/audit-policy.yaml << 'AUDITPOLICYRESTORE'
apiVersion: audit.k8s.io/v1
kind: Policy
omitStages:
  - "RequestReceived"
rules:
  - level: None
    nonResourceURLs:
      - /healthz*
      - /readyz*
      - /livez*
      - /metrics
      - /openapi/*
  - level: None
    verbs: ["watch"]
  - level: RequestResponse
    nonResourceURLs:
      - /apis/authentication.k8s.io/*
  - level: Metadata
    resources:
      - group: ""
        resources: ["secrets", "configmaps"]
  - level: RequestResponse
    verbs: ["create", "delete", "patch", "update"]
    resources:
      - group: ""
        resources: ["namespaces", "serviceaccounts"]
      - group: "rbac.authorization.k8s.io"
        resources: ["*"]
  - level: RequestResponse
    verbs: ["create"]
    resources:
      - group: ""
        resources: ["pods/exec", "pods/attach", "pods/portforward"]
  - level: Metadata
    resources:
      - group: ""
      - group: "apps"
      - group: "batch"
AUDITPOLICYRESTORE

    # First, create kubeadm config for restoration with audit logging
    cat > /tmp/kubeadm-restore-config.yaml << KUBEADMEOF
apiVersion: kubeadm.k8s.io/v1beta3
kind: InitConfiguration
localAPIEndpoint:
  advertiseAddress: \$PRIVATE_IP
  bindPort: 6443
nodeRegistration:
  name: $(hostname)
---
apiVersion: kubeadm.k8s.io/v1beta3
kind: ClusterConfiguration
kubernetesVersion: v\$KUBERNETES_VERSION
controlPlaneEndpoint: "${clusterName}-cp-lb.internal:6443"
networking:
  podSubnet: 10.244.0.0/16
  serviceSubnet: 10.96.0.0/12
etcd:
  local:
    dataDir: /var/lib/etcd
apiServer:
  extraArgs:
    service-account-issuer: https://s3.$REGION.amazonaws.com/${oidcBucketName}
    audit-policy-file: /etc/kubernetes/audit-policy.yaml
    audit-log-path: /var/log/kubernetes/audit/audit.log
    audit-log-maxage: "30"
    audit-log-maxbackup: "10"
    audit-log-maxsize: "100"
  extraVolumes:
    - name: audit-policy
      hostPath: /etc/kubernetes/audit-policy.yaml
      mountPath: /etc/kubernetes/audit-policy.yaml
      readOnly: true
    - name: audit-logs
      hostPath: /var/log/kubernetes/audit
      mountPath: /var/log/kubernetes/audit
      readOnly: false
KUBEADMEOF

    # Run kubeadm init with the restored etcd
    # The --ignore-preflight-errors is needed because etcd data already exists
    kubeadm init \\
        --config=/tmp/kubeadm-restore-config.yaml \\
        --ignore-preflight-errors=DirAvailable--var-lib-etcd \\
        --upload-certs

    if [ \$? -ne 0 ]; then
        echo "ERROR: kubeadm init after restore failed"
        return 1
    fi

    echo "Cluster restored successfully!"

    # Configure kubectl
    mkdir -p /root/.kube
    cp -i /etc/kubernetes/admin.conf /root/.kube/config
    chown root:root /root/.kube/config

    # Generate new tokens and update SSM
    CERT_KEY=$(kubeadm certs certificate-key)
    kubeadm init phase upload-certs --upload-certs --certificate-key=\$CERT_KEY

    JOIN_TOKEN=$(kubeadm token create --ttl 24h)
    CA_CERT_HASH=$(openssl x509 -pubkey -in /etc/kubernetes/pki/ca.crt | openssl rsa -pubin -outform der 2>/dev/null | openssl dgst -sha256 -hex | sed 's/^.* //')

    # Update SSM parameters
    retry_command aws ssm put-parameter --name '/${clusterName}/cluster/endpoint' --value '${clusterName}-cp-lb.internal:6443' --type 'String' --overwrite --region $REGION
    retry_command aws ssm put-parameter --name '/${clusterName}/cluster/join-token' --value "\$JOIN_TOKEN" --type 'SecureString' --overwrite --region $REGION
    retry_command aws ssm put-parameter --name '/${clusterName}/cluster/join-token-updated' --value "\$(date -u +%Y-%m-%dT%H:%M:%SZ)" --type 'String' --overwrite --region $REGION
    retry_command aws ssm put-parameter --name '/${clusterName}/cluster/ca-cert-hash' --value "sha256:\$CA_CERT_HASH" --type 'String' --overwrite --region $REGION
    retry_command aws ssm put-parameter --name '/${clusterName}/cluster/certificate-key' --value "\$CERT_KEY" --type 'SecureString' --overwrite --region $REGION
    retry_command aws ssm put-parameter --name '/${clusterName}/cluster/certificate-key-updated' --value "\$(date -u +%Y-%m-%dT%H:%M:%SZ)" --type 'String' --overwrite --region $REGION
    retry_command aws ssm put-parameter --name '/${clusterName}/cluster/initialized' --value 'true' --type 'String' --overwrite --region $REGION

    # Clear restore mode
    retry_command aws ssm put-parameter --name '/${clusterName}/cluster/restore-mode' --value 'false' --type 'String' --overwrite --region $REGION

    # Register etcd member
    if register_etcd_member; then
        ETCD_REGISTERED=true
    else
        echo "WARNING: Failed to register etcd member, lifecycle cleanup may not work"
    fi

    # Install CNI
    echo "Installing Cilium CNI plugin..."
    kubectl apply -f https://raw.githubusercontent.com/cilium/cilium/v1.14.5/install/kubernetes/quick-install.yaml

    return 0
}

# Check for restore mode (disaster recovery)
RESTORE_MODE=$(retry_command_output aws ssm get-parameter --name '/${clusterName}/cluster/restore-mode' --query 'Parameter.Value' --output text --region $REGION || echo "false")
RESTORE_BACKUP=$(retry_command_output aws ssm get-parameter --name '/${clusterName}/cluster/restore-backup' --query 'Parameter.Value' --output text --region $REGION || echo "")

if [ "\$RESTORE_MODE" = "true" ] && [ -n "\$RESTORE_BACKUP" ]; then
    echo "RESTORE MODE DETECTED - Attempting disaster recovery"
    echo "Backup to restore: \$RESTORE_BACKUP"

    # WHY stale lock detection: A crashed restore leaves an orphan lock in DynamoDB.
    # Without cleanup, DR is blocked forever - no node can acquire the restore lock.
    # WHY 30-minute TTL: Restore (S3 download + etcd restore + kubeadm init) should
    # complete within 30 min. Any lock older than that indicates a dead holder.
    RESTORE_LOCK_TTL=1800

    existing_lock=$(aws dynamodb get-item \\
        --table-name "${clusterName}-etcd-members" \\
        --key '{"ClusterId":{"S":"'${clusterName}'"},"MemberId":{"S":"restore-lock"}}' \\
        --query 'Item' --output json --region $REGION 2>/dev/null || echo "{}")

    if [ "\$existing_lock" != "{}" ] && [ "\$existing_lock" != "null" ] && [ -n "\$existing_lock" ]; then
        # Extract lock details
        lock_created=$(echo "\$existing_lock" | grep -o '"CreatedAt":{[^}]*}' | grep -o '"S":"[^"]*"' | cut -d'"' -f4)
        lock_holder=$(echo "\$existing_lock" | grep -o '"InstanceId":{[^}]*}' | grep -o '"S":"[^"]*"' | cut -d'"' -f4)

        if [ -n "\$lock_created" ]; then
            # Calculate lock age
            lock_epoch=$(date -d "\$lock_created" +%s 2>/dev/null || echo "0")
            now_epoch=$(date +%s)
            lock_age=\$((now_epoch - lock_epoch))

            echo "Found existing restore lock: held by \$lock_holder, created at \$lock_created (age: \${lock_age}s)"

            if [ "\$lock_age" -gt "\$RESTORE_LOCK_TTL" ]; then
                echo "Stale restore lock detected (>\${RESTORE_LOCK_TTL}s old) - removing stale lock from \$lock_holder"
                aws dynamodb delete-item \\
                    --table-name "${clusterName}-etcd-members" \\
                    --key '{"ClusterId":{"S":"'${clusterName}'"},"MemberId":{"S":"restore-lock"}}' \\
                    --region $REGION 2>/dev/null || true
                echo "Stale lock removed, proceeding with restore attempt"
            fi
        fi
    fi

    # WHY restore lock: Only one node should restore from backup. If multiple nodes
    # attempt restore simultaneously, they'd each create separate single-node clusters.
    # Losers of this lock race fall through to normal join logic once winner completes.
    if aws dynamodb put-item \\
        --table-name "${clusterName}-etcd-members" \\
        --item '{"ClusterId":{"S":"'${clusterName}'"},"MemberId":{"S":"restore-lock"},"InstanceId":{"S":"'$INSTANCE_ID'"},"Status":{"S":"RESTORING"},"CreatedAt":{"S":"'$(date -u +%Y-%m-%dT%H:%M:%SZ)'"}}' \\
        --condition-expression "attribute_not_exists(ClusterId)" \\
        --region $REGION 2>/dev/null; then

        echo "Acquired restore lock, proceeding with restoration..."

        if restore_from_backup "\$RESTORE_BACKUP"; then
            echo "Disaster recovery completed successfully!"

            # Register with load balancer
            TARGET_GROUP_ARN=$(retry_command_output aws elbv2 describe-target-groups --names '${clusterName}-control-plane-tg' --query 'TargetGroups[0].TargetGroupArn' --output text --region $REGION)
            if [ -n "\$TARGET_GROUP_ARN" ]; then
                retry_command aws elbv2 register-targets --target-group-arn \$TARGET_GROUP_ARN --targets Id=\$INSTANCE_ID,Port=6443 --region $REGION
                LB_REGISTERED=true
            fi

            # Release restore lock
            aws dynamodb delete-item \\
                --table-name "${clusterName}-etcd-members" \\
                --key '{"ClusterId":{"S":"'${clusterName}'"},"MemberId":{"S":"restore-lock"}}' \\
                --region $REGION 2>/dev/null || true

            BOOTSTRAP_STAGE="complete"
            trap - EXIT

            echo "Control plane bootstrap (restore) completed successfully!"
            exit 0
        else
            echo "Disaster recovery failed!"
            # Release restore lock
            aws dynamodb delete-item \\
                --table-name "${clusterName}-etcd-members" \\
                --key '{"ClusterId":{"S":"'${clusterName}'"},"MemberId":{"S":"restore-lock"}}' \\
                --region $REGION 2>/dev/null || true
            exit 1
        fi
    else
        echo "Another node is handling restoration, waiting for cluster to be ready..."
        # Fall through to normal join logic
    fi
fi

# Check if this should be the first control plane node
if [ "$CLUSTER_INITIALIZED" = "false" ]; then
    echo "Attempting to initialize cluster as first control plane node..."

    BOOTSTRAP_STAGE="acquiring-lock"

    # Try to acquire cluster initialization lock using DynamoDB
    # WHY DynamoDB lock: Multiple control planes may start simultaneously from ASG scaling.
    # Only one node should initialize the cluster; others must wait then join.
    # WHY attribute_not_exists: This is an atomic conditional write - if another node
    # already inserted the lock, this put-item fails, ensuring exactly-once initialization.
    if aws dynamodb put-item \\
        --table-name "${clusterName}-bootstrap-lock" \\
        --item '{"LockName":{"S":"cluster-init"},"InstanceId":{"S":"'$INSTANCE_ID'"},"Status":{"S":"INITIALIZING"},"CreatedAt":{"S":"'$(date -u +%Y-%m-%dT%H:%M:%SZ)'"}}' \\
        --condition-expression "attribute_not_exists(LockName)" \\
        --region $REGION 2>/dev/null; then

        # WHY track CLUSTER_LOCK_HELD: cleanup_on_failure needs to know if we own the lock.
        # If bootstrap fails after acquiring lock, we must release it so another node can retry.
        CLUSTER_LOCK_HELD=true
        BOOTSTRAP_STAGE="kubeadm-init"
        echo "Acquired initialization lock - initializing cluster..."

        # Set OIDC issuer URL for IRSA (before kubeadm init)
        OIDC_BUCKET="${oidcBucketName}"
        OIDC_ISSUER="https://s3.$REGION.amazonaws.com/$OIDC_BUCKET"

        # Generate certificate key for control plane join (before kubeadm init)
        # This key allows additional control plane nodes to download certs
        CERT_KEY=$(kubeadm certs certificate-key)

        # Create audit policy for API server audit logging
        # This policy logs security-relevant events while minimizing noise
        mkdir -p /etc/kubernetes
        mkdir -p /var/log/kubernetes/audit
        cat > /etc/kubernetes/audit-policy.yaml << 'AUDITPOLICY'
apiVersion: audit.k8s.io/v1
kind: Policy
# Don't log requests to these endpoints (high volume, low value)
omitStages:
  - "RequestReceived"
rules:
  # Don't log health checks and other high-volume endpoints
  - level: None
    nonResourceURLs:
      - /healthz*
      - /readyz*
      - /livez*
      - /metrics
      - /openapi/*
      - /api/v1/namespaces/kube-system/configmaps/kube-root-ca.crt

  # Don't log watch requests (very high volume)
  - level: None
    verbs: ["watch"]

  # Don't log node status updates from kubelet (high volume)
  - level: None
    users: ["system:node:*", "kubelet"]
    verbs: ["patch", "update"]
    resources:
      - group: ""
        resources: ["nodes/status"]

  # Don't log endpoint updates (high volume from kube-proxy)
  - level: None
    users: ["system:kube-proxy"]
    verbs: ["*"]
    resources:
      - group: ""
        resources: ["endpoints", "endpointslices"]

  # Log authentication failures at RequestResponse level
  - level: RequestResponse
    nonResourceURLs:
      - /apis/authentication.k8s.io/*

  # Log secret access at Metadata level (don't log contents)
  - level: Metadata
    resources:
      - group: ""
        resources: ["secrets", "configmaps"]

  # Log all changes to cluster-critical resources at RequestResponse level
  - level: RequestResponse
    verbs: ["create", "delete", "patch", "update"]
    resources:
      - group: ""
        resources: ["namespaces", "serviceaccounts"]
      - group: "rbac.authorization.k8s.io"
        resources: ["clusterroles", "clusterrolebindings", "roles", "rolebindings"]
      - group: "networking.k8s.io"
        resources: ["networkpolicies"]
      - group: "policy"
        resources: ["podsecuritypolicies"]

  # Log pod exec/attach/portforward at RequestResponse level
  - level: RequestResponse
    verbs: ["create"]
    resources:
      - group: ""
        resources: ["pods/exec", "pods/attach", "pods/portforward"]

  # Log everything else at Metadata level
  - level: Metadata
    resources:
      - group: ""
      - group: "apps"
      - group: "batch"
      - group: "extensions"
      - group: "networking.k8s.io"
AUDITPOLICY

        echo "Created audit policy at /etc/kubernetes/audit-policy.yaml"

        # Create kubeadm config file with audit logging enabled
        cat > /tmp/kubeadm-init-config.yaml << KUBEADMCONFIG
apiVersion: kubeadm.k8s.io/v1beta3
kind: InitConfiguration
localAPIEndpoint:
  advertiseAddress: $PRIVATE_IP
  bindPort: 6443
nodeRegistration:
  name: $(hostname)
certificateKey: $CERT_KEY
---
apiVersion: kubeadm.k8s.io/v1beta3
kind: ClusterConfiguration
kubernetesVersion: v$KUBERNETES_VERSION
controlPlaneEndpoint: "${clusterName}-cp-lb.internal:6443"
networking:
  podSubnet: 10.244.0.0/16
  serviceSubnet: 10.96.0.0/12
apiServer:
  extraArgs:
    service-account-issuer: $OIDC_ISSUER
    audit-policy-file: /etc/kubernetes/audit-policy.yaml
    audit-log-path: /var/log/kubernetes/audit/audit.log
    audit-log-maxage: "30"
    audit-log-maxbackup: "10"
    audit-log-maxsize: "100"
  extraVolumes:
    - name: audit-policy
      hostPath: /etc/kubernetes/audit-policy.yaml
      mountPath: /etc/kubernetes/audit-policy.yaml
      readOnly: true
    - name: audit-logs
      hostPath: /var/log/kubernetes/audit
      mountPath: /var/log/kubernetes/audit
      readOnly: false
KUBEADMCONFIG

        # Initialize cluster with kubeadm using config file
        # The service-account-issuer must match the OIDC issuer URL for IRSA to work
        # --upload-certs uploads control plane certs to kubeadm-certs secret (encrypted with CERT_KEY)
        kubeadm init \\
            --config=/tmp/kubeadm-init-config.yaml \\
            --upload-certs

        if [ $? -eq 0 ]; then
            echo "Cluster initialization successful!"

            # Configure kubectl for root user
            mkdir -p /root/.kube
            cp -i /etc/kubernetes/admin.conf /root/.kube/config
            chown root:root /root/.kube/config

            # Get join token and CA cert hash
            JOIN_TOKEN=$(kubeadm token list | grep -v TOKEN | head -1 | awk '{print $1}')
            CA_CERT_HASH=$(openssl x509 -pubkey -in /etc/kubernetes/pki/ca.crt | openssl rsa -pubin -outform der 2>/dev/null | openssl dgst -sha256 -hex | sed 's/^.* //')

            # Store cluster information in SSM (with retries)
            # Critical SSM parameters - if these fail, we must release the lock and exit
            BOOTSTRAP_STAGE="ssm-params"
            SSM_FAILED=false

            if ! retry_command aws ssm put-parameter --name '/${clusterName}/cluster/endpoint' --value '${clusterName}-cp-lb.internal:6443' --type 'String' --overwrite --region $REGION; then
                echo "ERROR: Failed to store cluster endpoint in SSM"
                SSM_FAILED=true
            fi

            if ! retry_command aws ssm put-parameter --name '/${clusterName}/cluster/join-token' --value "\$JOIN_TOKEN" --type 'SecureString' --overwrite --region $REGION; then
                echo "ERROR: Failed to store join token in SSM"
                SSM_FAILED=true
            fi

            if ! retry_command aws ssm put-parameter --name '/${clusterName}/cluster/join-token-updated' --value "\$(date -u +%Y-%m-%dT%H:%M:%SZ)" --type 'String' --overwrite --region $REGION; then
                echo "ERROR: Failed to store join token timestamp in SSM"
                SSM_FAILED=true
            fi

            if ! retry_command aws ssm put-parameter --name '/${clusterName}/cluster/ca-cert-hash' --value "sha256:\$CA_CERT_HASH" --type 'String' --overwrite --region $REGION; then
                echo "ERROR: Failed to store CA cert hash in SSM"
                SSM_FAILED=true
            fi

            if ! retry_command aws ssm put-parameter --name '/${clusterName}/cluster/certificate-key' --value "\$CERT_KEY" --type 'SecureString' --overwrite --region $REGION; then
                echo "ERROR: Failed to store certificate key in SSM"
                SSM_FAILED=true
            fi

            if ! retry_command aws ssm put-parameter --name '/${clusterName}/cluster/certificate-key-updated' --value "\$(date -u +%Y-%m-%dT%H:%M:%SZ)" --type 'String' --overwrite --region $REGION; then
                echo "ERROR: Failed to store certificate key timestamp in SSM"
                SSM_FAILED=true
            fi

            if ! retry_command aws ssm put-parameter --name '/${clusterName}/cluster/initialized' --value 'true' --type 'String' --overwrite --region $REGION; then
                echo "ERROR: Failed to store initialized flag in SSM"
                SSM_FAILED=true
            fi

            # Check if any critical SSM parameter updates failed
            if [ "\$SSM_FAILED" = "true" ]; then
                echo "CRITICAL: SSM parameter updates failed - releasing lock due to failure"
                release_init_lock
                exit 1
            fi

            # Register this node's etcd member in DynamoDB for lifecycle management
            BOOTSTRAP_STAGE="etcd-registration"
            if register_etcd_member; then
                ETCD_REGISTERED=true
            else
                echo "WARNING: Failed to register etcd member, lifecycle cleanup may not work"
            fi

            # Install CNI plugin (Cilium)
            echo "Installing Cilium CNI plugin..."
            kubectl apply -f https://raw.githubusercontent.com/cilium/cilium/v1.14.5/install/kubernetes/quick-install.yaml

            # Setup OIDC for IRSA (IAM Roles for Service Accounts)
            echo "Setting up OIDC discovery for IRSA..."
            OIDC_PROVIDER_ARN="${oidcProviderArn}"
            # OIDC_BUCKET and OIDC_ISSUER were set before kubeadm init

            # Extract the service account signing key from the cluster
            # The API server uses this key to sign ServiceAccount tokens
            SA_SIGNING_KEY_FILE="/etc/kubernetes/pki/sa.pub"

            if [ -f "$SA_SIGNING_KEY_FILE" ]; then
                echo "Generating OIDC discovery documents..."

                # Create OIDC discovery document
                cat > /tmp/openid-configuration.json <<OIDCEOF
{
    "issuer": "$OIDC_ISSUER",
    "jwks_uri": "$OIDC_ISSUER/keys.json",
    "authorization_endpoint": "urn:kubernetes:programmatic_authorization",
    "response_types_supported": ["id_token"],
    "subject_types_supported": ["public"],
    "id_token_signing_alg_values_supported": ["RS256"],
    "claims_supported": ["sub", "iss"]
}
OIDCEOF

                # WHY extract modulus from SA key: AWS OIDC provider validates ServiceAccount
                # tokens by verifying signatures against this public key. The JWK (JSON Web Key)
                # format is required by the OIDC spec for the keys.json endpoint.
                SA_PUB_KEY=$(cat $SA_SIGNING_KEY_FILE)

                # WHY base64url encoding: JWK spec (RFC 7517) requires base64url encoding
                # (not standard base64) with no padding characters. Standard base64 uses +/
                # which are URL-unsafe; base64url uses -_ instead.
                # WHY xxd fallback to Python: xxd (hex converter) isn't available on all AMIs.
                # Python's codecs module is universally available on K8s nodes.
                MODULUS_HEX=$(openssl rsa -pubin -in $SA_SIGNING_KEY_FILE -modulus -noout 2>&1)
                if [ $? -ne 0 ] || [ -z "\$MODULUS_HEX" ]; then
                    echo "ERROR: Failed to extract modulus from SA public key"
                    echo "OpenSSL output: \$MODULUS_HEX"
                fi

                # Extract just the hex value after Modulus=
                MODULUS_HEX_CLEAN=$(echo "\$MODULUS_HEX" | cut -d= -f2)

                # Check if xxd is available, use Python as fallback
                if command -v xxd >/dev/null 2>&1; then
                    # xxd is available - use traditional method
                    MODULUS=$(echo "\$MODULUS_HEX_CLEAN" | xxd -r -p | base64 -w0 | tr '+/' '-_' | tr -d '=')
                else
                    # xxd not available - use Python for hex to base64url conversion
                    echo "xxd not found, using Python for modulus conversion"
                    MODULUS=$(python3 -c "
import base64
import codecs
hex_str = '\$MODULUS_HEX_CLEAN'
binary = codecs.decode(hex_str, 'hex')
b64 = base64.urlsafe_b64encode(binary).decode('utf-8').rstrip('=')
print(b64)
")
                fi

                # Validate modulus is not empty
                if [ -z "\$MODULUS" ]; then
                    echo "ERROR: Modulus extraction failed - MODULUS is empty"
                    echo "This will cause IRSA token validation to fail"
                fi

                # RSA public exponent is typically 65537 (AQAB in base64url)
                EXPONENT="AQAB"

                # Generate key ID (kid) from the key fingerprint
                KID=$(openssl rsa -pubin -in $SA_SIGNING_KEY_FILE -outform DER 2>/dev/null | openssl dgst -sha256 -binary | base64 -w0 | tr '+/' '-_' | tr -d '=' | cut -c1-16)

                # Create JWKS document
                cat > /tmp/keys.json <<JWKSEOF
{
    "keys": [
        {
            "kty": "RSA",
            "alg": "RS256",
            "use": "sig",
            "kid": "$KID",
            "n": "$MODULUS",
            "e": "$EXPONENT"
        }
    ]
}
JWKSEOF

                # Validate JWK structure before upload
                if ! python3 -c "import json; j=json.load(open('/tmp/keys.json')); assert 'keys' in j and len(j['keys']) > 0 and j['keys'][0].get('n')" 2>/dev/null; then
                    echo "ERROR: Generated keys.json has invalid JWK structure"
                    cat /tmp/keys.json
                fi

                # Upload OIDC documents to S3 (with retries)
                echo "Uploading OIDC discovery documents to S3..."
                retry_command aws s3 cp /tmp/openid-configuration.json s3://\$OIDC_BUCKET/.well-known/openid-configuration --content-type application/json --region $REGION
                retry_command aws s3 cp /tmp/keys.json s3://\$OIDC_BUCKET/keys.json --content-type application/json --region $REGION

                # Get the S3 TLS certificate thumbprint for the AWS OIDC provider
                # AWS S3 uses Amazon Trust Services certificates
                # The thumbprint for s3.amazonaws.com is well-known
                S3_THUMBPRINT="9e99a48a9960b14926bb7f3b02e22da2b0ab7280"

                # For regional S3 endpoints, we need to get the actual thumbprint
                S3_ENDPOINT="s3.$REGION.amazonaws.com"
                ACTUAL_THUMBPRINT=$(echo | openssl s_client -servername \$S3_ENDPOINT -connect \$S3_ENDPOINT:443 2>/dev/null | openssl x509 -fingerprint -sha1 -noout | cut -d= -f2 | tr -d ':' | tr '[:upper:]' '[:lower:]')

                if [ -n "\$ACTUAL_THUMBPRINT" ]; then
                    S3_THUMBPRINT=\$ACTUAL_THUMBPRINT
                fi

                echo "S3 TLS Thumbprint: \$S3_THUMBPRINT"

                # Update the AWS OIDC provider with the correct thumbprint (with retries)
                echo "Updating AWS OIDC provider thumbprint..."
                retry_command aws iam update-open-id-connect-provider-thumbprint --open-id-connect-provider-arn \$OIDC_PROVIDER_ARN --thumbprint-list \$S3_THUMBPRINT --region $REGION

                # Store OIDC issuer URL in SSM for reference (with retries)
                retry_command aws ssm put-parameter --name '/${clusterName}/oidc/issuer' --value "\$OIDC_ISSUER" --type 'String' --overwrite --region $REGION

                echo "OIDC setup completed successfully!"
            else
                echo "WARNING: Service account signing key not found. OIDC setup skipped."
            fi

            # Install cluster-autoscaler with HA configuration
            echo "Installing cluster-autoscaler..."
            cat <<EOF | kubectl apply -f -
apiVersion: apps/v1
kind: Deployment
metadata:
  name: cluster-autoscaler
  namespace: kube-system
  labels:
    app: cluster-autoscaler
spec:
  selector:
    matchLabels:
      app: cluster-autoscaler
  replicas: 2
  template:
    metadata:
      labels:
        app: cluster-autoscaler
    spec:
      serviceAccountName: cluster-autoscaler
      affinity:
        podAntiAffinity:
          preferredDuringSchedulingIgnoredDuringExecution:
          - weight: 100
            podAffinityTerm:
              labelSelector:
                matchLabels:
                  app: cluster-autoscaler
              topologyKey: kubernetes.io/hostname
      tolerations:
      - key: node-role.kubernetes.io/control-plane
        operator: Exists
        effect: NoSchedule
      - key: node-role.kubernetes.io/master
        operator: Exists
        effect: NoSchedule
      containers:
      - image: registry.k8s.io/autoscaling/cluster-autoscaler:v1.29.0
        name: cluster-autoscaler
        resources:
          limits:
            cpu: 100m
            memory: 300Mi
          requests:
            cpu: 100m
            memory: 300Mi
        command:
        - ./cluster-autoscaler
        - --v=4
        - --stderrthreshold=info
        - --cloud-provider=aws
        - --skip-nodes-with-local-storage=false
        - --expander=least-waste
        - --node-group-auto-discovery=asg:tag=k8s.io/cluster-autoscaler/enabled,k8s.io/cluster-autoscaler/${clusterName}
        - --balance-similar-node-groups
        - --skip-nodes-with-system-pods=false
        - --leader-elect=true
        env:
        - name: AWS_REGION
          value: $REGION
---
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: cluster-autoscaler
  namespace: kube-system
spec:
  minAvailable: 1
  selector:
    matchLabels:
      app: cluster-autoscaler
EOF

            # Install kubelet CSR auto-approver for server certificates
            # This is needed when serverTLSBootstrap is enabled on kubelets
            echo "Installing kubelet CSR auto-approver..."
            cat <<EOF | kubectl apply -f -
apiVersion: v1
kind: ServiceAccount
metadata:
  name: kubelet-csr-approver
  namespace: kube-system
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: kubelet-csr-approver
rules:
- apiGroups: ["certificates.k8s.io"]
  resources: ["certificatesigningrequests"]
  verbs: ["get", "list", "watch"]
- apiGroups: ["certificates.k8s.io"]
  resources: ["certificatesigningrequests/approval"]
  verbs: ["update"]
- apiGroups: ["certificates.k8s.io"]
  resources: ["signers"]
  resourceNames: ["kubernetes.io/kubelet-serving"]
  verbs: ["approve"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: kubelet-csr-approver
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: kubelet-csr-approver
subjects:
- kind: ServiceAccount
  name: kubelet-csr-approver
  namespace: kube-system
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: kubelet-csr-approver
  namespace: kube-system
  labels:
    app: kubelet-csr-approver
spec:
  replicas: 2
  selector:
    matchLabels:
      app: kubelet-csr-approver
  template:
    metadata:
      labels:
        app: kubelet-csr-approver
    spec:
      serviceAccountName: kubelet-csr-approver
      affinity:
        podAntiAffinity:
          preferredDuringSchedulingIgnoredDuringExecution:
          - weight: 100
            podAffinityTerm:
              labelSelector:
                matchLabels:
                  app: kubelet-csr-approver
              topologyKey: kubernetes.io/hostname
      tolerations:
      - key: node-role.kubernetes.io/control-plane
        operator: Exists
        effect: NoSchedule
      - key: node-role.kubernetes.io/master
        operator: Exists
        effect: NoSchedule
      containers:
      - name: approver
        image: bitnami/kubectl:latest
        command:
        - /bin/bash
        - -c
        - |
          echo "Starting kubelet CSR auto-approver..."
          while true; do
            # Get pending CSRs for kubelet serving certificates
            for csr in \$(kubectl get csr -o jsonpath='{range .items[?(@.status.conditions==null)]}{.metadata.name}{" "}{end}' 2>/dev/null); do
              # Check if this is a kubelet serving CSR
              SIGNER=\$(kubectl get csr "\$csr" -o jsonpath='{.spec.signerName}' 2>/dev/null)
              REQUESTOR=\$(kubectl get csr "\$csr" -o jsonpath='{.spec.username}' 2>/dev/null)

              if [ "\$SIGNER" = "kubernetes.io/kubelet-serving" ]; then
                # Validate requestor is a node
                if echo "\$REQUESTOR" | grep -q "^system:node:"; then
                  echo "Approving kubelet serving CSR: \$csr (requestor: \$REQUESTOR)"
                  kubectl certificate approve "\$csr" || true
                else
                  echo "Skipping CSR \$csr: requestor '\$REQUESTOR' is not a node"
                fi
              fi
            done
            sleep 30
          done
        resources:
          requests:
            cpu: 10m
            memory: 32Mi
          limits:
            cpu: 50m
            memory: 64Mi
EOF

            # Register this instance with load balancer target group (with retries)
            BOOTSTRAP_STAGE="lb-registration"
            TARGET_GROUP_ARN=$(retry_command_output aws elbv2 describe-target-groups --names '${clusterName}-control-plane-tg' --query 'TargetGroups[0].TargetGroupArn' --output text --region $REGION)
            if [ -n "\$TARGET_GROUP_ARN" ]; then
                if retry_command aws elbv2 register-targets --target-group-arn \$TARGET_GROUP_ARN --targets Id=\$INSTANCE_ID,Port=6443 --region $REGION; then
                    LB_REGISTERED=true
                fi
            else
                echo "WARNING: Could not find target group ARN"
            fi

            # Release the init lock since we're done
            release_init_lock
            BOOTSTRAP_STAGE="complete"

            echo "First control plane node setup completed successfully!"
        else
            echo "Cluster initialization failed!"
            # Release the lock
            aws dynamodb delete-item \\
                --table-name "${clusterName}-bootstrap-lock" \\
                --key '{"LockName":{"S":"cluster-init"}}' \\
                --region $REGION
            exit 1
        fi
    else
        echo "Another node is initializing the cluster, waiting..."
        # Wait for cluster to be initialized by another node
        for i in {1..30}; do
            sleep 10
            CLUSTER_INITIALIZED=$(aws ssm get-parameter --name "/${clusterName}/cluster/initialized" --query 'Parameter.Value' --output text --region $REGION 2>/dev/null || echo "false")
            if [ "$CLUSTER_INITIALIZED" = "true" ]; then
                echo "Cluster has been initialized by another node"
                break
            fi
            echo "Waiting for cluster initialization... ($i/30)"
        done

        if [ "$CLUSTER_INITIALIZED" != "true" ]; then
            echo "Timeout waiting for cluster initialization"
            exit 1
        fi
    fi
fi

# Function to request a fresh join token from another control plane node
request_new_control_plane_token() {
    echo "Requesting new join token from existing control plane node..."

    # WHY token-refresh lock: Multiple joining nodes may detect expired token simultaneously.
    # Without coordination, they'd all call kubeadm token create, wasting resources and
    # potentially causing SSM parameter update conflicts.
    local lock_acquired=false
    if aws dynamodb put-item \
        --table-name "${clusterName}-bootstrap-lock" \
        --item '{"LockName":{"S":"token-refresh-lock"},"InstanceId":{"S":"'\$INSTANCE_ID'"},"CreatedAt":{"S":"'"\$(date -u +%Y-%m-%dT%H:%M:%SZ)"'"}}' \
        --condition-expression "attribute_not_exists(LockName)" \
        --region $REGION 2>/dev/null; then
        lock_acquired=true
        echo "Acquired token refresh lock"
    else
        # WHY check recent update: Another node may have just refreshed the token.
        # If token was updated in last 60s, our original "expired" check is stale - use new token.
        local token_updated=$(aws ssm get-parameter \
            --name "/${clusterName}/cluster/join-token-updated" \
            --query 'Parameter.Value' --output text --region $REGION 2>/dev/null)
        if [ -n "\$token_updated" ] && [ "\$token_updated" != "None" ]; then
            local token_epoch=\$(date -d "\$token_updated" +%s 2>/dev/null || echo "0")
            local now_epoch=\$(date +%s)
            local age_seconds=\$((now_epoch - token_epoch))
            if [ \$age_seconds -lt 60 ]; then
                echo "Token was recently updated (\${age_seconds}s ago), skip refresh"
                return 0
            fi
        fi
        echo "Could not acquire lock, another node may be refreshing"
        return 1
    fi

    # Cleanup function to release lock
    release_token_refresh_lock() {
        if [ "\$lock_acquired" = "true" ]; then
            aws dynamodb delete-item \
                --table-name "${clusterName}-bootstrap-lock" \
                --key '{"LockName":{"S":"token-refresh-lock"}}' \
                --region $REGION 2>/dev/null || true
            echo "Released token refresh lock"
        fi
    }

    # Find a healthy control plane instance (not ourselves)
    CONTROL_PLANE_INSTANCE=$(aws ec2 describe-instances \
        --filters "Name=tag:aws:autoscaling:groupName,Values=${clusterName}-control-plane" \
                  "Name=instance-state-name,Values=running" \
        --query "Reservations[].Instances[?InstanceId!='\$INSTANCE_ID'].InstanceId | [0]" \
        --output text --region $REGION 2>/dev/null)

    if [ -z "\$CONTROL_PLANE_INSTANCE" ] || [ "\$CONTROL_PLANE_INSTANCE" = "None" ]; then
        echo "ERROR: No other healthy control plane instance found"
        release_token_refresh_lock
        return 1
    fi

    echo "Found control plane instance: \$CONTROL_PLANE_INSTANCE"

    # Create script to generate new token on control plane (with certificate-key for control plane join)
    # WHY separate token-gen lock on target node: The requesting node holds token-refresh-lock
    # to coordinate among requesters, but the target control plane also needs protection.
    # Multiple SSM commands could arrive at the same control plane from different requesters.
    local token_script='
export KUBECONFIG=/etc/kubernetes/admin.conf
# WHY token-gen-lock: Prevent concurrent kubeadm token create calls on this node.
# kubeadm is not safe for concurrent execution and could corrupt cluster state.
if ! aws dynamodb put-item \
    --table-name "'${clusterName}'-bootstrap-lock" \
    --item '"'"'{"LockName":{"S":"token-gen-lock"},"CreatedAt":{"S":"'"'"'"$(date -u +%Y-%m-%dT%H:%M:%SZ)"'"'"'"}}'"'"' \
    --condition-expression "attribute_not_exists(LockName)" \
    --region '$REGION' 2>/dev/null; then
    echo "TOKEN_REFRESH_LOCKED"
    exit 0
fi
# Generate new token
NEW_TOKEN=$(kubeadm token create --ttl 24h 2>/dev/null)
CERT_KEY=$(kubeadm init phase upload-certs --upload-certs 2>/dev/null | tail -1)
if [ -n "$NEW_TOKEN" ]; then
    aws ssm put-parameter --name "/'${clusterName}'/cluster/join-token" \
        --value "$NEW_TOKEN" --type "SecureString" --overwrite --region '$REGION'
    aws ssm put-parameter --name "/'${clusterName}'/cluster/join-token-updated" \
        --value "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --type "String" --overwrite --region '$REGION'
    if [ -n "$CERT_KEY" ]; then
        aws ssm put-parameter --name "/'${clusterName}'/cluster/certificate-key" \
            --value "$CERT_KEY" --type "SecureString" --overwrite --region '$REGION'
        aws ssm put-parameter --name "/'${clusterName}'/cluster/certificate-key-updated" \
            --value "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --type "String" --overwrite --region '$REGION'
    fi
    echo "TOKEN_REFRESH_SUCCESS"
else
    echo "TOKEN_REFRESH_FAILED"
fi
# Release the lock
aws dynamodb delete-item \
    --table-name "'${clusterName}'-bootstrap-lock" \
    --key '"'"'{"LockName":{"S":"token-gen-lock"}}'"'"' \
    --region '$REGION' 2>/dev/null || true
'

    # Execute via SSM Run Command
    local command_id=$(aws ssm send-command \
        --instance-ids "\$CONTROL_PLANE_INSTANCE" \
        --document-name "AWS-RunShellScript" \
        --parameters "commands=[\"\$token_script\"]" \
        --query 'Command.CommandId' \
        --output text --region $REGION 2>/dev/null)

    if [ -z "\$command_id" ] || [ "\$command_id" = "None" ]; then
        echo "ERROR: Failed to send SSM command"
        release_token_refresh_lock
        return 1
    fi

    echo "SSM command sent: \$command_id"

    # Wait for command completion
    local max_wait=90
    local elapsed=0
    while [ \$elapsed -lt \$max_wait ]; do
        sleep 5
        elapsed=\$((elapsed + 5))

        local status=$(aws ssm get-command-invocation \
            --command-id "\$command_id" \
            --instance-id "\$CONTROL_PLANE_INSTANCE" \
            --query 'Status' --output text --region $REGION 2>/dev/null)

        if [ "\$status" = "Success" ]; then
            local output=$(aws ssm get-command-invocation \
                --command-id "\$command_id" \
                --instance-id "\$CONTROL_PLANE_INSTANCE" \
                --query 'StandardOutputContent' --output text --region $REGION 2>/dev/null)

            if echo "\$output" | grep -q "TOKEN_REFRESH_SUCCESS"; then
                echo "Token refresh successful"
                release_token_refresh_lock
                return 0
            else
                echo "Token refresh command did not succeed"
                release_token_refresh_lock
                return 1
            fi
        elif [ "\$status" = "Failed" ] || [ "\$status" = "Cancelled" ] || [ "\$status" = "TimedOut" ]; then
            echo "SSM command failed with status: \$status"
            release_token_refresh_lock
            return 1
        fi
    done

    echo "Timeout waiting for token refresh"
    release_token_refresh_lock
    return 1
}

# WHY 20-hour threshold: kubeadm tokens expire after 24 hours by default. Proactive
# refresh at 20 hours prevents join failures from expired tokens, which are harder
# to debug than a slightly early token refresh.
check_control_plane_token_age() {
    local token_updated=$(aws ssm get-parameter \
        --name "/${clusterName}/cluster/join-token-updated" \
        --query 'Parameter.Value' --output text --region $REGION 2>/dev/null)

    if [ -z "\$token_updated" ] || [ "\$token_updated" = "None" ]; then
        echo "unknown"
        return
    fi

    # Convert to epoch (Linux date format)
    local token_epoch=$(date -d "\$token_updated" +%s 2>/dev/null)
    local now_epoch=$(date +%s)

    if [ -z "\$token_epoch" ]; then
        echo "unknown"
        return
    fi

    local age_hours=\$(( (now_epoch - token_epoch) / 3600 ))
    echo "\$age_hours"
}

# WHY 90-minute threshold: kubeadm --upload-certs stores encrypted certs in kubeadm-certs
# secret with 2-hour TTL. Using 90 min instead of 120 provides buffer for network latency
# and clock skew. A node attempting join with expired certs fails cryptically.
check_certificate_key_age() {
    local cert_key_updated=$(aws ssm get-parameter \
        --name "/${clusterName}/cluster/certificate-key-updated" \
        --query 'Parameter.Value' --output text --region $REGION 2>/dev/null)

    if [ -z "\$cert_key_updated" ] || [ "\$cert_key_updated" = "None" ]; then
        # No timestamp means unknown age - consider it stale for safety
        echo "unknown"
        return
    fi

    # Convert to epoch (Linux date format)
    local cert_epoch=$(date -d "\$cert_key_updated" +%s 2>/dev/null)
    local now_epoch=$(date +%s)

    if [ -z "\$cert_epoch" ]; then
        echo "unknown"
        return
    fi

    local age_minutes=\$(( (now_epoch - cert_epoch) / 60 ))
    echo "\$age_minutes"
}

# Function to check etcd cluster health via an existing control plane node
check_etcd_health() {
    echo "Checking etcd cluster health before joining..."

    # Find a healthy control plane instance
    CONTROL_PLANE_INSTANCE=$(aws ec2 describe-instances \
        --filters "Name=tag:aws:autoscaling:groupName,Values=${clusterName}-control-plane" \
                  "Name=instance-state-name,Values=running" \
        --query 'Reservations[0].Instances[0].InstanceId' \
        --output text --region $REGION 2>/dev/null)

    if [ -z "\$CONTROL_PLANE_INSTANCE" ] || [ "\$CONTROL_PLANE_INSTANCE" = "None" ]; then
        echo "WARNING: No control plane instance found to check etcd health"
        return 0  # Allow join attempt anyway
    fi

    echo "Checking etcd via instance: \$CONTROL_PLANE_INSTANCE"

    # Check etcd health via SSM
    local health_script='
export ETCDCTL_API=3
export ETCDCTL_ENDPOINTS=https://127.0.0.1:2379
export ETCDCTL_CACERT=/etc/kubernetes/pki/etcd/ca.crt
export ETCDCTL_CERT=/etc/kubernetes/pki/etcd/server.crt
export ETCDCTL_KEY=/etc/kubernetes/pki/etcd/server.key

# Check endpoint health
if etcdctl endpoint health --cluster 2>&1; then
    # Also check that we have quorum
    MEMBER_COUNT=$(etcdctl member list 2>/dev/null | wc -l)
    if [ "$MEMBER_COUNT" -ge 1 ]; then
        echo "ETCD_HEALTHY members=$MEMBER_COUNT"
    else
        echo "ETCD_NO_MEMBERS"
    fi
else
    echo "ETCD_UNHEALTHY"
fi
'

    # Execute via SSM Run Command
    local command_id=$(aws ssm send-command \
        --instance-ids "\$CONTROL_PLANE_INSTANCE" \
        --document-name "AWS-RunShellScript" \
        --parameters "commands=[\"\$health_script\"]" \
        --query 'Command.CommandId' \
        --output text --region $REGION 2>/dev/null)

    if [ -z "\$command_id" ] || [ "\$command_id" = "None" ]; then
        echo "WARNING: Failed to send health check command"
        return 0  # Allow join attempt anyway
    fi

    # Wait for command completion
    local max_wait=60
    local elapsed=0
    while [ \$elapsed -lt \$max_wait ]; do
        sleep 5
        elapsed=\$((elapsed + 5))

        local status=$(aws ssm get-command-invocation \
            --command-id "\$command_id" \
            --instance-id "\$CONTROL_PLANE_INSTANCE" \
            --query 'Status' --output text --region $REGION 2>/dev/null)

        if [ "\$status" = "Success" ]; then
            local output=$(aws ssm get-command-invocation \
                --command-id "\$command_id" \
                --instance-id "\$CONTROL_PLANE_INSTANCE" \
                --query 'StandardOutputContent' --output text --region $REGION 2>/dev/null)

            if echo "\$output" | grep -q "ETCD_HEALTHY"; then
                local member_count=$(echo "\$output" | grep "ETCD_HEALTHY" | sed 's/.*members=//')
                echo "etcd cluster is healthy with \$member_count members"
                return 0
            elif echo "\$output" | grep -q "ETCD_NO_MEMBERS"; then
                echo "WARNING: etcd cluster has no members - this is unexpected"
                return 1
            else
                echo "WARNING: etcd cluster may be unhealthy"
                return 1
            fi
        elif [ "\$status" = "Failed" ] || [ "\$status" = "Cancelled" ] || [ "\$status" = "TimedOut" ]; then
            echo "WARNING: Health check command failed"
            return 0  # Allow join attempt anyway
        fi
    done

    echo "WARNING: Timeout waiting for health check"
    return 0  # Allow join attempt anyway
}

# Join existing cluster as additional control plane node
if [ "\$CLUSTER_INITIALIZED" = "true" ] && [ ! -f /etc/kubernetes/admin.conf ]; then
    echo "Joining existing cluster as additional control plane node..."

    # Check etcd health before attempting to join
    ETCD_HEALTHY=true
    if ! check_etcd_health; then
        echo "WARNING: etcd cluster may not be healthy. Waiting before join attempt..."
        # Wait and retry health check
        sleep 30
        if ! check_etcd_health; then
            echo "ERROR: etcd cluster still unhealthy after waiting. Aborting join."
            exit 1
        fi
    fi

    # Check token age and refresh if needed
    TOKEN_AGE=$(check_control_plane_token_age)
    echo "Join token age: \$TOKEN_AGE hours"

    if [ "\$TOKEN_AGE" != "unknown" ] && [ "\$TOKEN_AGE" -ge 20 ]; then
        echo "Token is \$TOKEN_AGE hours old (near expiry), requesting refresh..."
        request_new_control_plane_token || echo "WARNING: Token refresh failed, will try existing token"
    fi

    # Check certificate key age - kubeadm certs expire after 2 hours
    # Use 90 minute threshold (5400 seconds) to refresh before expiry
    CERT_KEY_AGE=$(check_certificate_key_age)
    echo "Certificate key age: \$CERT_KEY_AGE minutes"

    if [ "\$CERT_KEY_AGE" = "unknown" ] || [ "\$CERT_KEY_AGE" -ge 90 ]; then
        echo "Certificate key is stale or expired (\$CERT_KEY_AGE minutes old), requesting refresh..."
        request_new_control_plane_token || echo "WARNING: Certificate key refresh failed, will try existing key"
    fi

    # Get join information from SSM (with retries)
    JOIN_TOKEN=$(retry_command_output aws ssm get-parameter --name '/${clusterName}/cluster/join-token' --with-decryption --query 'Parameter.Value' --output text --region $REGION)
    CA_CERT_HASH=$(retry_command_output aws ssm get-parameter --name '/${clusterName}/cluster/ca-cert-hash' --query 'Parameter.Value' --output text --region $REGION)
    CLUSTER_ENDPOINT=$(retry_command_output aws ssm get-parameter --name '/${clusterName}/cluster/endpoint' --query 'Parameter.Value' --output text --region $REGION)
    CERT_KEY=$(retry_command_output aws ssm get-parameter --name '/${clusterName}/cluster/certificate-key' --with-decryption --query 'Parameter.Value' --output text --region $REGION || echo "")

    # Validate SSM parameters are initialized (not placeholder values)
    validate_join_params() {
        local has_error=false

        if [ "\$CLUSTER_ENDPOINT" = "PENDING_INITIALIZATION" ] || [ "\$CLUSTER_ENDPOINT" = "placeholder" ]; then
            echo "ERROR: Cluster endpoint not initialized."
            has_error=true
        fi

        if [ "\$CA_CERT_HASH" = "PENDING_INITIALIZATION" ] || [ "\$CA_CERT_HASH" = "placeholder" ]; then
            echo "ERROR: CA certificate hash not initialized."
            has_error=true
        fi

        if [ "\$JOIN_TOKEN" = "PENDING_INITIALIZATION" ] || [ "\$JOIN_TOKEN" = "placeholder" ]; then
            echo "ERROR: Join token not initialized."
            has_error=true
        fi

        if [ "\$has_error" = "true" ]; then
            echo "ERROR: SSM parameters contain uninitialized values."
            echo "The first control plane node may not have completed initialization."
            return 1
        fi
        return 0
    }

    if ! validate_join_params; then
        echo "Cannot join cluster - SSM parameters not ready. Exiting."
        exit 1
    fi

    # Function to attempt control plane join
    attempt_control_plane_join() {
        local token="\$1"
        local cert_key="\$2"

        if [ -n "\$cert_key" ]; then
            kubeadm join \$CLUSTER_ENDPOINT \
                --token "\$token" \
                --discovery-token-ca-cert-hash \$CA_CERT_HASH \
                --control-plane \
                --certificate-key "\$cert_key" \
                --apiserver-advertise-address=\$PRIVATE_IP
        else
            kubeadm join \$CLUSTER_ENDPOINT \
                --token "\$token" \
                --discovery-token-ca-cert-hash \$CA_CERT_HASH \
                --control-plane \
                --apiserver-advertise-address=\$PRIVATE_IP
        fi
        return \$?
    }

    if [ -n "\$JOIN_TOKEN" ] && [ -n "\$CA_CERT_HASH" ] && [ -n "\$CLUSTER_ENDPOINT" ]; then
        BOOTSTRAP_STAGE="kubeadm-join"

        # First attempt
        if attempt_control_plane_join "\$JOIN_TOKEN" "\$CERT_KEY"; then
            echo "Successfully joined cluster as control plane node"

            # Configure kubectl for root user
            mkdir -p /root/.kube
            cp -i /etc/kubernetes/admin.conf /root/.kube/config
            chown root:root /root/.kube/config

            # WHY register AFTER kubeadm join: etcd member ID only exists after successful join.
            # Also, we only want to register if join succeeded; setting ETCD_REGISTERED=true
            # before DynamoDB write confirms would cause cleanup to attempt deregister on
            # a member that was never registered (race condition fixed in phase 04-01).
            BOOTSTRAP_STAGE="etcd-registration"
            if register_etcd_member; then
                ETCD_REGISTERED=true
            else
                echo "WARNING: Failed to register etcd member, lifecycle cleanup may not work"
            fi

            # Register this instance with load balancer target group (with retries)
            BOOTSTRAP_STAGE="lb-registration"
            TARGET_GROUP_ARN=$(retry_command_output aws elbv2 describe-target-groups --names '${clusterName}-control-plane-tg' --query 'TargetGroups[0].TargetGroupArn' --output text --region $REGION)
            if [ -n "\$TARGET_GROUP_ARN" ]; then
                if retry_command aws elbv2 register-targets --target-group-arn \$TARGET_GROUP_ARN --targets Id=\$INSTANCE_ID,Port=6443 --region $REGION; then
                    LB_REGISTERED=true
                fi
            else
                echo "WARNING: Could not find target group ARN"
            fi

            BOOTSTRAP_STAGE="complete"
        else
            echo "First join attempt failed, requesting fresh token..."

            # Try to get a fresh token
            BOOTSTRAP_STAGE="token-refresh"
            if request_new_control_plane_token; then
                # Get the new token
                NEW_JOIN_TOKEN=$(retry_command_output aws ssm get-parameter --name '/${clusterName}/cluster/join-token' --with-decryption --query 'Parameter.Value' --output text --region $REGION)
                NEW_CERT_KEY=$(retry_command_output aws ssm get-parameter --name '/${clusterName}/cluster/certificate-key' --with-decryption --query 'Parameter.Value' --output text --region $REGION || echo "")

                if [ -n "\$NEW_JOIN_TOKEN" ]; then
                    echo "Got fresh token, retrying join..."
                    # Reset kubeadm state before retry
                    kubeadm reset -f 2>/dev/null || true

                    BOOTSTRAP_STAGE="kubeadm-join-retry"
                    if attempt_control_plane_join "\$NEW_JOIN_TOKEN" "\$NEW_CERT_KEY"; then
                        echo "Successfully joined cluster with fresh token"

                        mkdir -p /root/.kube
                        cp -i /etc/kubernetes/admin.conf /root/.kube/config
                        chown root:root /root/.kube/config

                        BOOTSTRAP_STAGE="etcd-registration"
                        if register_etcd_member; then
                            ETCD_REGISTERED=true
                        else
                            echo "WARNING: Failed to register etcd member"
                        fi

                        BOOTSTRAP_STAGE="lb-registration"
                        TARGET_GROUP_ARN=$(retry_command_output aws elbv2 describe-target-groups --names '${clusterName}-control-plane-tg' --query 'TargetGroups[0].TargetGroupArn' --output text --region $REGION)
                        if [ -n "\$TARGET_GROUP_ARN" ]; then
                            if retry_command aws elbv2 register-targets --target-group-arn \$TARGET_GROUP_ARN --targets Id=\$INSTANCE_ID,Port=6443 --region $REGION; then
                                LB_REGISTERED=true
                            fi
                        fi

                        BOOTSTRAP_STAGE="complete"
                    else
                        echo "Join failed even with fresh token"
                        exit 1
                    fi
                else
                    echo "Could not get a new token"
                    exit 1
                fi
            else
                echo "Token refresh failed"
                exit 1
            fi
        fi
    else
        echo "Missing join information in SSM parameters"
        exit 1
    fi
fi

# Setup automatic certificate rotation for control plane
echo "Setting up automatic certificate rotation..."

# Create certificate renewal script
cat > /usr/local/bin/k8s-cert-renewal.sh << 'CERTSCRIPT'
#!/bin/bash
# Kubernetes certificate renewal script
# Checks certificate expiration and renews if needed

set -e

LOG_PREFIX="[k8s-cert-renewal]"
RENEWAL_THRESHOLD_DAYS=30

log() {
    echo "$LOG_PREFIX $(date '+%Y-%m-%d %H:%M:%S') $1"
}

# Check if kubeadm is available
if ! command -v kubeadm &> /dev/null; then
    log "kubeadm not found, skipping certificate renewal"
    exit 0
fi

# Check if this is a control plane node
if [ ! -f /etc/kubernetes/admin.conf ]; then
    log "Not a control plane node, skipping"
    exit 0
fi

# Get certificate expiration dates
log "Checking certificate expiration dates..."
CERTS_OUTPUT=$(kubeadm certs check-expiration 2>/dev/null || true)

if [ -z "$CERTS_OUTPUT" ]; then
    log "Could not check certificate expiration"
    exit 0
fi

# Check if any certificate expires within threshold
NEEDS_RENEWAL=false
CURRENT_DATE=$(date +%s)
THRESHOLD_SECONDS=$((RENEWAL_THRESHOLD_DAYS * 86400))

# Parse the expiration output and check each certificate
while IFS= read -r line; do
    # Skip header lines
    if echo "$line" | grep -qE "^CERTIFICATE|^----|^$|^CERTIFICATE AUTHORITY"; then
        continue
    fi

    # Extract expiration date (format: Mon DD, YYYY HH:MM UTC)
    EXPIRY=$(echo "$line" | awk '{print $2, $3, $4, $5, $6}' | sed 's/,//')
    if [ -n "$EXPIRY" ]; then
        EXPIRY_SECONDS=$(date -d "$EXPIRY" +%s 2>/dev/null || echo "0")
        if [ "$EXPIRY_SECONDS" != "0" ]; then
            TIME_LEFT=$((EXPIRY_SECONDS - CURRENT_DATE))
            if [ $TIME_LEFT -lt $THRESHOLD_SECONDS ]; then
                CERT_NAME=$(echo "$line" | awk '{print $1}')
                log "Certificate $CERT_NAME expires in $((TIME_LEFT / 86400)) days - renewal needed"
                NEEDS_RENEWAL=true
            fi
        fi
    fi
done <<< "$CERTS_OUTPUT"

if [ "$NEEDS_RENEWAL" = "true" ]; then
    log "Renewing all certificates..."

    # Renew all certificates
    if kubeadm certs renew all; then
        log "Certificates renewed successfully"

        # Restart control plane components
        log "Restarting control plane components..."

        # Move static pod manifests to trigger restart
        if [ -d /etc/kubernetes/manifests ]; then
            TEMP_DIR=$(mktemp -d)
            mv /etc/kubernetes/manifests/*.yaml "$TEMP_DIR/" 2>/dev/null || true
            sleep 10
            mv "$TEMP_DIR"/*.yaml /etc/kubernetes/manifests/ 2>/dev/null || true
            rmdir "$TEMP_DIR" 2>/dev/null || true
            log "Control plane components restarted"
        fi

        # Wait for API server to be ready
        log "Waiting for API server to be ready..."
        for i in {1..30}; do
            if kubectl --kubeconfig=/etc/kubernetes/admin.conf get nodes &>/dev/null; then
                log "API server is ready"
                break
            fi
            sleep 5
        done

        log "Certificate renewal completed successfully"
    else
        log "ERROR: Certificate renewal failed"
        exit 1
    fi
else
    log "All certificates are valid for more than $RENEWAL_THRESHOLD_DAYS days"
fi
CERTSCRIPT

chmod +x /usr/local/bin/k8s-cert-renewal.sh

# Create systemd service for certificate renewal
cat > /etc/systemd/system/k8s-cert-renewal.service << 'CERTSVC'
[Unit]
Description=Kubernetes Certificate Renewal
After=kubelet.service

[Service]
Type=oneshot
ExecStart=/usr/local/bin/k8s-cert-renewal.sh
StandardOutput=journal
StandardError=journal
CERTSVC

# Create systemd timer to run daily
cat > /etc/systemd/system/k8s-cert-renewal.timer << 'CERTTIMER'
[Unit]
Description=Daily Kubernetes Certificate Renewal Check

[Timer]
OnCalendar=daily
RandomizedDelaySec=3600
Persistent=true

[Install]
WantedBy=timers.target
CERTTIMER

# Enable and start the timer
systemctl daemon-reload
systemctl enable k8s-cert-renewal.timer
systemctl start k8s-cert-renewal.timer

echo "Certificate renewal timer configured"

# Disable cleanup trap on successful completion
trap - EXIT
BOOTSTRAP_STAGE="complete"

echo "Control plane bootstrap completed successfully!"
`;
}
