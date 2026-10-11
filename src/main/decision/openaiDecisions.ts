/**
 * OpenAI の Decisions API（POST https://api.openai.com/v1/decisions）と System One の形を写し合う。
 *
 * Agent は接続先に関わらず System One の形（model・state・questions・images）で中継へ送る（feedback.md の手順）。
 * 接続先が OpenAI の Decisions API のときだけ、中継（relay.ts）と「接続を確かめる」（check.ts）がここを通して
 *   - 依頼: state → input（画像があれば input_text と input_image の user メッセージ）、questions（鍵 → 定義）→ questions（配列）
 *       noul → predicate（criteria の true / false の説明は instructions に足す）、choice → choice（criteria → choices）、
 *       score → score（criteria を並びどおりの levels に）
 *   - 応答: answers（配列）→ answers（鍵 → 答え）。predicate の probability は noul、choice は choice・confidence・probabilities
 * に写す。usage など、ほかの項目はそのまま残す（中継が回数・量を数える）。
 * 画像は data URL だけを受け付ける接続先なので、ただの base64 は先頭のバイト列から種類を見て data URL にする。
 *
 * Electron に依存させない（純粋な関数。単体テストの対象）。
 */
import { isRecord } from '@shared/guards'

export type DecisionWire = 'systemone' | 'openai-decisions'

/** 接続先の URL から形を決める（パスが /v1/decisions なら OpenAI の Decisions API。Azure などの互換の中継も同じ形） */
export function decisionWireFor(url: string): DecisionWire {
  try {
    return /\/v1\/decisions\/?$/.test(new URL(url).pathname) ? 'openai-decisions' : 'systemone'
  } catch {
    return 'systemone'
  }
}

/** OpenAI の質問の name に使える形（使えない鍵は q1, q2… にして、応答で元の鍵へ戻す） */
const SAFE_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/

export type OpenAiDecisionsRequest =
  | { ok: true; body: Record<string, unknown>; names: Record<string, string> }
  | { ok: false; message: string }

/** ただの base64 を data URL にする（PNG・JPEG・GIF・WebP を先頭で見分ける。分からなければ JPEG とする） */
export function toImageDataUrl(image: string): string {
  if (/^data:/i.test(image)) return image
  const mime = image.startsWith('iVBORw0KGgo') ? 'image/png'
    : image.startsWith('R0lGOD') ? 'image/gif'
      : image.startsWith('UklGR') ? 'image/webp'
        : 'image/jpeg'
  return `data:${mime};base64,${image}`
}

function criteriaEntries(q: Record<string, unknown>): Array<[string, string]> {
  return isRecord(q.criteria) ? Object.entries(q.criteria).filter((e): e is [string, string] => typeof e[1] === 'string') : []
}

/**
 * System One の依頼（checkDecisionRequest で形を確かめたあとのもの）を OpenAI の Decisions API の依頼にする。
 * 写せない質問の種類は断る（Agent へ 400 で理由を返す）
 */
