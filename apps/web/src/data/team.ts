export type AgentRosterEntry = {
  id: string
  name: string
  color: number
  department: string
  responsibility: string
  role: 'secretary' | 'employee' | 'intern'
  task: string
}

/** 用户指定的九个部门/岗位；稳定ID保持动作与工位映射不变。 */
export const TEAM_ROSTER: AgentRosterEntry[] = [
  {
    id: 'marvis',
    name: '李婉儿',
    color: 0xe85d4a,
    department: '秘书处',
    responsibility: '传达、安排老板交代的工作',
    role: 'secretary',
  },
  {
    id: 'code-agent',
    name: '龙傲天',
    color: 0x4a90d9,
    department: '程序部',
    responsibility: '开发与排查问题',
    role: 'employee',
  },
  {
    id: 'file-agent',
    name: '赵雅梦',
    color: 0x9b6dd7,
    department: '资料室',
    responsibility: '整理各部门日常流程、资料归档',
    role: 'employee',
  },
  {
    id: 'app-agent',
    name: '叶凡',
    color: 0xf5c542,
    department: '运营部',
    responsibility: '文案制作及视频制作',
    role: 'employee',
  },
  {
    id: 'review-agent',
    name: '刘市',
    color: 0xf97316,
    department: '市场调研',
    responsibility: '分析评估本产品，给出综合报告',
    role: 'employee',
  },
  {
    id: 'data-agent',
    name: '派阿奇',
    color: 0x4ecdc4,
    department: '合规部',
    responsibility: '核对规范与风险',
    role: 'employee',
  },
  {
    id: 'new-agent-7',
    name: '林幼薇',
    color: 0x78946a,
    department: '设计部',
    responsibility: '设计视觉与版式',
    role: 'employee',
  },
  {
    id: 'new-agent-8',
    name: '西罗',
    color: 0xc084a2,
    department: '拓客部',
    responsibility: '根据需求找客户',
    role: 'employee',
  },
  {
    id: 'new-agent-9',
    name: '实习生',
    color: 0x6f89b7,
    department: '实习生',
    responsibility: '协助各部门日常工作',
    role: 'intern',
  },
].map((member) => ({
  ...member,
  role: member.role as AgentRosterEntry['role'],
  task: `${member.department}：${member.responsibility}`,
}))

/** 私人秘书单独协调；智能体页面展示七位员工及一位实习生。 */
export const DEPARTMENT_AGENTS = TEAM_ROSTER.filter((member) => member.role !== 'secretary')
