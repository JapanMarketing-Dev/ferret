import { sanitizeHeaders, type AiEndpointConfig } from '@shared/aiProviders'
import { isLocalModelEndpoint } from '@shared/localModels'

/**
 * 文字起こしの接続先と費用上限の小さな判定。
 * settings.ts（起動時に読む）からも使うので、重い依存を持たせない。
 */

/** 既定の費用上限（1レビューあたりの概算, USD） */
export const DEFAULT_COST_LIMIT_USD = 1

/** 設定できる費用上限の最大(USD)。打ち間違いで青天井にならないように */
const MAX_COST_LIMIT_USD = 1000

/**
 * Base URL を `https://host[:port][/path]` の形に揃える（末尾の / と /v1、貼り付けられた
 * /v1/audio/transcriptions は落とす）。http / https 以外や壊れた URL は null。
 */
export function normalizeBaseUrl(raw: string | undefined): string | null {
  const text = (raw ?? '').trim()
  if (!text) return null
  let url: URL
  // 入力の検証。読めない URL は想定内
  try { url = new URL(text) } catch { return null }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  // URL にキーを埋め込ませない（settings.json やログに残るため）
  if (url.username || url.password) return null
  const path = url.pathname.replace(/\/+$/, '').replace(/\/v1(\/audio\/transcriptions)?$/, '').replace(/\/+$/, '')
  return `${url.protocol}//${url.host}${path}`
}

/** 予約済みの額に今回の分を足すと上限を超えるか。null（上限なし）は常に false */
export function exceedsCostLimit(reservedUsd: number, costUsd: number, limitUsd: number | null | undefined): boolean {
  if (limitUsd === null) return false
  return reservedUsd + costUsd > (limitUsd ?? DEFAULT_COST_LIMIT_USD)
}

/**
 * 接続先に使う費用の上限。端末内・LAN のサーバー（互換の whisper サーバー・LM Studio など）は費用がかからないので上限なし（null）。
 * 単価の分からない互換サーバーは高めの概算で数えるため、ローカルでも数分で「費用の上限」に当たっていた（2026-10-12 本人の指摘）
 */
export function costLimitForEndpoint(baseUrl: string | undefined, limitUsd: number | null | undefined): number | null | undefined {
  return isLocalModelEndpoint(baseUrl) ? null : limitUsd
}

/**
 * 保存された上限を直す。null は「上限なし」としてそのまま、正の数は1セント単位に丸めて最大値で抑える。
 * それ以外（0 以下・壊れた値）は undefined（既定の $1）。
 */
export function sanitizeCostLimit(raw: unknown): number | null | undefined {
  if (raw === null) return null
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) return undefined
  return Math.min(MAX_COST_LIMIT_USD, Math.max(0.01, Math.round(raw * 100) / 100))
}


/**
 * 接続先の上書き（AiEndpointConfig）を直す。壊れた値は落とす（単体テストから使うため export）。
 * - baseUrl: http / https の URL だけ。利用者が入れた形のまま（/v1 の有無も）残す
 * - model: 前後の空白を落とし 200 文字まで
 * - timeoutMs: 1秒〜10分
 * - headers: sanitizeHeaders（値は文字列か { env }。秘密のヘッダーは { env } でだけ）
 * - apiVersion: Azure の api-version（英数字・ドット・ハイフン）
 * - apiKeyEnv: キーを読む環境変数の名前。apiKey: 平文のキー（利用者が settings.json に書いたときだけ）
 * - authScheme / authHeader: 認証の形（bearer・任意のヘッダー名・なし）
 * - accountId: baseUrl の {account_id} を置き換える値（Cloudflare Workers AI）
 */
export function sanitizeEndpointConfig(raw: unknown): AiEndpointConfig | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const r = raw as Record<string, unknown>
  const out: AiEndpointConfig = {}
  if (typeof r.baseUrl === 'string' && r.baseUrl.trim() && /^https?:\/\//i.test(r.baseUrl.trim())) {
    try {
      const u = new URL(r.baseUrl.trim())
      if (!u.username && !u.password) out.baseUrl = r.baseUrl.trim().slice(0, 500)
    } catch { /* 壊れた URL は捨てる */ }
  }
  if (typeof r.model === 'string' && r.model.trim()) out.model = r.model.trim().slice(0, 200)
  if (typeof r.timeoutMs === 'number' && Number.isFinite(r.timeoutMs)) out.timeoutMs = Math.min(600_000, Math.max(1_000, Math.round(r.timeoutMs)))
  // 追加のヘッダーは3つの接続先で共通の形（src/shared/aiProviders.ts）。開発中だけあった headersEnv もここで移す
  const headers = sanitizeHeaders(r.headers, r.headersEnv)
  if (headers) out.headers = headers
  if (typeof r.apiVersion === 'string' && /^[0-9A-Za-z.-]{1,40}$/.test(r.apiVersion)) out.apiVersion = r.apiVersion
  // キーの参照（環境変数の名前）と、settings.json に書いた人だけの平文のキー（src/main/settingsKeys.ts）
  if (typeof r.apiKeyEnv === 'string' && ENV_NAME.test(r.apiKeyEnv.trim())) out.apiKeyEnv = r.apiKeyEnv.trim()
  if (typeof r.apiKey === 'string' && /^[\x21-\x7e]{1,500}$/.test(r.apiKey.trim())) out.apiKey = r.apiKey.trim()
  // 認証の形（既定はプリセットのまま）。header のときはそのヘッダー名にキーを入れる
  if (r.authScheme === 'bearer' || r.authScheme === 'header' || r.authScheme === 'none') out.authScheme = r.authScheme
  if (typeof r.authHeader === 'string' && /^[A-Za-z0-9-]{1,64}$/.test(r.authHeader.trim())) out.authHeader = r.authHeader.trim()
  // baseUrl の {account_id}（Cloudflare）を置き換える値
  if (typeof r.accountId === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(r.accountId.trim())) out.accountId = r.accountId.trim()
  return Object.keys(out).length ? out : undefined
}

/** 環境変数の名前として使える形 */
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/

/** 提供元ごとの上書きの表を直す。知らない提供元は捨てる */
export function sanitizeEndpointMap<K extends string>(raw: unknown, isKey: (k: unknown) => k is K): Partial<Record<K, ReturnType<typeof sanitizeEndpointConfig> & object>> | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const out: Partial<Record<K, ReturnType<typeof sanitizeEndpointConfig> & object>> = {}
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const cfg = isKey(k) ? sanitizeEndpointConfig(v) : undefined
    if (cfg && isKey(k)) out[k] = cfg
  }
  return Object.keys(out).length ? out : undefined
}
