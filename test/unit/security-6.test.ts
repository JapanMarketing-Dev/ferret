import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { request } from 'node:http'
import { chmodSync, existsSync, readFileSync } from 'node:fs'
import { appendFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DECISION_ENV, type DecisionPreferences } from '@shared/decision'
import { setLocale } from '@shared/i18n'
import { APP_VERSION_PATTERN, OS_RELEASE_PATTERN } from '@shared/feedbackRelay'
import { DecisionRelay, RELAY_MAX_CONCURRENT_PER_TOKEN, RELAY_RESERVE_FLOOR_DIVISOR, type RelayBudget } from '../../src/main/decision/relay'
import { DecisionService } from '../../src/main/decision/service'
import { ProjectLedger } from '../../src/main/decision/projectLedger'
import { CredentialOrigins, authorizeCredentialOrigin } from '../../src/main/credentialOrigin'
import { checkSubmission } from '../../src/main/feedbackRelay'
import { resolveOrganizerCli, spawnText } from '../../src/main/pipeline/organize/spawn'
import { importEntries } from '../../src/main/fileOps'
import type { Env, LimiterStorage } from '../../workers/feedback-relay/src/env'
import { handle } from '../../workers/feedback-relay/src/index'
import { FeedbackLimiter, askLimiter, limiterKey, sourceIdentity } from '../../workers/feedback-relay/src/limiter'
import { PER_SENDER_LIMITS } from '../../workers/feedback-relay/src/limits'
import { buildIssue } from '../../workers/feedback-relay/src/github'
import { literalInline } from '../../workers/feedback-relay/src/redact'

/** 中継が受け付ける最小の System One の依頼（security-7 [7]。形の違う本文は送らずに断る） */
const SYSTEM_ONE_BODY = JSON.stringify({ model: 'm', state: 's', questions: { ok: { type: 'noul' } } })

/**
 * Codex のセキュリティスキャン6回目の [1]〜[8] を、同じ種類のコードが戻ったら落ちる形で止める。
 *   [1] 判定の中継は、最初の依頼（応答をまだ見ていない）でも枠から決めた下限を予約する。量が分からない応答は予約の分で精算する
 *   [2] 合言葉を無効にしたら、受け付け済みで途中の依頼も切る。本文には期限がある。送る直前に合言葉を確かめ直す
 *   [3] 設定（settings.json）の接続先を、初めての起動でも「認めた接続元」に移さない
 *   [4] 中継（Worker）の送り主の枠で断るときは、必ず全体の前処理の予約を戻す（1つの口にまとめる）
 *   [5] Issue の本文の外の行（版・OS）も、送り主の値はコードの中に入れる。版・OS の形も絞る
 *   [6] 整理の CLI（claude / codex）は、プロジェクトの外の信頼できる絶対パスから起動する
 *   [7] 外から取り込むコピーは、写しながら枠を減らし、測った実体と違うものは写さない
 *   [8] プロジェクトのその日の判定の量は main のファイルに残し、起動し直しても空に戻さない
 */

const repo = resolve(__dirname, '../..')
const read = (p: string) => readFileSync(join(repo, p), 'utf8')

beforeEach(() => setLocale('en'))

const UPSTREAM = 'https://decision.example.test/v1/systemone'
const upstreamOf = () => ({ url: UPSTREAM, headers: {}, provider: 'p', model: 'm', timeoutMs: 5000 })
const relayFor = (fetch: typeof globalThis.fetch, budget: Partial<RelayBudget>, extra: Partial<ConstructorParameters<typeof DecisionRelay>[0]> = {}) =>
  new DecisionRelay({ upstream: async () => upstreamOf(), fetch, budget, ...extra })

const post = async (url: string) => {
  const res = await fetch(url, { method: 'POST', body: SYSTEM_ONE_BODY })
  const body = await res.json().catch(() => ({})) as { error_type?: string }
  return { status: res.status, type: body.error_type }
}

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })

