import { OperationsSkillCard } from './operations/OperationsSkillCard'
import { t } from '@/i18n'
import { SkillCatalog } from './SkillCatalog'
import { SkillUpload } from './SkillUpload'
import { InstalledSkills } from './InstalledSkills'
export type SkillView = 'catalog' | 'installed'
export function Skills({
  base,
  canEdit,
  view,
  onView,
  revision,
  onInstalled,
  openOperations,
}: {
  base: string
  canEdit: boolean
  view: SkillView
  onView: (view: SkillView) => void
  revision: number
  onInstalled: () => void
  openOperations: () => void
}) {
  return (
    <>
      <div className="page-heading">
        <h1>{t('技能库')}</h1>
        <p className="muted">{t('集中管理秘书与智能体使用的技能。')}</p>
      </div>

      <div className="skills-upload-inline">
        <SkillUpload base={base} canEdit={canEdit} onInstalled={onInstalled} />
      </div>
      <div className="skill-view-switch" role="group" aria-label={t('技能视图')}>
        <button aria-pressed={view === 'catalog'} onClick={() => onView('catalog')}>
          {t('技能目录')}
        </button>
        <button aria-pressed={view === 'installed'} onClick={() => onView('installed')}>
          {t('我的技能')}
        </button>
      </div>
      <h2 className="skill-package-heading">{t('单体技能包')}</h2>
      {view === 'catalog' ? (
        <SkillCatalog base={base} canEdit={canEdit} openInstalled={onInstalled} />
      ) : (
        <InstalledSkills base={base} revision={revision} canEdit={canEdit}/>
      )}
      <section className="skill-workflow-section"><h2 className="skill-package-heading">{t('流程技能包')}</h2><OperationsSkillCard onOpen={openOperations} /></section>
    </>
  )
}
