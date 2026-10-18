/**
 * アップロードの受け渡し（Movie_ADE の docs/14）。`ferret-video publish upload` が <動画>/.ferret-video/publish-request.json を書いて待つ。
 * トークンを持つアプリが publish.json のとおりに上げ、同じ id で <動画>/.ferret-video/publish-result.json を書く
 * （先に `state: running`（受け取った・進み具合）、終わったら `state: done`）。
 * 上げたものは <動画>/.ferret-video/publish-log.json に記録し、同じファイルを同じ投稿先へ二度上げない（頼みに force があれば上げる）。
 *
 * 二重投稿を防ぐ決まり:
 * - 同じ id の頼みは二度と実行しない（再起動しても、結果ファイルに同じ id があれば実行しない）
 * - 同じ動画で同時に2つは走らない。途中で来た頼みは、今のアップロードが終わってから処理する
 * - 10 分以上前の頼み（受け取られないまま）は無視する
 * - アプリが途中で終わって running のまま残った結果は、次に見たときに「中断されました」で閉じる（自動では上げ直さない）
 *
 * Electron に依存させない（アップロードと `publish record` は渡す。テストは偽物を使う）。
 */
import { mkdirSync, readFileSync, readdirSync, realpathSync, statSync, watch, type FSWatcher } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { writePrivateFileAtomicSync } from '../../../../main/atomicFile'
import { t } from '@shared/i18n'
import {
  BUILTIN_DEFAULTS,
  PUBLISH_FILE,
  PUBLISH_LOG_FILE,
  REQUEST_FILE,
  RESULT_FILE,
  alreadyPublished,
  issueBlocks,
  issueText,
  parsePublishJson,
  parsePublishLog,
  parsePublishRequest,
  parsePublishResult,
  requestIsStale,
  targetsToUpload,
  type PublishDefaults,
  type PublishLogEntry,
  type PublishRequest,
  type PublishResult,
  type PublishSpec,
  type PublishTargetId,
  type PublishTargetResult
} from '../../shared/publish'

export interface UploadContext {
  dir: string
  spec: PublishSpec
  videoPath: string
  thumbnailPath?: string
  onProgress: (phase: string, fraction?: number) => void
}

export interface UploadOutcome {
  url?: string
  status: 'published' | 'scheduled' | 'inbox'
  warnings: string[]
}

export type RecordStatus = 'published' | 'scheduled' | 'draft' | 'failed'

export interface HandoffDeps {
  upload: Record<PublishTargetId, (c: UploadContext) => Promise<UploadOutcome>>
  /** `ferret-video publish record`（できる範囲で。例外を投げてもよい） */
  record?: (dir: string, target: PublishTargetId, status: RecordStatus, url?: string) => Promise<void>
  now?: () => number
  /** 設定の publish.youtube.privacy / publish.tiktok.privacy（publish.json に書かれていないときに使う） */
  defaults?: () => PublishDefaults
  /** 頼み・結果のファイルが変わった（画面が読み直す） */
  onChange?: (dir: string) => void
}

export type CheckOutcome = 'none' | 'invalid' | 'handled' | 'stale' | 'busy' | 'processed'

export function readText(path: string): string | null {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

/** 一時ファイルに書いてから置き換える（CLI が書きかけを読まない） */
export function writeJsonAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true })
  writePrivateFileAtomicSync(path, JSON.stringify(value, null, 2) + '\n')
}

export function readRequest(dir: string): PublishRequest | null {
  return parsePublishRequest(readText(join(dir, REQUEST_FILE)))
}

export function readResult(dir: string): PublishResult | null {
  return parsePublishResult(readText(join(dir, RESULT_FILE)))
}

export function readLog(dir: string): PublishLogEntry[] {
  return parsePublishLog(readText(join(dir, PUBLISH_LOG_FILE)))
}

function appendLog(dir: string, e: PublishLogEntry): void {
  writeJsonAtomic(join(dir, PUBLISH_LOG_FILE), { entries: [...readLog(dir), e] })
}

/**
 * dir の中の rel の実体（リンクをたどったもの）が dir の中にあるファイルなら、その絶対パス。無い・外を指すなら null。
 * publish.json の相対パスはフォルダの外へ出られないが、途中のリンクで外のファイルを上げさせない
 */
export function containedFile(dir: string, rel: string): string | null {
  const abs = resolve(dir, rel)
  try {
    const root = realpathSync(dir)
    const real = realpathSync(abs)
    if (!real.startsWith(root + sep)) return null
    return statSync(real).isFile() ? abs : null
  } catch {
    return null
  }
}

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e))

