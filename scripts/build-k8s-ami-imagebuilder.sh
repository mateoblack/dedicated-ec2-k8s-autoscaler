#!/bin/bash
set -euo pipefail

# =============================================================================
# Kubernetes AMI Builder Script
#
# This script creates Kubernetes AMIs using AWS Image Builder.
#
# Usage:
#   ./build-k8s-ami-imagebuilder.sh --region <aws-region>
#
# Example:
#   ./build-k8s-ami-imagebuilder.sh --region us-west-2
#   ./build-k8s-ami-imagebuilder.sh --region us-gov-west-1
# =============================================================================

# Parse command line arguments
REGION=""

while [[ $# -gt 0 ]]; do
    case $1 in
        --region)
            REGION="$2"
            shift 2
            ;;
        -h|--help)
            echo "Usage: $0 --region <aws-region>"
            echo ""
            echo "Required arguments:"
            echo "  --region    AWS region to build AMIs in (e.g., us-west-2, us-gov-west-1)"
            echo ""
            echo "Examples:"
            echo "  $0 --region us-west-2"
            echo "  $0 --region us-gov-west-1"
            exit 0
            ;;
        *)
            echo "ERROR: Unknown option: $1"
            echo "Use --help for usage information"
            exit 1
            ;;
    esac
done

# Validate required parameters
if [[ -z "$REGION" ]]; then
    echo "ERROR: --region is required"
    echo ""
    echo "Usage: $0 --region <aws-region>"
    echo ""
    echo "Examples:"
    echo "  $0 --region us-west-2"
    echo "  $0 --region us-gov-west-1"
    exit 1
fi

# Determine AWS partition based on region
# GovCloud regions use aws-us-gov partition
if [[ "$REGION" == us-gov-* ]]; then
    AWS_PARTITION="aws-us-gov"
    CONSOLE_DOMAIN="console.amazonaws-us-gov.com"
else
    AWS_PARTITION="aws"
    CONSOLE_DOMAIN="console.aws.amazon.com"
fi

echo "=============================================="
echo "Kubernetes AMI Builder"
echo "=============================================="
echo "Region:    $REGION"
echo "Partition: $AWS_PARTITION"
echo "=============================================="
echo ""

# Function to check if instance profile is ready
check_instance_profile() {
    aws iam get-instance-profile --instance-profile-name EC2InstanceProfileForImageBuilder --region "$REGION" >/dev/null 2>&1
}

# Check and create IAM role if it doesn't exist
if ! check_instance_profile; then
    echo "Creating EC2InstanceProfileForImageBuilder..."

    # Create IAM role
    aws iam create-role \
        --role-name EC2InstanceProfileForImageBuilder \
        --assume-role-policy-document '{
            "Version": "2012-10-17",
            "Statement": [
                {
                    "Effect": "Allow",
                    "Principal": {
                        "Service": "ec2.amazonaws.com"
                    },
                    "Action": "sts:AssumeRole"
                }
            ]
        }' \
        --region "$REGION"

    # Attach required policies
    aws iam attach-role-policy \
        --role-name EC2InstanceProfileForImageBuilder \
        --policy-arn "arn:${AWS_PARTITION}:iam::aws:policy/EC2InstanceProfileForImageBuilder" \
        --region "$REGION"

    aws iam attach-role-policy \
        --role-name EC2InstanceProfileForImageBuilder \
        --policy-arn "arn:${AWS_PARTITION}:iam::aws:policy/AmazonSSMManagedInstanceCore" \
        --region "$REGION"

    # Create instance profile
    aws iam create-instance-profile \
        --instance-profile-name EC2InstanceProfileForImageBuilder \
        --region "$REGION"

    # Add role to instance profile
    aws iam add-role-to-instance-profile \
        --instance-profile-name EC2InstanceProfileForImageBuilder \
        --role-name EC2InstanceProfileForImageBuilder \
        --region "$REGION"

    # Wait for IAM role to propagate (retry for 15 minutes)
    echo "Waiting for IAM role to propagate..."
    for attempt in {1..15}; do
        if check_instance_profile; then
            echo "IAM role is ready after $attempt minute(s)"
            break
        fi
        if [ $attempt -eq 15 ]; then
            echo "ERROR: IAM role failed to propagate after 15 minutes"
            exit 1
        fi
        echo "Attempt $attempt/15: IAM role not ready yet, waiting 1 minute..."
        sleep 60
    done
