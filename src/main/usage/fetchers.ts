import type { ProviderRateLimits, RateLimitWindow, UsageFailureKind } from '@shared/usage'
import type { AccountAgent } from '@shared/types'
import { readClaudeAccessToken, readCodexAccessToken } from './credentials'
import { t } from '@shared/i18n'
import { errorKind, reportHandled } from '@shared/report'
import { ResponseTooLargeError, SMALL_JSON_MAX_BYTES, readBoundedJson } from '../boundedResponse'

/**
 * Claude / Codex の使用量を、それぞれの公式のエンドポイントから読む。
 *
 * Orca由来: ~/bench/orca/src/main/rate-limits/claude-oauth-usage-request.ts,
 *           ~/bench/orca/src/main/rate-limits/claude-oauth-usage-error.ts,
 *           ~/bench/orca/src/main/rate-limits/claude-usage-window.ts,
 *           ~/bench/orca/src/main/rate-limits/codex-backend-usage-client.ts,
 *           ~/bench/orca/src/main/rate-limits/codex-rate-limit-window-classification.ts,
 *           ~/bench/orca/src/main/rate-limits/codex-rate-limit-window-mapper.ts（MIT, Copyright 2026 Lovecast Inc.）
 *
 * Orca は失敗時に Claude Code を隠しPTYで起動して /usage を読む・Codex は app-server の RPC を先に試す、
 * といった代替経路を持つが、本システムは HTTP の1経路だけにした（子プロセスを増やさないため）。
 */

export type UsageRequest = (url: string, init: RequestInit) => Promise<Response>

const API_TIMEOUT_MS = 10_000
/** 壊れた Retry-After で何日も止まらないようにする上限 */
const MAX_RETRY_AFTER_MS = 24 * 60 * 60 * 1000

const CLAUDE_USAGE_URL = 'https://api.anthropic.com/api/oauth/usage'
const CODEX_USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage'

const SESSION_MINUTES = 300
const WEEKLY_MINUTES = 10080

function failure(provider: AccountAgent, failureKind: UsageFailureKind, error: string, retryAtMs?: number): ProviderRateLimits {
  return {
    provider,
    session: null,
    weekly: null,
    updatedAt: Date.now(),
    error,
    status: 'error',
    failureKind,
    ...(retryAtMs ? { retryAtMs } : {})
  }
}

function parseRetryAfterMs(header: string | null): number | null {
  if (!header) return null
  const seconds = Number(header)
  if (Number.isFinite(seconds)) return seconds > 0 ? Math.min(seconds * 1000, MAX_RETRY_AFTER_MS) : null
  const dateMs = Date.parse(header)
  if (!Number.isFinite(dateMs)) return null
  const delta = dateMs - Date.now()
  return delta > 0 ? Math.min(delta, MAX_RETRY_AFTER_MS) : null
}

/** HTTP の失敗を、利用者向けの文と種類にする（本文は読まない。トークンを含む可能性があるため） */
function httpFailure(provider: AccountAgent, response: Response): ProviderRateLimits {
  const name = provider === 'claude' ? 'Claude' : 'Codex'
  if (response.status === 429) {
    const retry = parseRetryAfterMs(response.headers.get('retry-after'))
    return failure(provider, 'rate-limited', t('usage.errors.rateLimited', { name }), retry ? Date.now() + retry : undefined)
  }
  if (response.status === 401 || response.status === 403) {
    return failure(provider, 'stale-token', t('usage.errors.staleToken', { name }))
  }
  return failure(provider, response.status >= 500 ? 'server' : 'unknown', t('usage.errors.http', { name, status: response.status }))
}

function networkFailure(provider: AccountAgent): ProviderRateLimits {
  return failure(provider, 'network', t('usage.errors.network', { name: provider === 'claude' ? 'Claude' : 'Codex' }))
}

/**
 * 応答の本文を読む。読む途中で切れた・時間切れ（AbortSignal.timeout は本文の読み込みにも効く）は通信の失敗で、応答の形の変化ではない。
 * 形の変化として送っていた（Sentry FERRET-23: 'parse codex usage' の AbortError）。JSON として読めない・大きすぎるものだけを形の失敗にする
 */
export async function readUsageBody(response: Response): Promise<{ failed: false; json: unknown } | { failed: 'network' } | { failed: 'format'; err: unknown }> {
  try {
    return { failed: false, json: await readBoundedJson(response, SMALL_JSON_MAX_BYTES) }
  } catch (err) {
    if (err instanceof SyntaxError || err instanceof ResponseTooLargeError) return { failed: 'format', err }
    return { failed: 'network' }
  }
}

// ───────────────────────── Claude ─────────────────────────

type ClaudeUsageWindowInput = { utilization?: number; used_percentage?: number; resets_at?: string | number }

