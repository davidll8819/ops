// Local planning only: this module never invokes a model, worker, or publication channel.
export const departments = [
  { id: 'app-agent', name: '内容运营部', en: 'Content operations', person: '叶凡' },
  { id: 'review-agent', name: '市场调研部', en: 'Market research', person: '刘市' },
  { id: 'new-agent-7', name: '设计部', en: 'Design', person: '林幼薇' },
  { id: 'code-agent', name: '开发部', en: 'Development', person: '龙傲天' },
  { id: 'file-agent', name: '资料部', en: 'Records', person: '赵雅梦' },
  { id: 'data-agent', name: '合规部', en: 'Compliance', person: '派阿奇' },
  { id: 'new-agent-8', name: '拓客部', en: 'Outreach', person: '西罗' },
  { id: 'new-agent-9', name: '实习生', en: 'Intern', person: '实习生' },
]
export const emptyBoard = () => ({ messages: [], tasks: [], batches: [] })
const error = (message) => {
  throw Object.assign(new Error(message), { statusCode: 409, expose: true })
}
export function applyAction(previous, action, { id, today, time }) {
  const board = structuredClone(previous)
  const reply = (text, textEn, batchId) =>
    board.messages.push({ id: id(), role: 'assistant', text, textEn, batchId, time })
  if (action.type === 'send') {
    const text = action.text.trim()
    board.messages.push({ id: id(), role: 'user', text, time })
    if (action.intent === 'report') {
      const queued = board.tasks.filter((t) => t.status === 'queued').length
      const waiting = board.tasks.filter((t) => t.status === 'approval').length
      reply(
        `当前有 ${queued} 项已派发待执行、${waiting} 项待确认。执行服务尚未连接，我会保留任务记录，接通后再同步真实进度。`,
        `${queued} tasks are queued and ${waiting} await approval. Execution is not connected; task records are saved for the future runtime.`,
      )
    } else if (action.intent === 'remind') {
      reply(
        '已记录本次催办请求。当前尚未连接部门执行与通知服务，因此还没有发出提醒。',
        'Reminder request recorded. Department execution and notifications are not connected, so no reminder has been sent.',
      )
    } else {
      if (board.tasks.filter((t) => t.status === 'draft').length >= 40)
        error('请先处理已有任务草稿')
      const batchId = id()
      const english = action.language === 'en'
      const video = /视频|宣传|video|campaign/i.test(text)
      const rules = [
        [
          'app-agent',
          /文案|视频|运营|内容|video|copy|content|campaign/i,
          '制作文案与视频',
          'Create copy and video',
        ],
        [
          'review-agent',
          /调研|分析|评估|research|analy[sz]|report/i,
          '调研并形成综合报告',
          'Research and prepare a report',
        ],
        [
          'new-agent-7',
          /设计|视觉|参考图|海报|design|visual|image/i,
          '准备视觉与参考素材',
          'Prepare visuals and references',
        ],
        [
          'code-agent',
          /开发|编程|程序|问题|代码|develop|code|bug|software/i,
          '开发并排查问题',
          'Develop and investigate issues',
        ],
        [
          'file-agent',
          /归档|资料|整理|表格|archive|document|spreadsheet/i,
          '整理资料并归档',
          'Organize and archive records',
        ],
        [
          'data-agent',
          /合规|风险|审核|compliance|risk|review/i,
          '核对规范与风险',
          'Review compliance and risks',
        ],
        [
          'new-agent-8',
          /拓客|客户|线索|customer|lead|outreach/i,
          '整理目标客户线索',
          'Find potential customers',
        ],
        [
          'new-agent-9',
          /实习生|\bintern\b/i,
          '协助部门日常工作',
          'Assist with departmental work',
        ],
      ]
      let selected = rules.filter(
        (r) => r[1].test(text) || (video && ['new-agent-7', 'data-agent'].includes(r[0])),
      )
      if (!selected.length)
        selected = [
          [
            'file-agent',
            null,
            '梳理需求与所需资料',
            'Clarify requirements and supporting information',
          ],
        ]
      if (action.intent === 'meeting')
        selected = [
          [
            'file-agent',
            null,
            '整理会议议题与参会部门',
            'Prepare agenda and participating departments',
          ],
        ]
      const matchedDate = text.match(/\b\d{4}-\d{2}-\d{2}\b/)?.[0]
      const due =
        matchedDate &&
        !Number.isNaN(Date.parse(matchedDate)) &&
        new Date(matchedDate).toISOString().slice(0, 10) === matchedDate
          ? matchedDate
          : today
      for (const [dept, , zh, en] of selected)
        board.tasks.push({
          id: id(),
          batchId,
          dept,
          title: english ? en : zh,
          titleEn: en,
          titleZh: zh,
          due,
          status: 'draft',
          summary: text,
          publishRequired:
            /发布|抖音|对外|publish|post|release/i.test(text) && dept === 'app-agent',
        })
      board.batches.push({ id: batchId, status: 'draft' })
      reply(
        `收到。我拆成了 ${selected.length} 个任务，发布前都会先给你确认：`,
        `Received. I drafted ${selected.length} tasks. Anything intended for publication will need your approval first:`,
        batchId,
      )
    }
  } else if (action.type === 'edit') {
    const batch = board.batches.find((b) => b.id === action.batchId)
    if (!batch || batch.status !== 'draft') error('这组任务已更新，请刷新后查看')
    const current = board.tasks.filter((t) => t.batchId === batch.id)
    if (
      action.tasks.length !== current.length ||
      new Set(action.tasks.map((t) => t.id)).size !== current.length ||
      action.tasks.some((t) => !current.some((c) => c.id === t.id))
    )
      error('任务列表不匹配')
    if(action.tasks.some(item=>current.some(t=>t.id===item.id&&t.engine==='research-v1'&&t.dept!==item.dept))) error('调研链路的部门分工已绑定，请重新生成任务来更换部门')
    for (const item of action.tasks)
      Object.assign(
        current.find((t) => t.id === item.id),
        {
          title: item.title.trim(),
          titleEn: undefined,
          titleZh: undefined,
          dept: item.dept,
          due: item.due,
        },
      )
  } else if (action.type === 'dispatch') {
    const batch = board.batches.find((b) => b.id === action.batchId)
    if (!batch || batch.status !== 'draft') error('这组任务已更新，请刷新后查看')
    batch.status = 'queued'
    for (const task of board.tasks.filter((t) => t.batchId === batch.id)) task.status = 'queued'
    reply(
      '已确认分工。调研任务由后台执行，实际进度会更新在任务卡片中；其他部门按已接入的能力处理。',
      'Assignments confirmed. Research runs in the background; task cards show actual progress. Other departments use their connected capabilities.',
    )
  } else if (action.type === 'approve' || action.type === 'reject') {
    const task = board.tasks.find((t) => t.id === action.taskId)
    if (!task || task.status !== 'approval' || !task.publishRequired)
      error('此任务当前无需发布审批')
    task.status = action.type === 'approve' ? 'authorized' : 'revision'
    task.feedback = action.feedback || ''
    reply(
      action.type === 'approve'
        ? '发布许可已记录。发布渠道尚未接通，内容尚未发出。'
        : '已记录退回修改意见，等待部门执行服务接收。',
      action.type === 'approve'
        ? 'Publication authorized. No channel is connected and nothing has been published.'
        : 'Revision feedback recorded, awaiting the department execution service.',
    )
  }
  const pendingBatches = new Set(
    board.batches.filter((batch) => batch.status === 'draft').map((batch) => batch.id),
  )
  // Keep undecided drafts reachable even after a long progress/reminder conversation.
  board.messages = board.messages.filter(
    (message, index) => index >= board.messages.length - 100 || pendingBatches.has(message.batchId),
  )
  return board
}
export function exampleBoard(today) {
  return {
    messages: [
      {
        id: 'example-user',
        role: 'user',
        text: '这周帮公司做一条宣传视频，先做参考图，发布前给我确认。',
        textEn:
          'Create a company promo video this week. Start with visual references and ask me before publishing.',
      },
      {
        id: 'example-reply',
        role: 'assistant',
        text: '收到。我拆成了 3 个任务，发布前都会先给你确认：',
        textEn:
          'Received. I drafted 3 tasks. I will ask for your approval before anything is published.',
        batchId: 'example-batch',
      },
    ],
    batches: [{ id: 'example-batch', status: 'draft' }],
    tasks: [
      {
        id: 'example-copy',
        batchId: 'example-batch',
        title: '制作公司宣传视频',
        titleEn: 'Create the company promo video',
        dept: 'app-agent',
        due: today,
        status: 'draft',
        publishRequired: true,
        summary: '制作一条 30 秒公司宣传视频，突出产品价值。',
      },
      {
        id: 'example-design',
        batchId: 'example-batch',
        title: '设计分镜与参考图',
        titleEn: 'Design storyboard and references',
        dept: 'new-agent-7',
        due: today,
        status: 'draft',
        publishRequired: false,
        summary: '为宣传视频提供视觉参考与分镜。',
      },
      {
        id: 'example-review',
        batchId: 'example-batch',
        title: '审核文案与发布规范',
        titleEn: 'Review copy and publishing rules',
        dept: 'data-agent',
        due: today,
        status: 'draft',
        publishRequired: false,
        summary: '核对宣传措辞、素材授权与平台规范。',
      },
      {
        id: 'example-approval',
        title: '产品介绍短视频 · 第一期',
        titleEn: 'Product video · Episode 01',
        dept: 'app-agent',
        due: today,
        status: 'approval',
        publishRequired: true,
        summary: '示例审批卡：拟发布到抖音的 30 秒产品介绍短片。这里没有真实视频附件或发布连接。',
      },
      {
        id: 'example-report',
        title: '同类产品市场调研报告',
        titleEn: 'Competitive market report',
        dept: 'review-agent',
        due: today,
        status: 'review',
        publishRequired: false,
        summary: '示例报告：对比产品定位、目标用户与定价维度。实际调研数据接入后在此查看。',
      },
      {
        id: 'example-working',
        title: '整理本周运营资料',
        titleEn: 'Organize weekly operations files',
        dept: 'file-agent',
        due: today,
        status: 'working',
        publishRequired: false,
        summary: '示例任务，用于预览归档中的部门状态。',
      },
    ],
  }
}
