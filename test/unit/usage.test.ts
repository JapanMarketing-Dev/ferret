import { describe, expect, it, vi } from 'vitest'

// fetchers は credentials → accounts/identity を読むが、electron は使わない。念のため塞いでおく
vi.mock('electron', () => ({ app: { getPath: () => '/tmp/ade-unit' } }))

import {
  formatPlanLabel,
  formatResetCountdown,
  formatResetDuration,
  formatWindowChipLabel,
  resetLabel,
  tightestUsageSection,
  usageSections,
  usageStatusLabel,
  usageTone,
  type ProviderRateLimits
} from '../../src/shared/usage'
import { mapClaudeUsageResponse, mapCodexUsageResponse, parseResetTimestamp } from '../../src/main/usage/fetchers'
import {
  MIN_REFETCH_MS,
  STALE_THRESHOLD_MS,
  applyStalePolicy,
  failureRetryAfterMs,
  failureRetryDelayMs,
  providersToRefresh,
  withFetchingStatus
} from '../../src/main/usage/policy'

const NOW = 1_800_000_000_000

function ok(overrides: Partial<ProviderRateLimits> = {}): ProviderRateLimits {
  return {
    provider: 'claude',
    session: { usedPercent: 29, windowMinutes: 300, resetsAt: NOW + (3 * 60 + 5) * 60_000 },
    weekly: { usedPercent: 10, windowMinutes: 10080, resetsAt: NOW + 4 * 24 * 3_600_000 },
    updatedAt: NOW,
    error: null,
    status: 'ok',
    ...overrides
  }
}

describe('表示用の書式（Orca と同じ）', () => {
  it('残り時間', () => {
    expect(formatResetDuration(0)).toBe('now')
    expect(formatResetDuration(45 * 60_000)).toBe('45m')
    expect(formatResetDuration((3 * 60 + 5) * 60_000)).toBe('3h 5m')
    expect(formatResetDuration((6 * 24 + 23) * 3_600_000)).toBe('6d 23h')
    expect(formatResetDuration(4 * 24 * 3_600_000)).toBe('4d')
    expect(formatResetCountdown((3 * 60 + 5) * 60_000)).toBe('Resets in 3h 5m')
  })

  it('フッターの枠の名前は残り時間、分からなければ枠の長さ', () => {
    expect(formatWindowChipLabel({ usedPercent: 1, windowMinutes: 300, resetsAt: NOW + 3_600_000 }, NOW)).toBe('1h')
    expect(formatWindowChipLabel({ usedPercent: 1, windowMinutes: 10080, resetsAt: null }, NOW)).toBe('wk')
  })

  it('枠の並び・いちばん使っている枠・いちばん早い戻り', () => {
    const p = ok({ fableWeekly: { usedPercent: 3, windowMinutes: 10080, resetsAt: null } })
    expect(usageSections(p).map((s) => s.label)).toEqual(['5h', 'wk', 'Fable'])
    expect(tightestUsageSection(p)?.key).toBe('session')
    expect(resetLabel(p, NOW)).toBe('Resets 5h in 3h 5m · wk in 4d')
  })

  it('戻りは5時間（日）と週の2つを出す', () => {
    // Codex のように週だけ
    expect(resetLabel(ok({ session: undefined }), NOW)).toBe('Resets wk in 4d')
    // 5時間だけ
    expect(resetLabel(ok({ weekly: undefined }), NOW)).toBe('Resets 5h in 3h 5m')
    // 片方の時刻が分からなければ、分かる方だけ
    expect(resetLabel(ok({ weekly: { usedPercent: 10, windowMinutes: 10080, resetsAt: null } }), NOW)).toBe('Resets 5h in 3h 5m')
    // 過ぎていれば now
    expect(resetLabel(ok({ session: { usedPercent: 1, windowMinutes: 300, resetsAt: NOW - 1 } }), NOW)).toBe('Resets 5h now · wk in 4d')
    // 5時間・週の時刻が無ければ、ほかの枠のいちばん早い戻り
    expect(resetLabel(ok({ session: undefined, weekly: undefined, fableWeekly: { usedPercent: 3, windowMinutes: 10080, resetsAt: NOW + 3_600_000 } }), NOW)).toBe('Resets in 1h')
    // どれも分からない
    expect(resetLabel(ok({ session: undefined, weekly: { usedPercent: 10, windowMinutes: 10080, resetsAt: Number.NaN } }), NOW)).toBeNull()
    expect(resetLabel(ok({ session: undefined, weekly: undefined }), NOW)).toBeNull()
  })

  it('色の閾値は 60 / 80', () => {
    expect(usageTone(59)).toBe('normal')
    expect(usageTone(60)).toBe('warning')
    expect(usageTone(80)).toBe('urgent')
  })

  it('プラン名', () => {
    expect(formatPlanLabel('plus')).toBe('Plus')
    expect(formatPlanLabel('chatgpt_business')).toBe('ChatGPT Business')
    expect(formatPlanLabel('')).toBeNull()
  })
})

