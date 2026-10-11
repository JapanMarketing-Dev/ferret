/**
 * 判定の中継が送る前に、依頼の形を確かめて、1回の呼び出しで使いうる量の上限（最悪の量）を決める（security-7 [7]）。
 *
 * 中継は枠を送る前に予約するが、依頼の本文をそのまま送ると、1回で使う量は本文しだいで決まらない
 * （大きな state・画像・知らないモデルで、残りの枠を1回で超えられた）。そこで、
 *   - 本文は System One の形（model・state・questions・images）だけを受け付け、知らない項目は断る
 *   - model は Ferret の設定のモデルに書き換える（Agent が高いモデルを選べない）
 *   - 入力のトークン数は、文字のバイト数（1トークンは1バイト以上）＋画像1枚あたりの上限＋接続先が足す分で上から押さえ、
 *     出力は質問の数で上から押さえる（System One の答えは質問ごとの短い値）
 *   - 費用は、単価を設定していればその単価、ローカル（127.0.0.1・localhost）なら 0、
 *     それ以外の単価の分からない接続先は高めの既定の単価（FALLBACK_PRICING）で見込む（費用の枠を素通りさせない）
 * 中継はこの上限をまるごと予約してから送り、収まらなければ送らずに断る。
 *
 * Electron に依存させない（純粋な関数。単体テストの対象）。
 */
import type { DecisionPricing } from '@shared/decision'
import { isRecord } from '@shared/guards'

export const DECISION_REQUEST_LIMITS = {
  /** 質問の数 */
  questions: 32,
  /** 質問の鍵・種類の長さ */
  questionKeyChars: 100,
  /** 質問の指示の長さ */
  instructionChars: 4000,
  /** 質問の答えの決め方（criteria。答えの値 → 説明）の数と、説明の長さ */
  criteria: 32,
  criterionChars: 2000,
  /** state のバイト数 */
  stateBytes: 256 * 1024,
  /** 画像の枚数（BEFORE / AFTER の2枚。余裕を見て4枚） */
  images: 4,
  /** 画像1枚の文字数（base64 / data URI） */
  imageChars: 12 * 1024 * 1024
} as const

/** 画像1枚が使いうる入力のトークン数（接続先が縮めて読む。大きく見積もる） */
export const IMAGE_TOKEN_BOUND = 6_000
/** 接続先が依頼に足す指示などの分 */
export const INPUT_OVERHEAD_TOKENS = 4_096
/** 質問1つの答えに使いうる出力のトークン数と、答え全体の分 */
export const OUTPUT_TOKENS_PER_QUESTION = 256
export const OUTPUT_OVERHEAD_TOKENS = 512
/** 単価の分からない（ローカルでない）接続先の費用の見込み（1M トークンあたりの USD。高めにとる） */
export const FALLBACK_PRICING = { inputPer1M: 3, outputPer1M: 15 } as const

const TOP_LEVEL_KEYS = new Set(['model', 'state', 'questions', 'images'])

export type DecisionRequestCheck =
  | { ok: true; body: Buffer; inputTokens: number; outputTokens: number; images: number }
  | { ok: false; message: string }