export class PublishHandoff {
  private busy = new Set<string>()
  private now: () => number

  constructor(private deps: HandoffDeps) {
    this.now = deps.now ?? Date.now
  }

  isBusy(dir: string): boolean {
    return this.busy.has(resolve(dir))
  }

  /**
   * 動画の頼みを見て、新しければ実行する。同じ id の結果（running でも done でも）がある頼みは二度と実行しない。
   * 受け取られないまま REQUEST_TTL_MS を過ぎた頼みは無視する。実行のあとは、その間に来た頼みも見る。
   */
  async check(dir: string): Promise<CheckOutcome> {
    const key = resolve(dir)
    if (this.busy.has(key)) return 'busy'
    const text = readText(join(dir, REQUEST_FILE))
    if (text === null) return 'none'
    const req = parsePublishRequest(text)
    if (!req) return 'invalid'
    const prev = readResult(dir)
    if (prev && prev.id === req.id) {
      // このプロセスで走っていないのに running: アプリが途中で終わった。勝手に続けない（二重投稿のほうが悪い）。
      // 閉じて、待っている CLI に答えを返す
      if (prev.state === 'running') {
        this.write(dir, { ...prev, state: 'done', at: new Date(this.now()).toISOString(), error: t('video.publish.result.interrupted') })
      }
      return 'handled'
    }
    if (requestIsStale(req, this.now())) return 'stale'
    this.busy.add(key)
    try {
      await this.run(dir, req)
    } finally {
      this.busy.delete(key)
    }
    await this.check(dir)
    return 'processed'
  }

  private write(dir: string, r: PublishResult): void {
    writeJsonAtomic(join(dir, RESULT_FILE), r)
    this.deps.onChange?.(dir)
  }

  private async run(dir: string, req: PublishRequest): Promise<void> {
    const iso = () => new Date(this.now()).toISOString()
    const results: PublishTargetResult[] = []
    const running = (progress?: PublishResult['progress']) =>
      this.write(dir, { id: req.id, state: 'running', at: iso(), ...(progress ? { progress } : {}), results: [...results] })
    const done = (error?: string) => this.write(dir, { id: req.id, state: 'done', at: iso(), results, ...(error ? { error } : {}) })
    running()

    const text = readText(join(dir, PUBLISH_FILE))
    if (text === null) return done(t('video.publish.result.noFile'))
    let defaults = BUILTIN_DEFAULTS
    try {
      defaults = this.deps.defaults?.() ?? BUILTIN_DEFAULTS
    } catch {
      // 設定が読めない: 安全な既定（非公開・自分のみ）で続ける（想定内）
    }
    const { spec, issues } = parsePublishJson(text, new Date(this.now()), defaults)
    if (!spec) return done(issues.map((i) => issueText(i)).join('; '))
    const targets = targetsToUpload(spec, req.targets)
    if (!targets.length) return done(t('video.publish.result.noTarget'))

    const videoPath = containedFile(dir, spec.video)
    const size = videoPath ? statSync(videoPath).size : -1
    const thumbPath = spec.thumbnail ? containedFile(dir, spec.thumbnail) ?? undefined : undefined

    for (const target of targets) {
      const blocking = issues.filter((i) => issueBlocks(i, target))
      if (blocking.length) {
        results.push({ target, ok: false, error: blocking.map((i) => issueText(i)).join('; ') })
        continue
      }
      if (!videoPath || size <= 0) {
        results.push({ target, ok: false, error: t('video.publish.result.noVideo', { path: spec.video }) })
        continue
      }
      const prior = alreadyPublished(readLog(dir), target, spec.video, size)
      if (prior && !req.force) {
        results.push({ target, ok: true, alreadyPublished: true, ...(prior.url ? { url: prior.url } : {}), ...(prior.status ? { status: prior.status } : {}) })
        continue
      }
      let last = { phase: '', pct: -1 }
      running({ target, phase: 'start' })
      try {
        const out = await this.deps.upload[target]({
          dir,
          spec,
          videoPath,
          ...(thumbPath ? { thumbnailPath: thumbPath } : {}),
          onProgress: (phase, fraction) => {
            const pct = fraction === undefined ? -1 : Math.floor(fraction * 50) // 2 % ごと
            if (phase === last.phase && pct === last.pct) return
            last = { phase, pct }
            running({ target, phase, ...(fraction !== undefined ? { fraction } : {}) })
          }
        })
        const warnings = [...out.warnings, ...(spec.thumbnail && !thumbPath && target === 'youtube' ? [t('video.publish.warn.thumbMissing', { path: spec.thumbnail })] : [])]
        results.push({ target, ok: true, status: out.status, ...(out.url ? { url: out.url } : {}), ...(warnings.length ? { warnings } : {}) })
        appendLog(dir, { target, video: spec.video, size, status: out.status, requestId: req.id, at: iso(), ...(out.url ? { url: out.url } : {}) })
        const recStatus: RecordStatus = out.status === 'inbox' ? 'draft' : out.url ? out.status : 'draft'
        await this.deps.record?.(dir, target, recStatus, out.url).catch(() => undefined)
      } catch (e) {
        results.push({ target, ok: false, error: msg(e) })
        await this.deps.record?.(dir, target, 'failed').catch(() => undefined)
      }
    }
    done()
  }
}