export function toOpenAiDecisions(systemOne: Record<string, unknown>, model: string): OpenAiDecisionsRequest {
  const state = typeof systemOne.state === 'string' ? systemOne.state : ''
  const questionsIn = isRecord(systemOne.questions) ? systemOne.questions : {}
  const names: Record<string, string> = {}
  const questions: Record<string, unknown>[] = []
  let index = 0
  for (const [key, raw] of Object.entries(questionsIn)) {
    index += 1
    if (!isRecord(raw)) return { ok: false, message: 'Each question must be an object with type and instructions.' }
    const name = SAFE_NAME.test(key) && !(key in names) ? key : `q${index}`
    names[name] = key
    const instructions = typeof raw.instructions === 'string' ? raw.instructions : ''
    const criteria = criteriaEntries(raw)
    if (raw.type === 'noul') {
      // predicate には答えごとの説明の欄が無いので、instructions の後ろに足す
      const yes = criteria.find(([k]) => k === 'true')?.[1]
      const no = criteria.find(([k]) => k === 'false')?.[1]
      const extra = [yes ? `Answer true when: ${yes}` : '', no ? `Answer false when: ${no}` : ''].filter(Boolean).join('\n')
      questions.push({ type: 'predicate', name, instructions: [instructions, extra].filter(Boolean).join('\n\n') || 'Is this statement true?' })
    } else if (raw.type === 'choice') {
      if (criteria.length < 2) return { ok: false, message: `Question "${key}": a choice needs at least two answers in criteria.` }
      questions.push({ type: 'choice', name, instructions, choices: criteria.map(([value, description]) => ({ value, description })) })
    } else if (raw.type === 'score') {
      if (criteria.length < 2) return { ok: false, message: `Question "${key}": a score needs at least two levels in criteria.` }
      questions.push({ type: 'score', name, instructions, levels: criteria.map(([label, description]) => ({ label, description })) })
    } else {
      return { ok: false, message: `Question "${key}": type must be noul, choice or score for the OpenAI Decisions API.` }
    }
  }
  const images = Array.isArray(systemOne.images) ? systemOne.images.filter((img): img is string => typeof img === 'string') : []
  let input: unknown = state
  if (images.length > 0) {
    // Ferret の手順は [BEFORE, AFTER] の順で送る。2枚のときは名前を付け、ほかは番号を付ける
    const label = (i: number) => (images.length === 2 ? (i === 0 ? 'BEFORE image:' : 'AFTER image:') : `Image ${i + 1}:`)
    input = [{
      role: 'user',
      content: [
        { type: 'input_text', text: state },
        ...images.flatMap((img, i) => [{ type: 'input_text', text: label(i) }, { type: 'input_image', image_url: toImageDataUrl(img) }])
      ]
    }]
  }
  return { ok: true, body: { model, input, questions }, names }
}

/** 0〜1 の数だけ */
const prob = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1 ? v : undefined)

/** [{ value | label, probability }] を { 値: 確率 } にする */
function probabilityMap(v: unknown): Record<string, number> | undefined {
  if (!Array.isArray(v)) return undefined
  const out: Record<string, number> = {}
  for (const item of v) {
    if (!isRecord(item)) continue
    const key = typeof item.value === 'string' ? item.value : typeof item.label === 'string' ? item.label : undefined
    const p = prob(item.probability)
    if (key !== undefined && p !== undefined) out[key] = p
  }
  return Object.keys(out).length > 0 ? out : undefined
}

/**
 * OpenAI の Decisions API の応答を System One の応答（answers が 鍵 → 答え）にする。
 * answers が配列でない（エラーの本文など）なら null（呼び出し側は本文をそのまま返す）
 */
export function fromOpenAiDecisions(response: unknown, names: Record<string, string>): Record<string, unknown> | null {
  if (!isRecord(response) || !Array.isArray(response.answers)) return null
  const answers: Record<string, unknown> = {}
  for (const a of response.answers) {
    if (!isRecord(a) || typeof a.name !== 'string') continue
    const key = names[a.name] ?? a.name
    const probabilities = probabilityMap(a.probabilities)
    const confidence = prob(a.confidence)
    if (a.type === 'predicate') {
      const p = prob(a.probability)
      if (p !== undefined) answers[key] = { type: 'noul', noul: p }
    } else if (a.type === 'choice') {
      answers[key] = { type: 'choice', ...(typeof a.choice === 'string' ? { choice: a.choice } : {}), ...(confidence !== undefined ? { confidence } : {}), ...(probabilities ? { probabilities } : {}) }
    } else if (a.type === 'score') {
      answers[key] = { type: 'score', ...(typeof a.score === 'number' && Number.isFinite(a.score) ? { score: a.score } : {}), ...(confidence !== undefined ? { confidence } : {}), ...(probabilities ? { probabilities } : {}) }
    }
  }
  return { ...response, answers }
}
