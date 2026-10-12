import { describe, expect, it, vi } from 'vitest'
import { ChannelPublishRecordVo } from './publish-record.vo'

// Load the real enums without initializing unrelated decorated MongoDB schemas.
// eslint-disable-next-line @nx/enforce-module-boundaries
vi.mock('@yikart/mongodb', async () => import('../../../../../../../libs/mongodb/src/enums/publish.enum'))

describe('publish record source compatibility', () => {
  it('preserves existing Relay agent records alongside web records', () => {
    const records = ['agent', 'web'].map(source => ChannelPublishRecordVo.create({
      id: `record-${source}`,
      accountType: 'tiktok',
      type: 'video',
      status: 1,
      publishTime: new Date(),
      source,
    }))
    expect(records.map(record => record.source)).toEqual(['agent', 'web'])
  })

  it('still rejects unknown source values', () => {
    expect(() => ChannelPublishRecordVo.create({
      id: 'invalid-record',
      accountType: 'tiktok',
      type: 'video',
      status: 1,
      publishTime: new Date(),
      source: 'unknown-source',
    })).toThrow()
  })
})
