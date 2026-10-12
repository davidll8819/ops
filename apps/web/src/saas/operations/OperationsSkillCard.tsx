import { t } from '@/i18n'
import './operations.css'
export function OperationsSkillCard({ onOpen }: { onOpen: () => void }) {
  return <button className="ops-skill-card" onClick={() => onOpen()} aria-label={`${t('运营流程')} · ${t('打开运营工作台')}`}>
    <span className="ops-skill-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"><rect x="3" y="3" width="7" height="7" rx="2"/><rect x="14" y="14" width="7" height="7" rx="2"/><path d="M10 6.5h5a3 3 0 0 1 3 3V14M6.5 10v7.5H14"/></svg></span>
    <span className="ops-skill-copy"><strong>{t('运营流程')}</strong><span>{t('自动编写剧本、设计分镜、生成视频并发布，由叶凡负责。')}</span></span>
    <span aria-hidden="true">↗</span>
  </button>
}
