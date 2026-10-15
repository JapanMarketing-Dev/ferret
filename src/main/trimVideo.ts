/**
 * 何もない時間を削った版の動画（recording.trimmed.webm）を作る。
 *
 * ffmpeg は配布物に入っていない（各OS向けで数十MB・ライセンスの扱いも増える）ので使わない。
 * 代わりに非表示ウィンドウで元の動画を「残す区間だけ」再生し、canvas に描いた映像と音声を MediaRecorder で録り直す。
 * 区間のあいだは録画を一時停止するので、削った版は残す区間だけをつないだものになる。
 * 時間は残す区間の長さぶんかかる（実時間）ので、指摘を出したあとに裏で作る（review.ts の trimReviewTake）。
 *
 * 再生は index.ts の ade-media（Range 付き）から読む。ページも同じ ade-media に置き、動画と同じ出どころにする
 * （出どころが違うと、canvas が汚れて録れず、音声も無音になる）。
 */
import { BrowserWindow, powerSaveBlocker } from 'electron'
import { dirname } from 'node:path'
import { performance } from 'node:perf_hooks'
import { openNewFileContained, removeContained } from './sessions/containment'
import type { TrimCut } from '@shared/trim'

/** 非表示ウィンドウのページ（index.ts の ade-media が返す） */
const TRIM_HOST_URL = 'ade-media://review/trim-host'
export const TRIM_HOST_HTML = '<!doctype html><meta charset="utf-8"><title>trim</title>'

/** ページから一度に受け取る大きさ（base64 にする前のバイト数） */
const PULL_BYTES = 2 * 1024 * 1024

/** 時間切れを見張る間隔と、これより長く空いたら止められていた（スリープ・App Nap）とみなす間 */
const DEADLINE_TICK_MS = 1000
const DEADLINE_FROZEN_GAP_MS = 5000

/**
 * 動いていた時間だけで数える時間切れ。
 * 裏に回ったアプリは macOS の App Nap でタイマーも再生もほとんど止まり、スリープ中も進まない。
 * 時計だけで数えると、止められていた間に時間切れになって、戻った瞬間に失敗として送っていた（FERRET-1Y: ferret@0.6.27、
 * メインウィンドウを隠して6分後に trim timed out）。見張りの間が DEADLINE_FROZEN_GAP_MS より空いた分は数えない
 */
export class AwakeDeadline {
  private spentMs = 0
  private lastMs: number

  constructor(private readonly timeoutMs: number, startMs: number, private readonly frozenGapMs = DEADLINE_FROZEN_GAP_MS) {
    this.lastMs = startMs
  }

  /** 見張りの1回。時間切れなら true */
  tick(nowMs: number): boolean {
    const gap = nowMs - this.lastMs
    this.lastMs = nowMs
    if (gap > 0 && gap <= this.frozenGapMs) this.spentMs += gap
    return this.spentMs >= this.timeoutMs
  }
}

/**
 * 元の動画（sourceUrl）から残す区間（kept、ms）だけをつないだ動画を outPath に書く。
 * 失敗したら outPath は残さない（呼び出し側は元の動画のまま使う）
 */
export async function renderTrimmedVideo(sourceUrl: string, outPath: string, kept: TrimCut[], options: { timeoutMs?: number; attempts?: number } = {}): Promise<void> {
  // 再生が外から乱されて失敗することがある（e2e で、削っている間にレビューを読み直すと起きた）。新しいウィンドウでやり直す
  const attempts = Math.max(1, options.attempts ?? 2)
  for (let i = 1; ; i++) {
    try {
      await renderOnce(sourceUrl, outPath, kept, options)
      return
    } catch (err) {
      if (i >= attempts) throw err
    }
  }
}

