# Dragon version-bound tests Implementation Plan

> Use subagent-driven-development and verification-before-completion. User approved the complete described feature; no redundant approval. Scope changes in the existing no-commit checkout and preserve unrelated folders.

**Goal:** Real automatic tests tied to saved versions, required for new formal delivery, with Gomoku verified.
**Architecture:** Short DB transactions around the existing Docker executor; trusted Node reporter; immutable test-run records; existing acceptance UI consumes exact evidence.
**Tech:** Node24, PostgreSQL, React, current Docker image; no new npm dependencies.
**Spec:** ../specs/2026-10-15-dragon-version-tests-design.md

## Global constraints
- Existing centered enlarged popup, department colors, all40 office animation files unchanged.
- Immutable version files only, no test-output writes to workspace, no paid model call.
- 60s execution,120s lease,100records/version, latest20 visible, one running test/project; no automatic rerun after uncertainty.
- Structured trusted test evidence; zero/skipped/todo/truncated/unknown never passes; no automatic human acceptance.
- New delivery requires exact latest passed testRunId and freezes evidence; legacy deliveries unchanged.

## Review focus
- New current files or another selected version must never inherit old test evidence.
- Duplicate POST/network loss/crash cannot launch duplicate work or strand permanent running state.
- Malicious stdout and missing/partial summary cannot fabricate a passing run.
- Async UI response after project/version switch must not mix drafts or evidence.
- Migration and actual Gomoku test addition preserve old saved versions/files/office animations.

### Task1 backend and isolated reporter
Files: new migration015; execution/version-tests.mjs and version-test-routes.mjs (or cohesive service/routes pair); shared snapshot hash helper; trusted apps/execution/test-reporter.mjs; existing Dockerfile, docker.mjs, app.mjs, acceptance-service/routes, deliverables. Tests: new version-test/report tests plus driver integration. Root owns tests/integration.test.mjs.
Interface: exact API/TestRun contract in spec. Export test discovery/result classification helpers for meaningful unit coverage. Share driver instance in app, execute outside scoped transactions. GET acceptance uses test history; confirm requires exact latest run. Report to .local/dragon-tests/backend-report.md.
- [x] Observe root real API GET404 RED and add targeted reporter/driver RED cases before their implementation.
- [x] Implement durable owned test records, idempotency/recovery/concurrency, fixed version hashing and trusted results.
- [x] Add shared Docker test method/reporter and real container checks; preserve existing execute behavior.
- [x] Enforce new formal delivery gate/freeze and retain old delivery shape compatibility.
- [x] Run focused tests, self-review, write test commands/results/changed files to report.

### Task2 existing popup UI
Files: EmployeeAcceptance.tsx; optional scoped EmployeeVersionTests.tsx + helper; employee-dialog.css only if needed. Avoid EmployeeDialog/Deliverables unless forwarding an existing callback requires it.
Interface: API/TestRun in spec; existing onFeedback appends to scoped chat and changes tabs. Task1 independent from Task2 after contract settled. Report .local/dragon-tests/ui-report.md.
- [x] Add saved-version one-click test/status/history/cases/details and clear empty/running/error states.
- [x] Preserve dirty manual drafts while refreshing tests, prevent stale response/project scope mixing, recover persisted running state via refresh/poll.
- [x] Add failed/missing-test feedback draft and exact testRunId confirm gate; frozen historical test evidence.
- [x] Run meaningful helper tests if extracted, lint/build/web tests; no CSS mirror tests.

### Task3 root verification, Gomoku, deployment
Files: tests/integration.test.mjs, optional migration test, local deployment/evidence scripts, test/gomoku.test.mjs artifact for user's project.
- [x] Real API RED then API+DB integration covering all review focus and old acceptance behavior updated to new test gate.
- [x] Back up original data/source, create meaningful Gomoku tests on actual HTML, prove failure on temporary faulty variants.
- [x] Independent spec/quality review, relevant repairs, full suite and production build.
- [x] Build image, migrate restricted grants, verify PID and restart hidden server; add only Gomoku tests/new saved version with CAS.
- [x] Live browser run saved Gomoku version through new endpoint, verify passing cases, scope, refresh persistence and feedback; keep human acceptance untouched. Check old file hashes/data and office40 baseline, save screenshot, finish ledger.
