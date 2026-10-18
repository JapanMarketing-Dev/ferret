import type { BusinessListItem } from '@shared/business/ipc'
import { stepById } from '@shared/business/model'

/** サイドバーのプロジェクト名の横に出す、今のステップの小さな札（1行） */
export function BusinessStepBadge({ item }: { item: BusinessListItem | undefined }) {
  if (!item) return null
  const step = stepById(item.step)
  const label = `${item.step} ${step.name}・${item.loop}周目${item.pendingApprovals > 0 ? `・承認待ち ${item.pendingApprovals}` : ''}`
  return (
    <span className={`biz-step-badge${item.pendingApprovals > 0 ? ' has-pending' : ''}`} title={label} role="img" aria-label={label} data-testid={`business-step-${item.projectId}`}>
      {item.step}
    </span>
  )
}

/** タイトルバーの中央に出す「ビジネス名／周回／段階」 */
export function BusinessIndicator({ item }: { item: BusinessListItem | undefined }) {
  if (!item) return null
  return (
    <span className="biz-indicator" data-testid="business-indicator" title={`${item.name}・${item.loop}周目${item.stage ? `・${item.stage}` : ''}`}>
      <span className="biz-indicator__name">{item.name}</span>
      <span className="biz-indicator__sep" aria-hidden="true">/</span>
      <span className="biz-indicator__meta">{item.loop}周目</span>
      {item.stage && (
        <>
          <span className="biz-indicator__sep" aria-hidden="true">/</span>
          <span className="biz-indicator__meta">{item.stage}</span>
        </>
      )}
    </span>
  )
}
