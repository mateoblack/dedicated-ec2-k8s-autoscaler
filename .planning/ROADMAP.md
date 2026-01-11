# Roadmap: Dedicated EC2 K8s Autoscaler

## Overview

Comprehensive quality and operational improvement of the AWS CDK Kubernetes autoscaler codebase. Building on the v1.0 code audit foundation, we continue with observability and reliability enhancements to make the system easier to monitor, debug, and operate in production.

## Milestones

- ✅ [v1.0 Code Audit](milestones/v1.0-ROADMAP.md) (Phases 1-8) — SHIPPED 2026-01-11
- 🚧 **v1.1 Observability & Reliability** — Phases 9-13 (in progress)

## Domain Expertise

None

## Phases

**Phase Numbering:**
- Integer phases (1, 2, 3): Planned milestone work
- Decimal phases (2.1, 2.2): Urgent insertions (marked with INSERTED)

Decimal phases appear between their surrounding integers in numeric order.

<details>
<summary>✅ v1.0 Code Audit (Phases 1-8) — SHIPPED 2026-01-11</summary>

- [x] Phase 1: Script Extraction (3/3 plans) — completed 2026-01-11
- [x] Phase 2: Retry Consolidation (2/2 plans) — completed 2026-01-11
- [x] Phase 3: Variable Scoping Fix (1/1 plan) — completed 2026-01-11
- [x] Phase 4: Race Condition Fix (1/1 plan) — completed 2026-01-11
- [x] Phase 5: Eval Removal (1/1 plan) — completed 2026-01-11
- [x] Phase 6: Lambda Unit Tests (2/2 plans) — completed 2026-01-11
- [x] Phase 7: Script Linting (1/1 plan) — completed 2026-01-11
- [x] Phase 8: Documentation (1/1 plan) — completed 2026-01-11

</details>

### 🚧 v1.1 Observability & Reliability (In Progress)

**Milestone Goal:** Comprehensive observability and error handling improvements to make the autoscaler easier to monitor, debug, and operate

**Constraints:**
- Build on existing retry infrastructure from v1.0 (lib/scripts/bash/retry-utils.sh, lib/scripts/python/retry_utils.py)
- Maintain backwards compatibility with existing CloudFormation deployments
- Structured logging must work in both EC2 bootstrap context and Lambda context

#### Phase 9: Structured Logging

**Goal**: JSON logging format for bash scripts and Lambda functions with consistent context, severity levels, and timestamps
**Depends on**: v1.0 complete
**Research**: Unlikely (internal patterns, extending existing bash/Python modules)
**Plans**: 4

Plans:
- [x] 09-01: Bash structured logging module
- [x] 09-02: Bootstrap scripts migration
- [x] 09-03: Python structured logging module
- [x] 09-04: Lambda functions migration

#### Phase 10: CloudWatch Metrics

**Goal**: Custom metrics emission from bootstrap scripts and Lambda for monitoring dashboards
**Depends on**: Phase 9
**Research**: Complete (EMF for Lambda, PutMetricData CLI for bash)
**Plans**: 4

Plans:
- [x] 10-01: Python EMF metrics module
- [x] 10-02: IAM permissions + Bash metrics module
- [x] 10-03: Lambda integration (EMF metrics)
- [x] 10-04: Bootstrap integration + Dashboard widgets

#### Phase 11: Error Messages

**Goal**: Clearer error descriptions with actionable context and root cause hints
**Depends on**: Phase 10
**Research**: Unlikely (internal patterns, documentation improvements)
**Plans**: 2

Plans:
- [x] 11-01: Lambda error messages
- [x] 11-02: Bootstrap scripts error messages

#### Phase 12: Graceful Recovery

**Goal**: Enhanced retry patterns with better exponential backoff and intelligent fallbacks
**Depends on**: Phase 11
**Research**: Unlikely (building on existing v1.0 retry infrastructure)
**Plans**: TBD

Plans:
- [ ] 12-01: TBD (run /gsd:plan-phase 12 to break down)

#### Phase 13: Tracing

**Goal**: Correlation IDs linking related operations across Lambda invocations and script execution
**Depends on**: Phase 12
**Research**: Likely (correlation ID patterns, potentially X-Ray integration)
**Research topics**: X-Ray SDK for Lambda, correlation ID propagation patterns, trace context standards
**Plans**: TBD

Plans:
- [ ] 13-01: TBD (run /gsd:plan-phase 13 to break down)

## Progress

**Execution Order:**
Phases execute in numeric order: 1 → 2 → ... → 8 → 9 → 10 → 11 → 12 → 13

| Phase | Milestone | Plans Complete | Status | Completed |
|-------|-----------|----------------|--------|-----------|
| 1. Script Extraction | v1.0 | 3/3 | Complete | 2026-01-11 |
| 2. Retry Consolidation | v1.0 | 2/2 | Complete | 2026-01-11 |
| 3. Variable Scoping Fix | v1.0 | 1/1 | Complete | 2026-01-11 |
| 4. Race Condition Fix | v1.0 | 1/1 | Complete | 2026-01-11 |
| 5. Eval Removal | v1.0 | 1/1 | Complete | 2026-01-11 |
| 6. Lambda Unit Tests | v1.0 | 2/2 | Complete | 2026-01-11 |
| 7. Script Linting | v1.0 | 1/1 | Complete | 2026-01-11 |
| 8. Documentation | v1.0 | 1/1 | Complete | 2026-01-11 |
| 9. Structured Logging | v1.1 | 4/4 | Complete | 2026-01-11 |
| 10. CloudWatch Metrics | v1.1 | 4/4 | Complete | 2026-01-11 |
| 11. Error Messages | v1.1 | 2/2 | Complete | 2026-01-11 |
| 12. Graceful Recovery | v1.1 | 0/? | Not started | - |
| 13. Tracing | v1.1 | 0/? | Not started | - |
