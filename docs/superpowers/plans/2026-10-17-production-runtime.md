# 叶凡本机制作用环境 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans inline, test fixes before implementation.

**Goal:** 本机独立服务真实生成图片和短视频并在现有运营弹窗展示。
**Architecture:** 集成AiToEarn源码两服务 + 专用Mongo/Redis/S3本机存储，经Office bridge v4和统一模型网关接入。
**Tech Stack:** Node24, pnpm10.33, NestJS, Docker, MongoDB, Redis, S3.
**Spec:** docs/superpowers/specs/2026-10-17-production-runtime-design.md

## Global Constraints
- 不修改办公室动画及原数据，不打印密钥，所有主机端口只绑定127.0.0.1。
- 企业模型选择保留；任何付费请求结果未知时只查原任务，不自动重发。
- 本次仅生成预览，不发布；无Git HEAD，不清理现有工作。

## Review Focus
- Node/Nx输出路径与生产启动脚本必须一致。
- 密钥不会出现在日志/镜像/前端；模型API继续经过统一网关。
- 任务轮询、媒体地址和本机S3可跨容器/Windows访问。
- SSE连接关闭不误报成功；未知提交不会重复生成。
- 原有办公室动画/数据库与程序部执行环境保持不变。

### Task1: 可重复的本机部署
- [x] 保存原数据/动画/配置快照；固定锁文件安装并构建AI与server。
- [x] 专用Docker基础设施、私有配置、运行用户、服务启动/停止脚本；实际签名握手通过。
### Task2: 模型与媒体实测
- [x] 读取企业模型能力；真实图片生成和最短视频预览，记录唯一任务编号。
- [x] 如遇适配/启动缺陷，先复现并测试，再修复；成品写入真实任务结果，可在原弹窗预览。
### Task3: 验证与交付
- [x] 专项回归及一次独立最终审阅，重要修复测试RED/GREEN。
- [x] 验证真实视频字节、时长和尺寸，现有弹窗截图，原数据与动画哈希一致；本机服务保持运行。

交付记录：`docs/operations-local-runtime.md`。原弹窗内图片和视频均真实预览成功。视频实际横屏1920×1080，服务商未遵循竖屏参数；如实记录。追加图片测试成功后停止，无第二次视频生成。