/** 本文を途中まで送って止めた依頼。finish で残りを送る */
function partialPost(url: string) {
  const u = new URL(url)
  let status: number | null = null
  let closed = false
  const req = request({ host: u.hostname, port: u.port, path: `${u.pathname}${u.search}`, method: 'POST', headers: { 'content-type': 'application/json', 'content-length': '20' } }, (res) => {
    status = res.statusCode ?? null
    res.resume()
  })
  const done = new Promise<void>((r) => { req.on('close', () => { closed = true; r() }) })
  req.on('error', () => undefined)
  req.write('{"images":')
  return {
    finish: () => { if (!closed) req.end('[] ,"x":1}') },
    done,
    get status() { return status },
    get closed() { return closed }
  }
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

// ───────────────────────── [1] 最初の依頼も予約する ─────────────────────────

describe('security-6 [1] the decision relay reserves a positive amount even before any response was seen', () => {
  it('four concurrent first calls across tokens of one project cannot overshoot the project dollar budget', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    const sent: number[] = []
    const fetch = vi.fn(async () => { sent.push(1); await gate; return json({ provider_metadata: { gateway: { cost: 0.1 } }, usage: { input_tokens: 10 } }) }) as unknown as typeof globalThis.fetch
    // 合言葉の下限は 1.6 / 16 = 0.1 ドル。プロジェクトの枠 0.25 には 2 回分まで
    const relay = relayFor(fetch, { usdPerToken: 1.6, usdPerProjectPerDay: 0.25 })
    await relay.start()
    const urls = Array.from({ length: 4 }, () => relay.urlFor(relay.issue({ projectId: 'p1' })))
    const pending = urls.map((u) => post(u))
    await wait(100)
    release()
    const results = await Promise.all(pending)
    expect(results.filter((r) => r.status === 200)).toHaveLength(2)
    expect(results.filter((r) => r.type === 'relay_project_budget')).toHaveLength(2)
    // 1回 0.1 ドルなので、送った数 × 0.1 が枠 0.25 を超えない
    expect(sent.length * 0.1).toBeLessThanOrEqual(0.25)
    await relay.stop()
  })

  it('a response without usage is charged as its reservation, so it cannot erase the budget', async () => {
    const fetch = vi.fn(async () => json({})) as unknown as typeof globalThis.fetch
    // 下限は 80000 / 16 = 5000 トークン（1回の上限 4871 より大きい。security-7 [7]）。量が無い応答は 5000 ずつ使ったことになる
    const relay = relayFor(fetch, { tokensPerToken: 80_000, callsPerMinute: 1000 })
    await relay.start()
    const url = relay.urlFor(relay.issue())
    let ok = 0
    for (let i = 0; i < 40; i++) {
      const r = await post(url)
      if (r.status !== 200) {
        expect(r.type).toBe('relay_budget_exhausted')
        break
      }
      ok++
    }
    expect(ok).toBe(RELAY_RESERVE_FLOOR_DIVISOR)
    await relay.stop()
  })

  it('every reservation takes the larger of the observed maximum and a floor derived from the budget (shape check)', () => {
    const relay = read('src/main/decision/relay.ts')
    expect(relay).toMatch(/const heldTokens = Math\.max\([^)]*b\.tokensPerToken \/ RELAY_RESERVE_FLOOR_DIVISOR\)/)
    expect(relay).toMatch(/const heldUsd = Math\.max\([^)]*b\.usdPerToken \/ RELAY_RESERVE_FLOOR_DIVISOR\)/)
    expect(relay).toMatch(/tokens: out\.tokens \?\? r\.heldTokens/)
    expect(RELAY_RESERVE_FLOOR_DIVISOR).toBeGreaterThanOrEqual(RELAY_MAX_CONCURRENT_PER_TOKEN)
  })
})

// ───────────────────────── [2] 受け付け済みの依頼も切る ─────────────────────────

