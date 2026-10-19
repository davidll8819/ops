import { useState } from 'react'
import type { ResultMedia } from './models'

export function VideoPreview({ item }: { item: ResultMedia }) {
  const [actual, setActual] = useState(item.specification?.actual)
  const spec = item.specification
  const differs =
    !!spec &&
    !!actual &&
    (actual.width !== spec.actual?.width || actual.height !== spec.actual?.height)
  return (
    <>
      <video
        controls
        preload="metadata"
        src={item.url}
        onLoadedMetadata={(event) => {
          const video = event.currentTarget
          setActual({ width: video.videoWidth, height: video.videoHeight })
        }}
      />
      {spec?.requested && (
        <p>
          要求：{spec.requested.ratio} · {spec.requested.resolution}
        </p>
      )}
      {actual && (
        <p>
          实际：{actual.width} × {actual.height}
        </p>
      )}
      {spec && (
        <p className={spec.matches && !differs ? 'muted' : 'error'} role="status">
          {spec.matches && !differs
            ? '视频规格验收通过'
            : '视频规格未通过，请核对成品；不会自动重新生成。'}
        </p>
      )}
    </>
  )
}
