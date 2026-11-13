import { captureTargetGap, sanitizeCaptureTarget } from '@shared/captureTarget'
import { sanitizeLimitFailover } from '@shared/failover'
import { handoffFilePath } from './failover/handoff'
import { clipboard, nativeImage, shell } from 'electron'
import { renderAgentPrompt, renderNgPrompt } from '@shared/agentPrompt'
import { groupByTarget } from '@shared/reviewTarget'
import { purposeOf } from '@shared/projectTargets'
import { buildRemoteFeedbackPrompt } from '@shared/projectSource'
import { cursorRing } from './pipeline/cursor-ring'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import type { ReviewData, ReviewEdit } from '@shared/review'
import type { RecordingResult } from './recording/types'
import type { Material, TranscriptSegment } from './pipeline/types'
import { buildDraftDocument, refineWithLlm } from './pipeline/decompose'
import { CodexRunner, ClaudeCodeRunner } from './pipeline/organize'
import { ApiLlmRunner } from './pipeline/organize/runners/api'
import { LLM_PROVIDER_PRESETS, providerLabel, resolveEndpoint, type AiEndpointConfig, type LlmApiProvider, type OrganizeRunnerId } from '@shared/aiProviders'
import { resolveAgentEnv } from './accounts'
import { renderFeedbackMarkdown } from './pipeline/feedback'
import { nearestFrameTime } from './pipeline/draft'
import { finalizeItems, toPending } from './pipeline/assemble'
import { imagePlan } from './pipeline/assemble'
// restoreDropped は発話の時刻を t と呼ぶので、そこだけ別名（translateMessage）で引く
import { t, t as translateMessage } from '@shared/i18n'
import { UserFacingError } from '@shared/errors'
import { DEFAULT_PASS_THRESHOLD } from '@shared/decision'
import { currentSettings } from './settings'
import { appendEvents, applyEdits, createSession, ensureGitExclude, frameFilePath, isSessionId, loadSession, readEvents, readLabel, readProgress, saveSession, sessionPaths, takePaths, updateProgress, updateProgressWith,
  writeFeedbackMarkdown, type SessionPaths, type SessionRecord } from './sessions'
import { listTakes } from './sessions/takes'
import { appendNote, hasRecordedItems, keepTypedItems, newNoteRecord, typedCount, withoutNotes, type NoteInput, type NotePage, type TextNote } from './sessions/notes'
import { hasTrimFailure, videoDuration as videoDurationOf, withTrim, withTrimFailure } from './sessions/trim'
import { keptSpans, type TrimCut } from '@shared/trim'
import { reportHandled } from '@shared/report'
import { randomBytes } from 'node:crypto'
import { assertContained, mkdirContained, readFileNoFollow, removeContained, renameContained, writeFileNoFollow, writeNewFileContained } from './sessions/containment'
import { applyProgress, applyVerdict, pendingIds, queuedIds, recentComments, sentPatch, type ProgressMap, type ProgressPatchValue, type ReviewVerdict } from '@shared/findingProgress'
import type { ReviewProgressPatch } from '@shared/review'

export async function finishReview(paths: SessionPaths, result: RecordingResult,
  transcript: TranscriptSegment[], warnings: string[], twoSpeakers: boolean): Promise<ReviewData> {
  // 録画を始めた時点の登録URL（index.ts が capture.json に控える）。環境のラベルに使う
  // 古い録画には capture.json が無い（想定内）
  const capture = parseSmallJson(await readFileNoFollow(join(paths.dir, 'capture.json'), 'utf8', { maxBytes: 1024 * 1024 }).catch(() => '{}'))
  const urlPresets = urlPresetsOf(capture.urlPresets)
  const material: Material = {
    meta: { id: paths.id, startedAt: result.startedAt, durationMs: result.durationMs,
      targetUrl: result.events.find((e) => e.type === 'nav')?.url, twoSpeakers, ...(urlPresets.length ? { urlPresets } : {}) },
    transcript, events: result.events, frames: result.frames
  }
  const { mergeTranscripts } = await import('./pipeline/merge')
  const merged = mergeTranscripts(transcript.filter((s) => s.source !== 'system'), transcript.filter((s) => s.source === 'system'))
  material.transcript = merged.segments
  const stage = buildDraftDocument(material)
  const record: SessionRecord = { version: 1, meta: material.meta, transcript: material.transcript,
    removedDuplicates: merged.removed.map((r) => r.segment), frames: result.frames, draft: stage.draft.items,
    originalDocument: stage.document, document: stage.document, edits: [], captureGaps: [...result.warnings, ...warnings] }
  await persist(paths, record)
  return loadReviewAt(paths)
}

/**
 * 取り込んだ mtg の素材（meeting/import.ts）から、録画と同じレビューを作る。発話から下書きを作り、画像を書き出す。
 * 指摘の整理（review:organize）と判定（setMeetingScores）は、このあと画面が順に呼ぶ
 */
export async function createImportedReview(paths: SessionPaths, material: Material, warnings: string[]): Promise<ReviewData> {
  const stage = buildDraftDocument(material)
  // 取り込んだ候補は、人が確かめるまで送る対象に入れない（判定モデルの点が付いたら、しきい値で入れ直す）
  const document = { ...stage.document, items: stage.document.items.map((item) => ({ ...item, include: false })) }
  const record: SessionRecord = { version: 1, meta: material.meta, transcript: material.transcript, removedDuplicates: [], frames: material.frames,
    draft: stage.draft.items, originalDocument: document, document, edits: [], captureGaps: warnings }
  await persist(paths, record)
  return loadReviewAt(paths)
}

