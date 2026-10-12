# 下载包存放区（未安装）

仅保存用户目录指定来源的 ZIP 压缩包（完整来源包或按技能目录归档的原始文件），不解压到技能运行目录、不执行其中脚本、不写入 Codex 或其他应用的全局技能目录。

`../catalog/catalog.json` 的每条记录使用 `id` 标识表格条目，以 `发布来源 + 英文名称` 区分同名技能，并记录：

- `number`：原表序号。
- `download.packagePath`：相对项目根目录的压缩包路径。
- `download.skillFile`：包内准确的 SKILL.md 路径。
- `download.sha256`：整个压缩包的校验码。
- `download.skillSha256`：按 UTF-8 读取技能说明后的内容校验码。
- `download.sourceUrl`：实际下载地址。
- `download.historical` / `commit`：是否从同一来源的历史版本找回，以及确切提交。

同一发布仓库包含多个技能时，多条目录记录可以引用同一个来源压缩包，但包内技能路径不同。完整来源包保留原仓库内容；对体积过大的仓库，`packageScope: skill-folders-and-root-license` 表示仅归档选定技能目录内的全部文件及仓库根许可证，文件字节逐一核对 Git 校验值。此类包不保证包含仓库其他位置的共享依赖，后续安装前仍需检查。历史包仅作为原条目的归档资料，后续安装前需核对版本和兼容性。

将来安装模块根据稳定 ID 查表，验证压缩包校验码和安全路径，再提取所选技能并登记到企业；本次没有实现或启动该过程。

ZIP 文件保留在本机并忽略 Git 提交，备份或迁移时需连同 `catalog` 一起复制。运行 `python3 scripts/verify-skill-catalog.py` 可复核目录与下载包的对应关系。
