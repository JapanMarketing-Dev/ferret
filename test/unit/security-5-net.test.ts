import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { lstat, mkdir, mkdtemp, readdir, readFile, rm, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DECISION_ENV, type DecisionPreferences } from '@shared/decision'
import { setLocale } from '@shared/i18n'
import { DecisionRelay, RELAY_BUDGET, type RelayBudget } from '../../src/main/decision/relay'
import { DecisionService } from '../../src/main/decision/service'
import { CredentialOrigins, authorizeCredentialOrigin, credentialOriginOf } from '../../src/main/credentialOrigin'
import { RETENTION_LIMITS } from '../../src/main/sessions/limits'
import { pruneRecordings, scheduleRetention } from '../../src/main/sessions/retention'
import { createSession, saveSession } from '../../src/main/sessions'
import { removeContained } from '../../src/main/sessions/containment'
import { PinnedDir, removeIn, renameIn } from '../../src/main/pinnedDir'
import { createEntry, moveEntries, renameEntry } from '../../src/main/fileOps'

/** 中継が受け付ける最小の System One の依頼（security-7 [7]。形の違う本文は送らずに断る） */
const SYSTEM_ONE_BODY = JSON.stringify({ model: 'm', state: 's', questions: { ok: { type: 'noul' } } })

/**
 * Codex のセキュリティスキャン5回目のうち [4][6][7][11] を、同じ種類のコードが戻ったら落ちる形で止める。
 *   [4] 判定の中継は、合言葉・プロジェクトごとの総量（回数・1分あたり・トークン・費用）を送る前に予約する
 *   [6] 保存したキーは、プリセットか main のダイアログで認めた接続元にだけ送る（画面から届いた URL で決めない）
 *   [7] 起動時の保持期間の掃除は窓を待たせず、切れごとに件数・読む量・消す数・時間の上限を守る
 *   [11] プロジェクトを変える fs の呼び出しは pinnedDir.ts（開いた親フォルダからの相対）を通す
 */

const repo = resolve(__dirname, '../..')
const read = (p: string) => readFileSync(join(repo, p), 'utf8')

beforeEach(() => setLocale('en'))

// ───────────────────────── [4] 判定の中継の総量 ─────────────────────────

/** 応答に使ったトークンと費用を入れる偽の接続先 */
function fakeUpstream(opt: { costUsd?: number; tokens?: number; gate?: Promise<void> } = {}) {
  const calls: number[] = []
  const fetch = vi.fn(async () => {
    calls.push(Date.now())
    await opt.gate
    return new Response(JSON.stringify({ usage: { input_tokens: opt.tokens ?? 10, output_tokens: 0 }, ...(opt.costUsd !== undefined ? { provider_metadata: { gateway: { cost: opt.costUsd } } } : {}) }),
      { status: 200, headers: { 'content-type': 'application/json' } })
  }) as unknown as typeof globalThis.fetch
  return { fetch, calls }
}

const relayFor = (fetch: typeof globalThis.fetch, budget: Partial<RelayBudget>, extra: Partial<ConstructorParameters<typeof DecisionRelay>[0]> = {}) =>
  new DecisionRelay({ upstream: async () => ({ url: 'https://decision.example.test/v1/systemone', headers: {}, provider: 'p', model: 'm', timeoutMs: 5000 }), fetch, budget, ...extra })

const post = async (url: string) => {
  const res = await fetch(url, { method: 'POST', body: SYSTEM_ONE_BODY })
  const body = await res.json().catch(() => ({})) as { error_type?: string }
  return { status: res.status, type: body.error_type }
}

