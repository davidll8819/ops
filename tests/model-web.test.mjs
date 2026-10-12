import test from 'node:test'
import assert from 'node:assert/strict'
import { createModelWebTools } from '../apps/api/src/research/model-web.mjs'

const url = 'https://example.com/report'
const tool = {
  type: 'server_tool_use',
  id: 'srvtoolu_fixture',
  name: 'web_search',
  input: { query: 'one person company' },
}
const result = (
  items = [
    { type: 'web_search_result', url, title: 'Source report', encrypted_content: 'opaque-source' },
  ],
) => ({
  type: 'web_search_tool_result',
  tool_use_id: tool.id,
  content: items,
})
const response = (blocks = []) => ({
  content: [tool, result(), ...blocks],
  stop_reason: 'end_turn',
  usage: { input_tokens: 100, output_tokens: 50, server_tool_use: { web_search_requests: 1 } },
})
const fixture = (value) =>
  createModelWebTools({
    model: 'claude-haiku-4.5',
    call: async () => value,
    reader: async (value) => ({ url: value, text: 'Verified fixture page body' }),
  })
const errorBlock = (error_code) => ({
  type: 'web_search_tool_result',
  tool_use_id: tool.id,
  content: { type: 'web_search_tool_result_error', error_code },
})
async function rejectsSearch(value, pattern = /当前已配置模型入口未返回/) {
  const web = fixture(value)
  await assert.rejects(web.search('one person company'), (error) => {
    assert.equal(error.statusCode, 502)
    assert.equal(error.expose, true)
    assert.match(error.message, pattern)
    assert.doesNotMatch(error.message, /Tavily|Brave|搜索.*(?:密钥|API Key)/i)
    return true
  })
  assert.equal(web.sources.size, 0)
}

test('model web search uses only the existing gateway with one Claude server search and no fallback', async () => {
  const calls = []
  const web = createModelWebTools({
    model: 'claude-haiku-4.5',
    call: async (request) => {
      calls.push(request)
      return response()
    },
  })
  const found = await web.search('一人公司')
  assert.equal(calls.length, 1)
  assert.equal(calls[0].path, '/api/anthropic/v1/messages')
  assert.equal(calls[0].allowFallback, false)
  assert.equal(calls[0].body.max_tokens, 2048)
  assert.deepEqual(calls[0].body.tools, [
    { type: 'web_search_20250305', name: 'web_search', max_uses: 1 },
  ])
  assert.deepEqual(Object.keys(calls[0]).sort(), ['allowFallback', 'body', 'path'])
  assert.ok(!JSON.stringify(calls[0]).includes('api_key'))
  assert.equal(found[0].url, url)
  assert.equal(found[0].id, 'S1')
  assert.equal(found[0].read, false)
  assert.ok(!JSON.stringify(found).includes('opaque-source'))
})

test('Claude sources require matched real call/results and snippets only use matching citations', async () => {
  const web = fixture(
    response([
      {
        type: 'text',
        text: 'A fabricated URL https://invented.example/path',
        citations: [
          {
            type: 'web_search_result_location',
            url,
            title: 'Citation',
            cited_text: 'Verified quotation',
          },
          {
            type: 'web_search_result_location',
            url: 'https://invented.example/path',
            cited_text: 'Do not accept',
          },
        ],
      },
    ]),
  )
  const found = await web.search('one person company')
  assert.equal(found.length, 1)
  assert.equal(found[0].snippet, 'Verified quotation')
  await rejectsSearch({ content: [result()] })
  await rejectsSearch({ content: [tool] })
  await rejectsSearch({ content: [tool, { ...result(), tool_use_id: 'unmatched' }] })
  await rejectsSearch({ content: [{ ...tool, name: 'other_tool' }, result()] })
  await rejectsSearch({
    content: [
      {
        type: 'text',
        text: `Searched ${url}`,
        citations: [{ type: 'web_search_result_location', url }],
      },
    ],
  })
  await rejectsSearch({ content: [tool, result([])] })
  await rejectsSearch({
    content: [tool, result([{ type: 'web_search_result', url: 'http://127.0.0.1/secret' }])],
  })
})

test('HTTP 200 tool errors fail, while max-uses errors may retain preceding actual sources', async () => {
  for (const code of [
    'too_many_requests',
    'invalid_tool_input',
    'max_uses_exceeded',
    'unavailable',
    'unknown_error',
  ])
    await rejectsSearch({ content: [tool, errorBlock(code)] })
  const found = await fixture(response([errorBlock('max_uses_exceeded')])).search(
    'one person company',
  )
  assert.equal(found.length, 1)
  await rejectsSearch(response([errorBlock('unavailable')]))
  await rejectsSearch(response([errorBlock(undefined)]))
})

