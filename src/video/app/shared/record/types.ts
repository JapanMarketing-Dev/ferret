import type { DisplayInfo, Region } from './region'
import type { MarkerKind } from './take'

/**
 * 撮影の画面 ⇄ main ⇄ 録画ウインドウでやり取りする形。Electron にも DOM にも依存しない。
 */

export interface RecordDevice {
  id: string
  label: string
}

export interface RecordDevices {
  cameras: RecordDevice[]
  mics: RecordDevice[]
}

/**
 * 撮影の状態。countdown から stopping までは、ほかの録画（Ferret のレビューの録画）を始めない
 * idle → countdown → recording → stopping → ingesting → idle
 */
export type RecordState = 'idle' | 'countdown' | 'recording' | 'stopping' | 'ingesting'

export interface RecordStatus {
  state: RecordState
  takeId?: string
  /** 撮っている動画のフォルダ（絶対パス） */
  videoDir?: string
  /** カウントダウンの残り（秒） */
  countdown?: number
  /** 録画を始めた時刻（epoch ms。経過時間の表示） */
  startedAt?: number
  markers: { ng: number; important: number }
  /** 書いたバイト数（全トラックの合計） */
  bytes: number
  /** 録っているトラックの数 */
  tracks: number
  /** 録画中に起きた問題（書き込めない・機器が外れた）。録画は続く */
  warning?: string
}

/** 1つの音のメーター（mic:<deviceId> / system） */
export interface RecordLevel {
  id: string
  /** 0〜1（-60〜0 dB） */
  level: number
  /** 音割れ（少しのあいだ出し続ける） */
  clip: boolean
}

/** プレビューの縮小フレーム（screen / camera:<deviceId>）。JPEG の data URL */
export interface RecordFrame {
  id: string
  dataUrl: string
}

export type ScreenAccess = 'granted' | 'denied' | 'not-determined' | 'restricted' | 'unknown'

export type FrameRate = 24 | 25 | 30 | 50 | 60
export const FRAME_RATES: readonly FrameRate[] = [24, 25, 30, 50, 60]

export interface CameraFormat {
  width: number
  height: number
  fps: FrameRate
}

/** 動画の設定（~/.ferret/video/settings.json）のうち撮影が使うもの */
export interface RecordPrefs {
  screenFps: FrameRate
  camera: CameraFormat & { deviceId: string }
  micId: string
  systemAudio: boolean
  region: Region | null
  autoStart: boolean
  hotkeys: { ng: string; important: string }
}

export interface RecordSetup {
  platform: string
  displays: DisplayInfo[]
  devices: RecordDevices
  prefs: RecordPrefs
  status: RecordStatus
  /** PC の音声が録れるか（macOS 14.2 より前・Linux の一部は録れない） */
  systemAudioSupported: boolean
  /** 録画できない理由（Ferret のレビューの録画中など）。null なら録れる */
  blocked: 'reviewRecording' | null
}

/** 画面から送る、撮るものの選択 */
export interface RecordPlan {
  videoDir: string
  /** 画面・ウインドウ（desktopCapturer の ID）。null なら画面は録らない */
  screen: { sourceId: string } | null
  /** カメラの deviceId。先頭がメイン（camera-1） */
  cameraIds: string[]
  micIds: string[]
  systemAudio: boolean
  screenFps: FrameRate
  camera: CameraFormat
  /** 0・3・5・10 */
  countdownSec: number
}

/** プレビュー（録画ウインドウで開いて縮小フレームとメーターを送る）にするもの */
export interface PreviewSelection {
  screenSourceId: string | null
  cameraIds: string[]
  micIds: string[]
  camera: CameraFormat
}

/** 録画ウインドウで開く1本のトラック */
export interface RecorderVideoTrack {
  /** 拡張子の無い名前（screen / camera-1 …）。拡張子は録画ウインドウが形式で決める */
  base: string
  kind: 'screen' | 'camera'
}

/** main → 録画ウインドウ: 録画を始める */
export interface RecorderStartPayload {
  takeId: string
  createdAt: string
  app: { version: string; os: string }
  screen: {
    base: 'screen'
    sourceId: string
    fps: FrameRate
    /** 取り込みの大きさの上限（ディスプレイの実ピクセル。範囲を切り抜くときに粗くならないよう原寸で取る） */
    maxWidth: number
    maxHeight: number
    region: Region | null
    display: DisplayInfo | null
    videoBitsPerSecond: number
  } | null
  cameras: Array<{ base: string; deviceId: string; label: string; width: number; height: number; fps: FrameRate; main: boolean; videoBitsPerSecond: number }>
  mics: Array<{ file: string; deviceId: string; label: string }>
  systemAudio: { file: 'system.wav' } | null
  chunkMs: number
  /** 録画ウインドウが出す文（画面の言語で main が作る） */
  messages: { trackEnded: string; micFailed: string; cameraFailed: string; screenFailed: string; systemAudioFailed: string }
}

/** 録画ウインドウ → main: トラックのファイルを開く */
export interface RecorderOpenTrack {
  file: string
  kind: 'screen' | 'camera' | 'mic' | 'system'
  wav?: { sampleRate: number; channels: number }
}

export interface RecordStopResult {
  takeId: string
  videoDir: string
  /** 止める前に取り消した（カウントダウン中） */
  cancelled?: boolean
  ingest: { ok: boolean; message: string } | null
  autoStart: boolean
}

export type { MarkerKind }
