/**
 * 1回の撮影（テイク）の記録 take.json の形と、その組み立て。形式は旧 Solocut と同じ（docs/03・`ferret-video ingest` が読む）。
 *
 *   <動画のフォルダ>/media/takes/<take-id>/
 *     screen.mp4|webm   camera-1.mp4|webm …   mic-1.wav …   system.wav   take.json   cursor.jsonl
 *
 * 時刻はどれも録画ウインドウの performance.now()（ms）。ingest は各トラックの開始時刻の差から位置を合わせる。
 * Electron にも DOM にも依存しない（録画ウインドウ・main・単体テストで共用）。
 */

export type TrackKind = 'screen' | 'camera' | 'mic' | 'system'

export interface TakeTrackMeta {
  file: string
  kind: TrackKind
  device?: string
  label?: string
  mimeType?: string
  width?: number
  height?: number
  fps?: number
  sampleRate?: number
  channels?: number
  /** MediaRecorder・worklet を始めたときの performance.now() */
  recorderStartMs?: number
  /** 最初のフレーム・サンプルの performance.now() */
  firstFrameMs?: number
  /** 取れたときだけ、VideoFrame.timestamp そのもの */
  firstFrameTimestampUs?: number
  bytes?: number
  /** カメラ: 'main' = 人を映すカメラ（編集で顔をここから切り抜く） */
  role?: 'main'
  /** 画面: 録った範囲（ディスプレイの実ピクセル。設定 record.region）と、取り込んだ映像の大きさ */
  crop?: { displayId: string; x: number; y: number; width: number; height: number; sourceWidth?: number; sourceHeight?: number }
}

export interface TakeCursorInfo {
  file: string
  hz: number
  displayId: string | null
  bounds: { x: number; y: number; width: number; height: number }
  scaleFactor: number
  /** ウインドウを録った（座標はウインドウではなく、そのディスプレイに対するもの） */
  window: boolean
  /** 録った範囲（実ピクセル）。あれば cursor.jsonl の x/y はこの範囲に対する 0〜1 で、bounds はその DIP の長方形 */
  region?: { displayId: string; x: number; y: number; width: number; height: number }
}

export type MarkerKind = 'ng' | 'important'

export interface TakeMarker {
  kind: MarkerKind
  /** performance.now() */
  atMs: number
  sinceStartMs: number
}

export interface TakeMeta {
  schema: 1
  id: string
  createdAt: string
  timeOrigin: number
  startedAtMs: number
  stoppedAtMs?: number
  tracks: TakeTrackMeta[]
  markers: TakeMarker[]
  /** cursor.jsonl（{t_ms, x, y} を 30Hz。録った画面・範囲に対する 0〜1） */
  cursor?: TakeCursorInfo
  app: { version: string; os: string }
  /** 止める操作で最後まで書けた。false のまま残っていれば途中で落ちた（そこまでのファイルは再生できる） */
  complete: boolean
}

/** テイクの ID（take_<YYYYMMDD-HHMMSS>。ローカル時刻） */
export function newTakeId(now = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `take_${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`
}

/** テイクの ID の形（ingest と同じ） */
export const TAKE_ID = /^take_[A-Za-z0-9][A-Za-z0-9_.-]*$/

/** テイクのフォルダに書いてよいトラックのファイル名。これ以外（パス・別の拡張子）は書かない */
export const TRACK_FILE = /^(screen|camera-\d{1,2}|mic-\d{1,2}|system)\.(mp4|webm|wav)$/

export function isTrackFile(file: unknown): file is string {
  return typeof file === 'string' && TRACK_FILE.test(file)
}

/** トラックのファイル名。カメラ・マイクは 1 から数える（カメラの 1 はメイン） */
export function trackFileName(kind: TrackKind, index: number, ext: 'mp4' | 'webm' | 'wav'): string {
  if (kind === 'mic' || kind === 'system') ext = 'wav'
  else if (ext === 'wav') throw new Error(`video track cannot be wav: ${kind}`)
  if (kind === 'screen') return `screen.${ext}`
  if (kind === 'system') return 'system.wav'
  if (!Number.isInteger(index) || index < 1 || index > 99) throw new Error(`bad track index: ${index}`)
  return `${kind}-${index}.${ext}`
}

