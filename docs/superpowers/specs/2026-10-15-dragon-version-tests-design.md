# 龙傲天：保存版本的交付前自动测试

用户已批准一键真实测试、结果与保存版本绑定、失败反馈到对话、先跑通五子棋，沿用现有员工弹窗，不修改办公室动画。本文记录范围内的实现选择，直接实施。

## 使用方式和证据
龙傲天的成果页选择保存版本后，验收区域增加独立的“自动测试”。点击“运行此版本测试”在现有隔离 Docker 环境运行该版本内的 Node.js 测试，不运行当前工作文件，不调用收费模型，不把测试产生的文件写回项目。首版固定识别 *.test.mjs / *.test.js / *.test.cjs 和 *.spec.* 三种 JS 扩展，排除隐藏目录、node_modules；固定 Node 测试命令，无自定义 shell 或联网安装入口。

显示版本名称、测试时间、状态、用例名称与通过/失败结果、总数/跳过/待办、真实退出码；命令、文件摘要、stdout/stderr 放在展开详情。明确“只证明本版本已有测试用例的结果，不替代人工试玩或浏览器兼容性测试”。没有测试文件或零用例不能算通过；跳过/待办、超时、丢失摘要、日志截断或执行中断均不能算全部通过。失败或无测试时可将版本信息和错误带入当前项目对话草稿，保留原草稿，由用户发送，不自动修改或回滚项目。

测试与人工验收独立；运行测试不修改人工草稿修订或结论。所有新正式交付必须同时满足最新自动测试通过、现有打包检查通过和全部人工验收条件。确认提交必须明确携带看到的 testRunId；有更新/运行中的测试或不匹配的 ID 时拒绝。正式交付冻结完整自动测试证据，交付说明和验收记录 JSON 包含它；此前已交付的版本保持原样，标记无自动测试记录，不追溯编造。

## 执行与数据
复用 driver 的资源限制与无网络环境。新增只读镜像内 trusted Node test reporter，从 node:test 事件和最终全局 test:summary 得到结构化结果；普通测试 console 输出只作为日志，不能被当成计数。保留真实 Node 子进程退出码。driver.test({files,testFiles,timeoutMs:60000}) 内部构造固定命令，参数安全引用；不依赖项目提供 reporter。镜像更新需真实构建和容器验证。

新表 employee_project_test_runs，复合 FK 绑定 version/workspace/tenant/user，FORCE RLS。记录不可变版本 SHA256、测试文件、命令、运行环境、状态、结果、开始/结束/租约时间。终态禁止 UPDATE。请求 requestId 在项目内幂等，相同请求只执行一次；若相同 ID 指向不同版本拒绝。项目锁保护开始/交付确认，每个项目至多一个 running 测试，最多100条测试记录/版本；列表返回最新20条。运行不占有长事务：提交 running 后才执行 Docker，最后短事务写结果。120秒租约过期归为 interrupted，不自动重跑。执行前和结束时重查用户权限，权限撤销不能记为通过。

新交付 automated_test JSONB nullable 以兼容旧记录，保存完整终态结果。既有工作区、版本、对话和执行记录无需迁移或改写。snapshotSha256 与现有文件检查共用同一算法。任何客户端计数、命令或通过证据均不接受。

## API 和类型
项目根 `/api/tenants/:tenantId/employees/code-agent/projects/:projectId`。
- GET `/versions/:versionId/acceptance/tests` -> `{testRuns: TestRun[], latestTest: TestRun|null}`，默认无记录且不创建。
- POST 同路径 `{requestId:uuid}` -> `{testRun: TestRun}`，同步等待本次运行，重试可返回既有 running/终态。仅 owner/admin 可开始；历史记录按现有本人项目授权读取。
- GET acceptance 在现有 Draft 增加 `latestTest` 与 `testRuns`；其他草稿写入响应也保持这些字段。
- POST deliveries 现有字段增加必填 `testRunId:uuid`；Delivery 增加 `automatedTest: TestRun|null`。

TestRun 字段：`id,requestId,versionId,versionLabel,sourceRevision,snapshotSha256,testFiles:string[],command,environment,state,counts,cases,exitCode,stdout,stderr,timedOut,truncated,detail,startedAt,finishedAt`。state 为 running|passed|failed|no_tests|timed_out|interrupted|error|incomplete。counts 为 null 或 `{tests,passed,failed,cancelled,skipped,todo}` 非负整数。cases 为 `{name,status:'passed'|'failed'|'skipped'|'todo',detail}` 数组；有限截断不能伪称完整。超时60秒，详情和日志截断显示明确，不接受截断证据作为通过。

## 五子棋和验证
现有五子棋 index.html 是完整内联脚本，现有测试仅加法示例。新增 test/gomoku.test.mjs 使用 Node VM 执行原 HTML 中的真实脚本，轻量 DOM/canvas 接口仅提供环境；通过注册的点击和重开事件验证黑方先手、交替落子、拒绝重复/越界、四方向连五、非连五/不同颜色不误判、胜后停止、重开。明确这是逻辑测试，不冒充真实浏览器自动化。用临时故障变体证明测试会失败；只把正常用例加入当前五子棋工作区并保存新版本，原有四个文件和旧保存版本字节不变，不代用户确认人工验收。

自动测试包含真实 API+PGlite 的授权、幂等、并发、版本隔离、无测试、异常、过期恢复、伪造拒绝、交付冻结，以及 Node reporter/真实 Docker。最终本机浏览器运行选定新版本、检查结果刷新持久化和草稿反馈；检查办公室40个基线文件不变。