/**
 * 判定モデルの点を候補に付ける（mtg の取り込み）。まだ編集していなければ、しきい値で送る対象を決め直す
 * （編集のあとは送る対象を変えない。人の決めたことを上書きしない）
 */
export async function setMeetingScores(paths: SessionPaths, scores: ReadonlyMap<string, import('@shared/meetingImport').MeetingItemScore>, threshold: number): Promise<{ review: ReviewData; excluded: number }> {
  const { applyMeetingScores } = await import('@shared/meetingImport')
  return inReviewQueue(paths, async () => {
    const record = await loadSession(paths)
    if (!record) throw new UserFacingError(t('review.errors.notFound'))
    const setInclude = record.edits.length === 0
    const scored = applyMeetingScores(record.document.items, scores, threshold, setInclude)
    record.document = { ...record.document, items: scored.items }
    if (record.originalDocument) record.originalDocument = { ...record.originalDocument, items: applyMeetingScores(record.originalDocument.items, scores, threshold, setInclude).items }
    await persist(paths, record)
    return { review: await loadReviewAt(paths), excluded: scored.excluded }
  })
}

/** 取り込んだ mtg の動画（meeting.<拡張子>）の名前。無ければ null */
async function meetingVideoName(dir: string): Promise<string | null> {
  const { existsSync } = await import('node:fs')
  const { MEETING_MEDIA_EXTENSIONS } = await import('@shared/meetingImport')
  for (const ext of MEETING_MEDIA_EXTENSIONS) if (existsSync(join(dir, `meeting.${ext}`))) return `meeting.${ext}`
  return null
}

/** capture.json に控えた登録URL。形の合うものだけ */
function urlPresetsOf(value: unknown): NonNullable<Material['meta']['urlPresets']> {
  return Array.isArray(value)
    ? value.filter((p): p is { id: string; label: string; url: string; purpose?: unknown } =>
      !!p && typeof p.id === 'string' && typeof p.label === 'string' && typeof p.url === 'string')
      // 区分（デザイン・設計書・参考）は知っている値だけ残す。app と壊れた値は持たない
      .map(({ purpose, ...p }) => (purposeOf({ purpose }) !== 'app' ? { ...p, purpose: purposeOf({ purpose }) } : p))
    : []
}

export function checkedPaths(projectDir: string | null, id: string): SessionPaths {
  if (!projectDir) throw new UserFacingError(t('errors.openProjectFolder'))
  if (!isSessionId(id)) throw new UserFacingError(t('review.errors.invalidId'))
  return sessionPaths(projectDir, id)
}

export async function loadReviewAt(paths: SessionPaths): Promise<ReviewData> {
  const record = await loadSession(paths)
  if (!record) return recoverReview(paths)
  const { existsSync } = await import('node:fs')
  const images: Record<string, string> = {}
  // 画面に渡す画像は、枚数・1枚の大きさ・合計に上限を置く（細工した巨大な PNG を全部 base64 にしない。limits.ts）。
  // 超えた分は出さない（画像の無い指摘として表示される）
  const { SESSION_LIMITS } = await import('./sessions/limits')
  let total = 0
  for (const name of new Set(record.document.items.flatMap((item) => item.images))) {
    if (!/^\.\/\d+\.png$/.test(name)) continue
    if (Object.keys(images).length >= SESSION_LIMITS.images || total >= SESSION_LIMITS.imagesTotalBytes) break
    // 消された画像・大きすぎる画像は出さないだけ（想定内）。末端がリンクの画像は読まない（外のファイルを画面へ渡さない）
    const bytes = await readFileNoFollow(join(paths.dir, basename(name)), null, { maxBytes: Math.min(SESSION_LIMITS.imageBytes, SESSION_LIMITS.imagesTotalBytes - total) }).catch(() => null)
    if (!bytes) continue
    total += bytes.length
    images[name] = `data:image/png;base64,${bytes.toString('base64')}`
  }
  const progress = await readProgress(paths, record.document.items.map((it) => it.id))
  // 追記した録画があれば、録画ごとの動画と時刻の範囲を渡す（▷ で正しい録画の正しい時刻を開く）
  const takes = listTakes(record)
  const { sentAt } = await readLabel(paths)
  return { id: paths.id, document: record.document, images, progress, canUndo: record.edits.length > 0 && !!record.originalDocument, canOrganize: record.edits.length === 0 && hasRecordedItems(record.document) && !record.document.organizedByLlm, ...(existsSync(paths.recording) ? { videoUrl: `ade-media://review/${paths.id}/recording.webm` } : await meetingVideoName(paths.dir).then((name) => (name ? { videoUrl: `ade-media://review/${paths.id}/${name}` } : {}))), warnings: record.captureGaps ?? [],
    // 何もない時間を削った版ができていれば、▷ はそちらを開く（削った区間で再生位置を読み替える）。無ければ元の動画
    ...(takes.length > 1 || takes.some((take) => take.trim) ? { takes: takes.map(({ trim, ...take }) => {
      const files = takePaths(paths, take.n)
      if (trim && existsSync(files.trimmedRecording)) return { ...take, videoUrl: takeVideoUrl(paths.id, take.n, true), cuts: trim.cuts }
      return { ...take, ...(existsSync(files.recording) ? { videoUrl: takeVideoUrl(paths.id, take.n) } : {}) }
    }) } : {}),
    ...(sentAt ? { sentAt } : {}),
    ...(hasTrimFailure(record) ? { trimSkipped: true } : {}) }
}

/** 録画の動画の URL（index.ts の ade-media が返す）。1 本目はレビュー直下の recording.webm */
function takeVideoUrl(id: string, n: number, trimmed = false): string {
  const name = trimmed ? 'recording.trimmed.webm' : 'recording.webm'
  return n <= 1 ? `ade-media://review/${id}/${name}` : `ade-media://review/${id}/takes/${n}/${name}`
}

