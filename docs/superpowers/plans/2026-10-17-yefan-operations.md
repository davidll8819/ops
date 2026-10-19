# 叶凡运营闭环 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** 将叶凡的策划对话接入现有运营工作台并完善制作跟进。
**Architecture:** 私有不可变 brief 保存对话来源；direct submission 预留防重复；现有网关和运行服务继续负责模型和生成。
**Tech Stack:** React/TypeScript, Fastify, PostgreSQL, Node test, Edge.
**Spec:** docs/superpowers/specs/2026-10-17-yefan-operations-design.md

## Global Constraints
- 不修改办公室动画/资源；现有弹窗，叶凡黄色。
- 不暴露密钥，不自动发布，不静默截断原始方案。
- 无 Git HEAD；保存文件快照，不提交或清理已有工作。

## Review Focus
- 旧对话回复的交接应保留该回复之前的要求，而非后来消息。
- 两个并发相同 requestId 最多一次付费生成。
- 断流和 HTTP 错误都不能自动变成新付费请求。
- 快速换交接/任务/租户不应恢复旧异步响应。
- 真实状态未完成时不能用连接结束宣布完成。

### Task 1: 私有交接快照与叶凡能力
Files: migration021, operations/briefs.mjs, routes.mjs, registry.mjs; tests/operations-briefs.test.mjs.
Interfaces: POST /operations/briefs {messageId,revision} => {brief:{id,title,text,messages,sourceMessageId,sourceRevision,createdAt}}; GET /briefs/:id 同结构。限制200000字；title来源于本轮用户要求。readBrief(db,ctx,id)。
- [x] RED：准确历史窗口、复用、版本冲突、跨用户/企业404、角色、超限、无模型二次调用。
- [x] GREEN：不可变RLS表、受信对话快照、专用策划提示。
- [x] Run focused tests and save snapshots.

### Task 2: 制作提交与恢复
Files: migration021, operations/submissions.mjs, task-service.mjs, routes.mjs; tests/operations-submissions.test.mjs.
Interfaces: tasks POST accepts optional briefId/requestId(uuid); requestId supplied for workbench direct tasks; GET /submissions/:id => {submission:{requestId,state,runtimeTaskId}}. briefId incompatible secretaryTaskId. Legacy background calls remain unchanged.
- [x] RED：并发重复只调用一次，输入不符409、未知不再调用、错误/断流记录unknown、私有状态、方案原文进入prompt。
- [x] GREEN：执行前预留；记录SSE taskId；成功连接结束为submitted或uncertain；不根据模型文字判完成。
- [x] Run focused backend tests and existing handoff/security/media tests.

### Task 3: 对话模板、交接、制作状态与成果
Files: DepartmentChat.tsx, EmployeeDialog.tsx, AgentWorkspace.tsx, Workspace.tsx, operations/OperationsWorkspace.tsx, operations.css; apps/web/tests/operations-workspace.test.mjs.
Interfaces: openOperations(brief?:string,task?:Task,savedBrief?:OperationsBrief); optional DepartmentChat onOperations(brief). Workbench keyed base. Handoff brief plus provenance remains until new task.
- [x] RED：模板保留编辑、点击助手交接、未点开始不制作、显示来源/预览、EOF后查询真实状态、断流锁住重复、迟到响应隔离。
- [x] GREEN：手动开始、source快照、状态查询与恢复、有界SSE刷新、媒体预览、更大输入。
- [x] Run actual Edge UI suite; lint/build and full relevant regressions.

### Task 4: 本机验收与审阅
- [x] Fresh final review; fix important findings once with RED/GREEN.
- [x] Migrate, restart only verified local API PID; actual model chat -> saved handoff -> workbench; check live runtime status honestly.
- [x] Verify old data and office hashes; screenshot in existing popup; write acceptance results.
