import type { VideoDetail, VideoList, VideoTemplateInfo } from '../library'

/** 動画づくりの IPC（動画の一覧・新しい動画）。チャネル名は `video:` で始める。担当: 動画タブ */
export interface VideoLibraryIpc {
  /** フォルダが動画のチャンネルか（直下に ferret-video.json・旧 solocut.json のフォルダがある） */
  'video:isChannel': (folderPath: string) => boolean
  /** 今開いているプロジェクト（チャンネル）の動画。新しい順 */
  'video:list': () => VideoList
  /** 新しい動画に選べるテンプレート（`ferret-video templates --json`） */
  'video:templates': () => VideoTemplateInfo[]
  /** チャンネルの直下に `<YYYY-MM-DD>-<slug>/` を作って `ferret-video init` */
  'video:create': (input: { title: string; template?: string }) => { ok: boolean; name?: string; dir?: string; error?: string }
  /** 動画1本の進み具合（`ferret-video status --json`）。name はチャンネルの直下のフォルダ名 */
  'video:detail': (name: string) => VideoDetail
  /** 「動画を完成させて」の依頼文（設定の prompts.finish に動画のフォルダを添えたもの） */
  'video:finishPrompt': (name: string) => string
  /** 動画のフォルダを Finder・エクスプローラーで開く */
  'video:openFolder': (name: string) => void
  /** 旧 Solocut のフォルダを移す（`ferret-video migrate`） */
  'video:migrate': (name: string) => { ok: boolean; message: string }
}
export interface VideoLibraryEvents {
  /** 動画が増えた・変わった（作った・移した） */
  'video:changed': () => void
}

export const VIDEO_LIBRARY_REQUESTS = [
  'video:isChannel', 'video:list', 'video:templates', 'video:create', 'video:detail', 'video:finishPrompt', 'video:openFolder', 'video:migrate'
] as const satisfies readonly (keyof VideoLibraryIpc)[]
export const VIDEO_LIBRARY_EVENTS = ['video:changed'] as const satisfies readonly (keyof VideoLibraryEvents)[]