describe('security-5 [4] the decision relay reserves a cumulative budget before dispatch', () => {
  it('has finite per-token and per-project defaults for calls, rate, tokens and dollars', () => {
    for (const value of Object.values(RELAY_BUDGET)) expect(Number.isFinite(value) && value > 0).toBe(true)
  })

  it('sequential calls stop at the per-token call budget, and the exhausted token is revoked', async () => {
    const up = fakeUpstream()
    const relay = relayFor(up.fetch, { callsPerToken: 3 })
    await relay.start()
    const url = relay.urlFor(relay.issue())
    for (let i = 0; i < 3; i++) expect((await post(url)).status).toBe(200)
    expect(await post(url)).toEqual({ status: 429, type: 'relay_budget_exhausted' })
    // 使い切った合言葉は理由を返したあとで無効（その後は 401）。接続先へは3回だけ
    expect((await post(url)).status).toBe(401)
    expect(up.calls).toHaveLength(3)
    await relay.stop()
  })

  it('concurrent calls cannot overshoot the call budget (the reservation is taken before the request is sent)', async () => {
    let release!: () => void
    const up = fakeUpstream({ gate: new Promise<void>((r) => { release = r }) })
    const relay = relayFor(up.fetch, { callsPerToken: 2 })
    await relay.start()
    const url = relay.urlFor(relay.issue())
    const pending = Array.from({ length: 4 }, () => post(url))
    await new Promise((r) => setTimeout(r, 100))
    release()
    const results = await Promise.all(pending)
    expect(results.filter((r) => r.status === 200)).toHaveLength(2)
    expect(up.calls).toHaveLength(2)
    await relay.stop()
  })

  it('concurrent calls cannot overshoot the dollar budget (each in-flight call holds the largest cost seen so far)', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    let first = true
    const calls: number[] = []
    const fetch = vi.fn(async () => {
      calls.push(1)
      if (!first) await gate
      first = false
      return new Response(JSON.stringify({ provider_metadata: { gateway: { cost: 1 } } }), { status: 200 })
    }) as unknown as typeof globalThis.fetch
    const relay = relayFor(fetch, { usdPerToken: 2.5 })
    await relay.start()
    const url = relay.urlFor(relay.issue())
    expect((await post(url)).status).toBe(200)
    const pending = Array.from({ length: 4 }, () => post(url))
    await new Promise((r) => setTimeout(r, 100))
    release()
    await Promise.all(pending)
    // 1ドル＋押さえた1ドルで 2ドル。もう1つ押さえると 2.5 を超えるので送らない
    // 1回 1ドルなので、送った数がそのまま使った額。2.5 ドルを超えない
    expect(calls.length).toBe(2)
    await relay.stop()
  })

  it('stops a token at its token budget and limits calls per minute', async () => {
    // 1回の上限（security-7 [7]。最小の依頼で 4871 トークン）が収まる枠にする
    const up = fakeUpstream({ tokens: 6000 })
    const relay = relayFor(up.fetch, { tokensPerToken: 10_000 })
    await relay.start()
    const url = relay.urlFor(relay.issue())
    expect((await post(url)).status).toBe(200)
    // 6000 使った。次の1回で見込む 6000 を足すと 10000 を超える
    expect(await post(url)).toEqual({ status: 429, type: 'relay_budget_exhausted' })

    let now = Date.parse('2026-10-04T00:00:00Z')
    const rated = relayFor(fakeUpstream().fetch, { callsPerMinute: 2 }, { now: () => new Date(now) })
    await rated.start()
    const r = rated.urlFor(rated.issue())
    expect((await post(r)).status).toBe(200)
    expect((await post(r)).status).toBe(200)
    expect(await post(r)).toEqual({ status: 429, type: 'relay_rate_limited' })
    now += 61_000
    expect((await post(r)).status).toBe(200)
    await relay.stop()
    await rated.stop()
  })

  it('a project budget applies across tokens (opening new terminals does not reset it)', async () => {
    const up = fakeUpstream()
    const relay = relayFor(up.fetch, { callsPerProjectPerDay: 2 })
    await relay.start()
    expect((await post(relay.urlFor(relay.issue({ projectId: 'p1' })))).status).toBe(200)
    expect((await post(relay.urlFor(relay.issue({ projectId: 'p1' })))).status).toBe(200)
    expect(await post(relay.urlFor(relay.issue({ projectId: 'p1' })))).toEqual({ status: 429, type: 'relay_project_budget' })
    expect((await post(relay.urlFor(relay.issue({ projectId: 'p2' })))).status).toBe(200)
    await relay.stop()
  })

  it('closing the terminal and changing the decision settings revoke issued tokens', async () => {
    const up = fakeUpstream()
    let prefs: DecisionPreferences = { enabled: true, preset: 'custom', model: 'm', authScheme: 'none', endpoint: 'https://decision.example.test/v1/systemone' }
    const service = new DecisionService({ prefs: () => prefs, readKey: async () => undefined, getEnv: () => undefined, onCall: () => {}, fetch: up.fetch })
    const closed = (await service.launchEnv({ sessionId: 's1' }))[DECISION_ENV.url]!
    const kept = (await service.launchEnv({ sessionId: 's2' }))[DECISION_ENV.url]!
    service.revokeSession('s1')
    expect((await post(closed)).status).toBe(401)
    expect((await post(kept)).status).toBe(200)
    prefs = { ...prefs, endpoint: 'https://other.example.test/v1/systemone' }
    await service.sync()
    expect((await post(kept)).status).toBe(401)
    await service.stop()
  })
})

