---
phase: 03-variable-scoping-fix
plan: 01
subsystem: infra
tags: [bash, shell, subshell, process-substitution, bootstrap]

# Dependency graph
requires:
  - phase: 01-script-extraction
    provides: Bootstrap script architecture and TypeScript template patterns
  - phase: 02-retry-consolidation
    provides: Shared retry utilities referenced by bootstrap script
provides:
  - Fixed variable scoping in cleanup_on_failure() function
  - Process substitution pattern for parent shell variable reads
affects: [control-plane-bootstrap, etcd-lifecycle, disaster-recovery]

# Tech tracking
tech-stack:
  added: []
  patterns: [process-substitution-for-variable-reads]

key-files:
  created: []
  modified: [lib/scripts/control-plane-bootstrap.ts]

key-decisions:
  - "Used process substitution `< <(cmd)` instead of temp file approach for simplicity"
  - "Combined cluster_id and member_id into single read with space-separated Python output"

patterns-established:
  - "Process substitution pattern: `read var1 var2 < <(cmd)` for capturing command output in parent shell"
  - "When piping to block is needed, use command substitution first, then process substitution"

issues-created: []

# Metrics
duration: 2min
completed: 2026-01-11
---

# Phase 03-01: Variable Scoping Fix Summary

**Fixed subshell variable propagation bug in cleanup_on_failure() using process substitution pattern**

## Performance

- **Duration:** 2 min
- **Started:** 2026-01-11T09:46:36Z
- **Completed:** 2026-01-11T09:48:35Z
- **Tasks:** 2
- **Files modified:** 1

## Accomplishments
- Eliminated subshell variable scope issue in cleanup_on_failure() function
- Replaced pipe-into-block pattern `| { read ... }` with process substitution `< <(...)`
- Variable reads now execute in parent shell, ensuring CLUSTER_LOCK_HELD and other state variables propagate correctly
- All 901 tests continue to pass with no regressions

## Task Commits

Each task was committed atomically:

1. **Task 1: Fix subshell variable scoping in cleanup_on_failure()** - `b49d561` (refactor)
2. **Task 2: Verify existing tests pass** - No commit (verification only, no code changes)

**Plan metadata:** (pending)

## Files Created/Modified
- `lib/scripts/control-plane-bootstrap.ts` - Fixed cleanup_on_failure() to use process substitution instead of pipe-into-block pattern

## Decisions Made
- Used process substitution `< <(cmd)` approach rather than temp file approach as it keeps the logic more contained and readable
- Modified Python script to output space-separated values on single line for simpler `read var1 var2` parsing

## Deviations from Plan

None - plan executed exactly as written

## Issues Encountered

- The `npm test` script failed due to missing `bin/k8s-cluster.ts` (cdk.json references non-existent file). Used `npm run test:code` which runs Jest directly, bypassing the `cdk synth` step. This is a pre-existing project configuration issue, not introduced by this change.

## Next Phase Readiness
- Variable scoping fix complete
- Bootstrap script now has correct error handling semantics
- Ready for any subsequent phases that depend on reliable cleanup behavior

---
*Phase: 03-variable-scoping-fix*
*Completed: 2026-01-11*
