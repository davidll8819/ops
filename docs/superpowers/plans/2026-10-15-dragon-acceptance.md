# Dragon Acceptance Implementation Plan

> For agentic workers: use subagent-driven-development and verification-before-completion. User approved scope and execution; proceed without redundant approval. No Git base exists, so work scoped in place without commits or unrelated staging.

**Goal:** Version-bound truthful acceptance and immutable formal deliveries in existing Dragon popup, with all employee popups enlarged.
**Architecture:** Separate acceptance service/routes and two owned DB tables; reuse immutable project versions, existing previews/ZIP and project-scoped chat drafts. UI section is independent from version save/restore.
**Tech Stack:** Existing Node24/Fastify/PostgreSQL/React; no new dependencies.
**Spec:** ../specs/2026-10-15-dragon-acceptance-design.md

## Global constraints
- Preserve original project files/conversation/runs, original office40 file hashes, current colors and centered popup.
- Acceptance and formal delivery pinned to immutable version ID, never model summaries or old unbound execution logs.
- System check certifies only actual saved HTML/package assembly; manual functional results explicitly attributed to user.
- 1..20 manual rows; title1..160, note<=2000 (required for passed/failed), docs<=8000 (nonempty for delivery), label1..80. Revision-conflict409; no forged system evidence.
- One immutable formal delivery per version; source-only cannot deliver; no public publishing, no arbitrary command runner, no paid model work needed.
- Shared popup max1080x840, desktop gaps32px; existing mobile20/24 retained.

## Review focus
Version change while GET/mutation/preview in flight; mismatched project/user/version ownership; default unsaved revision0 races; editing entry after check; confirming from stale draft or later altering accepted files/docs. The tests in Task3 and live browser cover these boundaries.

### Task1 backend
Files: migration014; new execution/acceptance-service.mjs and acceptance-routes.mjs; app.mjs registration; deliverables.mjs optional safe extra ZIP docs; delivery-routes.mjs shared preview reuse if necessary. Backend owns focused unit tests only, root owns tests/integration.test.mjs.
Interfaces: exact Draft, Delivery and eight routes in spec. No workspace/runtime/chat changes needed.
- [x] Observe root API test fail404 before production code.
- [x] Add owned RLS tables/FKs, immutable delivery trigger; default GET read-only, strict validated draft writes, genuine package check with immutable snapshot hash, optimistic-lock mutations, formal frozen delivery.
- [x] Add formal list/read/preview/ZIP, safe documentation encoding and fixed filenames. Reuse existing preview authorization/CSP.
- [x] Focused unit tests for pure evidence/hash/package helpers only when behavior merits coverage; report files/commands/results and concerns.

### Task2 UI
Files: new EmployeeAcceptance.tsx (+optional cohesive types/helpers); EmployeeDeliverables.tsx; EmployeeDialog.tsx; employee-dialog.css. Do not touch scene/assets/team animation or backend.
Interfaces: spec routes/types; parent callback onRevisionFeedback(text) appends to scoped draft and opens chat. Render acceptance only for saved version, compact formal deliveries section for project even current selection. Reuse existing historical preview for official delivery or implement scoped preview via official endpoint.
- [x] Existing result surface gains clear steps, manual editable items/status/notes, system check/result detail, docs, save/confirm controls and immutable delivered view.
- [x] Add fixed formal delivery cards with preview/download/docs and feedback-to-chat preserving existing draft. Guard stale request completion and unsaved edits.
- [x] Enlarge all shared employee dialogs per size constraints, retain responsive overflow/colors/focus.
- [x] Run lint/build/web tests; root performs live UI checks (do not add tests mirroring CSS/source text).

### Task3 root integration/deploy
Files: tests/integration.test.mjs nested case; optional migration test; docs/.local/dragon-acceptance evidence.
- [x] Real API RED new acceptance404, then tests for roles/isolation/forgery/stale/not-ready/entry-change/confirmation/immutability/history/ZIP/preview.
- [x] Builder design check, independent spec+code review; fix substantive findings and rerun relevant cases.
- [x] Full npm test, lint/build results, office baseline and original project data preservation.
- [x] Backup local project/version/chat/run data; verify server PID before stop; migrate and restricted app grants; restart normal hidden service.
- [x] Live CUA exercise sample project acceptance/formal delivery/feedback and enlarged dialogs. Snapshot proof, preserve user's Gomoku and user acceptance authority, update ledger and final usage.
