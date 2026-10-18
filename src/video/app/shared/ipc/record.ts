import type { CaptureSourceInfo } from '@shared/types'
import type { Region } from '../record/region'
import type { MarkerKind } from '../record/take'
import type { PreviewSelection, RecordDevices, RecordFrame, RecordLevel, RecordPlan, RecordPrefs, RecordSetup, RecordStatus, RecordStopResult, ScreenAccess } from '../record/types'

/**
 * 動画づくりの IPC（撮影）。チャネル名は `video:record:` で始める。担当: 撮影
 * 映像（画面・カメラ）を開くのは main が作る非表示の録画ウインドウだけ。アプリの窓へは縮小フレーム（JPEG）とメーターの値だけを送る。
 */
export interface VideoRecordIpc {
  /** 撮影の画面を開いた。録画ウインドウを用意し、機器・ディスプレイ・設定・今の状態を返す */
  'video:record:setup': () => RecordSetup
  /** 録れる画面・ウインドウ（サムネイル付き。利用者の操作の直後だけ） */
  'video:record:sources': () => { screenAccess: ScreenAccess; sources: CaptureSourceInfo[] }
  /** 選んだ画面・カメラ・マイクをプレビューする（縮小フレームとメーターが video:record:frame / levels で届く） */
  'video:record:preview': (selection: PreviewSelection) => void
  /** 重ねたウインドウで範囲を選ぶ（Esc でやめる → null）。選んだ範囲は設定 record.region に残す */
  'video:record:pickRegion': (displayId: string) => Region | null
  /** 範囲を消して画面全体に戻す */
  'video:record:clearRegion': () => void
  /** 撮影の設定（fps・カメラ・マイク・PC の音声）を動画の設定ファイルへ残す */
  'video:record:savePrefs': (prefs: Partial<Pick<RecordPrefs, 'screenFps' | 'camera' | 'micId' | 'systemAudio'>>) => RecordPrefs
  /** カウントダウンのあと録画を始める（利用者の操作の直後だけ）。カウントダウン中に止めると cancelled */
  'video:record:start': (plan: RecordPlan) => { takeId: string } | { cancelled: true }
  /** 止めて、テイクを取り込む（ferret-video ingest）。録っていなければ null */
  'video:record:stop': () => RecordStopResult | null
  /** 目印（NG・重要）。ホットキーと同じ */
  'video:record:mark': (kind: MarkerKind) => void
  'video:record:status': () => RecordStatus
  /** 撮影の画面を閉じた（録画中でなければ録画ウインドウを閉じて、カメラ・マイクを放す） */
  'video:record:close': () => void
}
export interface VideoRecordEvents {
  'video:record:status': (status: RecordStatus) => void
  'video:record:levels': (levels: RecordLevel[]) => void
  'video:record:frame': (frame: RecordFrame) => void
  /** カメラ・マイクを抜き差しした */
  'video:record:devices': (devices: RecordDevices) => void
}

export const VIDEO_RECORD_REQUESTS = [
  'video:record:setup', 'video:record:sources', 'video:record:preview', 'video:record:pickRegion', 'video:record:clearRegion',
  'video:record:savePrefs', 'video:record:start', 'video:record:stop', 'video:record:mark', 'video:record:status', 'video:record:close'
] as const satisfies readonly (keyof VideoRecordIpc)[]
export const VIDEO_RECORD_EVENTS = ['video:record:status', 'video:record:levels', 'video:record:frame', 'video:record:devices'] as const satisfies readonly (keyof VideoRecordEvents)[]
