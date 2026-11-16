import type { ProviderRateLimits } from '@shared/usage'
import type { AccountAgent } from '@shared/types'

/**
 * 取り直す頻度と、失敗したときに何を見せるか（副作用のない部分）。
 *
 * Orca由来: ~/bench/orca/src/main/rate-limits/service/service-types.ts（間隔の定数）,
 *           ~/bench/orca/src/main/rate-limits/service/service-polling.ts（getActiveWindowRefreshPlan）,
 *           ~/bench/orca/src/main/rate-limits/service/service-result-policy.ts（applyStalePolicy / withFetchingStatus）,
 *           ~/bench/orca/src/main/rate-limits/service/service-fetch-policy.ts（isRetryAfterActive）（MIT, Copyright 2026 Lovecast Inc.）
 */

/** 裏での定期取得の間隔（15分） */
export const DEFAULT_POLL_MS = 15 * 60 * 1000
/** 窓を前に出した・再読み込みを押したときの連打よけ（5分） */
export const MIN_REFETCH_MS = 5 * 60 * 1000
/** 失敗したプロバイダの再試行の最短間隔（30秒）。続けて失敗するたびに倍にし、15分で止める */
const ACTIVE_FAILURE_REFETCH_MS = 30 * 1000
const MAX_ACTIVE_FAILURE_REFETCH_MS = DEFAULT_POLL_MS
export const MAX_ACTIVE_FAILURE_STREAK = 6
/** これより古い成功値は、失敗時にも見せない（30分。取得制限中は24時間） */
export const STALE_THRESHOLD_MS = 30 * 60 * 1000
const RATE_LIMITED_STALE_THRESHOLD_MS = 24 * 60 * 60 * 1000
/** アカウント別の内訳を開いたときの取り直しの間隔（60秒） */
export const INACTIVE_FETCH_DEBOUNCE_MS = 60 * 1000

export function isRetryAfterActive(limits: ProviderRateLimits | null, now: number = Date.now()): boolean {
  return Boolean(limits?.retryAtMs && limits.retryAtMs > now)
}

function hasData(p: ProviderRateLimits | null): boolean {
  return Boolean(p?.session || p?.weekly || p?.fableWeekly || p?.spendLimit || p?.unlimited)
}

/**
 * 新しい結果を、画面に出す値にする。
 * 失敗しても直前の成功値が新しければそれを残し、状態だけ error にする（バーが空と値を行き来しないように）。
 */
export function applyStalePolicy(fresh: ProviderRateLimits, previous: ProviderRateLimits | null, now: number = Date.now()): ProviderRateLimits {
  if (fresh.status === 'ok' || fresh.status === 'unavailable') return fresh
  if (!previous || !hasData(previous)) return fresh
  const threshold = fresh.failureKind === 'rate-limited' ? RATE_LIMITED_STALE_THRESHOLD_MS : STALE_THRESHOLD_MS
  if (now - previous.updatedAt > threshold) return fresh
  return { ...previous, error: fresh.error, status: 'error', failureKind: fresh.failureKind, retryAtMs: fresh.retryAtMs }
}

/** 取得中の表示。値が出ているあいだは出したまま（毎回「…」に戻さない） */
export function withFetchingStatus(current: ProviderRateLimits | null, provider: AccountAgent): ProviderRateLimits {
  if (!current) return { provider, session: null, weekly: null, updatedAt: 0, error: null, status: 'fetching' }
  if (current.status === 'ok' || current.status === 'error' || current.status === 'unavailable') return current
  return { ...current, status: 'fetching' }
}

/** 失敗が続いた回数から、次に再試行してよい間隔 */
export function failureRetryDelayMs(streak: number): number {
  return Math.min(ACTIVE_FAILURE_REFETCH_MS * 2 ** Math.max(0, streak - 1), MAX_ACTIVE_FAILURE_REFETCH_MS)
}

/**
 * 窓が前に出たときに、どのプロバイダを取り直すか。
 * - まだ値が無い・成功から5分たった → 取り直す
 * - 失敗している → Retry-After の間は待ち、それ以外は失敗回数に応じた間隔で取り直す
 */
export function providersToRefresh(options: {
  state: Record<AccountAgent, ProviderRateLimits | null>
  lastFailureRetryAt: Record<AccountAgent, number>
  failureStreak: Record<AccountAgent, number>
  now?: number
}): AccountAgent[] {
  const now = options.now ?? Date.now()
  return (Object.keys(options.state) as AccountAgent[]).filter((provider) => {
    const limits = options.state[provider]
    if (!limits || limits.status === 'idle') return true
    if (limits.status === 'fetching') return false
    if (limits.status === 'ok' || limits.status === 'unavailable') return now - limits.updatedAt >= MIN_REFETCH_MS
    if (isRetryAfterActive(limits, now)) return false
    return now - options.lastFailureRetryAt[provider] >= failureRetryDelayMs(options.failureStreak[provider])
  })
}

/**
 * 失敗したあと、自動でもう一度取りに行くまでの間隔。取りに行かないときは null。
 * 1度の失敗（起動直後の回線の揺れなど）がそのまま残らないよう、間隔を空けて静かに再試行する。
 * ただし、再試行しても直らないもの・OS の確認を出しうるものは、手動の再読み込みだけにする：
 *   keychain-unavailable … 自動で Keychain を読みに行くと確認のダイアログが出うる
 *   missing-credentials / stale-token … ログインし直すまで直らない
 * 取得制限（rate-limited）は、相手の Retry-After より前には行かない。
 */
export function failureRetryAfterMs(p: ProviderRateLimits, streak: number, now: number = Date.now()): number | null {
  if (p.status !== 'error') return null
  if (p.failureKind === 'keychain-unavailable' || p.failureKind === 'missing-credentials' || p.failureKind === 'stale-token' || p.failureKind === 'not-allowed') return null
  const delay = failureRetryDelayMs(streak)
  return p.retryAtMs && p.retryAtMs > now ? Math.max(delay, p.retryAtMs - now) : delay
}
