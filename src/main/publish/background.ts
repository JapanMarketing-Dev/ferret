/**
 * 「発信」の下書きを裏で作り足す。開いているプロジェクトだけを、15分ごと（起動の1分後に1回）に見て、
 * 新しいコミットがあり、未使用の下書きが少なく、前回から間が空いていれば、最近の変更から数件作る。
 *
 * - 生成は同時に1つだけ（裏の生成と利用者が押した生成も重ねない）
 * - 失敗したら理由と時刻を残す（時刻を残すので、次は間隔が空くまで試さない）
 * - 変更が無いだけのときは何も残さない（失敗ではない）
 */
import { UserFacingError } from '@shared/errors'
import { PUBLISH_LIMITS, type PublishGenerateRequest } from '@shared/publish'
import type { LlmRunner } from '../pipeline/organize/runner'
import {
  collectProjectMaterial, generateDrafts, resolveDraftMedia,
  type GeneratedDraft, type ProjectMaterial, type PublishPromptOptions, type TextMaterial
} from './generate'
import { publishText, type PublishStore } from './store'

export const CHECK_INTERVAL_MS = 15 * 60 * 1000
export const FIRST_CHECK_DELAY_MS = 60 * 1000

export interface PublishProject {
  id: string
  dir: string
}

export interface PublishBackgroundDeps {
  now?: () => number
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
  /** 開いているプロジェクト（無ければ null） */
  project: () => PublishProject | null
  store: Pick<PublishStore, 'add' | 'background' | 'setBackground' | 'pendingCount' | 'recentTitles'>
  /** 使える AI。使えなければ null */
  makeRunner: () => Promise<LlmRunner | null>
  /** runner ごとの待ち時間。既定は API 180秒・CLI 120秒 */
  timeoutMs?: (runner: LlmRunner) => number
  /** runner の作業フォルダ（記録用。CLI の runner は空の一時フォルダで動く） */
  workDir: () => string
  /** 下書きの言語 */
  language?: () => 'ja' | 'en'
  collect?: (dir: string, options: { sinceHead?: string }) => Promise<ProjectMaterial>
  generate?: (runner: LlmRunner, material: ProjectMaterial | TextMaterial,
    options: PublishPromptOptions & { cwd: string; timeoutMs: number }) => Promise<GeneratedDraft[]>
  resolveMedia?: (dir: string, relPaths: readonly string[]) => Promise<Array<{ path: string; bytes: number }>>
  /** 下書き・状態が変わった（画面へ知らせる） */
  onChanged: (projectId: string) => void
}

interface Flight {
  projectId: string
  promise: Promise<number>
}

export class PublishBackground {
  private timer: unknown = null
  private started = false
  private flight: Flight | null = null
  private readonly now: () => number
  private readonly setTimer: (fn: () => void, ms: number) => unknown
  private readonly clearTimer: (handle: unknown) => void

