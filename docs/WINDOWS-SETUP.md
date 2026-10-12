# Windows 安装、使用与 Mac 数据迁移

适用版本：2026-10-12 起的 Windows 发布包。代码仓库：<https://github.com/davidll8819/ops>。

## 先看这一页的选择

- **只想在办公室试用**：按第 1–3 节，生成一套新的本地账号和空数据库。
- **要继续使用 Mac 上的聊天、任务成果和模型配置**：先准备第 5 节的私有备份；Windows 解压程序后，**先恢复备份，再首次启动**。GitHub 下载不包含你的私人数据。
- 日常使用只需启动 Docker Desktop，再双击 `Start-Windows.cmd`。首次安装需要联网下载依赖和数据库镜像，不能离线开箱即用。

## 1. 项目地图：这次会在电脑里运行什么

这是给个人和企业团队使用的智能办公室：秘书接收要求，员工按依赖关系执行任务，成果进入资料室。

```text
浏览器 http://localhost:3000
  ↓
Node.js 主程序：网页 + 登录 + 秘书 + 部门任务队列
  ├─ PostgreSQL 17：账号、企业、对话、任务、成果、小附件和已安装技能
  ├─ Redis 7：登录会话、缓存、限流和锁
  ├─ skills/packages：600 项目录对应的 149 个下载归档包（尚未自动安装）
  └─ 你配置的模型 API：文字、图片、搜索等实际模型调用
       运营视频 / 平台发布还需要独立 AiToEarn 服务
```

Node.js（JavaScript 运行环境）负责运行程序。Docker（容器工具）负责统一启动数据库和缓存，省去在 Windows 分别配置它们。PostgreSQL（关系数据库）保存长期数据；Redis（高速缓存）保存登录会话等临时状态。代码、数据库和密钥是三样东西，迁移时要一起考虑。

目录分工：`apps/web` 是网页，`apps/api` 是业务和任务执行，`database` 是数据库结构升级，`skills` 是技能目录/流程/归档包，`scripts` 是启动与维护入口，`integrations/aitoearn/source` 是运营服务原代码，`infra` 是未来 AWS 的 Terraform（基础设施配置）文件。此次本机安装不创建 AWS 资源，不需要 AWS Profile（账户配置）。

## 2. 首次准备（需要你手动操作）

