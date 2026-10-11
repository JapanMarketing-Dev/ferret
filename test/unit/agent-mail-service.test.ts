/**
 * Agent どうしの依頼の配送（src/main/agentMail.ts）。本物の一時フォルダの受け口に1通を置き、偽のターミナルへの貼り付けを確かめる
 */
import { existsSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ settings: null as unknown as Record<string, unknown> }))
vi.mock('../../src/main/settings', () => ({ currentSettings: () => state.settings }))
vi.mock('../../src/main/sessions', () => ({ ensureGitExclude: async () => 'no-git' }))

import { AGENT_MAIL_MAGIC, cliInvocation, type AgentMailLaunchRequest } from '../../src/shared/agentMail'
import { DEFAULT_AGENT_PREFERENCES } from '../../src/shared/agentCatalog'
import type { TuiAgent } from '../../src/shared/types'
import { agentMailEnv, agentMailTerminalCreated, initAgentMail, revokeAgentMailSession, stopAgentMail } from '../../src/main/agentMail'

const project = mkdtempSync(join(tmpdir(), 'agent-mail-project-'))
afterAll(() => {
  stopAgentMail()
  rmSync(project, { recursive: true, force: true })
})

interface FakeTab { id: string; cwd: string; title: string; agent: TuiAgent | null; state: string }
let tabs: FakeTab[] = []
let pasted: Array<{ id: string; text: string }> = []
let launches: AgentMailLaunchRequest[] = []
let failFor = new Set<string>()

const fakeTerminals = {
  list: () => tabs.map((t) => ({ id: t.id, pid: 1, cwd: t.cwd, title: t.title, agent: t.agent })),
  agentState: async (id: string) => {
    const tab = tabs.find((t) => t.id === id)
    if (!tab || !tab.agent) return { kind: 'unknown', state: 'unknown', agent: null }
    return { kind: tab.agent === 'claude' ? 'claude-code' : tab.agent === 'codex' ? 'codex' : 'generic', state: tab.state, agent: tab.agent }
  },
  findAgentTerminal: async (agent: TuiAgent, dir: string | null, exclude: string | null) =>
    tabs.find((t) => t.agent === agent && t.id !== exclude && (!dir || t.cwd === dir || t.cwd.startsWith(`${dir}/`)))?.id ?? null,
  sendReview: async (id: string, text: string) => {
    if (failFor.has(id)) return { ok: false, message: 'waiting for a permission' }
    pasted.push({ id, text })
    return { ok: true, message: 'sent' }
  }
}

initAgentMail({ terminals: fakeTerminals as never, launch: (request) => launches.push(request) })

beforeEach(() => {
  state.settings = { agents: { ...DEFAULT_AGENT_PREFERENCES }, projects: [{ id: 'p', folderPath: project }] }
  tabs = []
  pasted = []
  launches = []
  failFor = new Set()
})

async function envFor(id: string): Promise<Record<string, string>> {
  return agentMailEnv(id)
}

let seq = 0
/** CLI と同じく、一時ファイルに書いてから .mail に名前を変える（書きかけを読ませない） */
function drop(path: string, text: string): void {
  writeFileSync(`${path}.tmp`, text)
  renameSync(`${path}.tmp`, path)
}
/** CLI と同じ形の1通を置いて、Ferret の結果（status）を待つ */
async function post(env: Record<string, string>, headers: Record<string, string>, body = ''): Promise<string> {
  const name = `${Date.now()}-${++seq}`
  const lines = [AGENT_MAIL_MAGIC, ...Object.entries({ from: env.FERRET_AGENT_ID ?? '', to: '', 'reply-to': '', file: '', cwd: project, ...headers }).map(([k, v]) => `${k}: ${v}`), '', body]
  drop(join(env.FERRET_AGENT_MAIL!, `${name}.mail`), lines.join('\n'))
  const status = join(env.FERRET_AGENT_MAIL!, `${name}.status`)
  for (let i = 0; i < 400; i++) {
    if (existsSync(status)) {
      const text = readFileSync(status, 'utf8')
      rmSync(status)
      return text.trim()
    }
    await new Promise((r) => setTimeout(r, 25))
  }
  throw new Error('no status')
}

async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (check()) return
    await new Promise((r) => setTimeout(r, 25))
  }
  throw new Error('timed out')
}

