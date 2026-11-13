import { isProjectPageUrl } from './htmlPreview'
import { isLocalHost } from './projectTargets'

/**
 * 内蔵ブラウザの「いまの画面」の控え（純粋な部分。単体テストの対象。書くのは src/main/screenCache.ts）。
 *
 * Agent が画面を見たいたびにスクリーンショットを撮らなくて済むよう、Ferret が開いているページの最新の画面を
 * プロジェクトの `.ferret/screens/` に置いておく:
 *   latest.jpg             … いま前に出ているページ
 *   pages/<host><path>.jpg … ページ（URL のパス）ごとの最新
 *   index.json             … { latest, pages: [{ file, url, title, capturedAt, width, height }] }
 * 撮るのは、読み込みが終わって落ち着いたとき・ページの中の移動（SPA）が落ち着いたとき・画面に出ている間のゆっくりした間隔だけ。
 * 前と同じ画像なら書かない。撮るのは手元の開発サーバー・プロジェクトのページ・プロジェクトに登録した URL のサイトだけ
 * （銀行やメールなど、ほかのサイトの画面をプロジェクトのフォルダへ残さない）。
 */

export const SCREENS_DIR = '.ferret/screens'
export const SCREENS_INDEX = 'index.json'
export const SCREENS_LATEST = 'latest.jpg'
export const SCREENS_PAGES_DIR = 'pages'

export const SCREEN_TIMING = {
  /** 読み込みが終わってから撮るまで（描画・フォント・遅れて出る部品を待つ） */
  settleMs: 1200,
  /** ページの中の移動（pushState・ハッシュ）から撮るまで */
  inPageSettleMs: 1500,
  /** 画面に出ている間に撮り直す間隔（変わっていなければ書かない） */
  refreshMs: 30_000,
  /** 続けて撮るときの最小の間 */
  minGapMs: 3_000
} as const

/** 画像の長い辺の上限（Agent が読むのに十分で、ファイルを小さく保つ） */
export const SCREEN_MAX_WIDTH = 1440
export const SCREEN_JPEG_QUALITY = 72
/** index.json に残すページの数（古いものから消す） */
export const SCREEN_MAX_PAGES = 40

export interface ScreenEntry {
  /** `.ferret/screens/` からの相対パス */
  file: string
  url: string
  title: string
  capturedAt: string
  width: number
  height: number
}

export interface ScreenIndex {
  version: 1
  latest: ScreenEntry | null
  pages: ScreenEntry[]
}

/** 撮ってよいページか（手元のホスト・プロジェクトのページ・登録した URL と同じホスト） */
export function isCapturableUrl(url: string, registered: readonly string[] = []): boolean {
  if (isProjectPageUrl(url)) return true
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false
  if (isLocalHost(parsed.hostname)) return true
  const host = parsed.host.toLowerCase().replace(/^www\./, '')
  return registered.some((item) => {
    try {
      const target = new URL(item)
      return (target.protocol === 'http:' || target.protocol === 'https:') && target.host.toLowerCase().replace(/^www\./, '') === host
    } catch {
      return false
    }
  })
}

/** 文字列の短い指紋（ファイル名の重なりを避ける。暗号ではない） */
export function shortHash(text: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16).padStart(8, '0')
}

const NAME_MAX = 100

/**
 * ページごとの画像の名前（`<host><path>.jpg`。クエリは見ない。`#/` で始まるハッシュは SPA の画面なので含める）。
 * 使える文字は英数字と . _ - だけ（ほかは _）。長ければ切って指紋を付ける
 */
export function screenFileName(url: string): string {
  let host = 'page'
  let path = ''
  try {
    const parsed = new URL(url)
    if (isProjectPageUrl(url)) {
      host = 'project'
      path = parsed.pathname
    } else {
      host = parsed.host
      path = parsed.pathname
      if (parsed.hash.startsWith('#/')) path += parsed.hash.slice(1)
    }
  } catch {
    path = url
  }
  const raw = `${host}${path === '/' ? '' : path}`
  let name = raw.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/_+/g, '_').replace(/^[._]+|[._]+$/g, '') || 'page'
  if (name.length > NAME_MAX) name = `${name.slice(0, NAME_MAX - 9)}-${shortHash(raw)}`
  return `${name}.jpg`
}

/** 撮った画像の大きさ（長い辺の上限を超えたら縮める） */
export function scaledSize(width: number, height: number, maxWidth: number = SCREEN_MAX_WIDTH): { width: number; height: number } {
  if (width <= 0 || height <= 0) return { width: 0, height: 0 }
  if (width <= maxWidth) return { width: Math.round(width), height: Math.round(height) }
  return { width: maxWidth, height: Math.max(1, Math.round(height * maxWidth / width)) }
}

