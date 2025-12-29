#!/bin/bash
set -euo pipefail

K8S_VERSION="1.29.0"
CILIUM_VERSION="1.14.5"
CONTAINERD_VERSION="1.7.11"
RUNC_VERSION="1.1.10"
CNI_VERSION="1.4.0"

# Create Packer template
cat > k8s-ami.pkr.hcl << 'EOF'
packer {
  required_plugins {
    amazon = {
      version = ">= 1.2.8"
      source  = "github.com/hashicorp/amazon"
    }
  }
}

source "amazon-ebs" "k8s" {
  ami_name      = "k8s-control-plane-{{timestamp}}"
  instance_type = "m5.large"
  region        = "us-gov-west-1"
  source_ami_filter {
    filters = {
      name                = "al2023-ami-*-x86_64"
      root-device-type    = "ebs"
      virtualization-type = "hvm"
    }
    most_recent = true
    owners      = ["045324592363"]
  }
  ssh_username = "ec2-user"
}

build {
  sources = ["source.amazon-ebs.k8s"]
  provisioner "shell" {
    script = "install-k8s.sh"
  }
}
EOF

# Create installation script
cat > install-k8s.sh << EOF
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

# Install Kubernetes
cat <<EOL | sudo tee /etc/yum.repos.d/kubernetes.repo
[kubernetes]
name=Kubernetes
baseurl=https://pkgs.k8s.io/core:/stable:/v1.29/rpm/
enabled=1
gpgcheck=1
gpgkey=https://pkgs.k8s.io/core:/stable:/v1.29/rpm/repodata/repomd.xml.key
EOL

sudo dnf install -y kubelet-${K8S_VERSION} kubeadm-${K8S_VERSION} kubectl-${K8S_VERSION} --disableexcludes=kubernetes

# Install Cilium CLI
CILIUM_CLI_VERSION=\$(curl -s https://raw.githubusercontent.com/cilium/cilium-cli/main/stable.txt)
curl -L --fail --remote-name-all https://github.com/cilium/cilium-cli/releases/download/\${CILIUM_CLI_VERSION}/cilium-linux-amd64.tar.gz{,.sha256sum}
sha256sum --check cilium-linux-amd64.tar.gz.sha256sum
sudo tar xzvfC cilium-linux-amd64.tar.gz /usr/local/bin
rm cilium-linux-amd64.tar.gz{,.sha256sum}

# Pre-pull Cilium images
sudo ctr image pull quay.io/cilium/cilium:v${CILIUM_VERSION}
sudo ctr image pull quay.io/cilium/operator-generic:v${CILIUM_VERSION}

# Pre-pull cluster autoscaler image
sudo ctr image pull registry.k8s.io/autoscaling/cluster-autoscaler:v${K8S_VERSION}

# Pre-pull Kubernetes images
sudo kubeadm config images pull --kubernetes-version=${K8S_VERSION}

# Enable services
sudo systemctl enable containerd
sudo systemctl enable kubelet
EOF

chmod +x install-k8s.sh

# Build AMI and capture ID
echo "Building Kubernetes control plane AMI..."
AMI_ID=$(packer build -machine-readable k8s-ami.pkr.hcl | grep 'artifact,0,id' | cut -d, -f6 | cut -d: -f2)

# Cleanup
rm -f k8s-ami.pkr.hcl install-k8s.sh

# Output AMI ID
echo "$AMI_ID"
