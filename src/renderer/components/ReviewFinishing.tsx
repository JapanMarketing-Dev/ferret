import type { ReviewFinishJob } from '@shared/reviewFinishing'
import { Progress, Tooltip } from '../ui'
import { useT } from '../lib/i18n'
import '../styles/reviewFinishing.css'

/**
 * 録画を止めたあと、裏でレビューを作っている進み具合（0〜100%）。録画ボタンの横に出す（エディタのタイトルバー・フィードバックのツールバー）。
 * 段階（音声の保存・残りの文字起こし・指摘と画像のまとめ）と、どのプロジェクトの録画かを添える。終われば消える
 */
export function ReviewFinishing({ jobs, compact = false }: { jobs: readonly ReviewFinishJob[]; compact?: boolean }) {
  const t = useT()
  if (jobs.length === 0) return null
  // 2本以上なら、いちばん遅れているものを出す（全部終わるまで出し続ける）
  const job = jobs.reduce((slowest, candidate) => (candidate.percent < slowest.percent ? candidate : slowest))
  const stage = job.stage === 'transcribe' && job.pendingChunks
    ? t('reviewFinishing.stage.transcribeLeft', { n: job.pendingChunks })
    : t(`reviewFinishing.stage.${job.stage}`)
  const detail = [stage, job.projectName, jobs.length > 1 ? t('reviewFinishing.more', { n: jobs.length }) : ''].filter(Boolean).join(' · ')
  return (
    <Tooltip label={`${t('reviewFinishing.title')} ${job.percent}% · ${detail}`}>
      <div className={`review-finishing${compact ? ' review-finishing--compact' : ''}`} role="status" aria-live="polite" data-testid="review-finishing">
        <span className="review-finishing__head">
          <span className="review-finishing__title">{t('reviewFinishing.title')}</span>
          <span className="review-finishing__percent" data-testid="review-finishing-percent">{job.percent}%</span>
        </span>
        <Progress value={job.percent / 100} label={t('reviewFinishing.title')} />
        {!compact && <span className="review-finishing__stage">{detail}</span>}
      </div>
    </Tooltip>
  )
}