else
    echo "EC2InstanceProfileForImageBuilder already exists"
fi

# Get account ID once
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text --region "$REGION")

# Create Image Builder component for Kubernetes control plane
if ! aws imagebuilder get-component --component-build-version-arn "arn:${AWS_PARTITION}:imagebuilder:${REGION}:${ACCOUNT_ID}:component/kubernetes-control-plane-1-29/1.29.0/1" --region "$REGION" >/dev/null 2>&1; then
    echo "Creating control plane component..."
    aws imagebuilder create-component \
      --name "kubernetes-control-plane-1-29" \
      --semantic-version "1.29.0" \
      --platform "Linux" \
      --data 'name: Install Kubernetes Control Plane
description: Install Kubernetes 1.29.0 with containerd and pre-pull images
schemaVersion: 1.0
phases:
  - name: build
    steps:
      - name: UpdateSystem
        action: ExecuteBash
        inputs:
          commands:
            - dnf update -y
            - dnf install -y curl wget tar socat conntrack-tools --allowerasing
      - name: ConfigureKernel
        action: ExecuteBash
        inputs:
          commands:
            - swapoff -a || true
            - |
              cat <<EOF > /etc/modules-load.d/k8s.conf
              overlay
              br_netfilter
              EOF
            - modprobe overlay
            - modprobe br_netfilter
            - |
              cat <<EOF > /etc/sysctl.d/k8s.conf
              net.bridge.bridge-nf-call-iptables  = 1
              net.bridge.bridge-nf-call-ip6tables = 1
              net.ipv4.ip_forward                 = 1
              EOF
            - sysctl --system
      - name: InstallContainerd
        action: ExecuteBash
        inputs:
          commands:
            - curl -fsSL https://github.com/containerd/containerd/releases/download/v1.7.11/containerd-1.7.11-linux-amd64.tar.gz | tar -xz -C /usr/local
            - curl -fsSL https://github.com/opencontainers/runc/releases/download/v1.1.10/runc.amd64 -o runc.amd64
            - install -m 755 runc.amd64 /usr/local/sbin/runc
            - rm runc.amd64
            - mkdir -p /opt/cni/bin
            - curl -fsSL https://github.com/containernetworking/plugins/releases/download/v1.4.0/cni-plugins-linux-amd64-v1.4.0.tgz | tar -xz -C /opt/cni/bin
      - name: ConfigureContainerd
        action: ExecuteBash
        inputs:
          commands:
            - mkdir -p /etc/containerd
            - containerd config default > /etc/containerd/config.toml
            - sed -i "s/SystemdCgroup = false/SystemdCgroup = true/" /etc/containerd/config.toml
            - |
              cat <<EOF > /etc/systemd/system/containerd.service
              [Unit]
              Description=containerd container runtime
              Documentation=https://containerd.io
              After=network.target local-fs.target

              [Service]
              ExecStartPre=-/sbin/modprobe overlay
              ExecStart=/usr/local/bin/containerd
              Type=notify
              Delegate=yes
              KillMode=process
              Restart=always
              RestartSec=5
              LimitNPROC=infinity
              LimitCORE=infinity
              LimitNOFILE=infinity
              TasksMax=infinity
              OOMScoreAdjust=-999

              [Install]
              WantedBy=multi-user.target
              EOF
      - name: InstallKubernetes
        action: ExecuteBash
        inputs:
          commands:
            - |
              cat <<EOF > /etc/yum.repos.d/kubernetes.repo
              [kubernetes]
              name=Kubernetes
              baseurl=https://pkgs.k8s.io/core:/stable:/v1.29/rpm/
              enabled=1
              gpgcheck=1
              gpgkey=https://pkgs.k8s.io/core:/stable:/v1.29/rpm/repodata/repomd.xml.key
              EOF
            - dnf install -y kubelet-1.29.0 kubeadm-1.29.0 kubectl-1.29.0 --disableexcludes=kubernetes --allowerasing
      - name: EnableServices
        action: ExecuteBash
        inputs:
          commands:
            - systemctl enable containerd
            - systemctl enable kubelet
            - systemctl start containerd
            - sleep 5
      - name: PrePullImages
        action: ExecuteBash
        inputs:
          commands:
            - ctr image pull quay.io/cilium/cilium:v1.14.5 || true
            - ctr image pull quay.io/cilium/operator-generic:v1.14.5 || true
            - ctr image pull registry.k8s.io/autoscaling/cluster-autoscaler:v1.29.0 || true
            - kubeadm config images pull --kubernetes-version=1.29.0 || true' \
      --region "$REGION"
