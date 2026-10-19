import test from 'node:test'
import assert from 'node:assert/strict'
import { employeeModels } from '../apps/api/src/employee-profiles.mjs'
import { defaultPolicy } from '../apps/api/src/operations/policy.mjs'
import { departmentMap, departmentRoster } from '../apps/api/src/secretary-execution.mjs'

test('employee model view resolves independent search routes and department overrides', () => {
  const policy = defaultPolicy()
  policy.tiers.strong = 'company-reasoning'
  policy.tiers.search = 'company-search'
  policy.tiers.fast = 'company-fast'
  policy.departments.market_research = {
    ...policy.departments.market_research,
    enabled: true,
    tier: 'strong',
    model: 'research-text',
    fallback: 'fast',
    capabilities: {
      search: { enabled: true, model: 'research-search' },
      image: { enabled: false, model: '' },
      video: { enabled: false, model: '' },
    },
  }
  const view = employeeModels(policy, 'market_research', true)
  assert.deepEqual(view.text, {
    enabled: true,
    configured: true,
    model: 'research-text',
    fallback: 'company-fast',
    source: 'department',
  })
  assert.deepEqual(view.search, {
    enabled: true,
    configured: true,
    model: 'research-search',
    fallback: '',
    source: 'department',
  })
  assert.equal(view.image.configured, false)
  policy.departments.market_research.model = ''
  policy.departments.market_research.capabilities.search.model = ''
  const inherited = employeeModels(policy, 'market_research', true)
  assert.equal(inherited.text.model, 'company-reasoning')
  assert.equal(inherited.text.source, 'company')
  assert.equal(inherited.search.model, 'company-search')
})

test('employee profiles never mark missing credentials or disabled departments configured', () => {
  const policy = defaultPolicy()
  policy.departments.dev = { ...policy.departments.dev, enabled: true, model: 'dev-model' }
  assert.equal(employeeModels(policy, 'dev', false).text.configured, false)
  assert.equal(employeeModels(policy, 'dev', true).text.configured, true)
  policy.departments.dev.enabled = false
  assert.equal(employeeModels(policy, 'dev', true).text.model, '')
  assert.equal(employeeModels(undefined, 'dev', false).text.configured, false)
})

test('existing persisted tasks still address the same office character numbers', () => {
  for (const [id, key, rosterNo] of [
    ['code-agent', 'dev', 2],
    ['file-agent', 'archive', 3],
    ['app-agent', 'content_ops', 4],
    ['review-agent', 'market_research', 5],
    ['data-agent', 'compliance', 6],
    ['new-agent-7', 'design', 7],
    ['new-agent-8', 'outreach', 8],
    ['new-agent-9', 'intern', 9],
  ]) {
    assert.equal(departmentMap[id], key)
    assert.equal(departmentRoster[departmentMap[id]], rosterNo)
  }
  assert.equal(departmentMap.marvis, undefined)
})
