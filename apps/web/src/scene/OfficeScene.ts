import type { OfficeWorkStatus } from '@/saas/office-work-status'
import { t } from '@/i18n'
import { Application, Container, Sprite } from 'pixi.js'
import type { FederatedPointerEvent } from 'pixi.js'
import type { Agent, AgentState } from '@/types/agent'
import {
  AGENT_ROSTER,
  COLORS,
  DESKS,
  INITIAL_AGENTS,
  pickHandoffVisitMessage,
  SCENE_WIDTH,
} from '@/scene/layout/officeLayout'
import { AgentEntity } from '@/scene/entities/AgentEntity'
import { DeskEntity } from '@/scene/entities/DeskEntity'
import {
  MovementSystem,
  isHomeDeskSeat,
} from '@/scene/systems/MovementSystem'
import { AnimationSystem } from '@/scene/systems/AnimationSystem'
import { OfficeSimulator } from '@/scene/simulation/OfficeSimulator'
import { AUTO_WORKFLOW_MAX_ACTIVE, AUTO_WORKFLOW_INTERVAL, nextWorkflowStep } from '@/scene/simulation/autoWorkflow'
import { startReturnToDesk } from '@/scene/simulation/deskVisit'
import { bindOfficeScene, unbindOfficeScene } from '@/scene/officeSceneBridge'
import {
  hasPendingVisitQueue,
  resetVisitDispatcher,
  notifyVisitMissionActivity,
} from '@/services/officeActionDispatcher'
import { setOfficeAgents } from '@/store/officeStore'
import {
  getOfficeBackgroundTexture,
  loadOfficeAssets,
} from '@/scene/assets/loadOfficeAssets'
import { loadSpineAssets } from '@/scene/assets/loadSpineAssets'

export type OfficeAgentClick = {
  agent: Agent
  rosterNo: number
  clientX: number
  clientY: number
}

export class OfficeScene {
  private disposed = false
  private workIndicators: Record<string, OfficeWorkStatus> = {}
  private paused = false
  private automatic = false
  private app: Application | null = null
  private world: Container | null = null
  private roomBackground: Sprite | null = null
  private agentEntities = new Map<string, AgentEntity>()
  private deskEntities = new Map<string, DeskEntity>()
  private officeLayer: Container | null = null

  private movement = new MovementSystem()
  private animation = new AnimationSystem()
  private simulator = new OfficeSimulator()

  private agents: Agent[] = INITIAL_AGENTS.map((a) => ({ ...a }))
  private autoWorkflowTimer = 0.8
  private autoWorkflowIndex = 0
  private autoWorkflowCounts: number[] = []
  private readonly options: {
    onAgentClick?: (event: OfficeAgentClick) => void
  }

  constructor(options: { onAgentClick?: (event: OfficeAgentClick) => void } = {}) {
    this.options = options
  }

  async init(container: HTMLElement, width: number, height: number) {
    const app = new Application()
    await app.init({
      width,
      height,
      backgroundColor: COLORS.floor,
      antialias: true,
      preference: 'webgl',
      resolution: Math.min(window.devicePixelRatio || 1, 2),
      autoDensity: true,
    })

    if (this.disposed) {
      app.destroy(true, { children: true })
      return
    }
    this.app = app
    container.appendChild(app.canvas)

    this.world = new Container()
    app.stage.addChild(this.world)
    this.fitStage(width, height)

    const spineOk = await loadSpineAssets()
    if (this.disposed) return
    if (!spineOk) throw new Error('角色模型加载失败，请重新加载场景')
    const officeOk = await loadOfficeAssets()
    if (this.disposed) return
    if (!officeOk) {
      console.error(
        '[Office] desk.png / chair.png 加载失败，工位将使用矢量占位图。请检查 public/assets/office/ 并硬刷新。',
      )
    }

    this.drawMap()
    this.spawnOffice(this.world)
    this.fitStage(app.screen.width, app.screen.height)
    this.pushDataToEntities()

    app.ticker.add(this.onTick)
    bindOfficeScene(this)
  }