describe('タブに渡す環境変数', () => {
  it('タブごとに別の合言葉と CLI。CLI は実行でき、受け口は利用者だけ。CLI のフォルダを PATH に足す', async () => {
    const a = await envFor('t1')
    const b = await envFor('t2')
    expect(a.FERRET_AGENT_ID).not.toBe(b.FERRET_AGENT_ID)
    expect(a.FERRET_AGENT_ID!.length).toBeGreaterThanOrEqual(16)
    expect(a.FERRET_AGENT_MAIL).toBe(b.FERRET_AGENT_MAIL)
    expect(existsSync(a.FERRET_AGENT_CLI!)).toBe(true)
    if (process.platform !== 'win32') {
      expect(statSync(a.FERRET_AGENT_CLI!).mode & 0o111).not.toBe(0)
      expect(statSync(join(a.FERRET_AGENT_MAIL!, '..')).mode & 0o077).toBe(0)
    }
    expect(a.FERRET_AGENT_CLI).not.toBe(b.FERRET_AGENT_CLI)
    expect(a.FERRET_AGENT_BIN).toBe(join(a.FERRET_AGENT_CLI!, '..'))
    // CLI に合言葉が書き込まれている（環境変数を消す Agent の中でも動く）
    expect(readFileSync(a.FERRET_AGENT_CLI!, 'utf8')).toContain(a.FERRET_AGENT_ID!)
    // 閉じたタブの CLI は消す
    revokeAgentMailSession('t2')
    await until(() => !existsSync(b.FERRET_AGENT_CLI!))
    // 名前に KEY・SECRET・TOKEN を含めない（Codex がコマンドに渡さない）
    for (const key of Object.keys(a)) expect(key).not.toMatch(/KEY|SECRET|TOKEN/)
  })

  it('切なら何も渡さない', async () => {
    state.settings = { ...state.settings, agents: { ...DEFAULT_AGENT_PREFERENCES, agentMail: false } }
    expect(await envFor('t3')).toEqual({})
  })
})

