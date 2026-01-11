---
phase: 11-error-messages
plan: 02
subsystem: infra
tags: [bash, bootstrap, error-handling, troubleshooting, observability]

# Dependency graph
requires:
  - phase: 09-structured-logging
    provides: Bash structured logging with log_error function
  - phase: 11-error-messages/01
    provides: Lambda error message patterns to follow
provides:
  - Actionable error messages in all bootstrap scripts
  - Troubleshooting context with check= and common_causes= fields
  - Consistent error format across control-plane and worker bootstrap
affects: [operations, debugging, support]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Error message format: log_error 'message' 'check=...' 'common_causes=...'"

key-files:
  created: []
  modified:
    - lib/scripts/control-plane-bootstrap.ts
    - lib/scripts/worker-bootstrap.ts
    - lib/scripts/bash-retry.ts

key-decisions:
  - "Use check= for immediate verification steps"
  - "Use common_causes= for root cause hints"
  - "Reference specific log locations and commands"

patterns-established:
  - "Actionable error messages with troubleshooting context"

issues-created: []

# Metrics
duration: 5min
completed: 2026-01-11
---

# Phase 11 Plan 02: Bootstrap Scripts Error Messages Summary

**Actionable error messages with troubleshooting context for all Bash bootstrap scripts (control-plane, worker, retry utilities)**

## Performance

- **Duration:** 5 min
- **Started:** 2026-01-11T19:21:49Z
- **Completed:** 2026-01-11T19:27:21Z
- **Tasks:** 3
- **Files modified:** 3

## Accomplishments

- Updated 35 log_error calls in control-plane-bootstrap.ts with troubleshooting guidance
- Updated 15 log_error calls in worker-bootstrap.ts with actionable context
- Enhanced bash-retry.ts failure message with check= and hint= fields
- All error messages now include what to verify and common root causes

## Task Commits

Each task was committed atomically:

1. **Task 1: Improve control-plane-bootstrap error messages** - `ef57402` (feat)
2. **Task 2: Improve worker-bootstrap error messages** - `69f9184` (feat)
3. **Task 3: Improve bash-retry error messages** - `46b6962` (feat)

**Plan metadata:** (this commit) (docs: complete plan)

## Files Created/Modified

- `lib/scripts/control-plane-bootstrap.ts` - 35 log_error calls enhanced with troubleshooting context (IMDS, etcd, SSM, kubeadm, OIDC errors)
- `lib/scripts/worker-bootstrap.ts` - 15 log_error calls enhanced with troubleshooting context (IMDS, SSM, join errors)
- `lib/scripts/bash-retry.ts` - Retry exhaustion message with check= and hint= fields

## Decisions Made

None - followed plan as specified

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

None

## Next Phase Readiness

- Phase 11 (Error Messages) complete with all plans finished
- Ready for Phase 12: Graceful Recovery
- All error messages now provide actionable troubleshooting guidance

---
*Phase: 11-error-messages*
*Completed: 2026-01-11*
