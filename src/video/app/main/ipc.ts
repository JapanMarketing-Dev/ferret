import type { VideoIpcHandlers, VideoMainContext } from './context'
import { libraryHandlers } from './library/ipc'
import { recordHandlers } from './record/ipc'
import { reviewHandlers } from './review/ipc'
import { publishHandlers, startPublish, stopPublish } from './publish/ipc'
import { configureVideoCli } from './cli/run'

/**
 * 動画づくりの main 側の入口（src/main/index.ts からはこのファイルだけを呼ぶ）。
 * 重い処理（ffmpeg・OAuth・録画）は各機能の中で動的 import する（起動時間 NF-5）。
 */
export function createVideoIpcHandlers(ctx: VideoMainContext): VideoIpcHandlers {
  // main の中で呼ぶ ferret-video に、組み込みテンプレートの場所と whisper の既定値を渡す（E2E でも要るのでここで）
  configureVideoCli(ctx)
  return {
    ...libraryHandlers(ctx),
    ...recordHandlers(ctx),
    ...reviewHandlers(ctx),
    ...publishHandlers(ctx)
  }
}

/** アプリの準備ができたあとに1回（投稿の受け渡しの見張りなど） */
export function startVideo(ctx: VideoMainContext): void {
  startPublish(ctx)
}

/** 終了するとき */
export function stopVideo(): void {
  stopPublish()
}

export { videoTerminalEnv } from './cli/env'
export { videoCaptureActive } from './record/captureLock'
