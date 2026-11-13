import type { ReviewSession } from './components/Sidebar'
import type { Finding } from './components/FindingsList'
import type { CaptureStatus } from './components/StatusBar'
import { formatDate, t } from '@shared/i18n'

/**
 * 見本データ。**ここ1ファイルにだけ置く。**
 *
 * 出てよい場所は2つだけ:
 *   - 部品見本（#gallery）
 *   - 撮影（window.ade.demo === true。ADE_DEMO=1 のとき）
 * 通常起動では使わない。実データが無ければ空状態を出す。
 *
 * 次の工程で実データをつなぐときは、この値を捨てて同じ型の実データを
 * 各コンポーネントへ渡すだけでよい（型は各コンポーネント側が正本）。
 */

// speaker は表示しない識別値（FindingsList の型が '自分' | '相手'）なので辞書へ移さない
// 文言は画面の言語に合わせるため、描画のたびに関数で作る（モジュールの最上位で t() を呼ばない）

export function demoSessions(): ReviewSession[] {
  const today = t('demo.group.today')
  const yesterday = t('demo.group.yesterday')
  const sep28 = formatDate(new Date(2026, 8, 28), { month: 'long', day: 'numeric' })
  const sep26 = formatDate(new Date(2026, 8, 26), { month: 'long', day: 'numeric' })
  return [
    { id: 's1', group: today, label: '14:32', target: t('demo.session.bookingPricing'), findings: 7, status: 'draft' },
    { id: 's2', group: today, label: '10:05', target: t('demo.session.bookingTop'), findings: 12, status: 'sent' },
    { id: 's3', group: yesterday, label: '18:40', target: t('demo.session.adminDashboard'), findings: 4, status: 'sent' },
    { id: 's4', group: yesterday, label: '09:12', target: t('demo.session.adminBookings'), findings: 6, status: 'sent' },
    { id: 's5', group: sep28, label: '11:20', target: t('demo.session.bookingContact'), findings: 9, status: 'sent' },
    { id: 's6', group: sep28, label: '09:48', target: t('demo.session.bookingTop'), findings: 3, status: 'sent' },
    { id: 's7', group: sep26, label: '16:05', target: t('demo.session.lpHero'), findings: 15, status: 'sent' }
  ]
}

/** 見本のレビューの id。実データの id と区別するため（App の選択処理） */
export const DEMO_SESSION_IDS: readonly string[] = ['s1', 's2', 's3', 's4', 's5', 's6', 's7']

export function demoFindings(): Finding[] {
  return [
    {
      n: 1,
      time: '01:42',
      title: t('demo.finding1.title'),
      request: t('demo.finding1.request'),
      quote: t('demo.finding1.quote'),
      url: '/pricing',
      element: t('demo.finding1.element'),
      speaker: '自分'
    },
    {
      n: 2,
      time: '03:08',
      title: t('demo.finding2.title'),
      request: t('demo.finding2.request'),
      quote: t('demo.finding2.quote'),
      url: '/pricing',
      element: 'table.pricing',
      speaker: '相手'
    },
    {
      n: 3,
      time: '05:20',
      title: t('demo.finding3.title'),
      request: t('demo.finding3.request'),
      quote: t('demo.finding3.quote'),
      url: '/contact',
      element: 'p.lead',
      speaker: '相手',
      unresolved: true
    },
    {
      n: 4,
      time: '06:55',
      title: t('demo.finding4.title'),
      request: t('demo.finding4.request'),
      quote: t('demo.finding4.quote'),
      url: '/',
      element: 'a.brand',
      speaker: '自分'
    }
  ]
}

export function demoCapture(): CaptureStatus {
  return {
    microphone: t('demo.capture.microphone'),
    transcription: t('demo.capture.transcription')
  }
}

/** 実データがまだ無いときの表示。通常起動の既定 */
export const EMPTY_CAPTURE: CaptureStatus = {}
