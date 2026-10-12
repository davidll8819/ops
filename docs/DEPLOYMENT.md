# 本地调试与未来 AWS 部署

## 2026-10-11 部署进度

用户已授权使用 AWS CLI profile `0511`，业务部署香港 `ap-east-1`，网站 `wishtaday.com`，通过 Terraform 更新 DNS；已确认保留本机数据和已授权的办公室动画。AgentCore 暂不启用，后续只能选 `us-west-2` 或 `us-east-2`；现有员工继续使用企业自带模型入口。

已验证账户连接、香港区域已启用、域名 Route53 托管与公网 NS 一致，托管区没有旧网站记录。已 apply `infra/bootstrap`，创建私有、加密、版本化的状态桶并初始化远程状态。业务基础设施目前只生成过计划，尚未 apply；部署规模仍等用户选择，网站 DNS 未切换。实际参数、计划和日志位于被 Git 忽略的 `infra/terraform/production.tfvars`、`infra/terraform/backend.hcl`、`.local/deploy-20261011/`。**规模选择后重新生成计划，不直接复用此前的 prepare.tfplan。**

本机 ARM64 镜像 `wishtaday:20261011-cloud` 构建成功，并在隔离的 PostgreSQL/Redis、生产环境及只读文件系统下启动成功：`/health/ready` 返回200，未登录 `/api/me` 返回401。未推送ECR，未创建Cognito用户，未调用AgentCore。模型慢请求已增加协商式心跳，CloudFront透传Accept；业务错误仍返回真实错误，断连不自动重新调用收费模型。

数据准备：`.local/backups/before-cloud-20261011.dump` 为受保护的本机备份；实际SQL快照在隔离数据库恢复演练通过，23表108行完整恢复，4份资料文件、3个已安装技能包逐字节一致。正式迁移前应检查并排空本机任务，再生成最终快照；当前演练快照不是最终云端数据。管理员身份需显式映射到正式Cognito subject，保留用户ID及关联数据，其他本地测试身份锁定保留。

生产配置增加：`enable_agentcore`（可选AWS助手）、`high_availability`（数据库与缓存备用节点）、`data_import_object_arn`（仅迁移角色能读的精确S3对象）。企业加密主密钥由ECS读取独立Secrets Manager值；Terraform仅创建空secret，禁止把密钥写入state。保留已有模型配置时必须安全迁入原主密钥。

费用选择按官方香港按需价、730小时核算：双应用+Multi-AZ RDS+双Redis固定基线约207.01美元/月；单应用+Single-AZ RDS+单Redis约144.06美元/月。另计流量、日志、镜像/备份存储、AI和独立视频服务、税。单实例减少冗余。AiToEarn独立运行服务尚未部署，不属于本次已验收能力。

以下为部署操作步骤；历史的“尚未实测”说明须以本节与之后的实际验收记录为准。

## 本地

依赖：Node.js 24、npm、Docker（本机使用 Colima）。首次 `npm ci`；双击根目录 Start-Local.command。

端口：网页/API 127.0.0.1:3000，PostgreSQL 127.0.0.1:55432，Redis 127.0.0.1:56379。账户在 `.local/login.txt`，服务日志在 `.local/server.log`，均被 Git 忽略。

验证：`node scripts/local-smoke.mjs`。数据容器状态：`docker compose -p wishtaday-local ps`。

本地备份（在项目根目录执行）：

```sh
mkdir -p .local/backups
docker compose -p wishtaday-local exec -T postgres pg_dump -U office_admin -d office -Fc > .local/backups/office.dump
```

恢复应先导入单独的新数据库并检查，避免覆盖正在使用的数据。Redis 只承载可过期会话/缓存，不作为业务数据库备份替代品。不要删除 Docker 数据卷。备份文件同样含用户数据，禁止提交到 Git。

## 云端地图与上线前决定

- 业务：ap-east-1，ECS Fargate ARM64、ALB、RDS PostgreSQL、ElastiCache Redis。
- 助手：us-west-2（或 us-east-2），共享原生 Harness 与按 profile 调用；记忆也在该美国区域。
- 域名：wishtaday.com，Route53 DNS；已有域名记录不自动接管，先核对 hosted zone 和现有网站。
- CloudFront CDN：API/登录不缓存；静态资源缓存；HTTPS 证书在 us-east-1，源站证书在香港。
- Cognito：云端用户名/密码和 Passkey；本地测试账号不会自动变成 Cognito 用户。

当前配置按两台应用、RDS Multi-AZ、Redis 双节点、一个 NAT 网关设计。它有持续云端费用，即使没有用户访问也会收费；单 NAT 是可用性折中。正式 apply 前通过 AWS Pricing Calculator 估价、设置预算告警，再确认是否调整规模。本次未连接账户，未报价，未创建收费资源。

## 1. 准备账户及远程状态

