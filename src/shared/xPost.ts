/**
 * X（旧Twitter）へ投稿する文面の下ごしらえ。エディタの文章から投稿文を作り、X の数え方で長さを測り、
 * 長ければスレッド用に分け、X の投稿画面（https://x.com/intent/post）を本文入りで開く URL を作る。
 *
 * - X の API（従量課金・キーが要る）は使わない。投稿画面を内蔵ブラウザで開き、利用者が「ポスト」を押す
 * - 長さは twitter-text の v3 の数え方に合わせる（Unicode の一部の範囲は1、ほかは2、URL は23、絵文字は2。上限は280）。
 *   URL は http(s):// で始まるものと www. で始まるものだけを URL とみなす（ドメインだけの書き方は文字として数える＝多めに出る側）
 */

/** 1件の投稿の上限（重み付きの長さ） */
export const X_MAX_WEIGHT = 280
/** URL は長さによらずこの長さで数える */
export const X_URL_WEIGHT = 23
/** 分けるときの件数の上限（超える分は出さず、overflow で知らせる） */
export const X_MAX_PARTS = 25

/** 重み1で数える範囲（twitter-text v3） */
const LIGHT_RANGES: ReadonlyArray<readonly [number, number]> = [[0, 4351], [8192, 8205], [8208, 8223], [8242, 8247]]

const URL_PATTERN = /(?:https?:\/\/|www\.)[^\s<>"'「」『』（）、。]+/giu
const PICTOGRAPHIC = /\p{Extended_Pictographic}|\p{Regional_Indicator}/u

function codePointWeight(cp: number): number {
  return LIGHT_RANGES.some(([lo, hi]) => cp >= lo && cp <= hi) ? 1 : 2
}

const segmenter = typeof Intl !== 'undefined' && 'Segmenter' in Intl ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null

function graphemes(text: string): string[] {
  return segmenter ? Array.from(segmenter.segment(text), (s) => s.segment) : Array.from(text)
}

function plainWeight(text: string): number {
  let weight = 0
  for (const g of graphemes(text)) {
    // 絵文字は肌の色・ZWJ でつないだものも含めて1つで2
    if (PICTOGRAPHIC.test(g)) { weight += 2; continue }
    for (const ch of g) weight += codePointWeight(ch.codePointAt(0) ?? 0)
  }
  return weight
}

/** X の数え方での長さ */
export function xWeightedLength(raw: string): number {
  const text = raw.normalize('NFC')
  let weight = 0
  let last = 0
  for (const m of text.matchAll(URL_PATTERN)) {
    const index = m.index ?? 0
    weight += plainWeight(text.slice(last, index)) + X_URL_WEIGHT
    last = index + m[0].length
  }
  return weight + plainWeight(text.slice(last))
}

/** Markdown を、投稿にそのまま使える平文にする（見出し・強調・リンクの記号を外す） */
export function markdownToPostText(markdown: string): string {
  let text = markdown.replace(/\r\n?/g, '\n')
  // 先頭の YAML（front matter）
  text = text.replace(/^---\n[\s\S]*?\n---(?:\n|$)/, '')
  // HTML のコメントは、外した後に新しくできる <!-- も残さないよう、変わらなくなるまで外す
  let previous: string
  do {
    previous = text
    text = text.replace(/<!--[\s\S]*?-->/g, '')
  } while (text !== previous)
  // README などに混ざる HTML。<br> と段落の終わりは改行にし、ほかのタグは外して中の文字だけ残す（同じく変わらなくなるまで）
  text = text.replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|li|h[1-6])>/gi, '\n')
  do {
    previous = text
    text = text.replace(/<\/?[a-z][^<>]*>/gi, '')
  } while (text !== previous)
  // コードブロックは囲みの行だけ外す
  text = text.replace(/^(```|~~~)[^\n]*\n?/gm, '')
  const lines = text.split('\n').map((line) => line
    .replace(/^\s{0,3}#{1,6}\s+/, '')
    .replace(/^\s{0,3}>\s?/, '')
    .replace(/^(\s*)[-*+]\s+\[[ xX]\]\s+/, '$1・')
    .replace(/^(\s*)[-*+]\s+/, '$1・')
    .replace(/^\s{0,3}([-*_])(\s*\1){2,}\s*$/, ''))
  text = lines.join('\n')
  text = text
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (_, label: string, url: string) => (label.trim() === url ? url : `${label} ${url}`))
    .replace(/\*\*([^*\n]+)\*\*/g, '$1')
    .replace(/__([^_\n]+)__/g, '$1')
    // 斜体は CommonMark と同じく * の内側が空白でないものだけ（2 * 3 * 4 を崩さない）
    .replace(/(^|[^*\w])\*(?=\S)([^*\n]*?\S)\*(?!\*)/g, '$1$2')
    .replace(/~~([^~\n]+)~~/g, '$1')
    .replace(/`([^`\n]+)`/g, '$1')
  return text.replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n').trim()
}

/** 文の切れ目（句点・感嘆符・疑問符・改行の後）で分ける。区切りは前の文に残す */
function sentences(paragraph: string): string[] {
  const parts = paragraph.match(/[^。！？!?\n]*(?:[。！？!?]+[」』）)]*|\n|$)\s*/gu) ?? [paragraph]
  return parts.filter((p) => p.length > 0)
}

/** 1文が上限を超えるときは、文字（書記素）の単位で切る */
function hardSplit(text: string, max: number): string[] {
  const out: string[] = []
  let current = ''
  for (const g of graphemes(text)) {
    if (current && xWeightedLength(current + g) > max) { out.push(current); current = '' }
    current += g
  }
  if (current) out.push(current)
  return out
}

/** 足して上限に収まるだけ詰める */
function pack(pieces: readonly string[], joiner: string, max: number): string[] {
  const out: string[] = []
  let current = ''
  for (const piece of pieces) {
    const next = current ? current + joiner + piece : piece
    if (xWeightedLength(next) <= max) { current = next; continue }
    if (current) out.push(current)
    current = piece
  }
  if (current) out.push(current)
  return out
}

/**
 * 投稿文をスレッドの各投稿に分ける。段落 → 文 → 文字の順で切れ目を探し、どれも上限（既定は280）以下にする。
 * 空の投稿は作らない。件数は X_MAX_PARTS まで（超えたら残りは出さず overflow を true にする）
 */
export function splitForThread(raw: string, max: number = X_MAX_WEIGHT): { parts: string[]; overflow: boolean } {
  const text = raw.normalize('NFC').trim()
  if (!text) return { parts: [], overflow: false }
  if (xWeightedLength(text) <= max) return { parts: [text], overflow: false }
  const pieces = text.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean).flatMap((paragraph) => {
    if (xWeightedLength(paragraph) <= max) return [paragraph]
    const fitted = sentences(paragraph).map((s) => s.trim()).filter(Boolean)
      .flatMap((s) => (xWeightedLength(s) <= max ? [s] : hardSplit(s, max)))
    return pack(fitted, '', max).map((p) => p.trim())
  })
  const parts = pack(pieces, '\n\n', max)
  return parts.length > X_MAX_PARTS ? { parts: parts.slice(0, X_MAX_PARTS), overflow: true } : { parts, overflow: false }
}

/** X の投稿画面を本文入りで開く URL */
export function xIntentUrl(text: string): string {
  return `https://x.com/intent/post?text=${encodeURIComponent(text.normalize('NFC'))}`
}
