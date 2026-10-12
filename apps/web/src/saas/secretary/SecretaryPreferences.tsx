import { useState } from 'react'
import { t } from '@/i18n'
import { api } from '../api'
import { portrait, type Preferences } from './preferences'
export function SecretaryPreferences({base,preferences,onSave}:{base:string;preferences:Preferences;onSave:(p:Preferences)=>void}) {
  const [draft,setDraft] = useState(preferences), [busy,setBusy] = useState(false), [error,setError] = useState(''), [saved,setSaved] = useState(false)
  function change(patch:Partial<Preferences>) {setDraft({...draft,...patch});setSaved(false)}
  return <form className="sec-card sec-preferences" onSubmit={async e => {
    e.preventDefault();setBusy(true);setError('');setSaved(false)
    try {const data=await api<{preferences:Preferences}>(`${base}/secretary/preferences`,draft,'PUT');onSave(data.preferences);setSaved(true)}
    catch(e) {setError((e as Error).message)} finally {setBusy(false)}
  }}>
    <header><div><h2>{t('你的私人秘书')}</h2><p>{t('形象与交流偏好仅对当前企业中的你生效，保存后用于后续对话。')}</p></div></header>
    <fieldset disabled={busy}><legend>{t('选择秘书形象')}</legend><div className="sec-persona-options">{(['female','male'] as const).map(gender => <button type="button" key={gender} aria-pressed={draft.gender === gender} className={draft.gender === gender ? 'selected' : ''} onClick={() => change({gender,...(['李婉儿','男秘书'].includes(draft.name) ? {name:gender === 'female' ? '李婉儿' : '男秘书'} : {})})}>
      <img src={portrait(gender)} alt=""/><strong>{t(gender === 'female' ? '女助手' : '男助手')}</strong><span>{t(draft.gender === gender ? '已选择' : '选择此形象')}</span>
    </button>)}</div>
    <div className="sec-preference-fields">
      <label>{t('秘书名字')}<input required maxLength={40} value={draft.name} onChange={e=>change({name:e.target.value})}/></label>
      <label>{t('如何称呼你')}<input required maxLength={40} value={draft.address} onChange={e=>change({address:e.target.value})}/></label>
      <label>{t('说话方式')}<select value={draft.tone} onChange={e=>change({tone:e.target.value as Preferences['tone']})}>{Object.entries({warm:'温和体贴',professional:'专业干练',lively:'轻松活泼'}).map(([k,v])=><option key={k} value={k}>{t(v)}</option>)}</select></label>
      <label>{t('回复详细程度')}<select value={draft.detail} onChange={e=>change({detail:e.target.value as Preferences['detail']})}>{Object.entries({concise:'简短直接',balanced:'适中',detailed:'详细说明'}).map(([k,v])=><option key={k} value={k}>{t(v)}</option>)}</select></label>
      <label className="sec-habits">{t('工作与交流习惯')}<textarea rows={4} maxLength={1500} value={draft.habits} onChange={e=>change({habits:e.target.value})} placeholder={t('例如：先说结论；使用清单；不确定时先问我。')}/></label>
    </div></fieldset>
    <p>{t('对话使用企业设置中“秘书处”的文字模型档位。未配置模型时会明确提示，不使用示例回复。')}</p>
    <button className="sec-primary" disabled={busy}>{t(busy ? '正在保存…' : '保存秘书偏好')}</button>
    {saved && <p role="status">{t('秘书偏好已保存，下一条对话即生效。')}</p>}{error && <p role="alert" className="error">{t(error)}</p>}
  </form>
}