async function renderOnce(sourceUrl: string, outPath: string, kept: TrimCut[], options: { timeoutMs?: number }): Promise<void> {
  const keptMs = kept.reduce((sum, span) => sum + Math.max(0, span.end - span.start), 0)
  const timeoutMs = options.timeoutMs ?? keptMs + 60_000
  const window = new BrowserWindow({
    show: false,
    width: 320,
    height: 240,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, autoplayPolicy: 'no-user-gesture-required' }
  })
  // 再生の音はスピーカーへ出さない（WebAudio で取り出す音声には入る）
  window.webContents.setAudioMuted(true)
  // 削っている間は App Nap で止められないようにする（裏に回すと実時間で再生できず時間切れになる。FERRET-1Y）
  const blocker = startAppNapBlocker()
  let timer: NodeJS.Timeout | undefined
  try {
    await window.loadURL(TRIM_HOST_URL)
    const work = window.webContents.executeJavaScript(`(${PAGE_SCRIPT})(${JSON.stringify(sourceUrl)}, ${JSON.stringify(kept)})`, true) as Promise<number>
    const deadline = new AwakeDeadline(timeoutMs, performance.now())
    const size = await Promise.race([work, new Promise<never>((_, reject) => {
      timer = setInterval(() => { if (deadline.tick(performance.now())) reject(new Error('trim timed out')) }, Math.min(DEADLINE_TICK_MS, Math.max(1, timeoutMs)))
    })])
    if (!Number.isFinite(size) || size <= 0) throw new Error('trim produced no data')
    // 排他で作る（既にある名前・リンクには書かない）。親を開いて持ったまま作る
    const file = await openNewFileContained(outPath)
    try {
      for (let at = 0; at < size; at += PULL_BYTES) {
        const base64 = await window.webContents.executeJavaScript(`window.__trimPull(${at}, ${Math.min(size, at + PULL_BYTES)})`, true) as string
        await file.write(Buffer.from(base64, 'base64'))
      }
    } finally { await file.close() }
  } catch (err) {
    await removeContained(dirname(outPath), outPath).catch(() => undefined)
    // ページから来た失敗が Error でなければ包む（記録に理由が残るように）
    throw err instanceof Error ? err : new Error(`trim failed: ${describeValue(err)}`)
  } finally {
    if (timer) clearInterval(timer)
    if (blocker !== null && powerSaveBlocker.isStarted(blocker)) powerSaveBlocker.stop(blocker)
    if (!window.isDestroyed()) window.destroy()
  }
}

function startAppNapBlocker(): number | null {
  try { return powerSaveBlocker.start('prevent-app-suspension') } catch { return null }
}

/**
 * ページの中で動く処理（素の JS の文字列で送る。ビルドの変換で補助関数が混ざらないように）。
 * 動画は頭から止めずに（seek せずに）再生し、捨てる区間だけ MediaRecorder を一時停止して速く送る。
 * 区間ごとに一時停止して seek すると、映像のトラックが途切れて MediaRecorder が止まることがあった（e2e）。
 * 映像は canvas に描いて録り、音声は WebAudio で取り出す（録る側のトラックは最後まで同じ）。
 * 終わったら削った版の大きさを返し、中身は window.__trimPull(from, to) で base64 にして渡す
 */
