import type { OfficeWorkStatus } from '@/saas/office-work-status'
import { t } from '@/i18n'
import { Container, Graphics, Text } from 'pixi.js'

const NAME_STYLE = {
  fontFamily: 'system-ui, -apple-system, sans-serif',
  fontSize: 11,
  fontWeight: '600' as const,
  fill: 0x333333,
}

const TASK_STYLE = {
  fontFamily: 'system-ui, -apple-system, sans-serif',
  fontSize: 10,
  fill: 0x666666,
  fontStyle: 'italic' as const,
  wordWrap: true,
  breakWords: true,
  wordWrapWidth: 180,
}

/** 名字顶边与任务框底边的间距（任务在名字上方） */
const NAME_TASK_GAP = 2
/** 名字底边与发顶之间的空隙 */
const CROWN_GAP = 8

export class StatusLabel extends Container {
  private nameText: Text
  private taskText: Text
  private stateDot: Graphics
  private taskBg: Graphics
  private workStatus?: OfficeWorkStatus
  private agentName: string

  constructor(name: string) {
    super()
    this.agentName = name
    this.nameText = new Text({ text: name, style: NAME_STYLE })
    this.nameText.anchor.set(0.5, 1)
    this.nameText.position.set(0, 0)

    this.taskBg = new Graphics()
    this.taskText = new Text({ text: '', style: TASK_STYLE })
    this.taskText.anchor.set(0.5, 0)

    this.stateDot = new Graphics()
    this.addChild(this.taskBg, this.nameText, this.taskText, this.stateDot)
    this.taskBg.visible = false
    this.paintStateDot()
  }

  setName(name: string) {
    this.agentName = name
    this.refreshName()
    this.paintStateDot()
  }

  setTask(task?: string) {
    if (!task) {
      this.taskText.text = ''
      this.taskBg.visible = false
      return
    }
    this.taskText.text = t(task)
    this.taskBg.visible = true

    this.layoutTaskAboveName()
  }

  private layoutTaskAboveName() {
    const padX = 5
    const padY = 3
    const w = this.taskText.width + padX * 2
    const h = this.taskText.height + padY * 2
    const nameH = this.nameText.height
    const taskTop = -(nameH + NAME_TASK_GAP + h)

    this.taskBg.clear()
    this.taskBg.roundRect(-w / 2, taskTop, w, h, 3)
    this.taskBg.fill({ color: 0xffffff, alpha: 0.9 })
    this.taskText.position.set(0, taskTop + padY)
  }

  setWorkStatus(status?: OfficeWorkStatus) {
    if (this.workStatus === status && this.nameText.text === this.formatName(status)) return
    this.workStatus = status
    this.refreshName()
    this.paintStateDot()
  }

  private refreshName() {
    this.nameText.text = this.formatName(this.workStatus)
    if (this.taskBg.visible) this.layoutTaskAboveName()
  }

  private formatName(status?: OfficeWorkStatus) {
    return `${this.agentName} · ${t(status?.label || '状态查询中')}`
  }

  /** 发顶 Y：名字贴在发顶上方，任务叠在名字上面 */
  layout(crownTopY: number) {
    this.position.set(0, crownTopY - CROWN_GAP)
  }

  /** 名字/任务标签块顶边 Y（Agent 本地坐标） */
  getLabelTopY(crownTopY: number): number {
    const baselineY = crownTopY - CROWN_GAP
    if (!this.taskBg.visible) {
      return baselineY - this.nameText.height
    }
    const taskBoxH = this.taskText.height + 6
    return baselineY - this.nameText.height - NAME_TASK_GAP - taskBoxH
  }

  private paintStateDot() {
    const color = this.workStatus?.color ?? 0x8a9299
    this.stateDot.clear()
    this.stateDot.circle(
      this.nameText.width * 0.5 + 6,
      -this.nameText.height * 0.5,
      3.5,
    )
    this.stateDot.fill(color)
  }
}
