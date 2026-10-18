import { keepAvailable } from './cameras'
import type { RecordDevices, RecordPrefs } from './types'

/**
 * 撮影の画面（RecordView）の純粋な部品。React にも Electron にも依存しない（単体テストで確かめる）。
 */

export const RESOLUTIONS = [
  { id: '720p', width: 1280, height: 720 },
  { id: '1080p', width: 1920, height: 1080 },
  { id: '4k', width: 3840, height: 2160 }
] as const

export type ResolutionId = (typeof RESOLUTIONS)[number]['id']

/** 設定の幅・高さに一番近い解像度 */
export function resolutionOf(width: number, height: number): ResolutionId {
  let best: ResolutionId = '1080p'
  let bestDiff = Number.POSITIVE_INFINITY
  for (const r of RESOLUTIONS) {
    const diff = Math.abs(r.width - width) + Math.abs(r.height - height)
    if (diff < bestDiff) { best = r.id; bestDiff = diff }
  }
  return best
}

/** 経過時間（mm:ss、1時間を超えたら h:mm:ss） */
export function formatElapsed(ms: number): string {
  const total = Number.isFinite(ms) && ms > 0 ? Math.floor(ms / 1000) : 0
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const two = (n: number) => String(n).padStart(2, '0')
  return h > 0 ? `${h}:${two(m)}:${two(s)}` : `${two(m)}:${two(s)}`
}

/** バイト数を MB（小数1桁） */
export function formatMegabytes(bytes: number): string {
  return `${(Math.max(0, Number.isFinite(bytes) ? bytes : 0) / 1e6).toFixed(1)} MB`
}

/** メーターの光る区切りの数（0〜n） */
export function litSegments(level: number, n: number, off = false): number {
  if (off || !Number.isFinite(level)) return 0
  return Math.max(0, Math.min(n, Math.round(level * n)))
}

export interface Selection {
  screenSourceId: string | null
  cameraIds: string[]
  mainCameraId: string | null
  micIds: string[]
  systemAudio: boolean
}

/**
 * 撮影の画面を開いたときの選択。画面は最初の画面、カメラは設定のカメラ（無ければ最初の1台）、マイクは設定のマイク（無ければ最初の1つ）、
 * PC の音声は設定どおり（録れない OS ではオフ）
 */
export function initialSelection(
  prefs: Pick<RecordPrefs, 'camera' | 'micId' | 'systemAudio'>,
  devices: RecordDevices,
  screens: readonly { id: string; kind: 'screen' | 'window' }[],
  systemAudioSupported: boolean
): Selection {
  const camIds = devices.cameras.map((d) => d.id)
  const micIds = devices.mics.map((d) => d.id)
  const cam = camIds.includes(prefs.camera.deviceId) ? prefs.camera.deviceId : camIds[0] ?? null
  const mic = micIds.includes(prefs.micId) ? prefs.micId : micIds[0] ?? null
  return {
    screenSourceId: screens.find((s) => s.kind === 'screen')?.id ?? null,
    cameraIds: cam ? [cam] : [],
    mainCameraId: cam,
    micIds: mic ? [mic] : [],
    systemAudio: systemAudioSupported && prefs.systemAudio
  }
}

/** 機器を抜き差ししたあとの選択（抜いたものを外す） */
export function selectionAfterDevices(sel: Selection, devices: RecordDevices): Selection {
  const cameraIds = keepAvailable(sel.cameraIds, devices.cameras.map((d) => d.id))
  const micIds = keepAvailable(sel.micIds, devices.mics.map((d) => d.id))
  return { ...sel, cameraIds, micIds, mainCameraId: sel.mainCameraId && cameraIds.includes(sel.mainCameraId) ? sel.mainCameraId : cameraIds[0] ?? null }
}

/** 何か1つでも録るものを選んでいるか */
export function hasAnythingToRecord(sel: Selection): boolean {
  return sel.screenSourceId !== null || sel.cameraIds.length > 0 || sel.micIds.length > 0 || sel.systemAudio
}

/** 動画のフォルダの名前（チャンネルの直下の1段） */
export function videoFolderName(dir: string): string {
  const parts = dir.split(/[\\/]+/).filter(Boolean)
  return parts[parts.length - 1] ?? ''
}
