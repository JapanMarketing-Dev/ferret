/**
 * 動画の撮影の録画ウインドウの中身（画面には出ない。docs/03）。
 *
 * - 入力ごとに別々の MediaRecorder・AudioWorklet を動かし、トラックごとに別のファイルにする（1本に合成しない）
 *   画面: chromeMediaSource 'desktop'（範囲を選んでいれば canvas で切り抜く）/ カメラ（複数）: getUserMedia
 *   マイク（複数）: 補正を切った 48kHz の PCM を WAV へ / PC の音声: getDisplayMedia のループバック（main が答える）
 * - 塊は1秒ごとに main へ送り、main がすぐファイルへ追記する。take.json の中身は始めたとき・目印のたび・5秒ごと・止めたときに送る
 * - どのトラックの時刻も、このページの performance.now() で記録する（take.json の firstFrameMs・recorderStartMs）
 * - 撮影の画面のプレビューのため、選んだ画面・カメラの縮小フレーム（JPEG）と、マイクの音の大きさを送る
 *   （アプリの窓には映像の取り込みを許さない。src/main/captureConsent.ts）
 */
import { ClipHold, levelFromPeak, pickVideoMime, toInt16Interleaved } from '../shared/record/pcm'
import { contextTimeToPerfMs } from '../shared/record/audioClock'
import { streamCrop } from '../shared/record/region'
import { addMarker, createTakeMeta, type MarkerKind, type TakeMeta, type TakeTrackMeta } from '../shared/record/take'
import type { PreviewSelection, RecordDevices, RecordLevel, RecorderOpenTrack, RecorderStartPayload } from '../shared/record/types'
import { cropVideoTrack } from './crop'

export {} // declare global のためモジュールにする

interface Bridge {
  onEnumerate(fn: () => void): void
  onPreview(fn: (selection: PreviewSelection) => void): void
  onStart(fn: (payload: RecorderStartPayload) => void): void
  onMark(fn: (kind: MarkerKind) => void): void
  onStop(fn: () => void): void
  ready(): void
  devices(devices: RecordDevices): void
  frame(id: string, jpeg: ArrayBuffer): void
  levels(levels: RecordLevel[]): void
  open(spec: RecorderOpenTrack): Promise<void>
  chunk(file: string, data: ArrayBuffer): void
  meta(meta: TakeMeta): void
  started(info: { startedAtMs: number; timeOrigin: number }): void
  startFailed(message: string): void
  stopped(meta: TakeMeta | null): void
  warning(message: string): void
}

declare global {
  interface Window {
    ferretVideoRecorder: Bridge
  }
}

const bridge = window.ferretVideoRecorder
const SAMPLE_RATE = 48000
const THUMB_WIDTH = 320
const META_INTERVAL_MS = 5000

const errText = (err: unknown) => (err instanceof Error ? `${err.name}: ${err.message}` : String(err))
const fill = (text: string, values: Record<string, string>) => text.replace(/\{\{(\w+)\}\}/g, (_m, k: string) => values[k] ?? '')

// ───────────────────────── 取り込み（プレビューと録画で共有） ─────────────────────────

interface Source {
  stream: MediaStream
  /** プレビュー・録画のどちらかが使っている */
  users: Set<'preview' | 'record'>
}

const sources = new Map<string, Source>()
const opening = new Map<string, Promise<MediaStream>>()

function screenConstraints(sourceId: string, maxWidth: number, maxHeight: number, fps: number): MediaStreamConstraints {
  return {
    audio: false,
    // Electron の画面の取り込みは古い形式の constraints でしか指定できない
    video: { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: sourceId, maxWidth, maxHeight, maxFrameRate: fps } } as unknown as MediaTrackConstraints
  }
}

function cameraConstraints(deviceId: string, width: number, height: number, fps: number): MediaStreamConstraints {
  return { audio: false, video: { deviceId: { exact: deviceId }, width: { ideal: width }, height: { ideal: height }, frameRate: { ideal: fps } } }
}

