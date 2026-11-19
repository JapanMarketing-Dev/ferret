/**
 * Ferret アカウント（メールのコードでログイン）で、指摘を PC とチームで共有する。Electron に依存させない（単体テストで偽の client・store を渡す）。
 *
 * - ログインしていれば、skill「ferret-feedback」の書き直しのたびに、この PC の指摘を送り（前と同じ中身なら送らない）、
 *   自分の全部の PC の分とチームの分を読んで控える。feedback.md には、ほかの PC の分（この PC の分は除く）とチームの分を載せる
 * - 送るのはプロジェクトの名前・どこで・題・日時・文だけ。手元のファイルのパスは送らない
 * - つながらないときは控え（cache.json）を使う。トークンが効かなくなったら（401）ログアウトしたことにする
 */
import { createHash } from 'node:crypto'
import {
  CLOUD_LIMITS,
  cloudEntryKey,
  normalizeEmail,
  sanitizeCloudUpload,
  type CloudAppStatus,
  type CloudEntry,
  type CloudEntryRead,
  type CloudFeedback,
  type CloudUpload
} from '@shared/feedbackCloud'
import type { FeedbackCloudExtra, FeedbackEntry, RemoteFeedbackEntry } from '@shared/feedbackSkill'
import { CloudApiError, type CloudClient } from './client'
import type { CloudStore } from './store'

/** この間に読めていれば、skill の書き直しで読み直さない（「今すぐ同期」の直後の書き直しで二度読まない） */
const FRESH_MS = 60_000

/** この PC の指摘を送る形にする（ファイルのパスは入れない）。同じ指摘は1つ */
export async function toCloudEntries(entries: readonly FeedbackEntry[]): Promise<CloudEntry[]> {
  const out: CloudEntry[] = []
  const seen = new Set<string>()
  for (const e of entries) {
    // ほかの PC・チームから来たもの（ファイルが無い）は送り返さない
    if (!e.file || e.origin) continue
    const key = await cloudEntryKey({ project: e.project, source: e.source, text: e.text })
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ key, project: e.project, source: e.source, ...(e.title ? { title: e.title } : {}), ...(e.at ? { at: e.at } : {}), text: e.text })
  }
  return out
}

/** 送る本文。形と大きさを契約に合わせ、上限を超えれば古いものから落とす */
export function buildUpload(deviceId: string, deviceName: string, entries: readonly CloudEntry[]): CloudUpload | null {
  const upload = sanitizeCloudUpload({ deviceId, deviceName, entries })
  if (!upload) return null
  const encoder = new TextEncoder()
  while (upload.entries.length && encoder.encode(JSON.stringify(upload)).byteLength > CLOUD_LIMITS.uploadBytes) {
    upload.entries = upload.entries.slice(0, Math.floor(upload.entries.length * 0.9))
  }
  return upload
}

export function uploadHash(upload: CloudUpload): string {
  return createHash('sha256').update(JSON.stringify(upload)).digest('hex')
}

function remote(e: CloudEntryRead, author?: string): RemoteFeedbackEntry {
  return { project: e.project, source: e.source, ...(e.title ? { title: e.title } : {}), ...(e.at ? { at: e.at } : {}), text: e.text, deviceName: e.deviceName, ...(author ? { author } : {}) }
}

/** 読んだ指摘から feedback.md に足す分を作る（この PC の分は除く） */
export function cloudExtra(feedback: CloudFeedback, deviceId: string): FeedbackCloudExtra {
  return {
    otherDevices: feedback.mine.filter((e) => e.deviceId !== deviceId).map((e) => remote(e)),
    teams: feedback.teams.map((t) => ({ name: t.name, entries: t.entries.map((e) => remote(e, e.author?.name || e.author?.email?.split('@')[0] || 'member')) }))
  }
}

export interface CloudServiceDeps {
  client: CloudClient
  store: CloudStore
  /** この PC の名前（Worker・ほかの PC の feedback.md に出る） */
  deviceName: () => string
  now?: () => number
}

export class CloudService {
  private pendingEmail: string | null = null
  private readonly now: () => number
  /** 同期を1つずつにする */
  private running: Promise<unknown> = Promise.resolve()

  constructor(private readonly deps: CloudServiceDeps) {
    this.now = deps.now ?? Date.now
  }