describe('Claude の応答の読み取り', () => {
  it('5時間・週・Fable（limits[] 形式）を読む', () => {
    const p = mapClaudeUsageResponse({
      five_hour: { utilization: 29, resets_at: '2027-01-15T08:00:00Z' },
      seven_day: { utilization: 10, resets_at: 1_800_000_000 },
      limits: [{ kind: 'weekly_scoped', percent: 3, resets_at: 1_800_000_000, scope: { model: { display_name: 'Fable' } } }]
    })
    expect(p.session).toEqual({ usedPercent: 29, windowMinutes: 300, resetsAt: Date.parse('2027-01-15T08:00:00Z') })
    expect(p.weekly?.resetsAt).toBe(1_800_000_000_000)
    expect(p.fableWeekly?.usedPercent).toBe(3)
    expect(p.status).toBe('ok')
  })

  it('古いキー名の Fable と、範囲外の値を丸める', () => {
    const p = mapClaudeUsageResponse({ five_hour: { used_percentage: 140 }, seven_day_fable: { utilization: -5 } })
    expect(p.session?.usedPercent).toBe(100)
    expect(p.weekly).toBeNull()
    expect(p.fableWeekly?.usedPercent).toBe(0)
  })

  it('戻る時刻は秒・ミリ秒・文字列のどれでも受ける', () => {
    expect(parseResetTimestamp(1_800_000_000)).toBe(1_800_000_000_000)
    expect(parseResetTimestamp(1_800_000_000_000)).toBe(1_800_000_000_000)
    expect(parseResetTimestamp('1800000000')).toBe(1_800_000_000_000)
    expect(parseResetTimestamp('壊れた値')).toBeNull()
    expect(parseResetTimestamp(undefined)).toBeNull()
  })
})

describe('Codex の応答の読み取り', () => {
  it('枠の長さで 5時間・週を見分ける（順番が逆でも）', () => {
    const p = mapCodexUsageResponse({
      plan_type: 'plus',
      rate_limit: {
        primary_window: { used_percent: 0, limit_window_seconds: 604800, reset_at: 1_800_000_000 },
        secondary_window: { used_percent: 12, limit_window_seconds: 18000, reset_at: 1_800_000_100 }
      }
    })!
    expect(p.weekly).toEqual({ usedPercent: 0, windowMinutes: 10080, resetsAt: 1_800_000_000_000 })
    expect(p.session?.usedPercent).toBe(12)
    expect(p.planType).toBe('plus')
  })

  it('Business のメンバーごとの利用額の上限を「$」の枠として出す（Orca #8664）', () => {
    const p = mapCodexUsageResponse({ plan_type: 'business', rate_limit: null, spend_control: { individual_limit: { used_percent: 39 } } })!
    expect(p.spendLimit).toEqual({ usedPercent: 39, windowMinutes: 0, resetsAt: null })
    expect(usageSections(p)).toEqual([{ key: 'spend', label: '$', window: p.spendLimit }])
    expect(formatWindowChipLabel(p.spendLimit!)).toBe('$')
    expect(p.unlimited).toBeUndefined()
  })

  it('Business の上限なし（枠が null・credits.unlimited）は失敗ではなく ∞（Orca #15764）', () => {
    const p = mapCodexUsageResponse({ plan_type: 'business', rate_limit: { primary_window: null, secondary_window: null }, credits: { unlimited: true } })!
    expect(p.status).toBe('ok')
    expect(p.unlimited).toBe(true)
    expect(usageSections(p)).toEqual([])
    expect(usageStatusLabel(p)).toBe('∞')
  })

  it('週の枠しか無いプランは週だけ', () => {
    const p = mapCodexUsageResponse({ plan_type: 'free', rate_limit: { primary_window: { used_percent: 5, limit_window_seconds: 604800 } } })!
    expect(p.session).toBeNull()
    expect(p.weekly?.usedPercent).toBe(5)
  })

  it('plan_type が無い応答は使わない', () => {
    expect(mapCodexUsageResponse({ rate_limit: null })).toBeNull()
  })
})

