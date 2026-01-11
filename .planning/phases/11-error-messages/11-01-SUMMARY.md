---
phase: 11-error-messages
plan: 01
subsystem: infra
tags: [lambda, python, error-handling, logging, etcd, backup]

# Dependency graph
requires:
  - phase: 09-structured-logging
    provides: structured logging with extra dict pattern
  - phase: 10-cloudwatch-metrics
    provides: metrics logger integration in Lambda functions
provides:
  - Actionable error messages with troubleshooting context for all Lambda functions
  - 'check' and 'possible_causes' fields in structured error logs
affects: [operations, debugging, incident-response]

# Tech tracking
tech-stack:
  added: []
  patterns: [error-message-format]

key-files:
  created: []
  modified:
    - lib/scripts/etcd-lifecycle-lambda.ts
    - lib/scripts/etcd-backup-lambda.ts
    - lib/scripts/cluster-health-lambda.ts

key-decisions:
  - "Error message format: [What failed]. [Root cause hints]. [What to check]."
  - "All logger.error calls include 'check' and 'possible_causes' in extra dict"
  - "Inline bash script errors include troubleshooting guidance in echo statements"

patterns-established:
  - "Error message format: Include what failed, possible causes, and actionable check instructions"
  - "Structured error context: Use 'check' and 'possible_causes' fields in extra dict"

issues-created: []

# Metrics
duration: 12min
completed: 2026-01-11
---

# Phase 11: Error Messages Summary

**Actionable error messages with troubleshooting context for etcd lifecycle, backup, and cluster health Lambda functions**

## Performance

- **Duration:** 12 min
- **Started:** 2026-01-11
- **Completed:** 2026-01-11
- **Tasks:** 3
- **Files modified:** 3

## Accomplishments

- Enhanced all QuorumRiskError, NodeDrainError, EtcdRemovalError messages with ASG health, SSM agent, and etcd troubleshooting guidance
- Updated all BackupError messages with etcd health, S3 permissions, and disk space checks
- Added 'check' and 'possible_causes' fields to all logger.error calls across all three Lambda functions
- Improved inline bash script error messages in etcd-backup-lambda with recovery steps

## Task Commits

Each task was committed atomically:

1. **Task 1: Improve etcd-lifecycle-lambda error messages** - `8c80848` (feat)
2. **Task 2: Improve etcd-backup-lambda error messages** - `895ed85` (feat)
3. **Task 3: Improve cluster-health-lambda error messages** - `dfbe64e` (feat)

**Plan metadata:** `dd4ce2d` (docs: complete plan)

## Files Created/Modified

- `lib/scripts/etcd-lifecycle-lambda.ts` - Enhanced QuorumRiskError, NodeDrainError, EtcdRemovalError messages and all logger.error calls with troubleshooting context
- `lib/scripts/etcd-backup-lambda.ts` - Enhanced BackupError messages, logger.error calls, and inline script error messages
- `lib/scripts/cluster-health-lambda.ts` - Enhanced all logger.error calls with 'check' and 'possible_causes' fields

## Decisions Made

- Used consistent error message format across all Lambda functions: "[What failed]. [Root cause hints]. [What to check]."
- Added structured 'check' and 'possible_causes' fields to extra dict for all logger.error calls
- Kept inline bash script errors human-readable with embedded troubleshooting guidance

## Deviations from Plan

None - plan executed exactly as written

## Issues Encountered

None

## Next Phase Readiness

- Error message improvements complete, ready for Phase 11-02 bootstrap scripts error messages
- Established pattern of 'check' and 'possible_causes' fields should be applied consistently in future error handling work

---
*Phase: 11-error-messages*
*Completed: 2026-01-11*
