/**
 * ビジネスのフォルダの変更（Agent が書いた・人が保存した）を見張り、まとめて1回知らせる（300ms）。
 * ビジネスリサーチのフォルダ（research.yaml など）も同じ見張りで知らせる。
 * 送った履歴・画面の写し・ゴミ箱・context.md（アプリが書くもの）と .git の中は知らせない。
 * プロジェクトを切り替えたら前の見張りは止める（watch(null)）
 */
import { watch as fsWatch } from 'node:fs'

export const DEBOUNCE_MS = 300
const IGNORED = ['.business/sent/', '.business/captures/', '.business/trash/', '.research/sent/', '.research/trash/', '.git/', 'node_modules/']
const IGNORED_FILES = ['.business/context.md', '.research/context.md']

export type WatchFn = (root: string, onChange: (filename: string | null) => void) => { close(): void }

/** macOS・Windows は再帰の見張り（Linux も Node 20 以降は使える） */
export const nodeWatch: WatchFn = (root, onChange) => {
  const w = fsWatch(root, { recursive: true, persistent: false }, (_event, filename) => onChange(filename ? String(filename) : null))
  // 見張りの失敗（フォルダが消えた等）は、知らせが来なくなるだけにする
  w.on('error', () => undefined)
  return w
}

export function isIgnored(filename: string | null): boolean {
  if (!filename) return false
  const name = filename.replace(/\\/g, '/')
  if (IGNORED_FILES.includes(name)) return true
  if (name.split('/').some((part) => /^\..+\.tmp$/.test(part) || /\.\d+\.[0-9a-f]+\.tmp$/.test(part))) return true
  return IGNORED.some((dir) => name === dir.slice(0, -1) || name.startsWith(dir))
}

export class BusinessWatcher {
  private current: { root: string; handle: { close(): void } } | null = null
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(
    private readonly onChanged: () => void,
    private readonly watchFn: WatchFn = nodeWatch,
    private readonly delayMs: number = DEBOUNCE_MS
  ) {}

  get root(): string | null {
    return this.current?.root ?? null
  }

  /** root を見張る（null で止める）。同じ root なら何もしない */
  watch(root: string | null): void {
    if (root === (this.current?.root ?? null)) return
    this.stop()
    if (!root) return
    try {
      const handle = this.watchFn(root, (filename) => {
        if (!isIgnored(filename)) this.schedule()
      })
      this.current = { root, handle }
    } catch {
      // 見張れないフォルダ（消えた・権限）。画面の読み直しは手動でできる
      this.current = null
    }
  }

  private schedule(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = null
      this.onChanged()
    }, this.delayMs)
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.current?.handle.close()
    this.current = null
  }
}
