import { checkVideoSpecification } from './fouryi-video-specification.util'

describe('checkVideoSpecification', () => {
  it.each([
    ['9:16', '720p', 720, 1280, true],
    ['9:16', '1080p', 1080, 1920, true],
    ['16:9', '720p', 1280, 720, true],
    ['1:1', '720p', 960, 960, true],
    ['9:16', '720p', 1920, 1080, false],
    ['9:16', '720p', 1080, 1920, false],
  ])('checks requested %s %s against real %s x %s', (ratio, resolution, width, height, matches) => {
    expect(checkVideoSpecification({ ratio, resolution }, { width, height })).toEqual({ requested: { ratio, resolution }, actual: { width, height }, matches })
  })
})
