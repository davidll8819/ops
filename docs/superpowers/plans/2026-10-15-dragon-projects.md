# Dragon Projects Implementation Plan

> Use subagent-driven-development for backend/UI tasks and verification-before-completion for deployment. User approved the feature description and asked to continue; routine design decisions proceed without another approval gate.

**Goal:** Independent named Dragon projects and reversible saved delivery versions in existing popup.
**Architecture:** Extend workspace entity, pin explicit project ID through existing model/runtime flow, immutable full-file version table, scoped frontend state.
**Tech Stack:** Existing PostgreSQL/Fastify/React/Node24, no dependencies.
**Spec:** ../specs/2026-10-15-dragon-projects-design.md

## Global constraints
Preserve current Gomoku/default ID/files/history and40 office animation files. No public publishing. Tenant+user isolation, owner/admin mutation.20 projects;100 versions/256MiB perproject. No history deletion. Existing8MiB project file limit remains. No Git base exists; scope current untracked tree without staging unrelated files.

## Review focus
Async model reply after project switch; two projects sharing same numeric revision; first-project migration from existing dev chat; restoration during ordinary chat or execution; quota failure after auto-backup starts. Test each at real API/DB boundaries.

### Task1 backend — separate implementer
Files: new migration013; execution/service.mjs, routes.mjs, delivery-routes.mjs; new execution/project-store.mjs/project-routes.mjs as useful; workspace-services.mjs, app.mjs route registration. Own focused backend tests if needed, not integration.test.mjs (root owns).
- [x] Root writes real API integration failure for project creation/isolation/version recovery; implementer watches RED before implementation.
- [x] Migration extends workspace, copies chat, creates owned immutable version table+RLS; model/ordinary chat paths share pinned repository helpers.
- [x] Implement all spec routes and return shapes; lock mutations; recover expired leases; explicit ID validates ownership with no default fallback.
- [x] Service uses perproject files/runs/chat and immutable versions; restore backups atomically, preserves history, updates conversation revision.
- [x] Focused tests green; root verifies old suite and migration preservation.

### Task2 UI — separate implementer
Files EmployeeDialog.tsx, DepartmentChat.tsx, EmployeeProject.tsx, EmployeeDeliverables.tsx, employee-dialog.css plus small project UI component/hook if useful. No office scene/team/assets changes.
- [x] Project chooser/new/rename, persisted owned selection and explicit project URLs per spec.
- [x] Perproject conversation draft/pending state; async lifecycle guard and stable callbacks; distinct scoped keys. Ordinary and execute chat both send projectId.
- [x] Current/history switch in 成果, label/save version, preview/download historical snapshot, restore with backup explanation, refresh chat/files after success.
- [x] Lint/build/web tests; root live switching, input and preview checks. Do not write implementation-mirroring tests for layout.

### Task3 integration/verification — root
- [x] Extend real PGlite API tests: identity, own-project requests, default compatibility, A/B ordinary+execution chat context, pinned async writes, immutable versions, backup recovery, stale/active/role/cross-tenant denial and RLS.
- [x] Add focused migration fixture if needed for pre013 files/chat survival.
- [x] Independent broad review; resolve material findings; run full npmtest (escalation for socket tests), build/lint.
- [x] Backup local DB project/chat state, stop verified app, apply migration as local admin, grant new table rights to restricted app role, restart normal app.
- [x] Live CUA verify existing Gomoku plus sample project creation/name/switch/version save+restore, verify original preserved; keep useful sample or clearly labeled test project.
- [x] Check office hashes, save screenshot/notes and return user-facing usage. No commits/push/unrelated edits.

