# Roadmap: Dedicated EC2 K8s Autoscaler

## Overview

Comprehensive quality and operational improvement of the AWS CDK Kubernetes autoscaler codebase. Building on the v1.0 code audit foundation, we continue with observability and reliability enhancements to make the system easier to monitor, debug, and operate in production.

## Milestones

- ✅ [v1.0 Code Audit](milestones/v1.0-ROADMAP.md) (Phases 1-8) — SHIPPED 2026-01-11
- ✅ [v1.1 Observability & Reliability](milestones/v1.1-ROADMAP.md) (Phases 9-13) — SHIPPED 2026-01-11
- 🚧 **v1.2 Quality & Consistency** - Phases 14-16 (in progress)

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

<details>
<summary>✅ v1.1 Observability & Reliability (Phases 9-13) — SHIPPED 2026-01-11</summary>

- [x] Phase 9: Structured Logging (4/4 plans) — completed 2026-01-11
- [x] Phase 10: CloudWatch Metrics (4/4 plans) — completed 2026-01-11
- [x] Phase 11: Error Messages (2/2 plans) — completed 2026-01-11
- [x] Phase 12: Graceful Recovery (5/5 plans) — completed 2026-01-11
- [x] Phase 13: Tracing (3/3 plans) — completed 2026-01-11

</details>

### 🚧 v1.2 Quality & Consistency (In Progress)

**Milestone Goal:** Fix known test failures and clean up technical debt around code consistency and test coverage.

#### Phase 14: Test Failures & Consistency Audit

**Goal**: Fix the 3 failing assertions in token-management.test.ts and audit codebase for consistency issues
**Depends on**: Previous milestone complete
**Research**: Unlikely (internal test fixes, established patterns)
**Plans**: 2

Plans:
- [ ] 14-01: Fix test failures (3 tasks)
- [ ] 14-02: Consistency audit (3 tasks)

#### Phase 15: Code Consistency Cleanup

**Goal**: Address naming, patterns, and formatting inconsistencies identified in audit
**Depends on**: Phase 14
**Research**: Unlikely (internal refactoring, established patterns)
**Plans**: TBD

Plans:
- [ ] 15-01: TBD (run /gsd:plan-phase 15 to break down)

#### Phase 16: Test Coverage Improvements

**Goal**: Identify areas with missing or weak test coverage and add comprehensive tests
**Depends on**: Phase 15
**Research**: Unlikely (internal testing, established patterns)
**Plans**: TBD

Plans:
- [ ] 16-01: TBD (run /gsd:plan-phase 16 to break down)

## Progress

See [MILESTONES.md](MILESTONES.md) for completed milestone history.

| Phase | Milestone | Plans | Status | Completed |
|-------|-----------|-------|--------|-----------|
| 14. Test Failures & Consistency Audit | v1.2 | 0/2 | Planned | - |
| 15. Code Consistency Cleanup | v1.2 | 0/? | Not started | - |
| 16. Test Coverage Improvements | v1.2 | 0/? | Not started | - |