test('non-Claude models require protocol URL citations and never scrape links out of prose', async () => {
  const calls = [],
    content = 'Reliable source evidence'
  const web = createModelWebTools({
    model: 'gpt-search-fixture',
    call: async (request) => {
      calls.push(request)
      return {
        choices: [
          {
            message: {
              content,
              annotations: [
                {
                  type: 'url_citation',
                  url_citation: {
                    url,
                    title: 'Report',
                    start_index: 0,
                    end_index: content.length,
                  },
                },
              ],
            },
          },
        ],
      }
    },
  })
  const found = await web.search('one person company')
  assert.equal(calls[0].path, '/api/v1/chat/completions')
  assert.deepEqual(calls[0].body.web_search_options, { search_context_size: 'low' })
  assert.equal(calls[0].allowFallback, false)
  assert.equal(found[0].snippet, content)
  for (const message of [
    { content: `I searched ${url}` },
    { content, annotations: [{ type: 'text', url_citation: { url } }] },
    {
      content,
      annotations: [{ type: 'url_citation', url_citation: { url: 'http://169.254.169.254' } }],
    },
  ]) {
    const invalid = createModelWebTools({
      model: 'other',
      call: async () => ({ choices: [{ message }] }),
    })
    await assert.rejects(invalid.search('query'), /未返回可验证的联网结果/)
  }
})

test('model search caps queries, returned sources and field lengths while maintaining stable source IDs', async () => {
  let calls = 0
  const web = createModelWebTools({
    model: 'claude-fixture',
    call: async () => {
      calls++
      return {
        content: [
          tool,
          result(
            Array.from({ length: 8 }, (_, i) => ({
              type: 'web_search_result',
              url: `${url}/${i}`,
              title: 't'.repeat(300),
            })),
          ),
          {
            type: 'text',
            citations: [
              { type: 'web_search_result_location', url: `${url}/0`, cited_text: 's'.repeat(3000) },
            ],
          },
        ],
      }
    },
  })
  const first = await web.search('first')
  assert.equal(first.length, 5)
  assert.equal(first[0].title.length, 200)
  assert.equal(first[0].snippet.length, 2000)
  assert.equal(web.sources.size, 5)
  const second = await web.search('second')
  assert.equal(second[0].id, first[0].id)
  await web.search('third')
  await assert.rejects(web.search('fourth'), /3 次搜索上限/)
  assert.equal(calls, 3)
})

test('model search does not retry failures or accept malformed queries', async () => {
  let calls = 0
  const web = createModelWebTools({
    model: 'claude-fixture',
    call: async () => {
      calls++
      throw new Error('private upstream detail')
    },
  })
  await assert.rejects(web.search('query'), /现有模型服务状态/)
  assert.equal(calls, 1)
  await assert.rejects(web.search('x'.repeat(301)), /搜索词不正确/)
  await assert.rejects(web.search(' '), /搜索词不正确/)
  assert.equal(calls, 1)
})

test('reader reuses public-page boundary, allows only discovered sources and caps reads', async () => {
  const reads = []
  const web = createModelWebTools({
    model: 'claude-fixture',
    call: async () => response(),
    reader: async (value) => {
      reads.push(value)
      return { url: 'https://example.com/final', text: 'actual page body' }
    },
  })
  await web.search('query')
  for (let i = 0; i < 6; i++) {
    const page = await web.read(url)
    assert.equal(page.read, true)
    assert.equal(page.text, 'actual page body')
    assert.equal(page.finalUrl, 'https://example.com/final')
  }
  await assert.rejects(web.read(url), /6 次网页读取上限/)
  assert.equal(reads.length, 6)
  const other = fixture(response())
  await other.search('query')
  await assert.rejects(other.read('https://example.com/not-discovered'), /本次搜索/)
  await assert.rejects(other.read('http://127.0.0.1/'), /公开网页/)
  const badRedirect = createModelWebTools({
    model: 'claude-fixture',
    call: async () => response(),
    reader: async () => ({
      url: 'http://127.0.0.1/',
      text: 'internal page',
    }),
  })
  await badRedirect.search('query')
  await assert.rejects(badRedirect.read(url), /公开正文/)
  assert.equal(badRedirect.sources.get(url).read, false)
})
