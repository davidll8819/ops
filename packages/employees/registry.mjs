// The order and IDs are also the office animation's desk/character contract.
export const EMPLOYEES = [
  {
    id: 'marvis',
    name: '李婉儿',
    color: 0xe85d4a,
    departmentKey: 'secretary',
    department: '秘书处',
    departmentEn: 'Secretariat',
    responsibility: '传达、安排老板交代的工作',
    role: 'secretary',
  },
  {
    id: 'code-agent',
    name: '龙傲天',
    color: 0x4a90d9,
    departmentKey: 'dev',
    department: '程序部',
    departmentEn: 'Development',
    responsibility: '开发与排查问题',
    role: 'employee',
  },
  {
    id: 'file-agent',
    name: '赵雅梦',
    color: 0x9b6dd7,
    departmentKey: 'archive',
    department: '资料室',
    departmentEn: 'Records',
    responsibility: '整理各部门日常流程、资料归档',
    role: 'employee',
  },
  {
    id: 'app-agent',
    name: '叶凡',
    color: 0xf5c542,
    departmentKey: 'content_ops',
    department: '运营部',
    departmentEn: 'Content operations',
    responsibility: '文案制作及视频制作',
    role: 'employee',
  },
  {
    id: 'review-agent',
    name: '刘市',
    color: 0xf97316,
    departmentKey: 'market_research',
    department: '市场调研',
    departmentEn: 'Market research',
    responsibility: '分析评估本产品，给出综合报告',
    role: 'employee',
  },
  {
    id: 'data-agent',
    name: '派阿奇',
    color: 0x4ecdc4,
    departmentKey: 'compliance',
    department: '合规部',
    departmentEn: 'Compliance',
    responsibility: '核对规范与风险',
    role: 'employee',
  },
  {
    id: 'new-agent-7',
    name: '林幼薇',
    color: 0x78946a,
    departmentKey: 'design',
    department: '设计部',
    departmentEn: 'Design',
    responsibility: '设计视觉与版式',
    role: 'employee',
  },
  {
    id: 'new-agent-8',
    name: '西罗',
    color: 0xc084a2,
    departmentKey: 'outreach',
    department: '拓客部',
    departmentEn: 'Outreach',
    responsibility: '根据需求找客户',
    role: 'employee',
  },
  {
    id: 'new-agent-9',
    name: '实习生',
    color: 0x6f89b7,
    departmentKey: 'intern',
    department: '实习生',
    departmentEn: 'Intern',
    responsibility: '协助各部门日常工作',
    role: 'intern',
  },
].map((employee, index) => Object.freeze({ ...employee, rosterNo: index + 1 }))
Object.freeze(EMPLOYEES)

// Preserve task planner order independently of desk order.
export const DEPARTMENT_KEYS = [
  'secretary',
  'content_ops',
  'market_research',
  'design',
  'dev',
  'archive',
  'compliance',
  'outreach',
  'intern',
]
export const EMPLOYEE_BY_DEPARTMENT = Object.freeze(
  Object.fromEntries(EMPLOYEES.map((e) => [e.departmentKey, e])),
)
export const DEPARTMENT_NAMES = Object.freeze(
  Object.fromEntries(DEPARTMENT_KEYS.map((key) => [key, EMPLOYEE_BY_DEPARTMENT[key].department])),
)
export const DEPARTMENT_IDS = Object.freeze(
  Object.fromEntries(EMPLOYEES.map((e) => [e.id, e.departmentKey])),
)
export const TASK_DEPARTMENTS = DEPARTMENT_KEYS.filter((key) => key !== 'secretary').map((key) => {
  const employee = EMPLOYEE_BY_DEPARTMENT[key]
  return {
    id: employee.id,
    name: employee.department,
    en: employee.departmentEn,
    person: employee.name,
  }
})
export function employeeIntroduction(department) {
  const employee = EMPLOYEE_BY_DEPARTMENT[department]
  if (!employee) throw new Error('Unknown department')
  return `你是${employee.department}的${employee.name}，工作职责是${employee.responsibility}。`
}
export function departmentChatInstructions(department) {
  if (department === 'content_ops')
    return `${employeeIntroduction(department)}你负责内容策划、平台文案、视频脚本分镜和素材制作方案。根据用户本轮修改结合上下文保留产品、受众、平台、时长、风格、预算和“不发布”等约束；缺少关键事实明确标记待确认，不编造品牌事实或数据。输出便于执行的交付物：策划给出目标、受众、核心卖点和选题；文案给出可直接使用的标题、正文及行动引导；视频按镜头列时间、画面、口播/字幕、素材及提示词，镜头时长合计符合要求；最后给出素材清单、待补信息和验收标准。简单问题直接回答，避免每次重复长模板。文字对话只完成方案，不声称生成了图片/视频、访问了链接或发布成功。用户可点击回复下“带入运营工作台”保存方案和原始要求，核对并点击开始制作；实际生成依赖企业制作服务，发布必须在工作台单独点击确认。无需为了交接再调用一次模型。`
  return `${employeeIntroduction(department)}根据用户要求完成文字分析、方案和文档。没有浏览器、终端、发布或定时工具，不得声称已执行这些动作。需要生成媒体或发布时建议进入运营工作台。`
}
