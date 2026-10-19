# Archive Chat Retrieval Implementation Plan
> Agentic workers: executing-plans inline and one final independent review. User already authorized implementation/local deployment; no repeated approval gates.
**Goal:** Zhao can retrieve formal archives and answer with saved, verifiable sources in existing popup.
**Architecture:** explicit archiveSearch scope, private bounded keyword retrieval, grounded response and final source validation; existing messages persistence.
**Tech:** existing Node24/PostgreSQL/React, no migration/dependencies.
**Spec:** docs/superpowers/specs/2026-10-17-archive-chat-design.md

## Constraints
Preserve office animations, all source/record/suggestion/comparison/project data and old conversations; only append archive chat for live acceptance. No GitHEAD: snapshots/noGitmutations/cleanup. Up to32keywords,4sources,32blocks/24000sourcecharacters. OriginalSHA before and after model; no modelinsideTX/fallback. Exact schema/interactions in spec.

## Review focus
1. No relevant private formal source must yield an honest no-evidence reply without model/history fabrication.
2. Cross-user/tenant/draft sources never enter context, even with guessed identities or history text.
3. Source changes during provider call cannot enter saved conversation; lock in deterministic order.
4. Request/model cannot forge archival identity/citation; historical previews retain validated source hashes.
5. Switching scope/busy/tenant/comparison preserves drafts and prevents stale conversation/result display.

### Task1 retrieval + grounded chat API
Create archive/search.mjs and tests/archive-search.test.mjs. Modify workspace-services.mjs and archive/context.mjs. Interfaces: searchArchivedDocuments(db,ctx,{question,history}) → {documents,reference}; buildArchivedContext(search) → existingcontext; revalidateArchivedSearch(db,ctx,search). archiveSearch bool request; returned messages archiveSearch reference and archival citation metadata.
- [x] RED actual migratedupload/archive/chat tests privacy, body retrieval, nohit, bounds/OCR, malicious quotes, mixed modes/source drift/revision.
- [x] Implement bounded SQL/identity checks, nohit deterministic branch, strictgrounding, postmodelchecks and savedscope snapshots.
- [x] Run new + originaldocument/comparison/record API regressions.

### Task2 popup mode and source display
Modify DepartmentChat.tsx, ArchiveSources.tsx, archive-documents.ts and localized CSS (new archive-search.css) + i18n/en.json. Create web/tests/archive-search.test.mjs using existing isolated-harness patterns.
- [x] RED tests modepayload/retainedselection/draft, restoredreference/citation, nohitdisplay, comparison/tenant isolation.
- [x] Compact header checkbox, request scope snapshot, source labels/archive context type, source-keyidentity; preserve original flows and dimensions.
- [x] Actualbrowserregressions, lint/build.

### Task3 review and local acceptance
- [x] Before snapshots, data/40officebaseline, buildercheck, ledger/preflight.
- [x] FullserialAPI/web and scopedbrowser suites; one independent final review and meaningful RED/GREENfixes.
- [x] Restart verifiedwebsitePID, actualarchiveddoc question configuredmodel withcitation and persistence; nohit/modelcount; DBsourcehash/archivepreservation, screenshot.
- [x] Acceptance/userinstructions; leavealluserfiles/Gitstate.
