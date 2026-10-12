import type { OfficeWorkStatus } from '@/saas/office-work-status'
// Pixi's CSP-compatible polyfill avoids dynamic eval in production.
import 'pixi.js/unsafe-eval'
import { OfficeActionConnector } from '@/components/OfficeActionConnector'
import { OfficeCanvas } from '@/components/OfficeCanvas'
import './App.css'
export default function App({
  tenantId,
  workIndicators,
  automatic,
  onAutomaticChange,
  onOpenOperations,
  onOpenPerson,
}: {
  tenantId: string
  workIndicators: Record<string, OfficeWorkStatus>
  automatic: boolean
  onAutomaticChange: (value: boolean) => void
  onOpenOperations: () => void
  onOpenPerson: (id: string) => void
}) {
  return (
    <div className="office-app">
      <OfficeActionConnector tenantId={tenantId} />
      <div className="office-center">
        <main className="office-main">
          <OfficeCanvas
            workIndicators={workIndicators}
            automatic={automatic}
            onAutomaticChange={onAutomaticChange}
            onOpenOperations={onOpenOperations}
            onOpenPerson={onOpenPerson}
          />
        </main>
      </div>
    </div>
  )
}
