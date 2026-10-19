import { z } from 'zod'
import yazl from 'yazl'

export function registerExecutionRoutes(app, { scoped, service }) {
  const path = '/api/tenants/:tenantId/employees/code-agent/workspace'
  const context = (req, roles) =>
    scoped(
      req,
      async (db, tenant, ctx) => ({
        ...ctx,
        ...(req.params.projectId
          ? { projectId: z.string().uuid().parse(req.params.projectId) }
          : {}),
      }),
      roles,
    )
  const projectRoot = '/api/tenants/:tenantId/employees/code-agent/projects'
  const name = z.string().trim().min(1).max(80)
  app.get(projectRoot, async (req) => service.projects(await context(req)))
  app.post(projectRoot, async (req) =>
    service.newProject(
      await context(req, ['owner', 'admin']),
      z.object({ name }).strict().parse(req.body).name,
    ),
  )
  app.post(`${projectRoot}/:projectId/rename`, async (req) =>
    service.renameProject(
      await context(req, ['owner', 'admin']),
      z.object({ name }).strict().parse(req.body).name,
    ),
  )
  app.get(`${projectRoot}/:projectId/versions`, async (req) => service.versions(await context(req)))
  app.post(`${projectRoot}/:projectId/versions`, async (req) =>
    service.saveVersion(
      await context(req, ['owner', 'admin']),
      z.object({ label: name, revision: z.number().int().nonnegative() }).strict().parse(req.body),
    ),
  )
  app.post(`${projectRoot}/:projectId/versions/:versionId/restore`, async (req) =>
    service.restoreVersion(
      await context(req, ['owner', 'admin']),
      z.string().uuid().parse(req.params.versionId),
      z.object({ revision: z.number().int().nonnegative() }).strict().parse(req.body).revision,
    ),
  )
  app.get(path, async (req) => service.status(await context(req)))
  app.post(path, async (req) => {
    const ctx = await context(req, ['owner', 'admin'])
    z.object({})
      .strict()
      .parse(req.body || {})
    return service.create(ctx)
  })
  for (const workspacePath of [path, `${projectRoot}/:projectId/workspace`]) {
    if (workspacePath !== path)
      app.get(workspacePath, async (req) => service.status(await context(req)))
    app.get(`${workspacePath}/file`, async (req) => {
      const ctx = await context(req)
      const { path: filePath } = z
        .object({ path: z.string().min(1).max(300) })
        .strict()
        .parse(req.query)
      return service.read(ctx, filePath)
    })
    app.get(`${workspacePath}/download`, async (req, reply) => {
      const files = await service.files(await context(req))
      const zip = new yazl.ZipFile()
      const output = new Promise((resolve, reject) => {
        const chunks = []
        zip.on('error', reject)
        zip.outputStream.on('error', reject)
        zip.outputStream.on('data', (b) => chunks.push(b))
        zip.outputStream.on('end', () => resolve(Buffer.concat(chunks)))
      })
      for (const file of files) zip.addBuffer(Buffer.from(file.contentBase64, 'base64'), file.path)
      zip.end()
      return reply
        .header('content-type', 'application/zip')
        .header('content-disposition', 'attachment; filename="dragon-project.zip"')
        .send(await output)
    })
  }
}
