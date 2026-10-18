import type { VideoIpcHandlers, VideoMainContext } from '../context'
import type { VideoPublishIpc } from '../../shared/ipc/publish'
import type { VideoPublishService } from './service'

/**
 * YouTube・TikTok の接続と投稿（担当: 投稿）。OAuth・アップロード・見張りの中身（service.ts）は初めて使うときに読み込む（起動時間 NF-5）。
 * どの口も投稿はしない。投稿は受け渡しのファイル（`ferret-video publish upload` が書く頼み）でだけ起きる。
 */
let service: Promise<VideoPublishService> | null = null
let started = false

function get(ctx: VideoMainContext): Promise<VideoPublishService> {
  service ??= import('./service').then(({ VideoPublishService }) => {
    const s = new VideoPublishService(ctx)
    if (started) s.start()
    return s
  })
  return service
}

export function publishHandlers(ctx: VideoMainContext): VideoIpcHandlers<VideoPublishIpc> {
  return {
    'video:publish:accounts': async () => (await get(ctx)).accounts(),
    'video:publish:connect': async (target) => (await get(ctx)).connect(target),
    'video:publish:cancelConnect': async () => (await get(ctx)).cancelConnect(),
    'video:publish:disconnect': async (target) => (await get(ctx)).disconnect(target),
    'video:publish:load': async (videoDir) => (await get(ctx)).load(videoDir),
    'video:publish:thumbnails': async (videoDir) => (await get(ctx)).thumbnails(videoDir),
    'video:publish:setThumbnail': async (videoDir, rel) => (await get(ctx)).setThumbnail(videoDir, rel),
    'video:publish:setPrivacy': async (videoDir, target, value) => (await get(ctx)).setPrivacy(videoDir, target, value),
    'video:publish:prompt': async (videoDir, kind, text) => (await get(ctx)).prompt(videoDir, kind, text),
    'video:publish:openTikTokUpload': async (videoDir) => (await get(ctx)).openTikTokUpload(videoDir)
  }
}

/**
 * 投稿の受け渡し（<動画>/.ferret-video/publish-request.json）の見張りを始める。今開いているチャンネルの直下の動画のフォルダが対象で、
 * チャンネルが切り替わったら 2 秒以内に見張り直す（起動時に1回呼ばれる。E2E では呼ばれない）
 */
export function startPublish(ctx: VideoMainContext): void {
  started = true
  void get(ctx).then((s) => s.start()).catch((err: unknown) => ctx.reportHandled(err, { area: 'video', op: 'publish start' }))
}

export function stopPublish(): void {
  started = false
  void service?.then((s) => s.stop()).catch(() => undefined)
}