/** マイクは自動の補正（エコー除去・ノイズ抑制・自動ゲイン）を切って録る。補正は編集でやり直せる形でかける */
function micConstraints(deviceId: string): MediaStreamConstraints {
  return {
    audio: { deviceId: { exact: deviceId }, echoCancellation: false, noiseSuppression: false, autoGainControl: false, sampleRate: SAMPLE_RATE, channelCount: { ideal: 2 } },
    video: false
  }
}

async function acquire(key: string, user: 'preview' | 'record', constraints: () => MediaStreamConstraints): Promise<MediaStream> {
  const have = sources.get(key)
  if (have && have.stream.getTracks().some((t) => t.readyState === 'live')) {
    have.users.add(user)
    return have.stream
  }
  let pending = opening.get(key)
  if (!pending) {
    pending = navigator.mediaDevices.getUserMedia(constraints())
    opening.set(key, pending)
  }
  try {
    const stream = await pending
    const entry = sources.get(key)
    if (entry && entry.stream === stream) entry.users.add(user)
    else sources.set(key, { stream, users: new Set([user]) })
    return stream
  } finally {
    opening.delete(key)
  }
}

function release(key: string, user: 'preview' | 'record'): void {
  const entry = sources.get(key)
  if (!entry) return
  entry.users.delete(user)
  if (entry.users.size > 0) return
  entry.stream.getTracks().forEach((t) => t.stop())
  sources.delete(key)
  dropShown(key)
}

const screenKey = (id: string) => `screen:${id}`
const cameraKey = (id: string, w: number, h: number, fps: number) => `camera:${id}:${w}x${h}@${fps}`
const micKey = (id: string) => `mic:${id}`

// ───────────────────────── 機器の一覧 ─────────────────────────

async function listDevices(): Promise<RecordDevices> {
  const all = await navigator.mediaDevices.enumerateDevices().catch(() => [] as MediaDeviceInfo[])
  const cams = all.filter((d) => d.kind === 'videoinput' && d.deviceId)
  let mics = all.filter((d) => d.kind === 'audioinput' && d.deviceId && d.deviceId !== 'communications')
  // 「既定」は同じ機器がもう1つ並ぶので、ほかに機器があれば出さない
  if (mics.some((d) => d.deviceId !== 'default')) mics = mics.filter((d) => d.deviceId !== 'default')
  return {
    cameras: cams.map((d) => ({ id: d.deviceId, label: d.label })),
    mics: mics.map((d) => ({ id: d.deviceId, label: d.label }))
  }
}

bridge.onEnumerate(() => void listDevices().then((d) => bridge.devices(d)))
navigator.mediaDevices.addEventListener('devicechange', () => void listDevices().then((d) => bridge.devices(d)))

// ───────────────────────── プレビュー（縮小フレームとメーター） ─────────────────────────

/** 縮小フレームを送るもの（screen / camera:<deviceId>）と、その映像を読む video */
const shown = new Map<string, { key: string; video: HTMLVideoElement; every: number }>()
/** メーター（mic:<deviceId> / system） */
const meters = new Map<string, { key: string; source: MediaStreamAudioSourceNode; analyser: AnalyserNode; hold: ClipHold }>()
let previewKeys = new Set<string>()
let previewSeq = 0

let audioCtx: AudioContext | null = null
function audio(): AudioContext {
  audioCtx ??= new AudioContext({ sampleRate: SAMPLE_RATE, latencyHint: 'interactive' })
  if (audioCtx.state === 'suspended') void audioCtx.resume().catch(() => undefined)
  return audioCtx
}

function showVideo(id: string, key: string, stream: MediaStream, every: number): void {
  const old = shown.get(id)
  if (old?.key === key) return
  if (old) old.video.srcObject = null
  const video = document.createElement('video')
  video.muted = true
  video.playsInline = true
  video.srcObject = stream
  void video.play().catch(() => undefined)
  shown.set(id, { key, video, every })
}

function meter(id: string, key: string, stream: MediaStream): void {
  if (meters.get(id)?.key === key) return
  dropMeter(id)
  const track = stream.getAudioTracks()[0]
  if (!track) return
  const ctx = audio()
  const source = ctx.createMediaStreamSource(new MediaStream([track]))
  const analyser = ctx.createAnalyser()
  analyser.fftSize = 1024
  source.connect(analyser)
  meters.set(id, { key, source, analyser, hold: new ClipHold() })
}

