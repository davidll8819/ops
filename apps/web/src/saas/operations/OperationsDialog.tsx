import { useEffect, useRef } from 'react'
import { t } from '@/i18n'
import { OperationsWorkspace, type OperationsHandoff } from './OperationsWorkspace'
export function OperationsDialog({
  open,
  onClose,
  base,
  canEdit,
  handoff,
  openSettings,
}: {
  open: boolean
  onClose: () => void
  base: string
  canEdit: boolean
  handoff?: OperationsHandoff
  openSettings: () => void
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    if (open && !dialog.current?.open) dialog.current?.showModal()
    else if (!open && dialog.current?.open) dialog.current.close()
  }, [open])
  return (
    <dialog
      ref={dialog}
      className="ops-dialog"
      aria-labelledby="operations-dialog-title"
      onClose={onClose}
      onCancel={onClose}
    >
      <header className="ops-dialog-header">
        <div>
          <p>{t('运营流程')} · 叶凡</p>
          <h1 id="operations-dialog-title">{t('运营工作台')}</h1>
        </div>
        <button autoFocus onClick={() => dialog.current?.close()} aria-label={t('关闭运营工作台')}>
          ×
        </button>
      </header>
      <div className="ops-dialog-body">
        <OperationsWorkspace
          base={base}
          canEdit={canEdit}
          handoff={handoff}
          openSettings={openSettings}
        />
      </div>
    </dialog>
  )
}