/** 削る処理は1本ずつ（非表示ウィンドウで実時間かかるので、同時に何本も動かさない） */
let trimQueue: Promise<unknown> = Promise.resolve()

/**
 * 録画 n（1 が最初の録画）の何もない時間を削った版を、裏で作る（指摘はもう出ている）。
 * 失敗しても元の動画のまま使えるので、知らせずに記録だけ残す。できたら session.json に削った区間を書く
 */
export function trimReviewTake(review: SessionPaths, n: number, cuts: TrimCut[], sourceDurationMs: number): Promise<boolean> {
  const run = trimQueue.catch(() => {}).then(async () => {
    const files = takePaths(review, n)
    const { renderTrimmedVideo } = await import('./trimVideo')
    // 途中のファイルは毎回別の名前にし、排他で作る（trimVideo.ts）。先回りのリンクへ書かない。置き換え・片付けは親を開いて持ったまま（containment.ts）
    const part = `${files.trimmedRecording}.${randomBytes(4).toString('hex')}.part`
    try {
      await renderTrimmedVideo(takeVideoUrl(review.id, n), part, keptSpans(sourceDurationMs, cuts))
      await renameContained(part, files.trimmedRecording, { replace: true })
    } catch (err) {
      await removeContained(dirname(part), part).catch(() => undefined)
      reportHandled(err, { area: 'review', op: 'trim recording' })
      // 元の動画のまま使う（▷ は元の位置を開く）。削らなかったことは session.json に残し、画面に一度だけ知らせる
      await inReviewQueue(review, async () => {
        const record = await loadSession(review)
        if (record) await saveSession(review, withTrimFailure(record, n, err))
      }).catch((e: unknown) => reportHandled(e, { area: 'review', op: 'record trim failure' }))
      return false
    }
    // 編集・整理と同じ順番待ちに並んで、削った区間を session.json に書く
    return inReviewQueue(review, async () => {
      const record = await loadSession(review)
      if (!record) return false
      const next = withTrim(record, n, cuts, sourceDurationMs)
      await saveSession(review, next)
      await writeFeedbackMarkdown(review, renderFeedbackMarkdown(next.document, await feedbackOptions(review, next)))
      return true
    })
  })
  trimQueue = run
  return run
}

/** 編集・整理と同じ順番待ちに並べて動かす（同じ session.json を書き換えるもの） */
async function inReviewQueue<T>(review: SessionPaths, fn: () => Promise<T>): Promise<T> {
  // 前の処理の失敗はその呼び出し側へ返し済み（順番待ちに使うだけ。想定内）
  const write = (queues.get(review.dir) ?? Promise.resolve()).catch(() => {}).then(fn)
  queues.set(review.dir, write)
  try { return await write } finally { if (queues.get(review.dir) === write) queues.delete(review.dir) }
}

/**
 * 「このレビューに追加で録る」の録画を始める前に、録る場所（takes/<n>/）を用意する。
 * 分解の終わっていない・壊れたレビューには足さない（足し先の session.json が要る）
 */
export async function prepareReviewTake(projectDir: string, id: string): Promise<{ review: SessionPaths; n: number; paths: SessionPaths }> {
  const review = checkedPaths(projectDir, id)
  const record = await loadSession(review)
  if (!record) throw new UserFacingError(t('review.errors.appendUnavailable'))
  const { nextTakeNumber } = await import('./sessions/takes')
  const { existsSync } = await import('node:fs')
  // 足し終えずに残った録画のフォルダ（落ちた・失敗した）は上書きせず、次の番号を使う
  let n = nextTakeNumber(record)
  while (existsSync(takePaths(review, n).dir)) n++
  const paths = takePaths(review, n)
  // takes/ は確かめてから作り、録画のフォルダ（takes/<n>）は排他で作る（先回りのリンクの中へ録らない）
  await mkdirContained(join(review.dir, 'takes'), { root: review.dir })
  assertContained(review.dir, join(review.dir, 'takes'))
  await mkdirContained(paths.dir, { root: review.dir, exclusive: true })
  await mkdirContained(paths.audioDir, { root: review.dir })
  await mkdirContained(paths.framesDir, { root: review.dir })
  assertContained(review.dir, paths.framesDir)
  return { review, n, paths }
}

/**
 * 「このレビューに追加で録る」の録画が止まったあと。takes/<n>/ の素材から下書きを作り、レビューの末尾に足す。
 * 既存の指摘・編集・全体への補足・進み具合は残す（sessions/takes.ts）
 */
export async function appendReviewTake(paths: SessionPaths, n: number, result: RecordingResult,
  transcript: TranscriptSegment[], warnings: string[]): Promise<ReviewData> {
  // 編集・整理と同じ順番待ちに並ぶ（同じ session.json を書き換えるので）
  const work = (queues.get(paths.dir) ?? Promise.resolve()).catch(() => {}).then(async () => {
    const record = await loadSession(paths)
    if (!record) throw new UserFacingError(t('review.errors.notFound'))
    const { appendTake } = await import('./sessions/takes')
    const { mergeTranscripts } = await import('./pipeline/merge')
    const merged = mergeTranscripts(transcript.filter((s) => s.source !== 'system'), transcript.filter((s) => s.source === 'system'))
    const appended = appendTake(record, await readEvents(paths), { n, startedAt: result.startedAt, addedAt: new Date().toISOString(),
      durationMs: result.durationMs, transcript: merged.segments, removedDuplicates: merged.removed.map((r) => r.segment),
      events: result.events, frames: result.frames, warnings: [...result.warnings, ...warnings] })
    // 操作ログはレビューの時間軸へずらしたものをレビューの events.jsonl へ足す（録画ごとの元の記録は takes/<n>/events.jsonl に残る）
    await appendEvents(paths, appended.events)
    await persist(paths, appended.record)
    return loadReviewAt(paths)
  })
  queues.set(paths.dir, work)
  try { return await work } finally { if (queues.get(paths.dir) === work) queues.delete(paths.dir) }
}

