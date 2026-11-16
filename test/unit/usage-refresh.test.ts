/**
 * 追加したアカウントの使用量が「ログインの更新待ち」のまま出ない（2026-11-16）への対応:
 * 期限の切れたトークンを取り直して書き戻し、全アカウントの使用量を出す。設定画面の行の使用量とリセットの表示、
 * 同じログインの行のまとめ、録画の合わせ鏡を止める場所の計算
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: () => '/tmp/ade-unit' } }))

import { applyRefreshedToken, isTokenExpiring, keychainWriteCommand, readRefreshToken, refreshClaudeCredentials, writeClaudeCredentials } from '../../src/main/usage/oauthRefresh'
import { fetchClaudeUsage } from '../../src/main/usage/fetchers'
import { groupAccountRows } from '../../src/shared/accounts'
import { usageResetText, usageSectionName, usageSections, type ProviderRateLimits } from '../../src/shared/usage'
import { isMirrorShownTitle, mirrorHash, mirrorMaskParam } from '../../src/shared/captureComposite'

const NOW = 1_800_000_000_000
const creds = (o: Record<string, unknown>) => JSON.stringify({ claudeAiOauth: { accessToken: 'old-at', refreshToken: 'old-rt', expiresAt: NOW - 1000, scopes: ['user:inference'], subscriptionType: 'max', ...o }, other: 1 })
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

describe('トークンの期限', () => {
  it('切れた・5分前を過ぎた・期限が無いなら取り直す。まだ先なら取り直さない', () => {
    expect(isTokenExpiring(creds({ expiresAt: NOW - 1 }), NOW)).toBe(true)
    expect(isTokenExpiring(creds({ expiresAt: NOW + 4 * 60_000 }), NOW)).toBe(true)
    expect(isTokenExpiring(creds({ expiresAt: NOW + 10 * 60_000 }), NOW)).toBe(false)
    expect(isTokenExpiring(creds({ expiresAt: 'x' }), NOW)).toBe(true)
  })
  it('資格情報の形でなければ取り直さない', () => {
    expect(isTokenExpiring('{broken', NOW)).toBe(false)
    expect(isTokenExpiring('{}', NOW)).toBe(false)
    expect(isTokenExpiring(JSON.stringify({ claudeAiOauth: [] }), NOW)).toBe(false)
  })
  it('リフレッシュトークンを読む（空・無しは null）', () => {
    expect(readRefreshToken(creds({}))).toBe('old-rt')
    expect(readRefreshToken(creds({ refreshToken: '  ' }))).toBeNull()
    expect(readRefreshToken(creds({ refreshToken: 3 }))).toBeNull()
    expect(readRefreshToken('nope')).toBeNull()
  })
})

describe('取り直した値を重ねる', () => {
  it('新しいアクセストークン・期限・リフレッシュトークン・scope を入れ、ほかの項目は残す', () => {
    const next = JSON.parse(applyRefreshedToken(creds({}), { access_token: 'new-at', expires_in: 3600, refresh_token: 'new-rt', scope: 'a b' }, NOW)!)
    expect(next.claudeAiOauth).toEqual({ accessToken: 'new-at', refreshToken: 'new-rt', expiresAt: NOW + 3_600_000, scopes: ['a', 'b'], subscriptionType: 'max' })
    expect(next.other).toBe(1)
  })
  it('リフレッシュトークンが来なければ前のものを残す', () => {
    const next = JSON.parse(applyRefreshedToken(creds({}), { access_token: 'new-at' }, NOW)!)
    expect(next.claudeAiOauth.refreshToken).toBe('old-rt')
    expect(next.claudeAiOauth.expiresAt).toBe(NOW - 1000)
  })
  it('アクセストークンが無い応答・壊れた資格情報は null（書き戻さない）', () => {
    expect(applyRefreshedToken(creds({}), {}, NOW)).toBeNull()
    expect(applyRefreshedToken(creds({}), { access_token: ' ' }, NOW)).toBeNull()
    expect(applyRefreshedToken('{x', { access_token: 'a' }, NOW)).toBeNull()
  })
})

describe('トークンの窓口', () => {
  it('Claude Code と同じ形で送り、応答を重ねる', async () => {
    const request = vi.fn(async (_url: string, _init: RequestInit) => json({ access_token: 'new-at', refresh_token: 'new-rt', expires_in: 60 }))
    const next = await refreshClaudeCredentials(request, creds({}), NOW)
    expect(JSON.parse(next!).claudeAiOauth.accessToken).toBe('new-at')
    const [url, init] = request.mock.calls[0]
    expect(url).toBe('https://platform.claude.com/v1/oauth/token')
    expect(init.method).toBe('POST')
    const body = new URLSearchParams(String(init.body))
    expect(body.get('grant_type')).toBe('refresh_token')
    expect(body.get('refresh_token')).toBe('old-rt')
    expect(body.get('client_id')).toBe('9d1c250a-e61b-44d9-88ed-5944d1962f5e')
  })
  it('失敗（400・通信の失敗・壊れた応答）は null', async () => {
    expect(await refreshClaudeCredentials(async () => json({ error: 'invalid_grant' }, 400), creds({}), NOW)).toBeNull()
    expect(await refreshClaudeCredentials(async () => { throw new Error('offline') }, creds({}), NOW)).toBeNull()
    expect(await refreshClaudeCredentials(async () => new Response('<html>', { status: 200 }), creds({}), NOW)).toBeNull()
  })
  it('リフレッシュトークンが無ければ窓口を呼ばない', async () => {
    const request = vi.fn()
    expect(await refreshClaudeCredentials(request, creds({ refreshToken: null }), NOW)).toBeNull()
    expect(request).not.toHaveBeenCalled()
  })
})

describe('Keychain への書き戻しの1行', () => {
  it('値は16進で、引数ではなく標準入力に載せる', () => {
    const line = keychainWriteCommand('Claude Code-credentials-1a2b3c4d', 'takumi', '{"a":"あ"}')!
    expect(line).toBe(`add-generic-password -U -a "takumi" -s "Claude Code-credentials-1a2b3c4d" -X "${Buffer.from('{"a":"あ"}').toString('hex')}"\n`)
    expect(line).not.toContain('{"a"')
  })
  it('記号の入った service・account は書かない（コマンドに混ぜない）', () => {
    expect(keychainWriteCommand('svc"; delete-keychain', 'me', '{}')).toBeNull()
    expect(keychainWriteCommand('svc', 'me\nx', '{}')).toBeNull()
    expect(keychainWriteCommand('svc', '', '{}')).toBeNull()
  })
})

describe('使用量の取得でトークンを取り直す', () => {
  let dir = ''
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
    dir = ''
  })
  const setup = (raw: string) => {
    dir = mkdtempSync(join(tmpdir(), 'ferret-refresh-'))
    writeFileSync(join(dir, '.credentials.json'), raw)
    return dir
  }
  const usageBody = { five_hour: { utilization: 12, resets_at: '2030-01-01T00:00:00Z' }, seven_day: { utilization: 40 } }

  it('期限が切れていれば取り直してファイルへ書き戻し、新しいトークンで読む', async () => {
    const configDir = setup(creds({ expiresAt: Date.now() + 60 * 60_000, accessToken: 'still-old' }).replace(/"expiresAt":\d+/, `"expiresAt":${Date.now() - 1000}`))
    const seen: string[] = []
    const request = vi.fn(async (url: string, init: RequestInit) => {
      if (url.includes('oauth/token')) return json({ access_token: 'new-at', refresh_token: 'new-rt', expires_in: 3600 })
      seen.push(String((init.headers as Record<string, string>).Authorization))
      return json(usageBody)
    })
    const result = await fetchClaudeUsage(request, configDir, { refresh: { request, write: writeClaudeCredentials } })
    expect(result.status).toBe('ok')
    expect(result.session?.usedPercent).toBe(12)
    expect(seen).toEqual(['Bearer new-at'])
    const saved = JSON.parse(readFileSync(join(configDir, '.credentials.json'), 'utf8'))
    expect(saved.claudeAiOauth.refreshToken).toBe('new-rt')
    expect(saved.other).toBe(1)
  })

  it('期限の前でも 401 なら一度だけ取り直して読み直す', async () => {
    const configDir = setup(creds({ expiresAt: Date.now() + 60 * 60_000 }))
    let usageCalls = 0
    const request = vi.fn(async (url: string) => {
      if (url.includes('oauth/token')) return json({ access_token: 'new-at', expires_in: 3600 })
      usageCalls += 1
      return usageCalls === 1 ? json({}, 401) : json(usageBody)
    })
    const write = vi.fn(async () => true)
    const result = await fetchClaudeUsage(request, configDir, { refresh: { request, write } })
    expect(result.status).toBe('ok')
    expect(usageCalls).toBe(2)
    expect(write).toHaveBeenCalledTimes(1)
  })

  it('組織が OAuth を許していない 403 は、取り直さずに「この組織では使用量を読めません」', async () => {
    const configDir = setup(creds({ expiresAt: Date.now() + 60 * 60_000 }))
    const write = vi.fn(async () => true)
    const request = vi.fn(async () => json({ type: 'error', error: { type: 'permission_error', details: { error_code: 'oauth_not_allowed_for_organization' } } }, 403))
    const result = await fetchClaudeUsage(request, configDir, { refresh: { request, write } })
    expect(result.failureKind).toBe('not-allowed')
    expect(request).toHaveBeenCalledTimes(1)
    expect(write).not.toHaveBeenCalled()
  })

  it('ほかの 403 は 401 と同じく一度だけ取り直す', async () => {
    const configDir = setup(creds({ expiresAt: Date.now() + 60 * 60_000 }))
    let usageCalls = 0
    const request = vi.fn(async (url: string) => {
      if (url.includes('oauth/token')) return json({ access_token: 'new-at' })
      usageCalls += 1
      return usageCalls === 1 ? json({ error: { type: 'forbidden' } }, 403) : json(usageBody)
    })
    expect((await fetchClaudeUsage(request, configDir, { refresh: { request, write: async () => true } })).status).toBe('ok')
  })

  it('取り直しを許していない（いつものログイン・選択中）なら取り直さず「ログインの更新待ち」', async () => {
    const configDir = setup(creds({ expiresAt: Date.now() + 60 * 60_000 }))
    const request = vi.fn(async () => json({}, 401))
    const result = await fetchClaudeUsage(request, configDir)
    expect(result.failureKind).toBe('stale-token')
    expect(request).toHaveBeenCalledTimes(1)
  })

  it('取り直せなければ（リフレッシュトークンが使えない）「ログインの更新待ち」のまま。書き戻さない', async () => {
    const configDir = setup(creds({ expiresAt: Date.now() + 60 * 60_000 }))
    const write = vi.fn(async () => true)
    const request = vi.fn(async (url: string) => (url.includes('oauth/token') ? json({ error: 'invalid_grant' }, 400) : json({}, 401)))
    const result = await fetchClaudeUsage(request, configDir, { refresh: { request, write } })
    expect(result.failureKind).toBe('stale-token')
    expect(write).not.toHaveBeenCalled()
  })
})

describe('同じログインの行をまとめる（設定画面とフッターの内訳で同じ）', () => {
  const row = (accountId: string | null, email: string | null, workspaceLabel: string | null = null) => ({ accountId, email, workspaceLabel })
  it('同じアカウントを2回追加し、いつものログインと同じアカウントも追加して選んでいる: 3行になり、まとめた行も持つ', () => {
    const rows = [row(null, 'me@x.com', 'Org M'), row('t1', 'tk@x.jp', 'Org T'), row('t2', 'tk@x.jp', 'Org T'), row('i', 'info@y.ai', 'Org I'), row('m', 'me@x.com', 'Org M')]
    const groups = groupAccountRows(rows, 'm')
    expect(groups.map((g) => g.keeper.accountId)).toEqual(['t1', 'i', 'm'])
    expect(groups[0].members.map((m) => m.accountId)).toEqual(['t1', 't2'])
    expect(groups[2].members.map((m) => m.accountId)).toEqual(['m', null])
  })
  it('選択中が無ければ、いつものログインを残して先頭に置く', () => {
    const groups = groupAccountRows([row(null, 'me@x.com'), row('m', 'me@x.com'), row('z', 'z@x.com')], null)
    expect(groups.map((g) => g.keeper.accountId)).toEqual([null, 'z'])
    expect(groups[0].members.map((m) => m.accountId)).toEqual([null, 'm'])
  })
  it('メールが分からない行（ログイン待ち・ログアウト）はまとめない', () => {
    const groups = groupAccountRows([row(null, null), row('a', null), row('b', null)], null)
    expect(groups.map((g) => g.members.length)).toEqual([1, 1, 1])
  })
  it('空なら空', () => {
    expect(groupAccountRows([], null)).toEqual([])
  })
})

describe('設定画面の使用量: 枠の名前といつリセットされるか', () => {
  const p: ProviderRateLimits = {
    provider: 'claude',
    session: { usedPercent: 12, windowMinutes: 300, resetsAt: NOW + (3 * 60 + 5) * 60_000 },
    weekly: { usedPercent: 40, windowMinutes: 10080, resetsAt: null },
    fableWeekly: { usedPercent: 3, windowMinutes: 10080, resetsAt: NOW - 1 },
    updatedAt: NOW,
    error: null,
    status: 'ok'
  }
  const fmt = (ms: number) => `T${ms - NOW}`
  it('枠の名前', () => {
    expect(usageSections(p).map(usageSectionName)).toEqual(['5 hours', 'Week', 'Fable (week)'])
  })
  it('日時と残り時間の両方。時刻が分からなければ null、過ぎていれば「まもなくリセット」', () => {
    const [session, weekly, fable] = usageSections(p)
    expect(usageResetText(session.window, NOW, fmt)).toBe(`Resets T${(3 * 60 + 5) * 60_000} (in 3h 5m)`)
    expect(usageResetText(weekly.window, NOW, fmt)).toBeNull()
    expect(usageResetText(fable.window, NOW, fmt)).toBe('Resets now')
  })
})

describe('録画の合わせ鏡を止める場所', () => {
  const display = { x: 0, y: 0, width: 1512, height: 982 }
  it('映している枠が録っている画面の上にあれば、その場所を割合で返す', () => {
    expect(mirrorMaskParam({ x: 756, y: 491, width: 756, height: 491 }, display)).toBe('0.5,0.5,0.5,0.5')
  })
  it('画面からはみ出した分は切る。別の画面（重ならない）なら null', () => {
    expect(mirrorMaskParam({ x: 1000, y: -100, width: 1000, height: 200 }, display)).toBe(`${Math.round((1000 / 1512) * 10000) / 10000},0,${Math.round((512 / 1512) * 10000) / 10000},${Math.round((100 / 982) * 10000) / 10000}`)
    expect(mirrorMaskParam({ x: 1600, y: 0, width: 100, height: 100 }, display)).toBeNull()
  })
  it('2枚目の画面（原点がずれている）でも、その画面に対する割合', () => {
    expect(mirrorMaskParam({ x: 1512, y: 0, width: 756, height: 982 }, { x: 1512, y: 0, width: 1512, height: 982 })).toBe('0,0,0.5,1')
  })
  it('大きさが0なら null', () => {
    expect(mirrorMaskParam({ x: 0, y: 0, width: 0, height: 10 }, display)).toBeNull()
    expect(mirrorMaskParam({ x: 0, y: 0, width: 10, height: 10 }, { x: 0, y: 0, width: 0, height: 0 })).toBeNull()
  })
})

describe('映すページへ渡すハッシュ', () => {
  it('映すもの・文・塗りつぶす場所。無いものは入れない。文は URL として逃がす', () => {
    expect(mirrorHash({ source: 'screen:1:0' })).toBe('src=screen%3A1%3A0')
    const hash = new URLSearchParams(mirrorHash({ source: 'screen:1:0,window:2:0', message: '映せません & ?#', mask: '0,0,0.5,1' }))
    expect(hash.get('src')).toBe('screen:1:0,window:2:0')
    expect(hash.get('msg')).toBe('映せません & ?#')
    expect(hash.get('mask')).toBe('0,0,0.5,1')
    expect(new URLSearchParams(mirrorHash({ source: 'screen:1:0', mask: null })).has('mask')).toBe(false)
  })
  it('ビューを出す題名は mirror-ready と mirror-failed だけ', () => {
    expect(isMirrorShownTitle('mirror-ready')).toBe(true)
    expect(isMirrorShownTitle('mirror-failed')).toBe(true)
    expect(isMirrorShownTitle('Ferret mirror')).toBe(false)
    expect(isMirrorShownTitle('')).toBe(false)
  })
})