describe('security-6 [2] revoking a relay token also cancels requests it already accepted', () => {
  it('closing the terminal mid-body stops the request before the upstream is resolved or anything is sent', async () => {
    const upstream = vi.fn(async () => upstreamOf())
    const fetch = vi.fn(async () => json({})) as unknown as typeof globalThis.fetch
    const relay = new DecisionRelay({ upstream, fetch })
    await relay.start()
    const p = partialPost(relay.urlFor(relay.issue({ sessionId: 't1' })))
    await wait(100)
    relay.revokeSession('t1')
    p.finish()
    await p.done
    await wait(50)
    expect(upstream).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
    expect(p.status).not.toBe(200)
    await relay.stop()
  })

  it('a settings change cancels an accepted request, so it cannot use the new provider or key', async () => {
    const fetch = vi.fn(async () => json({})) as unknown as typeof globalThis.fetch
    const readKey = vi.fn(async () => undefined)
    let prefs: DecisionPreferences = { enabled: true, preset: 'custom', model: 'm', authScheme: 'none', endpoint: 'https://old.example.test/v1/systemone' }
    const service = new DecisionService({ prefs: () => prefs, readKey, getEnv: () => undefined, onCall: () => {}, fetch })
    const url = (await service.launchEnv({ sessionId: 's1' }))[DECISION_ENV.url]!
    const p = partialPost(url)
    await wait(100)
    prefs = { ...prefs, endpoint: 'https://new.example.test/v1/systemone' }
    await service.sync()
    p.finish()
    await p.done
    await wait(50)
    expect(fetch).not.toHaveBeenCalled()
    await service.stop()
  })

  it('an incomplete body is cut after a finite deadline and gives back its concurrency slot', async () => {
    const fetch = vi.fn(async () => json({})) as unknown as typeof globalThis.fetch
    const relay = relayFor(fetch, {}, { bodyTimeoutMs: 200 })
    await relay.start()
    const url = relay.urlFor(relay.issue())
    const stuck = Array.from({ length: RELAY_MAX_CONCURRENT_PER_TOKEN }, () => partialPost(url))
    await wait(50)
    expect((await post(url)).type).toBe('relay_too_many')
    await Promise.all(stuck.map((s) => s.done))
    expect(stuck.every((s) => s.closed)).toBe(true)
    expect(fetch).not.toHaveBeenCalled()
    // 期限で切った依頼は同時の数を返している
    expect((await post(url)).status).toBe(200)
    await relay.stop()
  })

  it('revocation aborts in-flight requests and the token is re-checked before the upstream and before the fetch (shape check)', () => {
    const relay = read('src/main/decision/relay.ts')
    const kill = relay.slice(relay.indexOf('private kill('), relay.indexOf('revoke(token: string)'))
    expect(kill).toMatch(/controller\.abort\(\)/)
    for (const name of ['revoke(token: string): void', 'revokeSession(sessionId: string): void', 'revokeAll(): void']) {
      const body = relay.slice(relay.indexOf(name), relay.indexOf('\n  }', relay.indexOf(name)))
      expect(body).toMatch(/this\.kill\(/)
    }
    expect(relay).not.toMatch(/this\.tokens\.clear\(\)/)
    const forward = relay.slice(relay.indexOf('private async forward('))
    const checks = [...forward.matchAll(/if \(!(?:body \|\| !)?live\(\)\) return none/g)].map((m) => m.index!)
    expect(checks.length).toBeGreaterThanOrEqual(2)
    expect(checks[0]!).toBeLessThan(forward.indexOf('this.opt.upstream()'))
    expect(checks[1]!).toBeLessThan(forward.indexOf('this.doFetch('))
    expect(forward).toMatch(/AbortSignal\.any\(\[signal, AbortSignal\.timeout/)
  })
})

// ───────────────────────── [3] 設定を承認として移さない ─────────────────────────

describe('security-6 [3] settings endpoints are never seeded as credential approval', () => {
  let dir = ''
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'ferret-sec6-origin-')) })
  afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

  it('with no approval file, a settings endpoint is refused without asking; a dialog approval persists only that origin and scope', async () => {
    const file = join(dir, 'credential-origins.json')
    const origins = new CredentialOrigins(file)
    expect('seedOnce' in origins).toBe(false)
    const req = { scope: 'stt:compatible', url: 'https://attacker.example.test/v1', hasCredential: true, defaults: [] }
    expect(await authorizeCredentialOrigin(req, origins)).toEqual({ ok: false, origin: 'https://attacker.example.test' })
    expect(existsSync(file)).toBe(false)
    expect(await authorizeCredentialOrigin({ ...req, url: 'https://stt.example.test/v1' }, origins, async () => true)).toEqual({ ok: true })
    const saved = JSON.parse(await readFile(file, 'utf8')) as { approved: Record<string, string[]> }
    expect(saved.approved).toEqual({ 'stt:compatible': ['https://stt.example.test'] })
  })

  it('main does not copy settings endpoints into the approval store (shape check)', () => {
    expect(read('src/main/index.ts')).not.toMatch(/seedOnce|seed\(/)
    expect(read('src/main/credentialOrigin.ts')).not.toMatch(/async seedOnce|seedOnce\(/)
    // 承認を増やす口は approve（main のダイアログで認めたとき）だけ
    const index = read('src/main/index.ts')
    expect(index).not.toMatch(/\.approve\(/)
  })
})

// ───────────────────────── [4] 送り主の枠で断ったら戻す ─────────────────────────

class MemoryStorage implements LimiterStorage {
  data = new Map<string, unknown>()
  async get<T>(key: string) { return this.data.get(key) as T | undefined }
  async put<T>(key: string, value: T) { this.data.set(key, value) }
  async deleteAll() { this.data.clear() }
  async setAlarm() {}
}

function fakeEnv() {
  const limiters = new Map<string, { storage: MemoryStorage; obj: FeedbackLimiter }>()
  const env = {
    GITHUB_TOKEN: ['fake', 'token'].join('-'),
    RATE_LIMIT_SALT: 'test-salt',
    GITHUB_REPO: 'JapanMarketing-Dev/ferret',
    PUBLIC_BASE: 'https://feedback.example.test',
    MEDIA: { async put() {}, async get() { return null }, async delete() {} },
    LIMITER: {
      idFromName: (name: string) => name,
      get(id: unknown) {
        const name = id as string
        if (!limiters.has(name)) {
          const storage = new MemoryStorage()
          limiters.set(name, { storage, obj: new FeedbackLimiter({ storage } as never) })
        }
        return { fetch: (r: Request) => limiters.get(name)!.obj.fetch(r) }
      }
    }
  } as unknown as Env
  const times = (name: string) => ((limiters.get(name)?.storage.data.get('times') as number[] | undefined) ?? []).length
  return { env, times }
}

describe('security-6 [4] a sender refused by its own submission quota gives back the shared pre-parse reservation', () => {
  const T0 = 1_800_000_000_000
  const noGithub = { fetch: vi.fn(async () => new Response('', { status: 500 })) as unknown as typeof fetch, now: () => T0 }

  it('requests from an IP that used up its sender quota do not consume the shared pre-parse budget', async () => {
    const { env, times } = fakeEnv()
    const ip = '203.0.113.20'
    const ipKey = await limiterKey(env.RATE_LIMIT_SALT, 'ip', sourceIdentity(ip))
    const perSenderMax = Math.min(...PER_SENDER_LIMITS.map((w) => w.max))
    for (let i = 0; i < perSenderMax; i++) await askLimiter(env, ipKey, 'hit', PER_SENDER_LIMITS, T0)
    for (let i = 0; i < 10; i++) {
      const res = await handle(new Request('https://feedback.example.test/v1/issues', { method: 'POST', body: 'x', headers: { 'content-type': 'multipart/form-data; boundary=x', 'cf-connecting-ip': ip } }), env, noGithub)
      expect(res.status).toBe(429)
    }
    expect(times('preparse')).toBe(0)
  })

  it('every sender-quota refusal before the body is read goes through the one helper that releases (shape check)', () => {
    const relay = read('workers/feedback-relay/src/index.ts')
    const start = relay.indexOf("askLimiter(env, 'preparse', 'hit'")
    const end = relay.indexOf('readCapped(request')
    expect(start).toBeGreaterThan(0)
    const beforeBody = relay.slice(relay.indexOf('\n', start), end)
    // 全体の枠そのもので断る1つ（予約できなかった）を除き、rate_limited は refuseBySender の中の1つだけ
    expect(beforeBody.match(/fail\('rate_limited'/g)).toHaveLength(2)
    const helper = beforeBody.slice(beforeBody.indexOf('const refuseBySender'), beforeBody.indexOf('\n  }\n', beforeBody.indexOf('const refuseBySender')))
    expect(helper).toMatch(/askLimiter\(env, 'preparse', 'release'/)
    expect(helper).toMatch(/fail\('rate_limited'/)
    // 送り主の limiter で断る所は、どれも refuseBySender を通す
    for (const m of beforeBody.matchAll(/if \(!(\w+)\.allowed\) (.*)/g)) {
      if (m[1] === 'preparse') continue
      expect(m[2]).toMatch(/^return refuseBySender\(/)
    }
  })
})

// ───────────────────────── [5] 版・OS の行でも参照を作らない ─────────────────────────

/** コードブロック・インラインのコードを除いた、GitHub が読む部分 */
function liveMarkdown(md: string): string {
  return md.replace(/^(`{3,})[^\n]*\n[\s\S]*?\n\1$/gm, '').replace(/(`+)[^`]*?\1/g, '')
}

describe('security-6 [5] feedback metadata cannot create live GitHub references', () => {
  it('reference syntax in every free-form metadata value stays inside literal code', () => {
    const hostile = 'GH-123 #9 @octocat octo/repo#1 https://github.com/x/y/issues/1'
    const issue = buildIssue({ kind: 'bug', title: 'ok', body: 'ok', appVersion: hostile, platform: hostile, osRelease: hostile, arch: hostile, imageUrls: [] })
    const live = liveMarkdown(issue.body)
    expect(live).not.toMatch(/GH-\d/i)
    expect(live).not.toMatch(/#\d/)
    expect(live).not.toMatch(/@[A-Za-z0-9]/)
    expect(live).not.toMatch(/github\.com/i)
    // 本文はコードブロック、版・OS はインラインのコード
    expect(issue.body).toContain('**App:** `')
  })

  it('literalInline keeps backticks in the value from closing the code span', () => {
    expect(literalInline('a`b')).toBe('``a`b``')
    expect(literalInline('`x')).toBe('`` `x ``')
    expect(literalInline('GH-1')).not.toMatch(/GH-\d/)
  })

  it('app version and OS release follow their real grammar on both the app and the relay', () => {
    for (const ok of ['0.4.9', '1.0.0-beta.1', '1.2.3+build.5']) expect(APP_VERSION_PATTERN.test(ok)).toBe(true)
    for (const bad of ['GH-123', 'v1.0.0', '1.0', '0.2.0; rm']) expect(APP_VERSION_PATTERN.test(bad)).toBe(false)
    for (const ok of ['25.6.0', '10.0.26100', '6.8.0-45-generic', '5.15.153.1-microsoft-standard-WSL2']) expect(OS_RELEASE_PATTERN.test(ok)).toBe(true)
    expect(OS_RELEASE_PATTERN.test('GH-123')).toBe(false)
    const sub = { kind: 'bug' as const, title: 't', body: 'b', appVersion: 'GH-123', images: [] }
    expect(checkSubmission(sub)).toBe('invalid_meta')
    const relay = read('workers/feedback-relay/src/index.ts')
    expect(relay).toMatch(/APP_VERSION_PATTERN\.test\(appVersion\)/)
    expect(relay).toMatch(/OS_RELEASE_PATTERN\.test\(osRelease\)/)
  })

  it('buildIssue interpolates no sender value without literalInline (shape check)', () => {
    const github = read('workers/feedback-relay/src/github.ts')
    const fn = github.slice(github.indexOf('export function buildIssue('), github.indexOf('\n}\n', github.indexOf('export function buildIssue(')))
    // Markdown になる行（lines）には、送り主の値を生のまま埋め込まない
    const lines = fn.slice(fn.indexOf('const lines = ['))
    expect(lines).not.toMatch(/\$\{input\.\w+\}/)
    expect(lines).not.toMatch(/\$\{osParts\}/)
    expect(fn).toMatch(/const os = osParts \? literalInline\(osParts\)/)
  })
})

// ───────────────────────── [6] 整理の CLI は信頼できる絶対パスから ─────────────────────────

describe.skipIf(process.platform === 'win32')('security-6 [6] organizer CLIs start only from trusted absolute paths outside the project', () => {
  let root = ''
  let project = ''
  let trusted = ''
  const script = (marker: string, out: string) => `#!/bin/sh\necho ran > "${marker}"\necho ${out}\n`
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'ferret-sec6-cli-'))
    project = join(root, 'project')
    trusted = join(root, 'bin')
    await mkdir(join(project, 'tools'), { recursive: true })
    await mkdir(trusted, { recursive: true })
    for (const name of ['claude', 'codex']) {
      await writeFile(join(project, 'tools', name), script(join(root, `project-${name}-ran`), 'evil'))
      chmodSync(join(project, 'tools', name), 0o755)
    }
  })
  afterEach(async () => { await rm(root, { recursive: true, force: true }) })

  it('a fake claude / codex in the project, first on PATH, is refused and never runs', async () => {
    for (const name of ['claude', 'codex']) {
      const dirs = [join(project, 'tools')]
      expect(await resolveOrganizerCli(name, { project, dirs, env: { PATH: dirs.join(':') } })).toBeNull()
      await expect(spawnText({ binary: name, args: ['--version'], cwd: root, timeoutMs: 5000, project, env: { PATH: dirs.join(':') } },
        { resolve: (b, o) => resolveOrganizerCli(b, { ...o, dirs }) })).rejects.toMatchObject({ kind: 'spawn' })
      expect(existsSync(join(root, `project-${name}-ran`))).toBe(false)
    }
  })

  it('the CLI on a trusted absolute PATH entry is resolved and spawned by its absolute path', async () => {
    await writeFile(join(trusted, 'claude'), script(join(root, 'trusted-ran'), 'hello'))
    chmodSync(join(trusted, 'claude'), 0o755)
    const dirs = [join(project, 'tools'), '.', 'relative/bin', trusted]
    const path = await resolveOrganizerCli('claude', { project, dirs, env: { PATH: dirs.join(':') } })
    expect(path).toMatch(/^\//)
    expect(path!.endsWith('/bin/claude')).toBe(true)
    // 子プロセスの起動はマシンが混んでいると数秒かかることがある（リリースのビルド中に 5 秒を超えた）。通る時間は変わらない
    const r = await spawnText({ binary: 'claude', args: [], cwd: root, timeoutMs: 20_000, project, env: { PATH: '' } },
      { resolve: (b, o) => resolveOrganizerCli(b, { ...o, dirs }) })
    expect(r.stdout.trim()).toBe('hello')
    expect(existsSync(join(root, 'project-claude-ran'))).toBe(false)
  }, 30_000)

  it('spawnText resolves before spawning and the organizer passes the project to both runners (shape check)', () => {
    const spawn = read('src/main/pipeline/organize/spawn.ts')
    const fn = spawn.slice(spawn.indexOf('export async function spawnText('))
    expect(fn.indexOf('resolveOrganizerCli')).toBeGreaterThan(0)
    expect(fn.indexOf('resolveOrganizerCli')).toBeLessThan(fn.indexOf('resolveSpawn('))
    expect(fn).toMatch(/resolveSpawn\(trusted,/)
    const review = read('src/main/review.ts')
    expect(review).toMatch(/new CodexRunner\(\{ project,/)
    expect(review).toMatch(/new ClaudeCodeRunner\(\{ project,/)
  })
})

// ───────────────────────── [7] 取り込みは写しながら枠を減らす ─────────────────────────

describe('security-6 [7] external imports enforce the budget while copying and copy only the measured files', () => {
  let root = ''
  let outside = ''
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'ferret-sec6-import-'))
    outside = await mkdtemp(join(tmpdir(), 'ferret-sec6-source-'))
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
    await rm(outside, { recursive: true, force: true })
  })
  const dropped = () => true

  it('a file that grows after measuring is refused before copying (size and ctime are part of its identity)', async () => {
    const src = join(outside, 'grow.bin')
    await writeFile(src, Buffer.alloc(10))
    await expect(importEntries(root, [src], '', dropped, {
      afterMeasure: () => appendFile(src, Buffer.alloc(4 * 1024 * 1024)),
      budget: { entries: 10, bytes: 1024 * 1024 }
    })).rejects.toThrow(/no longer exists/)
    expect(await readdir(root)).toEqual([])
  })

  it('the budget is enforced while copying and the partial copy is removed', async () => {
    // 測ったあとは変えず、写すときの枠（1 MiB）だけを小さくして、写しながら止まることを確かめる
    const src = join(outside, 'big.bin')
    await writeFile(src, Buffer.alloc(4 * 1024 * 1024))
    await expect(importEntries(root, [src], '', dropped, {
      budget: { entries: 10, bytes: 1024 * 1024 }
    })).rejects.toThrow(/Too much data/)
    expect(await readdir(root)).toEqual([])
  })

  it('a file replaced after measuring is refused (identity mismatch)', async () => {
    const src = join(outside, 'swap.txt')
    await writeFile(src, 'small')
    await expect(importEntries(root, [src], '', dropped, {
      afterMeasure: async () => { await rm(src); await writeFile(src, 'x'.repeat(1000)) }
    })).rejects.toThrow(/no longer exists/)
    expect(await readdir(root)).toEqual([])
  })

  it('an entry added to a folder after measuring is refused and nothing is left behind', async () => {
    const dir = join(outside, 'folder')
    await mkdir(dir)
    await writeFile(join(dir, 'a.txt'), 'a')
    await expect(importEntries(root, [dir], '', dropped, {
      afterMeasure: () => writeFile(join(dir, 'b.txt'), 'b'.repeat(100))
    })).rejects.toThrow(/no longer exists/)
    expect(await readdir(root)).toEqual([])
  })

  it('an unchanged import still copies', async () => {
    const src = join(outside, 'ok.txt')
    await writeFile(src, 'hello')
    const done = await importEntries(root, [src], '', dropped)
    expect(done).toEqual([{ from: 'ok.txt', to: 'ok.txt' }])
    expect(await readFile(join(root, 'ok.txt'), 'utf8')).toBe('hello')
  })

  it('copy loops spend the running budget and check the opened handle identity (shape check)', () => {
    const ops = read('src/main/fileOps.ts')
    const copy = ops.slice(ops.indexOf('async function copyTree('), ops.indexOf('async function copyOrCleanUp('))
    expect(copy).toMatch(/ctx\.budget\.bytes -= bytesRead/)
    expect(copy).toMatch(/assertSameIdentity\(ctx\.expected, source, opened\)/)
    // 取り込み（external）の呼び出しは、どれも測った実体（expected）を渡す
    const calls = [...ops.matchAll(/await copyOrCleanUp\([^\n]*'external'[^\n]*/g)]
    expect(calls.length).toBeGreaterThanOrEqual(2)
    for (const m of calls) expect(m[0]).toMatch(/expected/)
  })
})

// ───────────────────────── [8] プロジェクトの日の枠は起動し直しても残る ─────────────────────────

describe('security-6 [8] daily project decision budgets survive a restart', () => {
  let dir = ''
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'ferret-sec6-ledger-')) })
  afterEach(async () => { await rm(dir, { recursive: true, force: true }) })
  const usage = () => vi.fn(async () => json({ usage: { input_tokens: 10, output_tokens: 0 } })) as unknown as typeof globalThis.fetch

  it('a recreated relay with the same ledger still refuses the project until the day changes', async () => {
    const file = join(dir, 'decision-project-usage.json')
    let now = new Date('2026-10-05T10:00:00')
    const opts = { ledger: new ProjectLedger(file), now: () => now }
    const first = relayFor(usage(), { callsPerProjectPerDay: 2 }, opts)
    await first.start()
    expect((await post(first.urlFor(first.issue({ projectId: 'p1' })))).status).toBe(200)
    expect((await post(first.urlFor(first.issue({ projectId: 'p1' })))).status).toBe(200)
    await first.stop()
    const second = relayFor(usage(), { callsPerProjectPerDay: 2 }, { ledger: new ProjectLedger(file), now: () => now })
    await second.start()
    expect(await post(second.urlFor(second.issue({ projectId: 'p1' })))).toEqual({ status: 429, type: 'relay_project_budget' })
    expect((await post(second.urlFor(second.issue({ projectId: 'p2' })))).status).toBe(200)
    now = new Date('2026-10-06T00:00:01')
    expect((await post(second.urlFor(second.issue({ projectId: 'p1' })))).status).toBe(200)
    await second.stop()
    // 残すのは数だけ
    const saved = JSON.parse(await readFile(file, 'utf8')) as { projects: Record<string, Record<string, unknown>> }
    for (const entry of Object.values(saved.projects)) expect(Object.keys(entry).sort()).toEqual(['calls', 'day', 'maxCallTokens', 'maxCallUsd', 'usd'])
  })

  it('two relays sharing the ledger cannot together exceed the project budget', async () => {
    const file = join(dir, 'decision-project-usage.json')
    const a = relayFor(usage(), { callsPerProjectPerDay: 3 }, { ledger: new ProjectLedger(file) })
    const b = relayFor(usage(), { callsPerProjectPerDay: 3 }, { ledger: new ProjectLedger(file) })
    await a.start()
    await b.start()
    const statuses: number[] = []
    for (let i = 0; i < 6; i++) {
      const relay = i % 2 === 0 ? a : b
      statuses.push((await post(relay.urlFor(relay.issue({ projectId: 'p1' })))).status)
    }
    expect(statuses.filter((s) => s === 200)).toHaveLength(3)
    await a.stop()
    await b.stop()
  })

  it('main wires the ledger into the decision service in userData (shape check)', () => {
    const index = read('src/main/index.ts')
    expect(index).toMatch(/ledger: new ProjectLedger\(join\(app\.getPath\('userData'\), 'decision-project-usage\.json'\)\)/)
  })
})

describe('security-6 [7] file identity does not depend on inode numbers alone', () => {
  it('a file recreated with the same dev and inode (ext4 reuses inodes) is a different file when its ctime or size differs', async () => {
    const { sameFileIdentity } = await import('../../src/main/fileOps')
    const was = { dev: 1n, ino: 42n, size: 5n, ctimeNs: 1_000n }
    expect(sameFileIdentity(was, { ...was })).toBe(true)
    expect(sameFileIdentity(was, { ...was, ctimeNs: 2_000n })).toBe(false)
    expect(sameFileIdentity(was, { ...was, size: 1000n })).toBe(false)
    expect(sameFileIdentity(was, { ...was, ino: 43n })).toBe(false)
  })
})
