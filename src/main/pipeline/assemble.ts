/**
 * ③の結果（または②の下書き）を、確認画面と feedback.md が扱う最終形へ組み立てる。
 * 画像ファイル名の割り当てと、操作ログからの文脈付与（EXT-4）をここで行う。
 *
 * 確認画面での編集（sessions/edits.ts）も最後に `finalizeItems()` を通すので、
 * 番号・画像名・文脈は常にこの1か所で決まる。
 */
import type {
  DraftItem,
  Event,
  FeedbackDocument,
  FeedbackItem,
  FrameRef,
  ItemStatus,
  Material,
  OrganizeOutput,
  Quote,
  SessionMeta,
  TranscriptSegment
} from './types'
import { buildItemContext } from './context'
import { buildDraft, nearestFrameTime } from './draft'
import { isAnnotation } from './types'
import { isMeaninglessUtterance } from './meaningless'
import { t } from '@shared/i18n'

export interface AssembleOptions {
  /** 画像の拡張子（④で縮小保存する形式） */
  imageExt: string
  /** 「要確認」の指摘を既定で送信対象に含めるか（設計7章4: 既定は外す） */
  includeNeedsCheck: boolean
}

const defaultAssembleOptions: AssembleOptions = {
  imageExt: 'png',
  includeNeedsCheck: false
}

/**
 * 確定前の指摘。index・画像名・contextTime・context は `finalizeItems()` が付ける。
 * 確認画面の編集もこの形で行い、最後に finalize する。
 */
export interface PendingItem {
  id: string
  t: number
  title: string
  request: string
  status: ItemStatus
  quotes: Quote[]
  frameTimes: number[]
  annotationIds: string[]
  draftIds: string[]
  include: boolean
}

/**
 * 番号・画像名・文脈を確定する。
 * - 時刻の順に並べ替えて 1 から番号を振る（並べ替えた一覧は keepOrder でその順のまま）
 * - 使われた静止画の時刻に `01.png` から連番を割り当てる（同じ時刻は同じファイル）
 * - URL・要素・直前の操作は**画像の時刻**から引く（画像と説明が同じ瞬間を指すように。設計5章④）
 */
export function finalizeItems(
  pending: PendingItem[],
  events: Event[],
  options: Partial<AssembleOptions> = {},
  /** 並べ替えた一覧（FeedbackDocument.customOrder）。時刻順に並べ直さず、渡した順に番号を振る */
  keepOrder = false
): FeedbackItem[] {
  const opt = { ...defaultAssembleOptions, ...options }
  const namer = new ImageNamer(opt.imageExt)

  return (keepOrder ? [...pending] : [...pending].sort((a, b) => a.t - b.t))
    .map((it, i) => {
      const ctxTime = it.frameTimes[0] ?? it.t
      return {
        id: it.id,
        index: i + 1,
        t: it.t,
        title: it.title,
        request: it.request,
        status: it.status,
        quotes: it.quotes,
        images: it.frameTimes.map((ft) => namer.nameFor(ft)),
        frameTimes: it.frameTimes,
        contextTime: ctxTime,
        context: buildItemContext(events, ctxTime, it.annotationIds),
        annotationIds: it.annotationIds,
        draftIds: it.draftIds,
        include: it.include
      }
    })
}

