---
phase: 13-tracing
plan: 03
subsystem: observability
tags: [tracing, correlation-id, bootstrap, bash]

# Dependency graph
requires:
  - phase: 13-01-correlation-id-infrastructure
    provides: init_trace_id() function for Bash trace ID initialization
  - phase: 13-02-lambda-ssm-trace-id
    provides: TRACE_ID environment variable from Lambda SSM commands
provides:
  - Bootstrap scripts generate trace_id on startup
  - Key bootstrap log messages include trace_id for correlation
  - Incoming TRACE_ID from SSM commands is reused if present
affects: [cloudwatch-logs, troubleshooting]

# Tech tracking
tech-stack:
  added: []
  patterns: [bootstrap-trace-correlation]

key-files:
  created: []
  modified:
    - lib/scripts/control-plane-bootstrap.ts
    - lib/scripts/worker-bootstrap.ts
    - test/bootstrap-script-generators.test.ts

key-decisions:
  - "Call init_trace_id after INSTANCE_ID is set (enables trace+instance correlation)"
  - "Include trace_id in 'Instance metadata retrieved' log as initial correlation point"

patterns-established:
  - "Bootstrap scripts call init_trace_id early to enable correlation throughout execution"
  - "If TRACE_ID already set (from SSM), reuse it; otherwise generate new"

issues-created: []

# Metrics
duration: 4min
completed: 2026-01-11
---

# Phase 13 Plan 03: Bootstrap Scripts Trace ID Summary

**Added trace_id generation to control-plane and worker bootstrap scripts with init_trace_id() call and trace_id in key log messages**

## Performance

- **Duration:** 4 min
- **Started:** 2026-01-11T20:50:03Z
- **Completed:** 2026-01-11T20:54:16Z
- **Tasks:** 2
- **Files modified:** 3

## Accomplishments

- Control-plane bootstrap: Calls init_trace_id() after INSTANCE_ID is set, includes trace_id in metadata log
- Worker bootstrap: Calls init_trace_id() after INSTANCE_ID is set, includes trace_id in metadata log
- Both scripts reuse incoming TRACE_ID from SSM commands if present (Lambda-to-bootstrap correlation)

## Task Commits

Each task was committed atomically:

1. **Task 1: Update control-plane-bootstrap with trace_id** - `cd5d77c` (feat)
2. **Task 2: Update worker-bootstrap with trace_id** - `60da427` (feat)

## Files Created/Modified

- `lib/scripts/control-plane-bootstrap.ts` - Added init_trace_id() call, trace_id in log message
- `lib/scripts/worker-bootstrap.ts` - Added init_trace_id() call, trace_id in log message
- `test/bootstrap-script-generators.test.ts` - Added trace ID tests for both bootstrap scripts (4 tests)

## Decisions Made

- Call init_trace_id() immediately after INSTANCE_ID is retrieved so both can be correlated in logs
- Include trace_id in the "Instance metadata retrieved" log as the first correlation point in bootstrap

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

None

## Next Phase Readiness

- Phase 13 (Tracing) complete with all 3 plans executed
- End-to-end trace correlation now available: Lambda -> SSM -> Bootstrap scripts
- CloudWatch Logs Insights can now correlate events across Lambda invocations and EC2 bootstrap using trace_id

---
*Phase: 13-tracing*
*Completed: 2026-01-11*
