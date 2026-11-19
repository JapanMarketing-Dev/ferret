/**
 * Agent に人が打った指示を各 Agent の履歴から集める（src/main/agentPrompts.ts）。一時フォルダをホームにして確かめる（本物の履歴は読まない）
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  MAX_PROMPTS_PER_PROJECT,
  cleanPrompt,
  codexSessionCwd,
  collectAgentPrompts,
  parseAntigravityHistory,
  parseClaudeHistory,
  parseCodexHistory,
  parseGeminiLogs,
  projectFor,
  redactHomePaths,
  redactPromptSecrets,
  resetAgentPromptCache
} from '../../src/main/agentPrompts'
import { AGENT_REQUEST_CLOSING, composeAgentRequest } from '../../src/shared/agentRequests'
import { CLOUD_LIMITS } from '../../src/shared/feedbackCloud'
import { renderFeedbackList, type FeedbackEntry } from '../../src/shared/feedbackSkill'
import { en } from '../../src/shared/i18n/en'
import { ja } from '../../src/shared/i18n/ja'

const NOW = Date.parse('2026-11-19T00:00:00Z')
const DAY = 24 * 60 * 60 * 1000
const SID = '01a1d8b8-ef55-7241-82e3-29e50947dca5'

let dir: string
let home: string
beforeEach(async () => {
  resetAgentPromptCache()
  dir = await mkdtemp(join(tmpdir(), 'ferret-prompts-'))
  home = join(dir, 'home')
  await mkdir(home, { recursive: true })
})
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

const jsonl = (rows: unknown[]) => rows.map((r) => JSON.stringify(r)).join('\n') + '\n'

describe('履歴の読み方', () => {
  it('Claude Code: display・timestamp（ミリ秒）・project。壊れた行・形の違う行は飛ばす', () => {
    const text = jsonl([{ display: '文字を減らして', timestamp: NOW, project: '/p/a', pastedContents: {} }, { display: 1, timestamp: NOW, project: '/p' }]) + '{broken\n'
    expect(parseClaudeHistory(text, '/h')).toEqual([{ agent: 'claude', text: '文字を減らして', at: NOW, cwd: '/p/a', file: '/h' }])
  })

  it('Codex: ts は秒・作業フォルダは後から', () => {
    expect(parseCodexHistory(jsonl([{ session_id: SID, ts: NOW / 1000, text: 'テストを足して' }, { ts: 1, text: 'x' }]), '/c')).toEqual([
      { agent: 'codex', text: 'テストを足して', at: NOW, cwd: '', file: '/c', sessionId: SID }
    ])
  })

  it('Codex のセッションの1行目から作業フォルダ（長くて頭で切れていても cwd を拾う）', () => {
    const line = JSON.stringify({ type: 'session_meta', payload: { session_id: SID, cwd: '/p/"a"', base_instructions: 'x'.repeat(100) } })
    expect(codexSessionCwd(line + '\n{}')).toBe('/p/"a"')
    expect(codexSessionCwd(line.slice(0, 120))).toBe('/p/"a"')
    expect(codexSessionCwd('{"type":"x"}')).toBeNull()
  })

  it('Antigravity（CLI）: display・timestamp・workspace', () => {
    expect(parseAntigravityHistory(jsonl([{ display: '並列で', timestamp: NOW, workspace: '/w' }]), '/g')).toEqual([{ agent: 'antigravity', text: '並列で', at: NOW, cwd: '/w', file: '/g' }])
  })

  it('Gemini・Qwen の logs.json: type が user のものだけ', () => {
    const text = JSON.stringify([{ type: 'user', message: '色を減らして', timestamp: '2026-11-18T00:00:00Z' }, { type: 'gemini', message: 'x', timestamp: '2026-11-18T00:00:00Z' }, { type: 'user', message: 'y', timestamp: 'bad' }])
    expect(parseGeminiLogs(text, 'qwen', '/q', '/l')).toEqual([{ agent: 'qwen', text: '色を減らして', at: Date.parse('2026-11-18T00:00:00Z'), cwd: '/q', file: '/l' }])
    expect(parseGeminiLogs('{', 'gemini', '/q', '/l')).toEqual([])
  })
})

describe('捨てる指示・伏せる文字列', () => {
  it('スラッシュコマンド・シェルのモード・タグで包んだ文・計画モードの文を捨てる', () => {
    for (const t of ['/model', '/resume abc', '!ls -la', '<command-name>/clear</command-name>', '<local-command-stdout>ok</local-command-stdout>', 'Implement the following plan:\n# Plan']) {
      expect(cleanPrompt(t), t).toBeNull()
    }
  })

  it('Ferret が入れた文（[Ferret …]・依頼の結び・引き継ぎ・続きから・レビューの送信）を捨てる', () => {
    const samples = [
      '[Ferret visual review] The plan was approved',
      '[Ferret agent mail] from x',
      composeAgentRequest([{ title: 'a', text: 'READMEを直す' }], 'ja', false),
      composeAgentRequest([{ title: 'a', text: 'fix readme' }], 'en', false),
      ja['failover.handoff.readLimit'].replace('{{from}}', 'Claude Code').replace('{{to}}', 'Codex').replace('{{path}}', '/p/.ferret/handoff.md'),
      en['failover.handoff.updateRequest'].replace('{{path}}', '/x'),
      ja['terminal.continueWork'],
      ja['agentPrompt.default'].replace('{{path}}', '/p/f.md').replace('{{progress}}', '/p/p.json')
    ]
    for (const t of samples) expect(cleanPrompt(t), t.slice(0, 30)).toBeNull()
    expect(AGENT_REQUEST_CLOSING.ja.length).toBeGreaterThan(20)
  })

  it('相づち・続けての合図・パスや URL だけの文を捨てる。意味のある指示は残す', () => {
    for (const t of ['はい', 'OK', 'ok!', '続けて', '進めてください', '今どう？', 'どうですか？', 'stop', '1', 'えっと', '[Pasted text #1 +12 lines]', '[Image #1]',
      "'/Users/taro/Desktop/a.png'", 'https://github.com/x/y', '/Users/hanako/b/c.ts', 'git@github.com:x/y.git']) {
      expect(cleanPrompt(t), t).toBeNull()
    }
    expect(cleanPrompt('e2eテストは入れないで')).toBe('e2eテストは入れないで')
    expect(cleanPrompt("'/Users/taro/Desktop/a.png' この余白を詰めて")).toBe("'~/Desktop/a.png' この余白を詰めて")
    expect(cleanPrompt('[Pasted text #1 +3 lines] これを直して')).toBe('これを直して')
  })

  it('秘密に見える文字列とホームのフォルダを伏せ、長い文は切る', () => {
    const key = ['sk', 'ant', 'api03', 'abcdefghijklmnopqrstuvwxyz0123'].join('-')
    const out = cleanPrompt(`このキー ${key} と password=hunter22 で、Bearer abcdefgh12345678 を使って /Users/taro/app を直して`)!
    expect(out).not.toContain(key)
    expect(out).not.toContain('hunter22')
    expect(out).not.toContain('abcdefgh12345678')
    expect(out).not.toContain('taro')
    expect(out).toContain('<secret>')
    expect(redactPromptSecrets('-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----')).toBe('<secret>')
    expect(redactPromptSecrets('パスワードは abc123 です')).toBe('パスワードは <secret> です')
    expect(redactPromptSecrets('https://user:pw@example.com')).toBe('https://<secret>@example.com')
    expect(redactHomePaths('C:\\Users\\taro\\x と /home/taro/y')).toBe('~\\x と ~/y')
    expect(cleanPrompt('直して'.repeat(2000))!.length).toBe(CLOUD_LIMITS.textChars)
  })
})

describe('プロジェクトへの結び付け', () => {
  it('いちばん深いプロジェクト。前方一致だけの別フォルダは入れない', () => {
    const folders = [{ name: 'A', paths: ['/p/a'] }, { name: 'Inner', paths: ['/p/a/sub'] }]
    expect(projectFor('/p/a', folders)).toBe('A')
    expect(projectFor('/p/a/src/x', folders)).toBe('A')
    expect(projectFor('/p/a/sub/y/', folders)).toBe('Inner')
    expect(projectFor('/p/ab', folders)).toBeNull()
    expect(projectFor('/q', folders)).toBeNull()
  })
})

describe('集める', () => {
  async function seed() {
    const a = join(dir, 'a')
    const b = join(dir, 'b')
    await mkdir(a, { recursive: true })
    await mkdir(b, { recursive: true })
    await mkdir(join(home, '.claude'), { recursive: true })
    await writeFile(join(home, '.claude', 'history.jsonl'), jsonl([
      { display: '文字を減らして', timestamp: NOW - DAY, project: a },
      { display: 'サブフォルダでも並列に進めて', timestamp: NOW - 2 * DAY, project: join(a, 'src') },
      { display: '古い指示を直して', timestamp: NOW - 200 * DAY, project: a },
      { display: '登録外のフォルダの指示', timestamp: NOW, project: join(dir, 'other') },
      { display: '/clear', timestamp: NOW, project: a },
      { display: 'はい', timestamp: NOW, project: a }
    ]))
    // Codex（CODEX_HOME を見る）
    const codexHome = join(dir, 'codex')
    await mkdir(join(codexHome, 'sessions', '2026', '11', '18'), { recursive: true })
    await writeFile(join(codexHome, 'history.jsonl'), jsonl([{ session_id: SID, ts: (NOW - DAY) / 1000, text: 'テストは速いものだけにして' }, { session_id: '00000000-0000-0000-0000-000000000000', ts: NOW / 1000, text: 'セッションの無い指示を直して' }]))
    await writeFile(join(codexHome, 'sessions', '2026', '11', '18', `rollout-2026-11-18T00-00-00-${SID}.jsonl`), jsonl([{ type: 'session_meta', payload: { session_id: SID, cwd: b } }]))
    // Antigravity（CLI）
    await mkdir(join(home, '.gemini', 'antigravity-cli'), { recursive: true })
    await writeFile(join(home, '.gemini', 'antigravity-cli', 'history.jsonl'), jsonl([{ display: 'ボタンを大きくして', timestamp: NOW - DAY, workspace: b }]))
    // Gemini（.project_root の名前のフォルダ）と Qwen（作業フォルダの SHA-256 のフォルダ）
    await mkdir(join(home, '.gemini', 'tmp', 'b'), { recursive: true })
    await writeFile(join(home, '.gemini', 'tmp', 'b', '.project_root'), b)
    await writeFile(join(home, '.gemini', 'tmp', 'b', 'logs.json'), JSON.stringify([{ type: 'user', message: 'バナーを消して', timestamp: new Date(NOW - DAY).toISOString() }]))
    const hash = createHash('sha256').update(a).digest('hex')
    await mkdir(join(home, '.qwen', 'tmp', hash), { recursive: true })
    await writeFile(join(home, '.qwen', 'tmp', hash, 'logs.json'), JSON.stringify([{ type: 'user', message: '日本語で答えて', timestamp: new Date(NOW - DAY).toISOString() }]))
    return { a, b, codexHome }
  }

  it('Claude Code・Codex・Antigravity・Gemini・Qwen から、登録したプロジェクトの中の指示だけを新しい順に集める', async () => {
    const { a, b, codexHome } = await seed()
    const out = await collectAgentPrompts([{ name: 'A', folderPath: a }, { name: 'B', folderPath: b }], home, { CODEX_HOME: codexHome }, NOW)
    const got = out.map((e) => `${e.project}|${e.title}|${e.text}`).sort()
    expect(got).toEqual([
      'A|Claude Code|サブフォルダでも並列に進めて',
      'A|Claude Code|文字を減らして',
      'A|Qwen Code|日本語で答えて',
      'B|Antigravity|ボタンを大きくして',
      'B|Codex|テストは速いものだけにして',
      'B|Gemini CLI|バナーを消して'
    ])
    for (const e of out) {
      expect(e.source).toBe('agent-prompt')
      expect(e.file).toBeTruthy()
      expect(Date.parse(e.at!)).toBeGreaterThan(NOW - 3 * DAY)
    }
  })

  it('CLAUDE_CONFIG_DIR を見る。リンクの履歴は読まない', async () => {
    const a = join(dir, 'a')
    await mkdir(a, { recursive: true })
    const cfg = join(dir, 'cfg')
    await mkdir(cfg, { recursive: true })
    await writeFile(join(cfg, 'history.jsonl'), jsonl([{ display: '余白を詰めて', timestamp: NOW, project: a }]))
    expect((await collectAgentPrompts([{ name: 'A', folderPath: a }], home, { CLAUDE_CONFIG_DIR: cfg }, NOW)).map((e) => e.text)).toEqual(['余白を詰めて'])
    resetAgentPromptCache()
    await mkdir(join(home, '.claude'), { recursive: true })
    await symlink(join(cfg, 'history.jsonl'), join(home, '.claude', 'history.jsonl'))
    expect(await collectAgentPrompts([{ name: 'A', folderPath: a }], home, {}, NOW)).toEqual([])
  })

  it('1つのプロジェクトで MAX_PROMPTS_PER_PROJECT 件まで（新しいものから）。変わっていない履歴は前の結果を使う', async () => {
    const a = join(dir, 'a')
    await mkdir(join(home, '.claude'), { recursive: true })
    await mkdir(a, { recursive: true })
    const rows = Array.from({ length: MAX_PROMPTS_PER_PROJECT + 20 }, (_, i) => ({ display: `指示その${i}を直して`, timestamp: NOW - i * 1000, project: a }))
    const file = join(home, '.claude', 'history.jsonl')
    await writeFile(file, jsonl(rows))
    const out = await collectAgentPrompts([{ name: 'A', folderPath: a }], home, {}, NOW)
    expect(out).toHaveLength(MAX_PROMPTS_PER_PROJECT)
    expect(out[0]!.text).toBe('指示その0を直して')
    const again = await collectAgentPrompts([{ name: 'A', folderPath: a }], home, {}, NOW)
    expect(again).toEqual(out)
  })

  it('履歴が無くても投げない・プロジェクトが無ければ空', async () => {
    expect(await collectAgentPrompts([{ name: 'A', folderPath: join(dir, 'none') }], home, {}, NOW)).toEqual([])
    expect(await collectAgentPrompts([], home, {}, NOW)).toEqual([])
  })
})

describe('feedback.md の「Agent に頼み続けていること」', () => {
  const prompt = (text: string, project = 'A', at = '2026-11-10T00:00:00.000Z'): FeedbackEntry => ({ project, source: 'agent-prompt', title: 'Claude Code', at, text, file: '/h/history.jsonl' })

  it('繰り返し出る型・2回以上打った同じ指示・新しい指示を載せ、全体の型にも数える。指摘の一覧には混ぜない', () => {
    const md = renderFeedbackList([
      prompt('e2eテストは入れないで'), prompt('E2E テストは入れないで！', 'B', '2026-11-11T00:00:00.000Z'), prompt('並列で進めて'), prompt('サブエージェントで並列に'),
      { project: 'A', source: 'visual-review', text: '余白がずれてる', file: '/p/x.json' }
    ])
    expect(md).toContain('## What the person keeps asking agents to do')
    expect(md).toContain('### Said more than once')
    expect(md).toMatch(/- 2× \(A, B\) — E2E テストは入れないで！/)
    expect(md).toContain('**Work in parallel** (2 times')
    const recurring = md.slice(md.indexOf('## Recurring themes'), md.indexOf('## What the person keeps'))
    expect(recurring).toContain('Work in parallel')
    const all = md.slice(md.indexOf('## All feedback'))
    expect(all).toContain('余白がずれてる')
    expect(all).not.toContain('並列で進めて')
    expect(md).not.toContain('/h/history.jsonl')
  })

  it('新しい指示は上限の行まで', () => {
    const many = Array.from({ length: 400 }, (_, i) => prompt(`別々の指示その${i}を直して`, 'A', new Date(NOW - i * 1000).toISOString()))
    const md = renderFeedbackList(many)
    const recent = md.slice(md.indexOf('### Recent instructions'), md.indexOf('## All feedback'))
    expect(recent.split('\n').filter((l) => l.startsWith('- '))).toHaveLength(150)
    expect(recent).toContain('(250 older instructions omitted.)')
  })

  it('チームの指示は型にだけ数え、一覧には出さない', () => {
    const md = renderFeedbackList([], undefined, [], { otherDevices: [], teams: [{ name: 'T', entries: [
      { project: 'X', source: 'agent-prompt', text: '並列で進めて', deviceName: 'd', author: 'Bob' },
      { project: 'Y', source: 'agent-prompt', text: 'サブエージェントで並列に', deviceName: 'd', author: 'Bob' }
    ] }] })
    expect(md).toContain('### Recurring in the team')
    expect(md).not.toContain('### Team feedback')
  })
})