  /** 名册序号从 1 开始：visitor 去找 host 说一句话后回座继续工作 */
  requestDeskVisit(
    visitorRosterNo: number,
    hostRosterNo: number,
    message: string,
  ) {
    this.agents = this.simulator.startDeskVisit(
      this.agents,
      visitorRosterNo,
      hostRosterNo,
      message,
    )
    this.pushDataToEntities()
  }

  /** 按顺序拜访多个工位，全部说完后回访客工位 */
  requestDeskVisitTour(
    visitorRosterNo: number,
    hostRosterNos: number[],
    messageFn?: (hostRosterNo: number, hostName: string) => string,
  ) {
    this.agents = this.simulator.startDeskVisitTour(
      this.agents,
      visitorRosterNo,
      hostRosterNos,
      messageFn ?? ((hostNo, hostName) => pickHandoffVisitMessage(hostName, hostNo)),
    )
    this.pushDataToEntities()
  }

  setWorkIndicators(indicators: Record<string, OfficeWorkStatus>) {
    this.workIndicators = indicators
    for (const [id, entity] of this.agentEntities) entity.setWorkStatus(indicators[id])
  }

  getAgents(): Agent[] {
    return this.agents.map((agent) => ({ ...agent }))
  }

  setAgentState(id: string, state: AgentState, task?: string) {
    const current = this.agents.find((a) => a.id === id)
    if (!current) return

    // 离座小人：先走回座位，到位后再落入目标状态（避免被钉座位瞬移）
    if (!isHomeDeskSeat(current.assignedDeskId, current.x, current.y)) {
      this.agents = startReturnToDesk(this.agents, id, {
        landingState: state,
        task,
      })
      this.agentEntities.get(id)?.hideBubble()
      setOfficeAgents(this.agents)
      this.pushDataToEntities()
      return
    }

    this.agents = this.agents.map((agent) => {
      if (agent.id !== id) return agent
      return {
        ...agent,
        state,
        currentTask: task,
        targetX: undefined,
        targetY: undefined,
        walkPath: undefined,
        walkPathIndex: undefined,
        mission: undefined,
        bubbleText: undefined,
        customAnimation: undefined,
        viewFacing:
          state === 'working' || state === 'thinking'
            ? ('back' as const)
            : agent.viewFacing,
      }
    })
    setOfficeAgents(this.agents)
    this.pushDataToEntities()
  }

  playAgentAnimation(id: string, animation: string, task?: string) {
    const current = this.agents.find((a) => a.id === id)
    if (!current) return

    // 离座小人：先走回座位，到位后再播放表情（避免被钉座位瞬移）
    if (!isHomeDeskSeat(current.assignedDeskId, current.x, current.y)) {
      this.agents = startReturnToDesk(this.agents, id, {
        landingAnimation: animation,
        task,
      })
      this.agentEntities.get(id)?.hideBubble()
      setOfficeAgents(this.agents)
      this.pushDataToEntities()
      return
    }

    this.agents = this.agents.map((agent) => {
      if (agent.id !== id) return agent
      return {
        ...agent,
        state: 'talking' as const,
        currentTask: task,
        targetX: undefined,
        targetY: undefined,
        walkPath: undefined,
        walkPathIndex: undefined,
        mission: undefined,
        bubbleText: undefined,
        customAnimation: animation,
        viewFacing: 'front' as const,
        facing: 1 as const,
      }
    })
    setOfficeAgents(this.agents)
    this.pushDataToEntities()
    this.agentEntities.get(id)?.playCustomAnimation(animation, task)
    this.pullDataFromEntities()
    setOfficeAgents(this.agents)
  }

  setPaused(paused: boolean) {
    this.paused = paused
  }

