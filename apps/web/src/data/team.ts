import { EMPLOYEES } from '../../../../packages/employees/registry.mjs'

export type AgentRosterEntry = {
  id: string
  name: string
  color: number
  department: string
  responsibility: string
  role: 'secretary' | 'employee' | 'intern'
  task: string
}

/** Preserve the office roster shape, order, IDs, colors and task text. */
export const TEAM_ROSTER: AgentRosterEntry[] = EMPLOYEES.map(
  ({ id, name, color, department, responsibility, role }) => ({
    id,
    name,
    color,
    department,
    responsibility,
    role,
    task: `${department}：${responsibility}`,
  }),
)
export const DEPARTMENT_AGENTS = TEAM_ROSTER.filter((member) => member.role !== 'secretary')
