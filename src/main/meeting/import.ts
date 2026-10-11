/**
 * mtg の録画・文字起こしを取り込み、指摘の候補のレビューを作る（流れは @shared/meetingImport の先頭）。
 *
 *   1. 新しいレビューのフォルダを作り、動画をその中へ写す（meeting.<拡張子>。▷ で発言の時刻から見返せる）
 *   2. 文字起こしがあれば読む（@shared/meetingTranscript）。無ければ動画の音声を復号し、設定の文字起こしで起こす
 *      （録画と同じ無音の区切り → WAV → IncrementalTranscriber）
 *   3. 動画に映像があり、文字起こしに時刻があれば、発言の時刻のコマを撮る（指摘の BEFORE の画像）
 *   4. 録画と同じく下書きのレビューにする（review.ts の createImportedReview）
 * 判定（scoreMeetingReview）は、画面が整理を済ませたあとに別に呼ぶ。
 *
 * 選んだファイルのパスは main だけが持つ（画面には token と名前だけ。rememberMeetingMedia）。
 */
import { randomBytes } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { copyFile, stat } from 'node:fs/promises'
import { constants } from 'node:fs'
import { join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { t } from '@shared/i18n'
import { UserFacingError } from '@shared/errors'
import { reportHandled } from '@shared/report'
import { delay } from '@shared/delay'
import { parseMeetingTranscript } from '@shared/meetingTranscript'
import { MEETING_SCORE_THRESHOLD, isAudioOnly, meetingDecisionBody, meetingFrameTimes, meetingMediaExtension, meetingScoreFromAnswer,
  type MeetingImportProgress, type MeetingImportRequest, type MeetingItemScore, type MeetingMediaPick, type MeetingScoreResult } from '@shared/meetingImport'
import type { ReviewData } from '@shared/review'
import type { FrameRef, Material, TranscriptSegment } from '../pipeline/types'
import type { SttEngine } from '../pipeline/stt/engine'
import type { SttEngineKind } from '../pipeline/stt/segmenter'
import type { DecisionAskSession } from '../decision/service'
import { assertContained, mkdirContained, openNewFileContained, readFileNoFollow, writeFileNoFollow, writeNewFileContained } from '../sessions/containment'
import { createSession, ensureGitExclude, frameFilePath, loadSession, type SessionPaths } from '../sessions'
import { MAX_AUDIO_DECODE_MS, MeetingMedia } from './media'

// ─── 選んだファイル（パスは main だけが持つ）────────────────────────

const picked = new Map<string, { path: string; name: string; at: number }>()
/** 選んでから取り込むまでの猶予 */
const PICK_TTL_MS = 60 * 60 * 1000

/** ダイアログで選んだ動画を覚え、画面へ渡す token を返す */
export async function rememberMeetingMedia(path: string): Promise<MeetingMediaPick> {
  const name = path.split(/[\\/]/).pop() ?? 'meeting'
  if (!meetingMediaExtension(name)) throw new UserFacingError(t('meeting.errors.mediaType'))
  const info = await stat(path)
  if (!info.isFile()) throw new UserFacingError(t('meeting.errors.mediaType'))
  const now = Date.now()
  for (const [key, value] of picked) if (now - value.at > PICK_TTL_MS) picked.delete(key)
  const token = randomBytes(16).toString('hex')
  picked.set(token, { path, name, at: now })
  return { token, name, sizeBytes: info.size }
}

/** 選んだ文字起こしのファイルを読む（.docx は Office の読み取りで文にする） */
export async function readMeetingTranscriptFile(path: string, readDocx: (path: string) => Promise<string>): Promise<{ name: string; text: string }> {
  const name = path.split(/[\\/]/).pop() ?? 'transcript.txt'
  const ext = name.toLowerCase().split('.').pop() ?? ''
  if (ext === 'docx') return { name, text: await readDocx(path) }
  const info = await stat(path)
  // 文字起こしは大きくても数MB。巨大なファイルは読まない
  if (!info.isFile() || info.size > 8 * 1024 * 1024) throw new UserFacingError(t('meeting.errors.transcriptTooLarge'))
  const { readFile } = await import('node:fs/promises')
  return { name, text: (await readFile(path, 'utf8')).replace(/^﻿/, '') }
}

/** Word の文字起こし（Google ドキュメントの Meet の文字起こしを .docx で書き出したものなど）を段落ごとの文にする */
export async function docxPlainText(bytes: Uint8Array): Promise<string> {
  const { openZip } = await import('@shared/office/zip')
  const { descendants, documentElement, parseXml } = await import('@shared/office/xml')
  const source = await openZip(bytes).text('word/document.xml')
  if (source === null) throw new UserFacingError(t('meeting.errors.transcriptUnreadable'))
  const root = documentElement(parseXml(source))
  return descendants(root, 'p')
    .map((p) => descendants(p, 't').map((node) => node.text).join(''))
    .join('\n')
}

/** 選んだ .docx を読む（大きさの上限は Office のプレビューと同じ） */
export async function readDocxFile(path: string): Promise<string> {
  const { MAX_OFFICE_BYTES } = await import('@shared/office/kinds')
  const info = await stat(path)
  if (!info.isFile() || info.size > MAX_OFFICE_BYTES) throw new UserFacingError(t('meeting.errors.transcriptTooLarge'))
  const { readFile } = await import('node:fs/promises')
  return docxPlainText(new Uint8Array(await readFile(path)))
}

// ─── 取り込み ─────────────────────────────────────────────

export interface MeetingImportDeps {
  projectDir: string
  request: MeetingImportRequest
  /** 設定の文字起こしのエンジン（動画しか無いとき）。使えなければ warning に理由 */
  sttEngine: () => Promise<{ engine: SttEngine | null; kind: SttEngineKind; warning?: string }>
  /** 新しいレビューに控える、プロジェクトの登録URL */
  urlPresets: NonNullable<Material['meta']['urlPresets']>
  createReview: (paths: SessionPaths, material: Material, warnings: string[]) => Promise<ReviewData>
  onProgress: (progress: MeetingImportProgress) => void
}

export async function importMeeting(deps: MeetingImportDeps): Promise<ReviewData> {
  const { request } = deps
  const media = request.mediaToken ? picked.get(request.mediaToken) ?? null : null
  if (request.mediaToken && !media) throw new UserFacingError(t('meeting.errors.mediaExpired'))
  const transcriptText = request.transcript?.text?.trim() ? request.transcript.text : ''
  if (!media && !transcriptText) throw new UserFacingError(t('meeting.errors.nothing'))
  const parsed = transcriptText ? parseMeetingTranscript(transcriptText, request.transcript?.name ?? '') : null
  if (parsed && parsed.utterances.length === 0 && !media) throw new UserFacingError(t('meeting.errors.emptyTranscript'))

  await ensureGitExclude(deps.projectDir)
  const paths = await createSession(deps.projectDir)
  const warnings: string[] = []
  const startedAt = new Date().toISOString()
  let videoUrl: string | null = null
  let ext: ReturnType<typeof meetingMediaExtension> = null
  if (media) {
    ext = meetingMediaExtension(media.name)
    deps.onProgress({ stage: 'copy' })
    const dest = join(paths.dir, `meeting.${ext}`)
    assertContained(paths.dir, dest)
    await copyIntoReview(media.path, dest)
    videoUrl = `ade-media://review/${paths.id}/meeting.${ext}`
  }
  await writeFileNoFollow(join(paths.dir, 'capture.json'), JSON.stringify({ startedAt, twoSpeakers: (parsed?.speakers.length ?? 0) > 1,
    meeting: { ...(media ? { media: media.name } : {}), ...(request.transcript?.name ? { transcript: request.transcript.name } : {}) }, urlPresets: deps.urlPresets }))

  const player = videoUrl ? new MeetingMedia(videoUrl) : null
  try {
    const info = player ? await player.probe().catch((err: unknown) => { reportHandled(err, { area: 'review', op: 'meeting: probe media' }); return null }) : null
    if (player && !info) warnings.push(t('meeting.warnings.unplayable'))

    // 文字起こし
    let transcript: TranscriptSegment[]
    if (parsed && parsed.utterances.length > 0) {
      transcript = parsed.utterances.map((u) => ({ t0: u.t, t1: u.t1, speaker: 'other' as const, text: u.text, ...(u.speaker ? { speakerName: u.speaker } : {}) }))
      if (!parsed.timed) warnings.push(t('meeting.warnings.untimed'))
    } else if (player && info) {
      transcript = await transcribeMedia(player, info.durationMs, paths, deps)
    } else {
      transcript = []
    }
    if (transcript.length === 0) throw new UserFacingError(t('meeting.errors.noSpeech'))

    // コマ（時刻のある文字起こしと、映像のある動画のときだけ）
    const frames: FrameRef[] = []
    const timed = !parsed || parsed.timed
    if (player && info?.hasVideo && ext && !isAudioOnly(ext) && timed) {
      const times = meetingFrameTimes(transcript.map((s) => s.t0), info.durationMs)
      let done = 0
      for (const at of times) {
        deps.onProgress({ stage: 'frames', done, total: times.length })
        const shot = await player.frame(at)
        done++
        if (!shot) continue
        const name = `meeting-${String(at).padStart(9, '0')}.jpg`
        try {
          await mkdirContained(paths.framesDir, { root: paths.dir })
          assertContained(paths.dir, paths.framesDir)
          await writeNewFileContained(join(paths.framesDir, name), shot.jpeg)
          frames.push({ t: at, path: name, size: { width: shot.width, height: shot.height } })
        } catch (err) {
          reportHandled(err, { area: 'review', op: 'meeting: save frame' })
        }
      }
    }

    deps.onProgress({ stage: 'draft' })
    const durationMs = Math.max(info?.durationMs ?? 0, ...transcript.map((s) => s.t1))
    const material: Material = {
      meta: { id: paths.id, startedAt, durationMs, twoSpeakers: (parsed?.speakers.length ?? 0) > 1, ...(deps.urlPresets.length ? { urlPresets: deps.urlPresets } : {}) },
      transcript, events: [], frames
    }
    return await deps.createReview(paths, material, warnings)
  } finally {
    player?.close()
  }
}

// ─── 共有リンクに届いた録画（src/main/feedbackShare/）─────────────────

export interface ShareRecordingImportDeps {
  projectDir: string
  recording: import('@shared/feedbackShare').ShareRecording
  /** 書き込みの記録（events.json）。無ければ null */
  events: import('@shared/feedbackShare').ShareEventsFile | null
  /** 録画（声・映像）を dest へ落とす（新しいファイルとして。上限は呼び出し側）。媒体の無い録画（文字だけ）では呼ばない */
  download: (dest: string) => Promise<void>
  sttEngine: MeetingImportDeps['sttEngine']
  urlPresets: MeetingImportDeps['urlPresets']
  createReview: MeetingImportDeps['createReview']
  onProgress: MeetingImportDeps['onProgress']
}

/**
 * 共有リンクに届いた録画を、mtg と同じ流れで指摘の候補のレビューにする（動画は meeting.<拡張子> として ▷ で見返せる）。
 * 声は設定の文字起こしで起こし、送った人の名前を話者の名前にする。書き込み・文字で指摘は録画と同じ操作ログにする
 * （feedbackShare/importRecording.ts）。書き込みは描き終わりのコマ、発言は時刻のコマを撮る
 */
export async function importShareRecording(deps: ShareRecordingImportDeps): Promise<ReviewData> {
  const { recording } = deps
  const { SHARE_MEDIA_TYPES } = await import('@shared/feedbackShare')
  const { shareRecordingMaterial } = await import('../feedbackShare/importRecording')
  await ensureGitExclude(deps.projectDir)
  const paths = await createSession(deps.projectDir)
  const warnings: string[] = []
  const ext = recording.mime ? SHARE_MEDIA_TYPES[recording.mime] : null
  let videoUrl: string | null = null
  if (ext) {
    deps.onProgress({ stage: 'copy' })
    const dest = join(paths.dir, `meeting.${ext}`)
    assertContained(paths.dir, dest)
    await deps.download(dest)
    videoUrl = `ade-media://review/${paths.id}/meeting.${ext}`
  }
  await writeFileNoFollow(join(paths.dir, 'capture.json'), JSON.stringify({ startedAt: recording.createdAt, twoSpeakers: false,
    share: { mode: recording.mode, ...(recording.name ? { name: recording.name } : {}) }, urlPresets: deps.urlPresets }))

  const player = videoUrl ? new MeetingMedia(videoUrl) : null
  try {
    const info = player ? await player.probe().catch((err: unknown) => { reportHandled(err, { area: 'review', op: 'share: probe media' }); return null }) : null
    if (player && !info) warnings.push(t('meeting.warnings.unplayable'))
    const hasMarks = recording.notes.length > 0 || (deps.events?.events.some((e) => e.type === 'pen' || e.type === 'note') ?? false)
    // 声。起こせなくても、文字で指摘・書き込みがあればそれだけで候補にする
    let spoken: TranscriptSegment[] = []
    if (player && info && info.durationMs > 0) {
      try {
        spoken = await transcribeMedia(player, info.durationMs, paths, deps)
      } catch (err) {
        if (!(err instanceof UserFacingError) || !hasMarks) throw err
        warnings.push(err.message)
      }
    }
    const material = shareRecordingMaterial(recording, deps.events, spoken)
    if (material.transcript.length === 0 && material.penFrames.length === 0) throw new UserFacingError(t('meeting.errors.noSpeech'))

    // コマ（映像のあるときだけ）。書き込みは描き終わりの少し後、発言はその時刻
    const frames: FrameRef[] = []
    if (player && info?.hasVideo) {
      const durationMs = info.durationMs || recording.durationMs
      const annotated = new Map<number, string>()
      for (const p of material.penFrames) if (!annotated.has(p.t)) annotated.set(p.t, p.annotationId)
      const times = [...new Set([...annotated.keys(), ...meetingFrameTimes(material.transcript.map((s) => s.t0), durationMs)])].sort((a, b) => a - b)
      let done = 0
      for (const at of times) {
        deps.onProgress({ stage: 'frames', done, total: times.length })
        const shot = await player.frame(at)
        done++
        if (!shot) continue
        const name = `meeting-${String(at).padStart(9, '0')}.jpg`
        try {
          await mkdirContained(paths.framesDir, { root: paths.dir })
          assertContained(paths.dir, paths.framesDir)
          await writeNewFileContained(join(paths.framesDir, name), shot.jpeg)
          const annotationId = annotated.get(at)
          frames.push({ t: at, path: name, size: { width: shot.width, height: shot.height }, ...(annotationId ? { annotationId } : {}) })
        } catch (err) {
          reportHandled(err, { area: 'review', op: 'share: save frame' })
        }
      }
    }

    deps.onProgress({ stage: 'draft' })
    const durationMs = Math.max(info?.durationMs ?? 0, recording.durationMs, ...material.transcript.map((s) => s.t1))
    return await deps.createReview(paths, {
      meta: { id: paths.id, startedAt: recording.createdAt, durationMs, twoSpeakers: false,
        ...(recording.startUrl ? { targetUrl: recording.startUrl } : {}), ...(deps.urlPresets.length ? { urlPresets: deps.urlPresets } : {}) },
      transcript: material.transcript, events: material.events, frames
    }, warnings)
  } finally {
    player?.close()
  }
}

/** 動画を写す（APFS などでは中身を複製しない写し。できなければ流して写す）。既にある名前・リンクには書かない */
async function copyIntoReview(from: string, dest: string): Promise<void> {
  try {
    await copyFile(from, dest, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE)
    return
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') throw err
  }
  const file = await openNewFileContained(dest)
  try {
    await pipeline(createReadStream(from), file.createWriteStream())
  } finally {
    await file.close().catch(() => undefined)
  }
}

/** 動画の音声を設定の文字起こしで起こす（録画と同じ区切り方）。使えなければ理由を投げる */
async function transcribeMedia(player: MeetingMedia, durationMs: number, paths: SessionPaths, deps: Pick<MeetingImportDeps, 'sttEngine' | 'onProgress'>): Promise<TranscriptSegment[]> {
  if (durationMs > MAX_AUDIO_DECODE_MS) throw new UserFacingError(t('meeting.errors.tooLongForAudio'))
  const { engine, kind, warning } = await deps.sttEngine()
  if (!engine) throw new UserFacingError(warning ?? t('meeting.errors.noTranscriber'))
  const { IncrementalTranscriber } = await import('../pipeline/stt/engine')
  const { SilenceSegmenter, recommendedMaxChunkMs, wavChunkWriter } = await import('../pipeline/stt/segmenter')
  await mkdirContained(paths.audioDir, { root: paths.dir })
  let chunks = 0
  let finished = 0
  const transcriber = new IncrementalTranscriber(engine, undefined, (progress) => {
    if (progress.segments || progress.error) finished++
    deps.onProgress({ stage: 'transcribe', done: finished, total: Math.max(chunks, finished) })
  })
  const segmenter = new SilenceSegmenter(wavChunkWriter(paths.audioDir, 16_000, (file) => {
    chunks++
    transcriber.push({ wavPath: file.wavPath, offsetMs: file.offsetMs, durationMs: file.durationMs, speaker: 'self', source: 'mic' })
  }), { maxChunkMs: recommendedMaxChunkMs(kind) })
  await player.decodeAudio((pcm) => segmenter.push(pcm), (done, total) => deps.onProgress({ stage: 'transcribe', done: Math.round((done / total) * 100), total: 100 }))
    .catch((err: unknown) => {
      reportHandled(err, { area: 'review', op: 'meeting: decode audio' })
      throw new UserFacingError(t('meeting.errors.audioDecode'))
    })
  await segmenter.flush()
  const result = await transcriber.flush()
  if (result.errors.length && result.segments.length === 0) {
    reportHandled(result.errors[0]!, { area: 'review', op: 'meeting: transcribe meeting' })
    throw new UserFacingError(t('meeting.errors.transcribeFailed'))
  }
  return result.segments
}

// ─── 判定 ─────────────────────────────────────────────

/** 1回の取り込みで判定する候補の上限（中継の合言葉の枠の中に収める） */
export const MAX_SCORED_ITEMS = 200
/** 判定に送るコマの幅（大きな画像は量の枠を早く使い切る） */
const SCORE_IMAGE_WIDTH = 1024

export interface MeetingScoreDeps {
  paths: SessionPaths
  session: DecisionAskSession | null
  /** コマを判定に送れる形（JPEG の base64）にする。読めなければ null */
  encodeFrame: (file: string, width: number) => Promise<string | null>
  save: (scores: Map<string, MeetingItemScore>, threshold: number) => Promise<{ excluded: number }>
  onProgress: (done: number, total: number) => void
  threshold?: number
  /** 待つ（429 のあと）。テストで差し替える */
  sleep?: (ms: number) => Promise<void>
}

/**
 * 候補ごとに判定モデルへ問い、点を付ける。判定を有効にしていなければ何もしない（skipped に理由）。
 * 1件ずつ送る（中継の1分あたりの回数の枠に合わせ、429 なら待ってやり直す）
 */
export async function scoreMeetingReview(deps: MeetingScoreDeps): Promise<MeetingScoreResult> {
  const { session } = deps
  if (!session) return { scored: 0, excluded: 0, skipped: t('meeting.score.disabled') }
  const record = await loadSession(deps.paths)
  if (!record) throw new UserFacingError(t('review.errors.notFound'))
  const items = record.document.items.slice(0, MAX_SCORED_ITEMS)
  const sleep = deps.sleep ?? delay
  const scores = new Map<string, MeetingItemScore>()
  let failure: string | null = null
  for (let i = 0; i < items.length; i++) {
    deps.onProgress(i, items.length)
    const item = items[i]!
    const frame = session.images && item.frameTimes[0] !== undefined ? record.frames.find((f) => f.t === item.frameTimes[0]) : undefined
    const jpeg = frame ? await deps.encodeFrame(frameFilePath(deps.paths, frame.path), SCORE_IMAGE_WIDTH) : null
    const image = jpeg ? (session.imageFormat === 'data-uri' ? `data:image/jpeg;base64,${jpeg}` : jpeg) : undefined
    const body = meetingDecisionBody(session.model, { title: item.title, request: item.request, quotes: item.quotes.map((q) => ({ ...(q.name ? { name: q.name } : {}), text: q.text })) }, image)
    let answer: { status: number; json: unknown } | null = null
    for (let attempt = 0; attempt < 4; attempt++) {
      answer = await session.ask(body).catch((err: unknown) => { reportHandled(err, { area: 'review', op: 'meeting: ask decision' }); return null })
      if (answer?.status !== 429) break
      // 1分あたりの回数の枠。少し待ってやり直す（合言葉の総量を使い切ったときも 429 だが、やり直しても通らないので回数で止まる）
      await sleep(15_000)
    }
    const score = answer && answer.status >= 200 && answer.status < 300 ? meetingScoreFromAnswer(answer.json) : null
    if (score) scores.set(item.id, score)
    else if (!failure) failure = answer ? t('meeting.score.failedStatus', { status: answer.status }) : t('meeting.score.unreachable')
    // 最初の数件が続けて失敗したら（接続先・キーの誤り）、残りは送らない
    if (scores.size === 0 && i >= 2 && failure) break
  }
  deps.onProgress(items.length, items.length)
  if (scores.size === 0) return { scored: 0, excluded: 0, skipped: failure ?? t('meeting.score.noItems') }
  const saved = await deps.save(scores, deps.threshold ?? MEETING_SCORE_THRESHOLD)
  return { scored: scores.size, excluded: saved.excluded }
}

/** コマのファイル（review の frames）を判定に送る JPEG の base64 にする（nativeImage で縮める） */
export async function encodeFrameJpeg(file: string, width: number): Promise<string | null> {
  const bytes = await readFileNoFollow(file, null, { maxBytes: 20 * 1024 * 1024 }).catch(() => null)
  if (!bytes) return null
  const { nativeImage } = await import('electron')
  const image = nativeImage.createFromBuffer(bytes)
  if (image.isEmpty()) return null
  const resized = image.getSize().width > width ? image.resize({ width }) : image
  return resized.toJPEG(80).toString('base64')
}
