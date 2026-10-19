# Dragon acceptance and formal delivery

User approved the described acceptance checklist, fixed-version formal delivery, and revision-feedback workflow in the existing employee popup, and additionally requested larger conversation windows for every agent. Office animation must remain unchanged. This document records implementation choices within that approved scope; no extra approval round is needed.

## Product flow

Keep the existing centered, department-colored popup and its navigation. On Dragon's 成果 page, the user saves/selects a version, reviews its playable output, and completes an acceptance panel. Current files show guidance to save a version before acceptance. A saved version is the immutable unit being accepted; never infer its correctness from legacy model summaries or execution logs (they lack snapshot provenance).

The panel has editable manual acceptance items, a genuine server-side deliverable-package check, usage instructions, known limitations, and a delivery name. Initial manual items are 核心功能符合要求, 主要操作与页面显示正常, 使用说明与实际作品一致; all start unchecked. Users can rename/add/remove items (1..20), set unchecked/passed/failed, and record what they actually observed. Passed/failed items require a note. Display source as 用户试玩确认; the package check as 系统文件检查. The system check verifies the selected HTML is in the saved deliverable snapshot and that its static product ZIP can really be assembled; records entry, file count, byte count, SHA-256 of the exact saved files, timestamp and result. Label its limited meaning explicitly: file/package availability, not functional behavior, browser compatibility, or gameplay correctness. No model claims or unrelated old tests turn an item green. No new arbitrary command runner or paid model call is necessary for this stage.

Confirm delivery only after the package check passed, every manual item passed, and label, instructions, limitations are explicitly filled (暂无已知限制 is valid, empty is not). Freeze a copy of all acceptance evidence/docs and reference the immutable version. One formal delivery per version; later current-file changes/restores cannot alter it. Its acceptance becomes read-only; new revisions use another saved version. Official deliveries appear in a compact project-specific list, each with its label/time/version/docs/checklist, fixed-version preview and a dedicated ZIP including 交付说明.txt and 验收记录.json alongside the existing launcher and website files. They remain readable while current work is running. This is local private delivery, not external publishing.

Each formal delivery has a revision-feedback text field and 带入对话继续修改 button. Append the feedback plus delivery/version context to the selected project's existing chat draft and navigate to 对话; preserve any existing draft. No silent model submission or automatic file rollback. The text explicitly tells Dragon to read current files and apply requested changes with the delivered version as reference.

All shared employee popups grow from max920x780 to max1080x840, with desktop viewport gaps32px (16px each side) and existing mobile gaps20/24px retained. Preserve centered layout, scrolling/focus behavior, all department colors and all40 office animation baseline files. Secretary's separate layout remains unchanged unless it uses the shared component.

## Persistence and authorization

New migration014 adds employee_project_acceptance (one row per version; mutable draft with optimistic revision) and employee_project_deliveries (immutable official record). Add composite unique version ownership (id,workspace_id,tenant_id,user_id) and matching FKs on both new tables, FORCE RLS tenant+user. Draft reads do not create rows. Only owner/admin may change their own project acceptance or confirm delivery; reads retain current owned-project policy. No unrelated workspace/chat/run updates in migration. Grant restricted local app role SELECT/INSERT/UPDATE on acceptance and SELECT/INSERT on deliveries during deployment. Delivery UPDATE rejected by DB trigger; expose no deletion routes.

Draft shape: {versionId,revision,entry,items:[{id,title,status,note}],instructions,limitations,systemCheck:null|{status,entry,snapshotSha256,fileCount,packageBytes,checkedAt,detail},delivery:null|Delivery}. Status is unchecked|passed|failed, item IDs are stable UUIDs or initial stable identifiers; server validates unique IDs, title1..160, note<=2000, docs<=8000, entry existing HTML when nonempty. Revision0 denotes absent draft; first save increments to1. A row lock/owned-project lock serializes create/update/check/confirm; exact expected revision required (409 otherwise). Client cannot set source/systemCheck/checkedAt or delivery state. Saving changed entry invalidates systemCheck; other content changes retain exact version-bound check. Confirm locks draft and verifies persisted evidence and version entry, not request claims; reject incomplete/failed/empty/stale/duplicate. After delivery, draft mutations reject409. System check failure persists failed evidence rather than a fabricated pass; source-only versions show no eligible entry and cannot confirm.

Delivery shape: {id,versionId,versionLabel,sourceRevision,label,entry,items,systemCheck,instructions,limitations,createdAt}; source identity is always the saved version ID. File bytes are not duplicated. All requests validate tenant+user+project+version/delivery ownership without default fallback. Delivery ZIP docs reflect frozen values and no secrets; quote user text safely in HTML, plaintext and JSON, use constant safe archive paths (not labels). Reuse preview sandbox, expiry and per-asset authorization.

## API contract

Root: /api/tenants/:tenantId/employees/code-agent/projects/:projectId
- GET /versions/:versionId/acceptance -> {acceptance: Draft} (default unsaved draft if absent; derive default entry from first eligible HTML).
- PUT /versions/:versionId/acceptance {revision,entry,items,instructions,limitations} -> {acceptance: Draft}. Strict body, no user-supplied system evidence.
- POST /versions/:versionId/acceptance/check {revision} -> {acceptance: Draft}; requires a saved draft and valid entry, stores actual package check and increments revision. Structured check failure is evidence; authorization/conflict/invalid selection are normal HTTP errors.
- POST /deliveries {versionId,acceptanceRevision,label} -> {delivery: Delivery}; label1..80.
- GET /deliveries -> {deliveries: Delivery[]} newest first.
- GET /deliveries/:deliveryId -> {delivery: Delivery}.
- POST /deliveries/:deliveryId/preview {} -> existing Preview shape, fixed entry/version from delivery.
- GET /deliveries/:deliveryId/download -> fixed snapshot product ZIP with frozen documentation.

UI uses fresh mount/selection request guards keyed tenant+project+version. Unsaved acceptance edits stay visibly dirty and cannot be silently overwritten by unrelated refresh, check or confirmation; save before check/confirm. Scope feedback to the originating project. Loading or failed reads must not leave a previous version's acceptance usable. Historical preview/download remain independent of current file revision. Existing project/version flows remain intact.

## Verification

Real PGlite API tests: default read does not persist; roles/user/project/tenant/version isolation; strict forged-evidence denial; unchecked/failed/empty/undocumented/stale/duplicate confirmation rejection; real package-check bytes/hash/entry; changed entry invalidates check; frozen delivery cannot update and remains identical after working file/other-version changes; fixed preview and ZIP include exact frozen docs and original HTML; source-only versions cannot deliver. Root observes route404 RED before production implementation. Regression full suite, web lint/build. Live browser: enlarged Dragon and another employee, create/save/check acceptance on an existing sample version, human-confirm what was actually verified, formal delivery, preview/download evidence, append feedback preserving draft, reload/persisted records; original Gomoku/chat/runs and office hashes unchanged. Do not mark the user's Gomoku accepted on their behalf: use clearly labeled 独立项目示例 for live delivery verification.
