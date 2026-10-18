import { Code2, Megaphone } from 'lucide-react'
import { Button } from '../ui'
import { useT } from '../lib/i18n'
import { requestAgentLaunch } from '../lib/agentLaunchRequest'
import { openPublishPanel } from '../lib/publishPanel'

/**
 * ビジネスの画面から、続けて「開発」（Ferret の既存の Agent・ターミナル・ブラウザ）と「発信」（Ferret の X・ブログ投稿の下書き）へ進む口。
 * 流れ: ビジネスリサーチ（候補の発見・証拠・採点）→ ビジネス（S6〜S10。提供案・聞き取り・有料試行）→ 開発 → 発信
 */
export function NextSteps() {
  const t = useT()
  return (
    <div className="biz-next" role="group" aria-label={t('business.next.label')} data-testid="business-next">
      <span className="biz-next__label">{t('business.next.label')}</span>
      <Button variant="ghost" icon={<Code2 size={13} />} title={t('business.next.developHint')} onClick={() => requestAgentLaunch('claude')} data-testid="business-next-develop">{t('business.next.develop')}</Button>
      <Button variant="ghost" icon={<Megaphone size={13} />} title={t('business.next.publishHint')} onClick={() => openPublishPanel()} data-testid="business-next-publish">{t('business.next.publish')}</Button>
    </div>
  )
}