/** LLM 出力 → 最終の指摘一覧 */
export function assembleFromOrganized(
  material: Material,
  output: OrganizeOutput,
  options: Partial<AssembleOptions> = {}
): FeedbackDocument {
  const opt = { ...defaultAssembleOptions, ...options }
  const cleaned = withoutMeaningless(output, material.transcript)

  const pending: PendingItem[] = cleaned.items.map(({ item: it }, i) => {
    const frameTimes = resolveFrameTimes(it.frame_times, material.frames)
    return {
      id: `i${i + 1}`,
      t: representativeTime(it.quotes, frameTimes, material.meta),
      title: it.title,
      request: it.request,
      status: it.status,
      quotes: it.quotes,
      frameTimes,
      annotationIds: it.annotation_ids,
      draftIds: [],
      include: it.status === 'decided' || opt.includeNeedsCheck
    }
  })
  const penOnly = new Set(cleaned.items.flatMap(({ penOnly }, i) => (penOnly ? [`i${i + 1}`] : [])))
  // 整理（LLM）がどの指摘にも除外にも入れなかった発話は、話したそのままの指摘として足す（黙って落とさない）
  const missed = uncoveredSpeech(material, cleaned)

  return {
    meta: material.meta,
    items: finalizeItems([...pending, ...missed.items.map((d) => draftPending(d, `i-missed-${d.id}`))], material.events, opt)
      .map((item) => (penOnly.has(item.id) ? withPenTitle(item, true) : item)),
    dropped: [...cleaned.dropped, ...missed.meaningless.map((s) => ({ t: s.t0, text: s.text, reason: meaninglessReason() }))].sort((a, b) => a.t - b.t),
    organizedByLlm: true
  }
}

/**
 * 整理の出力のどの指摘の引用にも、「除外した発話」にも入っていない発話。
 * LLM は発話を書き漏らすことがある（長い録画・検証で外した指摘・区間ごとの整理の失敗）。消えた発話は確認画面のどこにも出ず、
 * 取り戻せないので、下書きと同じ決まりで指摘にする（書き込みは整理が使ったので付け直さない。ページの区切りは操作ログから引く）
 */
export function uncoveredSpeech(material: Material, organized: { items: Array<{ item: { quotes: Quote[] } }>; dropped: Array<{ t: number }> }):
  { items: DraftItem[]; meaningless: TranscriptSegment[] } {
  const covered = new Set<number>([...organized.items.flatMap(({ item }) => item.quotes.map((q) => q.t)), ...organized.dropped.map((d) => d.t)])
  const missed = material.transcript.filter((s) => !covered.has(s.t0))
  if (missed.length === 0) return { items: [], meaningless: [] }
  const draft = buildDraft({ ...material, transcript: missed, events: material.events.filter((e) => !isAnnotation(e)) })
  return { items: draft.items.filter((d) => d.segments.length > 0), meaningless: draft.meaningless ?? [] }
}

/** 「除外した発話」に付ける理由（意味の通じない発話） */
function meaninglessReason(): string {
  return t('review.droppedMeaningless')
}

/**
 * 整理（LLM）の出力からも、意味の通じない発話（meaningless.ts）を外す。下書き（draft.ts）と同じ決まり:
 * - 意味の無い引用は外す（書き込みのある指摘の返事「はい」「OK」は残す）
 * - 引用が残らず書き込みも無い指摘は消し、その発話を「除外した発話」へ入れる
 * - 引用が残らず書き込みがある指摘は残し、見出しは囲んだ要素・要望は空にする（書き込みだけの指摘と同じ。penOnly）
 * - 見出し・要望そのものが意味の無い文なら、残った引用から作り直す
 * - どの指摘にも除外にも入っていない意味の無い発話も「除外した発話」へ入れる（戻せるように）
 */