  setAutomatic(automatic: boolean) {
    if (automatic && !this.automatic) {
      // Resume all colleagues, including those left in a manual looping emote.
      this.agents = this.agents.map(agent => {
        const task = AGENT_ROSTER.find(entry => entry.id === agent.id)?.task
        if (agent.mission?.landingAnimation) {
          return { ...agent, mission: { ...agent.mission,
            landingAnimation: undefined, landingState: 'working' as const, resumeTask: task ?? '',
          } }
        }
        if (!agent.customAnimation) return agent
        return { ...agent, customAnimation: undefined, state: 'working' as const,
          currentTask: task, viewFacing: 'back' as const }
      })
      this.autoWorkflowTimer = 0.8
      this.pushDataToEntities()
      setOfficeAgents(this.agents)
    }
    this.automatic = automatic
  }

  reset() {
    resetVisitDispatcher()
    this.agents = INITIAL_AGENTS.map(agent => ({ ...agent,
      targetX: undefined, targetY: undefined, walkPath: undefined,
      walkPathIndex: undefined, mission: undefined, bubbleText: undefined,
      customAnimation: undefined,
    }))
    this.autoWorkflowIndex = 0
    this.autoWorkflowCounts = []
    this.autoWorkflowTimer = 0.8
    this.paused = false
    for (const entity of this.agentEntities.values()) entity.hideBubble()
    this.pushDataToEntities()
    setOfficeAgents(this.agents)
  }

  resize(containerWidth: number, containerHeight: number) {
    if (!this.app || !this.world) return
    this.app.renderer.resize(containerWidth, containerHeight)
    this.fitStage(containerWidth, containerHeight)
  }

  /** The room fills the viewport; the foreground retains its original proportions. */
  private fitStage(containerWidth: number, containerHeight: number) {
    if (!this.world) return

    const scale = Math.min(
      containerWidth / 720,
      containerHeight / 570,
    )
    const offsetX = (containerWidth - SCENE_WIDTH * scale) / 2
    const offsetY = (containerHeight - 570 * scale) / 2 - 30 * scale

    this.world.scale.set(scale)
    this.world.position.set(offsetX, offsetY)

    // Crop only the transparent border of the room asset. The backdrop adapts
    // to the panel aspect ratio independently of the Spine models and desks.
    if (this.roomBackground) {
      const roomFrame = { x: 180, y: 100, width: 1030, height: 930 }
      this.roomBackground.scale.set(
        containerWidth / roomFrame.width,
        containerHeight / roomFrame.height,
      )
      this.roomBackground.position.set(
        -roomFrame.x * containerWidth / roomFrame.width,
        -roomFrame.y * containerHeight / roomFrame.height,
      )
    }

    const canvas = this.app?.canvas as HTMLCanvasElement | undefined
    if (!canvas) return
    canvas.style.display = 'block'
    canvas.style.width = '100%'
    canvas.style.height = '100%'
    canvas.style.maxWidth = '100%'
    canvas.style.maxHeight = '100%'
  }

  destroy() {
    this.disposed = true
    unbindOfficeScene(this)
    this.app?.ticker.remove(this.onTick)
    this.app?.destroy(true, { children: true })
    this.app = null
    this.agentEntities.clear()
    this.deskEntities.clear()
    this.officeLayer = null
    this.roomBackground = null
  }

  private onTick = (ticker: { deltaTime: number }) => {
    if (this.paused || this.disposed) return
    const dt = Math.min(ticker.deltaTime / 60, 0.05)

    this.agents = this.simulator.tick(dt, this.agents)
    this.pushDataToEntities()

    this.movement.update(this.agentEntities, dt)
    this.pullDataFromEntities()

    this.agents = this.simulator.afterMovement(
      dt,
      this.agents,
      this.agentEntities,
    )
    this.pushDataToEntities()

    // 先同步 store 并消费外部队列，再补 Demo，避免空闲窗口被自动工作流吞掉
    setOfficeAgents(this.agents)
    notifyVisitMissionActivity(this.agents)
    this.updateAutoWorkflow(dt)

    this.animation.update(this.agentEntities, dt)
    this.sortOfficeDepth()
    this.syncDeskOccupancy()

    setOfficeAgents(this.agents)
  }

