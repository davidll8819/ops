# 赵雅梦：文档读取与带出处问答

User-approved scope: in the existing Zhao Yameng popup, upload Word/PDF/Excel, ask about actual content and inspect sources. Preserve all office animation files and existing conversations/projects. This implements step one of the approved sequence; document comparison, tagging/numbering, OA and scanned-document OCR are deferred.

## Experience

The existing file-agent conversation receives a compact documents panel. Upload DOCX, text PDF or XLSX (6 MiB/file, existing 100 MiB private workspace quota), or choose an existing supported file. Show uploaded/parsing/ready/failed states with useful failure reasons and retry. Ready files can be selected (up to four); show the selection when sending and retain it for follow-up questions. Uploading a supported file automatically parses and selects it when ready. Preview extracted text and locations inside the same popup; download original through the existing authenticated file route. Existing OCR chat and other agents do not acquire the new upload UI.

Answers based on selected documents contain numbered citations. A citation shows the actual filename, location, and a verbatim source excerpt; expand it in the same popup to inspect the saved extraction. DOCX locations use body paragraph/table-row numbers, never invented page numbers. PDF locations use actual page numbers. XLSX locations use sheet names and cell ranges. Old messages remain readable. Document history records the selected file identities and extraction hashes used at answer time.

## Data and parser boundaries (implementation decisions)

Keep original workspace_files bytes unchanged. Add archive_documents derived records scoped by BOTH tenant and user, FORCE RLS, with source SHA-256, immutable successful extraction, parser version, state/attempt/lease metadata, error text, warnings and located text blocks. No shared company-wide access is introduced. Parsing never executes Office macros/formulas, external relationships or embedded scripts. Use bounded ZIP inspection before Office parsing, reject DTD/entities, corrupted/encrypted/unsupported files clearly; no silent truncation. Limits: 6 MiB source, 30 MiB expanded ZIP, 2,000 entries, 120 PDF pages, 20,000 populated spreadsheet cells, 200,000 extracted characters, 2,000 blocks. Split large locations into blocks of at most 2,000 chars without losing source location. Complex Word layout/header/footer/image text is outside the body-text extractor; disclose limits in the preview. XLSX formulas use saved results and disclose no recalculation.

Use pdfjs-dist for PDF text, ExcelJS for spreadsheets and fast-xml-parser for DOCX body structure. Root verifies/install pinned registry versions. Parsing runs outside database transactions in a bounded worker thread (30 seconds, resource limit, max two simultaneous workers); server remains responsive. Concurrent parse requests reuse an active attempt; successful records are reused. A lease of 90 seconds permits recovery after server restart, and stale workers cannot overwrite newer attempts. Unsupported old .doc/.xls, scanned/empty PDFs and password protected files offer actionable feedback.

## Interfaces

`extractDocument({name,bytes}) -> Promise<{kind:'docx'|'pdf'|'xlsx',blocks:Array<{id:string,location:string,text:string}>,warnings:string[],stats:object}>` in `apps/api/src/archive/extract.mjs`. Deterministic block IDs for one extraction. Errors have safe user-facing message and code. No database/model access in parser.

Archive routes under `/api/tenants/:tenantId/archive/documents`:
- GET root -> `{items:Document[]}` lists supported private workspace files including unparsed ones, no blocks.
- POST `/:fileId/parse` with `{}` -> `{document:Document}`; completes bounded parse or returns existing processing/ready state. Failed attempts may retry.
- GET `/:fileId` -> `{document:Document & {blocks:Block[]}}`; metadata/preview, with stale parsing state recovered.
- Document shape: `{fileId,name,mime,size,createdAt,extractionId:string|null,sha256:string|null,kind:string|null,state:'unparsed'|'processing'|'ready'|'failed',error:string|null,warnings:string[],blockCount:number}`.

Existing department chat POST gains optional `fileIds: UUID[]` (unique, max four), only archive. Reject fileIds for other departments and image+fileIds together. In the initial authorized database scope load selected ready extractions; reject missing/private/unfinished documents before calling a model. With files, append server-built bounded source context and use the configured archive text model. With no files, preserve current conversation/skills behavior.

Retrieval selects up to 24,000 source characters / 32 blocks, balancing files and lexical match (Chinese plus Latin/numeric), including preceding question context for follow-ups. Full short documents fit; larger ones get an explicit partial-coverage notice and no claims of exhaustive absence. Sources are untrusted material, not instructions. Old chat assertions must not replace current file evidence. Never send unselected/private files.

Grounded response contract: JSON `{claims:[{text:string,citations:[{sourceId:string,quote:string}]}],notFound:boolean}`. Each substantive claim requires at least one citation; validate source IDs against supplied snippets and quote as a normalized exact substring, not a model-created filename/location. Reject malformed/uncited/fabricated references with an actionable retry error; never persist such an answer as verified. If notFound=true with no claims, return a fixed honest message that no answer was found in supplied excerpts (not an exhaustive document absence claim). Build numbered text and saved citations server-side. A validated quote establishes traceability, not proof that every model inference is correct.

Persist user `files:[{fileId,name,extractionId,sha256}]` and assistant `citations:[{id:string,fileId,extractionId,sha256,filename,blockId,location,quote}]`, plus optional `documentCoverage` string. Citations numbers are string IDs `1`, `2`, etc. UI treats all model/extracted strings as text; no HTML injection. Use saved citation excerpts for historical evidence; source preview checks matching extraction/hash.

## Acceptance

Real DOCX/PDF/XLSX fixtures upload, parse, answer and reveal the correct paragraph/page/cell. Stored messages survive reload with citations. A real configured-model smoke test uses synthetic company material only. Tests prove fabricated citations rejection, unknown answer behavior, malformed/oversized/encrypted/scanned inputs, same-tenant other-user and other-tenant isolation, duplicate/retry/stale parse handling, and existing chat compatibility. Full suite/lint/build, live popup check, original office-file hashes and preserved prior project data finish the change. No initial Git commit exists in this checkout; preserve file snapshots for review and do not stage unrelated files.