function dropMeter(id: string): void {
  const m = meters.get(id)
  if (!m) return
  m.source.disconnect()
  meters.delete(id)
}

function dropShown(key: string): void {
  for (const [id, s] of shown) if (s.key === key) { s.video.srcObject = null; shown.delete(id) }
  for (const [id, m] of meters) if (m.key === key) dropMeter(id)
}

async function applyPreview(sel: PreviewSelection): Promise<void> {
  const seq = ++previewSeq
  const want = new Map<string, { id: string; open: () => MediaStreamConstraints; kind: 'video' | 'audio'; every: number }>()
  if (sel.screenSourceId) {
    want.set(screenKey(sel.screenSourceId), { id: 'screen', kind: 'video', every: 2, open: () => screenConstraints(sel.screenSourceId!, 1920, 1200, 10) })
  }
  for (const id of sel.cameraIds) {
    want.set(cameraKey(id, sel.camera.width, sel.camera.height, sel.camera.fps), { id: `camera:${id}`, kind: 'video', every: 1, open: () => cameraConstraints(id, sel.camera.width, sel.camera.height, sel.camera.fps) })
  }
  for (const id of sel.micIds) want.set(micKey(id), { id: `mic:${id}`, kind: 'audio', every: 1, open: () => micConstraints(id) })
  for (const key of previewKeys) if (!want.has(key)) release(key, 'preview')
  // 画面を選び直したときは、前の画面の縮小フレームを止める（録画中の画面はそのまま）
  for (const [id, s] of shown) if (!want.has(s.key) && !sources.get(s.key)?.users.has('record')) { s.video.srcObject = null; shown.delete(id) }
  previewKeys = new Set(want.keys())
  for (const [key, w] of want) {
    try {
      const stream = await acquire(key, 'preview', w.open)
      if (seq !== previewSeq) return
      if (w.kind === 'video') showVideo(w.id, key, stream, w.every)
      else meter(w.id, key, stream)
    } catch (err) {
      // 他のアプリが使っているカメラ・許可が無いなど。ほかのプレビューは続ける
      console.warn(`[video-recorder] preview ${w.id}: ${errText(err)}`)
    }
  }
}

bridge.onPreview((sel) => void applyPreview(sel))

const thumb = document.createElement('canvas')
const thumbCtx = thumb.getContext('2d', { alpha: false })
let tick = 0
let thumbBusy = false
setInterval(() => {
  tick++
  if (thumbBusy || !thumbCtx) return
  thumbBusy = true
  void (async () => {
    try {
      for (const [id, s] of shown) {
        if (tick % s.every !== 0) continue
        const v = s.video
        if (v.readyState < 2 || !v.videoWidth) continue
        thumb.width = THUMB_WIDTH
        thumb.height = Math.max(2, Math.round((v.videoHeight / v.videoWidth) * THUMB_WIDTH))
        thumbCtx.drawImage(v, 0, 0, thumb.width, thumb.height)
        const blob = await new Promise<Blob | null>((resolve) => thumb.toBlob(resolve, 'image/jpeg', 0.6))
        if (blob) bridge.frame(id, await blob.arrayBuffer())
      }
    } finally {
      thumbBusy = false
    }
  })()
}, 250)

const levelBuf = new Float32Array(1024)
setInterval(() => {
  if (meters.size === 0) return
  const now = performance.now()
  const out: RecordLevel[] = []
  for (const [id, m] of meters) {
    m.analyser.getFloatTimeDomainData(levelBuf)
    let peak = 0
    for (const x of levelBuf) peak = Math.max(peak, Math.abs(x))
    out.push({ id, level: levelFromPeak(peak), clip: m.hold.push(peak, now) })
  }
  bridge.levels(out)
}, 100)

// ───────────────────────── 録画 ─────────────────────────

interface Writer {
  file: string
  stop: () => Promise<void>
}

