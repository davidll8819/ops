# Employee skills implementation plan

> **For agentic workers:** Use executing-plans to implement this plan task by task.

**Goal:** Manage skills inside each existing employee popup and install the official Superpowers suite for 龙傲天.

**Architecture:** Keep the existing tenant-scoped department assignments. Add employee-oriented reads and revision-checked writes. Ship a pinned, hash-checked official bundle; expose its documents through a bounded, read-only model tool in department chat and text tasks.

**Tech stack:** Fastify, PostgreSQL, React, existing model gateway, yauzl/yazl.

**Spec:** User-approved next increment: complete skill binding and install Superpowers inside 龙傲天; preserve all office animations and existing employee colors/popups. Code execution environments remain the subsequent increment.

## Global constraints

- No scene/store/public animation or roster changes.
- Tenant and role enforcement; at most 8 bound packages per department.
- Keep official skill documents intact and retain MIT license, source commit and package hashes.
- Do not execute imported hooks/scripts; only retrieve bound package documents.
- Do not claim filesystem, terminal, subagent or browser actions without connected tools.

## Review focus

- Foreign tenant IDs and member mutations must fail without changing assignments.
- Stale editor writes must not overwrite another admin's bindings.
- Installing twice must not duplicate the package or erase existing bindings.
- Tool requests must not access unbound files, paths on disk or arbitrary URLs.
- Tool loops and document output must be bounded; disabled skills stop applying on the next request.

### 1. Binding and official package

- [x] Add failing integration coverage for employee GET/PUT skills, role/tenant/stale checks and idempotent Superpowers install.
- [x] Implement employee-skills.mjs and superpowers.mjs; register routes in app.mjs. Add pinned artifact in skills/bundles.
- [x] Run integration tests, inspect stored assignments and package integrity.

### 2. Readable skill runtime

- [x] Add failing tests for skill document loading, forbidden reads, full retrieval and bounded tool rounds.
- [x] Implement skill-runtime.mjs: loadAssignedSkills(db,tenantId,department) and runWithSkills({call,skills,...request}); retain normal skill compatibility.
- [x] Wire department chat and generic department text tasks; persist actual loaded skill references in chat output.
- [x] Verify tool result contents reach the next model request and unbinding removes them.

### 3. Employee popup and delivery

- [x] Add EmployeeSkills.tsx with select/save, revision reload, source/version and Superpowers installation.
- [x] Verify in the real browser; preserve centered popup and employee colors.
- [x] Run npm test, npm run build, npm run lint and independent code review.
- [x] Restart local service, install and bind in the user's tenant; run one real model check.
- [x] Compare office baseline file hashes and report capabilities and remaining execution-tool limitations.

No Git commit: this workspace has no initial commit and contains unrelated untracked work.