安装 AWS CLI 与 Terraform >=1.13，通过 SSO 或本机配置连接 profile 0511，不把密钥写入仓库。确认香港区域已启用，目标模型与 AgentCore 在美国区域可用。

```sh
aws sts get-caller-identity --profile 0511
terraform -chdir=infra/bootstrap init
terraform -chdir=infra/bootstrap plan -var='bucket_name=替换为全球唯一存储桶名称' -out=bootstrap.tfplan
terraform -chdir=infra/bootstrap apply bootstrap.tfplan
```

bootstrap 创建私有、加密、版本化的 S3 state 存储桶。保管初始 bootstrap 本地 state 和备份；不要删除，不要提交。复制 `infra/terraform/backend.hcl.example` 到 backend.hcl，填入桶名。

```sh
terraform -chdir=infra/terraform init -backend-config=backend.hcl
```

Terraform state 会含密码和源站密钥，按生产密钥管理。限制访问者，启用 S3 锁，不在终端输出或公开上传 state/plan。

## 2. 第一次准备基础设施

复制 production.tfvars.example 为 production.tfvars。填 zone_id、实际授权 model_id 与完整 model_resource_arns（跨区推理时包括推理 profile 及其目标区域模型 ARN）。根据正式选择验证模型可用性，示例不是已验证的模型授权。

初次 image_digest 留空、desired_count=0、publish_dns=false；license_reviewed 保持 false，直到完成上游资产商业许可核对。

```sh
terraform -chdir=infra/terraform fmt -check -recursive
terraform -chdir=infra/terraform validate
terraform -chdir=infra/terraform plan -var-file=production.tfvars -var=desired_count=0 -out=prepare.tfplan
terraform -chdir=infra/terraform apply prepare.tfplan
```

即使 desired_count=0，数据库、缓存、NAT、负载均衡等仍产生费用。该步骤也会创建 origin 子域与证书 DNS 验证记录，但不会发布根域网站。

## 3. 发布 ARM 镜像并迁移数据库

```sh
node scripts/cloud-release.mjs v0.1.0
terraform -chdir=infra/terraform plan -var-file=production.tfvars -var-file=../../.local/release.tfvars.json -var=desired_count=0 -out=migration.tfplan
terraform -chdir=infra/terraform apply migration.tfplan
node scripts/cloud-migrate.mjs
```

发布脚本使用 profile 0511、香港 ECR，构建 linux/arm64，保存不可变 image digest。数据库迁移任务拿管理员凭据，网页任务只拿受限应用凭据。迁移失败立即停止，检查 CloudWatch 日志。所有数据库迁移在事务中执行，并用版本表和数据库锁防止并发重复执行。

## 4. 启动与 DNS 发布

完成许可核对，将 license_reviewed=true，保留 publish_dns=false，使用同一镜像 digest 先启动服务。检查 ECS 稳定、ALB 健康、CloudFront 来源限制与 API 未登录返回 401。然后 plan 核对 DNS 变更，将 publish_dns=true 后 apply。域名发布可能替换现有网站，必须在此时核对现有 DNS，而不是盲目覆盖。

正式域名就绪后逐项验收：Cognito 注册/验证/密码/Passkey、退出、邀请链接登录后继续接受、用户切换企业、跨企业与跨用户数据拒绝访问、真实 AgentCore 对话及记忆隔离、重复请求只记一次账、中英文和手机界面。Passkey 依赖真实 HTTPS 域名和设备支持，本地账号验证不能替代此项。

## 升级、回滚与数据迁移

后续发布每次使用新镜像 tag，重跑发布/迁移/服务 plan；数据库 schema 变更应保持旧版本兼容，再更新服务。ECS deployment circuit breaker 已配置；应用回滚到上一个 image digest，数据库不自动执行破坏性回滚。RDS 已配置七天备份和删除保护；定期在隔离实例演练恢复。

本地使用与生产相同 PostgreSQL schema，但本地 seed 身份是 local:email；云端使用 Cognito subject。默认生产空库，若需要保留调试数据，需要独立数据迁移与身份映射，不直接搬本地认证记录。未来增加大版本 migration 前先做备份。

## 尚待云端实测

本地启动与单元/集成检查不能替代 AWS 实测。账户未连接，Terraform plan/apply、镜像发布运行、云端证书、Cognito/Passkey、真实 Harness/记忆、跨区域网络、CDN 行为与恢复演练均未验收。第一次云端上线仍可能遇到账户配额、区域/模型权限和服务配置差异，需要按错误定位。

官方参考：[AgentCore Harness](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/harness-models.html)、[记忆](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/harness-memory.html)、[Cognito 登录](https://docs.aws.amazon.com/cognito/latest/developerguide/authentication.html)。


## Windows 本机交付

Windows 的安装、账号、Mac 数据迁移、主加密密钥保护与排错见 [Windows 安装说明](WINDOWS-SETUP.md)。使用该本机路径不需要执行 Terraform 或创建 AWS 资源。
