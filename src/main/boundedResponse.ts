import { t } from '@shared/i18n'
import { UserFacingError } from '@shared/errors'

/**
 * 外部の応答本文を、上限のバイト数までしか読まない読み手。
 *
 * res.text() / res.json() / res.arrayBuffer() は本文を最後まで溜めるので、設定した接続先（自前サーバー・
 * 乗っ取られた提供元）が巨大な応答を返すとメモリを使い切る。時間の上限（AbortSignal.timeout）だけでは
 * バイト数は抑えられない。外部の API の応答はすべてここを通す。
 *
 * - 宣言の長さ（Content-Length）が上限を超えていれば、読む前に断る
 * - 実際に届いた量が上限を超えた時点で読むのをやめ、接続を切る（chunked で長さが無い応答も止まる）
 */

/** STT・整理・判定の応答の上限（文字起こしの JSON は語ごとの時刻を含めても数 MB に収まる） */
export const AI_RESPONSE_MAX_BYTES = 16 * 1024 * 1024
/** 失敗の応答の本文は説明に先頭を使うだけ。ここまで読んで残りは捨てる */
const ERROR_BODY_MAX_BYTES = 64 * 1024
/** 小さな JSON（更新の確認・使用量）の上限 */
export const SMALL_JSON_MAX_BYTES = 1024 * 1024

/** 応答が上限より大きかった。接続先の都合で、アプリの不具合ではないので Sentry には送らない */
export class ResponseTooLargeError extends UserFacingError {
  readonly limitBytes: number

  constructor(limitBytes: number) {
    super(t('errors.responseTooLarge', { limit: Math.max(1, Math.round(limitBytes / 1024 / 1024)) }))
    this.limitBytes = limitBytes
  }
}

/** Content-Length の値。無い・読めないときは undefined */
function declaredLength(res: Pick<Response, 'headers'>): number | undefined {
  const raw = res.headers.get('content-length')
  if (raw === null || !/^\d+$/.test(raw.trim())) return undefined
  const n = Number(raw.trim())
  return Number.isSafeInteger(n) ? n : undefined
}

async function cancelBody(res: Response): Promise<void> {
  // 読まない本文の後始末。すでに閉じていれば何もしない（想定内）
  await res.body?.cancel().catch(() => undefined)
}

/**
 * 本文を最大 maxBytes まで読む。
 * truncate が false（既定）なら、上限を超えた時点で ResponseTooLargeError を投げる。
 * true なら、上限までで打ち切って返す（失敗の本文の説明用）。
 */
export async function readBoundedBytes(res: Response, maxBytes: number, options: { truncate?: boolean } = {}): Promise<Buffer> {
  const declared = declaredLength(res)
  if (declared !== undefined && declared > maxBytes && !options.truncate) {
    await cancelBody(res)
    throw new ResponseTooLargeError(maxBytes)
  }
  if (!res.body) return Buffer.alloc(0)
  const reader = res.body.getReader()
  const chunks: Buffer[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value || value.byteLength === 0) continue
      if (total + value.byteLength > maxBytes) {
        if (!options.truncate) throw new ResponseTooLargeError(maxBytes)
        chunks.push(Buffer.from(value.buffer, value.byteOffset, maxBytes - total))
        total = maxBytes
        break
      }
      chunks.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength))
      total += value.byteLength
    }
  } finally {
    // 途中でやめたときは接続を切る（最後まで読んだときは何も起きない）
    await reader.cancel().catch(() => undefined)
  }
  return Buffer.concat(chunks, total)
}

export async function readBoundedText(res: Response, maxBytes: number): Promise<string> {
  return (await readBoundedBytes(res, maxBytes)).toString('utf8')
}

/** 上限まで読んで JSON として解釈する。JSON でなければ SyntaxError（res.json() と同じ） */
export async function readBoundedJson(res: Response, maxBytes: number = AI_RESPONSE_MAX_BYTES): Promise<unknown> {
  return JSON.parse(await readBoundedText(res, maxBytes)) as unknown
}

/**
 * JSON の本文を読み、失敗を「読み込みの失敗」と「形の失敗」に分ける。投げない。
 * 本文の途中で切れた・時間切れ（fetch の AbortSignal.timeout は本文の読み込みにも効く）は network、
 * JSON でない・上限より大きいは format。network は回線の都合なので Sentry に送らない（FERRET-23・FERRET-2K）。
 * 外部の API の JSON は res.json() ではなくこれで読む（test/unit/response-json-policy.test.ts が落とす）
 */
export type JsonBodyResult = { failed: false; json: unknown } | { failed: 'network' } | { failed: 'format'; err: unknown }

export async function readJsonBody(res: Response, maxBytes: number = AI_RESPONSE_MAX_BYTES): Promise<JsonBodyResult> {
  let text: string
  try {
    text = await readBoundedText(res, maxBytes)
  } catch (err) {
    if (err instanceof ResponseTooLargeError) return { failed: 'format', err }
    return { failed: 'network' }
  }
  try {
    return { failed: false, json: JSON.parse(text) as unknown }
  } catch (err) {
    return { failed: 'format', err }
  }
}

/** 返したのが JSON の口か（content-type が JSON か無い）。HTML などは途中のプロキシ・ログインの要る Wi-Fi の画面 */
export function isJsonContentType(res: Pick<Response, 'headers'>): boolean {
  const type = (res.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase()
  return type === '' || type === 'application/json' || type.endsWith('+json')
}

/** 失敗の応答の本文の先頭。読めなければ空文字（説明に使うだけなので想定内） */
export async function readErrorText(res: Response, maxBytes: number = ERROR_BODY_MAX_BYTES): Promise<string> {
  try {
    return (await readBoundedBytes(res, maxBytes, { truncate: true })).toString('utf8')
  } catch {
    return ''
  }
}
