import { createHash } from 'node:crypto'
import { join } from 'node:path'
import type { NativeImage } from 'electron'
import {
  SCREENS_DIR,
  SCREENS_INDEX,
  SCREENS_LATEST,
  SCREENS_PAGES_DIR,
  SCREEN_JPEG_QUALITY,
  SCREEN_TIMING,
  ScreenCaptureScheduler,
  addScreen,
  isCapturableUrl,
  parseScreenIndex,
  scaledSize,
  screenFileName,
  type ScreenEntry
} from '@shared/screenCache'
import { mkdirContained, readFileNoFollow, removeContained, writeFileNoFollow } from './sessions/containment'

/**
 * 内蔵ブラウザの最新の画面を、開いているプロジェクトの `.ferret/screens/` に置いておく（@shared/screenCache）。
 * Agent（skill ferret-visual-review）は、スクリーンショットを撮らずにこれを読む。
 *
 * 撮るのは、画面に出ていて（隠れたビューは撮らない）、読み込みが終わり、撮ってよいページ（手元・プロジェクトのページ・登録した URL）のときだけ。
 * 撮っている間にプロジェクトが替わったら書かない。前と同じ画像なら書かない。
 */

export interface ScreenCacheTarget {
  /** 書く先のプロジェクトのフォルダ */
  folder: string
  /** 撮ってよいサイト（プロジェクトに登録した URL） */
  registeredUrls: string[]
  /** いま前に出ているページの URL（撮る前に、撮ってよいページかを決める） */
  url: string
  /** 内蔵ブラウザの前のタブの見えている分を撮る（browser.ts の captureVisibleTab）。撮れなければ null */
  capture: () => Promise<{ image: NativeImage; url: string; title: string } | null>
}

export class ScreenCache {
  private readonly scheduler: ScreenCaptureScheduler
  /** 書いたファイルごとの画像の指紋（同じなら書かない） */
  private readonly written = new Map<string, string>()
  /** git の除外を確かめたフォルダ */
  private readonly excluded = new Set<string>()
  private refreshTimer: ReturnType<typeof setInterval> | null = null

  constructor(private readonly deps: {
    /** いま撮れる対象（見えていない・プロジェクトが無いなら null） */
    target: () => ScreenCacheTarget | null
    /** `.ferret/` を git の対象外にする（sessions/gitexclude.ts） */
    ensureExcluded?: (folder: string) => Promise<unknown>
    onError?: (err: unknown) => void
  }) {
    this.scheduler = new ScreenCaptureScheduler(async () => { await this.captureNow() })
  }

  /** 内蔵ブラウザの状態が変わった（browser.onStateChange） */
  onState(state: { url: string; loading: boolean }): void {
    this.scheduler.onState(state)
  }

  /** 画面に出ている間のゆっくりした撮り直しを始める */
  start(): void {
    if (this.refreshTimer) return
    this.refreshTimer = setInterval(() => this.scheduler.refresh(), SCREEN_TIMING.refreshMs)
    this.refreshTimer.unref?.()
  }

  stop(): void {
    if (this.refreshTimer) clearInterval(this.refreshTimer)
    this.refreshTimer = null
    this.scheduler.cancel()
  }

  /** 今の画面を撮って書く（撮れなければ何もしない） */
  async captureNow(): Promise<boolean> {
    const target = this.deps.target()
    if (!target || !isCapturableUrl(target.url, target.registeredUrls)) return false
    const shot = await target.capture()
    if (!shot || shot.url !== target.url) return false
    // 撮っている間にページ・プロジェクトが替わったら書かない（前のプロジェクトの画面を次のフォルダへ書かない）
    const after = this.deps.target()
    if (!after || after.folder !== target.folder || after.url !== target.url) return false
    const { image } = shot
    const size = image.getSize()
    const scaled = scaledSize(size.width, size.height)
    if (scaled.width === 0) return false
    const resized = scaled.width === size.width ? image : image.resize({ width: scaled.width, height: scaled.height, quality: 'good' })
    const jpeg = resized.toJPEG(SCREEN_JPEG_QUALITY)
    const hash = createHash('sha1').update(jpeg).digest('hex')
    const name = screenFileName(target.url)
    const pageRel = `${SCREENS_PAGES_DIR}/${name}`
    const key = `${target.folder}\n${pageRel}`
    const latestKey = `${target.folder}\n${SCREENS_LATEST}`
    if (this.written.get(key) === hash && this.written.get(latestKey) === hash) return false
    await this.write(target.folder, { url: shot.url, title: shot.title }, jpeg, pageRel, { width: scaled.width, height: scaled.height })
    this.written.set(key, hash)
    this.written.set(latestKey, hash)
    return true
  }

  private async write(root: string, page: { url: string; title: string }, jpeg: Buffer, pageRel: string, size: { width: number; height: number }): Promise<void> {
    const dir = join(root, ...SCREENS_DIR.split('/'))
    const pagesDir = join(dir, SCREENS_PAGES_DIR)
    if (!this.excluded.has(root)) {
      this.excluded.add(root)
      await this.deps.ensureExcluded?.(root).catch((err: unknown) => this.deps.onError?.(err))
    }
    await mkdirContained(pagesDir, { root })
    await writeFileNoFollow(join(pagesDir, pageRel.slice(SCREENS_PAGES_DIR.length + 1)), jpeg)
    await writeFileNoFollow(join(dir, SCREENS_LATEST), jpeg)
    const indexPath = join(dir, SCREENS_INDEX)
    let current = parseScreenIndex(null)
    try {
      current = parseScreenIndex(JSON.parse(await readFileNoFollow(indexPath, 'utf8', { maxBytes: 512 * 1024 })))
    } catch {
      // 無い・壊れている（作り直す）
    }
    const entry: ScreenEntry = { file: pageRel, url: page.url, title: page.title, capturedAt: new Date().toISOString(), ...size }
    const { index, evicted } = addScreen(current, entry)
    await writeFileNoFollow(indexPath, `${JSON.stringify(index, null, 2)}\n`)
    for (const file of evicted) {
      if (!file.startsWith(`${SCREENS_PAGES_DIR}/`) || file.includes('..')) continue
      await removeContained(root, join(dir, ...file.split('/'))).catch(() => undefined)
      this.written.delete(`${root}\n${file}`)
    }
  }
}
