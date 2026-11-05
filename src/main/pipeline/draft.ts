/**
 * ② 下書き（ルール。LLMなしでも成立する最低ライン）
 * 03_design.md 5章② / 02_requirements.md EXT-2・EXT-3・EXT-11
 *
 * - 発話の間隔が2秒未満なら同じまとまりにする
 * - ペンの書き込みは、時刻が重なる（または前後3秒以内の）まとまりに付ける。該当がなければ単独の指摘
 * - 画像: 書き込みがあればその確定時刻の静止画。なければ発話開始時刻の静止画（カーソルのリングを合成）
 *   まとまりの途中でURLが変わったら変化後の静止画を追加（最大3枚）
 * - 発話もペンもない区間は捨てる
 * - 録画中に動かした書き込みは最後の位置のもの（その静止画）を使い、元に戻した書き込みは使わない
 * - 録画の途中で対象（ページ・ファイル）を切り替えたら、そこでまとまりを分ける。
 *   書き込みも同じページのまとまりにだけ付ける（指摘がそれぞれの対象に属するように）
 *
 * つなぎ言葉・独り言の除外は③のLLMの担当（設計5章③）なので、ここでは落とさない。
 * ただし意味の通じない発話（「Shh.」「ご視聴ありがとうございました」などの聞き取りの誤り、「えー」だけ、
 * 書き込みの無い「はい」だけ。meaningless.ts）は指摘にせず、Draft.meaningless に分けて「除外した発話」に入れる。
 * 書き込みに添えた意味の無い発話は外し、書き込みだけの指摘（囲んだ要素の見出し）にする。
 */
import type {
  Annotation,
  Draft,
  DraftItem,
  Event,
  FrameRef,
  Material,
  NavEvent,
  TranscriptSegment,
} from './types'
import { annotationFrameTime, isAnnotation, resolveAnnotationEdits } from './types'
import { normalizeJa } from './text'
import { activeTrackAt } from '@shared/captureTracks'
import { isMeaninglessUtterance } from './meaningless'
import { pageKey } from '@shared/page'

export interface DraftOptions {
  /** これ未満の間隔なら同じまとまり(ms) */
  speechGapMs: number;
  /**
   * 1つのまとまりの長さの上限(ms)。超えたら内部の最も大きい間隔で割る。
   *
   * 2人のMTGでは掛け合いの間隔が2秒を切り続けるため、間隔の規則だけでは
   * 録画全体が1つのまとまりになってしまう（実測: 8分のMTGが5件になった）。
   * 上限を入れることで、LLMが使えないときの下書きも実用的な粒度に収まる。
   */
  maxClusterMs: number;
  /** 書き込みをまとまりに紐づける許容幅(ms) */
  annotationWindowMs: number;
  /** 1指摘あたりの画像の最大枚数 */
  maxFrames: number;
  /** 正規化後これ未満の文字数で書き込みの無いまとまりは捨てる（「ん」などの取りこぼし） */
  minTextLength: number
}

export const defaultDraftOptions: DraftOptions = {
  speechGapMs: 2000,
  maxClusterMs: 30_000,
  annotationWindowMs: 3000,
  maxFrames: 3,
  minTextLength: 2,
}

interface Cluster {
  t: number
  tEnd: number
  segments: TranscriptSegment[]
  annotations: Annotation[]
  origin: 'speech' | 'annotation'
}

