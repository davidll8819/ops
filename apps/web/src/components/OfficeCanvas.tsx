import type { OfficeWorkStatus } from '@/saas/office-work-status'
import { t, useLanguage } from '@/i18n'
import { useEffect, useRef, useState } from 'react'
import { OfficeScene, type OfficeAgentClick } from '@/scene/OfficeScene'
import type { Agent, AgentState } from '@/types/agent'
type AgentMenuState = {
  agent: Agent
  rosterNo: number
  x: number
  y: number
  agents: Agent[]
  pickingTarget: boolean
}
const STATE_ACTIONS: Array<{
  label: string
  state: AgentState
  task?: string
}> = [
  { label: t('开始工作'), state: 'working', task: t('处理当前任务…') },
  { label: t('进入思考'), state: 'thinking', task: t('思考下一步…') },
  { label: t('暂时空闲'), state: 'idle' },
]
const EMOTE_ACTIONS = [
  { label: t('生气'), animation: 'emotes/angry' },
  { label: t('打嗝'), animation: 'emotes/burp' },
  { label: t('困惑'), animation: 'emotes/confused' },
  { label: t('哭泣'), animation: 'emotes/crying' },
  { label: t('倒下'), animation: 'emotes/dead' },
  { label: t('坚定'), animation: 'emotes/determined' },
  { label: t('凝视'), animation: 'emotes/dramatic-stare' },
  { label: t('兴奋'), animation: 'emotes/excited' },
  { label: t('撒娇'), animation: 'emotes/fawning' },
  { label: t('脸红'), animation: 'emotes/flushed' },
  { label: t('欢呼'), animation: 'emotes/hooray' },
  { label: t('灵感'), animation: 'emotes/idea' },
  { label: t('刚刚好'), animation: 'emotes/just-right' },
  { label: t('大笑'), animation: 'emotes/laugh' },
  { label: t('喜欢'), animation: 'emotes/love' },
  { label: t('害怕'), animation: 'emotes/scared' },
  { label: t('遮眼'), animation: 'emotes/see-no-evil' },
  { label: t('耸肩'), animation: 'emotes/shrug' },
  { label: t('闷闷不乐'), animation: 'emotes/sulk' },
  { label: t('冒汗'), animation: 'emotes/sweat' },
  { label: t('思考表情'), animation: 'emotes/thinking' },
  { label: t('吐舌'), animation: 'emotes/tongue-out' },
  { label: t('挥手'), animation: 'emotes/wave' },
] as const
export function OfficeCanvas({
  workIndicators,
  automatic,
  onAutomaticChange,
  onOpenOperations,
  onOpenPerson,
}: {
  workIndicators: Record<string, OfficeWorkStatus>
  automatic: boolean
  onAutomaticChange: (value: boolean) => void
  onOpenOperations: () => void
  onOpenPerson: (id: string) => void
}) {
  useLanguage()
  const hostRef = useRef<HTMLDivElement>(null)
  const sceneRef = useRef<OfficeScene | null>(null)
  const [ready, setReady] = useState(false)
  useEffect(() => {
    sceneRef.current?.setWorkIndicators(workIndicators)
  }, [workIndicators, ready])
  const [error, setError] = useState('')
  const [generation, setGeneration] = useState(0)
  const [menu, setMenu] = useState<AgentMenuState | null>(null)
  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const handleAgentClick = (event: OfficeAgentClick) => {
      if (event.agent.id === 'app-agent') {
        setMenu(null)
        onOpenOperations()
        return
      }
      const rect = host.getBoundingClientRect()
      const menuWidth = 260
      const menuHeight = Math.min(520, rect.height - 24)
      setMenu({
        agent: event.agent,
        rosterNo: event.rosterNo,
        x: Math.max(12, Math.min(event.clientX - rect.left, rect.width - menuWidth - 12)),
        y: Math.max(12, Math.min(event.clientY - rect.top, rect.height - menuHeight - 12)),
        agents: sceneRef.current?.getAgents() ?? [],
        pickingTarget: false,
      })
    }
    let disposed = false
    let initializing = false
    let initialized = false
    const scene = new OfficeScene({ onAgentClick: handleAgentClick })
    sceneRef.current = scene
    const ro = new ResizeObserver((entries) => {
      const { width, height } = entries[0].contentRect
      if (width <= 0 || height <= 0) return
      if (!initializing) {
        initializing = true
        void scene
          .init(host, width, height)
          .then(() => {
            if (disposed) return
            initialized = true
            scene.resize(host.clientWidth, host.clientHeight)
            setReady(true)
          })
          .catch((cause: unknown) => {
            if (disposed) return
            scene.destroy()
            setError(cause instanceof Error ? cause.message : '办公室加载失败，请重试')
          })
        return
      }
      if (initialized) scene.resize(width, height)
    })
    ro.observe(host)
    return () => {
      ro.disconnect()
      disposed = true
      scene.destroy()
      sceneRef.current = null
    }
  }, [generation, onOpenOperations])
  useEffect(() => {
    sceneRef.current?.setAutomatic(automatic)
  }, [automatic, generation])
  useEffect(() => {
    const close = (event: PointerEvent) => {
      const target = event.target
      if (target instanceof Element && target.closest('.agent-action-menu')) {
        return
      }
      setMenu(null)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMenu(null)
    }
    document.addEventListener('pointerdown', close)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', close)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [])
  const manualControl = () => {
    onAutomaticChange(false)
    sceneRef.current?.setAutomatic(false)
    sceneRef.current?.setPaused(false)
  }
  const applyState = (state: AgentState, task?: string) => {
    if (!menu) return
    manualControl()
    sceneRef.current?.setAgentState(menu.agent.id, state, task)
    setMenu(null)
  }
  const playEmote = (animation: string, label: string) => {
    if (!menu) return
    manualControl()
    sceneRef.current?.playAgentAnimation(menu.agent.id, animation, label)
    setMenu(null)
  }
  const startInteraction = (targetRosterNo: number, targetName: string) => {
    if (!menu || targetRosterNo === menu.rosterNo) return
    manualControl()
    sceneRef.current?.requestDeskVisit(
      menu.rosterNo,
      targetRosterNo,
      `${targetName}, ${t('我来和你同步一下。')}`,
    )
    setMenu(null)
  }
  return (
    <div className="office-scene-shell">
      <button
        className="office-interaction-compact"
        aria-pressed={automatic}
        title={t('关闭后停止新的自动互动，当前交流完成后回座。')}
        onClick={() => onAutomaticChange(!automatic)}
      >
        {t(automatic ? '关闭互动' : '开启互动')}
      </button>
      <div ref={hostRef} className="office-canvas" aria-label={t('办公室角色动画')}>
        {!ready && (
          <div className="scene-loading" role="status">
            <p>{t(error || '正在加载办公室…')}</p>
            {error && (
              <button
                onClick={() => {
                  setError('')
                  setReady(false)
                  setGeneration((n) => n + 1)
                }}
              >
                {t('重新加载场景')}
              </button>
            )}
          </div>
        )}
        {menu && (
          <div
            className="agent-action-menu"
            role="dialog"
            aria-label={`${menu.agent.name} · ${t('角色动作')}`}
            style={{ left: menu.x, top: menu.y }}
          >
            <button
              className="agent-action-btn"
              onClick={() => {
                onOpenPerson(menu.agent.id)
                setMenu(null)
              }}
            >
              {t('打开部门工作台')}
            </button>
            <div className="agent-action-head">
              <span className="agent-action-name">{menu.agent.name}</span>
              <span className="agent-action-state">{t(menu.agent.state)}</span>
            </div>

            {!menu.pickingTarget ? (
              <>
                <div className="agent-action-group">
                  <div className="agent-action-section-title">{t('互动')}</div>
                  <button
                    type="button"
                    className="agent-action-btn"
                    onClick={() =>
                      setMenu((current) =>
                        current ? { ...current, pickingTarget: true } : current,
                      )
                    }
                  >
                    {t('互动…')}
                  </button>
                </div>

                <div className="agent-action-group">
                  <div className="agent-action-section-title">{t('状态')}</div>
                  {STATE_ACTIONS.map((action) => (
                    <button
                      key={t(action.label)}
                      type="button"
                      className="agent-action-btn"
                      onClick={() => applyState(action.state, action.task)}
                    >
                      {t(action.label)}
                    </button>
                  ))}
                </div>

                <div className="agent-action-group">
                  <div className="agent-action-section-title">{t('表情动作')}</div>
                  <div className="agent-emote-grid">
                    {EMOTE_ACTIONS.map((action) => (
                      <button
                        key={action.animation}
                        type="button"
                        className="agent-action-chip"
                        onClick={() => playEmote(action.animation, action.label)}
                      >
                        {t(action.label)}
                      </button>
                    ))}
                  </div>
                </div>
              </>
            ) : (
              <div className="agent-action-group">
                <div className="agent-action-section-title">{t('选择互动对象')}</div>
                <button
                  type="button"
                  className="agent-action-btn subtle"
                  onClick={() =>
                    setMenu((current) => (current ? { ...current, pickingTarget: false } : current))
                  }
                >
                  {t('返回动作')}
                </button>
                {menu.agents
                  .map((agent, index) => ({ agent, rosterNo: index + 1 }))
                  .filter(({ agent }) => agent.id !== menu.agent.id)
                  .map(({ agent, rosterNo }) => (
                    <button
                      key={agent.id}
                      type="button"
                      className="agent-action-btn"
                      onClick={() => startInteraction(rosterNo, agent.name)}
                    >
                      {t('和')}
                      {agent.name}
                      {t('互动')}
                    </button>
                  ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
