import { displayPixels, regionForDisplay, type DisplayInfo, type Region } from './region'
import { trackFileName, type TrackKind } from './take'
import { FRAME_RATES, type CameraFormat, type FrameRate, type PreviewSelection, type RecordDevices, type RecordPlan, type RecorderStartPayload } from './types'

/**
 * 画面から届いた撮影の選択（信用しない）を確かめ、録画ウインドウへ渡す形にする（純粋な関数）。
 * 選んだ機器・画面は、いま main が知っているもの（enumerateDevices・desktopCapturer の一覧）に限る。
 */

export const MAX_CAMERAS = 4
export const MAX_MICS = 4
export const SCREEN_BITRATE = 12_000_000
export const CAMERA_BITRATE = 10_000_000
/** 録画ウインドウがファイルへ送る間隔（落ちてもここまでは残る） */
export const CHUNK_MS = 1000
/** ウインドウを録るときの取り込みの上限 */
const WINDOW_MAX = { width: 3840, height: 2160 }
export const COUNTDOWNS = [0, 3, 5, 10] as const

export type PlanProblem = 'nothingSelected' | 'screenMissing' | 'cameraMissing' | 'micMissing' | 'tooManyCameras' | 'tooManyMics' | 'systemAudioUnsupported'

export class PlanError extends Error {
  constructor(readonly problem: PlanProblem, readonly detail?: string) {
    super(detail ? `${problem}: ${detail}` : problem)
  }
}

export interface PlanSource {
  id: string
  kind: 'screen' | 'window'
  displayId?: string
}

export interface PlanEnv {
  takeId: string
  createdAt: string
  app: { version: string; os: string }
  /** desktopCapturer の一覧（画面を録るときだけ要る） */
  sources: readonly PlanSource[]
  displays: readonly DisplayInfo[]
  devices: RecordDevices
  /** 設定 record.region */
  region: unknown
  systemAudioSupported: boolean
  messages: RecorderStartPayload['messages']
}

export function cleanFps(v: unknown, fallback: FrameRate = 30): FrameRate {
  return FRAME_RATES.includes(v as FrameRate) ? (v as FrameRate) : fallback
}

export function cleanCameraFormat(v: unknown): CameraFormat {
  const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>
  const int = (x: unknown, min: number, max: number, def: number) => (typeof x === 'number' && Number.isFinite(x) ? Math.min(max, Math.max(min, Math.round(x))) : def)
  return { width: int(o.width, 320, 3840, 1920), height: int(o.height, 240, 2160, 1080), fps: cleanFps(o.fps) }
}

export function cleanCountdown(v: unknown): number {
  return (COUNTDOWNS as readonly number[]).includes(v as number) ? (v as number) : 3
}

/** 重なりと知らない ID を除いた ID の並び（順は保つ） */
function knownIds(ids: unknown, known: readonly { id: string }[], max: number): { ok: string[]; missing: string[]; tooMany: boolean } {
  const list = Array.isArray(ids) ? [...new Set(ids.filter((x): x is string => typeof x === 'string' && x.length > 0 && x.length <= 500))] : []
  const set = new Set(known.map((d) => d.id))
  return { ok: list.filter((id) => set.has(id)).slice(0, max), missing: list.filter((id) => !set.has(id)), tooMany: list.filter((id) => set.has(id)).length > max }
}

/** 画面・ウインドウのディスプレイ（ウインドウは null） */
export function displayOfSource(source: PlanSource, displays: readonly DisplayInfo[]): DisplayInfo | null {
  if (source.kind !== 'screen') return null
  const id = source.displayId ?? /^screen:(\d+):/.exec(source.id)?.[1]
  return displays.find((d) => d.id === id) ?? null
}

