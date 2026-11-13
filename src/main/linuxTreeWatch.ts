import { watch, type FSWatcher } from 'node:fs'
import { opendir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { shouldIncludePath } from '@shared/files'

/**
 * Linux 用の、フォルダごとの変更の見張り。
 *
 * Linux の fs.watch(root, { recursive: true }) は Node が中のフォルダ（node_modules・.git も）を全部たどって
 * inotify を張る。大きなリポジトリでは起動が重く、上限（fs.inotify.max_user_watches）に当たると
 * ENOSPC で見張りが黙って止まり、Agent が書いた変更がエディタに届かなくなる。
 * ここでは変更通知の対象（shouldIncludePath）のフォルダにだけ、1つずつ張る。
 * 例外として、指摘の進み具合（.ferret/reviews/<id>/progress.json）を拾うため .ferret/reviews/<id> までは降りる。
 * ビジュアルレビューの計画（.ferret/visual-review/<id>.json と画像のフォルダ）も拾うため .ferret/visual-review/<id> まで降りる。
 * 価値ユースケース（.ferret/value-usecases/<id>.json と画像のフォルダ）も同じく .ferret/value-usecases/<id> まで降りる。
 */

/** 張るフォルダの数の上限。超えた分は見張らない（上限に当たってほかのアプリの見張りまで止めないため） */
const MAX_WATCHED_DIRS = 8000
/**
 * 見張るフォルダを探すときに読む項目（ファイルも含む）の数と時間の上限（security-7 [11]）。
 * 張る数の上限だけでは、1つのフォルダに何百万の項目があると、その名前を全部読むまで止まらない。
 * 項目は opendir で少しずつ読み、上限に当たったらそこで探すのをやめる（見張れた分だけで動く）
 */
export const MAX_SCANNED_ENTRIES = 200_000
export const MAX_DISCOVERY_MS = 30_000

/** このフォルダ（`/` 区切りの相対パス。'' はプロジェクトの直下）に降りて見張るか */
export function shouldWatchDir(rel: string): boolean {
  if (rel === '' || shouldIncludePath(rel)) return true
  if (/^\.ferret\/(?:visual-review|value-usecases)(?:\/[^/]+)?$/.test(rel)) return true
  return /^\.(?:ferret|ade-movie)(?:\/reviews(?:\/[^/]+)?)?$/.test(rel)
}

type Listener = (event: string, filename: string) => void
/** フォルダ1つを見張る関数（fs.watch の形）。単体テストは差し替えて、通知を自分で出す（OS の通知の遅れに左右されない） */
export type WatchDir = (path: string, listener: (event: string, filename: string | Buffer | null) => void) => FSWatcher

interface DiscoveryBudget {
  scanned: number
  startedAt: number
}
const newBudget = (): DiscoveryBudget => ({ scanned: 0, startedAt: Date.now() })

export class LinuxTreeWatcher {
  private readonly watchers = new Map<string, FSWatcher>()
  private readonly errorListeners: Array<(err: unknown) => void> = []
  private closed = false
  private limitReported = false
  /** 開いたときの探索の枠（読んだ項目の数と、探し始めた時刻。security-7 [11]）。あとから増えたフォルダは、そのたびに新しい枠で探す */
  private readonly initial: DiscoveryBudget = newBudget()

  constructor(private readonly root: string, private readonly listener: Listener,
    /** 上限に当たって一部を見張れなかったとき（1回だけ） */
    private readonly onLimit?: (err: unknown) => void,
    private readonly watchDir: WatchDir = (path, listener) => watch(path, listener)) {
    // 直下は同期で張る（作れなければ fs.watch と同じく投げる）
    this.addDir('', true)
    void this.addChildren('', this.initial)
  }

  on(event: 'error', listener: (err: unknown) => void): this {
    if (event === 'error') this.errorListeners.push(listener)
    return this
  }

  /** fs.watch（FSWatcher）と同じ形でエラーを知らせる。プロジェクトの監視の張り直しのテストが、どの OS でも同じ手で止められるように */
  emit(event: 'error', err: unknown): boolean {
    if (event !== 'error') return false
    for (const listener of this.errorListeners) listener(err)
    return this.errorListeners.length > 0
  }

  close(): void {
    this.closed = true
    for (const watcher of this.watchers.values()) watcher.close()
    this.watchers.clear()
  }

  /** 見張っているフォルダの数（単体テスト用） */
  get size(): number {
    return this.watchers.size
  }

  private addDir(rel: string, rethrow = false): boolean {
    if (this.closed || this.watchers.has(rel)) return false
    if (this.watchers.size >= MAX_WATCHED_DIRS) {
      this.reportLimit(new Error(`more than ${MAX_WATCHED_DIRS} folders`))
      return false
    }
    let watcher: FSWatcher
    try {
      watcher = this.watchDir(rel ? join(this.root, rel) : this.root, (event, name) => {
        if (!name) return
        const child = rel ? `${rel}/${String(name)}` : String(name)
        this.listener(event, child)
        if (event === 'rename') void this.onRename(child)
      })
    } catch (err) {
      if (rethrow) throw err
      // ENOSPC（inotify の上限）・消えたフォルダ・読めないフォルダ。そこから下は見張らない
      if ((err as NodeJS.ErrnoException).code === 'ENOSPC') this.reportLimit(err)
      return false
    }
    watcher.on('error', (err) => {
      this.removeTree(rel)
      if (rel === '') for (const listener of this.errorListeners) listener(err)
    })
    this.watchers.set(rel, watcher)
    return true
  }

  /** 探す枠（項目の数・時間）が残っているか。尽きたら1回だけ知らせる */
  private budgetLeft(budget: DiscoveryBudget): boolean {
    if (budget.scanned < MAX_SCANNED_ENTRIES && Date.now() - budget.startedAt < MAX_DISCOVERY_MS) return true
    this.reportLimit(new Error(`scanned more than ${MAX_SCANNED_ENTRIES} entries or ${MAX_DISCOVERY_MS / 1000}s`))
    return false
  }

  private async addChildren(rel: string, budget: DiscoveryBudget): Promise<void> {
    if (!this.budgetLeft(budget)) return
    let dir
    try {
      dir = await opendir(rel ? join(this.root, rel) : this.root, { bufferSize: 64 })
    } catch {
      return // 消えた・読めない（想定内）
    }
    // 下のフォルダは、このフォルダを読み終えて閉じてから降りる（開いたままのフォルダを深さの分だけ増やさない）
    const subdirs: string[] = []
    try {
      for await (const entry of dir) {
        if (this.closed) return
        budget.scanned += 1
        if (!this.budgetLeft(budget)) return
        if (!entry.isDirectory()) continue
        const child = rel ? `${rel}/${entry.name}` : entry.name
        if (shouldWatchDir(child) && this.addDir(child)) subdirs.push(child)
      }
    } catch {
      return // 読んでいる途中で消えた（想定内）
    } finally {
      // for await を途中で抜けても閉じる（抜けずに読み終えたときは自動で閉じている）
      await dir.close().catch(() => undefined)
    }
    for (const child of subdirs) {
      if (this.closed) return
      await this.addChildren(child, budget)
    }
  }

  /** フォルダが増えたら張り、消えたら外す */
  private async onRename(rel: string): Promise<void> {
    const isDir = await stat(join(this.root, rel)).then((s) => s.isDirectory(), () => false)
    if (this.closed) return
    if (!isDir) {
      this.removeTree(rel)
      return
    }
    if (shouldWatchDir(rel) && this.addDir(rel)) await this.addChildren(rel, newBudget())
  }

  private removeTree(rel: string): void {
    for (const [key, watcher] of this.watchers) {
      if (key === rel || (rel !== '' && key.startsWith(`${rel}/`)) || rel === '') {
        watcher.close()
        this.watchers.delete(key)
      }
    }
  }

  private reportLimit(err: unknown): void {
    if (this.limitReported) return
    this.limitReported = true
    this.onLimit?.(err)
  }
}
