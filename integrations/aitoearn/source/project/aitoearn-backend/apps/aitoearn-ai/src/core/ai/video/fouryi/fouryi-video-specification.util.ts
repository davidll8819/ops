export function checkVideoSpecification(requested: { ratio: string, resolution: string }, actual: { width: number, height: number }) {
  const sizes: Record<string, Record<string, number[]>> = {
    '720p': { '9:16': [720, 1280], '16:9': [1280, 720], '1:1': [960, 960] },
    '1080p': { '9:16': [1080, 1920], '16:9': [1920, 1080], '1:1': [1440, 1440] },
  }
  const size = sizes[requested.resolution]?.[requested.ratio]
  return { requested, actual: { width: actual.width, height: actual.height }, matches: !!size && size[0] === actual.width && size[1] === actual.height }
}
