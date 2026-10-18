import type { PublishTargetId, VideoPublishAccounts, VideoPublishState, VideoThumbFile } from '../publish'

/** 「AI に〜」の依頼の種類（文は main が作る。動画のフォルダの場所と設定の投稿プロンプトを入れるため） */
export type VideoPublishPromptKind = 'publish' | 'fix' | 'make' | 'thumbnails'

/**
 * 動画づくりの IPC（YouTube・TikTok の接続と投稿）。チャネル名は `video:publish:` で始める。担当: 投稿
 * videoDir は今開いているチャンネルの直下の動画のフォルダ（絶対パスかフォルダ名）。main が確かめ、違えば断る。
 * どれも何も投稿しない。投稿は「OK・投稿する」で送る投稿プロンプト → エージェントの `ferret-video publish upload` → 受け渡しのファイルだけで起きる。
 */
export interface VideoPublishIpc {
  /** YouTube・TikTok の接続の状態（トークンは返さない） */
  'video:publish:accounts': () => VideoPublishAccounts
  /** 既定のブラウザで同意画面を開き、戻るまで待つ（同時に1つ） */
  'video:publish:connect': (target: PublishTargetId) => VideoPublishAccounts
  /** 待っている接続をやめる */
  'video:publish:cancelConnect': () => void
  'video:publish:disconnect': (target: PublishTargetId) => VideoPublishAccounts
  /** 投稿画面のデータ（publish.json・動画・サムネイル・受け渡しの結果・投稿の記録） */
  'video:publish:load': (videoDir: string) => VideoPublishState
  /** thumbnails/ の画像（新しい順） */
  'video:publish:thumbnails': (videoDir: string) => VideoThumbFile[]
  /** publish.json の thumbnail を変える（rel は動画のフォルダからの相対パス。null で外す） */
  'video:publish:setThumbnail': (videoDir: string, rel: string | null) => VideoPublishState
  /** この動画の公開範囲を publish.json に書く */
  'video:publish:setPrivacy': (videoDir: string, target: PublishTargetId, value: string) => VideoPublishState
  /** エージェントへ送る文（publish: 設定の投稿プロンプト、fix: 一言の直し、make: publish.json を作って、thumbnails: サムネを作って） */
  'video:publish:prompt': (videoDir: string, kind: VideoPublishPromptKind, text?: string) => { text: string }
  /** TikTok に手で上げる: 動画を Finder で見せ、TikTok Studio のアップロード画面を開く */
  'video:publish:openTikTokUpload': (videoDir: string) => void
}
export interface VideoPublishEvents {
  /** 動画の publish.json・サムネイル・受け渡しの結果が変わった（videoDir はその動画のフォルダの絶対パス） */
  'video:publish:changed': (videoDir: string) => void
}

export const VIDEO_PUBLISH_REQUESTS = [
  'video:publish:accounts', 'video:publish:connect', 'video:publish:cancelConnect', 'video:publish:disconnect',
  'video:publish:load', 'video:publish:thumbnails', 'video:publish:setThumbnail', 'video:publish:setPrivacy',
  'video:publish:prompt', 'video:publish:openTikTokUpload'
] as const satisfies readonly (keyof VideoPublishIpc)[]
export const VIDEO_PUBLISH_EVENTS = ['video:publish:changed'] as const satisfies readonly (keyof VideoPublishEvents)[]
