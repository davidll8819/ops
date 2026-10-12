import type { Agent } from '@/types/agent'

export type AutoWorkflowStep = { visitor: number; host: number; message: string }
export const AUTO_WORKFLOW_MAX_ACTIVE = 2
export const AUTO_WORKFLOW_INTERVAL = 1.2

export const AUTO_WORKFLOW_STEPS: AutoWorkflowStep[] = [
  { visitor: 1, host: 2, message: '新的任务来了，先帮我扫一下信息源。' },
  { visitor: 7, host: 5, message: '这版视觉做好了，一起看看效果吧。' },
  { visitor: 8, host: 9, message: '我来和你打个招呼，有需要一起搭把手。' },
  { visitor: 9, host: 3, message: '我把资料送过来了，麻烦帮忙收一下。' },
  { visitor: 2, host: 3, message: '资料已经找到，麻烦整理一下。' },
  { visitor: 3, host: 4, message: '这份可以进入撰写了。' },
  { visitor: 4, host: 6, message: '初稿好了，请帮忙审一下。' },
  { visitor: 6, host: 4, message: '这里需要改一版，我标了重点。' },
  { visitor: 5, host: 1, message: '市场简报已经打包，请看一下。' },
  { visitor: 1, host: 5, message: '同步一下调研方向，准备发给团队。' },
  { visitor: 3, host: 6, message: '归档完成，合规队列可以接手。' },
  { visitor: 2, host: 5, message: '这些来源适合市场情报线。' },
  { visitor: 4, host: 1, message: '修改稿已完成，等你签批。' },
  { visitor: 4, host: 7, message: '文案整理好了，我们一起配一下版式。' },
  { visitor: 1, host: 8, message: '来同步一下今天的安排，慢慢熟悉就好。' },
  { visitor: 5, host: 9, message: '有个小任务想听听你的看法。' },
]

/** Only dispatch a pair when neither person is walking, visiting or in a manual pose. */
export function nextWorkflowStep(agents: Agent[], startIndex: number, counts: readonly number[]) {
  const busyIds = new Set<string>()
  for (const agent of agents) {
    if (agent.mission) {
      busyIds.add(agent.id)
      busyIds.add(agent.mission.hostAgentId)
    }
    if (agent.state === 'walking' || agent.customAnimation) busyIds.add(agent.id)
  }
  let candidate: { step: AutoWorkflowStep; index: number; nextIndex: number } | null = null
  for (let i = 0; i < AUTO_WORKFLOW_STEPS.length; i++) {
    const index = (startIndex + i) % AUTO_WORKFLOW_STEPS.length
    const step = AUTO_WORKFLOW_STEPS[index]
    const visitor = agents[step.visitor - 1]
    const host = agents[step.host - 1]
    if (visitor && host && visitor.id !== host.id && !busyIds.has(visitor.id) && !busyIds.has(host.id)) {
      // Prefer interactions that have happened least often, keeping skipped
      // visits eligible instead of letting busy colleagues miss every cycle.
      if (!candidate || (counts[index] ?? 0) < (counts[candidate.index] ?? 0)) {
        candidate = { step, index, nextIndex: (index + 1) % AUTO_WORKFLOW_STEPS.length }
      }
    }
  }
  return candidate
}
