---
phase: 05-eval-removal
plan: 01
subsystem: infra
tags: [bash, security, shell-scripting, bootstrap]

# Dependency graph
requires:
  - phase: 02-retry-consolidation
    provides: Shared bash retry module
provides:
  - Safer command execution in retry functions using "$@" pattern
  - Elimination of eval-based command injection risk
affects: [bootstrap-scripts, security-audit]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "$@" pattern for safe bash command execution
    - Argument-based retry calls instead of string commands

key-files:
  created: []
  modified:
    - lib/scripts/bash-retry.ts
    - lib/scripts/control-plane-bootstrap.ts
    - lib/scripts/worker-bootstrap.ts

key-decisions:
  - "Use $* for display (echo) and \"$@\" for execution (preserves argument boundaries)"

patterns-established:
  - "retry_command/retry_command_output: Use argument syntax, not quoted command strings"

issues-created: []

# Metrics
duration: 4min
completed: 2026-01-11
---

# Phase 05-01: Eval Removal Summary

**Replaced eval with safer "$@" pattern in bash retry functions, eliminating command injection risk**

## Performance

- **Duration:** 4 min
- **Started:** 2026-01-11T16:58:33Z
- **Completed:** 2026-01-11T17:02:56Z
- **Tasks:** 3
- **Files modified:** 3

## Accomplishments
- Replaced eval "$cmd" with "$@" in retry_command() and retry_command_output()
- Updated ~45 caller sites to use argument syntax instead of string syntax
- All 901 tests pass, confirming behavioral equivalence
- Zero eval usage remaining in retry functions

## Task Commits

Each task was committed atomically:

1. **Task 1: Update bash-retry.ts retry functions to use "$@" pattern** - `85d72ec` (refactor)
2. **Task 2: Update all retry_command callers to use argument syntax** - `c31d0b2` (refactor)
3. **Task 3: Run tests to verify behavioral equivalence** - (verification only, no code changes)

**Plan metadata:** (pending - this summary commit)

## Files Created/Modified
- `lib/scripts/bash-retry.ts` - Replaced eval with "$@" pattern in retry functions
- `lib/scripts/control-plane-bootstrap.ts` - Updated ~39 retry_command/retry_command_output calls
- `lib/scripts/worker-bootstrap.ts` - Updated ~6 retry_command_output calls

## Decisions Made
- Used `$*` for echo statements (concatenates with spaces for display)
- Used `"$@"` for command execution (preserves argument boundaries)
- Changed shell variable quoting from '\$var' to "\$var" when removing outer quotes

## Deviations from Plan

None - plan executed exactly as written

## Issues Encountered

None

## Next Phase Readiness
- Eval removal complete, no further work needed for this security improvement
- All retry-based command execution now uses safe "$@" pattern

---
*Phase: 05-eval-removal*
*Completed: 2026-01-11*
