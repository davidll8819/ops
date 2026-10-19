# Archive OCR Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Zhao reads scanned PDFs and raster images and answers with persistent, inspectable OCR sources in the existing popup.
**Architecture:** Local bounded OCR inside disposable parser processes, immutable private extraction storage with progress, existing grounded text chat and citation verification, compact popup extensions.
**Tech Stack:** Node24/Fastify/PostgreSQL/React, PDF.js, @napi-rs/canvas, Tesseract.js and bundled Chinese/English language packages.
**Spec:** docs/superpowers/specs/2026-10-17-archive-ocr-design.md

## Global Constraints
- Existing Zhao popup only; office animations and other employee features unchanged. Preserve prior source bytes, ready extractions, conversations and Dragon data.
- Source6MiB; selected4; images12million pixels/12,000per side; render5million/3,000per side; PDF120pages/OCR10pages/50million total rasterpixels; chars200,000,blocks2,000,blockchars2,000.
- Offline OCR chi_sim+eng; no runtime downloads or model/provider changes. Text answering retains configured archive model.
- Max2 parser child processes; ordinary timeout30s, PDF/image300s; leases90/360s. Private tenant AND user; attempt fencing and successful extraction immutability.
- No Git HEAD: snapshots/reports under .local/archive-ocr; no commits/staging or deletion of prior evidence. Root owns dependencies, live deployment and full regression.

## Review Focus
- A scan with a text header must not silently become a header-only answer (Task1).
- A terminated OCR parser must not leave nested workers or capacity occupied (Task2).
- A new file's long parse must be discoverable/pollable before POST finishes (Task3).
- Late progress must not change a ready result or another attempt (Task2).
- Saved OCR excerpts must retain quality caveat and original identity after reload or deselection (Tasks2/3).

### Task 1: local OCR extraction
Own apps/api/src/archive/extract.mjs; create archive/ocr.mjs and archive/raster.mjs as focused helpers; tests/archive-ocr-extract.test.mjs, tests/helpers/archive-ocr-fixtures.mjs and small fixture PNGs under tests/fixtures/archive-ocr. Update only prior scanner test in archive-extract.test.mjs. Root installs dependencies.
Interface: implement spec extractDocument/onProgress/result contracts. Reuse current collector/Office parser; no DB/gateway/HTTP calls. Runtime resources resolve from installed production packages, no network.
- [x] Write RED actual PNG/JPEG/WebP and embedded scan/mixed PDF fixtures with deterministic page text, Chinese/English, header+scan. Add malformed/headerpixel/animated/empty/limits and OCR error/lowconfidence assertions; real OCR smoke, bounded injected recognizer seam only for otherwise costly limits/failures.
- [x] Implement signature/pixel checks, safe sequential rendering, automatic scan detection including dominant images, reusable local OCR worker/finally termination, page-specific locations/method/stats/cautions and Unicode-safe collection.
- [x] Run `node --test tests/archive-extract.test.mjs tests/archive-ocr-extract.test.mjs`; record RED/GREEN and fixtures/API details in .local/archive-ocr/task-1-report.md.

### Task 2: process lifecycle, private persistence and grounded OCR
Own archive/worker.mjs,parse-worker.mjs,store.mjs,routes.mjs,context.mjs,workspace-services.mjs,app.mjs,slow-response.mjs; create database/migrations/017_archive_ocr.sql, tests/archive-ocr-documents.test.mjs; extend archive-documents/context and slow-response tests only where behavior changes. No parser/UI ownership.
Consumes Task1 extractDocument; produces spec Document.progress/ocr, block and saved citation metadata. Parser function `(input,{onProgress?}={})` and close() contract in spec. Keep existing test injections compatible.
- [x] Write RED process timeout/capacity/childcleanup, progressdurability/latefencing, kindmigration/oldfailedretry/readyimmutability and private sourcedimage/PDF API tests. Preserve existingdocumenttests; use real migratedPGlite and actualprocesses, syntheticmodel transport only.
- [x] Replace workerthread isolation with Node fork+advancedserialization and windowsHide, safe boundedmessageprotocol, errors, deadlines, finallykill/awaitexit and close. Persist orderedprogressoutside DBtransactions, completionafterprogressflush, leases andparserVersion. Addparseheartbeatroute. Preserve originals andscope.
- [x] Pass OCR caution to groundedmodel and save server-owned method/page citations and coverage, keep quote/source checks unchanged; update archivecapability guidance. No gateway changes.
- [x] Run focusedtests and report .local/archive-ocr/task-2-report.md with RED/GREEN and exactintegrationcontract.

### Task 3: existing popup OCR experience
Own ArchiveDocuments.tsx,archive-documents.ts,ArchiveSources.tsx,archive-documents.css,i18n/en.json and apps/web/tests/archive-documents.test.mjs. No global modal/office changes.
Consumes spec Document.progress/ocr and OCR block/citation optionalmethod/page. All newimageURLs useexisting private files/:id/preview onlyaftervalidatedreadyfile/sourceidentity. OriginalPDFdownloadunchanged.
- [x] Write RED uploadimageaccept/MIME, newpendinguploadvisibleandprogresspollingbeforePOSTresolves, retry/oldreadyhint, cautiousOCRsource and verifiedimagepreview/no mismatchedpreview; retain selected4/stalecontexts/layout878x669 tests.
- [x] Extend uploadformats and text, preservecollapse/selection, ensurelocalbusyfile polling whileparsePOSTawaits, renderstage/currentpage andOCRcaution, imagepreviewwithboundedsize; plaintextonly.
- [x] Run portable and `ARCHIVE_UI_BROWSER_TESTS=1` focusedbrowser tests, web lint/build. Report .local/archive-ocr/task-3-report.md.

### Task 4: root verification and local delivery
- [x] Snapshot all touchedsourcepaths and existing DBrecords, checkofficehashbaseline; install pinnedproductiondependencies and audit.
- [x] Task-scopedreviews, scopedfixloops, fullregression/lint/build and one finalintegratedreview.
- [x] Apply additivemigration onlocalPG, restartonlyverifiedapp, healthcheck; upload synthetic scannedPDF+image throughactualpopup and ask configuredmodel, inspect actualsourceandreloadsavedanswer.
- [x] Check originals/oldconversations/Dragonrecords/40officehashes; savefinalscreenshot, markledgercomplete and explainlimits/use.

