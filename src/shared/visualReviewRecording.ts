import {
  LIMITS,
  canRespond,
  isRecordedReviewId,
  normalizePlanImage,
  parseRecordedReview,
  sanitizeRecordingNote,
  type RecordedReviewRef,
  type RecordingNote,
  type ReviewDocKind,
  type VisualPlan
} from './visualReview'
import { VALUE_LIMITS } from './valueUseCase'

/**
 * ビジュアルレビューの「声と書き込みでフィードバック」（純粋な関数。単体テストの対象）。
 *
 * 計画の画面で押すと、Ferret のいつもの録画（画面全体のワンクリック録画・マイク・文字起こし）が始まる。計画は見せたままで、
 * 人は話しながら計画の画像の上を囲む。止めるといつものパイプライン（文字起こし → 指摘 → .ferret/reviews/<id>/）が動き、
 * できたレビューを計画の返事（kind: 'recording'）として書き足し、計画を書いた Agent のターミナルへ送る。
 * うまくいかなくても録画はふつうのレビューとして残す（ここでは捨てない）。
 *
 * 流れ: idle → begin（録画を頼む）→ recording（録画中。打った文・囲みはその都度控える）→ 止めて review:ready
 *       → linkFinishedReview が 'attach' → processing（整理して計画に添える）→ finish で idle
 *
 * 価値ユースケース（@shared/valueUseCase）の文書にも同じ流れで返す（kind が 'value-usecases'）。
 * そのときの囲みの screen は、手順を価値をまたいで通しで数えた番号（flatStepIndex）
 */

/** 囲みの画像の番号（screen）の上限。ビジュアルレビューは画面の数、価値ユースケースは手順の通しの数 */
export function noteScreens(kind: ReviewDocKind): number {
  return kind === 'value-usecases' ? VALUE_LIMITS.totalSteps : LIMITS.screens
}

/** 声と書き込みで返そうとしている計画（App が1つだけ持つ） */
export interface PendingRecordingFeedback {
  /** 返す先の種類（ビジュアルレビューの計画・価値ユースケースの文書）。タブの id と同じ */
  kind: ReviewDocKind
  /** 計画・文書の id */
  planId: string
  /** 押したときのプロジェクトのフォルダ。止めたときに別のプロジェクトなら添えない */
  folderPath: string
  /** 押したときの計画の版。止めるまでに Agent が計画を書き直したら添えない */
  revision: number
  phase: 'recording' | 'processing'
  /** 打った文と囲み（録画中も書き足せる。止めたときの最新を送る） */
  note: RecordingNote
}

export type BeginResult =
  | { ok: true; pending: PendingRecordingFeedback }
  | { ok: false; reason: 'busy' | 'not-pending' | 'no-folder' }

/** 押したときに始めてよいか。録画中・開始の途中・ほかの計画をまとめている途中・返事を待っていない計画・フォルダが無いなら始めない */
export function beginRecordingFeedback(input: {
  current: PendingRecordingFeedback | null
  plan: Pick<VisualPlan, 'id' | 'status' | 'revision'>
  folderPath: string | null
  recording: boolean
  note?: unknown
  /** 既定はビジュアルレビュー */
  kind?: ReviewDocKind
}): BeginResult {
  if (input.current || input.recording) return { ok: false, reason: 'busy' }
  if (!input.folderPath) return { ok: false, reason: 'no-folder' }
  if (!canRespond(input.plan)) return { ok: false, reason: 'not-pending' }
  const kind = input.kind ?? 'visual-review'
  return { ok: true, pending: { kind, planId: input.plan.id, folderPath: input.folderPath, revision: input.plan.revision, phase: 'recording', note: sanitizeRecordingNote(input.note, noteScreens(kind)) } }
}

