/**
 * 投稿の main 側の中身（ipc.ts が初めて使うときに動的 import する）。Electron の部品（net.fetch・shell・safeStorage）はここでだけ使う。
 */
import { join } from 'node:path'
import { net, safeStorage, shell } from 'electron'
import { UserFacingError } from '@shared/errors'
import { getLocale, t } from '@shared/i18n'
import { chooseKeyCipher } from '../../../../main/pipeline/stt/keys'
import type { VideoMainContext } from '../context'
import type { VideoPublishPromptKind } from '../../shared/ipc/publish'
import { BUILTIN_DEFAULTS, PUBLISH_FILE, PUBLISH_TARGETS, TIKTOK_UPLOAD_PAGE, fixInstruction, parsePublishJson, publishDefaultsFrom, type PublishDefaults, type PublishTargetId, type VideoPublishAccounts, type VideoPublishState } from '../../shared/publish'
import { oauthClients } from './config'
import { PublishHandoff, PublishWatcher, containedFile, readText, type RecordStatus, type WatchWhat } from './handoff'
import { listThumbnails, loadState, resolveVideoDir, setPrivacy, setThumbnail, videoProjectInfo } from './data'
import { VideoPublishStore } from './store'
import { TikTokService } from './tiktok'
import { YouTubeService, type Fetcher } from './youtube'

export const CONNECTIONS_FILE = 'video-publish-connections.bin'

const IS_E2E = process.env.ADE_E2E === '1'

export class VideoPublishService {
  readonly store: VideoPublishStore
  readonly youtube: YouTubeService
  readonly tiktok: TikTokService
  private readonly handoff: PublishHandoff
  private watcher: PublishWatcher | null = null
  private changeTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private connecting: PublishTargetId | null = null

  constructor(private readonly ctx: VideoMainContext) {
    this.store = new VideoPublishStore(join(ctx.userDataDir, CONNECTIONS_FILE), chooseKeyCipher({ isPackaged: ctx.isPackaged, isE2E: IS_E2E, safeStorage }))
    const fetch: Fetcher = (url, init) => net.fetch(url, init)
    const openExternal = (url: string) => shell.openExternal(url)
    const clients = () => oauthClients(ctx.isPackaged)
    this.youtube = new YouTubeService({ fetch, openExternal, store: this.store, client: () => clients().youtube })
    this.tiktok = new TikTokService({ fetch, openExternal, store: this.store, client: () => clients().tiktok })
    this.handoff = new PublishHandoff({
      upload: { youtube: (c) => this.youtube.upload(c), tiktok: (c) => this.tiktok.upload(c) },
      record: (dir, target, status, url) => this.record(dir, target, status, url),
      defaults: () => this.defaults(),
      onChange: (dir) => this.changed(dir)
    })
  }

  private async record(dir: string, target: PublishTargetId, status: RecordStatus, url?: string): Promise<void> {
    const { runVideoCli } = await import('../cli/run')
    await runVideoCli(['publish', 'record', '--target', target, '--status', status, ...(url ? ['--url', url] : [])], { cwd: dir })
  }

  /** 設定の既定の公開範囲（~/.ferret/video/settings.json）。読めなければ安全な既定 */
  private defaultsCache: { at: number; value: PublishDefaults } | null = null
  defaults(): PublishDefaults {
    return this.defaultsCache?.value ?? BUILTIN_DEFAULTS
  }

  async refreshDefaults(): Promise<PublishDefaults> {
    if (this.defaultsCache && Date.now() - this.defaultsCache.at < 5000) return this.defaultsCache.value
    try {
      const { loadSettings } = await import('@video/settings')
      this.defaultsCache = { at: Date.now(), value: publishDefaultsFrom(loadSettings()) }
    } catch {
      this.defaultsCache = { at: Date.now(), value: BUILTIN_DEFAULTS }
    }
    return this.defaultsCache.value
  }

  /** 画面へ「変わった」を送る（続けて来たものは 1 回にまとめる） */
  private changed(dir: string): void {
    const prev = this.changeTimers.get(dir)
    if (prev) clearTimeout(prev)
    this.changeTimers.set(dir, setTimeout(() => {
      this.changeTimers.delete(dir)
      this.ctx.send('video:publish:changed', dir)
    }, 150))
  }

  // ---------- 見張り ----------

  private channel(): string | null {
    const project = this.ctx.project()
    return project?.kind === 'video' ? this.ctx.folderPath() : null
  }

  start(): void {
    this.watcher ??= new PublishWatcher((dir, what) => this.onEvent(dir, what), 2000, () => this.watcher?.watch(this.channel()))
    this.watcher.watch(this.channel())
  }

