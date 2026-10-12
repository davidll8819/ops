import { t } from '@/i18n'
import type { Task } from '../../../../packages/secretary/model.mjs'
export function TaskImages({ task, base }: { task: Task; base: string }) {
  if (!task.images?.length) return null
  return (
    <section className="task-images" aria-label={t('生成的图片')}>
      {task.images.map((image) => (
        <figure key={image.fileId}>
          <a
            href={`${base}/files/${image.fileId}/preview`}
            target="_blank"
            rel="noopener noreferrer"
          >
            <img src={`${base}/files/${image.fileId}/preview`} alt={task.title} loading="lazy" />
          </a>
          <figcaption>
            <span>{image.name}</span>
            <a href={`${base}/files/${image.fileId}/download`} download>
              {t('下载图片')}
            </a>
          </figcaption>
        </figure>
      ))}
    </section>
  )
}
