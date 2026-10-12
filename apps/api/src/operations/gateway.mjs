import { modelCatalog } from './model-catalog.mjs'
import { Readable } from 'node:stream'
import { z } from 'zod'
import { transaction, fail } from '../db.mjs'
import { configKey, decryptConfig } from './security.mjs'
import { toPolicy, resolveDepartment, resolveCapability, validGatewayToken } from './policy.mjs'
import { reserveTokens, settleTokens } from './budget.mjs'
import { loadSecrets } from './credentials.mjs'
import { createOperationsDriver } from './driver.mjs'
export async function loadPolicy(db, tenantId, env) {
  const row = (await db.query('SELECT encrypted_config,revision FROM operations_settings WHERE tenant_id=$1',[tenantId])).rows[0]
  if (!row) throw fail(409,'请先保存企业模型配置')
  return { policy: toPolicy(decryptConfig(row.encrypted_config,await configKey(env),tenantId)), revision: row.revision }
}
export function readUsage(data, anthropic = false) {
  const u = data?.usage
  if (!u) return undefined
  const input = anthropic ? Number(u.input_tokens) + Number(u.cache_read_input_tokens || 0) + Number(u.cache_creation_input_tokens || 0) : Number(u.prompt_tokens)
  const output = Number(anthropic ? u.output_tokens : u.completion_tokens)
  return Number.isSafeInteger(input) && Number.isSafeInteger(output) && input >= 0 && output >= 0 ? { input,output } : undefined
}
// Collect only usage metadata; never persist prompts, tool arguments, or model response text.
export function streamUsage(anthropic) {
  let pending = '', usage, complete = false, invalid = false
  return {
    feed(text) {
      pending = (pending + text).replaceAll('\r\n','\n')
      if (pending.length > 4 * 1024 * 1024) { invalid = true; pending = ''; return }
      let pos
      while ((pos = pending.indexOf('\n\n')) >= 0) {
        const frame = pending.slice(0,pos); pending = pending.slice(pos+2)
        const payload = frame.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trimStart()).join('\n')
        if (payload === '[DONE]') { complete = true; continue }
        try {
          const data = JSON.parse(payload)
          if (data.error || data.type === 'error') invalid = true
          if (!anthropic && data.usage) usage = readUsage(data)
          if (anthropic && data.type === 'message_start') usage = readUsage(data.message,true)
          if (anthropic && data.type === 'message_delta' && usage && Number.isSafeInteger(data.usage?.output_tokens)) usage.output = data.usage.output_tokens
          if (data.type === 'message_stop') complete = true
        } catch { /* Keep forwarding protocol comments and unknown event types. */ }
      }
    }, result() { return complete && !invalid ? usage : undefined },
  }
}
export function createModelGateway({ pool, env, fetcher = fetch }) {
  return async function call({ ctx, policy, department, path, body, reply, allowFallback = true, capability = 'text' }) {
    const key = (await transaction(pool,db => loadSecrets(db,env,ctx.tenantId),ctx)).ai
    if (!key) throw fail(409,'请先在设置中填写并保存企业 API Key')
    const selection = resolveCapability(policy,department,capability)
    const anthropic = path === '/api/anthropic/v1/messages'
    const textCall = anthropic || path === '/api/v1/chat/completions'
    const headers = { authorization: `Bearer ${key}`, 'content-type': 'application/json', ...(anthropic ? { 'x-api-key':key,'anthropic-version':'2023-06-01' } : {}) }
    let requestBody = body, reservation, outputLimit
    if (!textCall) {
      const kind = path.includes('/images/') ? 'image' : 'video'
      const model = resolveCapability(policy,department,kind).model
      if (!model) throw fail(409, kind === 'image' ? '请先选择图片模型' : '请先选择视频模型')
      requestBody = { ...body, model }
    }
    if (textCall) {
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw fail(400,'模型请求格式不正确')
      requestBody = { ...body,model:selection.model }
      // One completion per request; tools remain available to the original workflow.
      if (!anthropic) requestBody.n = 1
      outputLimit = body.max_completion_tokens ?? body.max_tokens ?? 4096
      if (!Number.isSafeInteger(outputLimit) || outputLimit < 1) throw fail(400,'模型输出额度必须为正整数')
      if (!anthropic && body.max_completion_tokens !== undefined) {
        delete requestBody.max_tokens
        requestBody.max_completion_tokens = outputLimit
      } else {
        delete requestBody.max_completion_tokens
        requestBody.max_tokens = outputLimit
      }
      if (body.stream && !anthropic) requestBody.stream_options = { include_usage:true }
      // A conservative text estimate; remote media may cost more. Actual usage always wins.
      const reserve = Buffer.byteLength(JSON.stringify(requestBody))*2 + 4096 + outputLimit
      reservation = await reserveTokens(pool,ctx,{ department,model:selection.model,limit:policy.budget.daily_token_limit,tokens:reserve })
    }
    let response
    try {
      response = await fetcher(`https://app.4yi.ai${path}`, { method:'POST',headers,body:JSON.stringify(requestBody),redirect:'error',signal:AbortSignal.timeout(300000) })
      // A fallback is a new request only after an explicit pre-output rejection. Never retry a timeout or an accepted media job.
      if (allowFallback && textCall && [429,502,503,504].includes(response.status) && selection.fallback && selection.fallback !== selection.model) {
        await response.body?.cancel()
        // Keep the first reservation: the upstream may have done work before returning an error.
        await settleTokens(pool,ctx,reservation,'unknown')
        requestBody.model = selection.fallback
        const tokens = Buffer.byteLength(JSON.stringify(requestBody))*2+4096+outputLimit
        reservation = await reserveTokens(pool,ctx,{department,model:selection.fallback,limit:policy.budget.daily_token_limit,tokens})
        response = await fetcher(`https://app.4yi.ai${path}`,{method:'POST',headers,body:JSON.stringify(requestBody),redirect:'error',signal:AbortSignal.timeout(300000)})
      }
    } catch (error) {
      if (reservation) await settleTokens(pool,ctx,reservation,'unknown')
      if (error.expose) throw error
      throw fail(502,'模型请求结果未知，已保留预占额度；请勿自动重试')
    }
    if (!response.ok) {
      if (reservation) await settleTokens(pool,ctx,reservation,[400,401,403,404,422].includes(response.status) ? 'rejected' : 'unknown')
      const searchRequest = body?.web_search_options || body?.tools?.some(tool => /^web_search_/.test(tool.type || ''))
      if (searchRequest && [400,422].includes(response.status)) {
        const error = await response.clone().json().catch(() => ({}))
        const message = String(error.error?.message || error.message || '').slice(0,2000)
        if (/unsupported server tool|web_search|web search|search.*not supported/i.test(message)) {
          await response.body?.cancel()
          throw fail(409,'当前调研模型的中转通道未开放内置联网搜索；请在现有模型服务中开通此能力')
        }
      }
      await response.body?.cancel()
      throw fail(response.status === 429 ? 429 : 502,'模型服务未完成请求，请检查模型档位、密钥或服务状态')
    }
    if (textCall && body.stream) {
      if (!response.headers.get('content-type')?.includes('text/event-stream') || !response.body) {
        await settleTokens(pool,ctx,reservation,'unknown'); await response.body?.cancel()
        throw fail(502,'模型服务未返回有效的流式响应')
      }
      const meter = streamUsage(anthropic), decoder = new TextDecoder()
      async function* forward() {
        try {
          for await (const chunk of response.body) { meter.feed(decoder.decode(chunk,{stream:true})); yield chunk }
          meter.feed(decoder.decode())
        } finally { await settleTokens(pool,ctx,reservation,'completed',meter.result()) }
      }
      return reply.header('content-type','text/event-stream').header('x-accel-buffering','no').send(Readable.from(forward()))
    }
    let result
    try { result = await response.json() }
    catch { if (reservation) await settleTokens(pool,ctx,reservation,'unknown'); throw fail(502,'模型返回内容无法解析') }
    if (reservation) await settleTokens(pool,ctx,reservation,'completed',readUsage(result,anthropic))
    return result
  }
}
export function registerModelGateway(app,{ scoped,pool,env,driver = createOperationsDriver(env),fetcher = fetch }) {
  const call = createModelGateway({pool,env,fetcher})
  app.get('/api/tenants/:tenantId/operations/models',async req => {
    const {ctx} = await scoped(req,async (db,tenant,ctx) => ({ctx}),['owner','admin'])
    const key = (await transaction(pool,db => loadSecrets(db,env,ctx.tenantId),ctx)).ai
    if (!key) throw fail(409,'请先在设置中填写并保存企业 API Key')
    let response
    try { response = await fetcher('https://app.4yi.ai/api/v1/models',{headers:{authorization:`Bearer ${key}`},redirect:'error',signal:AbortSignal.timeout(15000)}) }
    catch { throw fail(502,'暂时无法读取模型列表') }
    if (!response.ok) throw fail(502,'暂时无法读取模型列表')
    const data = await response.json()
    const catalog = modelCatalog(data).map(m=>({...m, searchVerified: ['gemini-3.5-flash','gemini-2.5-pro','grok-4.3'].includes(m.id)}))
    return { models: catalog.map(m => m.id), catalog }
  })
  app.post('/api/tenants/:tenantId/departments/:department/messages',async (req,reply) => {
    const input = z.object({prompt:z.string().trim().min(1).max(20000)}).strict().parse(req.body)
    const {ctx,policy} = await scoped(req,async (db,tenant,ctx) => ({ctx,...await loadPolicy(db,ctx.tenantId,env)}))
    return call({ctx,policy,department:req.params.department,path:'/api/v1/chat/completions',body:{messages:[{role:'user',content:input.prompt}],max_tokens:4096},reply})
  })
  // Private AiToEarn uses a tenant-bound internal token, never the provider key.
  app.addContentTypeParser(/^multipart\/form-data(?:;|$)/, {parseAs:'buffer'}, (_req,body,done) => done(null,body))
  app.all('/integrations/model-gateway/:tenantId/*',{bodyLimit:32*1024*1024},async (req,reply) => {
    const tenantId = z.uuid().parse(req.params.tenantId), entry = await driver.binding(tenantId)
    if (!entry || !validGatewayToken(entry.bridgeSecret,tenantId,req.headers.authorization)) throw fail(403,'运行服务认证失败')
    const ctx = {tenantId,userId:''}
    const {policy} = await transaction(pool,db => loadPolicy(db,tenantId,env),ctx)
    resolveDepartment(policy,'content_ops')
    const path = `/${req.params['*']}`
    const textPath = ['/api/v1/chat/completions','/api/anthropic/v1/messages'].includes(path)
    const mediaCreate = ['/api/v1/images/generations','/api/v1/videos/generations','/api/v1/images/edits'].includes(path)
    const mediaRead = /^\/api\/v1\/videos\/generations\/[a-zA-Z0-9._-]+(?:\/artifact)?$/.test(path)
    if (req.url.includes('?') || !((req.method === 'POST' && (textPath || mediaCreate)) || (req.method === 'GET' && (mediaRead || path === '/api/v1/models')))) throw fail(404,'模型接口尚未接入')
    if (path === '/api/v1/images/edits') {
      const key = (await transaction(pool,db => loadSecrets(db,env,tenantId),ctx)).ai
      if (!key) throw fail(409,'请先在设置中填写并保存企业 API Key')
      if (!Buffer.isBuffer(req.body)) throw fail(400,'图片编辑需要 multipart 文件请求')
      const imageModel = resolveCapability(policy,'content_ops','image').model
      let form
      try { form = await new Request('http://localhost',{method:'POST',headers:{'content-type':req.headers['content-type']},body:req.body}).formData() }
      catch { throw fail(400,'图片编辑文件格式不正确') }
      form.set('model',imageModel)
      const response = await fetcher(`https://app.4yi.ai${path}`,{method:'POST',headers:{authorization:`Bearer ${key}`},body:form,redirect:'error',signal:AbortSignal.timeout(300000)})
      if (!response.ok) { await response.body?.cancel(); throw fail(502,'图片编辑请求未完成，请核对状态后再操作') }
      return response.json()
    }
    if (req.method === 'POST') return call({ctx,policy,department:'content_ops',path,body:req.body,reply})
    const key = (await transaction(pool,db => loadSecrets(db,env,tenantId),ctx)).ai
    if (!key) throw fail(409,'请先在设置中填写并保存企业 API Key')
    const response = await fetcher(`https://app.4yi.ai${path}`,{headers:{authorization:`Bearer ${key}`},redirect:'error',signal:AbortSignal.timeout(300000)})
    if (!response.ok) { await response.body?.cancel(); throw fail(502,'模型服务未完成请求，请检查模型档位、密钥或服务状态') }
    return reply.header('content-type',response.headers.get('content-type') || 'application/octet-stream').send(Readable.fromWeb(response.body))
  })
}
