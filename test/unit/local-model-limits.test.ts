/**
 * 端末内・LAN のモデル（Ollama の clef / clef-flash など）には Ferret の枠をかけない（2026-10-12 本人の指摘
 * 「clef などのローカルモデルなのに、レートリミットの制限があって使えなかった」）。
 *   - 判定（@shared/localModels の isLocalModelEndpoint・launchUsesLocalModel・agentUsesLocalModel）の境界と異常な値
 *   - 判定の中継（src/main/decision/relay.ts）: ローカルなら回数・1分あたり・トークン・費用・プロジェクトの1日の枠をかけない。クラウドは今までどおり
 *   - 文字起こしの費用の上限（src/main/pipeline/stt）: ローカルのサーバーには上限なし
 *   - 上限での自動切り替え（src/main/failover/plan.ts）: ローカルの Agent は上限・使用量で外さない
 * 本物のサーバー・CLI は使わない。
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { agentUsesLocalModel, isLocalHostname, isLocalModelEndpoint, launchUsesLocalModel } from '@shared/localModels'
import { DEFAULT_AGENT_PREFERENCES } from '@shared/agentCatalog'
import { DEFAULT_LIMIT_FAILOVER } from '@shared/failover'
import { DECISION_ENV, type DecisionPreferences } from '@shared/decision'
import { setLocale } from '@shared/i18n'
import type { AgentPreferences } from '@shared/types'
import { DecisionRelay, RELAY_MAX_CONCURRENT_LOCAL, RELAY_MAX_CONCURRENT_PER_TOKEN, type RelayBudget } from '../../src/main/decision/relay'
import { DecisionService } from '../../src/main/decision/service'
import { budgetPricing, FALLBACK_PRICING, isLocalEndpoint } from '../../src/main/decision/requestBound'
import { costLimitForEndpoint, exceedsCostLimit } from '../../src/main/pipeline/stt/endpoint'
import { createSttEngine } from '../../src/main/pipeline/stt/cloud'
import { writeWavFile } from '../../src/main/pipeline/stt/wav'
import { limitKey, nearLimitTabs, planFailover, usableAccounts, type PlanInput, type RunningTab } from '../../src/main/failover/plan'

beforeEach(() => setLocale('en'))

describe('isLocalModelEndpoint: 端末内・LAN の接続先か', () => {
  it('この PC（ループバック）を指す URL は true', () => {
    for (const url of [
      'http://localhost:11434/v1/systemone',
      'HTTP://LOCALHOST:11434/v1',
      'http://localhost./v1',
      'http://ollama.localhost:11434',
      'http://127.0.0.1:1234/v1',
      'http://127.9.8.7/',
      'http://[::1]:11434/v1',
      'http://[::ffff:127.0.0.1]:11434',
      'http://2130706433/', // 127.0.0.1 の10進の書き方（URL が直す）
      'http://0x7f.1/',
      'http://0.0.0.0:11434'
    ]) expect(isLocalModelEndpoint(url), url).toBe(true)
  })

  it('LAN・Tailscale・mDNS・点の無いホスト名は true', () => {
    for (const url of [
      'http://10.0.0.5:11434',
      'http://172.16.0.1', 'http://172.31.255.255',
      'http://192.168.1.20:1234/v1',
      'http://169.254.10.10',
      'http://100.64.0.1', 'http://100.104.17.26:11434', 'http://100.127.255.255',
      'http://gpu-pc.local:11434',
      'http://nas.lan/v1',
      'http://box.home.arpa',
      'http://host.docker.internal:11434',
      'https://ubuntu-server.tail1234.ts.net/v1',
      'http://ubuntu-server:11434/v1',
      'http://[fd12:3456::1]:11434',
      'http://[fe80::1]/'
    ]) expect(isLocalModelEndpoint(url), url).toBe(true)
  })

  it('クラウドと、境界のすぐ外の IP は false', () => {
    for (const url of [
      'https://api.openai.com/v1/decisions',
      'https://api.cloudflare.com/client/v4/accounts/{account_id}/ai/run/@cf/cloudflare/clef-flash',
      'https://ai-gateway.vercel.sh/typesafe/v1/systemone',
      'http://8.8.8.8/',
      'http://172.15.255.255', 'http://172.32.0.1',
      'http://192.169.0.1',
      'http://100.63.255.255', 'http://100.128.0.1',
      'http://169.253.0.1',
      'http://11.0.0.1',
      'http://[2001:db8::1]/',
      'http://[::ffff:8.8.8.8]/',
      'http://localhost.example.com/',
      'http://example.local.attacker.com/',
      'http://api.mylocal.com/v1'
    ]) expect(isLocalModelEndpoint(url), url).toBe(false)
  })

  it('空・壊れた URL・http(s) 以外は false（クラウドとみなし、枠を残す）', () => {
    for (const url of [undefined, null, '', '   ', 'not a url', 'localhost:11434', 'file:///tmp/x', 'ftp://localhost/', 'ws://localhost:11434', 'http://999.1.1.1/'] as const) {
      expect(isLocalModelEndpoint(url), String(url)).toBe(false)
    }
  })

  it('ホスト名だけの判定（角括弧・末尾の点・大文字）', () => {
    expect(isLocalHostname('[::1]')).toBe(true)
    expect(isLocalHostname('LocalHost.')).toBe(true)
    expect(isLocalHostname('')).toBe(false)
    expect(isLocalHostname('   ')).toBe(false)
    expect(isLocalHostname('1.2.3')).toBe(false)
    expect(isLocalHostname('api.anthropic.com')).toBe(false)
  })

  it('判定の中継の費用の見込みも同じ判定を使う（LAN も費用 0。クラウドは高めの既定のまま）', () => {
    expect(isLocalEndpoint('http://192.168.1.20:11434/v1/systemone')).toBe(true)
    expect(budgetPricing('http://192.168.1.20:11434/v1/systemone', undefined)).toEqual({ inputPer1M: 0, outputPer1M: 0 })
    expect(budgetPricing('https://api.example.test/x', undefined)).toEqual(FALLBACK_PRICING)
  })
})

describe('launchUsesLocalModel / agentUsesLocalModel: Agent が端末内・LAN のモデルで動くか', () => {
  it('ローカルのモデルを動かす CLI・引数・URL を拾う', () => {
    expect(launchUsesLocalModel('ollama', 'launch claude')).toBe(true)
    expect(launchUsesLocalModel('ollama run clef', '')).toBe(true)
    expect(launchUsesLocalModel('/opt/homebrew/bin/ollama', 'launch codex')).toBe(true)
    expect(launchUsesLocalModel('C:\\Program Files\\Ollama\\ollama.exe', 'launch claude')).toBe(true)
    expect(launchUsesLocalModel('lms', 'chat')).toBe(true)
    expect(launchUsesLocalModel('llama-server', '-m model.gguf')).toBe(true)
    expect(launchUsesLocalModel('codex', '--oss')).toBe(true)
    expect(launchUsesLocalModel('codex', '--oss --local-provider lmstudio')).toBe(true)
    expect(launchUsesLocalModel('codex', '-c model_provider=ollama')).toBe(true)
    expect(launchUsesLocalModel('codex', '-c model_provider="lmstudio"')).toBe(true)
    expect(launchUsesLocalModel('aider', '--model ollama_chat/qwen3:8b')).toBe(true)
    expect(launchUsesLocalModel('aider', '--model=ollama/clef')).toBe(true)
    expect(launchUsesLocalModel('ANTHROPIC_BASE_URL=http://localhost:11434 claude', '--chrome')).toBe(true)
    expect(launchUsesLocalModel('ANTHROPIC_BASE_URL=http://localhost:11434 claude', null)).toBe(true)
    expect(launchUsesLocalModel('opencode', '--base-url "http://192.168.1.20:11434/v1"')).toBe(true)
  })

  it('クラウドのままの起動・空・似た名前は false', () => {
    expect(launchUsesLocalModel('claude', '--chrome')).toBe(false)
    expect(launchUsesLocalModel('codex', '')).toBe(false)
    expect(launchUsesLocalModel('gemini', undefined)).toBe(false)
    expect(launchUsesLocalModel('', '')).toBe(false)
    expect(launchUsesLocalModel(null, null)).toBe(false)
    expect(launchUsesLocalModel('myollama', '')).toBe(false)
    expect(launchUsesLocalModel('codex', '--model gpt-oss-120b')).toBe(false)
    expect(launchUsesLocalModel('codex', '--ossify')).toBe(false)
    expect(launchUsesLocalModel('/Users/me/ollama/bin/claude', '')).toBe(false)
    expect(launchUsesLocalModel('ANTHROPIC_BASE_URL=https://api.anthropic.com claude', '')).toBe(false)
    expect(launchUsesLocalModel('claude', '--base-url https://gateway.example.com')).toBe(false)
  })

  const prefs = (patch: Partial<AgentPreferences> = {}): AgentPreferences => ({ ...DEFAULT_AGENT_PREFERENCES, ...patch })

  it('組み込みの起動の設定・カスタムの Agent・受け継いだ接続先の環境変数から決める', () => {
    expect(agentUsesLocalModel('claude', prefs())).toBe(false)
    expect(agentUsesLocalModel('codex', prefs({ launch: { ...DEFAULT_AGENT_PREFERENCES.launch, codex: { command: 'codex', args: '--oss' } } }))).toBe(true)
    const custom = prefs({ customAgents: [{ id: 'custom:clef', name: 'Clef', command: 'ollama', args: 'launch claude --model clef' }] })
    expect(agentUsesLocalModel('custom:clef', custom)).toBe(true)
    expect(agentUsesLocalModel('custom:none', custom)).toBe(false)
    expect(agentUsesLocalModel('claude', prefs(), { ANTHROPIC_BASE_URL: 'http://127.0.0.1:11434' })).toBe(true)
    expect(agentUsesLocalModel('claude', prefs(), { ANTHROPIC_BASE_URL: 'https://api.anthropic.com' })).toBe(false)
    // ほかの Agent の変数では決めない
    expect(agentUsesLocalModel('codex', prefs(), { ANTHROPIC_BASE_URL: 'http://127.0.0.1:11434' })).toBe(false)
    expect(agentUsesLocalModel('codex', prefs(), { OPENAI_BASE_URL: 'http://localhost:1234/v1' })).toBe(true)
    expect(agentUsesLocalModel('gemini', prefs(), { GOOGLE_GEMINI_BASE_URL: 'http://gpu.local:8080' })).toBe(true)
  })

  it('壊れた・古い形の設定でも落ちない', () => {
    expect(agentUsesLocalModel('claude', null)).toBe(false)
    expect(agentUsesLocalModel('custom:x', undefined)).toBe(false)
    expect(agentUsesLocalModel('claude', { launch: {} as AgentPreferences['launch'], customAgents: undefined as unknown as [] })).toBe(false)
  })
})

// ───────────────────────── 判定の中継 ─────────────────────────

const SYSTEM_ONE_BODY = JSON.stringify({ model: 'm', state: 's', questions: { ok: { type: 'noul' } } })
const LOCAL_URL = 'http://localhost:11434/v1/systemone'
const CLOUD_URL = 'https://decision.example.test/v1/systemone'
/** Ollama の応答には量が無い（予約の分で数えると、すぐに枠を使い切っていた） */
const noUsage = () => vi.fn(async () => new Response('{"done":{"true":0.9}}', { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof globalThis.fetch
const TINY: Partial<RelayBudget> = { callsPerToken: 2, callsPerMinute: 1, tokensPerToken: 80_000, usdPerToken: 100, callsPerProjectPerDay: 1, usdPerProjectPerDay: 100 }

const post = async (url: string) => {
  const res = await fetch(url, { method: 'POST', body: SYSTEM_ONE_BODY })
  const body = await res.json().catch(() => ({})) as { error_type?: string }
  return { status: res.status, type: body.error_type }
}

const relayFor = (url: string, local: (() => boolean) | undefined, fetch = noUsage(), budget = TINY) =>
  new DecisionRelay({ upstream: async () => ({ url, headers: {}, provider: 'ollama', model: 'clef-flash', timeoutMs: 5000 }), fetch, budget, ...(local ? { localUpstream: local } : {}) })

describe('判定の中継: ローカルのモデルには枠をかけない', () => {
  it('ローカルなら、回数・1分あたり・トークン・費用・プロジェクトの1日の枠を超えても送る', async () => {
    const fetch = noUsage()
    const relay = relayFor(LOCAL_URL, () => true, fetch)
    await relay.start()
    try {
      const url = relay.urlFor(relay.issue({ projectId: 'p1' }))
      for (let i = 0; i < 12; i++) expect(await post(url), `call ${i}`).toEqual({ status: 200, type: undefined })
      // 別の合言葉でも、同じプロジェクトの1日の枠で止まらない
      expect((await post(relay.urlFor(relay.issue({ projectId: 'p1' })))).status).toBe(200)
      expect(fetch).toHaveBeenCalledTimes(13)
    } finally {
      await relay.stop()
    }
  })

  it('クラウドは今までどおり枠で断る（同じ小さい枠）', async () => {
    const relay = relayFor(CLOUD_URL, () => false)
    await relay.start()
    try {
      const url = relay.urlFor(relay.issue({ projectId: 'p1' }))
      expect((await post(url)).status).toBe(200)
      const second = await post(url)
      expect(second.status).toBe(429)
      expect(second.type).toMatch(/^relay_/)
    } finally {
      await relay.stop()
    }
  })

  it('受け付けたときはローカルでも、実際の接続先がクラウドなら送る前に枠で数える', async () => {
    const fetch = noUsage()
    const relay = relayFor(CLOUD_URL, () => true, fetch)
    await relay.start()
    try {
      const url = relay.urlFor(relay.issue({ projectId: 'p1' }))
      expect((await post(url)).status).toBe(200)
      expect((await post(url)).status).toBe(429)
      expect(fetch).toHaveBeenCalledTimes(1)
    } finally {
      await relay.stop()
    }
  })

  it('ローカルかを読めない（例外）・指定の無い中継は、枠をかける側に倒す', async () => {
    for (const local of [() => { throw new Error('settings') }, undefined]) {
      const relay = relayFor(CLOUD_URL, local)
      await relay.start()
      try {
        const url = relay.urlFor(relay.issue())
        expect((await post(url)).status).toBe(200)
        expect((await post(url)).status).toBe(429)
      } finally {
        await relay.stop()
      }
    }
  })

  it('ローカルでも、合言葉の無い・違う依頼と形の違う本文は今までどおり断る', async () => {
    const relay = relayFor(LOCAL_URL, () => true)
    await relay.start()
    try {
      const url = relay.urlFor(relay.issue())
      expect((await fetch(url.replace(/t=[^&]+/, 't=wrong'), { method: 'POST', body: SYSTEM_ONE_BODY })).status).toBe(401)
      expect((await fetch(url, { method: 'POST', body: '{"model":"m","extra":1}' })).status).toBe(400)
    } finally {
      await relay.stop()
    }
  })

  it('同時の数は、ローカルではメモリを守る上限（RELAY_MAX_CONCURRENT_LOCAL）まで送れる', async () => {
    expect(RELAY_MAX_CONCURRENT_LOCAL).toBeGreaterThan(RELAY_MAX_CONCURRENT_PER_TOKEN)
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => { release = r })
    const upstreamFetch = vi.fn(async () => { await gate; return new Response('{}', { status: 200 }) }) as unknown as typeof globalThis.fetch
    const relay = relayFor(LOCAL_URL, () => true, upstreamFetch)
    await relay.start()
    try {
      const url = relay.urlFor(relay.issue())
      // クラウドの上限（4）を超えて同時に送れる
      const inflight = Array.from({ length: RELAY_MAX_CONCURRENT_LOCAL }, () => fetch(url, { method: 'POST', body: SYSTEM_ONE_BODY }))
      await new Promise((r) => setTimeout(r, 150))
      expect((await post(url)).type).toBe('relay_too_many')
      release()
      expect((await Promise.all(inflight)).map((r) => r.status)).toEqual(Array(RELAY_MAX_CONCURRENT_LOCAL).fill(200))
      expect((await post(url)).status).toBe(200)
    } finally {
      release()
      await relay.stop()
    }
  })

  it('DecisionService: Ollama の既定（localhost の clef-flash）は、量の無い応答が続いても合言葉を使い切らない', async () => {
    const fetch = noUsage()
    const prefs: DecisionPreferences = { enabled: true, preset: 'ollama', model: 'clef' }
    const service = new DecisionService({ prefs: () => prefs, readKey: async () => undefined, getEnv: () => undefined, onCall: () => {}, fetch })
    try {
      const url = (await service.launchEnv({ projectId: 'p1' }))[DECISION_ENV.url]!
      // 以前は量の無い応答を1回 125 万トークンとして数え、16回で relay_budget_exhausted になっていた
      for (let i = 0; i < 40; i++) expect((await post(url)).status, `call ${i}`).toBe(200)
      expect(fetch).toHaveBeenCalledTimes(40)
    } finally {
      await service.stop()
    }
  })

  it('DecisionService: Cloudflare で動かす clef（クラウド）は今までどおり枠で数える', async () => {
    const fetch = noUsage()
    const prefs: DecisionPreferences = { enabled: true, preset: 'cloudflare', accountId: 'acc', authScheme: 'none', model: 'clef' }
    const service = new DecisionService({ prefs: () => prefs, readKey: async () => undefined, getEnv: () => undefined, onCall: () => {}, fetch })
    try {
      const url = (await service.launchEnv())[DECISION_ENV.url]!
      const statuses: number[] = []
      for (let i = 0; i < 20; i++) statuses.push((await post(url)).status)
      // 量の無い応答は予約の分（枠の 1/16）で数えるので、16回で使い切り、理由を返してから合言葉を無効にする
      expect(statuses.slice(0, 16)).toEqual(Array(16).fill(200))
      expect(statuses[16]).toBe(429)
      expect(statuses.slice(17)).toEqual([401, 401, 401])
    } finally {
      await service.stop()
    }
  })
})

// ───────────────────────── 文字起こしの費用の上限 ─────────────────────────

describe('文字起こし: ローカルのサーバーには費用の上限をかけない', () => {
  it('costLimitForEndpoint: ローカルは上限なし（null）、クラウド・読めない URL は設定のまま', () => {
    expect(costLimitForEndpoint('http://localhost:8000', 1)).toBeNull()
    expect(costLimitForEndpoint('http://192.168.1.20:8000/v1', 0.5)).toBeNull()
    expect(costLimitForEndpoint('http://localhost:8000', undefined)).toBeNull()
    expect(costLimitForEndpoint('https://api.openai.com/v1', 1)).toBe(1)
    expect(costLimitForEndpoint('https://api.openai.com/v1', undefined)).toBeUndefined()
    expect(costLimitForEndpoint('https://api.openai.com/v1', null)).toBeNull()
    expect(costLimitForEndpoint('', 2)).toBe(2)
    expect(costLimitForEndpoint(undefined, 2)).toBe(2)
    expect(costLimitForEndpoint('not a url', 2)).toBe(2)
    // 上限なしは、どれだけ使っても超えない
    expect(exceedsCostLimit(1e9, 1e9, costLimitForEndpoint('http://localhost:8000', 0.01))).toBe(false)
  })

  let dir = ''
  let wavPath = ''
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ferret-local-stt-'))
    wavPath = join(dir, 'c.wav')
    await writeWavFile(wavPath, new Int16Array(1600), 16_000)
  })
  afterEach(async () => {
    vi.unstubAllGlobals()
    await rm(dir, { recursive: true, force: true })
  })
  const chunk = (durationMs: number) => ({ wavPath, offsetMs: 0, speaker: 'self' as const, source: 'mic' as const, durationMs })

  it('互換のサーバーがこの PC・LAN なら、長い録音でも費用の上限で止めない。クラウドの互換サーバーは止める', async () => {
    const calls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string) => { calls.push(url); return new Response('{"text":"ok"}', { status: 200, headers: { 'content-type': 'application/json' } }) }))
    for (const baseUrl of ['http://localhost:8000', 'http://gpu:8000', 'http://192.168.1.20:8000']) {
      const engine = createSttEngine({ provider: 'compatible', endpoint: { baseUrl, model: 'whisper' }, maxCostUsd: 0.01 })
      await expect(engine.transcribeChunk(chunk(10 * 3600_000)), baseUrl).resolves.toBeTruthy()
    }
    expect(calls).toHaveLength(3)
    const cloud = createSttEngine({ provider: 'compatible', endpoint: { baseUrl: 'https://stt.example.com', model: 'whisper' }, maxCostUsd: 0.01 })
    await expect(cloud.transcribeChunk(chunk(10 * 3600_000))).rejects.toThrow()
    expect(calls).toHaveLength(3)
  })
})