interface Recording {
  meta: TakeMeta
  writers: Writer[]
  cleanups: Array<() => void>
  held: string[]
  metaTimer: number
  payload: RecorderStartPayload
}

let rec: Recording | null = null
let workletReady: Promise<void> | null = null

function sendMeta(): void {
  if (rec) bridge.meta(rec.meta)
}

/** 最初のフレームの performance.now()（MediaStreamTrackProcessor があればその時刻） */
async function firstFrameTime(track: MediaStreamTrack): Promise<{ perfMs: number; timestampUs?: number } | null> {
  const MSTP = (globalThis as unknown as { MediaStreamTrackProcessor?: new (o: { track: MediaStreamTrack }) => { readable: ReadableStream<VideoFrame> } }).MediaStreamTrackProcessor
  if (!MSTP) return { perfMs: performance.now() }
  const clone = track.clone()
  try {
    const reader = new MSTP({ track: clone }).readable.getReader()
    const r = await reader.read()
    const perfMs = performance.now()
    const ts = r.value?.timestamp
    r.value?.close()
    void reader.cancel()
    return ts !== undefined && ts !== null ? { perfMs, timestampUs: ts } : { perfMs }
  } catch {
    return { perfMs: performance.now() }
  } finally {
    clone.stop()
  }
}

async function startVideo(
  r: Recording,
  file: string,
  kind: 'screen' | 'camera',
  track: MediaStreamTrack,
  mime: string,
  bitrate: number,
  extra: { device?: string; label?: string; fps: number; role?: 'main'; size?: { width: number; height: number }; crop?: TakeTrackMeta['crop'] }
): Promise<void> {
  await bridge.open({ file, kind })
  const s = track.getSettings()
  const width = extra.size?.width ?? s.width
  const height = extra.size?.height ?? s.height
  const meta: TakeTrackMeta = {
    file,
    kind,
    ...(mime ? { mimeType: mime } : {}),
    ...(width ? { width } : {}),
    ...(height ? { height } : {}),
    // 画面の取り込みは変化があったときだけフレームが来るので、ファイルの平均は当てにならない。頼んだ fps を書く（ingest はこれを優先する）
    fps: kind === 'screen' || extra.size ? extra.fps : Math.round(s.frameRate ?? extra.fps)
  }
  if (extra.device) meta.device = extra.device
  if (extra.label) meta.label = extra.label
  if (extra.role) meta.role = extra.role
  if (extra.crop) meta.crop = extra.crop
  const mr = new MediaRecorder(new MediaStream([track]), { ...(mime ? { mimeType: mime } : {}), videoBitsPerSecond: bitrate })
  let queue: Promise<void> = Promise.resolve()
  mr.ondataavailable = (ev) => {
    if (ev.data.size > 0) queue = queue.then(async () => bridge.chunk(file, await ev.data.arrayBuffer())).catch(() => undefined)
  }
  const stopped = new Promise<void>((resolve) => { mr.onstop = () => resolve() })
  mr.onstart = () => { meta.recorderStartMs = performance.now() }
  mr.onerror = (ev) => bridge.warning(`${file}: ${errText((ev as unknown as { error?: unknown }).error)}`)
  const onEnded = () => { if (rec === r) bridge.warning(fill(r.payload.messages.trackEnded, { track: extra.label ?? file })) }
  track.addEventListener('ended', onEnded)
  r.meta.tracks.push(meta)
  r.writers.push({
    file,
    stop: async () => {
      track.removeEventListener('ended', onEnded)
      if (mr.state !== 'inactive') mr.stop()
      await Promise.race([stopped, new Promise((resolve) => setTimeout(resolve, 3000))])
      // 最後の dataavailable は stop の前に来る。その arrayBuffer() が終わって送るまで待つ
      await new Promise((resolve) => setTimeout(resolve, 50))
      await queue
    }
  })
  void firstFrameTime(track).then((t) => {
    if (!t) return
    meta.firstFrameMs = t.perfMs
    if (t.timestampUs !== undefined) meta.firstFrameTimestampUs = t.timestampUs
  })
  mr.start(r.payload.chunkMs)
}