async function persist(paths: SessionPaths, record: SessionRecord): Promise<void> {
  // 編集で番号が変わったときも、画像名と内容を同時に作り直す。
  for (const plan of imagePlan({ ...record.document, items: record.document.items.map((it) => ({ ...it, include: true })) }, record.frames)) {
    let frame = nativeImage.createFromPath(frameFilePath(paths, plan.frame.path))
    if (frame.isEmpty()) continue
    if (plan.needsCursorRing && plan.frame.cursor && plan.frame.size) {
      const size = frame.getSize()
      frame = nativeImage.createFromBitmap(cursorRing(frame.toBitmap(), size.width, size.height, plan.frame.cursor.x, plan.frame.cursor.y), size)
    }
    const width = Math.min(frame.getSize().width, 1568)
    await writeFileNoFollow(join(paths.dir, basename(plan.name)), frame.resize({ width }).toPNG())
  }
  await saveSession(paths, record)
  await writeFeedbackMarkdown(paths, renderFeedbackMarkdown(record.document, await feedbackOptions(paths, record)))
}

/** feedback.md の書き出しの設定（受け入れ確認の節・進み具合のファイル・録った対象） */
async function feedbackOptions(paths: SessionPaths, record: SessionRecord) {
  // 動画の長さは、削った版があれば削ったあとの長さ（元の長さも併記する）。録画と録画のすき間は数えない
  const videoDuration = videoDurationOf(record, listTakes(record)[0]!.durationMs)
  // AFTER を撮る localhost の URL は、録画時の確認先に加えて今のプロジェクトの確認先からも探す（あとから local を登録した場合）
  const project = currentSettings().projects.find((p) => paths.dir.startsWith(`${p.folderPath}${sep}`))
  const urlPresets = [...(record.document.meta.urlPresets ?? []), ...(project?.urls ?? [])]
  // 録った対象（デスクトップアプリ・スマホの端末）。古い録画・内蔵ブラウザの録画には無い（想定内）
  const capture = parseSmallJson(await readFileNoFollow(join(paths.dir, 'capture.json'), 'utf8', { maxBytes: 1024 * 1024 }).catch(() => '{}'))
  const captureTarget = sanitizeCaptureTarget(capture.captureTarget)
  return { captureGaps: record.captureGaps ?? [], decision: feedbackDecisionOptions(paths), progressFile: paths.progressJson, reviewDir: paths.dir, urlPresets, videoDuration,
    ...(captureTarget ? { captureTarget } : {}) }
}

/**
 * 指摘の進み具合を変える（画面の切り替え）。Agent と同じ progress.json に書く。
 * 知らない指摘のIDは書かない（renderer から来た値なので確かめる）
 */
export async function setReviewProgress(paths: SessionPaths, patch: ReviewProgressPatch): Promise<ProgressMap> {
  const record = await loadSession(paths)
  if (!record) throw new UserFacingError(t('review.errors.notFound'))
  const ids = record.document.items.map((it) => it.id)
  const known = Object.entries(patch && typeof patch === 'object' ? patch : {}).filter(([id]) => ids.includes(id))
  // 画面から done にするのは人の OK と同じ（done にできるのは人だけ。記録が無い done は確認待ちとして読まれる）
  const isDone = (v: ProgressPatchValue) => (typeof v === 'object' && v ? v.status : v) === 'done'
  if (known.length) {
    await updateProgressWith(paths, (current) => {
      const at = new Date().toISOString()
      const next = applyProgress(current, Object.fromEntries(known.filter(([, v]) => !isDone(v))))
      for (const [id] of known.filter(([, v]) => isDone(v))) next[id] = applyVerdict(next[id], 'ok', undefined, at)
      return next
    })
  }
  return readProgress(paths, ids)
}

/**
 * 人の判断（OK / NG / Comment）を記録する。OK で完了、NG で対応中に戻して送り直し待ち（queued）、Comment は状態を変えない。
 * NG はコメントが必須（Agent に何を直すか伝えるため）
 */
export async function recordReviewVerdict(paths: SessionPaths, itemId: string, verdict: ReviewVerdict, body?: string): Promise<ProgressMap> {
  const record = await loadSession(paths)
  if (!record) throw new UserFacingError(t('review.errors.notFound'))
  const ids = record.document.items.map((it) => it.id)
  if (!ids.includes(itemId)) throw new UserFacingError(t('review.errors.findingNotFound'))
  if (verdict !== 'ok' && !body?.trim()) throw new UserFacingError(t('review.verdict.commentRequired'))
  await updateProgressWith(paths, (current) => ({ ...current, [itemId]: applyVerdict(current[itemId], verdict, body, new Date().toISOString()) }))
  return readProgress(paths, ids)
}

/**
 * NG を付けた指摘を、コメントつきで Agent へ送り直す1行（「NG をまとめて送る」と、1件だけ送る操作）。
 * itemIds を省くと queued の指摘すべて。番号は feedback.md の見出しと同じ数え方。送る指摘が無ければ投げる
 */
