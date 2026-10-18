import { TriangleAlert } from 'lucide-react'
import type { ExecutionItem, ExecutionKey } from '@shared/research/model'
import { useT } from '../lib/i18n'
import { Badge } from '../ui'
import { EXECUTION_ORDER } from './view'

/**
 * 実行条件の4点（最初の有料取引・提供する能力と供給・最初の実験・利益と運用）。リサーチの区分6とビジネスのダッシュボードの両方で使う。
 * 供給（supply）は抜けやすいので先頭に置き、未確認なら注意を出す。plan の空欄にはナレッジの「決める内容」を薄く出す
 */
export function ExecutionList({ value, onChange, testId = 'execution', disabled }: {
  value: Record<ExecutionKey, ExecutionItem>
  onChange: (key: ExecutionKey, item: ExecutionItem) => void
  testId?: string
  disabled?: boolean
}) {
  const t = useT()
  const confirmed = EXECUTION_ORDER.filter((k) => value[k]?.confirmed).length
  return (
    <div className="rs-exec" data-testid={testId}>
      <p className="rs-exec__summary">
        <Badge tone={confirmed === EXECUTION_ORDER.length ? 'success' : 'neutral'}>{t('research.exec.confirmed', { n: confirmed, total: EXECUTION_ORDER.length })}</Badge>
        {!value.supply?.confirmed && (
          <span className="biz-issue biz-issue--warning" data-testid={`${testId}-supply-warning`}>
            <TriangleAlert size={12} aria-hidden="true" />
            <span>{t('research.exec.supplyWarning')}</span>
          </span>
        )}
      </p>
      <ol className="rs-exec__items">
        {EXECUTION_ORDER.map((k, i) => {
          const item = value[k] ?? { plan: '', confirmed: false }
          return (
            <li key={k} className={`rs-exec__item${k === 'supply' ? ' rs-exec__item--supply' : ''}${item.confirmed ? ' is-confirmed' : ''}`} data-testid={`${testId}-${k}`} data-confirmed={String(item.confirmed)}>
              <div className="rs-exec__head">
                <span className="rs-exec__num biz-mono">{i + 1}</span>
                <span className="rs-exec__name">{t(`research.exec.${k}` as const)}</span>
                {k === 'supply' && <Badge tone="warning">{t('research.exec.oftenMissed')}</Badge>}
                <span className="biz-spacer" />
                <label className="rs-exec__check">
                  <input type="checkbox" checked={item.confirmed} disabled={disabled} onChange={(e) => onChange(k, { ...item, confirmed: e.target.checked })} data-testid={`${testId}-${k}-confirmed`} />
                  <span>{t('research.exec.confirmedLabel')}</span>
                </label>
              </div>
              <textarea
                className="biz-textarea"
                rows={2}
                aria-label={t('research.exec.planOf', { item: t(`research.exec.${k}` as const) })}
                placeholder={t(`research.exec.${k}.plan` as const)}
                value={item.plan}
                disabled={disabled}
                onChange={(e) => onChange(k, { ...item, plan: e.target.value })}
                data-testid={`${testId}-${k}-plan`}
              />
              <span className="biz-muted rs-exec__done">{t('research.exec.doneWhen', { state: t(`research.exec.${k}.done` as const) })}</span>
            </li>
          )
        })}
      </ol>
    </div>
  )
}
