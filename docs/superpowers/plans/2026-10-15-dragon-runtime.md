# Dragon execution workspace implementation plan

> **For agentic workers:** Use test-driven development for each implementation task and verification-before-completion before delivery.

**Goal:** Give Dragon real isolated file/code/test execution in the current employee popup.

**Architecture:** DB project snapshots and durable execution journal; ephemeral constrained Docker worker; runtime-aware model tool loop; existing employee dialog renders project state.

**Tech stack:** Fastify/PostgreSQL/React, Node 24/Python 3 Docker image, existing gateway and skills.

**Spec:** ../specs/2026-10-15-dragon-runtime-design.md

## Global constraints
- No office scene, roster, animation asset or interaction changes.
- Never execute model commands in the host shell; Docker must be available and prebuilt.
- No app secrets, source mounts, Docker socket, network or root user in worker.
- Only owner/admin may execute; each tool rechecks permission and active claim.
- Existing ordinary chats and non-dev department tasks remain intact.

## Review focus
- Duplicate/stale requests must not execute commands twice.
- Model failure after file change preserves project and execution journal.
- Interrupted work is visible and never silently replayed.
- Paths/symlinks, oversized snapshots, timed-out descendants cannot escape limits.
- Runtime unavailable is actionable and does not enable a host fallback.

### 1. Isolated command driver (delegated)
- [x] Write and run failing tests for snapshot/path validation and command result collection.
- [x] Add apps/execution Dockerfile, runner.mjs and reusable files.mjs; API execution/docker.mjs.
- [x] Driver interface: createDockerExecution({env}).status() => {available,reason,environment}; .execute({files,command,timeoutMs}) => {files?,exitCode,stdout,stderr,timedOut,truncated,snapshotError?}. files are [{path,contentBase64}]. No DB/UI dependencies.
- [x] Build image wishtaday-execution:local; exercise real Node/Python, failing command, timeout and isolation.

### 2. Project journal and tool orchestration (root)
- [x] Migration for private employee_workspaces and employee_runs, RLS scoped to tenant/user.
- [x] New execution/service.mjs and routes.mjs, app.mjs integration; claim before tool execution and journal each tool.
- [x] Extend skill-runtime.mjs to run extra tools, bounded execution loop and runtime-specific guidance.
- [x] Dept dev/chat accepts execute:true, dispatches project runner; saves pending and final transcript with run ID. Ordinary chat blocked while project run active.
- [x] Regression tests for roles, tenant isolation, stale requests, model failure after write, download and tool results.

### 3. Existing popup project UI (delegated)
- [x] Add EmployeeProject.tsx and integrate a project tab for code-agent only; preserve existing popup/theme.
- [x] GET /employees/code-agent/workspace => {workspace:null|{id,name,revision,files:[{path,size}],activeRunId,updatedAt},runtime:{available,reason,environment},runs:[{id,state,summary,createdAt,finishedAt,steps:[{id,tool,summary,status,result}]}]}.
- [x] POST same path {} creates project; GET /workspace/file?path= => {path,content,size}; GET /workspace/download => zip. Read-only UI plus create, refresh, view, download; no raw host path input.
- [x] DepartmentChat execution toggle sends execute:true only for Dragon with ready project and canEdit; refreshes project after response, displays persisted run result/tool evidence. Use callback/props to coordinate project status and refresh; API chat remains {messages,revision} with message.runId.
- [x] UI displays current limits/capability plainly, preserves normal chat when execution disabled/unavailable.

### 4. Verification and local activation
- [x] Independent review + fix material findings; npm test/build/lint.
- [x] Migrate local DB, build image, restart verified service process, create user's project via UI.
- [x] Real model verification: write files, run tests, fix failure and confirm files/logs/download.
- [x] Compare office baseline hashes, save screenshot and delivery notes.

Workspace has no initial Git commit, so no usable base for linked worktree. Changes stay in the existing project with scoped file ownership; no unrelated files staged.
