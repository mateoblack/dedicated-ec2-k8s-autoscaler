---
phase: 12-graceful-recovery
plan: 02
subsystem: infra
tags: [bash, timeout, retry, aws, bootstrap]

# Dependency graph
requires:
  - phase: 12-01
    provides: retry functions with jitter
provides:
  - retry_command_timeout function with per-operation timeout
  - retry_command_output_timeout function for output capture with timeout
  - timeout exit code handling (124, 137)
affects: [bootstrap-scripts, control-plane-init, worker-init]

# Tech tracking
tech-stack:
  added: []
  patterns: [timeout-wrapped-retries]

key-files:
  created: []
  modified: [lib/scripts/bash-retry.ts, test/scripts/bash-retry.test.ts]

key-decisions:
  - "Use GNU timeout command (available on Amazon Linux 2)"
  - "Treat exit codes 124 (timeout) and 137 (killed) as retriable"

patterns-established:
  - "Timeout functions follow same jitter pattern as base retry functions"

issues-created: []

# Metrics
duration: 12min
completed: 2026-01-11
---

# Phase 12 Plan 02: Timeout Support Summary

**Per-operation timeout support for bash retry functions, preventing indefinite waits on hung commands**

## Performance

- **Duration:** 12 min
- **Started:** 2026-01-11T22:30:00Z
- **Completed:** 2026-01-11T22:42:00Z
- **Tasks:** 3
- **Files modified:** 2

## Accomplishments

- Added retry_command_timeout() with per-operation timeout support
- Added retry_command_output_timeout() for output capture with timeout
- Proper handling of timeout exit codes (124 for timeout, 137 for killed)
- Consistent jitter implementation matching base retry functions
- Comprehensive test coverage (12 new tests)

## Task Commits

Each task was committed atomically:

1. **Task 1: Create retry_command_timeout function** - `298e083` (feat)
2. **Task 2: Add retry_command_output_timeout variant** - `d9ff4a6` (feat)
3. **Fix: Escape timeout_seconds in template** - `1eec18e` (fix)
4. **Task 3: Add timeout function tests** - `016184c` (test)

## Files Created/Modified

- `lib/scripts/bash-retry.ts` - Added retry_command_timeout and retry_command_output_timeout functions
- `test/scripts/bash-retry.test.ts` - Added 12 tests for timeout function verification

## Decisions Made

- Used GNU `timeout` command for wrapping commands (standard on Amazon Linux 2)
- Exit code 124 (timeout) and 137 (SIGKILL) both treated as retriable failures
- Structured logging includes failure reason (timeout vs command_failed vs killed)

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Fixed TypeScript template interpolation**
- **Found during:** Task 3 (test verification)
- **Issue:** `${timeout_seconds}` in echo statements was interpreted as TypeScript template interpolation, causing the new functions to be silently dropped from output
- **Fix:** Escaped as `\${timeout_seconds}` for literal bash variable reference
- **Files modified:** lib/scripts/bash-retry.ts
- **Verification:** Tests now pass, functions included in generated bash
- **Commit:** 1eec18e

---

**Total deviations:** 1 auto-fixed (blocking issue)
**Impact on plan:** Essential fix for correctness. No scope creep.

## Issues Encountered

None - plan executed as specified once template interpolation was fixed.

## Next Phase Readiness

- Timeout retry functions ready for use in bootstrap scripts
- Ready for 12-03-PLAN.md (Critical path timeout usage)

---
*Phase: 12-graceful-recovery*
*Completed: 2026-01-11*