/** 依頼の本文を確かめ、model を設定のものにした本文と、トークン数の上限を返す */
export function checkDecisionRequest(raw: Buffer, model: string): DecisionRequestCheck {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw.toString('utf8'))
  } catch {
    return { ok: false, message: 'The request body must be JSON with model, state and questions.' }
  }
  if (!isRecord(parsed)) return { ok: false, message: 'The request body must be a JSON object.' }
  const extra = Object.keys(parsed).filter((k) => !TOP_LEVEL_KEYS.has(k))
  if (extra.length > 0) return { ok: false, message: 'Only model, state, questions and images are accepted.' }
  const L = DECISION_REQUEST_LIMITS
  const state = parsed.state
  if (typeof state !== 'string') return { ok: false, message: 'state must be a string.' }
  const stateBytes = Buffer.byteLength(state, 'utf8')
  if (stateBytes > L.stateBytes) return { ok: false, message: `state is larger than ${L.stateBytes / 1024}KB.` }
  const questions = parsed.questions
  if (!isRecord(questions)) return { ok: false, message: 'questions must be an object.' }
  const entries = Object.entries(questions)
  if (entries.length === 0 || entries.length > L.questions) return { ok: false, message: `Send 1 to ${L.questions} questions.` }
  let questionBytes = 0
  for (const [key, q] of entries) {
    if (key.length > L.questionKeyChars || !isRecord(q)) return { ok: false, message: 'Each question must be an object with type and instructions.' }
    const keys = Object.keys(q)
    if (keys.some((k) => k !== 'type' && k !== 'instructions' && k !== 'criteria')) return { ok: false, message: 'A question accepts only type, instructions and criteria.' }
    if (typeof q.type !== 'string' || q.type.length > L.questionKeyChars) return { ok: false, message: 'Each question needs a type.' }
    if (q.instructions !== undefined && (typeof q.instructions !== 'string' || q.instructions.length > L.instructionChars)) {
      return { ok: false, message: `instructions must be a string of up to ${L.instructionChars} characters.` }
    }
    if (q.criteria !== undefined) {
      if (!isRecord(q.criteria)) return { ok: false, message: 'criteria must be an object of answer → description.' }
      const criteria = Object.entries(q.criteria)
      if (criteria.length > L.criteria || criteria.some(([k, v]) => k.length > L.questionKeyChars || typeof v !== 'string' || v.length > L.criterionChars)) {
        return { ok: false, message: `criteria accepts up to ${L.criteria} answers with descriptions of up to ${L.criterionChars} characters.` }
      }
      for (const [k, v] of criteria) questionBytes += Buffer.byteLength(k) + Buffer.byteLength(v as string)
    }
    questionBytes += Buffer.byteLength(key) + Buffer.byteLength(q.type) + Buffer.byteLength(typeof q.instructions === 'string' ? q.instructions : '')
  }
  let images = 0
  if (parsed.images !== undefined) {
    if (!Array.isArray(parsed.images) || parsed.images.length > L.images) return { ok: false, message: `images must be a list of up to ${L.images}.` }
    if (parsed.images.some((img) => typeof img !== 'string' || img.length > L.imageChars)) return { ok: false, message: 'Each image must be a base64 string.' }
    images = parsed.images.length
  }
  const body = Buffer.from(JSON.stringify({ ...parsed, model }), 'utf8')
  return {
    ok: true,
    body,
    // 1トークンは1バイト以上なので、バイト数は文字のトークン数の上限になる
    inputTokens: stateBytes + questionBytes + images * IMAGE_TOKEN_BOUND + INPUT_OVERHEAD_TOKENS,
    outputTokens: entries.length * OUTPUT_TOKENS_PER_QUESTION + OUTPUT_OVERHEAD_TOKENS,
    images
  }
}

/** ローカルの接続先（Ollama など。費用はかからない） */
export function isLocalEndpoint(url: string): boolean {
  try {
    const host = new URL(url).hostname.replace(/^\[|\]$/g, '').toLowerCase()
    return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host.endsWith('.localhost')
  } catch {
    return false
  }
}

/** 費用の見込みに使う単価。設定した単価 > ローカルは 0 > 高めの既定 */
export function budgetPricing(url: string, pricing: DecisionPricing | undefined): { inputPer1M: number; outputPer1M: number } {
  if (pricing && (pricing.inputPer1M !== undefined || pricing.outputPer1M !== undefined)) {
    return { inputPer1M: pricing.inputPer1M ?? FALLBACK_PRICING.inputPer1M, outputPer1M: pricing.outputPer1M ?? FALLBACK_PRICING.outputPer1M }
  }
  return isLocalEndpoint(url) ? { inputPer1M: 0, outputPer1M: 0 } : FALLBACK_PRICING
}

export function costOf(tokens: { input: number; output: number }, price: { inputPer1M: number; outputPer1M: number }): number {
  return (tokens.input * price.inputPer1M + tokens.output * price.outputPer1M) / 1_000_000
}
