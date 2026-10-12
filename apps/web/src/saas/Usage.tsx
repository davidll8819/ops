import { useEffect, useState } from 'react'
import { t } from '@/i18n'
import { api } from './api'
export type UsageData = {
  usage: {
    user_id: string
    operation: string
    status: string
    requests: number
    input_tokens: string
    output_tokens: string
    charge_microusd: string
  }[]
  modelUsage: UsageData['usage']
  pricingConfigured: boolean
  plan: string
  subscriptionStatus: string
}
export function Usage({ base }: { base: string }) {
  const [data, setData] = useState<UsageData>(),
    [error, setError] = useState('')
  useEffect(() => {
    api<UsageData>(`${base}/usage`)
      .then(setData)
      .catch((e) => setError(e.message))
  }, [base])
  const rows = [...(data?.usage || []), ...(data?.modelUsage || [])]
  return (
    <>
      <div className="page-heading">
        <p className="eyebrow">USAGE & BILLING</p>
        <h1>{t('每一次使用，都有记录')}</h1>
        <p className="muted">
          {t('当前自然月，按 UTC（协调世界时）统计。管理员可查看全企业，成员查看个人用量。')}
        </p>
      </div>
      <div className="metrics">
        <section>
          <span>{t('请求次数')}</span>
          <strong>{rows.reduce((n, r) => n + r.requests, 0) || 0}</strong>
        </section>
        <section>
          <span>{t('输入 / 输出 Token（词元）')}</span>
          <strong>
            {rows.reduce((n, r) => n + Number(r.input_tokens) + Number(r.output_tokens), 0) || 0}
          </strong>
        </section>
        <section>
          <span>{t('费用 USD（美元）')}</span>
          <strong>
            {data?.pricingConfigured && !data?.modelUsage?.length
              ? '$' + (rows.reduce((n, r) => n + Number(r.charge_microusd), 0) / 1e6).toFixed(4)
              : t('待配置价格')}
          </strong>
        </section>
      </div>
      <section className="builder-card">
        <h2>{t('使用明细')}</h2>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>{t('用户编号')}</th>
                <th>{t('操作')}</th>
                <th>{t('状态')}</th>
                <th>{t('次数')}</th>
                <th>{t('输入')}</th>
                <th>{t('输出')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i}>
                  <td>{r.user_id?.slice(0, 8) || t('运营运行服务')}</td>
                  <td>
                    {t(
                      (
                        {
                          chat: '对话',
                          builder: '构建助手',
                          secretary: '秘书处',
                          content_ops: '运营部',
                          archive: '资料室',
                          design: '设计部',
                          dev: '程序部',
                          market_research: '市场调研',
                          outreach: '拓客部',
                          compliance: '合规部',
                          intern: '实习生',
                        } as Record<string, string>
                      )[r.operation] || r.operation,
                    )}
                  </td>
                  <td>
                    {
                      {
                        completed: t('已完成'),
                        pending: t('处理中'),
                        unknown: t('待核对'),
                        failed: t('未执行'),
                        rejected: t('未执行'),
                      }[r.status]
                    }
                  </td>
                  <td>{r.requests}</td>
                  <td>{r.input_tokens}</td>
                  <td>{r.output_tokens}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="small muted">
          {t(
            '支付宝与微信支付待接入，目前不会自动扣款。费用未知的调用标记为待核对，不按成功调用重复收费。',
          )}
        </p>
      </section>
      {error && <p className="error">{t(error)}</p>}
    </>
  )
}
