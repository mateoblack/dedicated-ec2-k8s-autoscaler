# Roadmap: Dedicated EC2 K8s Autoscaler Code Audit

## Overview

Systematic quality improvement of the AWS CDK Kubernetes autoscaler codebase. We'll extract the monolithic compute-stack.ts into focused modules, consolidate duplicated patterns, fix critical bugs in bootstrap scripts, add comprehensive testing for Lambda code, and improve maintainability with linting and documentation. The focus is reliability and code quality without adding new features.

## Domain Expertise

None

## Phases

**Phase Numbering:**
- Integer phases (1, 2, 3): Planned milestone work
- Decimal phases (2.1, 2.2): Urgent insertions (marked with INSERTED)

Decimal phases appear between their surrounding integers in numeric order.

- [x] **Phase 1: Script Extraction** - Extract bootstrap/Lambda scripts from compute-stack.ts to lib/scripts/
- [x] **Phase 2: Retry Consolidation** - Create shared retry module for bash and Python
- [x] **Phase 3: Variable Scoping Fix** - Fix subshell variable propagation issues in bootstrap scripts
- [ ] **Phase 4: Race Condition Fix** - Fix etcd member registration ordering bug
- [ ] **Phase 5: Eval Removal** - Replace eval usage with safer command execution patterns
- [ ] **Phase 6: Lambda Unit Tests** - Add unit tests for 5 createXxxCode methods
- [ ] **Phase 7: Script Linting** - Add shellcheck integration and fix issues
- [ ] **Phase 8: Documentation** - Add inline documentation to complex bootstrap sections

## Phase Details

### Phase 1: Script Extraction
**Goal**: Extract the 5 embedded script/Lambda methods from compute-stack.ts into separate files under lib/scripts/, reducing the file from 3,623 lines to a manageable size while maintaining the inline Lambda pattern
**Depends on**: Nothing (first phase)
**Research**: Unlikely (internal refactoring, CDK patterns established)
**Plans**: TBD

### Phase 2: Retry Consolidation
**Goal**: Create a shared retry module that consolidates the duplicated retry logic found in 4+ locations across bash and Python code
**Depends on**: Phase 1 (scripts must be extracted first)
**Research**: Unlikely (consolidating existing patterns)
**Plans**: TBD

### Phase 3: Variable Scoping Fix
**Goal**: Fix the CLUSTER_LOCK_HELD subshell variable propagation bug where updates in subshells don't reach the parent shell
**Depends on**: Phase 1 (scripts must be extracted first)
**Research**: Unlikely (bash scoping rules well-documented)
**Plans**: TBD

### Phase 4: Race Condition Fix
**Goal**: Fix the etcd member registration race condition where ETCD_REGISTERED=true is set before DynamoDB confirmation completes
**Depends on**: Phase 1 (scripts must be extracted first)
**Research**: Unlikely (ordering fix, no external APIs)
**Plans**: TBD

### Phase 5: Eval Removal
**Goal**: Replace eval usage (lines 993, 1958, 1984) with safer command execution patterns that don't risk command injection
**Depends on**: Phase 2 (retry module may be affected)
**Research**: Unlikely (bash patterns, internal code)
**Plans**: TBD

### Phase 6: Lambda Unit Tests
**Goal**: Add unit tests for the 5 createXxxCode methods that generate Lambda code, testing the Python logic independently of CDK infrastructure tests
**Depends on**: Phase 1 (extracted scripts are easier to test)
**Research**: Unlikely (Jest already in use, 30 existing test files)
**Plans**: TBD

### Phase 7: Script Linting
**Goal**: Integrate shellcheck into the build/test pipeline and fix any issues it identifies in the bash bootstrap scripts
**Depends on**: Phase 1-5 (scripts should be stable before linting)
**Research**: Likely (shellcheck npm integration)
**Research topics**: shellcheck npm package options, integrating shell linting with Jest/npm test, CI integration patterns
**Plans**: TBD

### Phase 8: Documentation
**Goal**: Add inline documentation to complex bootstrap sections, explaining the "why" behind non-obvious code patterns
**Depends on**: Phase 1-7 (document after code is stable)
**Research**: Unlikely (internal documentation)
**Plans**: TBD

## Progress

**Execution Order:**
Phases execute in numeric order: 1 → 2 → 3 → 4 → 5 → 6 → 7 → 8

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 1. Script Extraction | 3/3 | Complete | 2026-01-11 |
| 2. Retry Consolidation | 2/2 | Complete | 2026-01-11 |
| 3. Variable Scoping Fix | 1/1 | Complete | 2026-01-11 |
| 4. Race Condition Fix | 0/TBD | Not started | - |
| 5. Eval Removal | 0/TBD | Not started | - |
| 6. Lambda Unit Tests | 0/TBD | Not started | - |
| 7. Script Linting | 0/TBD | Not started | - |
| 8. Documentation | 0/TBD | Not started | - |
