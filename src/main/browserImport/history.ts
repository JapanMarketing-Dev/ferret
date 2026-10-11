/**
 * ほかのブラウザの履歴の取り込み（内蔵ブラウザの URL 欄の候補にだけ使う）。
 *
 * - Chromium 系（Chrome・Edge・Brave・Arc など）: プロフィールの History（SQLite。暗号化されていない）
 * - Safari: ~/Library/Safari/History.db。macOS のフルディスクアクセスが無いと読めない（読めなければ案内する）
 *
 * ブラウザが開いている間は DB がロックされているので、一時フォルダへ写してから読む（-wal / -journal も一緒に写す）。
 * SQLite は Electron に入っている Node の node:sqlite で読む（依存を増やさない）。
 * 取り込んだ履歴は「全プロジェクト共通の取り込み済み履歴」として userData/browser-import/history.json に持つ。
 * 内蔵ブラウザのふだんの履歴（プロジェクトごと。src/renderer/lib/urlHistory.ts）とは混ぜない。
 */
import { copyFile, mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { savePrivateFile } from '../atomicFile'
import { chromiumUserDataDirs, isChromiumProfileDir } from '@shared/browserExtensions'
import {
  BROWSER_IMPORT_LIMITS,
  chromiumMsToUnixMs,
  mergeHistory,
  safariSecondsToUnixMs,
  sanitizeHistory,
  suggestHistory,
  toHistoryEntry,
  type HistorySourceInfo,
  type ImportedHistoryEntry
} from '@shared/browserImport'

/** 見つけた元。path は main の中だけで持つ（画面へは key だけ） */
export interface HistorySource extends HistorySourceInfo {
  path: string
}

/** Safari の履歴が macOS の権限（フルディスクアクセス）で読めなかった */
export class HistoryAccessDeniedError extends Error {
  constructor() {
    super('history database is not readable (permission)')
    this.name = 'HistoryAccessDeniedError'
  }
}

/** 履歴を取り込む元になる Chromium 系のブラウザのユーザーデータのフォルダ（拡張の取り込みと同じ一覧＋Arc） */
export function historyBrowserRoots(platform: string, home: string, env: Record<string, string | undefined>): Array<{ browser: string; dir: string }> {
  const roots = chromiumUserDataDirs(platform, home, env)
  if (platform === 'darwin') roots.push({ browser: 'Arc', dir: join(home, 'Library', 'Application Support', 'Arc', 'User Data') })
  return roots
}

/** この端末の履歴の元を探す。Safari は macOS なら必ず候補に出す（権限が無いと有無も分からないため。読むときに案内する） */
export async function detectHistorySources(platform: string, home: string, env: Record<string, string | undefined>): Promise<HistorySource[]> {
  const found: HistorySource[] = []
  for (const root of historyBrowserRoots(platform, home, env)) {
    let profiles: string[] = []
    try {
      profiles = (await readdir(root.dir)).filter(isChromiumProfileDir).sort()
    } catch {
      // そのブラウザが入っていない（想定内）
      continue
    }
    for (const profile of profiles) {
      const path = join(root.dir, profile, 'History')
      if (!existsSync(path)) continue
      found.push({ key: `${root.browser}|${profile}`, browser: root.browser, profile, kind: 'chromium', path })
    }
  }
  if (platform === 'darwin') found.push({ key: 'Safari|', browser: 'Safari', profile: '', kind: 'safari', path: join(home, 'Library', 'Safari', 'History.db') })
  return found
}

/** 写す DB の大きさの上限（巨大な履歴で一時フォルダを埋めない） */
const MAX_DB_BYTES = 1024 * 1024 * 1024

function isPermissionError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | null)?.code
  return code === 'EPERM' || code === 'EACCES'
}

/**
 * DB を一時フォルダへ写して読む（-wal・-journal も写す）。読み終えたら写しは消す。
 * Safari のフォルダが権限で読めなければ HistoryAccessDeniedError
 */
export async function readHistorySource(source: Pick<HistorySource, 'kind' | 'path'>, limit: number = BROWSER_IMPORT_LIMITS.historyRowsPerSource): Promise<ImportedHistoryEntry[]> {
  let size = 0
  try {
    size = (await stat(source.path)).size
  } catch (err) {
    if (isPermissionError(err)) throw new HistoryAccessDeniedError()
    throw err
  }
  if (size > MAX_DB_BYTES) throw new Error('history database is too large')
  const dir = await mkdtemp(join(tmpdir(), 'ferret-history-'))
  try {
    const copy = join(dir, basename(source.path))
    try {
      await copyFile(source.path, copy)
    } catch (err) {
      if (isPermissionError(err)) throw new HistoryAccessDeniedError()
      throw err
    }
    for (const suffix of ['-wal', '-journal']) {
      // 無ければそれで良い（想定内）
      await copyFile(`${source.path}${suffix}`, `${copy}${suffix}`).catch(() => undefined)
    }
    const { DatabaseSync } = await import('node:sqlite')
    const db = new DatabaseSync(copy)
    try {
      // Chromium の時刻は 1601 年からのマイクロ秒で、JS の安全な整数を超える。SQL でミリ秒に落としてから受け取る
      const sql = source.kind === 'chromium'
        ? 'SELECT url, title, CAST(last_visit_time / 1000 AS INTEGER) AS t FROM urls WHERE hidden = 0 AND last_visit_time > 0 ORDER BY last_visit_time DESC LIMIT ?'
        : 'SELECT i.url AS url, v.title AS title, MAX(v.visit_time) AS t FROM history_items i JOIN history_visits v ON v.history_item = i.id GROUP BY i.id ORDER BY t DESC LIMIT ?'
      const rows = db.prepare(sql).all(limit) as Array<{ url: unknown; title: unknown; t: unknown }>
      const toUnix = source.kind === 'chromium' ? chromiumMsToUnixMs : safariSecondsToUnixMs
      return rows.flatMap((row) => {
        const entry = toHistoryEntry({ url: row.url, title: row.title, lastVisit: toUnix(Number(row.t)) })
        return entry ? [entry] : []
      })
    } finally {
      db.close()
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

/** 取り込んだ履歴（全プロジェクト共通）。最初に要るときに読み、変えたら書く */
export class ImportedHistoryStore {
  private entries: ImportedHistoryEntry[] | null = null

  constructor(private readonly path: string) {}

  private async load(): Promise<ImportedHistoryEntry[]> {
    if (this.entries) return this.entries
    try {
      this.entries = sanitizeHistory(JSON.parse(await readFile(this.path, 'utf8')))
    } catch {
      // まだ取り込んでいない・壊れている（想定内。空から）
      this.entries = []
    }
    return this.entries
  }

  private async save(entries: ImportedHistoryEntry[]): Promise<void> {
    this.entries = entries
    if (entries.length === 0) {
      await rm(this.path, { force: true })
      return
    }
    await savePrivateFile(this.path, JSON.stringify({ version: 1, entries }))
  }

  async count(): Promise<number> {
    return (await this.load()).length
  }

  /** 足して、増えた件数を返す */
  async add(incoming: readonly ImportedHistoryEntry[]): Promise<number> {
    const before = await this.load()
    const merged = mergeHistory(before, incoming)
    await this.save(merged)
    return Math.max(0, merged.length - before.length)
  }

  async clear(): Promise<void> {
    await this.save([])
  }

  async suggest(query: string, limit?: number): Promise<ImportedHistoryEntry[]> {
    return suggestHistory(await this.load(), query, limit)
  }
}