const PAGE_SCRIPT = `async (src, kept) => {
  // 失敗は名前と理由付きの Error にして返す（DOMException などはそのままだと main で中身が見えない）
  const describe = (e) => (e && e.name ? e.name + ': ' : '') + (e && e.message ? e.message : String(e))
  let state = 'load'
  const tracksInfo = []
  try {
  const video = document.createElement('video')
  video.preload = 'auto'
  video.src = src
  document.body.appendChild(video)
  const once = (name) => new Promise((resolve, reject) => {
    const ok = () => { video.removeEventListener('error', ng); resolve() }
    const ng = () => { video.removeEventListener(name, ok); reject(new Error('video ' + name + ' failed: ' + describe(video.error))) }
    video.addEventListener(name, ok, { once: true })
    video.addEventListener('error', ng, { once: true })
  })
  await once('loadedmetadata')
  // MediaRecorder の WebM は長さが Infinity のまま。末尾へ飛ばして長さを確定させてから頭へ戻す（録り始める前だけ seek する）
  if (!Number.isFinite(video.duration)) {
    const settled = once('durationchange')
    video.currentTime = Number.MAX_SAFE_INTEGER
    await settled
  }
  if (video.currentTime !== 0) {
    const back = once('seeked')
    video.currentTime = 0
    await back
  }
  if (video.readyState < 2) await once('loadeddata')
  state = 'setup'
  const canvas = document.createElement('canvas')
  canvas.width = video.videoWidth || 1280
  canvas.height = video.videoHeight || 720
  const ctx = canvas.getContext('2d')
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
  const tracks = [...canvas.captureStream(30).getVideoTracks()]
  let audio = null
  try {
    audio = new AudioContext()
    const dest = audio.createMediaStreamDestination()
    audio.createMediaElementSource(video).connect(dest)
    await audio.resume()
    tracks.push(...dest.stream.getAudioTracks())
  } catch (e) { audio = null }
  for (const track of tracks) {
    const info = { kind: track.kind, ended: false }
    tracksInfo.push(info)
    track.addEventListener('ended', () => { info.ended = true })
  }
  let drawing = true
  const draw = () => {
    if (!drawing) return
    if (video.readyState >= 2) ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
    setTimeout(draw, 33)
  }
  draw()
  const stream = new MediaStream(tracks)
  const mimeType = ['video/webm;codecs=vp8,opus', 'video/webm;codecs=vp9,opus', 'video/webm'].find((m) => MediaRecorder.isTypeSupported(m))
  // キーフレームを 0.5 秒ごとに入れる（▷ で開く位置が、前のキーフレームへ大きく寄らないように。対応していなければ無視される）
  const recorder = new MediaRecorder(stream, { ...(mimeType ? { mimeType } : {}), videoKeyFrameIntervalDuration: 500 })
  const chunks = []
  let recorderError = null
  recorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data) }
  recorder.onerror = (e) => { recorderError = e.error || e }
  const stopped = new Promise((resolve) => { recorder.onstop = () => resolve() })

  const spans = [...kept].sort((a, b) => a.start - b.start)
  const lastEnd = spans.length ? spans[spans.length - 1].end : 0
  const inKept = (ms) => spans.some((s) => ms >= s.start && ms < s.end)
  const nextStart = (ms) => { const s = spans.find((x) => x.start > ms); return s ? s.start : Infinity }
  // 再生は止められる・断られることがある（ほかの再生・省電力で中断されるなど）。少し待って数回やり直す
  const play = async () => {
    for (let i = 0; ; i++) {
      try { await video.play(); return } catch (e) { if (i >= 5) throw e; await new Promise((r) => setTimeout(r, 200)) }
    }
  }
  state = 'record'
  recorder.start(1000)
  if (!inKept(0)) { recorder.pause(); video.playbackRate = 16 }
  await play()
  await new Promise((resolve, reject) => {
    let last = video.currentTime
    let stalledSince = Date.now()
    let tickedAt = Date.now()
    const tick = () => {
      // 止められていた（スリープ・App Nap）あとは、止まっていた間を詰まりに数えない
      if (Date.now() - tickedAt > 2000) stalledSince = Date.now()
      tickedAt = Date.now()
      if (recorderError) return reject(recorderError)
      if (recorder.state === 'inactive') return reject(new Error('recorder stopped unexpectedly'))
      const ms = video.currentTime * 1000
      if (video.ended || ms >= lastEnd - 15) return resolve()
      const keep = inKept(ms)
      if (keep && recorder.state === 'paused') { video.playbackRate = 1; recorder.resume() }
      else if (!keep && recorder.state === 'recording') recorder.pause()
      // 捨てる区間は速く送る。次の残す区間の手前 1.5 秒からは等速に戻す（行き過ぎないように）
      if (!keep) video.playbackRate = nextStart(ms) - ms > 1500 ? 16 : 1
      if (video.currentTime !== last) { last = video.currentTime; stalledSince = Date.now() }
      else if (Date.now() - stalledSince > 10000) return reject(new Error('playback stalled at ' + video.currentTime))
      if (video.paused) video.play().catch(() => {})
      setTimeout(tick, 10)
    }
    tick()
  })
  video.pause()
  state = 'finish'
  recorder.stop()
  await stopped
  drawing = false
  if (audio) audio.close().catch(() => {})
  const blob = new Blob(chunks, { type: 'video/webm' })
  window.__trimPull = (from, to) => new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ''))
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(blob.slice(from, to))
  })
  return blob.size
  } catch (e) {
    // どの段階で・トラックがどうなっていたかも添える（原因を絞るため）
    throw new Error('trim page (' + state + '): ' + describe(e) + ' tracks=' + JSON.stringify(tracksInfo))
  }
}`

/** Error でない失敗の値を、記録に残せる文字列にする */
function describeValue(value: unknown): string {
  if (value && typeof value === 'object') {
    const v = value as { name?: unknown; message?: unknown }
    const text = [v.name, v.message].filter((x) => typeof x === 'string' && x).join(': ')
    if (text) return text
    try { return JSON.stringify(value) } catch { return Object.prototype.toString.call(value) }
  }
  return String(value)
}