export function createTakeMeta(o: { id: string; createdAt: string; timeOrigin: number; startedAtMs: number; app: { version: string; os: string } }): TakeMeta {
  return { schema: 1, id: o.id, createdAt: o.createdAt, timeOrigin: o.timeOrigin, startedAtMs: o.startedAtMs, tracks: [], markers: [], app: { ...o.app }, complete: false }
}

/** 目印を足した新しい記録。始める前の時刻は 0 にする */
export function addMarker(meta: TakeMeta, kind: MarkerKind, atMs: number): TakeMeta {
  const marker: TakeMarker = { kind, atMs, sinceStartMs: Math.max(0, atMs - meta.startedAtMs) }
  return { ...meta, markers: [...meta.markers, marker] }
}

/** 止めたときの記録（最後まで書けた印を付ける） */
export function finalizeTake(meta: TakeMeta, stoppedAtMs: number): TakeMeta {
  return { ...meta, stoppedAtMs: Math.max(meta.startedAtMs, stoppedAtMs), complete: true }
}

export function countMarkers(markers: readonly TakeMarker[]): { ng: number; important: number } {
  let ng = 0
  let important = 0
  for (const m of markers) {
    if (m.kind === 'ng') ng++
    else if (m.kind === 'important') important++
  }
  return { ng, important }
}

/** 最初のフレームの時刻が録画を始めた時刻からこれ以上離れていれば、別の時計（音を出す前の AudioContext など）とみなす */
export const CLOCK_SANITY_MS = 2000

/** トラックの始まり（ms・録画ウインドウの時計）。最初のフレーム。ただし明らかに別の時計なら録画を始めた時刻 */
export function trackStartMs(tr: Pick<TakeTrackMeta, 'firstFrameMs' | 'recorderStartMs'>, startedAtMs: number | undefined): number | undefined {
  const first = finiteNum(tr.firstFrameMs)
  const ref = finiteNum(tr.recorderStartMs) ?? finiteNum(startedAtMs)
  if (first !== undefined && (ref === undefined || Math.abs(first - ref) <= CLOCK_SANITY_MS)) return first
  return ref
}

/** 各トラックの、いちばん早いトラックからのずれ（秒）。ingest の位置合わせと同じ考え方 */
export function trackOffsetsSec(meta: Pick<TakeMeta, 'tracks' | 'startedAtMs'>): Record<string, number> {
  const starts = meta.tracks.map((tr) => [tr.file, trackStartMs(tr, meta.startedAtMs)] as const)
  const known = starts.map(([, ms]) => ms).filter((ms): ms is number => ms !== undefined)
  const t0 = known.length ? Math.min(...known) : 0
  return Object.fromEntries(starts.map(([file, ms]) => [file, ms === undefined ? 0 : (ms - t0) / 1000]))
}

const finiteNum = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)
const str = (v: unknown, max = 200): string | undefined => (typeof v === 'string' && v.length > 0 ? v.slice(0, max) : undefined)
const posInt = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.round(v) : undefined)
const nonNeg = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined)
const TRACK_KINDS: ReadonlySet<string> = new Set(['screen', 'camera', 'mic', 'system'])
/** 1テイクのトラックの数の上限（画面1・カメラ・マイク・PC の音声） */
export const MAX_TRACKS = 16
const MAX_MARKERS = 5000