describe('取得の頻度と失敗時の表示（Orca と同じ）', () => {
  const failed = (extra: Partial<ProviderRateLimits> = {}): ProviderRateLimits => ({
    provider: 'claude',
    session: null,
    weekly: null,
    updatedAt: NOW,
    error: '通信できません',
    status: 'error',
    failureKind: 'network',
    ...extra
  })

  it('失敗しても、30分以内の成功値は出したまま状態だけ error にする', () => {
    const previous = ok({ updatedAt: NOW - 60_000 })
    const shown = applyStalePolicy(failed(), previous, NOW)
    expect(shown.status).toBe('error')
    expect(shown.session?.usedPercent).toBe(29)
    expect(shown.error).toBe('通信できません')
  })

  it('古すぎる成功値は出さない（取得制限中は24時間まで残す）', () => {
    const previous = ok({ updatedAt: NOW - STALE_THRESHOLD_MS - 1 })
    expect(applyStalePolicy(failed(), previous, NOW).session).toBeNull()
    expect(applyStalePolicy(failed({ failureKind: 'rate-limited' }), previous, NOW).session?.usedPercent).toBe(29)
  })

  it('取得中も、出ている値は出したまま', () => {
    expect(withFetchingStatus(null, 'codex').status).toBe('fetching')
    const current = ok()
    expect(withFetchingStatus(current, 'claude')).toBe(current)
  })

  it('失敗の再試行は 30秒から倍々で、15分で止まる', () => {
    expect(failureRetryDelayMs(1)).toBe(30_000)
    expect(failureRetryDelayMs(2)).toBe(60_000)
    expect(failureRetryDelayMs(10)).toBe(15 * 60_000)
  })

  it('窓が前に出たとき：値なし・5分たった成功・間隔をあけた失敗だけ取り直す', () => {
    const base = { lastFailureRetryAt: { claude: 0, codex: 0 }, failureStreak: { claude: 0, codex: 0 }, now: NOW }
    expect(providersToRefresh({ ...base, state: { claude: null, codex: ok({ provider: 'codex' }) } })).toEqual(['claude'])
    expect(providersToRefresh({ ...base, state: { claude: ok({ updatedAt: NOW - MIN_REFETCH_MS }), codex: null } })).toEqual(['claude', 'codex'])
    // Retry-After の間は取りに行かない
    expect(providersToRefresh({ ...base, state: { claude: failed({ retryAtMs: NOW + 1000 }), codex: ok({ provider: 'codex' }) } })).toEqual([])
    // 直前に失敗して再試行したばかりなら待つ
    expect(
      providersToRefresh({
        ...base,
        lastFailureRetryAt: { claude: NOW - 10_000, codex: 0 },
        failureStreak: { claude: 1, codex: 0 },
        state: { claude: failed(), codex: ok({ provider: 'codex' }) }
      })
    ).toEqual([])
  })
})

describe('フッターが狭いときの段階', async () => {
  const { pickUsageDensityLevel, segmentDetail } = await import('../../src/renderer/lib/usageDensity')

  it('広い順に「used」→ 副次の枠 → ラベル → バーを省く', () => {
    expect(segmentDetail(0)).toEqual({ used: true, secondary: true, labels: true, bar: true, allSections: true })
    expect(segmentDetail(1)).toMatchObject({ used: false, secondary: true })
    expect(segmentDetail(2)).toMatchObject({ used: false, secondary: false, labels: true })
    expect(segmentDetail(3)).toEqual({ used: false, secondary: false, labels: false, bar: true, allSections: false })
    expect(segmentDetail(4).bar).toBe(false)
  })

  it('収まるいちばん広い段階を選び、測っていない段階はいったん試す', () => {
    expect(pickUsageDensityLevel([], 100)).toBe(0)
    expect(pickUsageDensityLevel([500], 300)).toBe(1)
    expect(pickUsageDensityLevel([500, 400, 280], 300)).toBe(2)
    expect(pickUsageDensityLevel([500, 400, 350, 320, 200], 100)).toBe(4)
    expect(pickUsageDensityLevel([300.5], 300)).toBe(0)
  })
})