export async function ngResendInstruction(paths: SessionPaths, itemIds?: string[]): Promise<{ text: string; ids: string[] }> {
  const record = await loadSession(paths)
  if (!record) throw new UserFacingError(t('review.errors.notFound'))
  const progress = await readProgress(paths)
  const included = record.document.items.filter((it) => it.include)
  const ordered = groupByTarget(included, (it) => it.context.url, record.document.meta.urlPresets ?? [], (it) => it.context.source).flatMap((g) => g.items)
  const wanted = new Set(itemIds ?? queuedIds(ordered, progress))
  const items = ordered.flatMap((it, i) => {
    const comment = recentComments(progress[it.id], 1)[0]?.text
    return wanted.has(it.id) && comment ? [{ n: i + 1, id: it.id, comment }] : []
  })
  if (!items.length) throw new UserFacingError(t('review.verdict.nothingToResend'))
  await refreshFeedbackMarkdown(paths)
  return { text: renderNgPrompt({ relativeDir: paths.relativeDir, feedbackMd: paths.feedbackMd }, items, undefined, decisionPromptOptions()), ids: items.map((it) => it.id) }
}

/** NG を送り直したあと。送り直し待ち（queued）を外して対応中にする（前の AFTER・スコア・記録は残す） */
export async function markResent(paths: SessionPaths, itemIds: string[]): Promise<ProgressMap> {
  const record = await loadSession(paths)
  const ids = record?.document.items.map((it) => it.id) ?? []
  await updateProgress(paths, Object.fromEntries(itemIds.filter((id) => ids.includes(id)).map((id) => [id, 'in_progress' as const])))
  return readProgress(paths, ids)
}

/** 「Agentへ送信」のあと。送った指摘のうち未対応のものを対応中にする（Agent が done にするまで） */
export async function markSentInProgress(paths: SessionPaths): Promise<void> {
  const record = await loadSession(paths)
  if (!record) return
  const patch = sentPatch(record.document.items, await readProgress(paths))
  if (Object.keys(patch).length) await updateProgress(paths, patch)
}

const queues = new Map<string, Promise<unknown>>()
export async function editReview(paths: SessionPaths, edit: ReviewEdit): Promise<ReviewData> {
  // 前の処理の失敗はその呼び出し側へ返し済み。ここでは順番待ちに使うだけ（想定内）
  const next = (queues.get(paths.dir) ?? Promise.resolve()).catch(() => {}).then(() => editReviewNow(paths, edit))
  queues.set(paths.dir, next)
  try { return await next } finally { if (queues.get(paths.dir) === next) queues.delete(paths.dir) }
}
async function editReviewNow(paths: SessionPaths, edit: ReviewEdit): Promise<ReviewData> {
  const record = await loadSession(paths)
  if (!record) throw new UserFacingError(t('review.errors.notFound'))
  if (edit.kind === 'undo') {
    if (!record.originalDocument || !record.edits.length) throw new UserFacingError(t('review.errors.nothingToRestore'))
    const edits = record.edits.slice(0, -1)
    const applied = applyEdits({ document: record.originalDocument, edits, events: await readEvents(paths), frames: record.frames })
    await persist(paths, { ...record, document: applied.document, edits })
    return loadReviewAt(paths)
  }
  // 「要確認にする」「次とまとめる」は画面から無くした。古い session.json の編集の列に残るものは applyEdits が再生するが、新しくは受け付けない
  const raw = edit as { kind: string; status?: unknown }
  if (raw.kind === 'merge' || (raw.kind === 'status' && raw.status !== 'decided')) throw new Error(`unsupported review edit: ${raw.kind}`)
  const applied = applyEdits({ document: record.document, edits: [edit],
    events: await readEvents(paths), frames: record.frames })
  if (applied.skipped.length) throw new Error(applied.skipped[0]!.reason)
  await persist(paths, { ...record, document: applied.document, edits: [...record.edits, edit] })
  return loadReviewAt(paths)
}

/** 判定モデルを有効にしているときの、指示文の受け入れ確認（無効なら null） */
function decisionPromptOptions(): { threshold: number } | null {
  const decision = currentSettings().decision
  return decision?.enabled ? { threshold: decision.passThreshold ?? DEFAULT_PASS_THRESHOLD } : null
}

/** 判定モデルを有効にしているときの、feedback.md の受け入れ確認の節と BEFORE の画像の絶対パス（無効なら null） */
function feedbackDecisionOptions(paths: SessionPaths): { threshold: number; dir: string } | null {
  const prompt = decisionPromptOptions()
  return prompt ? { ...prompt, dir: paths.dir } : null
}

/**
 * 送る・コピーする直前に feedback.md を今の設定で書き直す（判定モデルを有効・無効にしたあとでも節が合うように）。
 * 記録の無いレビュー（分解の途中で落ちた）はそのまま
 */
export async function refreshFeedbackMarkdown(paths: SessionPaths): Promise<void> {
  const record = await loadSession(paths)
  // 人のコメント（NG・Comment）も各指摘に載せる
  if (record) await writeFeedbackMarkdown(paths, renderFeedbackMarkdown(record.document, { ...(await feedbackOptions(paths, record)), progress: await readProgress(paths) }))
}

/**
 * 「Agentへ送信」の直前。送るのは未対応（todo）で送る対象の指摘だけ（done・in_progress・human_review は送らない）。
 * feedback.md をその指摘だけを詳しく書いた形で書き直し、残りは「今回の依頼に含まない（やり直さない）」の節に載せる。
 * 送る指摘のIDを返す。0件なら feedback.md は書き換えない（呼び出し側が送らずに理由を返す）
 */
export async function prepareSendFeedback(paths: SessionPaths): Promise<string[]> {
  const record = await loadSession(paths)
  if (!record) return []
  const progress = await readProgress(paths)
  const ids = pendingIds(record.document.items, progress)
  if (ids.length) await writeFeedbackMarkdown(paths, renderFeedbackMarkdown(record.document, { ...(await feedbackOptions(paths, record)), focusIds: ids, progress }))
  return ids
}