else
    echo "Control plane component already exists"
fi

# Create worker component
if ! aws imagebuilder get-component --component-build-version-arn "arn:${AWS_PARTITION}:imagebuilder:${REGION}:${ACCOUNT_ID}:component/kubernetes-worker-1-29/1.29.0/1" --region "$REGION" >/dev/null 2>&1; then
    echo "Creating worker component..."
    aws imagebuilder create-component \
      --name "kubernetes-worker-1-29" \
      --semantic-version "1.29.0" \
      --platform "Linux" \
      --data 'name: Install Kubernetes Worker
description: Install Kubernetes 1.29.0 worker components with containerd
schemaVersion: 1.0
phases:
  - name: build
    steps:
      - name: UpdateSystem
        action: ExecuteBash
        inputs:
          commands:
            - dnf update -y
            - dnf install -y curl wget tar socat conntrack-tools --allowerasing
      - name: ConfigureKernel
        action: ExecuteBash
        inputs:
          commands:
            - swapoff -a || true
            - |
              cat <<EOF > /etc/modules-load.d/k8s.conf
              overlay
              br_netfilter
              EOF
            - modprobe overlay
            - modprobe br_netfilter
            - |
              cat <<EOF > /etc/sysctl.d/k8s.conf
              net.bridge.bridge-nf-call-iptables  = 1
              net.bridge.bridge-nf-call-ip6tables = 1
              net.ipv4.ip_forward                 = 1
              EOF
            - sysctl --system
      - name: InstallContainerd
        action: ExecuteBash
        inputs:
          commands:
            - curl -fsSL https://github.com/containerd/containerd/releases/download/v1.7.11/containerd-1.7.11-linux-amd64.tar.gz | tar -xz -C /usr/local
            - curl -fsSL https://github.com/opencontainers/runc/releases/download/v1.1.10/runc.amd64 -o runc.amd64
            - install -m 755 runc.amd64 /usr/local/sbin/runc
            - rm runc.amd64
            - mkdir -p /opt/cni/bin
            - curl -fsSL https://github.com/containernetworking/plugins/releases/download/v1.4.0/cni-plugins-linux-amd64-v1.4.0.tgz | tar -xz -C /opt/cni/bin
      - name: ConfigureContainerd
        action: ExecuteBash
        inputs:
          commands:
            - mkdir -p /etc/containerd
            - containerd config default > /etc/containerd/config.toml
            - sed -i "s/SystemdCgroup = false/SystemdCgroup = true/" /etc/containerd/config.toml
            - |
              cat <<EOF > /etc/systemd/system/containerd.service
              [Unit]
              Description=containerd container runtime
              Documentation=https://containerd.io
              After=network.target local-fs.target

              [Service]
              ExecStartPre=-/sbin/modprobe overlay
              ExecStart=/usr/local/bin/containerd
              Type=notify
              Delegate=yes
              KillMode=process
              Restart=always
              RestartSec=5
              LimitNPROC=infinity
              LimitCORE=infinity
              LimitNOFILE=infinity
              TasksMax=infinity
              OOMScoreAdjust=-999

              [Install]
              WantedBy=multi-user.target
              EOF
      - name: InstallKubernetes
        action: ExecuteBash
        inputs:
          commands:
            - |
              cat <<EOF > /etc/yum.repos.d/kubernetes.repo
              [kubernetes]
              name=Kubernetes
              baseurl=https://pkgs.k8s.io/core:/stable:/v1.29/rpm/
              enabled=1
              gpgcheck=1
              gpgkey=https://pkgs.k8s.io/core:/stable:/v1.29/rpm/repodata/repomd.xml.key
              EOF
            - dnf install -y kubelet-1.29.0 kubectl-1.29.0 --disableexcludes=kubernetes --allowerasing
      - name: EnableServices
        action: ExecuteBash
        inputs:
          commands:
            - systemctl enable containerd
            - systemctl enable kubelet' \
      --region "$REGION"