/** 録画中に打った文・囲みを控える（録画中だけ。まとめ始めたら変えない） */
export function updateRecordingNote(pending: PendingRecordingFeedback | null, planId: string, note: unknown, kind: ReviewDocKind = 'visual-review'): PendingRecordingFeedback | null {
  if (!pending || pending.kind !== kind || pending.planId !== planId || pending.phase !== 'recording') return pending
  return { ...pending, note: sanitizeRecordingNote(note, noteScreens(kind)) }
}

/**
 * 録画が止まってレビューができた（review:ready）。待っている計画に添えるか。
 *   attach        … 添える（processing へ）
 *   ignore        … 声と書き込みの録画ではない（ふつうの録画・追記・もうまとめている）
 *   other-project … 止めるまでにプロジェクトを替えた。レビューは残し、計画には添えない
 *   invalid       … レビューの id がおかしい
 */
export function linkFinishedReview(pending: PendingRecordingFeedback | null, ready: { reviewId: string; folderPath: string | null }): 'attach' | 'ignore' | 'other-project' | 'invalid' {
  if (!pending || pending.phase !== 'recording') return 'ignore'
  if (!isRecordedReviewId(ready.reviewId)) return 'invalid'
  if (ready.folderPath !== pending.folderPath) return 'other-project'
  return 'attach'
}

/** 計画に添える前に、計画がまだ同じ版で返事を待っているか（止めるまでに Agent が書き直した・人が文で返した、なら添えない） */
export function canAttachTo(pending: PendingRecordingFeedback, plan: Pick<VisualPlan, 'id' | 'status' | 'revision'> | null | undefined, kind: ReviewDocKind = 'visual-review'): boolean {
  return !!plan && pending.kind === kind && plan.id === pending.planId && plan.revision === pending.revision && canRespond(plan)
}

/** 録画のレビューの中身（main の review.ts が session.json から作る） */
export interface RecordedReviewDigest {
  id: string
  /** プロジェクトの根からのレビューのフォルダ（`.ferret/reviews/<id>`） */
  relativeDir: string
  items: ReadonlyArray<{ title: string; request: string; images: readonly string[]; include: boolean }>
  transcript: ReadonlyArray<{ text: string }>
}

const oneLine = (text: string): string => text.replace(/\s+/g, ' ').trim()

/**
 * 録画のレビューから、計画に書く RecordedReviewRef を作る。送る指摘（include）も発言も無ければ null（何も取れなかった）。
 * 画像は指摘の `./NN.png` を、プロジェクトの根からの相対パスに直したものだけ
 */
export function recordedReviewRef(digest: RecordedReviewDigest): RecordedReviewRef | null {
  const items = digest.items.filter((item) => item.include)
  const findings = items
    .map((item) => {
      const title = oneLine(item.title)
      const request = oneLine(item.request)
      return title && request && title !== request ? `${title} — ${request}` : title || request
    })
    .filter((line) => line.length > 0)
  let transcript = ''
  for (const segment of digest.transcript) {
    const text = oneLine(segment.text)
    if (!text) continue
    transcript = transcript ? `${transcript} ${text}` : text
    if (transcript.length >= LIMITS.transcript) break
  }
  if (findings.length === 0 && !transcript) return null
  const screenshots: string[] = []
  for (const name of new Set(items.flatMap((item) => item.images))) {
    if (!/^\.\/\d+\.png$/.test(name)) continue
    const rel = normalizePlanImage(`${digest.relativeDir}/${name.slice(2)}`)
    if (rel) screenshots.push(rel)
  }
  // 計画に書く形と同じ確かめ方で通す（長さ・数・パスの範囲）
  return parseRecordedReview({ id: digest.id, dir: digest.relativeDir, findings, screenshots, transcript })
}

/** 添えた結果（main が返す） */
export type AttachOutcome =
  /** 計画に書き、Agent のターミナルへ送れた */
  | { state: 'sent'; message: string }
  /** 計画には書いたが送れなかった（人がターミナルへ貼る文） */
  | { state: 'manual'; message: string; copyText: string }
  /** 何も取れなかった・計画がもう待っていない・読めない。レビューは残っている */
  | { state: 'kept'; message: string }