export function emptyScreenIndex(): ScreenIndex {
  return { version: 1, latest: null, pages: [] }
}

/** 読んだ index.json（壊れていれば空から） */
export function parseScreenIndex(raw: unknown): ScreenIndex {
  if (typeof raw !== 'object' || raw === null) return emptyScreenIndex()
  const value = raw as { latest?: unknown; pages?: unknown }
  const entry = (item: unknown): ScreenEntry | null => {
    if (typeof item !== 'object' || item === null) return null
    const e = item as Record<string, unknown>
    if (typeof e.file !== 'string' || !/^[A-Za-z0-9._-][A-Za-z0-9._/-]*$/.test(e.file) || e.file.includes('..')) return null
    if (typeof e.url !== 'string') return null
    return {
      file: e.file,
      url: e.url,
      title: typeof e.title === 'string' ? e.title : '',
      capturedAt: typeof e.capturedAt === 'string' ? e.capturedAt : '',
      width: typeof e.width === 'number' ? e.width : 0,
      height: typeof e.height === 'number' ? e.height : 0
    }
  }
  const pages = Array.isArray(value.pages) ? value.pages.map(entry).filter((e): e is ScreenEntry => e !== null) : []
  return { version: 1, latest: entry(value.latest), pages }
}

/**
 * 撮った1枚を index に入れる（同じファイルは置き換えて先頭へ）。上限を超えた古いページは外し、消すファイルとして返す
 */
export function addScreen(index: ScreenIndex, page: ScreenEntry, max: number = SCREEN_MAX_PAGES): { index: ScreenIndex; evicted: string[] } {
  const rest = index.pages.filter((p) => p.file !== page.file)
  const pages = [page, ...rest]
  const evicted = pages.slice(max).map((p) => p.file)
  return { index: { version: 1, latest: { ...page, file: SCREENS_LATEST }, pages: pages.slice(0, max) }, evicted }
}

interface Timers {
  set: (fn: () => void, ms: number) => unknown
  clear: (handle: unknown) => void
}

const defaultTimers: Timers = {
  set: (fn, ms) => {
    const handle = setTimeout(fn, ms)
    ;(handle as { unref?: () => void }).unref?.()
    return handle
  },
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>)
}

/**
 * いつ撮るかを決める（撮る処理は capture に渡す）。
 * - 読み込みが終わった・URL が変わった → 落ち着くのを待って撮る（途中で次の読み込みが始まれば待ち直す）
 * - ページの中の移動（同じ読み込みのまま URL が変わった）→ 少し長めに待って撮る
 * - refresh（呼ぶ側がゆっくりした間隔で呼ぶ）→ 前に撮ってから refreshMs 経っていれば撮る
 * - 続けて撮るのは minGapMs 空けてから
 */
export class ScreenCaptureScheduler {
  private timer: unknown = null
  private lastUrl = ''
  private wasLoading = false
  private lastAt = -Infinity
  private running = false

  constructor(
    private readonly capture: () => Promise<void>,
    private readonly now: () => number = Date.now,
    private readonly timers: Timers = defaultTimers,
    private readonly timing: { settleMs: number; inPageSettleMs: number; refreshMs: number; minGapMs: number } = SCREEN_TIMING
  ) {}

  /** 内蔵ブラウザの状態が変わった */
  onState(state: { url: string; loading: boolean }): void {
    const urlChanged = state.url !== this.lastUrl
    const finished = this.wasLoading && !state.loading
    this.lastUrl = state.url
    this.wasLoading = state.loading
    if (state.loading) {
      this.cancel()
      return
    }
    if (finished) this.schedule(this.timing.settleMs)
    else if (urlChanged) this.schedule(this.timing.inPageSettleMs)
  }

  /** ゆっくりした間隔で呼ぶ。前に撮ってから間が空いていて、待っているものが無ければ撮る */
  refresh(): void {
    if (this.timer !== null || this.wasLoading) return
    if (this.now() - this.lastAt < this.timing.refreshMs) return
    this.schedule(0)
  }

  /** 待っているものがあるか（テスト用） */
  get pending(): boolean {
    return this.timer !== null
  }

  cancel(): void {
    if (this.timer !== null) this.timers.clear(this.timer)
    this.timer = null
  }

  private schedule(ms: number): void {
    this.cancel()
    const gap = Math.max(0, this.lastAt + this.timing.minGapMs - this.now())
    this.timer = this.timers.set(() => {
      this.timer = null
      void this.run()
    }, Math.max(ms, gap))
  }

  private async run(): Promise<void> {
    if (this.running) return
    this.running = true
    this.lastAt = this.now()
    try {
      await this.capture()
    } catch {
      // 撮れなかった（隠れていた・閉じた）。次の機会に撮る
    } finally {
      this.running = false
    }
  }
}
