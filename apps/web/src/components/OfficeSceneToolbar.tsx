import { t } from '@/i18n'
import { AGENT_ROSTER } from '@/scene/layout/officeLayout'

type Props = {
  ready: boolean
  paused: boolean
  automatic: boolean
  onPause: (paused: boolean) => void
  onAutomatic: () => void
  onReset: () => void
  onSelect: (index: number) => void
}

/** Scene controls only; business actions in the sidebar are independent. */
export function OfficeSceneToolbar(props: Props) {
  return (
    <div className="scene-controls">
      <div className="scene-control-row">
        <span className="scene-mode" role="status">
          <i className={props.paused ? 'paused' : ''} />
          {t(
            !props.ready
              ? '正在加载办公室…'
              : props.paused
                ? '动画已暂停'
                : props.automatic
                  ? '自动演示中'
                  : '手动控制中',
          )}
        </span>
        <div className="scene-control-buttons">
          <button disabled={!props.ready || props.paused} onClick={() => props.onPause(true)}>
            Ⅱ {t('全部暂停')}
          </button>
          <button disabled={!props.ready || !props.paused} onClick={() => props.onPause(false)}>
            ▶ {t('全部继续')}
          </button>
          <button
            disabled={!props.ready}
            aria-pressed={props.automatic}
            onClick={props.onAutomatic}
          >
            {t('自动演示')}
          </button>
          <button disabled={!props.ready} onClick={props.onReset}>
            ↺ {t('恢复初始场景')}
          </button>
        </div>
      </div>
      <div className="scene-roster" aria-label={t('选择角色')}>
        <span>{t('点击角色控制动作')}</span>
        {AGENT_ROSTER.map((agent, index) => (
          <button key={agent.id} disabled={!props.ready} onClick={() => props.onSelect(index)}>
            <i style={{ background: `#${agent.color.toString(16).padStart(6, '0')}` }} />
            {agent.name}
          </button>
        ))}
      </div>
    </div>
  )
}