  constructor(private readonly deps: PublishBackgroundDeps) {
    this.now = deps.now ?? Date.now
    this.setTimer = deps.setTimer ?? ((fn, ms) => {
      const handle = setTimeout(fn, ms)
      // 裏の確認のためにアプリの終了を待たせない
      handle.unref?.()
      return handle
    })
    this.clearTimer = deps.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>))
  }

  start(): void {
    if (this.started) return
    this.started = true
    this.schedule(FIRST_CHECK_DELAY_MS)
  }

  stop(): void {
    this.started = false
    if (this.timer !== null) this.clearTimer(this.timer)
    this.timer = null
  }

  isRunning(projectId: string): boolean {
    return this.flight?.projectId === projectId
  }

  private schedule(ms: number): void {
    if (!this.started) return
    this.timer = this.setTimer(() => {
      this.timer = null
      // 失敗は tick の中で状態に残している（ここまで来るのは想定外だけ）
      void this.tick().catch(() => undefined).finally(() => this.schedule(CHECK_INTERVAL_MS))
    }, ms)
  }

  /** 1回の確認（タイマーから呼ぶ。テストからも直接呼ぶ）。作った数を返す */
  async tick(): Promise<number> {
    const project = this.deps.project()
    if (!project || this.flight) return 0
    const state = await this.deps.store.background(project.id)
    if (!state.enabled) return 0
    if (await this.deps.store.pendingCount(project.id) >= PUBLISH_LIMITS.backgroundMaxPending) return 0
    const last = state.lastRunAt ? Date.parse(state.lastRunAt) : NaN
    if (Number.isFinite(last) && this.now() - last < PUBLISH_LIMITS.backgroundIntervalMs) return 0
    // 確かめているあいだに別の生成が始まっていたら譲る
    if (this.flight) return 0
    return this.fly(project.id, async () => {
      const collect = this.deps.collect ?? ((dir, options) => collectProjectMaterial(dir, options))
      const material = await collect(project.dir, state.lastHead ? { sinceHead: state.lastHead } : {})
      // 新しいコミットが無い（前回と同じ HEAD・git でない）。失敗ではないので何も残さない
      if (!material.commits.length) return { added: 0, quiet: true }
      try {
        const added = await this.produce(project, material)
        await this.deps.store.setBackground(project.id, { lastRunAt: this.iso(), lastError: null, ...(material.head ? { lastHead: material.head } : {}) })
        return { added }
      } catch (err) {
        await this.deps.store.setBackground(project.id, { lastRunAt: this.iso(), lastError: errorMessage(err) })
        return { added: 0 }
      }
    })
  }

  /**
   * 利用者が押した生成。text があればその文章から（ai-text）、無ければ最近の変更から（新しいコミットの有無・間隔は見ない）。
   * 同じプロジェクトの生成が走っていればそれを待ち、別のプロジェクトのものが走っていれば断る。作った数を返す
   */
  async runNow(projectId: string, request: PublishGenerateRequest = {}): Promise<number> {
    if (this.flight) {
      if (this.flight.projectId === projectId) return this.flight.promise
      throw new UserFacingError(publishText('publish.errors.alreadyRunning'))
    }
    const project = this.deps.project()
    if (!project || project.id !== projectId) throw new UserFacingError(publishText('publish.errors.projectNotOpen'))
    return this.fly(projectId, async () => {
      if (request.text !== undefined) {
        const text = request.text.slice(0, PUBLISH_LIMITS.sourceTextChars)
        if (!text.trim()) throw new UserFacingError(publishText('publish.errors.nothingToWrite'))
        const added = await this.produce(project, { text, ...(request.textLabel ? { textLabel: request.textLabel } : {}) }, request.hint)
        return { added }
      }
      const collect = this.deps.collect ?? ((dir, options) => collectProjectMaterial(dir, options))
      const material = await collect(project.dir, {})
      if (!material.commits.length && !material.readme) throw new UserFacingError(publishText('publish.errors.nothingToWrite'))
      const added = await this.produce(project, material, request.hint)
      await this.deps.store.setBackground(projectId, { lastRunAt: this.iso(), lastError: null, ...(material.head ? { lastHead: material.head } : {}) })
      return { added }
    })
  }

  /** 生成を1つだけ走らせる。始まり・終わりを画面へ知らせる */
  private fly(projectId: string, work: () => Promise<{ added: number; quiet?: boolean }>): Promise<number> {
    let quiet = false
    const promise = (async () => {
      try {
        const result = await work()
        quiet = result.quiet === true
        return result.added
      } finally {
        this.flight = null
        if (!quiet) this.deps.onChanged(projectId)
      }
    })()
    this.flight = { projectId, promise }
    return promise
  }

  /** AI に作らせて足す。足した数 */
  private async produce(project: PublishProject, material: ProjectMaterial | TextMaterial, hint?: string): Promise<number> {
    const runner = await this.deps.makeRunner()
    if (!runner) throw new UserFacingError(publishText('publish.errors.aiUnavailable'))
    const generate = this.deps.generate ?? generateDrafts
    const resolveMedia = this.deps.resolveMedia ?? resolveDraftMedia
    const timeoutMs = this.deps.timeoutMs?.(runner) ?? (runner.id.startsWith('api:') ? 180_000 : 120_000)
    const drafts = await generate(runner, material, {
      count: PUBLISH_LIMITS.backgroundBatch,
      language: this.deps.language?.() ?? 'ja',
      existingTitles: await this.deps.store.recentTitles(project.id),
      cwd: this.deps.workDir(),
      timeoutMs,
      ...(hint?.trim() ? { hint } : {})
    })
    const source = 'text' in material ? 'ai-text' as const : 'ai-background' as const
    const withMedia = await Promise.all(drafts.map(async (d) => ({
      source, title: d.title, text: d.text, ...(d.basis ? { basis: d.basis } : {}),
      media: d.media.length ? await resolveMedia(project.dir, d.media) : []
    })))
    return (await this.deps.store.add(project.id, withMedia)).length
  }

  private iso(): string {
    return new Date(this.now()).toISOString()
  }
}

/** 状態に残す理由。利用者向けの文はそのまま、それ以外は決まった文にする（パス・英語のエラーを画面に出さない） */
function errorMessage(err: unknown): string {
  if (err instanceof UserFacingError) return err.message
  return publishText('publish.errors.generateFailed')
}