else
    echo "Worker component already exists"
fi

# Create Image Builder recipes
if ! aws imagebuilder get-image-recipe --image-recipe-arn "arn:${AWS_PARTITION}:imagebuilder:${REGION}:${ACCOUNT_ID}:image-recipe/kubernetes-control-plane-recipe/1.29.0" --region "$REGION" >/dev/null 2>&1; then
    echo "Creating control plane recipe..."
    aws imagebuilder create-image-recipe \
      --name "kubernetes-control-plane-recipe" \
      --semantic-version "1.29.0" \
      --parent-image "arn:${AWS_PARTITION}:imagebuilder:${REGION}:aws:image/amazon-linux-2023-x86/x.x.x" \
      --components "[{\"componentArn\":\"arn:${AWS_PARTITION}:imagebuilder:${REGION}:${ACCOUNT_ID}:component/kubernetes-control-plane-1-29/1.29.0\"}]" \
      --region "$REGION"
else
    echo "Control plane recipe already exists"
fi

if ! aws imagebuilder get-image-recipe --image-recipe-arn "arn:${AWS_PARTITION}:imagebuilder:${REGION}:${ACCOUNT_ID}:image-recipe/kubernetes-worker-recipe/1.29.0" --region "$REGION" >/dev/null 2>&1; then
    echo "Creating worker recipe..."
    aws imagebuilder create-image-recipe \
      --name "kubernetes-worker-recipe" \
      --semantic-version "1.29.0" \
      --parent-image "arn:${AWS_PARTITION}:imagebuilder:${REGION}:aws:image/amazon-linux-2023-x86/x.x.x" \
      --components "[{\"componentArn\":\"arn:${AWS_PARTITION}:imagebuilder:${REGION}:${ACCOUNT_ID}:component/kubernetes-worker-1-29/1.29.0\"}]" \
      --region "$REGION"
else
    echo "Worker recipe already exists"
fi

# Create infrastructure configuration
if ! aws imagebuilder get-infrastructure-configuration --infrastructure-configuration-arn "arn:${AWS_PARTITION}:imagebuilder:${REGION}:${ACCOUNT_ID}:infrastructure-configuration/k8s-infra-config" --region "$REGION" >/dev/null 2>&1; then
    echo "Creating infrastructure configuration..."
    aws imagebuilder create-infrastructure-configuration \
      --name "k8s-infra-config" \
      --instance-types "m5.large" \
      --instance-profile-name "EC2InstanceProfileForImageBuilder" \
      --region "$REGION"
else
    echo "Infrastructure configuration already exists"
fi

# Create and run image pipelines
if ! aws imagebuilder get-image-pipeline --image-pipeline-arn "arn:${AWS_PARTITION}:imagebuilder:${REGION}:${ACCOUNT_ID}:image-pipeline/kubernetes-control-plane-pipeline" --region "$REGION" >/dev/null 2>&1; then
    echo "Creating control plane pipeline..."
    aws imagebuilder create-image-pipeline \
      --name "kubernetes-control-plane-pipeline" \
      --image-recipe-arn "arn:${AWS_PARTITION}:imagebuilder:${REGION}:${ACCOUNT_ID}:image-recipe/kubernetes-control-plane-recipe/1.29.0" \
      --infrastructure-configuration-arn "arn:${AWS_PARTITION}:imagebuilder:${REGION}:${ACCOUNT_ID}:infrastructure-configuration/k8s-infra-config" \
      --region "$REGION"
else
    echo "Control plane pipeline already exists"