/**
 * ビジュアルレビューの「声と書き込みでフィードバック」に添える、録画のレビューの中身（指摘・発言・画像の名前）。
 * Agent が読む feedback.md を今の設定で書き直してから返す。記録が無ければ null
 */
export async function recordedReviewDigest(paths: SessionPaths): Promise<import('@shared/visualReviewRecording').RecordedReviewDigest | null> {
  const record = await loadSession(paths)
  if (!record) return null
  await refreshFeedbackMarkdown(paths)
  return {
    id: paths.id,
    relativeDir: paths.relativeDir,
    items: record.document.items.map((item) => ({ title: item.title, request: item.request, images: item.images, include: item.include })),
    transcript: record.transcript.map((segment) => ({ text: segment.text }))
  }
}

export async function copyReview(paths: SessionPaths, template?: string | null, remote = false): Promise<void> {
  await refreshFeedbackMarkdown(paths)
  clipboard.writeText(remote ? await remoteReviewInstruction(paths) : await reviewInstruction(paths, template))
}

/**
 * SSH のプロジェクトで送る本文。リモートの Agent はローカルの feedback.md を読めないので、中身をそのまま貼る
 * （src/shared/projectSource.ts の buildRemoteFeedbackPrompt）。画像は開けない旨も前置きに書く。
 */
export async function remoteReviewInstruction(paths: SessionPaths): Promise<string> {
  const markdown = await readFileNoFollow(paths.feedbackMd, 'utf8')
  return buildRemoteFeedbackPrompt(t('review.remote.intro'), markdown, t('review.remote.truncated'))
}
export async function revealReview(paths: SessionPaths): Promise<void> {
  shell.showItemInFolder(paths.feedbackMd)
}

/**
 * 「Agentへ送信」「Agent向けにコピー」の1行。文面は設定のテンプレート（空なら既定文）。
 * デザイン・設計書の確認先で撮った指摘があれば、コードではなくそれらを直す1文を足す。
 * 参考（外部サイト）で撮った指摘があれば、そのサイトは直さず自分のアプリに取り入れる・避ける1文を足す
 */
export async function reviewInstruction(paths: SessionPaths, template?: string | null): Promise<string> {
  const record = await loadSession(paths)
  const included = record?.document.items.filter((it) => it.include) ?? []
  const purposes = new Set(groupByTarget(included, (it) => it.context.url, record?.document.meta.urlPresets ?? [], (it) => it.context.source).map((g) => g.target.purpose))
  const nonCode = purposes.has('design') || purposes.has('doc')
  // 参考に見た外部サイト（競合・お手本）の指摘は、そのサイトを直させない
  const reference = purposes.has('reference')
  // 上限での自動切り替えが入なら、引き継ぎのファイル（.ferret/handoff.md）を区切りごとに更新させる（src/main/failover）
  const handoff = sanitizeLimitFailover(currentSettings().limitFailover).enabled ? handoffFilePath(resolve(paths.dir, relative(paths.relativeDir, '.'))) : undefined
  return renderAgentPrompt({ relativeDir: paths.relativeDir, feedbackMd: paths.feedbackMd, ...(nonCode ? { nonCode } : {}), ...(reference ? { reference } : {}), ...(handoff ? { handoff } : {}) }, template, undefined, decisionPromptOptions())
}

export async function previewFrames(paths: SessionPaths, itemId: string): Promise<import('@shared/review').ReviewFrame[]> {
  const record = await loadSession(paths)
  const item = record?.document.items.find((it) => it.id === itemId)
  if (!record || !item) throw new UserFacingError(t('review.errors.findingNotFound'))
  const { frameCandidates } = await import('./sessions/edits')
  const { framesOfTake } = await import('./sessions/takes')
  // 追記した録画があれば、その指摘と同じ録画の静止画だけを候補にする
  return frameCandidates(framesOfTake(record, item.contextTime), item.contextTime, 7).flatMap((frame) => {
    const image = nativeImage.createFromPath(frameFilePath(paths, frame.path))
    return image.isEmpty() ? [] : [{ t: frame.t, image: image.resize({ width: Math.min(800, image.getSize().width) }).toDataURL() }]
  })
}

/**
 * 「指摘を整理」。CLI（各自の契約）か、API キーで直接 LLM を呼ぶ（api: で始まる runnerId）。
 * api には保存したキーと接続先を渡す（キーは pipeline/stt/keys.ts。配布版は環境変数のキーを読まない）
 */
