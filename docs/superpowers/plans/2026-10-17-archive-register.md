# Archive Registration Implementation Plan
> Agentic workers: executing-plans inline implementation; one fresh final review. User already authorized local feature/deployment, no repeat approval gates.
**Goal:** Editable persisted draft, explicit confirmation and private classification/tag retrieval in Zhao's existing popup.
**Architecture:** Separate versioned archive_records referencing immutable suggestions, transactional private routes and popup editor/search.
**Tech:** existing Node24/PostgreSQL/React, no dependencies.
**Spec:** docs/superpowers/specs/2026-10-17-archive-register-design.md

## Constraints
Preserve all office animation/resources, source documents, suggestions, conversations, comparisons and project records. No Git HEAD: source/data snapshots instead of commits/worktrees/cleanup. No model calls for registration. Exact enum/limits/endpoints and version semantics in spec.

## Review focus
1. Two editors/first save cannot overwrite a competing revision; confirm retry creates no duplicate.
2. Tenant/user private source integrity before save/confirm/detail, no trusting client identity.
3. Edited title/tags cannot inject filenames/SQL/UI; download only after validated detail.
4. Filter/page/tenant transitions cannot display or confirm stale records, unsaved input cannot be confirmed.
5. Existing comparison state, right draft, composer and office animations retained.

### Task1 API and data
Create archive/records.mjs, archive/record-routes.mjs, migration020, tests/archive-records.test.mjs; modify app registration and archive guidance. Interfaces: spec endpoints return {record}, list {items,total,page,pageSize}; source metadata derived from suggestion and current original. Export metadata schema and recordView; reuse buildFilingResult safely.
- [x] Write/run RED migrated upload+suggestion route tests for edit, restore, confirm, duplicate/conflict, filters/paging, isolation, RLS, FK, immutable and source drift.
- [x] Implement transactional versioned draft CRUD and confirm, private retrieval/search; no file/model mutations.
- [x] Run focused new + existing filing tests green.

### Task2 popup editor and registry
Create archive-records.ts, ArchiveRegistration.tsx, ArchiveRegistry.tsx, archive-records.css, web/tests/archive-records.test.mjs. Modify ArchiveFiling.tsx (editor beneath source), ArchiveDocuments.tsx (registry tool), i18n/en.json.
- [x] Write/run RED browser tests for editable draft/save/confirm, failed save retention, stale replies and combined search/details.
- [x] Implement keyed forms, saved revision/dirty guard, server-derived preview, list paging/filter/record detail and cited origin/download; preserve existing comparison mounted and rightchat.
- [x] Run scoped actual browser tests, lint/build.

### Task3 review, deploy, live
- [x] Source/data/office baseline; builder check; ledger/preflight.
- [x] Fullserial backend+frontend once, final independent review, focused RED/GREEN fixes if needed.
- [x] Apply migration020 + minimum runtime grants, restart verifiedwebsiteonly, live editor→save→confirm→classification/tag retrieval and reload, DB identity/original preservation, screenshot.
- [x] Acceptance record, user instructions, no Git cleanup.
