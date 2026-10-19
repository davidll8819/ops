export type Employee = {
  id: string
  name: string
  color: number
  departmentKey: string
  department: string
  departmentEn: string
  responsibility: string
  role: 'secretary' | 'employee' | 'intern'
  rosterNo: number
}
export const EMPLOYEES: readonly Employee[]
export const DEPARTMENT_KEYS: readonly string[]
export const EMPLOYEE_BY_DEPARTMENT: Readonly<Record<string, Employee>>
export const DEPARTMENT_NAMES: Readonly<Record<string, string>>
export const DEPARTMENT_IDS: Readonly<Record<string, string>>
export const TASK_DEPARTMENTS: { id: string; name: string; en: string; person: string }[]
export function employeeIntroduction(department: string): string
export function departmentChatInstructions(department: string): string
