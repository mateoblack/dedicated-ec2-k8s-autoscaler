---
phase: 13-tracing
plan: 02
subsystem: observability
tags: [tracing, correlation-id, lambda, ssm, python]

# Dependency graph
requires:
  - phase: 13-01-correlation-id-infrastructure
    provides: setup_logging(context, trace_id) with auto-generation
provides:
  - trace_id propagation from Lambda to SSM commands
  - TRACE_ID environment variable in SSM shell scripts
  - Correlation IDs in SSM command log messages
affects: [13-03, bootstrap-scripts, cloudwatch-logs]

# Tech tracking
tech-stack:
  added: []
  patterns: [lambda-to-ssm-correlation]

key-files:
  created: []
  modified:
    - lib/scripts/etcd-lifecycle-lambda.ts
    - lib/scripts/etcd-backup-lambda.ts
    - test/before-terminate-lifecycle.test.ts
    - test/etcd-backup-lambda.test.ts

key-decisions:
  - "Export TRACE_ID at SSM command start for downstream script access"
  - "Store trace_id as global _trace_id for access in helper functions"

patterns-established:
  - "Lambda generates trace_id at handler start, stores globally, exports in SSM commands"
  - "SSM command log messages include trace_id for CloudWatch correlation"

issues-created: []

# Metrics
duration: 6min
completed: 2026-01-11
---

# Phase 13 Plan 02: Lambda SSM Trace ID Propagation Summary

**Added trace_id generation to etcd Lambda handlers with propagation through SSM commands via TRACE_ID environment variable export**

## Performance

- **Duration:** 6 min
- **Started:** 2026-01-11T20:26:34Z
- **Completed:** 2026-01-11T20:32:06Z
- **Tasks:** 2
- **Files modified:** 4

## Accomplishments

- etcd-lifecycle-lambda: Generates trace_id, exports TRACE_ID in drain_node() and remove_etcd_member() SSM commands
- etcd-backup-lambda: Generates trace_id, exports TRACE_ID in create_etcd_backup() SSM command
- Both Lambdas include trace_id in SSM command log messages for CloudWatch correlation

## Task Commits

Each task was committed atomically:

1. **Task 1: Update etcd-lifecycle-lambda to pass trace_id in SSM commands** - `4f1aa63` (feat)
2. **Task 2: Update etcd-backup-lambda to pass trace_id in SSM commands** - `881ddca` (feat)

## Files Created/Modified

- `lib/scripts/etcd-lifecycle-lambda.ts` - Added trace_id generation, global _trace_id, TRACE_ID export in SSM commands, trace_id in logs
- `lib/scripts/etcd-backup-lambda.ts` - Added trace_id generation, global _trace_id, TRACE_ID export in SSM command, trace_id in log
- `test/before-terminate-lifecycle.test.ts` - Added 6 tests for trace ID correlation patterns
- `test/etcd-backup-lambda.test.ts` - Added 6 tests for trace ID correlation patterns, fixed 2 pre-existing test assertions

## Decisions Made

- Export TRACE_ID as first command in SSM shell scripts to make it available to all subsequent operations
- Store _trace_id as global Python variable to allow helper functions (drain_node, remove_etcd_member, create_etcd_backup) to reference it

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Fixed pre-existing test assertions in etcd-backup-lambda.test.ts**
- **Found during:** Task 2 (etcd-backup-lambda tests)
- **Issue:** Two tests had incorrect assertions: expected 'return s3_key' but code returns dict, expected 'Failed to send SSM command' but code says 'Failed to send SSM backup command'
- **Fix:** Updated test assertions to match actual code behavior
- **Files modified:** test/etcd-backup-lambda.test.ts
- **Verification:** All 48 tests pass
- **Committed in:** 881ddca (Task 2 commit)

---

**Total deviations:** 1 auto-fixed (bug in tests)
**Impact on plan:** Test fix was required to pass verification. No scope creep.

## Issues Encountered

None

## Next Phase Readiness

- Lambda handlers now propagate trace_id through SSM commands
- TRACE_ID environment variable available to shell scripts on target instances
- Ready for 13-03-PLAN.md (Bootstrap scripts trace ID integration)

---
*Phase: 13-tracing*
*Completed: 2026-01-11*
