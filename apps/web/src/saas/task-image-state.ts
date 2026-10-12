import type { Task } from '../../../../packages/secretary/model.mjs'
export function unfinishedImage(task: Task) {
  return (
    task.dept === 'new-agent-7' &&
    task.status === 'completed' &&
    !task.images?.length &&
    /图片|生图|画图|绘制|插画|海报|视觉稿|参考图|设计稿|封面|配图|静态图|logo|illustration|poster|image|artwork|cover design/i.test(
      task.title,
    )
  )
}