  async status(): Promise<CloudAppStatus> {
    const account = await this.deps.store.load()
    const persisted = this.deps.store.persisted()
    if (!account) return { loggedIn: false, persisted }
    const cache = await this.deps.store.readCache()
    return {
      loggedIn: true, email: account.email, persisted,
      ...(cache ? { lastSyncAt: cache.syncedAt, mine: cache.feedback.mine.length, team: cache.feedback.teams.reduce((n, t) => n + t.entries.length, 0) } : {})
    }
  }

  /** メールにコードを送ってもらう。bad_email は送る前に断る */
  async start(rawEmail: unknown): Promise<void> {
    const email = normalizeEmail(rawEmail)
    if (!email) throw new CloudApiError('bad_email')
    await this.deps.client.start(email)
    this.pendingEmail = email
  }

  /** start で送ったメールのコードでログインする */
  async verify(rawCode: unknown): Promise<CloudAppStatus> {
    const code = typeof rawCode === 'string' ? rawCode.replace(/\s+/g, '') : ''
    if (!this.pendingEmail) throw new CloudApiError('code_expired')
    const { token, me } = await this.deps.client.verify(this.pendingEmail, code)
    this.pendingEmail = null
    // 前の人の控えを残さない
    await this.deps.store.clear()
    await this.deps.store.save({ token, email: normalizeEmail(me.email) ?? me.email })
    return this.status()
  }

  /** ログアウト。Worker に届かなくても手元のトークンと控えは消す */
  async logout(): Promise<void> {
    const account = await this.deps.store.load()
    this.pendingEmail = null
    if (account) await this.deps.client.logout(account.token).catch(() => undefined)
    await this.deps.store.clear()
  }

  /**
   * この PC の指摘を送り（前と同じなら送らない）、全部を読んで控える。ログインしていなければ null。
   * 失敗は CloudApiError で投げる（401 ならログアウトしたことにする）
   */
  async sync(entries: readonly FeedbackEntry[]): Promise<CloudFeedback | null> {
    const run = this.running.then(() => this.syncNow(entries))
    this.running = run.catch(() => undefined)
    return run
  }

  private async syncNow(entries: readonly FeedbackEntry[]): Promise<CloudFeedback | null> {
    const { store, client } = this.deps
    const account = await store.load()
    if (!account) return null
    try {
      const upload = buildUpload(await store.device(), this.deps.deviceName(), await toCloudEntries(entries))
      const cache = await store.readCache()
      const hash = upload ? uploadHash(upload) : undefined
      if (upload && hash !== cache?.uploadHash) await client.upload(account.token, upload)
      const feedback = await client.download(account.token)
      await store.writeCache({ feedback, syncedAt: new Date(this.now()).toISOString(), ...(hash ? { uploadHash: hash } : {}) })
      return feedback
    } catch (err) {
      if (err instanceof CloudApiError && err.code === 'unauthorized') await store.clear()
      throw err
    }
  }

  /**
   * skill の書き直しから呼ぶ。ログインしていなければ null。つながらなければ控えを使う。投げない
   * （思っていない失敗だけ report に渡す。つながらない・混んでいるのは想定内）
   */
  async extraFor(entries: readonly FeedbackEntry[], report?: (err: unknown) => void): Promise<FeedbackCloudExtra | null> {
    const { store } = this.deps
    const account = await store.load()
    if (!account) return null
    const deviceId = await store.device()
    const cache = await store.readCache()
    let feedback: CloudFeedback | null = null
    const fresh = cache && this.now() - Date.parse(cache.syncedAt) < FRESH_MS
    const upload = fresh ? buildUpload(deviceId, this.deps.deviceName(), await toCloudEntries(entries)) : null
    if (fresh && upload && uploadHash(upload) === cache.uploadHash) feedback = cache.feedback
    else {
      try {
        feedback = await this.sync(entries)
      } catch (err) {
        if (err instanceof CloudApiError && err.code === 'unauthorized') return null
        if (!(err instanceof CloudApiError) || !EXPECTED.has(err.code)) report?.(err)
        feedback = (await store.readCache())?.feedback ?? null
      }
    }
    return feedback ? cloudExtra(feedback, deviceId) : null
  }

  /** 読み込み済みでログインしているか（読み込み前は鍵の仕組みに触れずに false） */
  loggedInCached(): boolean {
    return this.deps.store.loadedLoggedIn() === true
  }
}

/** つながらない・混んでいる・Worker の一時的な失敗。知らせない */
const EXPECTED = new Set<string>(['network', 'rate_limited', 'server', 'mail_failed'])