function withoutMeaningless(output: OrganizeOutput, transcript: TranscriptSegment[]): {
  items: Array<{ item: OrganizeOutput['items'][number]; penOnly: boolean }>
  dropped: OrganizeOutput['dropped']
} {
  const removed: Quote[] = []
  const items: Array<{ item: OrganizeOutput['items'][number]; penOnly: boolean }> = []
  for (const it of output.items) {
    const hasAnnotation = it.annotation_ids.length > 0
    const quotes = it.quotes.filter((q) => !isMeaninglessUtterance(q.text, { hasAnnotation }))
    removed.push(...it.quotes.filter((q) => !quotes.includes(q)))
    const titleMeaningless = isMeaninglessUtterance(it.title, { hasAnnotation })
    const requestMeaningless = isMeaninglessUtterance(it.request, { hasAnnotation }) && it.request.trim() !== ''
    if (quotes.length === 0) {
      // 引用の無い書き込みだけの指摘は、もともとの形（見出し・要望は整理のまま）。意味の無い引用を外して空になったものだけ直す
      if (!hasAnnotation) continue
      const emptied = it.quotes.length > 0
      if (!emptied && !titleMeaningless && !requestMeaningless) { items.push({ item: it, penOnly: false }); continue }
      items.push({ item: { ...it, quotes: [], request: emptied || requestMeaningless ? '' : it.request }, penOnly: emptied || titleMeaningless })
      continue
    }
    if (quotes.length === it.quotes.length && !titleMeaningless && !requestMeaningless) { items.push({ item: it, penOnly: false }); continue }
    const spoken = quotes.map((q) => q.text.trim()).join(' ').trim()
    items.push({
      item: {
        ...it,
        quotes,
        title: titleMeaningless ? truncate(spoken, 60) : it.title,
        request: requestMeaningless ? spoken : it.request
      },
      penOnly: false
    })
  }

  const quoted = new Set(items.flatMap(({ item }) => item.quotes.map((q) => q.t)))
  const dropped = [...output.dropped]
  const seen = new Set(dropped.map((d) => d.t))
  const add = (t: number, text: string) => {
    if (quoted.has(t) || seen.has(t)) return
    seen.add(t)
    dropped.push({ t, text, reason: meaninglessReason() })
  }
  for (const q of removed) add(q.t, q.text)
  for (const s of transcript) if (isMeaninglessUtterance(s.text, { hasAnnotation: true })) add(s.t0, s.text)
  dropped.sort((a, b) => a.t - b.t)
  return { items, dropped }
}

/** 下書きのまま（LLM未設定・失敗・タイムアウト時のフォールバック。EXT-11） */
export function assembleFromDraft(
  material: Material,
  draft: DraftItem[],
  options: Partial<AssembleOptions> = {},
  /** 指摘にしなかった意味の通じない発話（Draft.meaningless）。「除外した発話」に入れ、確認画面から戻せるようにする */
  meaningless: TranscriptSegment[] = []
): FeedbackDocument {
  const opt = { ...defaultAssembleOptions, ...options }

  const pending: PendingItem[] = draft.map((d) => draftPending(d, `i-${d.id}`))

  return {
    meta: material.meta,
    // 話していないペンだけの指摘は、囲んだ要素を見出しにする（どこを囲んだかが一目で分かる）
    items: finalizeItems(pending, material.events, opt).map((item) => (item.quotes.length > 0 ? item : withPenTitle(item, false))),
    dropped: meaningless.map((s) => ({ t: s.t0, text: s.text, reason: meaninglessReason() })),
    organizedByLlm: false
  }
}

/** FeedbackItem を編集できる形へ戻す（確認画面の編集で使う） */
export function toPending(item: FeedbackItem): PendingItem {
  return {
    id: item.id,
    t: item.t,
    title: item.title,
    request: item.request,
    status: item.status,
    quotes: item.quotes,
    frameTimes: item.frameTimes,
    annotationIds: item.annotationIds,
    draftIds: item.draftIds,
    include: item.include
  }
}

/**
 * 話していないペンだけの指摘の見出し: 囲んだ要素（の文字。伏せる要素ならセレクタ）。
 * 要素が分からなければ、fallback のときだけ「ペンで囲んだ箇所」にする（下書きは draftTitle が既に付けている）
 */
function withPenTitle(item: FeedbackItem, fallback: boolean): FeedbackItem {
  const element = item.context.element
  if (!element) return fallback ? { ...item, title: t('review.penFallbackTitle') } : item
  const text = !element.sensitive ? element.text?.replace(/\s+/g, ' ').trim() : ''
  return { ...item, title: t('review.penTitleAt', { target: text ? `“${truncate(text, 40)}”` : element.selector }) }
}