describe('Keychain の読み方（確認のダイアログを待たない）', async () => {
  const { createKeychainReader } = await import('../../src/main/usage/credentials')
  type Result = { ok: true; stdout: string } | { ok: false; code: unknown }

  function fakeExec(results: Record<'exists' | 'read', Result>) {
    const calls: string[][] = []
    const exec = async (args: string[]): Promise<Result> => {
      calls.push(args)
      return args.includes('-w') ? results.read : results.exists
    }
    return { exec, calls }
  }

  it('項目があれば -w で中身を読む', async () => {
    const { exec, calls } = fakeExec({ exists: { ok: true, stdout: '' }, read: { ok: true, stdout: '{"x":1}\n' } })
    expect(await createKeychainReader(exec).read('svc', 'me')).toBe('{"x":1}')
    expect(calls).toEqual([
      ['find-generic-password', '-s', 'svc', '-a', 'me'],
      ['find-generic-password', '-s', 'svc', '-a', 'me', '-w']
    ])
  })

  it('項目が無ければ中身は読みに行かない（許可を求める操作をしない）', async () => {
    const { exec, calls } = fakeExec({ exists: { ok: false, code: 44 }, read: { ok: true, stdout: 'x' } })
    expect(await createKeychainReader(exec).read('svc', 'me')).toBeNull()
    expect(calls).toHaveLength(1)
  })

  it('拒否・タイムアウトなら諦め、以後は手動の再読み込みまで読みに行かない', async () => {
    const { exec, calls } = fakeExec({ exists: { ok: true, stdout: '' }, read: { ok: false, code: 'ETIMEDOUT' } })
    const reader = createKeychainReader(exec)
    expect(await reader.read('svc', 'me')).toBe('unavailable')
    expect(await reader.read('svc', 'me')).toBe('unavailable')
    expect(calls).toHaveLength(2)
    await reader.read('svc', 'me', { retryBlocked: true })
    expect(calls).toHaveLength(4)
  })
})

describe('失敗したあとの自動の再試行', () => {
  const failed = (failureKind: ProviderRateLimits['failureKind'], extra: Partial<ProviderRateLimits> = {}): ProviderRateLimits =>
    ({ provider: 'claude', session: null, weekly: null, updatedAt: 0, error: 'x', status: 'error', failureKind, ...extra })
  it('回線・サーバー・不明の失敗は、間隔を倍々に空けて再試行する（1度の失敗が残らない）', () => {
    expect(failureRetryAfterMs(failed('network'), 1)).toBe(30_000)
    expect(failureRetryAfterMs(failed('server'), 2)).toBe(60_000)
    expect(failureRetryAfterMs(failed('unknown'), 10)).toBe(15 * 60_000)
  })
  it('Keychain の許可・未ログイン・ログインの期限切れは、自動では取りに行かない（OS の確認を出さない）', () => {
    expect(failureRetryAfterMs(failed('keychain-unavailable'), 1)).toBeNull()
    expect(failureRetryAfterMs(failed('missing-credentials'), 1)).toBeNull()
    expect(failureRetryAfterMs(failed('stale-token'), 1)).toBeNull()
  })
  it('取得制限は Retry-After より前に行かない', () => {
    expect(failureRetryAfterMs(failed('rate-limited', { retryAtMs: 1000 + 120_000 }), 1, 1000)).toBe(120_000)
    expect(failureRetryAfterMs(failed('rate-limited', { retryAtMs: 500 }), 1, 1000)).toBe(30_000)
  })
  it('成功していれば予約しない', () => {
    expect(failureRetryAfterMs({ ...failed('network'), status: 'ok' }, 1)).toBeNull()
  })
})

describe('Claude の資格情報の期限', () => {
  it('期限切れのファイルのトークンを見分ける（macOS では Keychain の新しいトークンを先に使う）', async () => {
    const { parseClaudeCredentials } = await import('../../src/main/usage/credentials')
    const raw = (expiresAt?: number) => JSON.stringify({ claudeAiOauth: { accessToken: 'tok', ...(expiresAt === undefined ? {} : { expiresAt }) } })
    expect(parseClaudeCredentials(raw(2_000), 1_000)).toEqual({ token: 'tok', expired: false })
    expect(parseClaudeCredentials(raw(500), 1_000)).toEqual({ token: 'tok', expired: true })
    expect(parseClaudeCredentials(raw(), 1_000)).toEqual({ token: 'tok', expired: false })
    expect(parseClaudeCredentials('{broken', 1_000)).toBeNull()
    expect(parseClaudeCredentials('{}', 1_000)).toBeNull()
  })
})
