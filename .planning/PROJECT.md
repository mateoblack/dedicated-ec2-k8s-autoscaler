# Dedicated EC2 K8s Autoscaler - Code Audit

## What This Is

AWS CDK infrastructure for deploying self-managed Kubernetes clusters on dedicated EC2 instances. The codebase provisions VPC, IAM roles, DynamoDB tables, S3 buckets, Auto Scaling Groups, Lambda functions for etcd lifecycle management, and CloudWatch monitoring. This audit focuses on improving reliability and code quality without adding new features.

## Core Value

**Reliable cluster initialization and etcd lifecycle management.** If bootstrap scripts fail or etcd member removal breaks, the cluster becomes unusable. Everything else can be imperfect; this must be rock solid.

## Requirements

### Validated

<!-- Existing capabilities confirmed working -->

- ✓ Multi-stack CDK architecture with separation of concerns (IAM, Network, Compute, Database, Monitoring, Services) — existing
- ✓ Control plane bootstrap with kubeadm initialization and join token management — existing
- ✓ Worker node bootstrap with automatic cluster joining — existing
- ✓ etcd lifecycle Lambda for graceful member removal on termination — existing
- ✓ etcd backup Lambda with 6-hour scheduled snapshots — existing
- ✓ Cluster health monitoring Lambda — existing
- ✓ DynamoDB-based bootstrap locking for leader election — existing
- ✓ OIDC provider and IRSA support for cluster-autoscaler — existing
- ✓ NLB for Kubernetes API load balancing — existing
- ✓ CloudWatch alarms for control plane, workers, and Lambda errors — existing
- ✓ 30 test files with CDK Template assertions — existing

### Active

<!-- Code audit goals -->

- [ ] Extract compute-stack.ts into focused modules (currently 3,623 lines)
- [ ] Consolidate duplicated retry logic into shared functions
- [ ] Fix bootstrap script variable scoping issues (subshell problems)
- [ ] Fix etcd member registration race condition (flag before confirmation)
- [ ] Replace eval usage with safer command execution patterns
- [ ] Add unit tests for Lambda code logic (5 createXxxCode methods)
- [ ] Add shellcheck/linting for bootstrap scripts
- [ ] Add inline documentation to complex bootstrap sections

### Out of Scope

- New features — pure quality improvements, no capability additions
- IAM policy tightening — security audit is a separate effort
- CDK version upgrade — maintain compatibility with aws-cdk-lib 2.161.1
- External Lambda files — Lambda code must remain inline strings per CDK pattern

## Context

**Codebase state (mapped 2026-01-11):**
- 7 stack files in `lib/`, largest is `compute-stack.ts` at 3,623 lines
- 30 test files in `test/` using CDK Template assertions
- TypeScript 4.9.5, AWS CDK 2.161.1, Jest 29.5.0
- Bootstrap scripts are Bash with embedded Python for AWS API calls
- Lambda functions are Python 3.11 generated as inline strings

**Key concerns identified:**
- `lib/compute-stack.ts` contains 5 private methods generating ~2,500 lines of bootstrap/Lambda code
- Retry logic duplicated in 4+ locations across scripts
- Variable scoping bug: `CLUSTER_LOCK_HELD` in subshell won't update parent
- Race condition: `ETCD_REGISTERED=true` set before DynamoDB confirmation
- `eval` usage in retry functions (lines 993, 1958, 1984)

**What's working well:**
- Clean separation between stacks
- Comprehensive infrastructure test coverage
- No TODO/FIXME comments (technical debt is structural, not deferred)
- Recent fixes show active maintenance

## Constraints

- **CDK Compatibility**: Must work with aws-cdk-lib 2.161.1 — no version upgrades
- **Inline Lambda**: Lambda code stays as inline strings — CDK deployment pattern requires this
- **No Regressions**: All 30 existing tests must pass after refactor
- **Behavior Preservation**: Bootstrap script behavior must remain identical (pure refactor)

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| Keep Lambda inline | CDK pattern for single-file Lambda, avoids asset bundling complexity | — Pending |
| Extract scripts to lib/scripts/ | Enables shellcheck, better testing, reduces compute-stack.ts | — Pending |
| Shared retry module | Single source of truth for retry logic across bash and Python | — Pending |

---
*Last updated: 2026-01-11 after initialization*