/** 秒とミリ秒のどちらでも受ける（1e10 で見分ける。Orca と同じ） */
export function parseResetTimestamp(value: string | number | undefined): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? (value > 10_000_000_000 ? value : value * 1000) : null
  if (!value) return null
  const numeric = Number(value)
  if (Number.isFinite(numeric) && value.trim() !== '') return numeric > 10_000_000_000 ? numeric : numeric * 1000
  const parsed = new Date(value).getTime()
  return Number.isNaN(parsed) ? null : parsed
}

function mapClaudeUsageWindow(raw: ClaudeUsageWindowInput | undefined, windowMinutes: number): RateLimitWindow | null {
  if (!raw) return null
  const used = typeof raw.utilization === 'number' ? raw.utilization : typeof raw.used_percentage === 'number' ? raw.used_percentage : null
  if (used === null) return null
  return { usedPercent: Math.min(100, Math.max(0, used)), windowMinutes, resetsAt: parseResetTimestamp(raw.resets_at) }
}

type ClaudeUsageResponse = {
  five_hour?: ClaudeUsageWindowInput
  seven_day?: ClaudeUsageWindowInput
  fable_weekly?: ClaudeUsageWindowInput
  fable_seven_day?: ClaudeUsageWindowInput
  seven_day_fable?: ClaudeUsageWindowInput
  limits?: Array<{ kind?: string; percent?: number; resets_at?: string | number; scope?: { model?: { display_name?: string } | null } | null }> | null
}

/** モデル別（Fable）の週の枠。新しい limits[] 形式と、古いキー名の両方を見る */
function mapClaudeFableWindow(data: ClaudeUsageResponse): RateLimitWindow | null {
  const scoped = Array.isArray(data.limits)
    ? data.limits.find(
        (l) => l?.kind === 'weekly_scoped' && Number.isFinite(l.percent) && l.scope?.model?.display_name?.trim().toLowerCase() === 'fable'
      )
    : undefined
  return (
    mapClaudeUsageWindow(scoped ? { used_percentage: scoped.percent, resets_at: scoped.resets_at } : undefined, WEEKLY_MINUTES) ??
    mapClaudeUsageWindow(data.fable_weekly, WEEKLY_MINUTES) ??
    mapClaudeUsageWindow(data.fable_seven_day, WEEKLY_MINUTES) ??
    mapClaudeUsageWindow(data.seven_day_fable, WEEKLY_MINUTES)
  )
}

export function mapClaudeUsageResponse(data: ClaudeUsageResponse): ProviderRateLimits {
  return {
    provider: 'claude',
    session: mapClaudeUsageWindow(data.five_hour, SESSION_MINUTES),
    weekly: mapClaudeUsageWindow(data.seven_day, WEEKLY_MINUTES),
    fableWeekly: mapClaudeFableWindow(data),
    updatedAt: Date.now(),
    error: null,
    status: 'ok'
  }
}

/** configDir を省略するとシステムの既定アカウント */
/** retryKeychain は手動の再読み込みのときだけ true（一度読めなかった Keychain の項目をもう一度試す） */
export async function fetchClaudeUsage(request: UsageRequest, configDir?: string, options: { retryKeychain?: boolean } = {}): Promise<ProviderRateLimits> {
  const credential = await readClaudeAccessToken(configDir, { retryBlocked: options.retryKeychain })
  if (credential.token === null) {
    return credential.reason === 'keychain-unavailable'
      ? failure('claude', 'keychain-unavailable', t('usage.errors.keychain'))
      : failure('claude', 'missing-credentials', t('usage.errors.claudeNotLoggedIn'))
  }
  let response: Response
  try {
    response = await request(CLAUDE_USAGE_URL, {
      headers: { Authorization: `Bearer ${credential.token}`, 'anthropic-beta': 'oauth-2025-04-20', 'User-Agent': 'claude-code/2.1.0' },
      signal: AbortSignal.timeout(API_TIMEOUT_MS)
    })
  } catch {
    return networkFailure('claude')
  }
  if (!response.ok) return httpFailure('claude', response)
  const body = await readUsageBody(response)
  if (body.failed === 'network') return networkFailure('claude')
  try {
    if (body.failed) throw body.err
    return mapClaudeUsageResponse(body.json as ClaudeUsageResponse)
  } catch (err) {
    // 応答の形が変わった（API の変更）。中身は送らない
    reportHandled(errorKind(err), { area: 'usage', op: 'parse claude usage' })
    return failure('claude', 'unknown', t('usage.errors.badFormat', { name: 'Claude' }))
  }
}

// ───────────────────────── Codex ─────────────────────────

type CodexBackendWindow = { used_percent?: number; limit_window_seconds?: number; reset_at?: number }
type CodexUsageResponse = {
  plan_type?: string
  rate_limit?: { primary_window?: CodexBackendWindow | null; secondary_window?: CodexBackendWindow | null } | null
  /** Business: メンバーごとの利用額の上限（Orca #8664） */
  spend_control?: { individual_limit?: { used_percent?: number } | null } | null
  /** Business の上限なし: 枠が null で credits.unlimited が true（Orca #15764） */
  credits?: { unlimited?: boolean } | null
}

