---
phase: 12-graceful-recovery
plan: 01
subsystem: infra
tags: [bash, retry, jitter, exponential-backoff, thundering-herd]

# Dependency graph
requires:
  - phase: 02-retry-consolidation
    provides: Shared bash-retry.ts module with retry_command and retry_command_output functions
provides:
  - Random jitter in bash retry functions to prevent thundering herd
  - JITTER_FACTOR configuration (default 0.3 = 30%)
  - Structured logging with jitter details
affects: [12-graceful-recovery, 13-tracing]

# Tech tracking
tech-stack:
  added: []
  patterns: [jitter-on-retry, exponential-backoff-with-jitter]

key-files:
  created:
    - test/scripts/bash-retry.test.ts
  modified:
    - lib/scripts/bash-retry.ts

key-decisions:
  - "Use awk for floating-point jitter calculation (bash native arithmetic is integer-only)"
  - "Default JITTER_FACTOR=0.3 (30% of delay) balances spread with reasonable delay"
  - "Log base_delay and jitter separately for debugging visibility"

patterns-established:
  - "Jitter formula: actual_delay = delay + random(0, delay * JITTER_FACTOR)"
  - "Use $RANDOM % (max + 1) for bash random integer in range [0, max]"

issues-created: []

# Metrics
duration: 8min
completed: 2026-01-11
---

# Phase 12-01: Bash Retry Jitter Summary

**Added random jitter to bash retry functions preventing thundering herd when multiple EC2 instances retry AWS APIs simultaneously**

## Performance

- **Duration:** 8 min
- **Started:** 2026-01-11T20:30:00Z
- **Completed:** 2026-01-11T20:38:00Z
- **Tasks:** 3
- **Files modified:** 2

## Accomplishments
- Added JITTER_FACTOR variable (default 0.3 = 30% jitter) to retry functions
- Both retry_command() and retry_command_output() now include jitter in sleep delays
- Structured logging includes base_delay and jitter for debugging
- Created comprehensive test suite with 22 tests for jitter implementation

## Task Commits

Each task was committed atomically:

1. **Task 1: Add jitter to retry_command function** - `dd88cd4` (feat)
2. **Task 2: Add jitter to retry_command_output function** - `9dd4d03` (feat)
3. **Task 3: Update bash-retry tests for jitter** - `be8e1f1` (test)

**Plan metadata:** `cdf9e20` (docs: complete plan)

## Files Created/Modified
- `lib/scripts/bash-retry.ts` - Added jitter calculation to both retry functions, JITTER_FACTOR configuration
- `test/scripts/bash-retry.test.ts` - New test file with 22 tests verifying jitter implementation

## Decisions Made
- Used awk for floating-point multiplication since bash arithmetic is integer-only
- Default JITTER_FACTOR=0.3 provides good spread without excessive delays
- Log base_delay and jitter separately in structured logging for debugging

## Deviations from Plan

None - plan executed exactly as written

## Issues Encountered

None

## Next Phase Readiness
- Bash retry functions now have jitter, ready for 12-02 (bash retry with timeout)
- All bootstrap scripts automatically benefit from jitter through shared module

---
*Phase: 12-graceful-recovery*
*Completed: 2026-01-11*