// ───────────────────────── 上限での自動切り替え ─────────────────────────

function planInput(overrides: Partial<PlanInput> = {}): PlanInput {
  return {
    prefs: DEFAULT_LIMIT_FAILOVER,
    from: { agent: 'claude', accountId: null },
    accounts: {
      claude: [
        { accountId: null, signedIn: true, usedPercent: 100, active: true },
        { accountId: 'a', signedIn: true, usedPercent: 99, active: false }
      ],
      codex: [{ accountId: null, signedIn: true, usedPercent: 100, active: true }]
    },
    available: new Set(['claude', 'codex', 'antigravity']),
    limited: new Map(),
    now: 1_000_000,
    ...overrides
  }
}

describe('上限での自動切り替え: ローカルのモデルで動く Agent は上限で外さない', () => {
  it('ローカルの Agent が上限らしい知らせを出しても、切り替え先を選ばない', () => {
    expect(planFailover(planInput())).toEqual({ agent: 'antigravity' })
    expect(planFailover(planInput({ local: new Set(['claude']) }))).toBeNull()
  })

  it('切り替え先がローカルの Agent なら、使用量のしきい値・上限とみなした時刻で外さない', () => {
    const limited = new Map([[limitKey({ agent: 'codex', accountId: null }), 2_000_000], [limitKey({ agent: 'antigravity' }), 2_000_000]])
    // クラウドのままなら codex（100%・上限中）も antigravity（上限中）も選べない
    expect(planFailover(planInput({ limited, accounts: { claude: [{ accountId: null, signedIn: true, usedPercent: 100, active: true }], codex: [{ accountId: null, signedIn: true, usedPercent: 100, active: true }] } }))).toBeNull()
    expect(planFailover(planInput({ limited, local: new Set(['codex']), accounts: { claude: [{ accountId: null, signedIn: true, usedPercent: 100, active: true }], codex: [{ accountId: null, signedIn: true, usedPercent: 100, active: true }] } })))
      .toEqual({ agent: 'codex', accountId: null })
    expect(planFailover(planInput({ limited, local: new Set(['antigravity']), accounts: { claude: [{ accountId: null, signedIn: true, usedPercent: 100, active: true }], codex: [] } })))
      .toEqual({ agent: 'antigravity' })
  })

  it('usableAccounts: ローカルでもログインしていないアカウントは使わない', () => {
    const input = planInput({ local: new Set(['claude']), accounts: { claude: [{ accountId: 'x', signedIn: false, usedPercent: 0, active: false }, { accountId: 'y', signedIn: true, usedPercent: 100, active: true }], codex: [] } })
    expect(usableAccounts(input, 'claude').map((a) => a.accountId)).toEqual(['y'])
    expect(usableAccounts({ ...input, local: undefined }, 'claude')).toEqual([])
  })

  it('上限の手前の引き継ぎは、ローカルの Agent のタブを除く', () => {
    const tabs: RunningTab[] = [
      { id: 't1', cwd: '/a', agent: 'claude', accountId: null },
      { id: 't2', cwd: '/b', agent: 'codex', accountId: null }
    ]
    const used = () => 99
    expect(nearLimitTabs(tabs, used, 98, new Set(), new Set()).map((t) => t.id)).toEqual(['t1', 't2'])
    expect(nearLimitTabs(tabs, used, 98, new Set(), new Set(), new Set(['codex'])).map((t) => t.id)).toEqual(['t1'])
    expect(nearLimitTabs(tabs, used, 98, new Set(), new Set(), new Set(['claude', 'codex']))).toEqual([])
  })
})