function cleanTrack(raw: unknown): TakeTrackMeta | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  if (!isTrackFile(o.file) || typeof o.kind !== 'string' || !TRACK_KINDS.has(o.kind)) return null
  const kind = o.kind as TrackKind
  // 名前と種類が食い違うもの（camera-1.wav など）は書かない
  const prefix = o.file.split(/[-.]/)[0]
  if (prefix !== kind) return null
  if (o.file.endsWith('.wav') !== (kind === 'mic' || kind === 'system')) return null
  const tr: TakeTrackMeta = { file: o.file, kind }
  const put = <K extends keyof TakeTrackMeta>(key: K, value: TakeTrackMeta[K] | undefined) => { if (value !== undefined) tr[key] = value }
  put('device', str(o.device, 500))
  put('label', str(o.label))
  put('mimeType', str(o.mimeType, 100))
  put('width', posInt(o.width))
  put('height', posInt(o.height))
  put('fps', posInt(o.fps))
  put('sampleRate', posInt(o.sampleRate))
  put('channels', posInt(o.channels))
  put('recorderStartMs', nonNeg(o.recorderStartMs))
  put('firstFrameMs', nonNeg(o.firstFrameMs))
  put('firstFrameTimestampUs', nonNeg(o.firstFrameTimestampUs))
  put('bytes', nonNeg(o.bytes))
  if (o.role === 'main' && kind === 'camera') tr.role = 'main'
  if (kind === 'screen' && o.crop && typeof o.crop === 'object') {
    const c = o.crop as Record<string, unknown>
    const displayId = str(c.displayId, 50)
    const [x, y, width, height] = [nonNeg(c.x), nonNeg(c.y), posInt(c.width), posInt(c.height)]
    if (displayId && x !== undefined && y !== undefined && width && height) {
      tr.crop = { displayId, x: Math.round(x), y: Math.round(y), width, height }
      const sw = posInt(c.sourceWidth)
      const sh = posInt(c.sourceHeight)
      if (sw) tr.crop.sourceWidth = sw
      if (sh) tr.crop.sourceHeight = sh
    }
  }
  return tr
}

/**
 * 録画ウインドウから届いた記録を、書いてよい形にする（知らないキー・形の違う値は落とす）。
 * ID が違う・必須の値が無いときは null（書かない）
 */
export function sanitizeTakeMeta(raw: unknown, takeId: string): TakeMeta | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const o = raw as Record<string, unknown>
  if (o.id !== takeId || !TAKE_ID.test(takeId)) return null
  const timeOrigin = nonNeg(o.timeOrigin)
  const startedAtMs = nonNeg(o.startedAtMs)
  if (timeOrigin === undefined || startedAtMs === undefined) return null
  const tracks: TakeTrackMeta[] = []
  const seen = new Set<string>()
  for (const raw of Array.isArray(o.tracks) ? o.tracks.slice(0, MAX_TRACKS) : []) {
    const tr = cleanTrack(raw)
    if (!tr || seen.has(tr.file)) continue
    seen.add(tr.file)
    tracks.push(tr)
  }
  const markers: TakeMarker[] = []
  for (const raw of Array.isArray(o.markers) ? o.markers.slice(0, MAX_MARKERS) : []) {
    const m = raw as Record<string, unknown> | null
    if (!m || (m.kind !== 'ng' && m.kind !== 'important')) continue
    const atMs = nonNeg(m.atMs)
    if (atMs === undefined) continue
    markers.push({ kind: m.kind, atMs, sinceStartMs: nonNeg(m.sinceStartMs) ?? Math.max(0, atMs - startedAtMs) })
  }
  const app = (o.app && typeof o.app === 'object' ? o.app : {}) as Record<string, unknown>
  const meta: TakeMeta = {
    schema: 1,
    id: takeId,
    createdAt: str(o.createdAt, 40) ?? new Date(timeOrigin + startedAtMs).toISOString(),
    timeOrigin,
    startedAtMs,
    tracks,
    markers,
    app: { version: str(app.version, 40) ?? '', os: str(app.os, 20) ?? '' },
    complete: o.complete === true
  }
  const stopped = nonNeg(o.stoppedAtMs)
  if (stopped !== undefined) meta.stoppedAtMs = stopped
  return meta
}