export function buildDraft(material: Material, options: Partial<DraftOptions> = {}): Draft {
  const opt = { ...defaultDraftOptions, ...options }
  const sorted = [...material.transcript].sort((a, b) => a.t0 - b.t0)
  // 書き込みがあっても意味の無い発話（聞き取りの誤り・つなぎ言葉）は、まとまりを作る前に外す
  // （まとまり同士をつないだり、書き込みを引き寄せたりしないように）
  const meaningless = sorted.filter((s) => isMeaninglessUtterance(s.text, { hasAnnotation: true }))
  const transcript = sorted.filter((s) => !meaningless.includes(s))
  // 録画中に動かした書き込みは最後の位置のものだけ、元に戻した書き込みは外す
  const events = resolveAnnotationEdits(material.events)
  const annotations = events.filter(isAnnotation).sort((a, b) => a.t - b.t)

  const pageOf = pageLookup(events)
  const clusters = clusterSpeech(transcript, opt.speechGapMs, pageOf).flatMap((c) =>
    splitLongCluster(c, opt.maxClusterMs),
  )
  const orphans = attachAnnotations(clusters, annotations, opt.annotationWindowMs, pageOf);

  // 書き込み単独の指摘
  for (const a of orphans) {
    clusters.push({
      t: a.t,
      tEnd: annotationFrameTime(a),
      segments: [],
      annotations: [a],
      origin: 'annotation',
    })
  }

  // 返事だけの発話（「はい」「OK」）は、書き込みの無いまとまりでは外す（指示を含まない）
  for (const c of clusters) {
    if (c.annotations.length > 0) continue
    const acks = c.segments.filter((s) => isMeaninglessUtterance(s.text, { hasAnnotation: false }))
    if (acks.length === 0) continue
    meaningless.push(...acks)
    c.segments = c.segments.filter((s) => !acks.includes(s))
    if (c.segments.length > 0) {
      c.t = c.segments[0]!.t0
      c.tEnd = c.segments.reduce((m, s) => Math.max(m, s.t1), c.t)
    }
  }

  clusters.sort((a, b) => a.t - b.t)

  const items: DraftItem[] = []
  for (const c of clusters) {
    if (c.segments.length === 0 && c.annotations.length === 0) continue
    if (c.annotations.length === 0) {
      const len = normalizeJa(c.segments.map((s) => s.text).join('')).length
      // 黙って捨てない。「除外した発話」に入れ、確認画面の「発話を指摘に戻す」で戻せるようにする
      if (len < opt.minTextLength) { meaningless.push(...c.segments); continue }
    }
    items.push({
      id: `d${items.length + 1}`,
      t: c.t,
      tEnd: c.tEnd,
      segments: c.segments,
      annotationIds: c.annotations.map((a) => a.id),
      frameTimes: pickFrameTimes(c, material.frames, events, opt.maxFrames),
      origin: c.origin,
    })
  }

  return { items, meaningless: meaningless.sort((a, b) => a.t0 - b.t0) }
}

/**
 * その時刻に開いていたページ（直前の遷移の pageKey）を返す関数。遷移が無ければ ''。
 * ハッシュのアンカーだけの移動は同じページ（page.ts）。
 */
function pageLookup(events: Event[]): (t: number) => string {
  const navs = events.filter((e): e is NavEvent => e.type === 'nav').sort((a, b) => a.t - b.t)
  // 複数の映像を録って切り替えた録画では、内蔵ブラウザ以外（ウインドウ・画面）を映していた間はそれが対象
  const tracks = events.filter((e) => e.type === 'track')
  return (t) => {
    const track = activeTrackAt(tracks, t)
    if (track?.type === 'track' && track.kind !== 'browser') return `window:${track.label}`
    let key = ''
    for (const nav of navs) {
      if (nav.t > t) break
      key = pageKey(nav.url)
    }
    return key
  }
}

function clusterSpeech(transcript: TranscriptSegment[], gapMs: number, pageOf: (t: number) => string): Cluster[] {
  const clusters: Cluster[] = []
  for (const seg of transcript) {
    const last = clusters[clusters.length - 1];
    // 間隔は「直前のまとまりの終わり」から測る。相手→自分の掛け合いも
    // 2秒未満なら1つの話題として扱い、分割・結合は③のLLMに委ねる。
    // ただし対象（ページ・ファイル）を切り替えたら、間隔が短くても別のまとまりにする
    if (last && seg.t0 - last.tEnd < gapMs && pageOf(seg.t0) === pageOf(last.t)) {
      last.segments.push(seg)
      last.tEnd = Math.max(last.tEnd, seg.t1)
    } else {
      clusters.push({ t: seg.t0, tEnd: seg.t1, segments: [seg], annotations: [], origin: 'speech' })
    }
  }
  return clusters
}

/**
 * 長すぎるまとまりを、内部で最も間隔が大きいところで割る。
 * 上限に収まるまで再帰的に割る（割れなければそのまま返す）。
 */