1. 准备受 Docker Desktop 支持的 Windows 64 位系统，建议 Windows 11 x64、16 GB 内存并预留 15 GB 空间。ARM 电脑应核对 Docker 官方支持情况；本项目自动检查针对 Windows x64。系统及虚拟化要求以 [Docker 官方 Windows 安装说明](https://docs.docker.com/desktop/setup/install/windows-install/) 为准。
2. 从 [Node.js 官方下载页](https://nodejs.org/en/download) 安装 **Node.js 24**，保留 npm（依赖安装工具）和加入 PATH（命令搜索路径）的选项。不要直接选择不同的大版本。
3. 安装并打开 Docker Desktop，使用 WSL 2（Windows 的 Linux 子系统）和 **Linux containers（Linux 容器）**。若系统要求启用虚拟化、安装 WSL 或重启，需要你或办公室管理员完成。Docker 的企业使用许可按官方条款处理。
4. 在 [Releases（发布包）](https://github.com/davidll8819/ops/releases) 下载 `wishtaday-windows-20261012.zip`。**不要用页面自动生成的 Source code.zip 代替完整包**，自动源码包不带技能 ZIP。
5. 完整解压到例如 `C:\Work\ops`，确认该层能看到 `Start-Windows.cmd` 与 `package.json`。不要在压缩软件内直接运行，不要放 OneDrive 同步目录。若多套副本使用同一个 Docker 环境，它们会共享 `wishtaday-local` 数据卷；不要同时启动不同副本。
6. 若要迁移旧数据，跳至第 5 节。否则继续下面的新安装。

可在 PowerShell（Windows 命令窗口）检查软件：

```powershell
node --version
npm.cmd --version
docker version
docker compose version
docker info --format '{{.OSType}}'
```

Node 应显示 `v24...`，Docker 最后一项应为 `linux`，并且 `docker version` 能显示服务端信息。如果只有客户端或连接错误，先把 Docker Desktop 启动好。

## 3. 全新安装、每天打开和关闭

1. 双击 `Setup-Windows.cmd`。它会生成随机本地账号与密钥、安装依赖、检查技能包、启动数据库/缓存、创建数据结构、构建网页。现有 `.env` 不覆盖；已有企业与用户不重建。失败时保留窗口，上方会有原因。
2. 安装完成后，在资源管理器打开 `.local\login.txt` 查看账号密码。管理员默认是 `owner@local.test`，密码每次新安装随机生成；此文件不能公开发送。
3. 双击 `Start-Windows.cmd`，就绪后自动打开 <http://localhost:3000/>。没有自动打开时手动输入这个网址。首次直接双击启动也会先安装。
4. **保留启动窗口**。停止时在该窗口按 `Ctrl+C` 并等服务退出，再双击 `Stop-Windows.cmd` 停止数据库和缓存。重新启动后数据仍在。

也可用 PowerShell，路径由你按实际位置填写：

```powershell
Set-Location 'C:\Work\ops'
.\Setup-Windows.cmd
.\Start-Windows.cmd
```

不要运行 `docker compose down -v`，也不要在 Docker Desktop 删除项目数据卷。普通 `stop` 不删数据。应用、数据库和 Redis 默认只监听本机，不必开放公网端口，也不要把本地调试账号用于云端生产。

安装脚本会收紧 `.env` 和 `.local` 的 Windows 访问权限。使用普通的当前 Windows 账号运行即可；换 Windows 账号使用时，需要由原账号/管理员安全移交这两个位置的权限。

## 4. 启动后检查什么、哪些功能仍有限制

- 能登录办公室、切换中英文、打开人物/秘书/设置/资料室。
- 新安装的模型密钥为空。你在设置中填写企业 API Key（模型服务密钥）、读取模型列表，再选择文字、图片、视频、搜索模型。旧数据完整迁移后保留原配置。模型费用由你的服务商收取。
- `node scripts/check-skill-packages.mjs` 应显示 `rows: 600`、`packages: 149`、`missing: []`、`invalid: []`。一个来源 ZIP 可含多个技能，所以不是 600 个 ZIP。包只下载存放，在技能库点安装后才写入企业技能库；安装不等于允许自动执行任意脚本。
- 可以用一条简短的文字任务检查“确认派发 → 执行 → 成果 → 归档”。真实模型调用会产生费用；自动测试不用你的真实密钥。
- 图片生成、模型内置搜索取决于所选模型和中转通道真实支持情况，模型出现在列表中不保证每项能力可用。
- **AiToEarn 的独立运行服务目前尚未接通。** 原源码和主程序适配在包里，但此安装只启动主应用、PostgreSQL、Redis；不会自动部署 AiToEarn 的 MongoDB、队列、对象存储、AI/Server 服务或绑定社交平台。因此视频生成/平台发布还需后续部署验收，不能把“等待运营服务”当成 Windows 安装故障。相关准备见 [主说明](../README.md#aitoearn-运营部接入本地集成阶段)。
- AWS AgentCore、云端登录、实际支付也不属于这次本机安装。语音/屏幕截图依赖浏览器支持及用户授权，建议先用 Edge/Chrome 验收。

自动验证命令（主项目已安装依赖后）：

```powershell
node scripts/windows-local.mjs check
node scripts/check-skill-packages.mjs
npm.cmd test
npm.cmd run lint
npm.cmd run build
```

GitHub 的 Windows/Linux 自动检查测试代码、构建和静态规则；**不等于在你的实体 Windows 电脑上验收了 Docker、浏览器权限或付费模型/视频/发布**。本轮结果见 [Windows 交付记录](WINDOWS-VERIFICATION.md)。

## 5. 把 Mac 上的旧数据带到 Windows

### 5.1 必须一起带走的东西

| 资料 | 用途 | 如何携带 |
| --- | --- | --- |
| `office.dump` | 所有企业、用户、聊天、任务、成果、小附件、已安装技能等 | 从 PostgreSQL 导出 |
| `.env` | 原本地登录校验、数据库密码、文件位置 | 私有备份 |
| `.local/operations-config.key` | 解开数据库里加密的企业模型密钥 | 必须是原来的同一把主密钥 |
| `.local/accounts.json`、`login.txt` | 其他本地账号校验与登录信息 | 私有备份 |
| `.local/operations-runtimes.json` | 企业运营服务绑定 | 私有备份；若以后有独立服务，地址需另行调整 |
| 技能归档包 | 目录点击安装时使用 | 完整 Windows 发布包已包含 |

主密钥是 32 字节随机值的 Base64 编码。**不要重新生成来替代旧密钥**，否则旧数据库中的企业密钥无法解密。保留原企业/用户 ID，不要通过重新注册“同邮箱账号”替代导入。主应用的小附件内容在数据库中，不仅是一个 Mac 文件路径。

这些备份含私人数据和密码，压缩不等于加密。使用加密移动硬盘或受保护的私有传输，不要上传 GitHub、公开网盘或发到聊天。数据库备份与主密钥建议分开保存。Redis 无需迁移，Windows 上重新登录即可。

目前没有已部署的独立 AiToEarn 运行服务；将来若有，它的 MongoDB、媒体对象、任务 session（运行状态文件）和队列还必须另外备份，以下命令不能代替其备份。

### 5.2 Mac 导出：在 Mac 终端执行

先停止主应用，防止备份过程中继续写入和调用模型；保留数据库容器运行。下方示例项目路径是本机当前路径，若你移动了目录请修改。

```bash
cd /Users/apple/Documents/ChatGPT/opc
node scripts/local-process.mjs stop
```

确认应用已停，再执行整个块；完成后会打印备份目录，不打印任何密钥：

```bash
(
  set -e
  umask 077
  export_dir="$HOME/Desktop/office-transfer-$(date +%Y%m%d-%H%M%S)"
  mkdir -p "$export_dir"
  docker compose -p wishtaday-local exec -T postgres pg_dump -U office_admin -d office --format=custom --no-owner --no-acl --file=/tmp/office-transfer.dump
  docker compose -p wishtaday-local cp postgres:/tmp/office-transfer.dump "$export_dir/office.dump"
  COPYFILE_DISABLE=1 tar -czf "$export_dir/office-private-files.tgz" .env .local/operations-config.key .local/accounts.json .local/operations-runtimes.json .local/login.txt
  (cd "$export_dir" && shasum -a256 office.dump office-private-files.tgz > SHA256SUMS.txt)
  docker compose -p wishtaday-local exec -T postgres rm /tmp/office-transfer.dump
  echo "备份完成：$export_dir"
)
```

导出前确保任务已完成或手动停止；尚在队列里的任务会随数据库迁移，Windows 启动后可能恢复执行并产生模型费用。切换使用后不要同时让两台机器执行同一份待办。此说明没有自动停止或导出你当前 Mac 上的数据。

### 5.3 Windows 导入：首次启动之前执行

先安装第 2 节的软件、解压完整程序，将私有备份放到受保护目录，例如 `D:\Private\office-transfer`。在 PowerShell 执行。修改以下两处路径，逐段运行；任何一段报错立即停止。

```powershell
Set-Location 'C:\Work\ops'
$backupDir = 'D:\Private\office-transfer'
Get-FileHash "$backupDir\office.dump" -Algorithm SHA256
Get-FileHash "$backupDir\office-private-files.tgz" -Algorithm SHA256
Get-Content "$backupDir\SHA256SUMS.txt"
```

手动核对两个哈希值与清单一致；然后恢复配置。若已经启动过新安装，下面会拒绝覆盖配置；不要删文件强行继续，先备份并由维护者处理已有数据库。

```powershell
if ((Test-Path '.env') -or (Test-Path '.local')) { throw '已有本机配置。请先备份并核对，不要覆盖。' }
tar -xzf "$backupDir\office-private-files.tgz" -C .
if ($LASTEXITCODE -ne 0) { throw '私有文件恢复失败' }
docker compose -p wishtaday-local up -d --wait
if ($LASTEXITCODE -ne 0) { throw '数据库启动失败' }
```

只向空数据库导入。如果发现已有表，停止操作，不能删除数据卷来跳过检查：

```powershell
$tableCount = docker compose -p wishtaday-local exec -T postgres psql -U office_admin -d office -Atc "SELECT count(*) FROM information_schema.tables WHERE table_schema='public'"
if ($LASTEXITCODE -ne 0 -or "$tableCount".Trim() -ne '0') { throw '目标数据库不是空库或检查失败，停止导入。' }
docker compose -p wishtaday-local cp "$backupDir\office.dump" postgres:/tmp/office-transfer.dump
if ($LASTEXITCODE -ne 0) { throw '复制数据库备份失败' }
docker compose -p wishtaday-local exec -T postgres pg_restore -U office_admin -d office --no-owner --no-acl --single-transaction --exit-on-error /tmp/office-transfer.dump
if ($LASTEXITCODE -ne 0) { throw '数据库恢复失败，不要启动应用' }
docker compose -p wishtaday-local exec -T postgres rm /tmp/office-transfer.dump
```

使用容器内 `pg_dump/pg_restore` 可保持 PostgreSQL 17 版本一致；不要用 PowerShell 的 `>` / `Get-Content` 管道搬运二进制 dump。恢复时忽略原所有者和授权，下一步由安装脚本重建受限应用角色和授权。

收紧私有文件权限，然后运行安装入口。安装会识别已有用户、执行缺失迁移并保留原身份；若 `LOCAL_EMAIL` 与数据库不匹配会停止。

```powershell
$identity = whoami
icacls .env /inheritance:r /grant:r "${identity}:F"
if ($LASTEXITCODE -ne 0) { throw '配置权限设置失败' }
icacls .local /inheritance:r /grant:r "${identity}:(OI)(CI)F"
if ($LASTEXITCODE -ne 0) { throw '密钥目录权限设置失败' }
.\Setup-Windows.cmd
```

看到安装完成后，双击 `Start-Windows.cmd`，使用原 `.local/login.txt` 的账号密码。先检查企业切换、历史对话、原任务成果预览/下载、模型设置的已配置状态。不要把 API Key 复制到日志来“证明迁移成功”。若未来运行服务使用了 Mac 的地址或绝对路径，应按实际 Windows 服务位置更新绑定；本次默认本地配置使用相对路径。

## 6. 排错和升级

| 现象 | 处理 |
| --- | --- |
| 找不到 node/npm | 安装官方 Node.js 24（带 npm），重新开窗口；PowerShell 用 `npm.cmd`，无需改执行策略 |
| Docker 无法连接 / 不是 linux | 打开 Docker Desktop，等引擎就绪，切换 Linux 容器；检查 WSL/虚拟化 |
| npm 或镜像下载失败 | 检查办公室网络/代理，处理后重跑 Setup；不要删除数据库，不要关闭 TLS 校验 |
| 3000 已占用 | 先访问已有办公室；需要重装时在原启动窗口 Ctrl+C；不要结束不认识的程序 |
| 55432/56379 冲突 | 检查是否已有另一套项目/数据库，不要盲目删容器或改 `.env` 单边端口 |
| 数据库密码不匹配 | 新 `.env` 对上了旧卷；恢复该卷原配置，不能只改 Compose 密码期待改掉数据库密码 |
| 解密失败/密钥缺失 | 核对原主密钥文件、企业 ID 和 `.env`；不要点重置或生成新主密钥 |
| 技能显示存在但缺少安装包 | 使用完整 Release 包，重跑技能校验；GitHub 自动源码 ZIP 不含这些归档 |
| 页面连接拒绝 | 保留 Start 窗口查看错误；用下方健康检查，不要只看容器绿色 |
| 运营等待/独立服务未部署 | 属于尚未完成的 AiToEarn 接入，不是重装 Windows 能解决的问题 |

```powershell
docker compose -p wishtaday-local ps
Invoke-RestMethod 'http://localhost:3000/health/ready'
```

升级前先停止应用并备份数据库和私有文件。解压新版代码覆盖程序文件时保留 `.env`、`.local`、技能归档和 Docker 数据卷，然后重跑 `Setup-Windows.cmd`。如用 Git（版本管理工具），先保存自己的代码修改再拉取；安装包不包含你电脑的运行依赖，升级后重新安装/构建是正常的。

主应用采用官方预编译平台依赖（如 rolldown、lightningcss）；正常 Windows x64 安装无需手工装 Python/MSVC。Mac 的 `node_modules` 不能拷过去复用。若另行开发原 AiToEarn 服务，其独立依赖和媒体工具另按原项目要求部署。

`.command` 是 Mac 入口；`.sh` 中的云端发布等 Bash（命令解释器）脚本不属于本次 Windows 日常运行路径。未来 Terraform 上云单独验收，当前无需改用云端模式。

## 7. 需要你手动提供/决定的只有这些

1. 安装系统软件、按公司策略启用 WSL/虚拟化，以及安装路径。
2. 选全新试用，还是带走旧数据；后者提供私有备份并核对哈希。
3. 用本机生成/迁移的密码登录；全新企业需在设置里填写自己的模型密钥和模型选择。
4. 将来接通运营发布时，再提供企业自己的平台授权及独立服务部署配置。这次不要求上传任何密钥到 GitHub。
