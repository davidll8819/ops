import { EMPLOYEES, departmentChatInstructions } from '../../../packages/employees/registry.mjs'
import { loadPolicy } from './operations/gateway.mjs'
import { loadSecrets } from './operations/credentials.mjs'
import { defaultCapabilities, resolveCapability } from './operations/policy.mjs'

export function employeeModels(policy, department, credentialConfigured) {
  const configuration = policy?.departments[department]
  return Object.fromEntries(
    ['text', 'search', 'image', 'video'].map((kind) => {
      const slot =
        kind === 'text'
          ? configuration
          : (configuration?.capabilities || defaultCapabilities(department))[kind]
      const enabled = Boolean(configuration?.enabled && slot?.enabled)
      let model = '',
        fallback = ''
      if (enabled) {
        try {
          ;({ model, fallback } = resolveCapability(policy, department, kind))
        } catch (error) {
          if (error.statusCode !== 409) throw error
        }
      }
      return [
        kind,
        {
          enabled,
          configured: Boolean(enabled && model && credentialConfigured),
          model,
          fallback,
          source: slot?.model ? 'department' : 'company',
        },
      ]
    }),
  )
}

export function registerEmployeeProfiles(app, { scoped, env }) {
  app.get('/api/tenants/:tenantId/employees', (req) =>
    scoped(req, async (db, tenant, ctx) => {
      let policy,
        credentialConfigured = false
      try {
        policy = (await loadPolicy(db, ctx.tenantId, env)).policy
        credentialConfigured = Boolean((await loadSecrets(db, env, ctx.tenantId)).ai)
      } catch (error) {
        if (error.statusCode !== 409) throw error
      }
      const assignments = (
        await db.query(
          'SELECT a.department,s.id,s.name,s.version FROM skill_assignments a JOIN installed_skills s ON s.tenant_id=a.tenant_id AND s.id=a.skill_id WHERE a.tenant_id=$1 ORDER BY s.name,s.id',
          [ctx.tenantId],
        )
      ).rows
      return {
        employees: EMPLOYEES.map((employee) => ({
          ...employee,
          chatInstructions: departmentChatInstructions(employee.departmentKey),
          models: employeeModels(policy, employee.departmentKey, credentialConfigured),
          skills: assignments
            .filter((a) => a.department === employee.departmentKey)
            .map(({ id, name, version }) => ({ id, name, version })),
        })),
      }
    }),
  )
}
