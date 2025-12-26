#!/bin/bash
set -euo pipefail

K8S_VERSION="1.29.0"
CONTAINERD_VERSION="1.7.11"
RUNC_VERSION="1.1.10"
CNI_VERSION="1.4.0"

# Create Packer template
cat > k8s-worker-ami.pkr.hcl << 'EOF'
packer {
  required_plugins {
    amazon = {
      version = ">= 1.2.8"
      source  = "github.com/hashicorp/amazon"
    }
  }
}

source "amazon-ebs" "k8s-worker" {
  ami_name      = "k8s-worker-node-{{timestamp}}"
  instance_type = "t3.medium"
  region        = "us-west-2"
  source_ami_filter {
    filters = {
      name                = "al2023-ami-*-x86_64"
      root-device-type    = "ebs"
      virtualization-type = "hvm"
    }
    most_recent = true
    owners      = ["137112412989"]
  }
  ssh_username = "ec2-user"
}

build {
  sources = ["source.amazon-ebs.k8s-worker"]
  provisioner "shell" {
    script = "install-k8s-worker.sh"
  }
}
EOF

# Create worker installation script
cat > install-k8s-worker.sh << EOF
#!/bin/bash
set -euo pipefail

# Update system
sudo dnf update -y
sudo dnf install -y curl wget tar socat conntrack-tools

# Disable swap
sudo swapoff -a || true

# Configure kernel modules
cat <<EOL | sudo tee /etc/modules-load.d/k8s.conf
overlay
br_netfilter
EOL

sudo modprobe overlay
sudo modprobe br_netfilter

# Configure sysctl
cat <<EOL | sudo tee /etc/sysctl.d/k8s.conf
net.bridge.bridge-nf-call-iptables  = 1
net.bridge.bridge-nf-call-ip6tables = 1
net.ipv4.ip_forward                 = 1
EOL

sudo sysctl --system

# Install containerd
curl -fsSL https://github.com/containerd/containerd/releases/download/v${CONTAINERD_VERSION}/containerd-${CONTAINERD_VERSION}-linux-amd64.tar.gz | sudo tar -xz -C /usr/local

# Install runc
curl -fsSL https://github.com/opencontainers/runc/releases/download/v${RUNC_VERSION}/runc.amd64 -o runc.amd64
sudo install -m 755 runc.amd64 /usr/local/sbin/runc
rm runc.amd64

# Install CNI plugins
sudo mkdir -p /opt/cni/bin
curl -fsSL https://github.com/containernetworking/plugins/releases/download/v${CNI_VERSION}/cni-plugins-linux-amd64-v${CNI_VERSION}.tgz | sudo tar -xz -C /opt/cni/bin

# Configure containerd
sudo mkdir -p /etc/containerd
containerd config default | sudo tee /etc/containerd/config.toml
sudo sed -i 's/SystemdCgroup = false/SystemdCgroup = true/' /etc/containerd/config.toml

# Create containerd service
cat <<EOL | sudo tee /etc/systemd/system/containerd.service
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
EOL

# Install Kubernetes (worker components only)
cat <<EOL | sudo tee /etc/yum.repos.d/kubernetes.repo
[kubernetes]
name=Kubernetes
baseurl=https://pkgs.k8s.io/core:/stable:/v1.29/rpm/
enabled=1
gpgcheck=1
gpgkey=https://pkgs.k8s.io/core:/stable:/v1.29/rpm/repodata/repomd.xml.key
EOL

sudo dnf install -y kubelet-${K8S_VERSION} kubectl-${K8S_VERSION} --disableexcludes=kubernetes

# Enable services
sudo systemctl enable containerd
sudo systemctl enable kubelet
EOF

chmod +x install-k8s-worker.sh

# Build AMI and capture ID
echo "Building Kubernetes worker node AMI..."
AMI_ID=$(packer build -machine-readable k8s-worker-ami.pkr.hcl | grep 'artifact,0,id' | cut -d, -f6 | cut -d: -f2)

# Cleanup
rm -f k8s-worker-ami.pkr.hcl install-k8s-worker.sh

# Output AMI ID
echo "$AMI_ID"