async function startAudio(r: Recording, file: string, kind: 'mic' | 'system', track: MediaStreamTrack, label: string, device?: string): Promise<void> {
  const ctx = audio()
  workletReady ??= ctx.audioWorklet.addModule('./pcm-worklet.js')
  await workletReady
  const channels = Math.min(2, Math.max(1, track.getSettings().channelCount ?? 1))
  await bridge.open({ file, kind, wav: { sampleRate: ctx.sampleRate, channels } })
  const meta: TakeTrackMeta = { file, kind, label, sampleRate: ctx.sampleRate, channels }
  if (device) meta.device = device
  meta.recorderStartMs = performance.now()
  const src = ctx.createMediaStreamSource(new MediaStream([track]))
  const node = new AudioWorkletNode(ctx, 'ferret-video-pcm', { channelCount: channels, channelCountMode: 'explicit' })
  // 鳴らさずにグラフに引かせ続ける
  const mute = ctx.createGain()
  mute.gain.value = 0
  src.connect(node)
  node.connect(mute).connect(ctx.destination)
  let pending: Uint8Array[] = []
  let bytes = 0
  const flush = () => {
    if (bytes === 0) return
    const out = new Uint8Array(bytes)
    let off = 0
    for (const p of pending) { out.set(p, off); off += p.byteLength }
    pending = []
    bytes = 0
    bridge.chunk(file, out.buffer)
  }
  node.port.onmessage = (ev: MessageEvent<{ first?: boolean; t?: number; data?: Float32Array[] }>) => {
    const m = ev.data
    if (m.first && m.t !== undefined) {
      const first = contextTimeToPerfMs(m.t, ctx.getOutputTimestamp(), performance.now(), ctx.currentTime)
      if (first !== undefined) meta.firstFrameMs = first
      return
    }
    if (m.data && m.data.length > 0) {
      const pcm = toInt16Interleaved(m.data.slice(0, channels))
      pending.push(pcm)
      bytes += pcm.byteLength
    }
  }
  const timer = window.setInterval(flush, r.payload.chunkMs)
  const onEnded = () => { if (rec === r) bridge.warning(fill(r.payload.messages.trackEnded, { track: label })) }
  track.addEventListener('ended', onEnded)
  r.meta.tracks.push(meta)
  r.writers.push({
    file,
    stop: async () => {
      track.removeEventListener('ended', onEnded)
      window.clearInterval(timer)
      src.disconnect()
      node.disconnect()
      mute.disconnect()
      node.port.onmessage = null
      flush()
    }
  })
}