  private updateAutoWorkflow(dt: number) {
    if (!this.automatic) return
    this.autoWorkflowTimer -= dt
    if (this.autoWorkflowTimer > 0) return

    // 外部 HTTP 拜访优先：有待执行命令时不启动新的 Demo 拜访
    if (hasPendingVisitQueue()) {
      this.autoWorkflowTimer = 0.35
      return
    }

    const activeCount = this.agents.filter((agent) => agent.mission).length
    if (activeCount >= AUTO_WORKFLOW_MAX_ACTIVE) {
      this.autoWorkflowTimer = 0.35
      return
    }

    const next = nextWorkflowStep(this.agents, this.autoWorkflowIndex, this.autoWorkflowCounts)
    if (!next) {
      this.autoWorkflowTimer = 0.45
      return
    }

    const { step, index, nextIndex } = next
    this.autoWorkflowCounts[index] = (this.autoWorkflowCounts[index] ?? 0) + 1
    this.autoWorkflowIndex = nextIndex
    const visitorName = AGENT_ROSTER[step.visitor - 1]?.name ?? `#${step.visitor}`
    const message = `${visitorName}：${t(step.message)}`
    this.agents = this.simulator.startDeskVisit(
      this.agents,
      step.visitor,
      step.host,
      message,
    )
    this.pushDataToEntities()
    this.autoWorkflowTimer = AUTO_WORKFLOW_INTERVAL
  }

  private sortOfficeDepth() {
    if (!this.officeLayer) return

    const agentPositions = [...this.agentEntities.values()].map((e) => ({
      x: e.position.x,
      y: e.position.y,
    }))

    for (const e of this.agentEntities.values()) {
      e.zIndex = e.position.y
    }

    for (const desk of this.deskEntities.values()) {
      desk.updateDepthZ(agentPositions)
    }

    this.officeLayer.sortChildren()
  }

  private pushDataToEntities() {
    for (const agent of this.agents) {
      const entity = this.agentEntities.get(agent.id)
      if (!entity) continue

      const prev = entity.data
      entity.apply(agent)
      entity.setWorkStatus(this.workIndicators[agent.id])
      if (
        prev.x !== agent.x ||
        prev.y !== agent.y ||
        agent.state !== 'walking'
      ) {
        entity.setPosition(agent.x, agent.y)
      }
    }
  }

  private pullDataFromEntities() {
    this.agents = this.agents.map((agent) => {
      const entity = this.agentEntities.get(agent.id)
      return entity ? { ...agent, ...entity.data } : agent
    })
  }

  private syncDeskOccupancy() {
    const occupied = new Set(
      this.agents
        .filter((a) => a.state === 'working' && a.assignedDeskId)
        .map((a) => a.assignedDeskId!),
    )
    for (const desk of this.deskEntities.values()) {
      desk.setOccupied(occupied.has(desk.deskId))
    }
  }

  /** 桌子 / 人物 / 椅子同层；桌沿为界动态遮挡 */
  private spawnOffice(parent: Container) {
    const layer = new Container()
    layer.label = 'office'
    layer.sortableChildren = true
    this.officeLayer = layer

    for (const desk of DESKS) {
      const entity = new DeskEntity(desk)
      this.deskEntities.set(desk.id, entity)
      layer.addChild(
        entity.shadowGfx,
        entity.deskLayer,
        entity.chairLayer,
        entity.occupiedIndicator,
      )
    }

    for (const agent of this.agents) {
      const entity = new AgentEntity(agent)
      this.agentEntities.set(agent.id, entity)
      entity.zIndex = agent.y
      entity.on('pointertap', (event: FederatedPointerEvent) => {
        event.stopPropagation()
        this.options.onAgentClick?.({
          agent: { ...entity.data },
          rosterNo: this.agents.findIndex((a) => a.id === agent.id) + 1,
          clientX: event.clientX,
          clientY: event.clientY,
        })
      })
      layer.addChild(entity)
    }

    this.sortOfficeDepth()
    parent.addChild(layer)
  }

  private drawMap() {
    const bgTex = getOfficeBackgroundTexture()
    if (bgTex) {
      const bg = new Sprite(bgTex)
      bg.label = 'room-background'
      this.roomBackground = bg
      this.app?.stage.addChildAt(bg, 0)
    }
  }
}
