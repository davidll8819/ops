import { fail } from '../db.mjs'
import { publicURL, readPublicPage } from './web.mjs'

const noResults = (detail = '') =>
  fail(502, `当前已配置模型入口未返回可验证的联网结果${detail ? `：${detail}` : ''}`)
const plain = (value, limit) =>
  typeof value === 'string'
    ? value
        .replace(/<[^>]*>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, limit)
    : ''
const safeURL = (value) => {
  if (typeof value !== 'string') return undefined
  try {
    return publicURL(value).href
  } catch {
    return undefined
  }
}
const errors = {
  too_many_requests: '模型内置搜索暂时限流',
  invalid_tool_input: '模型内置搜索参数无效',
  max_uses_exceeded: '模型内置搜索已达到单次上限',
  query_too_long: '模型内置搜索词过长',
  request_too_large: '模型内置搜索请求过大',
  unavailable: '模型内置搜索暂时不可用',
}

function anthropicResults(response) {
  const content = Array.isArray(response?.content) ? response.content : []
  const calls = new Set(
    content
      .filter(
        (block) =>
          block?.type === 'server_tool_use' &&
          block.name === 'web_search' &&
          typeof block.id === 'string' &&
          block.id &&
          typeof block.input?.query === 'string' &&
          block.input.query.trim(),
      )
      .map((block) => block.id),
  )
  const results = [],
    toolErrors = []
  for (const block of content) {
    if (block?.type !== 'web_search_tool_result' || !calls.has(block.tool_use_id)) continue
    if (!Array.isArray(block.content)) {
      if (block.content?.type === 'web_search_tool_result_error')
        toolErrors.push(
          typeof block.content.error_code === 'string' ? block.content.error_code : 'unknown_error',
        )
      continue
    }
    for (const item of block.content) {
      if (item?.type !== 'web_search_result') continue
      const url = safeURL(item.url)
      if (url) results.push({ url, title: item.title, snippet: '' })
    }
  }
  // A provider may return real results followed by the cap error. Keep that evidence,
  // but never turn an unrelated tool error or a text-only claim into a successful search.
  const error = toolErrors.find((code) => code !== 'max_uses_exceeded')
  if (error || (!results.length && toolErrors.length))
    throw noResults(errors[error || toolErrors[0]] || '模型内置搜索执行失败')
  if (!results.length) throw noResults('缺少匹配的搜索调用与公开来源回执')
  const excerpts = new Map()
  for (const block of content) {
    if (block?.type !== 'text' || !Array.isArray(block.citations)) continue
    for (const citation of block.citations) {
      if (citation?.type !== 'web_search_result_location') continue
      const url = safeURL(citation.url)
      if (!url || !results.some((item) => item.url === url)) continue
      const excerpt = plain(citation.cited_text, 2000)
      if (excerpt) excerpts.set(url, plain(`${excerpts.get(url) || ''} ${excerpt}`, 2000))
    }
  }
  return results.map((item) => ({ ...item, snippet: excerpts.get(item.url) || '' }))
}

function chatResults(response) {
  const message = response?.choices?.[0]?.message
  const annotations = Array.isArray(message?.annotations) ? message.annotations : []
  const results = []
  for (const annotation of annotations) {
    if (annotation?.type !== 'url_citation') continue
    const citation = annotation.url_citation
    const url = safeURL(citation?.url)
    if (!url) continue
    const start = citation.start_index,
      end = citation.end_index
    const snippet =
      typeof message.content === 'string' &&
      Number.isInteger(start) &&
      Number.isInteger(end) &&
      start >= 0 &&
      end > start &&
      end <= message.content.length
        ? message.content.slice(start, Math.min(end, start + 2000))
        : ''
    results.push({ url, title: citation.title, snippet })
  }
  if (!results.length) throw noResults('模型回复没有提供联网来源引用回执')
  return results
}

/** Search through the configured model gateway; no second credential or direct provider fetch. */
export function createModelWebTools({ model, call, reader = readPublicPage }) {
  if (typeof model !== 'string' || !model.trim() || typeof call !== 'function')
    throw fail(409, '请先选择市场调研使用的企业模型')
  const native = ['gemini-3.5-flash','gemini-2.5-pro','grok-4.3'].includes(model),
    claude = /claude/i.test(model),
    sources = new Map()
  let queries = 0,
    reads = 0
  return {
    sources,
    async search(query) {
      if (++queries > 3) throw fail(409, '本次任务已达到 3 次搜索上限')
      if (typeof query !== 'string' || !query.trim() || query.length > 300)
        throw fail(400, '搜索词不正确')
      const messages = [
        {
          role: 'user',
          content: `请使用内置联网搜索搜索一次以下查询，给出简短结果及来源引用。必须实际执行搜索；不能以已有知识代替，不能猜测链接。查询：${query.trim()}`,
        },
      ]
      let response
      try {
        response = await call({
          path: claude ? '/api/anthropic/v1/messages' : '/api/v1/chat/completions',
          allowFallback: false,
          body: {
            messages,
            max_tokens: 2048,
            ...(native ? {tools:[{type:'openrouter:web_search',parameters:{engine:'native',max_total_results:3,search_context_size:'low'}}],max_tool_calls:1} : claude
              ? { tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 1 }] }
              : { web_search_options: { search_context_size: 'low' } }),
          },
        })
      } catch (error) {
        if (error.expose) throw error
        throw noResults('模型请求未完成，请检查现有模型服务状态')
      }
      const result = claude ? anthropicResults(response) : chatResults(response)
      const found = [],
        seen = new Set()
      for (const item of result) {
        if (seen.has(item.url)) continue
        seen.add(item.url)
        if (!sources.has(item.url))
          sources.set(item.url, {
            id: `S${sources.size + 1}`,
            url: item.url,
            title: plain(item.title, 200) || item.url.slice(0, 200),
            snippet: plain(item.snippet, 2000),
            retrievedAt: new Date().toISOString(),
            read: false,
          })
        found.push(sources.get(item.url))
        if (found.length === 5) break
      }
      return found
    },
    async read(value) {
      if (++reads > 6) throw fail(409, '本次任务已达到 6 次网页读取上限')
      const url = safeURL(value)
      if (!url) throw fail(400, '只允许读取公开网页')
      const source = sources.get(url)
      if (!source) throw fail(400, '只能读取本次搜索得到的网页')
      try {
        const page = await reader(source.url)
        const finalUrl = safeURL(page?.url)
        if (!finalUrl || typeof page.text !== 'string' || !page.text.trim())
          throw fail(502, '网页没有可读取的公开正文')
        Object.assign(source, { read: true, finalUrl, readAt: new Date().toISOString() })
        return { ...source, text: page.text.slice(0, 10000) }
      } catch (error) {
        throw fail(502, error.expose ? error.message : '网页读取失败')
      }
    },
  }
}