/** 下書きのまとまり1つを、話したそのままの指摘にする */
function draftPending(d: DraftItem, id: string): PendingItem {
  return {
    id,
    t: d.t,
    // 見出し・要望は作れないので、発話原文をそのまま使う（要望が空だと何を直すのか分からないので、話した全文を入れる）
    title: draftTitle(d),
    request: spokenText(d),
    // 文字起こしに失敗した区間だけの指摘は、話した言葉が分からない。一覧には出し（黙って捨てない）、要確認にして送る対象からは外す
    status: onlyFailedSpeech(d) ? 'needs_check' : 'decided',
    quotes: d.segments.map((s) => ({ speaker: s.speaker, t: s.t0, text: s.text, ...(s.speakerName ? { name: s.speakerName } : {}) })),
    frameTimes: d.frameTimes,
    annotationIds: d.annotationIds,
    draftIds: [d.id],
    include: !onlyFailedSpeech(d)
  }
}

/** 発話が、文字起こしに失敗した区間（TranscriptSegment.sttFailed）だけか。書き込みがあれば、その印の指摘として送れるので含めない */
function onlyFailedSpeech(d: DraftItem): boolean {
  return d.annotationIds.length === 0 && d.segments.length > 0 && d.segments.every((s) => s.sttFailed === true)
}

function spokenText(d: DraftItem): string {
  return d.segments
    .map((s) => s.text.trim())
    .join(' ')
    .trim()
}

function draftTitle(d: DraftItem): string {
  const spoken = spokenText(d)
  if (spoken) return truncate(spoken, 60)
  // ペンだけの指摘
  return t('review.penFallbackTitle')
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n)}…`
}

/** LLM が返した時刻を、実在する静止画の時刻へ寄せる */
function resolveFrameTimes(times: number[], frames: FrameRef[]): number[] {
  const out: number[] = []
  for (const t of times) {
    const exact = frames.find((f) => f.t === t)
    const resolved = exact ? exact.t : nearestFrameTime(frames, t)
    if (resolved !== undefined && !out.includes(resolved)) out.push(resolved)
  }
  return out.slice(0, 3)
}

function representativeTime(quotes: Quote[], frameTimes: number[], meta: SessionMeta): number {
  const candidates = [...quotes.map((q) => q.t), ...frameTimes].filter(
    (t) => Number.isFinite(t) && t >= 0 && t <= meta.durationMs
  )
  return candidates.length > 0 ? Math.min(...candidates) : 0
}

/** 使われた静止画の時刻に 01.png, 02.png … を割り当てる（同じ時刻は同じファイル） */
class ImageNamer {
  private readonly assigned = new Map<number, string>()
  constructor(private readonly ext: string) {}

  nameFor(t: number): string {
    const existing = this.assigned.get(t)
    if (existing) return existing
    const name = `./${String(this.assigned.size + 1).padStart(2, '0')}.${this.ext}`
    this.assigned.set(t, name)
    return name
  }
}

/**
 * 保存すべき画像の一覧（④で静止画を縮小保存するときに使う）。
 * 送信対象（include）の指摘が参照する静止画だけを返す。
 */
export function imagePlan(
  doc: FeedbackDocument,
  frames: FrameRef[]
): Array<{ name: string; frame: FrameRef; needsCursorRing: boolean }> {
  const byName = new Map<string, FrameRef>()
  for (const it of doc.items) {
    if (!it.include) continue
    for (let i = 0; i < it.images.length; i++) {
      const name = it.images[i]!
      const t = it.frameTimes[i]
      if (t === undefined || byName.has(name)) continue
      const f = frames.find((x) => x.t === t)
      if (f) byName.set(name, f)
    }
  }
  // ペンの書き込みが無い指摘の画像にはカーソルのリングを合成する（EXT-3）
  const ringTimes = new Set(
    doc.items.filter((it) => it.include && !it.context.element).flatMap((it) => it.frameTimes)
  )
  return [...byName.entries()].map(([name, frame]) => ({
    name,
    frame,
    needsCursorRing: ringTimes.has(frame.t) && frame.cursor !== undefined
  }))
}
