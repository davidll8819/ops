import { useEffect, useRef } from 'react'
import { OfficeActionHttpClient } from '@/services/officeActionHttp'

/** 轮询 HTTP 动作源，将外部动作同步到办公室场景 */
export function OfficeActionConnector({ tenantId }: { tenantId: string }) {
  const clientRef = useRef<OfficeActionHttpClient | null>(null)

  useEffect(() => {
    const client = new OfficeActionHttpClient()
    clientRef.current = client
    client.connect(`/api/tenants/${tenantId}/actions`)

    return () => {
      client.disconnect()
      clientRef.current = null
    }
  }, [tenantId])

  return null
}