/** 選択を確かめて、録画ウインドウへ渡す形にする。問題があれば PlanError */
export function buildStartPayload(plan: RecordPlan, env: PlanEnv): RecorderStartPayload {
  const label = (list: readonly { id: string; label: string }[], id: string) => list.find((d) => d.id === id)?.label || id.slice(0, 8)

  let screen: RecorderStartPayload['screen'] = null
  if (plan.screen) {
    const source = env.sources.find((s) => s.id === plan.screen!.sourceId)
    if (!source) throw new PlanError('screenMissing', plan.screen.sourceId)
    const display = displayOfSource(source, env.displays)
    const region: Region | null = display ? regionForDisplay(env.region, display) : null
    const max = display ? displayPixels(display) : WINDOW_MAX
    screen = { base: 'screen', sourceId: source.id, fps: cleanFps(plan.screenFps), maxWidth: max.width, maxHeight: max.height, region, display, videoBitsPerSecond: SCREEN_BITRATE }
  }

  const cams = knownIds(plan.cameraIds, env.devices.cameras, MAX_CAMERAS)
  if (cams.missing.length) throw new PlanError('cameraMissing', cams.missing[0])
  if (cams.tooMany) throw new PlanError('tooManyCameras')
  const mics = knownIds(plan.micIds, env.devices.mics, MAX_MICS)
  if (mics.missing.length) throw new PlanError('micMissing', mics.missing[0])
  if (mics.tooMany) throw new PlanError('tooManyMics')
  if (plan.systemAudio && !env.systemAudioSupported) throw new PlanError('systemAudioUnsupported')

  const format = cleanCameraFormat(plan.camera)
  const cameras = cams.ok.map((id, i) => ({
    base: baseName('camera', i + 1), deviceId: id, label: label(env.devices.cameras, id), ...format, main: i === 0, videoBitsPerSecond: CAMERA_BITRATE
  }))
  const micTracks = mics.ok.map((id, i) => ({ file: trackFileName('mic', i + 1, 'wav'), deviceId: id, label: label(env.devices.mics, id) }))
  const systemAudio = plan.systemAudio === true ? { file: 'system.wav' as const } : null
  if (!screen && cameras.length === 0 && micTracks.length === 0 && !systemAudio) throw new PlanError('nothingSelected')

  return { takeId: env.takeId, createdAt: env.createdAt, app: env.app, screen, cameras, mics: micTracks, systemAudio, chunkMs: CHUNK_MS, messages: env.messages }
}

function baseName(kind: Extract<TrackKind, 'camera'>, index: number): string {
  return trackFileName(kind, index, 'webm').replace(/\.webm$/, '')
}

/** 録画ウインドウが開いてよいファイル（映像は .mp4 か .webm のどちらか） */
export function allowedTrackFiles(payload: RecorderStartPayload): Map<string, 'screen' | 'camera' | 'mic' | 'system'> {
  const out = new Map<string, 'screen' | 'camera' | 'mic' | 'system'>()
  const video = (base: string, kind: 'screen' | 'camera') => { for (const ext of ['mp4', 'webm']) out.set(`${base}.${ext}`, kind) }
  if (payload.screen) video(payload.screen.base, 'screen')
  for (const cam of payload.cameras) video(cam.base, 'camera')
  for (const mic of payload.mics) out.set(mic.file, 'mic')
  if (payload.systemAudio) out.set(payload.systemAudio.file, 'system')
  return out
}

/** プレビューの選択を、知っている機器・画面に絞る */
export function cleanPreview(sel: unknown, devices: RecordDevices, sources: readonly PlanSource[] | null): PreviewSelection {
  const o = (sel && typeof sel === 'object' ? sel : {}) as Record<string, unknown>
  const screenSourceId = typeof o.screenSourceId === 'string' && (sources === null || sources.some((s) => s.id === o.screenSourceId)) ? o.screenSourceId : null
  return {
    screenSourceId,
    cameraIds: knownIds(o.cameraIds, devices.cameras, MAX_CAMERAS).ok,
    micIds: knownIds(o.micIds, devices.mics, MAX_MICS).ok,
    camera: cleanCameraFormat(o.camera)
  }
}

/** 信用できない機器の一覧（録画ウインドウの enumerateDevices の結果）を確かめる */
export function cleanDevices(raw: unknown): RecordDevices {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const list = (v: unknown) => {
    const seen = new Set<string>()
    const out: { id: string; label: string }[] = []
    for (const d of Array.isArray(v) ? v.slice(0, 64) : []) {
      const r = d as Record<string, unknown> | null
      if (!r || typeof r.id !== 'string' || !r.id || r.id.length > 500 || seen.has(r.id)) continue
      seen.add(r.id)
      out.push({ id: r.id, label: typeof r.label === 'string' ? r.label.slice(0, 200) : '' })
    }
    return out
  }
  return { cameras: list(o.cameras), mics: list(o.mics) }
}