function splitLongCluster(c: Cluster, maxMs: number): Cluster[] {
  if (c.tEnd - c.t <= maxMs || c.segments.length < 2) return [c]

  let bestIndex = -1
  let bestGap = -1
  for (let i = 1; i < c.segments.length; i++) {
    const gap = c.segments[i]!.t0 - c.segments[i - 1]!.t1
    if (gap > bestGap) {
      bestGap = gap
      bestIndex = i
    }
  }
  if (bestIndex <= 0) return [c]

  const make = (segs: TranscriptSegment[]): Cluster => ({
    t: segs[0]!.t0,
    tEnd: segs[segs.length - 1]!.t1,
    segments: segs,
    annotations: [],
    origin: 'speech',
  })

  return [
    ...splitLongCluster(make(c.segments.slice(0, bestIndex)), maxMs),
    ...splitLongCluster(make(c.segments.slice(bestIndex)), maxMs),
  ]
}

/** 書き込みを一番近いまとまりに付ける。付かなかったものを返す */
function attachAnnotations(clusters: Cluster[], annotations: Annotation[], windowMs: number, pageOf: (t: number) => string): Annotation[] {
  const orphans: Annotation[] = []
  for (const a of annotations) {
    const aStart = a.t
    const aEnd = annotationFrameTime(a)
    const page = pageOf(aStart)
    let best: { c: Cluster; d: number } | undefined
    for (const c of clusters) {
      // 別の対象で話した内容には付けない
      if (pageOf(c.t) !== page) continue
      const d = gapBetween(aStart, aEnd, c.t, c.tEnd)
      if (d <= windowMs && (!best || d < best.d)) best = { c, d }
    }
    if (best) {
      best.c.annotations.push(a)
      best.c.tEnd = Math.max(best.c.tEnd, aEnd)
      best.c.t = Math.min(best.c.t, aStart)
    } else {
      orphans.push(a)
    }
  }
  return orphans
}

/** 2区間の隙間(ms)。重なっていれば0 */
function gapBetween(a0: number, a1: number, b0: number, b1: number): number {
  if (a1 >= b0 && b1 >= a0) return 0
  return a1 < b0 ? b0 - a1 : a0 - b1
}

function pickFrameTimes(c: Cluster, frames: FrameRef[], events: Event[], maxFrames: number): number[] {
  const out: number[] = []
  const push = (t: number | undefined) => {
    if (t === undefined) return
    if (!out.includes(t) && out.length < maxFrames) out.push(t)
  }

  if (c.annotations.length > 0) {
    // 書き込みの確定時刻（ペン=描き終わり、テキスト=設置時刻）
    for (const a of [...c.annotations].sort((x, y) => annotationFrameTime(x) - annotationFrameTime(y))) {
      const associated = frames.find((f) => f.annotationId === a.id)
      push(associated?.t ?? nearestFrameTime(frames, annotationFrameTime(a)))
    }
  } else {
    // 話しただけの指摘は、ほぼ一色の画像（読み込み途中のページなど）を避ける。中身のある画像が無ければそのまま
    const filled = frames.filter((f) => !f.blank)
    push(nearestFrameTime(filled.length > 0 ? filled : frames, c.t))
  }

  // まとまりの途中でURL・映していたもの（track）が変わったら、変化後の静止画を足す
  const navs = events.filter((e) => (e.type === 'nav' || e.type === 'track') && e.t > c.t && e.t <= c.tEnd)
  for (const n of navs) push(nearestFrameTimeAfter(frames, n.t));

  return out.sort((a, b) => a - b)
}

/** 指定時刻に最も近い静止画の時刻。同距離なら後ろ（書き込みが写っている側）を選ぶ */
export function nearestFrameTime(frames: FrameRef[], t: number): number | undefined {
  let best: FrameRef | undefined
  let bestD = Infinity
  for (const f of frames) {
    const d = Math.abs(f.t - t)
    if (d < bestD || (d === bestD && best && f.t > best.t)) {
      best = f
      bestD = d
    }
  }
  return best?.t
}

/** 指定時刻以降で最初の静止画の時刻。無ければ undefined */
export function nearestFrameTimeAfter(frames: FrameRef[], t: number): number | undefined {
  let best: FrameRef | undefined
  for (const f of frames) {
    if (f.t < t) continue
    if (!best || f.t < best.t) best = f
  }
  return best?.t
}
