---
name: aitoearn-content-pipeline
description: 运营流程技能包，通过运营工作台完成内容自动制作与确认后发布。复用本地 AiToEarn 源码，使用当前企业独立的运行服务与 AI 密钥。
---

# 运营流程 / Operations workflow

Owner: 叶凡 / 运营部. Category: 流程技能包.

Entry points: 技能库下方「运营流程」、办公室中的叶凡、智能体中的叶凡、私人秘书转交。All entry points open the same 运营工作台 modal and use company-wide settings. No separate login or connection form. Secretary handoff carries the brief; execution starts only through the production action once the runtime is ready.

1. Accept the user's brief through the authenticated Office tenant session.
2. Use the original Agent task endpoint, tools and bundled skills to plan prompts and storyboards, generate keyframes and video shots, compose/edit and save materials. Do not substitute a single text-to-video call for the original workflow.
3. Use only the current tenant's model configuration, storage and platform authorizations.
4. When publishing is part of the task and the target account is specified and connected, create a pending proposal through the authenticated Office publishing workflow. Wait for the user to approve the exact content, accounts and schedule before submission. If only a draft or preview was requested, do not publish. Ask for missing account or task details only when necessary.
5. Only publish the exact content, accounts and schedule approved by the user. Keep the stable flow ID, avoid duplicate submissions and never automatically retry an uncertain result.
6. Report task status and platform receipts. Distinguish generation errors, missing configuration, accepted publishing jobs and confirmed publications.

This is a built-in service-backed workflow, not a runnable shell skill. Runtime availability must be checked. Source copied does not mean paid generation or platform publishing has been validated. Some original tools require additional provider credentials; subtitle registration is disabled upstream and must be tested before activation.