describe('依頼を届ける・返事を返す', () => {
  it('置かれた依頼は見張りの知らせですぐ読む（ゆっくりの読み直し 2 秒を待たない）', async () => {
    tabs = [{ id: 'fast-from', cwd: project, title: 'claude', agent: 'claude', state: 'idle' }, { id: 'fast-to', cwd: project, title: 'codex', agent: 'codex', state: 'idle' }]
    const env = await envFor('fast-from')
    // 見張りが始まるまで（初めの1通の前に受け口を作る）
    await new Promise((r) => setTimeout(r, 50))
    const started = Date.now()
    const status = await post(env, { kind: 'send', to: 'codex' }, 'check this')
    expect(status).toMatch(/^ok/)
    expect(Date.now() - started).toBeLessThan(1500)
    // 貼り終えるまで待つ（次のテストの貼り付けに混ざらないように）
    await until(() => pasted.some((p) => p.id === 'fast-to'))
  })

  it('同じプロジェクトの Codex のタブへ貼り、Codex の返事を Claude Code のタブへ貼る。続けて頼むと同じタブへ', async () => {
    tabs = [
      { id: 'c1', cwd: project, title: 'Claude Code', agent: 'claude', state: 'working' },
      { id: 'x1', cwd: project, title: 'Codex', agent: 'codex', state: 'idle' }
    ]
    const claude = await envFor('c1')
    const codex = await envFor('x1')
    const status = await post(claude, { kind: 'send', to: 'codex' }, 'Run a security review of src/auth')
    expect(status).toMatch(/^ok: request #(\d+) is being delivered to Codex \(Ferret terminal "Codex"\)/)
    const number = Number(/#(\d+)/.exec(status)![1])
    await until(() => pasted.length === 1)
    expect(pasted[0]!.id).toBe('x1')
    expect(pasted[0]!.text).toContain(`[Ferret agent mail #${number}] Request from Claude Code`)
    expect(pasted[0]!.text).toContain('Run a security review of src/auth')
    // 返し方は Codex のタブの CLI の絶対パスで
    expect(pasted[0]!.text).toContain(`${cliInvocation(codex.FERRET_AGENT_CLI!, process.platform)} reply ${number} --file`)
    const replyPath = /write your full result .* to (\S+) ,/.exec(pasted[0]!.text)![1]!
    expect(replyPath.startsWith(join(project, '.ferret', 'agent-mail'))).toBe(true)
    expect(existsSync(join(project, '.ferret', 'agent-mail'))).toBe(true)

    writeFileSync(replyPath, '# 2 issues')
    const replied = await post(codex, { kind: 'reply', 'reply-to': String(number), file: replyPath }, '2 issues found')
    expect(replied).toContain(`ok: your reply to #${number} is being pasted into Claude Code`)
    await until(() => pasted.length === 2)
    expect(pasted[1]).toMatchObject({ id: 'c1' })
    expect(pasted[1]!.text).toContain(`[Ferret agent mail #${number} reply] Codex`)
    expect(pasted[1]!.text).toContain(`Result file: ${replyPath}`)
    expect(pasted[1]!.text).toContain('2 issues found')
    expect(pasted[1]!.text).toContain(`${cliInvocation(claude.FERRET_AGENT_CLI!, process.platform)} send codex`)

    // 別の Codex のタブが増えても、続けて頼めば前と同じタブへ
    tabs = [{ id: 'x0', cwd: project, title: 'Codex 0', agent: 'codex', state: 'idle' }, ...tabs]
    await post(claude, { kind: 'send', to: 'codex' }, 're-check after my fixes')
    await until(() => pasted.length === 3)
    expect(pasted[2]!.id).toBe('x1')
  })

  it('長い本文はファイルに書き、貼るのは頭と場所だけ', async () => {
    tabs = [
      { id: 'c2', cwd: project, title: 'Claude Code', agent: 'claude', state: 'idle' },
      { id: 'x2', cwd: project, title: 'Codex', agent: 'codex', state: 'idle' }
    ]
    const claude = await envFor('c2')
    const long = `${'a'.repeat(5000)}END`
    await post(claude, { kind: 'send', to: 'codex' }, long)
    await until(() => pasted.length === 1)
    expect(pasted[0]!.text.length).toBeLessThan(2500)
    const file = /The full request is in (\S+) \./.exec(pasted[0]!.text)![1]!
    expect(readFileSync(file, 'utf8').trim()).toBe(long)
  })

  it('同じ Agent どうし（Claude Code → 別の Claude Code）にも届く。自分には送らない', async () => {
    tabs = [
      { id: 'c3', cwd: project, title: 'Claude A', agent: 'claude', state: 'idle' },
      { id: 'c4', cwd: project, title: 'Claude B', agent: 'claude', state: 'idle' }
    ]
    const a = await envFor('c3')
    await post(a, { kind: 'send', to: 'claude' }, 'x')
    await until(() => pasted.length === 1)
    expect(pasted[0]!.id).toBe('c4')
  })

  it('相手が居なければ送り手の隣に開いてもらい、準備ができたら貼る', async () => {
    tabs = [{ id: 'c5', cwd: project, title: 'Claude Code', agent: 'claude', state: 'idle' }]
    const claude = await envFor('c5')
    const status = await post(claude, { kind: 'send', to: 'gemini' }, 'check the tests')
    expect(status).toContain('opening Gemini CLI in a new Ferret terminal')
    await until(() => launches.length === 1)
    expect(launches[0]).toMatchObject({ agent: 'gemini', cwd: project, fromTerminalId: 'c5' })
    // renderer が開いた（起動中はまだ準備ができていない）
    tabs.push({ id: 'g1', cwd: project, title: 'Gemini CLI', agent: 'gemini', state: 'working' })
    agentMailTerminalCreated('g1', { size: { cols: 80, rows: 24 }, agentMailToken: launches[0]!.token })
    await new Promise((r) => setTimeout(r, 600))
    expect(pasted).toEqual([])
    tabs[1]!.state = 'idle'
    await until(() => pasted.length === 1)
    expect(pasted[0]!.id).toBe('g1')
    expect(pasted[0]!.text).toContain('check the tests')
  })

  it('別のプロジェクトのタブには届けず、新しく開く', async () => {
    tabs = [
      { id: 'c6', cwd: project, title: 'Claude Code', agent: 'claude', state: 'idle' },
      { id: 'x6', cwd: '/elsewhere', title: 'Codex', agent: 'codex', state: 'idle' }
    ]
    const claude = await envFor('c6')
    await post(claude, { kind: 'send', to: 'codex' }, 'x')
    await until(() => launches.length === 1)
    expect(pasted).toEqual([])
  })

  it('貼れなかったら（許可の確認中など）送り手に理由を貼る', async () => {
    tabs = [
      { id: 'c7', cwd: project, title: 'Claude Code', agent: 'claude', state: 'idle' },
      { id: 'x7', cwd: project, title: 'Codex', agent: 'codex', state: 'blocked' }
    ]
    const claude = await envFor('c7')
    failFor = new Set(['x7'])
    const status = await post(claude, { kind: 'send', to: 'codex' }, 'x')
    const number = /#(\d+)/.exec(status)![1]
    await until(() => pasted.length === 1)
    expect(pasted[0]).toEqual({ id: 'c7', text: `[Ferret agent mail #${number}] Could not deliver to Codex: waiting for a permission` })
  })
})

describe('断る', () => {
  it('知らない合言葉・閉じたタブの合言葉', async () => {
    tabs = [{ id: 'c8', cwd: project, title: 'Claude Code', agent: 'claude', state: 'idle' }]
    const env = await envFor('c8')
    expect(await post({ ...env, FERRET_AGENT_ID: 'zzzzzzzzzzzzzzzzzzzzzzzz' }, { kind: 'send', to: 'codex' }, 'x')).toMatch(/^error: this terminal is not known/)
    revokeAgentMailSession('c8')
    expect(await post(env, { kind: 'send', to: 'codex' }, 'x')).toMatch(/^error: this terminal is not known/)
    expect(pasted).toEqual([])
    expect(launches).toEqual([])
  })

  it('知らない宛先・無効にした Agent', async () => {
    tabs = [{ id: 'c9', cwd: project, title: 'Claude Code', agent: 'claude', state: 'idle' }]
    const env = await envFor('c9')
    expect(await post(env, { kind: 'send', to: 'nobody' }, 'x')).toMatch(/^error: unknown agent "nobody"/)
    state.settings = { ...state.settings, agents: { ...DEFAULT_AGENT_PREFERENCES, disabledAgents: ['codex'] } }
    expect(await post(env, { kind: 'send', to: 'codex' }, 'x')).toMatch(/^error: Codex is turned off/)
  })

  it('知らない番号・自分宛てでない依頼への返事', async () => {
    tabs = [
      { id: 'c10', cwd: project, title: 'Claude Code', agent: 'claude', state: 'idle' },
      { id: 'x10', cwd: project, title: 'Codex', agent: 'codex', state: 'idle' },
      { id: 'x11', cwd: project, title: 'Codex 2', agent: 'codex', state: 'idle' }
    ]
    const claude = await envFor('c10')
    const other = await envFor('x11')
    expect(await post(other, { kind: 'reply', 'reply-to': '999999' }, 'x')).toMatch(/^error: request #999999 is not known/)
    const status = await post(claude, { kind: 'send', to: 'codex' }, 'x')
    const number = /#(\d+)/.exec(status)![1]
    await until(() => pasted.length === 1)
    expect(pasted[0]!.id).toBe('x10')
    expect(await post(other, { kind: 'reply', 'reply-to': number! }, 'x')).toBe(`error: request #${number} was not sent to this terminal.`)
    // 送り手が閉じていれば返せない
    const codex = await envFor('x10')
    tabs = tabs.filter((t) => t.id !== 'c10')
    expect(await post(codex, { kind: 'reply', 'reply-to': number! }, 'x')).toBe(`error: the terminal that sent request #${number} is closed.`)
  })

  it('壊れた1通・大きすぎる1通・切のとき', async () => {
    tabs = [{ id: 'c12', cwd: project, title: 'Claude Code', agent: 'claude', state: 'idle' }]
    const env = await envFor('c12')
    const mailbox = env.FERRET_AGENT_MAIL!
    drop(join(mailbox, 'bad-1.mail'), 'hello')
    drop(join(mailbox, 'big-1.mail'), `${AGENT_MAIL_MAGIC}\nkind: send\nfrom: ${env.FERRET_AGENT_ID}\nto: codex\n\n${'x'.repeat(300 * 1024)}`)
    await until(() => existsSync(join(mailbox, 'bad-1.status')) && existsSync(join(mailbox, 'big-1.status')))
    expect(readFileSync(join(mailbox, 'bad-1.status'), 'utf8')).toMatch(/^error: not an agent mail file/)
    expect(readFileSync(join(mailbox, 'big-1.status'), 'utf8')).toMatch(/^error: the message could not be read/)
    rmSync(join(mailbox, 'bad-1.status'))
    rmSync(join(mailbox, 'big-1.status'))
    // 名前の決まりに合わないファイルは読まない・消さない
    writeFileSync(join(mailbox, '.x.tmp'), 'partial')
    state.settings = { ...state.settings, agents: { ...DEFAULT_AGENT_PREFERENCES, agentMail: false } }
    expect(await post(env, { kind: 'send', to: 'codex' }, 'x')).toMatch(/^error: agent mail is turned off/)
    expect(readdirSync(mailbox)).toContain('.x.tmp')
    rmSync(join(mailbox, '.x.tmp'))
  })

  it('1時間の上限を超えたら断る', async () => {
    tabs = [
      { id: 'c13', cwd: project, title: 'Claude Code', agent: 'claude', state: 'idle' },
      { id: 'x13', cwd: project, title: 'Codex', agent: 'codex', state: 'idle' }
    ]
    initAgentMail({ terminals: fakeTerminals as never, launch: (request) => launches.push(request), maxPerHour: 3 })
    try {
      const env = await envFor('c13')
      const results: string[] = []
      for (let i = 0; i < 4; i++) results.push(await post(env, { kind: 'send', to: 'codex' }, `#${i}`))
      expect(results.slice(0, 3).filter((r) => !r.startsWith('ok:'))).toEqual([])
      expect(results[3]).toMatch(/^error: too many agent mails/)
      // ほかのタブは数えない
      tabs.push({ id: 'c14', cwd: project, title: 'Claude 2', agent: 'claude', state: 'idle' })
      expect(await post(await envFor('c14'), { kind: 'send', to: 'codex' }, 'x')).toMatch(/^ok:/)
    } finally {
      initAgentMail({ terminals: fakeTerminals as never, launch: (request) => launches.push(request), maxPerHour: 60 })
    }
  })
})
