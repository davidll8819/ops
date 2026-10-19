# Archive filing implementation plan
> Agentic workers: executing-plans inline implementation, then independent final review.
**Goal:** grounded persisted classification, tags, naming and directory suggestions in Zhao's existing popup.
**Architecture:** private per-extraction generation lease + bounded existing model gateway + strict grounded schema + selected-file UI.
**Tech:** existing Node24/PostgreSQL/React; no dependencies.
**Spec:** docs/superpowers/specs/2026-10-17-archive-filing-design.md

## Global constraints
Preserve office animations/original documents/conversations/projects. Source6MiB; context32sources/24000chars; selected1–4 docs. Private tenant+user access, source hashes before and after model, no modelinsideTX, lease10min/late attempt fence. Exact schema/interfaces in spec. No GitHEAD; snapshot instead of stage/commit/worktree. Existing user authorization covers local deployment.

## Review focus
1. Concurrent generate/reload must not duplicate paid generation or change a ready archive number.
2. Selection/tenant changes during model work must not mix recommendations or export old selection.
3. Model response cannot forge path, archive number, identity or cross-document evidence.
4. Empty/ambiguous/OCR/partial sources must expose uncertainty rather than false official metadata.
5. New left-tool tab must retain comparison behavior, rightchat draft and existing geometry.

### Task1 private grounded recommendation API
Create `archive/filing.mjs` (context/schema/safe naming), `archive/filing-store.mjs` (private source/read/lease/save), `archive/filing-routes.mjs` (gateway orchestration), migration019; modify app registration, slow-response route set, workspace-services archiveguidance. Create tests/archive-filing.test.mjs. All API paths under apps/api/src.
- [x] Write and run RED pure schema/path/source quote tests and real migrated PGlite upload/route tests.
- [x] Implement strictmodelcontext/validation, source loader, private leasedrecords, serveridentitynumber/path, no paid duplicate/cache/recovery and finalhashcheck.
- [x] Verify actualDOCX/PDF/XLSX fixtures, badschema/quotes/enums/path, privateuser/tenant, RLS/FK/immutable, cached/concurrent/expired/late/error states, postmodelSHA drift, no openTX, slowroute. Run `node --test tests/archive-filing.test.mjs tests/slow-response.test.mjs`.

### Task2 existing-popup filing tool
Create apps/web/src/saas/ArchiveFiling.tsx, archive-filing.ts, archive-filing.css, apps/web/tests/archive-filing.test.mjs; modify ArchiveDocuments.tsx + i18n/en.json only (no rightchat/layout changes).
- [x] Write RED helper/export and isolated-browser generation/selection/failure/stale/restore tests.
- [x] Add tool tabs, existingselection linkage, sequentialgenerate/poll/manualretry, savedsourcevalidation, rationale/citations/tags/recommendedpath and TXTcopy/download. Preserve currentcomparison mountedstate in hiddenpanel.
- [x] Run focusedbrowserfiles withARCHIVE_UI_BROWSER_TESTS=1, lint/build, verify878x669 andmobilegeometry retains rightcomposer; originalcomparison stillworks.

### Task3 verify/review/deploy
- [x] Snapshot sources/data/40officefiles before productedits. Independentbuildercheck design, inlinepreflight interfaces/ledger.
- [x] Fullroot tests once afterintegration, lint/build evidence, fresh finalreview; fix importantissues withfocusedRED/GREEN.
- [x] Migration019 limitedruntimegrants, verifiedwebsitePIDrestart; actualuploadedsyntheticfiles+configuredmodel classification, savedIDs/names/sourcequotes/export/reload verified. Preserveoriginalrecords+40officehashes, screenshot.
- [x] Ledger completion and user instructions/limits; noGitcleanup.