fi

if ! aws imagebuilder get-image-pipeline --image-pipeline-arn "arn:${AWS_PARTITION}:imagebuilder:${REGION}:${ACCOUNT_ID}:image-pipeline/kubernetes-worker-pipeline" --region "$REGION" >/dev/null 2>&1; then
    echo "Creating worker pipeline..."
    aws imagebuilder create-image-pipeline \
      --name "kubernetes-worker-pipeline" \
      --image-recipe-arn "arn:${AWS_PARTITION}:imagebuilder:${REGION}:${ACCOUNT_ID}:image-recipe/kubernetes-worker-recipe/1.29.0" \
      --infrastructure-configuration-arn "arn:${AWS_PARTITION}:imagebuilder:${REGION}:${ACCOUNT_ID}:infrastructure-configuration/k8s-infra-config" \
      --region "$REGION"
else
    echo "Worker pipeline already exists"
fi

# Start both builds
echo "Starting control plane AMI build..."
aws imagebuilder start-image-pipeline-execution \
  --image-pipeline-arn "arn:${AWS_PARTITION}:imagebuilder:${REGION}:${ACCOUNT_ID}:image-pipeline/kubernetes-control-plane-pipeline" \
  --region "$REGION"

echo "Starting worker AMI build..."
aws imagebuilder start-image-pipeline-execution \
  --image-pipeline-arn "arn:${AWS_PARTITION}:imagebuilder:${REGION}:${ACCOUNT_ID}:image-pipeline/kubernetes-worker-pipeline" \
  --region "$REGION"

echo ""
echo "Both AMI builds started! Monitor progress in AWS Console:"
echo "https://${CONSOLE_DOMAIN}/imagebuilder/home?region=${REGION}#/pipelines"

# Function to get latest AMI ID from a pipeline
get_latest_ami_id() {
    local pipeline_name=$1
    aws imagebuilder list-images \
        --filters "name=name,values=${pipeline_name}" \
        --query 'imageList | sort_by(@, &dateCreated) | [-1].outputResources.amis[0].image' \
        --output text \
        --region "$REGION"
}

# Wait for builds to complete and store AMI IDs in SSM
echo ""
echo "Waiting for builds to complete..."
echo "This may take 10-15 minutes. You can monitor progress in the AWS Console."

# Wait for control plane build
echo "Checking control plane build status..."
while true; do
    CONTROL_AMI=$(get_latest_ami_id "kubernetes-control-plane-pipeline")
    if [[ "$CONTROL_AMI" != "None" && "$CONTROL_AMI" != "" ]]; then
        echo "Control plane AMI ready: $CONTROL_AMI"
        break
    fi
    echo "Control plane build still in progress..."
    sleep 60
done

# Wait for worker build
echo "Checking worker build status..."
while true; do
    WORKER_AMI=$(get_latest_ami_id "kubernetes-worker-pipeline")
    if [[ "$WORKER_AMI" != "None" && "$WORKER_AMI" != "" ]]; then
        echo "Worker AMI ready: $WORKER_AMI"
        break
    fi
    echo "Worker build still in progress..."
    sleep 60
done

# Store AMI IDs in SSM Parameter Store
echo ""
echo "Storing AMI IDs in SSM Parameter Store..."

aws ssm put-parameter \
  --name "/k8s-cluster/control-plane-ami-id" \
  --value "$CONTROL_AMI" \
  --type "String" \
  --region "$REGION" \
  --overwrite

aws ssm put-parameter \
  --name "/k8s-cluster/worker-ami-id" \
  --value "$WORKER_AMI" \
  --type "String" \
  --region "$REGION" \
  --overwrite

echo ""
echo "=============================================="
echo "Build complete!"
echo "=============================================="
echo "Region:           $REGION"
echo "Control Plane AMI: $CONTROL_AMI"
echo "Worker AMI:        $WORKER_AMI"
echo ""
echo "AMI IDs stored in SSM:"
echo "  /k8s-cluster/control-plane-ami-id = $CONTROL_AMI"
echo "  /k8s-cluster/worker-ami-id = $WORKER_AMI"
echo "=============================================="
