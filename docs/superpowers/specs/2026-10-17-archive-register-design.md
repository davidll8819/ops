# 赵雅梦正式归档与检索

用户已批准：现有弹窗内修改建议、确认并正式归档，归档后按分类和标签检索；办公室动画不改。延续已有Word/PDF/Excel/OCR、版本比对与私有归档建议。

## 设计决定
沿用Node/PostgreSQL/React，无新依赖。原模型建议和原文件保持可追溯，在独立archive_records表保存人工核对的草稿和正式记录。“正式归档”指在Wishtaday登记并可检索、下载原文件，不移动本机文件。无需再次调用模型。当前私有资料延续tenant+user权限，不能扩大给企业其他成员。

在每份成功建议下增加“修改并归档”。表单修改主题、归属部门、资料类型、标签和归档说明；编号及扩展名由系统保留，文件名由修改后的主题+原建议编号生成（预览显示），目录由部门/类型/原建议年份生成。标签最多6个，每项1–20字；标题1–80字；说明最多600字，允许空。复用现有安全命名规则，不接受路径、档案号或来源客户端字段。保存草稿不归档，确认按钮明确提示“确认归档后将登记为正式记录，原文件保留”。不设置第二个模态框。

确认仅使用已保存草稿的revision，表单改动后须先保存。每份建议仅一条记录，草稿修改使用乐观版本校验，旧版本409提示重载；正式归档幂等、不可修改或删除，确认人和时间由服务端写入。重复点击只产生一条档案。返回source/source引用直接取不可变建议，不接受用户伪造。首次保存前、详情读取和确认前均检查当前原文件SHA与提取身份，保存/确认锁定原文件，归档前source drift拒绝。正式记录若原件后来变化，检索可保留历史元数据但详情会明确409，避免将新内容当旧原件；通过详情后才显示可下载原件链接。

新增“档案检索”工具标签，仍在弹窗左侧。可按资料类型下拉、完整标签过滤和关键词（标题/建议编号/文件名）联合查询；只显示正式档案，默认每页20项，页码分页返回total。按归档时间/id倒序。标签列可点击作为筛选。结果显示正式名称、编号、分类、标签、目录和归档时间；“查看档案”读取详情并展示人工元数据、原模型建议依据/出处、来源版本、原件下载入口。关键词按字面匹配，转义LIKE通配符；标签是精确数组项匹配。元数据列表无用户正文；权限同私有文件。切换企业卸载会话，筛选/页码/详情请求序号隔离，迟到响应不得替换新结果。分页变化清空详情。

## 数据与接口
archive_records: id,tenant_id,user_id,suggestion_id(unique),state(draft/archived),revision(integer>=1),metadata(jsonb),created_at,updated_at,archived_at,confirmed_by。复合FK(suggestion_id,tenant_id,user_id)绑定建议；FORCE RLS tenant+user。触发器保护身份和已归档结果，拒绝DELETE，约束确认人等于owner及archived_at状态一致。runtime仅SELECT/INSERT/UPDATE。原表、原建议、原文件不更新。

GET /archive/filings/:suggestionId/record → {record:null|Record}，检查建议ready/私有/来源。
POST 同路径 {revision:0|positive,metadata:{title,department,category,tags,note}} → {record}。revision0表示首次保存，重复/并发首次非覆盖而409；事务内保证唯一。Record输出包含系统number、source、metadata、generatedName/directory/relativePath、状态/版本/时间/确认人和引用依据。
POST /archive/records/:id/confirm {revision} → {record}。锁记录，已归档且版本相同返回原记录；草稿版本一致才归档，revision不增加以支持重试。
GET /archive/records?category=&tag=&q=&page=1 → {items,total,page,pageSize:20}，严格限制query长度及页码，空filter为不限。
GET /archive/records/:id → {record}，仅正式档案可获取；草稿从suggestion路径获取。

## 验证与边界
测试真实上传与已有生成fixture，修改/草稿恢复/确认/相同版本幂等/并发冲突/权限RLS复合FK/已归档防改/空非法字段/原件SHA漂移/无模型调用/字面关键词与标签联合分页。浏览器验证修改未保存禁确认、失败保留输入、切企业/筛选迟到隔离、正式记录检索详情、原比对和右侧输入布局保持。生产验收使用前次两份演示资料，修改其中一份、保存、确认、检索、重开复用，记录所有原数据与40office资源哈希。原建议TXT仍明确建议，正式记录显示归档状态；不把旧建议标作已登记。
