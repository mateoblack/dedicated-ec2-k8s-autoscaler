# Self-Managed Kubernetes on Dedicated Instances (CDK)

> **Experimental**

> A dedicated-instance, self-healing Kubernetes 
controlplane on EC2

## What This Is 

This project creates a fully self-managed Kubernetes
cluster on AWS using EC2 dedicated instances, deployed and reconciled with AWS CDK 

This is Kubernetes you own, automated to deploy in 
AWS.

---

## Core Characteristics 

**Self-healing control plane**
* Control plane and workers can run on isolated EC2 capacity (no shared tenancy)

**High-avaliability etcd (by default)**
* Control plane nodes are managed by AutoScaling Groups and safely replaced without breaking etcd quorum.

**Self-healing control plane**
* Three control plane nodes with automated memeber tracking and cleanup using lambda 

**Immutable by design**
* Nodes are never fixed in place - They are replacable 

**CDK-native**

---

## What Problems This Solves 

Running fully distributed Kubernetes control plane yourself can be complex. EKS solves this problem but, for highly restrictive environments full control over the cluster will be required so, in this use using EKS is not possible.

The hardest part being **etcd lifecycle management** in the K8 control plane nodes

---

## How it workes (High Level)

### Cluster Creation

* CDK creates networking, AutoScaling Groups, and supporting AWS resources 

* Three control plane instances start at once

* one instance bootstraps the cluster 

* Others join automatically 

* Workers join as stateless nodes 

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

**infrastructure** is reconciled - not recreated

---

## What This Is Not 

* not a managed kubernetes service. Just self healing. You'll need a system admin for kubernetes.

* Not recommend as the replacement of as this project is experemential 
---

## Status 

Active build and not ready for use

---

Licence

Apache 2.0