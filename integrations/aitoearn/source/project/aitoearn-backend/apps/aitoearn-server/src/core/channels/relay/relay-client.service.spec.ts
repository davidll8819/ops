import { describe, expect, it, vi } from 'vitest'
import { RelayClientService } from './relay-client.service'

vi.mock('../../../config', () => ({ config: {
  assets: { endpoint: 'http://storage:9000', cdnEndpoint: 'http://localhost:8080/oss', bucketName: 'aitoearn' },
} }))
vi.mock('@yikart/mongodb', () => ({ AssetType: { PublishMedia: 'publishMedia' } }))

describe('relay media preparation', () => {
  it('uploads repeated local media once through internal storage and preserves public URLs', async () => {
    const client = new RelayClientService()
    const upload = vi.spyOn(client, 'uploadFileFromLocalUrl').mockResolvedValue('https://cdn.example.test/uploaded.mp4')
    const media = [{ url: 'http://localhost:8080/oss/user/video.mp4' }]
    const body = { content: { media }, items: [{ overrides: { media } }], cover: 'https://other.example.test/cover.png' }
    const result = await client.replaceLocalUrls(body)
    expect(upload).toHaveBeenCalledExactlyOnceWith('http://storage:9000/aitoearn/user/video.mp4')
    expect(result).toEqual({
      content: { media: [{ url: 'https://cdn.example.test/uploaded.mp4' }] },
      items: [{ overrides: { media: [{ url: 'https://cdn.example.test/uploaded.mp4' }] } }],
      cover: 'https://other.example.test/cover.png',
    })
    expect(body.content.media[0].url).toBe('http://localhost:8080/oss/user/video.mp4')
  })

  it('leaves external-only content unchanged without downloading it', async () => {
    const client = new RelayClientService()
    const upload = vi.spyOn(client, 'uploadFileFromLocalUrl')
    const body = { media: [{ url: 'https://other.example.test/video.mp4' }] }
    expect(await client.replaceLocalUrls(body)).toEqual(body)
    expect(upload).not.toHaveBeenCalled()
  })
})
