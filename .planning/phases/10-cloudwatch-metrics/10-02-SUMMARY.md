---
phase: 10-cloudwatch-metrics
plan: 02
subsystem: infra
tags: [cloudwatch, iam, bash, metrics, aws-cli]

# Dependency graph
requires:
  - phase: 10-01
    provides: Python EMF metrics module pattern
provides:
  - CloudWatch PutMetricData IAM permissions for EC2 and Lambda roles
  - Bash emit_metric functions for bootstrap scripts
affects: [10-03, 10-04]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Namespace-scoped IAM condition for PutMetricData"
    - "Bash metrics emission with graceful error handling"

key-files:
  created:
    - lib/scripts/bash-metrics.ts
    - test/scripts/bash-metrics.test.ts
  modified:
    - lib/iam-stack.ts
    - lib/compute-stack.ts
    - lib/scripts/index.ts

key-decisions:
  - "Used cloudwatch:namespace condition to scope PutMetricData to K8sCluster/{clusterName}"
  - "Metrics functions fail silently with log_warn to not break bootstrap on metric failures"

patterns-established:
  - "emit_metric pattern: metric_name, value, unit with InstanceId dimension"
  - "emit_metric_with_dimensions pattern: custom dimensions for specialized metrics"

issues-created: []

# Metrics
duration: 4min
completed: 2026-01-11
---

# Phase 10 Plan 02: IAM Permissions & Bash Metrics Summary

**CloudWatch PutMetricData IAM permissions added to EC2/Lambda roles with bash emit_metric functions for bootstrap scripts**

## Performance

- **Duration:** 4 min
- **Started:** 2026-01-11T18:48:27Z
- **Completed:** 2026-01-11T18:52:47Z
- **Tasks:** 2/2
- **Files modified:** 5

## Accomplishments

- Added cloudwatch:PutMetricData permission to EC2 roles (control plane and worker) via addCloudWatchPermissions method
- Added cloudwatch:PutMetricData permission to all Lambda roles (etcdLifecycle, etcdBackup, clusterHealth)
- Created bash-metrics.ts module with emit_metric, emit_metric_with_dimensions, and emit_timing_metric functions
- All permissions scoped to K8sCluster/${clusterName} namespace via IAM condition

## Task Commits

Each task was committed atomically:

1. **Task 1: Add CloudWatch PutMetricData permissions to IAM roles** - `2e5bdd1` (feat)
2. **Task 2: Create bash-metrics.ts module** - `8053ba2` (feat)

## Files Created/Modified

- `lib/iam-stack.ts` - Added PutMetricData permission in addCloudWatchPermissions method
- `lib/compute-stack.ts` - Added PutMetricData permission to etcdLifecycleRole, etcdBackupRole, clusterHealthRole
- `lib/scripts/bash-metrics.ts` - New module with CloudWatch metrics emission functions
- `lib/scripts/index.ts` - Export getBashMetricsFunctions
- `test/scripts/bash-metrics.test.ts` - 30 unit tests for bash metrics functions

## Decisions Made

- **Namespace-scoped IAM condition:** Used `cloudwatch:namespace: K8sCluster/${clusterName}` condition on PutMetricData to restrict metrics to cluster-specific namespace (better security than resource: * alone)
- **Graceful failure on metrics:** emit_metric functions return success (0) and log warning on errors to prevent bootstrap script failures from non-critical metrics

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

None.

## Next Phase Readiness

- IAM permissions in place for both EC2 and Lambda to emit CloudWatch metrics
- Bash emit_metric functions ready for integration into bootstrap scripts
- Ready for 10-03-PLAN.md (integrate metrics into bootstrap scripts)

---
*Phase: 10-cloudwatch-metrics*
*Completed: 2026-01-11*
