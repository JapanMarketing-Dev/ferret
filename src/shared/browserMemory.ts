import { isLocalHost } from './projectTargets'

/**
 * 内蔵ブラウザのメモリを抑える決まり（main の browser.ts・index.ts が使う。Electron に依存しない純粋な関数）。
 *
 * - 後ろのタブは「眠らせる」: ページを捨てて、題名・URL・戻る/進むの履歴だけを残す。押せばその場で読み直す
 * - ページを持たせておくのは、前のタブ＋最近使ったタブで LIVE_TABS 枚まで
 * - 30秒ごとに Ferret 全体のメモリを読み、PC のメモリに対する割合で決める（PC によってメモリの量が大きく違うので、GB では決めない）
 * - ページが開く別タブのリンクは、手元の開発中のページ（localhost など）でなければ外部ブラウザで開く
 */

/** ページを持たせておくタブの数（前のタブを含む） */
export const LIVE_TABS = 3
/** メモリを見る間隔 */
export const MEMORY_CHECK_MS = 30_000
/** これを超えたら、前のタブ以外を眠らせる（PC のメモリに対する Ferret 全体の割合） */
export const MEMORY_SLEEP_RATIO = 0.25
/** 眠らせても、これを超えていたら知らせる */
export const MEMORY_NOTICE_RATIO = 0.35
/** 知らせを繰り返さない間 */
export const MEMORY_NOTICE_INTERVAL_MS = 30 * 60_000

/** 眠らせるかを決めるためのタブの様子 */
export interface TabSleepInfo {
  id: string
  /** 最後に前に出した時刻 */
  lastActiveAt: number
  /** 既に眠っている */
  sleeping: boolean
  /** 眠らせてはいけない（録画中・Agent が操作中・音が出ている） */
  pinned: boolean
}

/**
 * 眠らせるタブ。前のタブと pinned は残し、残りのうち最近使ったものから、合わせて keepLive 枚までページを持たせる。
 * pinned も枚数に数える（pinned が多ければ、ほかは全部眠らせる）
 */
export function tabsToSleep(tabs: readonly TabSleepInfo[], activeId: string, keepLive: number = LIVE_TABS): string[] {
  const awake = tabs.filter((tab) => !tab.sleeping)
  let budget = Math.max(1, keepLive) - awake.filter((tab) => tab.id === activeId || tab.pinned).length
  const candidates = awake
    .filter((tab) => tab.id !== activeId && !tab.pinned)
    .sort((a, b) => b.lastActiveAt - a.lastActiveAt)
  const sleep: string[] = []
  for (const tab of candidates) {
    if (budget > 0) {
      budget--
      continue
    }
    sleep.push(tab.id)
  }
  return sleep
}

export type MemoryAction = { sleep: boolean; notice: boolean }

/**
 * メモリの使い方からすること。used は Ferret 全体（全プロセス）のバイト数、total は PC のメモリのバイト数。
 * lastNoticeAt は前に知らせた時刻（無ければ null）。sleptBefore は前の確認で既に眠らせたか
 * （知らせるのは、眠らせたあとの確認でも多いときだけ。眠らせれば足りるなら知らせない）
 */
export function memoryAction(used: number, total: number, now: number, lastNoticeAt: number | null, sleptBefore = false): MemoryAction {
  if (!(total > 0) || !(used >= 0)) return { sleep: false, notice: false }
  const ratio = used / total
  const sleep = ratio >= MEMORY_SLEEP_RATIO
  const notice = sleptBefore && ratio >= MEMORY_NOTICE_RATIO && (lastNoticeAt === null || now - lastNoticeAt >= MEMORY_NOTICE_INTERVAL_MS)
  return { sleep, notice }
}

/** GB の表示（知らせに出す。小数1桁） */
export function formatGb(bytes: number): string {
  return (Math.max(0, bytes) / 1024 ** 3).toFixed(1)
}

/**
 * ページが別タブで開こうとしたリンクをどこで開くか。手元の開発中のページ（localhost など）は内蔵ブラウザのタブ、
 * それ以外の http / https は外部ブラウザ。ほかの形（プレビュー・プロジェクトのページなど）は今までどおり内蔵
 */
export function pageTabDestination(url: string): 'tab' | 'external' {
  let parsed: URL
  try { parsed = new URL(url) } catch { return 'tab' }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return 'tab'
  return isLocalHost(parsed.hostname) ? 'tab' : 'external'
}