export async function organizeReview(paths: SessionPaths, runnerId: OrganizeRunnerId, api?: { apiKey?: string; endpoint?: AiEndpointConfig },
  /** CLI の runner のモデル名（settings.json の organizer.cliModels）。省略時は各 CLI の既定 */
  cliModels?: Partial<Record<'codex' | 'claude-code', string>>): Promise<ReviewData> {
  // 前の処理の失敗はその呼び出し側へ返し済み（順番待ちに使うだけ。想定内）
  const work = (queues.get(paths.dir) ?? Promise.resolve()).catch(() => {}).then(async () => {
    const record = await loadSession(paths)
    if (!record || record.edits.length) throw new UserFacingError(t('review.errors.editedNoOverwrite'))
    // 選択中のアカウント（フッターで切り替えたもの）で CLI を動かす
    const apiProvider = runnerId.startsWith('api:') ? runnerId.slice(4) as LlmApiProvider : null
    // CLI はプロジェクトの外の信頼できる絶対パスから起動する（プロジェクトに置かれた claude / codex を拾わない。security-6 [6]）
    const project = resolve(paths.dir, relative(paths.relativeDir, '.'))
    const runner = apiProvider
      ? new ApiLlmRunner({ provider: apiProvider, endpoint: api?.endpoint, apiKey: api?.apiKey })
      : runnerId === 'codex'
        ? new CodexRunner({ project, accountEnv: () => resolveAgentEnv('codex'), ...(cliModels?.codex ? { model: cliModels.codex } : {}) })
        : new ClaudeCodeRunner({ project, accountEnv: () => resolveAgentEnv('claude'), ...(cliModels?.['claude-code'] ? { model: cliModels['claude-code'] } : {}) })
    const name = apiProvider ? providerLabel(LLM_PROVIDER_PRESETS[apiProvider], t) : runnerId === 'codex' ? 'Codex' : 'Claude Code'
    if (!await runner.available()) throw new Error(apiProvider ? t('organize.api.keyMissing', { label: name }) : t('review.errors.runnerUnavailable', { name }))
    // 端末内のサーバー（おすすめの Ollama など）は、動いていない・モデルが無いときに先に理由と次の一手を出す
    if (apiProvider && LLM_PROVIDER_PRESETS[apiProvider].local) {
      const ep = resolveEndpoint(LLM_PROVIDER_PRESETS[apiProvider], api?.endpoint)
      const state = await (await import('./localModels')).checkLocalServer(ep.baseUrl, ep.model)
      if (state === 'down') throw new UserFacingError(t('review.errors.localServerDown', { name }))
      if (state === 'noModel') throw new UserFacingError(t('review.errors.localModelMissing', { name, model: ep.model }))
    }
    const events = await readEvents(paths)
    // 文字で指摘した指摘（枠と静止画）は整理の素材から外し、整理の後に足し直す（notes.ts。整理が打った文を発話と混ぜたり、枠だけの指摘を作り直したりしない）
    const material: Material = withoutNotes({ meta: record.meta, transcript: record.transcript, events, frames: record.frames })
    // API は CLI より待つ（大きなモデルは1分を超えることがある。接続先ごとの timeoutMs があればそれを使う）
    const result = await refineWithLlm(material, buildDraftDocument(material), { runner, cwd: paths.dir, timeoutMs: apiProvider ? 180_000 : 60_000 })
    record.llm = { runner: runner.id, ok: result.organize.ok, elapsedMs: result.organize.elapsedMs,
      issues: result.organize.issues, ...(!result.organize.ok ? { reason: result.organize.reason } : {}) }
    if (result.fellBack) {
      await persist(paths, record)
      // 理由は session.json の llm.reason に残す。画面には次の一手だけを出す
      throw new UserFacingError(t('review.errors.organizeFailed', { name }))
    }
    const organized = keepTypedItems(record.document, result.document, events)
    record.originalDocument = organized
    record.document = organized
    await persist(paths, record)
    return loadReviewAt(paths)
  })
  queues.set(paths.dir, work)
  try { return await work } finally { if (queues.get(paths.dir) === work) queues.delete(paths.dir) }
}

async function recoverReview(paths: SessionPaths): Promise<ReviewData> {
  const { inspect, startedAtFromId } = await import('./sessions')
  const info = await inspect(paths)
  const { existsSync } = await import('node:fs')
  const broken = existsSync(paths.sessionJson)
  // 素材の残っていない記録（すぐ止めた録画・壊れた session.json だけ）を開いたのは想定内。利用者に理由を出すだけで Sentry には送らない（FERRET-25）
  if (!info.worthRecovering) throw new UserFacingError(broken ? t('review.errors.broken') : t('review.errors.nothingRecoverable'))
  // 壊れた session.json は上書きで失わないよう、別名へ移してから作り直す（読み込まずに移す。巨大なものもある）
  if (broken) {
    await renameContained(paths.sessionJson, `${paths.sessionJson}.broken`, { replace: true })
  }
  // 記録の各ファイルは無いことがあり、途中で切れた行は飛ばす（中断した録画の復元。想定内）。
  // 行数・1行の長さ・大きさの上限付きで読み、形の合わない行は捨てる（limits.ts）
  const { readJsonLines, maxOf } = await import('./sessions/limits')
  const events = await readEvents(paths)
  const frames = (await readJsonLines<import('./pipeline/types').FrameRef>(join(paths.dir, 'frames.jsonl')))
    .filter((f) => !!f && Number.isFinite(f.t) && typeof f.path === 'string')
  const transcript = (await readJsonLines<TranscriptSegment>(join(paths.dir, 'transcript.jsonl')))
    .filter((s) => !!s && Number.isFinite(s.t0) && Number.isFinite(s.t1) && typeof s.text === 'string')
  const meta = parseSmallJson(await readFileNoFollow(join(paths.dir, 'capture.json'), 'utf8', { maxBytes: 1024 * 1024 }).catch(() => '{}'))
  // 可変長引数（Math.max(...xs)）は、件数が引数の上限を超えると投げる。ループで求める
  const durationMs = maxOf([...events.map((e) => e.t), ...frames.map((f) => f.t), ...transcript.map((s) => s.t1)], 0)
  return finishReview(paths, { startedAt: typeof meta.startedAt === 'string' ? meta.startedAt : startedAtFromId(paths.id), durationMs, videoPath: paths.recording,
    videoBytes: 0, frames, events, audioSamples: { mic: 0, system: 0 }, warnings: [], tracks: [] }, transcript,
    [t('review.recoveredWarning')], meta.twoSpeakers === true)
}