// ───────────────────────── [6] キーを送る接続元 ─────────────────────────

describe('security-5 [6] saved credentials are bound to approved origins in main', () => {
  let dir = ''
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'ferret-sec5-origin-')) })
  afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

  it('a saved key is never sent to an unconfirmed origin; a preset origin passes without asking', async () => {
    const origins = new CredentialOrigins(join(dir, 'credential-origins.json'))
    const confirm = vi.fn(async () => false)
    const req = { scope: 'stt:openai', hasCredential: true, defaults: ['https://api.openai.com/v1'] }
    expect(await authorizeCredentialOrigin({ ...req, url: 'https://api.openai.com/v1' }, origins, confirm)).toEqual({ ok: true })
    expect(confirm).not.toHaveBeenCalled()
    expect(await authorizeCredentialOrigin({ ...req, url: 'https://attacker.example.test/v1' }, origins)).toEqual({ ok: false, origin: 'https://attacker.example.test' })
    expect(await authorizeCredentialOrigin({ ...req, url: 'https://attacker.example.test/v1' }, origins, confirm)).toEqual({ ok: false, origin: 'https://attacker.example.test' })
    expect(confirm).toHaveBeenCalledWith('https://attacker.example.test')
    // 似た名前・ポート違い・http は別の接続元
    expect(credentialOriginOf('https://api.openai.com.attacker.example.test/v1')).not.toBe('https://api.openai.com')
    expect(origins.isApproved('stt:openai', 'http://api.openai.com', req.defaults)).toBe(false)
    expect(origins.isApproved('stt:openai', 'https://api.openai.com:8443', req.defaults)).toBe(false)
    // 認証情報を付けない依頼は接続元を問わない
    expect(await authorizeCredentialOrigin({ ...req, hasCredential: false, url: 'http://127.0.0.1:9/v1' }, origins)).toEqual({ ok: true })
  })

  it('an origin confirmed in the main-process dialog is remembered by main, per scope (settings are never seeded as approval: security-6 [3])', async () => {
    const file = join(dir, 'credential-origins.json')
    const origins = new CredentialOrigins(file)
    // 設定の接続先を「認めた」ものとして移す口は無い（security-6 [3]）
    expect('seedOnce' in origins).toBe(false)
    const ok = await authorizeCredentialOrigin({ scope: 'stt:compatible', url: 'https://stt.example.test/v1', hasCredential: true, defaults: [] }, origins, async () => true)
    expect(ok).toEqual({ ok: true })
    const again = new CredentialOrigins(file)
    expect(again.isApproved('stt:compatible', 'https://stt.example.test')).toBe(true)
    // 別の用途には持ち越さない
    expect(again.isApproved('organize:openai', 'https://stt.example.test')).toBe(false)
    expect(new CredentialOrigins(file).isApproved('stt:openai', 'https://attacker.example.test')).toBe(false)
  })

  it('the decision relay and its connection test refuse before the key is read or anything is sent', async () => {
    const fetch = vi.fn() as unknown as typeof globalThis.fetch
    const readKey = vi.fn(async () => 'k')
    const authorize = vi.fn(async (_p: DecisionPreferences, url: string, interactive: boolean) => {
      if (!interactive || new URL(url).origin !== 'https://decision.example.test') throw new Error('not approved')
    })
    const prefs: DecisionPreferences = { enabled: true, preset: 'custom', model: 'm', authScheme: 'bearer', apiKeyEnv: 'DECISION_KEY', endpoint: 'https://attacker.example.test/v1/systemone' }
    const service = new DecisionService({ prefs: () => prefs, readKey, getEnv: () => undefined, onCall: () => {}, authorize, fetch })
    const url = (await service.launchEnv())[DECISION_ENV.url]!
    expect((await post(url)).status).toBe(400)
    const test = await service.testConnection(prefs, { interactive: true })
    expect(test.ok).toBe(false)
    expect(authorize).toHaveBeenCalledWith(prefs, 'https://attacker.example.test/v1/systemone', true)
    expect(readKey).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
    await service.stop()
  })

  it('all three connection tests and every saved-key send in main go through the same gate (shape check)', () => {
    const index = read('src/main/index.ts')
    const handler = (name: string) => {
      const at = index.indexOf(`'${name}': async`)
      expect(at).toBeGreaterThan(0)
      return index.slice(at, index.indexOf('\n    },', at))
    }
    // 「接続を確かめる」は main のダイアログで聞ける（ask = true）
    expect(handler('capture:testConnection')).toMatch(/await gateCredentials\(`stt:\$\{target\.provider\}`[^\n]*, true\)/)
    expect(handler('organize:testConnection')).toMatch(/await gateCredentials\(`organize:\$\{target\.provider\}`[^\n]*, true\)/)
    expect(handler('decision:testConnection')).toMatch(/testConnection\(prefs, \{[^}]*interactive: true/)
    // 保存した設定で送るときは聞かずに断る（ask = false）。キーを読む前に確かめる
    const organize = handler('review:organize')
    expect(organize.indexOf('gateCredentials(')).toBeGreaterThan(0)
    expect(organize.indexOf('gateCredentials(')).toBeLessThan(organize.indexOf('providerKey('))
    expect(index).toMatch(/authorize: \(prefs, url, interactive\) => gateCredentials\(/)
    // providerKey を呼ぶ所は、定義・判定の readKey・上の2つの「接続を確かめる」・整理・録画の文字起こし・発信の下書きだけ（増えたら gate を通すこと）
    expect(index.match(/providerKey\(/g)?.length).toBe(7)
    const publish = index.slice(index.indexOf('async function publishRunner('))
    expect(publish.indexOf('gateCredentials(')).toBeGreaterThan(0)
    expect(publish.indexOf('gateCredentials(')).toBeLessThan(publish.indexOf('providerKey('))
    const stt = index.slice(index.indexOf("const gate = await gateCredentials(`stt:${provider}`"))
    expect(stt.indexOf('gateCredentials(')).toBeLessThan(stt.indexOf('providerKey('))
    // 送り主は main ウィンドウの本体のフレームだけ（IPC の共通の入口）
    expect(index).toMatch(/if \(!isTrustedIpcSender\(event, main,/)
  })
})

// ───────────────────────── [7] 起動時の掃除の総量 ─────────────────────────

describe('security-5 [7] startup retention is bounded and does not block the window', () => {
  let project = ''
  beforeEach(async () => { project = await mkdtemp(join(tmpdir(), 'ferret-sec5-retention-')) })
  afterEach(async () => { await rm(project, { recursive: true, force: true }) })

  it('main schedules retention instead of awaiting it before the window opens', () => {
    const index = read('src/main/index.ts')
    expect(index).not.toMatch(/await pruneRecordings\(/)
    expect(index).toMatch(/scheduleRetention\(loadedSettings\.folderPath/)
    expect(RETENTION_LIMITS.startDelayMs).toBeGreaterThan(0)
  })

  it('40,000 IDs are handled in slices that each stop at the session count and the deadline', async () => {
    const ids = Array.from({ length: 40_000 }, (_, i) => `2026${String(1 + (i % 12)).padStart(2, '0')}${String(1 + (i % 28)).padStart(2, '0')}-${String(i % 1_000_000).padStart(6, '0')}`)
    const slice = await pruneRecordings(project, { ids, keepDays: 1 })
    expect(slice.scanned).toBeLessThanOrEqual(RETENTION_LIMITS.sessionsPerSlice)
    expect(slice.next).toBe(slice.scanned)
    // 時間の上限: 時計が上限を越えたら、そこで止める
    let now = 0
    const timed = await pruneRecordings(project, { ids, keepDays: 1, clock: () => (now += 100), limits: { sessionsPerSlice: 1_000_000, sliceMs: 1000 } })
    expect(timed.scanned).toBeLessThan(15)
    expect(timed.next).not.toBeNull()
  })

  it('large session files cannot exceed the aggregate read budget of a slice', async () => {
    for (let i = 0; i < 5; i++) {
      const paths = await createSession(project, new Date(Date.UTC(2026, 0, 1, 0, 0, i * 10)))
      await writeFile(paths.sessionJson, `{"version":1,"pad":"${'x'.repeat(1024 * 1024)}"}`)
    }
    const slice = await pruneRecordings(project, { keepDays: 1, limits: { readBytesPerSlice: 2.5 * 1024 * 1024 } })
    expect(slice.scanned).toBe(2)
    expect(slice.readBytes).toBeLessThanOrEqual(2.5 * 1024 * 1024)
    expect(slice.next).toBe(2)
  })

  it('deferred work resumes in bounded slices until every old recording is removed', async () => {
    const old = new Date(Date.now() - 30 * 86_400_000)
    for (let i = 0; i < 7; i++) {
      const paths = await createSession(project, new Date(Date.UTC(2026, 0, 2, 0, 0, i * 10)))
      await saveSession(paths, { version: 1, meta: { id: paths.id, durationMs: 1000 }, transcript: [], frames: [], edits: [], document: { items: [] } } as never)
      await writeFile(paths.recording, 'v')
      await utimes(paths.recording, old, old)
    }
    const timers: Array<{ fn: () => void; ms: number }> = []
    const run = scheduleRetention(project, { keepDays: 1, limits: { sessionsPerSlice: 3 }, setTimer: (fn, ms) => timers.push({ fn, ms }) })
    // 何も同期では走らない（窓を開くのを待たせない）。最初の切れは間を空けてから
    expect(timers).toHaveLength(1)
    expect(timers[0].ms).toBe(RETENTION_LIMITS.startDelayMs)
    // 次の切れの予約は前の切れが終わってから入るので、遅い環境では間が空く。終わるまで、予約が入るたびに進める
    const slices: number[] = []
    let finished = false
    void run.done.then(() => { finished = true })
    while (!finished) {
      const next = timers.shift()
      if (next) {
        next.fn()
        slices.push(1)
      }
      await new Promise((r) => setTimeout(r, 20))
    }
    const total = await run.done
    expect(total.scanned).toBe(7)
    expect(total.removedRecordings).toHaveLength(7)
    expect(slices.length).toBe(3)
    // 実際のファイルを作って消すので、遅い Windows（VM・ARM）では 10 秒を超えることがある
  }, 60_000)
})

// ───────────────────────── [11] プロジェクトを変える fs の呼び出し ─────────────────────────

const MUTATING_FS = ['mkdir', 'rename', 'rm', 'rmdir', 'unlink', 'symlink', 'link', 'writeFile', 'appendFile', 'copyFile', 'cp', 'truncate', 'mkdtemp', 'chmod', 'utimes', 'createWriteStream']
  .flatMap((name) => [name, `${name}Sync`])

/** node:fs・node:fs/promises から取り込む名前（静的な import と、await import の分割代入） */
function fsImports(source: string): string[] {
  const names: string[] = []
  for (const m of source.matchAll(/import\s*\{([^}]*)\}\s*from\s*'node:fs(?:\/promises)?'/g)) names.push(...m[1].split(',').map((x) => x.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0]))
  for (const m of source.matchAll(/const\s*\{([^}]*)\}\s*=\s*await\s+import\('node:fs(?:\/promises)?'\)/g)) names.push(...m[1].split(',').map((x) => x.trim().split(':')[0].trim()))
  if (/import\s+\*\s+as\s+\w+\s+from\s+'node:fs/.test(source) || /import\s+\w+\s+from\s+'node:fs/.test(source)) names.push('*')
  return names.filter(Boolean)
}

describe('security-5 [11] every project mutation goes through the handle-relative helpers', () => {
  const PROJECT_MUTATORS = ['src/main/fileOps.ts', 'src/main/sessions/containment.ts', 'src/main/sessions/store.ts', 'src/main/sessions/retention.ts', 'src/main/sessions/labels.ts',
    'src/main/sessions/gitexclude.ts', 'src/main/sessions/progress.ts', 'src/main/sessions/summary.ts', 'src/main/sessions/history.ts', 'src/main/review.ts',
    'src/main/recording/controller.ts', 'src/main/recording/stills.ts', 'src/main/trimVideo.ts', 'src/main/failover/service.ts', 'src/main/pipeline/stt/wav.ts', 'src/main/files.ts']

  it('modules that change the project import no mutating fs function (only pinnedDir.ts does)', () => {
    for (const file of PROJECT_MUTATORS) {
      const source = read(file)
      const bad = fsImports(source).filter((name) => name === '*' || MUTATING_FS.includes(name))
      // E2E のゴミ箱の代わり（trashFor）だけは、利用者のゴミ箱の外のフォルダへ動かす
      const allowed = file === 'src/main/fileOps.ts' ? bad.filter((name) => name !== 'rename') : bad
      expect(allowed, file).toEqual([])
      expect(source, file).not.toMatch(/O_CREAT|flag:\s*'w|open\([^)]*'w/)
    }
    const fileOps = read('src/main/fileOps.ts')
    const trashFor = fileOps.slice(fileOps.indexOf('export function trashFor('))
    expect(fileOps.replace(trashFor, '')).not.toMatch(/\brename\(/)
  })

  let base = ''
  let root = ''
  let outside = ''
  beforeEach(async () => {
    base = await mkdtemp(join(tmpdir(), 'ferret-sec5-pinned-'))
    root = join(base, 'project')
    outside = join(base, 'outside')
    await mkdir(join(root, 'a'), { recursive: true })
    await mkdir(outside, { recursive: true })
    await writeFile(join(outside, 'secret.txt'), 'keep')
    await writeFile(join(root, 'a', 'x.txt'), 'x')
  })
  afterEach(async () => { await rm(base, { recursive: true, force: true }) })

  it('a destination that already exists (or appears) is never replaced', async () => {
    await writeFile(join(root, 'a', 'y.txt'), 'theirs')
    const pin = await PinnedDir.open(root, join(root, 'a'))
    try {
      await expect(renameIn(pin, 'x.txt', pin, 'y.txt')).rejects.toMatchObject({ code: 'EEXIST' })
    } finally {
      pin.close()
    }
    expect(await readFile(join(root, 'a', 'y.txt'), 'utf8')).toBe('theirs')
    expect(await readFile(join(root, 'a', 'x.txt'), 'utf8')).toBe('x')
  })

  it('cleanup deletes only the quarantined entry it checked; links inside are removed, not followed', async () => {
    await mkdir(join(root, 'a', 'work'))
    await symlink(outside, join(root, 'a', 'work', 'link'))
    await writeFile(join(root, 'a', 'work', 'f'), '1')
    await removeContained(root, join(root, 'a', 'work'), { recursive: true })
    expect(existsSync(join(root, 'a', 'work'))).toBe(false)
    expect(await readFile(join(outside, 'secret.txt'), 'utf8')).toBe('keep')
    expect((await readdir(join(root, 'a'))).filter((n) => n.startsWith('.ferret-removing-'))).toEqual([])
    // 確かめた実体と違えば消さない
    await mkdir(join(root, 'a', 'other'))
    const pin = await PinnedDir.open(root, join(root, 'a'))
    try {
      const wrong = (await lstat(join(root, 'a', 'x.txt'), { bigint: true }))
      await expect(removeIn(pin, 'other', { recursive: true, expect: { dev: wrong.dev, ino: wrong.ino } })).rejects.toThrow()
    } finally {
      pin.close()
    }
    expect(existsSync(join(root, 'a', 'other'))).toBe(true)
  })

  it('a pinned folder swapped for a link to the outside after the check is refused', async () => {
    const pin = await PinnedDir.open(root, join(root, 'a'))
    try {
      await rm(join(root, 'a'), { recursive: true })
      await symlink(outside, join(root, 'a'))
      await expect(renameIn(pin, 'secret.txt', pin, 'moved.txt')).rejects.toThrow()
    } finally {
      pin.close()
    }
    expect(await readdir(outside)).toEqual(['secret.txt'])
  })

  it('ancestor-swap stress: a concurrent process swapping the folder for a link never makes Ferret change the outside', async () => {
    // 別のプロセスが a と「外を指すリンク」を入れ替え続ける
    const racer = spawn(process.execPath, ['-e', `
      const fs = require('fs'); const p = require('path')
      const a = p.join(${JSON.stringify(root)}, 'a'), real = a + '-real', out = ${JSON.stringify(outside)}
      const end = Date.now() + 1500
      while (Date.now() < end) {
        try { fs.renameSync(a, real); fs.symlinkSync(out, a); fs.unlinkSync(a); fs.renameSync(real, a) } catch {}
      }
    `], { stdio: 'ignore' })
    const exited = new Promise((r) => racer.on('exit', r))
    await mkdir(join(root, 'dest'))
    for (let i = 0; i < 150; i++) {
      await createEntry(root, 'a', `n${i}.txt`, 'file').catch(() => undefined)
      await renameEntry(root, `a/n${i}.txt`, `m${i}.txt`).catch(() => undefined)
      await moveEntries(root, [`a/m${i}.txt`], 'dest').catch(() => undefined)
      await createEntry(root, 'a', `d${i}`, 'directory').catch(() => undefined)
      await removeContained(root, join(root, 'a', `d${i}`), { recursive: true }).catch(() => undefined)
    }
    await exited
    expect(await readdir(outside)).toEqual(['secret.txt'])
    expect(await readFile(join(outside, 'secret.txt'), 'utf8')).toBe('keep')
  }, 30_000)
})
