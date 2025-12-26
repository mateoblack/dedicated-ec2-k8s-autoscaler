import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

describe('build-k8s-worker-ami.sh script', () => {
  const scriptPath = path.join(__dirname, '../scripts/build-k8s-worker-ami.sh');

  beforeAll(() => {
    // Ensure script exists and is executable
    expect(fs.existsSync(scriptPath)).toBe(true);
    expect(fs.statSync(scriptPath).mode & parseInt('111', 8)).toBeTruthy();
  });

  test('script contains required Kubernetes version', () => {
    const scriptContent = fs.readFileSync(scriptPath, 'utf8');
    expect(scriptContent).toMatch(/K8S_VERSION="1\.29\.0"/);
  });

  test('script contains containerd installation', () => {
    const scriptContent = fs.readFileSync(scriptPath, 'utf8');
    expect(scriptContent).toContain('containerd-${CONTAINERD_VERSION}');
    expect(scriptContent).toContain('/usr/local/bin/containerd');
  });

  test('script contains worker Kubernetes components only', () => {
    const scriptContent = fs.readFileSync(scriptPath, 'utf8');
    expect(scriptContent).toContain('kubelet-${K8S_VERSION}');
    expect(scriptContent).toContain('kubectl-${K8S_VERSION}');
    // Should NOT contain kubeadm (control plane only)
    expect(scriptContent).not.toContain('kubeadm-${K8S_VERSION}');
  });

  test('script does not contain Cilium installation', () => {
    const scriptContent = fs.readFileSync(scriptPath, 'utf8');
    // Workers don't need Cilium CLI - it's deployed as DaemonSet
    expect(scriptContent).not.toContain('cilium-linux-amd64.tar.gz');
  });

  test('script does not pre-pull control plane images', () => {
    const scriptContent = fs.readFileSync(scriptPath, 'utf8');
    // Workers don't need control plane images
    expect(scriptContent).not.toContain('kubeadm config images pull');
    expect(scriptContent).not.toContain('cluster-autoscaler');
    expect(scriptContent).not.toContain('quay.io/cilium');
  });

  test('script uses Amazon Linux 2023', () => {
    const scriptContent = fs.readFileSync(scriptPath, 'utf8');
    expect(scriptContent).toContain('al2023-ami-*-x86_64');
    expect(scriptContent).toContain('ssh_username = "ec2-user"');
  });

  test('script configures systemd services', () => {
    const scriptContent = fs.readFileSync(scriptPath, 'utf8');
    expect(scriptContent).toContain('systemctl enable containerd');
    expect(scriptContent).toContain('systemctl enable kubelet');
  });

  test('script configures kernel modules', () => {
    const scriptContent = fs.readFileSync(scriptPath, 'utf8');
    expect(scriptContent).toContain('overlay');
    expect(scriptContent).toContain('br_netfilter');
    expect(scriptContent).toContain('/etc/modules-load.d/k8s.conf');
  });

  test('script configures sysctl settings', () => {
    const scriptContent = fs.readFileSync(scriptPath, 'utf8');
    expect(scriptContent).toContain('net.bridge.bridge-nf-call-iptables  = 1');
    expect(scriptContent).toContain('net.ipv4.ip_forward                 = 1');
    expect(scriptContent).toContain('/etc/sysctl.d/k8s.conf');
  });

  test('script outputs AMI ID', () => {
    const scriptContent = fs.readFileSync(scriptPath, 'utf8');
    expect(scriptContent).toContain('packer build -machine-readable');
    expect(scriptContent).toContain('artifact,0,id');
    expect(scriptContent).toContain('echo "$AMI_ID"');
  });

  test('script has correct AMI naming', () => {
    const scriptContent = fs.readFileSync(scriptPath, 'utf8');
    expect(scriptContent).toContain('k8s-worker-node-{{timestamp}}');
  });

  test('script validates syntax', () => {
    expect(() => {
      execSync(`bash -n ${scriptPath}`, { encoding: 'utf8' });
    }).not.toThrow();
  });

  test('script has proper error handling', () => {
    const scriptContent = fs.readFileSync(scriptPath, 'utf8');
    expect(scriptContent).toContain('set -euo pipefail');
  });
});