  stop(): void {
    this.watcher?.close()
    this.watcher = null
    for (const timer of this.changeTimers.values()) clearTimeout(timer)
    this.changeTimers.clear()
    this.youtube.cancelConnect()
    this.tiktok.cancelConnect()
  }

  private onEvent(dir: string, what: WatchWhat): void {
    if (what === 'request') {
      void this.refreshDefaults().then(() => this.handoff.check(dir)).catch((err: unknown) => this.ctx.reportHandled(err, { area: 'video', op: 'publish handoff' }))
      return
    }
    this.changed(dir)
  }

  // ---------- 画面 ----------

  private dir(videoDir: unknown): { channel: string; dir: string } {
    const channel = this.ctx.folderPath()
    return { channel: channel ?? '', dir: resolveVideoDir(channel, videoDir) }
  }

  async accounts(): Promise<VideoPublishAccounts> {
    const [youtube, tiktok] = await Promise.all([this.youtube.status(), this.tiktok.status()])
    return { youtube, tiktok, persisted: this.store.persisted() }
  }

  async connect(target: unknown): Promise<VideoPublishAccounts> {
    if (!(PUBLISH_TARGETS as readonly unknown[]).includes(target)) throw new UserFacingError(t('video.publish.errors.target'))
    if (this.connecting && this.connecting !== target) (this.connecting === 'youtube' ? this.youtube : this.tiktok).cancelConnect()
    this.connecting = target as PublishTargetId
    try {
      await (target === 'youtube' ? this.youtube : this.tiktok).connect()
    } finally {
      if (this.connecting === target) this.connecting = null
    }
    return this.accounts()
  }

  cancelConnect(): void {
    this.youtube.cancelConnect()
    this.tiktok.cancelConnect()
    this.connecting = null
  }

  async disconnect(target: unknown): Promise<VideoPublishAccounts> {
    if (!(PUBLISH_TARGETS as readonly unknown[]).includes(target)) throw new UserFacingError(t('video.publish.errors.target'))
    await (target === 'youtube' ? this.youtube : this.tiktok).disconnect()
    return this.accounts()
  }

  async load(videoDir: unknown): Promise<VideoPublishState> {
    const { channel, dir } = this.dir(videoDir)
    return loadState(channel, dir, new Date(), await this.refreshDefaults())
  }

  thumbnails(videoDir: unknown) {
    const { channel, dir } = this.dir(videoDir)
    return listThumbnails(channel, dir)
  }

  async setThumbnail(videoDir: unknown, rel: unknown): Promise<VideoPublishState> {
    const { dir } = this.dir(videoDir)
    if (rel !== null && typeof rel !== 'string') throw new UserFacingError(t('video.publish.errors.thumbOutside'))
    setThumbnail(dir, rel)
    this.changed(dir)
    return this.load(videoDir)
  }

  async setPrivacy(videoDir: unknown, target: unknown, value: unknown): Promise<VideoPublishState> {
    const { dir } = this.dir(videoDir)
    setPrivacy(dir, target, value)
    this.changed(dir)
    return this.load(videoDir)
  }

  async prompt(videoDir: unknown, kind: unknown, text: unknown): Promise<{ text: string }> {
    const { dir } = this.dir(videoDir)
    const folder = t('video.publish.prompt.folder', { dir })
    const k = kind as VideoPublishPromptKind
    if (k === 'publish') {
      const { loadSettings, renderPromptById } = await import('@video/settings')
      const info = videoProjectInfo(dir)
      let settings
      try {
        settings = loadSettings()
      } catch {
        settings = undefined
      }
      const body = renderPromptById('publish', { project: info.title, template: info.template }, getLocale() === 'ja' ? 'ja' : 'en', settings).text
      return { text: `${body.trim()}\n\n${folder}` }
    }
    if (k === 'fix') {
      const instruction = typeof text === 'string' ? fixInstruction(text) : ''
      return { text: `${instruction ? t('video.publish.prompt.fix', { text: instruction }) : t('video.publish.prompt.review')}\n${folder}` }
    }
    if (k === 'make') return { text: `${t('video.publish.prompt.make')}\n${folder}` }
    if (k === 'thumbnails') return { text: `${t('video.publish.prompt.thumbnails')}\n${folder}` }
    throw new UserFacingError(t('video.publish.errors.prompt'))
  }

  openTikTokUpload(videoDir: unknown): void {
    const { dir } = this.dir(videoDir)
    const text = readText(join(dir, PUBLISH_FILE))
    const spec = text === null ? null : parsePublishJson(text).spec
    const video = spec ? containedFile(dir, spec.video) : null
    if (video) shell.showItemInFolder(video)
    void shell.openExternal(TIKTOK_UPLOAD_PAGE)
  }
}