async function start(payload: RecorderStartPayload): Promise<void> {
  if (rec) return bridge.startFailed('already recording')
  const startedAtMs = performance.now()
  const r: Recording = {
    meta: createTakeMeta({ id: payload.takeId, createdAt: payload.createdAt, timeOrigin: performance.timeOrigin, startedAtMs, app: payload.app }),
    writers: [],
    cleanups: [],
    held: [],
    metaTimer: 0,
    payload
  }
  rec = r
  const msg = payload.messages
  const { mime, ext } = pickVideoMime((m) => MediaRecorder.isTypeSupported(m))
  const hold = async (key: string, constraints: () => MediaStreamConstraints) => {
    const stream = await acquire(key, 'record', constraints)
    r.held.push(key)
    return stream
  }

  if (payload.screen) {
    const sc = payload.screen
    try {
      // プレビュー（縮めた取り込み）とは別に、原寸・選んだ fps で取り込む
      const key = `${screenKey(sc.sourceId)}:rec`
      const stream = await hold(key, () => screenConstraints(sc.sourceId, sc.maxWidth, sc.maxHeight, sc.fps))
      const v = stream.getVideoTracks()[0]
      if (!v) throw new Error('no video track')
      const s = v.getSettings()
      const crop = sc.region && sc.display && s.width && s.height ? streamCrop(sc.region, sc.display, s.width, s.height) : null
      if (crop && sc.region) {
        // 範囲だけを録る。cursor.jsonl も同じ長方形に合わせる（main の cursor.ts）
        const cropped = cropVideoTrack(v, crop, sc.fps)
        r.cleanups.push(cropped.stop)
        await startVideo(r, `screen.${ext}`, 'screen', cropped.track, mime, sc.videoBitsPerSecond, {
          fps: sc.fps, size: { width: crop.width, height: crop.height },
          crop: { ...sc.region, ...(s.width ? { sourceWidth: s.width } : {}), ...(s.height ? { sourceHeight: s.height } : {}) }
        })
      } else {
        await startVideo(r, `screen.${ext}`, 'screen', v, mime, sc.videoBitsPerSecond, { fps: sc.fps })
      }
      showVideo('screen', key, stream, 2)
    } catch (err) {
      bridge.warning(fill(msg.screenFailed, { message: errText(err) }))
    }
  }

  for (const cam of payload.cameras) {
    try {
      const key = cameraKey(cam.deviceId, cam.width, cam.height, cam.fps)
      const stream = await hold(key, () => cameraConstraints(cam.deviceId, cam.width, cam.height, cam.fps))
      const v = stream.getVideoTracks()[0]
      if (!v) throw new Error('no video track')
      await startVideo(r, `${cam.base}.${ext}`, 'camera', v, mime, cam.videoBitsPerSecond, {
        device: cam.deviceId, label: cam.label, fps: cam.fps, ...(cam.main ? { role: 'main' as const } : {})
      })
    } catch (err) {
      // 他のアプリが使っているカメラは開けない（Windows）。ほかのトラックは録る
      bridge.warning(fill(msg.cameraFailed, { camera: cam.label, message: errText(err) }))
    }
  }

  for (const mic of payload.mics) {
    try {
      const stream = await hold(micKey(mic.deviceId), () => micConstraints(mic.deviceId))
      const a = stream.getAudioTracks()[0]
      if (!a) throw new Error('no audio track')
      await startAudio(r, mic.file, 'mic', a, mic.label, mic.deviceId)
    } catch (err) {
      bridge.warning(fill(msg.micFailed, { mic: mic.label, message: errText(err) }))
    }
  }

  if (payload.systemAudio) {
    try {
      // main の setDisplayMediaRequestHandler が、映像はこのウインドウ、音声は OS のループバックを返す
      const s = await navigator.mediaDevices.getDisplayMedia({ audio: true, video: true })
      s.getVideoTracks().forEach((t) => t.stop())
      const a = s.getAudioTracks()[0]
      if (!a) throw new Error('no audio track')
      r.cleanups.push(() => a.stop())
      await startAudio(r, payload.systemAudio.file, 'system', a, 'system')
      meter('system', 'system', s)
      r.cleanups.push(() => dropMeter('system'))
    } catch (err) {
      bridge.warning(fill(msg.systemAudioFailed, { message: errText(err) }))
    }
  }

  if (r.writers.length === 0) {
    await cleanup(r)
    rec = null
    return bridge.startFailed('no track could be started')
  }
  bridge.started({ startedAtMs, timeOrigin: performance.timeOrigin })
  sendMeta()
  r.metaTimer = window.setInterval(sendMeta, META_INTERVAL_MS)
}

async function cleanup(r: Recording): Promise<void> {
  window.clearInterval(r.metaTimer)
  await Promise.allSettled(r.writers.map((w) => w.stop()))
  for (const c of r.cleanups.splice(0)) {
    try { c() } catch { /* 続ける */ }
  }
  for (const key of r.held.splice(0)) release(key, 'record')
}

async function stop(): Promise<void> {
  const r = rec
  if (!r) return bridge.stopped(null)
  await cleanup(r)
  r.meta = { ...r.meta, stoppedAtMs: performance.now(), complete: true }
  rec = null
  bridge.stopped(r.meta)
}

bridge.onStart((payload) => void start(payload).catch((err: unknown) => {
  const r = rec
  rec = null
  if (r) void cleanup(r)
  bridge.startFailed(errText(err))
}))
bridge.onStop(() => void stop())
bridge.onMark((kind) => {
  if (!rec || (kind !== 'ng' && kind !== 'important')) return
  rec.meta = addMarker(rec.meta, kind, performance.now())
  sendMeta()
})

bridge.ready()