export async function restoreDropped(paths: SessionPaths, t: number): Promise<ReviewData> {
  // 前の処理の失敗はその呼び出し側へ返し済み（順番待ちに使うだけ。想定内）
  const work = (queues.get(paths.dir) ?? Promise.resolve()).catch(() => {}).then(async () => {
    const record = await loadSession(paths)
    const base = record?.originalDocument ?? record?.document
    const dropped = base?.dropped.find((item) => item.t === t)
    const quote = record?.transcript.find((item) => item.t0 === t)
    if (!record || !base || !dropped || !quote) throw new Error(translateMessage('review.errors.noRecoverableUtterance'))
    const events = await readEvents(paths)
    const ft = nearestFrameTime(record.frames, t)
    const restored = { id: `restored-${t}`, t, title: quote.text.slice(0, 60), request: '', status: 'needs_check' as const,
      quotes: [{ speaker: quote.speaker, t, text: quote.text }], frameTimes: ft === undefined ? [] : [ft], annotationIds: [], draftIds: [], include: false }
    // 指摘が増えたので、整理が付けた名前（reviewTitle）は外して自動の名前をルールで作り直す
    const { reviewTitle: _stale, ...rest } = base
    record.originalDocument = { ...rest, items: finalizeItems([...base.items.map(toPending), restored], events), dropped: base.dropped.filter((item) => item.t !== t) }
    record.document = applyEdits({ document: record.originalDocument, edits: record.edits, events, frames: record.frames }).document
    await persist(paths, record)
    return loadReviewAt(paths)
  })
  queues.set(paths.dir, work)
  try { return await work } finally { if (queues.get(paths.dir) === work) queues.delete(paths.dir) }
}

/** 文字で指摘の1件（index.ts が注入スクリプトの値を確かめ、静止画を撮ってから渡す） */
export interface TextNoteRequest {
  /** 書き込みの ID（note- で始まる。静止画のファイル名にも使う） */
  id: string
  note: TextNote
  /** 静止画（PNG）。撮れなければ null（画像の無い指摘になる） */
  image: { png: Uint8Array; size: { width: number; height: number } } | null
  /** 内蔵ブラウザのページ。映したウインドウなら無し */
  page?: NotePage
  /** 映したウインドウ（デスクトップアプリ・シミュレータ）。新しいレビューの capture.json に控える */
  captureTarget?: import('@shared/types').CaptureTarget
  /** 新しいレビューに控える、プロジェクトの登録URL */
  urlPresets?: unknown
}

/**
 * 文字で指摘を足す。開いているレビュー（reviewId。このプロジェクトのもの）があればその末尾へ、無ければ新しいレビューを作る。
 * 足した後のレビューと、その中の打った指摘の数を返す
 */
export async function addTextNote(projectDir: string, reviewId: string | null, request: TextNoteRequest): Promise<{ review: ReviewData; count: number }> {
  if (reviewId && isSessionId(reviewId)) {
    const paths = checkedPaths(projectDir, reviewId)
    const appended = await inReviewQueue(paths, async () => {
      const record = await loadSession(paths)
      // 分解の終わっていない・壊れた・消えたレビューには足さない（新しいレビューにする）
      if (!record) return null
      const events = await readEvents(paths)
      // 映したウインドウの指摘は、内蔵ブラウザのページを録ったレビューへは足さない（直前のページの URL が付いてしまう）。新しいレビューにする
      if (request.captureTarget && request.captureTarget.kind !== 'browser' && events.some((e) => e.type === 'nav')) return null
      const input = await saveNoteFrame(paths, request)
      const next = appendNote(record, events, input)
      await appendEvents(paths, next.events)
      await persist(paths, next.record)
      return { review: await loadReviewAt(paths), count: typedCount(next.record.document) }
    })
    if (appended) return appended
  }
  await ensureGitExclude(projectDir)
  const paths = await createSession(projectDir)
  const startedAt = new Date().toISOString()
  const target = request.captureTarget && request.captureTarget.kind !== 'browser' ? request.captureTarget : undefined
  const urlPresets = urlPresetsOf(request.urlPresets)
  await writeFileNoFollow(join(paths.dir, 'capture.json'), JSON.stringify({ startedAt, twoSpeakers: false, notes: true, ...(target ? { captureTarget: target } : {}), urlPresets }))
  const input = await saveNoteFrame(paths, request)
  const gap = target ? captureTargetGap(target) : null
  const created = newNoteRecord({ id: paths.id, startedAt, ...(urlPresets.length ? { urlPresets } : {}) }, input, gap ? [gap] : [])
  await appendEvents(paths, created.events)
  await persist(paths, created.record)
  return { review: await loadReviewAt(paths), count: typedCount(created.record.document) }
}

/** 文字で指摘の静止画を work/frames に置く（保存期間で work/ が消えていれば作り直す）。書けなければ画像の無い指摘にする */
async function saveNoteFrame(paths: SessionPaths, request: TextNoteRequest): Promise<NoteInput> {
  const base: NoteInput = { id: request.id, note: request.note, ...(request.page ? { page: request.page } : {}) }
  if (!request.image) return base
  const name = `${request.id}.png`
  try {
    await mkdirContained(paths.workDir, { root: paths.dir })
    await mkdirContained(paths.framesDir, { root: paths.dir })
    assertContained(paths.dir, paths.framesDir)
    await writeNewFileContained(join(paths.framesDir, name), request.image.png)
  } catch (err) {
    reportHandled(err, { area: 'review', op: 'save text note still' })
    return base
  }
  return { ...base, frame: { path: name, size: request.image.size } }
}

/** 小さな JSON（capture.json）を読む。壊れていれば空（想定内。古い録画には無い） */
function parseSmallJson(text: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(text)
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
  } catch {
    return {}
  }
}
