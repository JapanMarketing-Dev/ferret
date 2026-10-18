import type { BrowserWindow } from 'electron'
import type { VideoIpcEventChannel, VideoIpcEvents, VideoIpcRequests } from '../shared/ipc'

/**
 * 動画づくりの main 側が Ferret 本体から受け取るもの（src/main/index.ts が1回だけ作って渡す）。
 * 動画のコードは Ferret 本体の内部（workspace・terminals など）を直接 import せず、ここを通す。
 */
export interface VideoMainContext {
  /** 今開いているプロジェクト（動画のチャンネル＝マスタフォルダ）のフォルダ。無ければ null */
  folderPath(): string | null
  /** 今開いているプロジェクトの id と種類（kind が 'video' なら動画のチャンネル） */
  project(): { id: string; name: string; kind?: string } | null
  /** renderer へ通知する */
  send<C extends VideoIpcEventChannel>(channel: C, ...args: Parameters<VideoIpcEvents[C]>): void
  mainWindow(): BrowserWindow | null
  /** app.getPath('userData') */
  userDataDir: string
  /** アプリの out/ フォルダ（out/main・out/video-cli・out/video-recorder がある）。配布版では app.asar.unpacked 側を優先する */
  appOutDir: string
  isPackaged: boolean
  /** 今のプロジェクトの Agent へ文を送る（agent:sendText と同じ宛先）。Agent が居なければ noAgent */
  sendToAgent(text: string): Promise<{ ok: boolean; message: string; noAgent?: boolean }>
  /**
   * 設定の文字起こし（端末内の whisper かクラウド）で WAV を1本文字起こしする（確認の画面の「喋って囲む」）。
   * 使えないときは segments が空で、warning に利用者向けの理由。時刻は WAV の頭からの ms
   */
  transcribe?(wavPath: string, options?: { language?: string }): Promise<{ segments: Array<{ t0: number; t1: number; text: string }>; warning?: string }>
  /** Ferret のレビューの録画中か（その間は動画の撮影を始めない） */
  reviewRecording?(): boolean
  /** アプリの窓での利用者の操作の直後か（Ferret の UserGestures と同じ許可。画面の一覧・録画の開始の前に使う） */
  consumeGesture?(action: import('../../../main/captureConsent').GestureAction): boolean
  /** Sentry へ（想定外のエラーだけ） */
  reportHandled(err: unknown, context: { area: 'video'; op: string }): void
}

export type VideoIpcHandlers<T extends object = VideoIpcRequests> = {
  [C in keyof T]: T[C] extends (...args: infer A) => unknown ? (...args: A) => unknown : never
}