export type WatchWhat = 'request' | 'result' | 'spec' | 'thumbnails'

/** 動画のフォルダの中の、見張るファイルの種類（チャンネルからの相対パス、/ 区切りでも \ 区切りでも） */
export function classifyChange(rel: string): { video: string; what: WatchWhat } | null {
  const parts = rel.split(/[\\/]/).filter(Boolean)
  if (parts.length < 2) return null
  const [video, ...rest] = parts
  if (!video || video.startsWith('.')) return null
  const sub = rest.join('/')
  if (sub === PUBLISH_FILE) return { video, what: 'spec' }
  if (sub === REQUEST_FILE) return { video, what: 'request' }
  if (sub === RESULT_FILE) return { video, what: 'result' }
  if (rest[0] === 'thumbnails') return { video, what: 'thumbnails' }
  return null
}

/** チャンネルの直下の動画のフォルダ（隠しフォルダ・node_modules は除く） */
export function videoDirs(channel: string): string[] {
  try {
    return readdirSync(channel, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules')
      .map((e) => join(channel, e.name))
  } catch {
    return []
  }
}

/**
 * 今開いているチャンネル（動画のフォルダの親）を見張る。直下の動画のフォルダの publish.json・thumbnails/・受け渡しのファイルが対象。
 * fs.watch はどこでも確かではない（ネットワークドライブ・あとから作られた .ferret-video）ので、頼みのファイルは 2 秒ごとにも見る。
 */
export class PublishWatcher {
  private watcher: FSWatcher | null = null
  private channel: string | null = null
  private timer: ReturnType<typeof setInterval> | null = null
  private lastReq = new Map<string, number>()

  constructor(private onEvent: (dir: string, what: WatchWhat) => void, private pollMs = 2000, private beforePoll?: () => void) {}

  current(): string | null {
    return this.channel
  }

  /** 見張るチャンネルを変える（同じなら何もしない。null で止める） */
  watch(channel: string | null): void {
    const next = channel ? resolve(channel) : null
    if (next === this.channel) return
    this.close()
    this.channel = next
    if (!next) return
    try {
      const w = watch(next, { persistent: false, recursive: true }, (_e, name) => {
        const hit = name ? classifyChange(String(name)) : null
        if (!hit) return
        const dir = join(next, hit.video)
        if (hit.what === 'request') this.lastReq.set(dir, this.mtime(dir))
        this.onEvent(dir, hit.what)
      })
      w.on('error', () => undefined)
      this.watcher = w
    } catch {
      // 見張れないファイルシステム: 頼みは 2 秒ごとの確認で拾う（想定内）
    }
    // アプリを閉じている間に書かれた頼み（まだ新しいもの）は今拾う。running のまま残った結果もここで閉じる
    for (const dir of videoDirs(next)) {
      const m = this.mtime(dir)
      this.lastReq.set(dir, m)
      if (m) this.onEvent(dir, 'request')
    }
    this.timer = setInterval(() => this.poll(), this.pollMs)
    this.timer.unref?.()
  }

  private mtime(dir: string): number {
    try {
      return statSync(join(dir, REQUEST_FILE)).mtimeMs
    } catch {
      return 0
    }
  }

  private poll(): void {
    this.beforePoll?.()
    const channel = this.channel
    if (!channel) return
    for (const dir of videoDirs(channel)) {
      const m = this.mtime(dir)
      if (m && m !== this.lastReq.get(dir)) {
        this.lastReq.set(dir, m)
        this.onEvent(dir, 'request')
      }
    }
  }

  close(): void {
    this.watcher?.close()
    this.watcher = null
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    this.channel = null
    this.lastReq.clear()
  }
}

