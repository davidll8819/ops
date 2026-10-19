import test from 'node:test'
import assert from 'node:assert/strict'
import { toolCompatibleRequest } from '../apps/api/src/operations/gateway.mjs'

test('Luna function calls explicitly disable incompatible default reasoning without changing plain chat or search', () => {
  const tool = { type: 'function', function: { name: 'workspace_list_files' } }
  const input = { model: 'gpt-5.6-luna', tools: [tool], messages: [{ role: 'user', content: 'test' }] }
  assert.equal(toolCompatibleRequest(input).reasoning_effort, 'none')
  assert.equal(input.reasoning_effort, undefined)
  for (const body of [
    { model: 'gpt-5.6-luna', messages: input.messages, reasoning_effort: 'high' },
    { model: 'gpt-5.6-luna', tools: [{ type: 'web_search_preview' }] },
    { model: 'other-model', tools: [tool], reasoning_effort: 'high' },
  ]) assert.strictEqual(toolCompatibleRequest(body), body)
  const fallback = { ...input, model: 'claude-haiku-4.5' }
  assert.equal(toolCompatibleRequest(fallback).reasoning_effort, undefined)
})
