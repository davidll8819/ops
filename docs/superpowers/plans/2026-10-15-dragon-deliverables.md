# Dragon Deliverables Implementation Plan

> Use subagent-driven-development for independent helper/UI work and verification-before-completion before delivery.

**Goal:** Add playable previews and usable product ZIPs inside Dragon's existing popup.
**Architecture:** Authorized metadata + snapshot creation API, expiring read-only token asset routes with browser isolation, React 成果 tab. Existing DB project remains source of truth.
**Tech stack:** Fastify/PostgreSQL/React, existing yazl, Node24; no new dependencies.
**Spec:** ../specs/2026-10-15-dragon-deliverables-design.md

## Constraints and review focus
- Preserve 40-file office animation baseline; no new standalone app/public publishing.
- No same-origin permission in iframe or CSP; keep main cookies/CSP unchanged.
- Never serve another user's current workspace; tokens serve immutable snapshots and recheck membership.
- Handle HTML with relative/module/binary assets, Unicode paths, stale edits, empty projects and expired previews.
- Download original web bytes plus launcher/instructions without changing user files.

### Core (delegated: deliverable_core)
- [x] Failing tests for web entry detection, token isolation/expiry/capacity/immutability, MIME/path handling and ZIP content.
- [x] Add execution/deliverables.mjs: deliveryFiles(files), listDeliverables(snapshot), createPreviewStore(opts).issue(ctx,snapshot,entry)/lookup(token,path), previewHeaders({origin,token}), async productZip(snapshot,entry).
- [x] Unit tests green; focused independent review.

### API integration (root)
- [x] Write failing authenticated integration tests against actual routes.
- [x] execution.service deliverySnapshot(ctx) reads private name/revision/files/activeRunId/updatedAt without invoking Docker.
- [x] GET workspace/deliverables metadata; POST /deliverables/preview {entry,revision}; GET /deliverables/download?entry&revision. Reject active/stale snapshot selection, preserve auth/CSRF.
- [x] GET /project-preview/:token/* outside cookie gate, validates token+path, scoped tenantAccess before serving bytes and isolated headers; prevent SPA fallback for all preview errors.
- [x] Runtime guidance points completed web projects to 成果, uses relative assets; no new execution privileges.

### UI (delegated: deliverable_ui)
- [x] EmployeeDeliverables.tsx with 成果 nav/optional chat link, title/entry choice/version, 打开试玩/重新加载/停止预览 and 下载成品.
- [x] Sandbox iframe allow-scripts only, no-referrer; teardown on leaving tab. Correct async/stale/error/active editing and expiry states; normal chat draft retained.
- [x] Scoped lint/build/frontend tests; root live CUA validation.

### Delivery verification
- [x] Review security and integration; fix material findings; npm test/build/lint.
- [x] Restart verified local service (no DB migration required); inspect real Gomoku preview, make moves and reset, inspect console and isolated frame behavior.
- [x] Download product ZIP and verify launcher/original HTML/instructions; verify office baseline unchanged.
- [x] Save screenshots and local delivery notes; leave 成果 open for user.

User approved this feature description and asked to start. Routine implementation choices above are builder decisions. Repository has no initial Git base; edits remain scoped in current working tree, with no unrelated files staged/committed.
