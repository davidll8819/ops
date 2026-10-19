# Archive document chat implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Read DOCX/PDF/XLSX and answer with inspectable source excerpts inside Zhao's existing popup.
**Architecture:** Preserve original files, store private bounded extractions, pass selected located snippets to archive chat, validate citation evidence before saving replies. A focused React panel and citation renderer extend the existing conversation.
**Tech Stack:** Node24/Fastify/PostgreSQL/React; pdfjs-dist, ExcelJS, fast-xml-parser, existing yauzl ZIP inspection.
**Spec:** `docs/superpowers/specs/2026-10-15-archive-document-chat-design.md`

## Global Constraints
- No office animation/roster changes; existing popup only. Preserve prior data and no unrelated Git staging.
- Tenant AND user isolation; existing 6 MiB upload and 100 MiB quota.
- Parser/context limits and exact API/message contracts are in the spec and binding across tasks.
- No OCR, OA, archive numbering or version comparison in this increment.

## Review Focus
- Unsupported/encrypted/corrupt documents and oversized archives must fail visibly, not become empty successful documents (task 1).
- References in an old conversation or malicious file may not masquerade as current evidence (task 2).
- Parallel/retried parses must not overwrite immutable successful sources (task 2).
- Switching enterprise/closing/reopening while requests run must not show stale private documents in another context (task 3).
- Long documents/row gaps/sheet names must retain honest locations and coverage (tasks 1/2/3).

### Task 1: bounded located extraction
Files: create `apps/api/src/archive/extract.mjs` and small focused parser modules as needed; `tests/archive-extract.test.mjs`; fixture builder `tests/helpers/archive-fixtures.mjs` shared with task 2 and root. Root owns package dependency installation.
Interface: `extractDocument` and Block exactly as spec. Fixtures export `makeDocx`, `makePdf`, `makeXlsx` (document signatures in helper).
- [x] Write fixtures/tests for all three actual formats: paragraph/table, two PDF pages, noncontiguous cells/multiple sheets and formula cached values. Tests for limits/bad ZIP/DTD/scanned/unsupported.
- [x] Run `node --test tests/archive-extract.test.mjs`, observe expected missing behavior failure.
- [x] Implement bounded in-memory extraction with deterministic locations; no remote relationships or execution; no silent truncation.
- [x] Run focused tests and write evidence to `.local/archive-documents/parser-report.md`.

### Task 2: persistence, routes and sourced conversation
Files: create `database/migrations/016_archive_documents.sql`, `apps/api/src/archive/{worker,parse-worker,store,routes,context}.mjs` (split further only to clarify responsibilities); modify `apps/api/src/app.mjs`, `workspace-services.mjs`; create `tests/archive-documents.test.mjs`, `tests/archive-context.test.mjs`.
Consumes task1 `extractDocument`. Produces document endpoints, extended messages and fileIds schema in spec.
- [x] Write failing real PGlite/API tests: private files, parse/retry/concurrency/stale lease, successful extraction reuse, citation persistence across GET, wrong source/quote rejection before save, unsupported department/images; context tests for short/full vs long/partial, Chinese query and notFound.
- [x] Run focused tests for RED evidence.
- [x] Add additive FORCE-RLS migration, bounded worker parser service and scoped routes. Keep worker/model calls outside DB transactions and compare attempt identity before writes.
- [x] Integrate archive grounding with current chat revision and skill flow; only cited valid claims saved. Retain old OCR/text and Dragon behavior.
- [x] Run focused tests and report to `.local/archive-documents/backend-report.md`.

### Task 3: existing popup UI
Files: create `apps/web/src/saas/ArchiveDocuments.tsx`, `archive-documents.ts`, `archive-documents.css`, optional small source renderer; modify `EmployeeDialog.tsx`, `DepartmentChat.tsx`; `apps/web/tests/archive-documents.test.mjs`.
Consumes exact route/message contract in spec. `EmployeeDialog` opts file-agent into document panel; OCR reuse stays unchanged.
- [x] Test meaningful pure selection/citation/request-state logic for max4, only ready documents, stale context, quote rendering shape/coverage; run RED.
- [x] Implement upload using current `/files` JSON contract then parse, supported file selector, statuses/retry, inline preview with locations, current selection and empty state. Keep controls compact/scrollable.
- [x] Submit selected IDs fixed at request start. Show saved user file names; numbered citation buttons expand quote and source in popup, download original; never raw HTML.
- [x] Run web tests/lint/build and report `.local/archive-documents/ui-report.md`.

### Task 4: verification and local deployment (root)
- [x] Review tasks and address material findings with scoped tests.
- [x] Run full project tests, lint and build; independent final review.
- [x] Snapshot affected existing source and user DB rows; migrate additive table/grants; restart only verified local app process.
- [x] Upload three synthetic real fixture files via authenticated API, invoke configured archive model on their contents, verify accurate answers/citations and reload; bad input/fabricated evidence covered in tests.
- [x] Verify existing Zhao popup in browser, screenshots, original office file hashes and prior Dragon data unchanged; record completion and user steps.
