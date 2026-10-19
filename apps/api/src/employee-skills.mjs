import { createHash, randomUUID } from 'node:crypto'
import { z } from 'zod'
import { EMPLOYEES } from '../../../packages/employees/registry.mjs'
import { fail } from './db.mjs'
import { installUploadedSkill, listInstalledSkills } from './skill-upload.mjs'
import { prepareSuperpowers } from './superpowers.mjs'

function employee(req) {
  const found = EMPLOYEES.find((e) => e.id === req.params.employeeId)
  if (!found) throw fail(404, '员工不存在')
  return found
}
async function binding(db, tenantId, department) {
  const skillIds = (
    await db.query(
      'SELECT skill_id FROM skill_assignments WHERE tenant_id=$1 AND department=$2 ORDER BY skill_id',
      [tenantId, department],
    )
  ).rows.map((r) => r.skill_id)
  return { skillIds, revision: createHash('sha256').update(JSON.stringify(skillIds)).digest('hex') }
}
async function audit(db, ctx, department) {
  await db.query(
    'INSERT INTO audit_events(id,tenant_id,user_id,action,target_id) VALUES($1,$2,$3,$4,$5)',
    [randomUUID(), ctx.tenantId, ctx.userId, 'employee.skills-updated', department],
  )
}
export function registerEmployeeSkills(app, { scoped }) {
  const path = '/api/tenants/:tenantId/employees/:employeeId/skills'
  app.get(path, (req) =>
    scoped(req, async (db, tenant, ctx) => {
      const { departmentKey } = employee(req)
      return {
        ...(await listInstalledSkills(db, ctx.tenantId)),
        ...(await binding(db, ctx.tenantId, departmentKey)),
      }
    }),
  )
  app.put(path, (req) =>
    scoped(
      req,
      async (db, tenant, ctx) => {
        const { departmentKey } = employee(req)
        const input = z
          .object({
            skillIds: z.array(z.uuid()).max(8),
            revision: z.string().regex(/^[a-f0-9]{64}$/),
          })
          .strict()
          .parse(req.body)
        const ids = [...new Set(input.skillIds)]
        await db.query('SELECT id FROM tenants WHERE id=$1 FOR UPDATE', [ctx.tenantId])
        const available = new Set(
          (
            await db.query('SELECT id FROM installed_skills WHERE tenant_id=$1', [ctx.tenantId])
          ).rows.map((r) => r.id),
        )
        if (ids.some((id) => !available.has(id)))
          throw fail(404, '所选技能不存在于当前企业，请重新加载')
        if ((await binding(db, ctx.tenantId, departmentKey)).revision !== input.revision)
          throw fail(409, '该员工的技能已被更新，请重新加载后再保存')
        await db.query('DELETE FROM skill_assignments WHERE tenant_id=$1 AND department=$2', [
          ctx.tenantId,
          departmentKey,
        ])
        for (const id of ids)
          await db.query('INSERT INTO skill_assignments VALUES($1,$2,$3)', [
            ctx.tenantId,
            id,
            departmentKey,
          ])
        await audit(db, ctx, departmentKey)
        return binding(db, ctx.tenantId, departmentKey)
      },
      ['owner', 'admin'],
    ),
  )
  app.post(`${path}/superpowers`, (req) =>
    scoped(
      req,
      async (db, tenant, ctx) => {
        const { departmentKey } = employee(req)
        z.object({})
          .strict()
          .parse(req.body || {})
        // Installation and binding share a transaction: failure leaves neither a partial package nor a lost binding.
        const installed = await installUploadedSkill(db, ctx, await prepareSuperpowers())
        const current = await binding(db, ctx.tenantId, departmentKey)
        if (!current.skillIds.includes(installed.skill.id)) {
          if (current.skillIds.length >= 8)
            throw fail(409, '每位员工最多启用 8 个技能包，请先停用一个')
          await db.query('INSERT INTO skill_assignments VALUES($1,$2,$3)', [
            ctx.tenantId,
            installed.skill.id,
            departmentKey,
          ])
          await audit(db, ctx, departmentKey)
        }
        return { ...installed, ...(await binding(db, ctx.tenantId, departmentKey)) }
      },
      ['owner', 'admin'],
    ),
  )
}