function codexWindow(raw: CodexBackendWindow | null | undefined): (RateLimitWindow & { durationKnown: boolean }) | null {
  if (!raw || typeof raw.used_percent !== 'number' || !Number.isFinite(raw.used_percent)) return null
  const seconds = raw.limit_window_seconds
  const minutes = typeof seconds === 'number' && Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds / 60) : null
  return {
    usedPercent: Math.min(100, Math.max(0, raw.used_percent)),
    windowMinutes: minutes ?? 0,
    // Codex は秒で返す
    resetsAt: typeof raw.reset_at === 'number' && Number.isFinite(raw.reset_at) && raw.reset_at > 0 ? raw.reset_at * 1000 : null,
    durationKnown: minutes !== null
  }
}

/** 1分のずれまでは 5時間・週として扱う（古い Codex の値。Orca と同じ） */
function classifyMinutes(minutes: number): 'session' | 'weekly' | null {
  if (Math.abs(minutes - SESSION_MINUTES) <= 1) return 'session'
  if (Math.abs(minutes - WEEKLY_MINUTES) <= 1) return 'weekly'
  return null
}

export function mapCodexUsageResponse(payload: CodexUsageResponse): ProviderRateLimits | null {
  if (typeof payload.plan_type !== 'string') return null
  const primary = codexWindow(payload.rate_limit?.primary_window)
  const secondary = codexWindow(payload.rate_limit?.secondary_window)
  let session: RateLimitWindow | null = null
  let weekly: RateLimitWindow | null = null
  for (const w of [primary, secondary]) {
    if (!w) continue
    const kind = classifyMinutes(w.windowMinutes)
    if (kind === 'session' && !session) session = { ...w, windowMinutes: SESSION_MINUTES }
    else if (kind === 'weekly' && !weekly) weekly = { ...w, windowMinutes: WEEKLY_MINUTES }
  }
  // 長さが分からない枠は、primary を5時間・secondary を週として扱う（Orca の従来の対応）
  if (!session && primary && classifyMinutes(primary.windowMinutes) === null) session = { ...primary, windowMinutes: primary.durationKnown ? primary.windowMinutes : SESSION_MINUTES }
  if (!weekly && secondary && classifyMinutes(secondary.windowMinutes) === null) weekly = { ...secondary, windowMinutes: secondary.durationKnown ? secondary.windowMinutes : WEEKLY_MINUTES }
  const strip = (w: RateLimitWindow | null): RateLimitWindow | null => (w ? { usedPercent: w.usedPercent, windowMinutes: w.windowMinutes, resetsAt: w.resetsAt } : null)
  const spent = payload.spend_control?.individual_limit?.used_percent
  const spendLimit = typeof spent === 'number' && Number.isFinite(spent) ? { usedPercent: Math.min(100, Math.max(0, spent)), windowMinutes: 0, resetsAt: null } : null
  const unlimited = !session && !weekly && !spendLimit && payload.credits?.unlimited === true
  return {
    provider: 'codex', session: strip(session), weekly: strip(weekly),
    ...(spendLimit ? { spendLimit } : {}), ...(unlimited ? { unlimited } : {}),
    planType: payload.plan_type, updatedAt: Date.now(), error: null, status: 'ok'
  }
}

export async function fetchCodexUsage(request: UsageRequest, codexHome: string): Promise<ProviderRateLimits> {
  const credential = await readCodexAccessToken(codexHome)
  if (credential.token === null) return failure('codex', 'missing-credentials', t('usage.errors.codexNotLoggedIn'))
  const headers: Record<string, string> = {
    Authorization: `Bearer ${credential.token}`,
    'User-Agent': 'codex-cli',
    'OpenAI-Beta': 'codex-1',
    originator: 'Codex Desktop'
  }
  if (credential.accountId) headers['ChatGPT-Account-Id'] = credential.accountId
  let response: Response
  try {
    response = await request(CODEX_USAGE_URL, { headers, signal: AbortSignal.timeout(API_TIMEOUT_MS) })
  } catch {
    return networkFailure('codex')
  }
  if (!response.ok) return httpFailure('codex', response)
  const body = await readUsageBody(response)
  if (body.failed === 'network') return networkFailure('codex')
  try {
    if (body.failed) throw body.err
    return mapCodexUsageResponse(body.json as CodexUsageResponse) ?? failure('codex', 'unknown', t('usage.errors.badFormat', { name: 'Codex' }))
  } catch (err) {
    reportHandled(errorKind(err), { area: 'usage', op: 'parse codex usage' })
    return failure('codex', 'unknown', t('usage.errors.badFormat', { name: 'Codex' }))
  }
}
