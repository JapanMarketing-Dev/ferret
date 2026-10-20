import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  CLOSED_STACK_LIMIT,
  RESTORE_LINE_LIMIT,
  capScrollback,
  claudeProjectDirName,
  fitTotalBudget,
  formatRestoreTime,
  joinWrappedRows,
  panesToResume,
  parseRestoreFile,
  planSessionRestore,
  popClosedTerminal,
  pushClosedTerminal,
  remapRestoreKeys,
  restoreReplayText,
  resumeArgs,
  sanitizeClosedTerminal,
  sanitizeRestoreSnapshot,
  serializeRestoreFile,
  utf8Length,
  type ClosedTerminal,
  type RestorePane,
  type TerminalRestoreSnapshot
} from '../../src/shared/terminalRestore'
import { resolveAgentLaunchPolicy } from '../../src/shared/agentPolicy'
import { TerminalRestoreStore, hasClaudeConversation } from '../../src/main/terminalRestore'
import { isReopenTerminalKey } from '../../src/renderer/terminal/terminalKeys'

const pane = (key: string, patch: Partial<RestorePane> = {}): RestorePane => ({
  key, title: 'zsh', launch: null, cwd: '/work/app', accountId: null, scrollback: '', ...patch
})
const snapshot = (patch: Partial<TerminalRestoreSnapshot> = {}): TerminalRestoreSnapshot => ({
  tabs: [{ key: 'tab1', projectId: 'p1', layout: { type: 'leaf', leafId: 'pane1' }, activePane: 'pane1' }],
  panes: [pane('pane1', { scrollback: 'hello' })],
  activeByProject: { p1: 'tab1' },
  savedAt: 1_700_000_000_000,
  ...patch
})
const closed = (projectId: string | null, key: string, at = 1): ClosedTerminal => ({
  projectId, tab: { key: 'tab1', projectId, layout: { type: 'leaf', leafId: key }, activePane: key }, panes: [pane(key)], closedAt: at
})

describe('画面の文字の上限', () => {
  it('新しい側の行だけを残し、末尾の空行と右の空白を外す', () => {
    const text = Array.from({ length: RESTORE_LINE_LIMIT + 50 }, (_, i) => `line ${i}   `).join('\n') + '\n\n\n'
    const capped = capScrollback(text)
    const lines = capped.split('\n')
    expect(lines).toHaveLength(RESTORE_LINE_LIMIT)
    expect(lines[0]).toBe('line 50')
    expect(lines.at(-1)).toBe(`line ${RESTORE_LINE_LIMIT + 49}`)
  })

  it('大きさの上限を超えたら、行の頭から始まるように前を捨てる（多バイト文字も途中で切らない）', () => {
    const text = Array.from({ length: 100 }, (_, i) => `${i}: ${'あ'.repeat(20)}`).join('\n')
    const capped = capScrollback(text, 2000, 500)
    expect(utf8Length(capped)).toBeLessThanOrEqual(500)
    expect(capped.split('\n')[0]).toMatch(/^\d+: あ+$/)
    expect(capped.endsWith(`99: ${'あ'.repeat(20)}`)).toBe(true)
  })

  it('ESC などの制御文字を落とす（流し直したときに問い合わせ・クリップボード・画面の切り替えが動かない）', () => {
    const capped = capScrollback('ok\u001b]52;c;aGk=\u0007 \u001b[6n done\r\nnext\u009b31m')
    expect(capped).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/)
    expect(capped).toBe('ok]52;c;aGk= [6n done\nnext31m')
  })

  it('折り返しで続く行は1行に戻す', () => {
    expect(joinWrappedRows([
      { text: 'abc', wrapped: false }, { text: 'def  ', wrapped: true }, { text: 'g ', wrapped: false }, { text: 'x', wrapped: true }
    ])).toEqual(['abcdef', 'g x']) // 折り返しの境目の空白は残す（行の途中の空白）
    // 先頭が続きの行でも落とさない
    expect(joinWrappedRows([{ text: 'tail', wrapped: true }])).toEqual(['tail'])
  })

  it('全体の上限: 小さいものはそのまま、大きいものを同じ幅まで削る（新しい側を残す）', () => {
    const big = Array.from({ length: 400 }, (_, i) => `row ${i}`).join('\n')
    const fitted = fitTotalBudget(['small', big, big], 2000)
    expect(fitted[0]).toBe('small')
    expect(fitted.reduce((sum, text) => sum + utf8Length(text), 0)).toBeLessThanOrEqual(2000)
    expect(fitted[1]!.endsWith('row 399')).toBe(true)
    expect(fitTotalBudget(['a', 'b'], 10)).toEqual(['a', 'b'])
  })
})

describe('記録を確かめる', () => {
  it('壊れた分割・知らない Agent・どのタブにも無いペインは捨てる', () => {
    const value = sanitizeRestoreSnapshot({
      tabs: [
        { key: 'tab1', projectId: 'p1', layout: { type: 'split', direction: 'vertical', ratio: 3, first: { type: 'leaf', leafId: 'pane1' }, second: { type: 'leaf', leafId: 'pane2' } }, activePane: 'nope' },
        { key: 'tab2', projectId: 'p1', layout: { type: 'split', direction: 'diagonal', first: null, second: null }, activePane: 'pane3' },
        { key: 'tab3', projectId: 'p1', layout: { type: 'leaf', leafId: 'pane9' }, activePane: 'pane9' },
        { key: '../etc', projectId: 'p1', layout: { type: 'leaf', leafId: 'pane4' }, activePane: 'pane4' }
      ],
      panes: [
        { key: 'pane1', title: 'Claude\u001b[31m', launch: 'claude', cwd: '/w', accountId: 'acc_1', scrollback: 'x\u001b[2J' },
        { key: 'pane2', title: 'sh', launch: 'custom:my-agent', cwd: null, accountId: '../../x' },
        { key: 'pane4', title: 'x', launch: null, cwd: null },
        { key: 'pane5', title: 'stray', launch: null, cwd: null },
        { key: 'pane9', title: 'bad', launch: 'rm -rf', cwd: null }
      ],
      activeByProject: { p1: 'tab1', p2: 'tab2' }
    }, 42)!
    expect(value.tabs.map((tab) => tab.key)).toEqual(['tab1'])
    expect(value.tabs[0]!.activePane).toBe('pane1')
    expect(value.tabs[0]!.layout).toMatchObject({ type: 'split', ratio: 0.95 })
    expect(value.panes.map((p) => p.key)).toEqual(['pane1', 'pane2'])
    expect(value.panes[0]).toMatchObject({ title: 'Claude[31m', launch: 'claude', accountId: 'acc_1', scrollback: 'x[2J' })
    // アカウントの id として読めないものは既定のアカウントに倒す
    expect(value.panes[1]!.accountId).toBeNull()
    expect(value.activeByProject).toEqual({ p1: 'tab1' })
    expect(value.savedAt).toBe(42)
  })

  it('ファイル: 書いて読むと同じ。壊れていれば空', () => {
    const file = { version: 1 as const, session: snapshot(), closed: [closed('p1', 'pane2')] }
    expect(parseRestoreFile(serializeRestoreFile(file))).toEqual(file)
    expect(parseRestoreFile('{not json')).toEqual({ version: 1, session: null, closed: [] })
    expect(parseRestoreFile(JSON.stringify({ version: 2, session: snapshot() }))).toEqual({ version: 1, session: null, closed: [] })
  })

  it('ファイル全体の文字は 5MB まで（開いていたタブと閉じたタブを合わせて）', () => {
    const line = 'x'.repeat(250)
    const huge = Array.from({ length: 2000 }, () => line).join('\n') // 約 500KB
    const panes = Array.from({ length: 8 }, (_, i) => pane(`pane${i + 1}`, { scrollback: huge }))
    const tabs = panes.map((p, i) => ({ key: `tab${i + 1}`, projectId: 'p1', layout: { type: 'leaf' as const, leafId: p.key }, activePane: p.key }))
    const closedOnes = Array.from({ length: 6 }, (_, i) => ({ ...closed('p1', `pane${20 + i}`), panes: [pane(`pane${20 + i}`, { scrollback: huge })] }))
    const text = serializeRestoreFile({ version: 1, session: snapshot({ tabs, panes }), closed: closedOnes })
    const back = parseRestoreFile(text)
    const total = [...back.session!.panes, ...back.closed.flatMap((c) => c.panes)].reduce((sum, p) => sum + utf8Length(p.scrollback), 0)
    expect(total).toBeLessThanOrEqual(5 * 1024 * 1024)
    expect(total).toBeGreaterThan(4 * 1024 * 1024)
  })

  it('閉じたタブの記録も同じ決まりで確かめる', () => {
    expect(sanitizeClosedTerminal({ tab: { key: 'tab1', projectId: 'p1', layout: { type: 'leaf', leafId: 'pane1' } }, panes: [] })).toBeNull()
    expect(sanitizeClosedTerminal(closed('p1', 'pane1', 5))).toEqual(closed('p1', 'pane1', 5))
  })
})

describe('閉じたタブ', () => {
  it(`新しいものから ${CLOSED_STACK_LIMIT} 枚まで覚え、そのプロジェクトの最後のものを取り出す`, () => {
    let stack: ClosedTerminal[] = []
    for (let i = 1; i <= CLOSED_STACK_LIMIT + 3; i++) stack = pushClosedTerminal(stack, closed(i % 2 ? 'p1' : 'p2', `pane${i}`, i))
    expect(stack).toHaveLength(CLOSED_STACK_LIMIT)
    expect(stack[0]!.closedAt).toBe(4)
    const first = popClosedTerminal(stack, 'p2')
    expect(first.entry?.closedAt).toBe(12)
    expect(first.rest).toHaveLength(CLOSED_STACK_LIMIT - 1)
    expect(popClosedTerminal(first.rest, 'p2').entry?.closedAt).toBe(10)
    expect(popClosedTerminal(stack, 'p3')).toEqual({ entry: null, rest: stack })
  })
})

describe('戻す計画', () => {
  it('登録を外したプロジェクトのタブは戻さない（プロジェクトでないフォルダのタブは戻す）', () => {
    const value = snapshot({
      tabs: [
        { key: 'tab1', projectId: 'p1', layout: { type: 'leaf', leafId: 'pane1' }, activePane: 'pane1' },
        { key: 'tab2', projectId: 'gone', layout: { type: 'leaf', leafId: 'pane2' }, activePane: 'pane2' },
        { key: 'tab3', projectId: null, layout: { type: 'leaf', leafId: 'pane3' }, activePane: 'pane3' }
      ],
      panes: [pane('pane1'), pane('pane2'), pane('pane3')],
      activeByProject: { p1: 'tab1', gone: 'tab2' }
    })
    const plan = planSessionRestore(value, new Set(['p1']))!
    expect(plan.tabs.map((tab) => tab.key)).toEqual(['tab1', 'tab3'])
    expect(plan.panes.map((p) => p.key)).toEqual(['pane1', 'pane3'])
    expect(plan.activeByProject).toEqual({ p1: 'tab1' })
    expect(planSessionRestore(value, new Set())).toMatchObject({ tabs: [{ key: 'tab3' }] })
    expect(planSessionRestore(null, new Set(['p1']))).toBeNull()
  })

  it('キーは今の画面と重ならないものに付け替える（分割の形・選択中も合わせる）', () => {
    let n = 100
    const mapped = remapRestoreKeys({
      tabs: [{ key: 'tab1', projectId: 'p1', layout: { type: 'split', direction: 'horizontal', ratio: 0.5, first: { type: 'leaf', leafId: 'pane1' }, second: { type: 'leaf', leafId: 'pane2' } }, activePane: 'pane2' }],
      panes: [pane('pane1'), pane('pane2')],
      activeByProject: { p1: 'tab1' }
    }, (kind) => `${kind}${++n}`)
    expect(mapped.panes.map((p) => p.key)).toEqual(['pane101', 'pane102'])
    expect(mapped.tabs[0]).toMatchObject({ key: 'tab103', activePane: 'pane102', layout: { first: { leafId: 'pane101' }, second: { leafId: 'pane102' } } })
    expect(mapped.activeByProject).toEqual({ p1: 'tab103' })
  })

  it('会話を続けるのは同じ Agent・フォルダ・アカウントの最初の1つだけ。動いているものとも重ねない', () => {
    const panes = [
      pane('pane1', { launch: 'claude' }),
      pane('pane2', { launch: 'claude' }),
      pane('pane3', { launch: 'claude', accountId: 'work' }),
      pane('pane4', { launch: 'codex' }),
      pane('pane5', { launch: 'gemini' }),
      pane('pane6', { launch: null }),
      pane('pane7', { launch: 'codex', cwd: '/other' })
    ]
    expect([...panesToResume(panes)]).toEqual(['pane1', 'pane3', 'pane4', 'pane7'])
    expect([...panesToResume(panes, [{ launch: 'codex', cwd: '/work/app', accountId: null }])]).toEqual(['pane1', 'pane3', 'pane7'])
  })

  it('xterm に書く文字: 前の文字のあとに薄い区切りの行', () => {
    const at = new Date(2026, 9, 5, 9, 7).getTime()
    expect(formatRestoreTime(at)).toBe('2026-10-05 09:07')
    expect(restoreReplayText('a\nb\u001b[2J', '— 前回の続き（2026-10-05 09:07）—')).toBe('a\r\nb[2J\r\n\u001b[0m\u001b[2m— 前回の続き（2026-10-05 09:07）—\u001b[0m\r\n')
    expect(restoreReplayText('', 'x')).toBe('\u001b[0m\u001b[2mx\u001b[0m\r\n')
  })
})

describe('会話を続ける引数', () => {
  it('Claude Code は --continue を最後に、Codex は resume --last を実行ファイルのすぐ後ろに足す', () => {
    expect(resumeArgs('claude', [], ['--chrome'])).toEqual({ lead: [], trail: ['--continue'] })
    expect(resumeArgs('codex', [], ['--yolo'])).toEqual({ lead: ['resume', '--last'], trail: [] })
    expect(resumeArgs('gemini', [], [])).toBeNull()
    expect(resumeArgs('custom:x', [], [])).toBeNull()
  })

  it('別の会話を指す引数・サブコマンドがあれば足さない', () => {
    expect(resumeArgs('claude', [], ['--resume', 'abc'])).toBeNull()
    expect(resumeArgs('claude', [], ['-c'])).toBeNull()
    expect(resumeArgs('claude', [], ['--session-id=1234'])).toBeNull()
    expect(resumeArgs('codex', ['exec'], [])).toBeNull()
    expect(resumeArgs('codex', [], ['resume'])).toBeNull()
  })

  it('起動の決まり（権限確認を省く引数を含む）と一緒に使える', () => {
    const base = { command: '', projectId: null, skipPermissions: true, shell: 'posix' as const }
    expect(resolveAgentLaunchPolicy({ ...base, agent: 'claude', args: '--chrome', resume: true }))
      .toEqual({ ok: true, argv: ['claude', '--dangerously-skip-permissions', '--chrome', '--continue'], trustFolder: false, resumed: true })
    expect(resolveAgentLaunchPolicy({ ...base, agent: 'codex', args: '', resume: true }))
      .toEqual({ ok: true, argv: ['codex', 'resume', '--last', '--dangerously-bypass-approvals-and-sandbox'], trustFolder: false, resumed: true })
    // 頼まなければ今までどおり（resumed は付かない）
    expect(resolveAgentLaunchPolicy({ ...base, agent: 'codex', args: '' }))
      .toEqual({ ok: true, argv: ['codex', '--dangerously-bypass-approvals-and-sandbox'], trustFolder: false })
    // 続けられなければ普通に起動する
    expect(resolveAgentLaunchPolicy({ ...base, agent: 'claude', args: '--resume abc', resume: true }))
      .toEqual({ ok: true, argv: ['claude', '--dangerously-skip-permissions', '--resume', 'abc'], trustFolder: false })
  })

  it('Claude Code の会話のフォルダ名は英数字以外を - にしたもの', () => {
    expect(claudeProjectDirName('/Users/me/ADE_movie_feedback')).toBe('-Users-me-ADE-movie-feedback')
    expect(claudeProjectDirName('C:\\work\\app')).toBe('C--work-app')
  })
})

describe('⌘⇧T / Ctrl+Shift+T', () => {
  const key = (mods: Partial<{ ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean }>, code = 'KeyT') =>
    ({ code, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...mods })
  it('macOS は ⌘⇧T、Windows / Linux は Ctrl+Shift+T。⌘T・Ctrl+T（新しいタブ）とは別', () => {
    expect(isReopenTerminalKey(key({ metaKey: true, shiftKey: true }), 'darwin')).toBe(true)
    expect(isReopenTerminalKey(key({ metaKey: true }), 'darwin')).toBe(false)
    expect(isReopenTerminalKey(key({ ctrlKey: true, shiftKey: true }), 'darwin')).toBe(false)
    expect(isReopenTerminalKey(key({ ctrlKey: true, shiftKey: true }), 'win32')).toBe(true)
    expect(isReopenTerminalKey(key({ ctrlKey: true, shiftKey: true }), 'linux')).toBe(true)
    expect(isReopenTerminalKey(key({ ctrlKey: true }), 'linux')).toBe(false)
    expect(isReopenTerminalKey(key({ ctrlKey: true, shiftKey: true, altKey: true }), 'win32')).toBe(false)
    expect(isReopenTerminalKey(key({ ctrlKey: true, shiftKey: true }, 'KeyD'), 'win32')).toBe(false)
  })
})

describe('TerminalRestoreStore（userData のファイル）', () => {
  const dirs: string[] = []
  const fresh = () => {
    const dir = mkdtempSync(join(tmpdir(), 'terminal-restore-'))
    dirs.push(dir)
    return dir
  }
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })
  const posixOnly = process.platform === 'win32' ? it.skip : it

  posixOnly('書いたファイルは所有者だけが読める。次の起動で1回だけ返す', () => {
    const dir = fresh()
    const file = join(dir, 'terminal-restore.json')
    const store = new TerminalRestoreStore(file, () => true)
    store.save(snapshot())
    store.flushSync()
    expect(statSync(file).mode & 0o777).toBe(0o600)
    const next = new TerminalRestoreStore(file, () => true)
    expect(next.takeSession(new Set(['p1']))).toEqual(snapshot())
    expect(next.takeSession(new Set(['p1']))).toBeNull()
  })

  it('設定が切なら何も覚えず、消すとファイルもなくなる', () => {
    const dir = fresh()
    const file = join(dir, 'terminal-restore.json')
    let on = true
    const store = new TerminalRestoreStore(file, () => on)
    store.save(snapshot())
    store.pushClosed(closed('p1', 'pane2'))
    store.flushSync()
    expect(existsSync(file)).toBe(true)
    on = false
    store.save(snapshot({ savedAt: 1 }))
    store.pushClosed(closed('p1', 'pane3'))
    expect(store.popClosed('p1')).toBeNull()
    expect(new TerminalRestoreStore(file, () => false).takeSession(new Set(['p1']))).toBeNull()
    store.clear()
    expect(existsSync(file)).toBe(false)
  })

  it('閉じたタブを覚え、取り出したものは次の起動で返さない', () => {
    const dir = fresh()
    const file = join(dir, 'terminal-restore.json')
    const store = new TerminalRestoreStore(file, () => true)
    store.pushClosed(closed('p1', 'pane2', 1))
    store.pushClosed(closed('p1', 'pane3', 2))
    expect(store.popClosed('p1')?.closedAt).toBe(2)
    store.flushSync()
    const next = new TerminalRestoreStore(file, () => true)
    expect(next.popClosed('p1')?.closedAt).toBe(1)
    expect(next.popClosed('p1')).toBeNull()
  })

  it('終了で書き終えたあとに届いたものは覚えない', () => {
    const dir = fresh()
    const file = join(dir, 'terminal-restore.json')
    const store = new TerminalRestoreStore(file, () => true)
    store.save(snapshot())
    store.finish()
    store.save(snapshot({ tabs: [], panes: [], activeByProject: {} }))
    store.flushSync()
    expect(new TerminalRestoreStore(file, () => true).takeSession(new Set(['p1']))?.tabs).toHaveLength(1)
  })

  posixOnly('ふだんの書き込みは非同期（flush）。所有者だけが読め、一時ファイルを残さない', async () => {
    const dir = fresh()
    const file = join(dir, 'terminal-restore.json')
    const store = new TerminalRestoreStore(file, () => true)
    store.save(snapshot())
    await store.flush()
    expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(readdirSync(dir)).toEqual(['terminal-restore.json'])
    expect(new TerminalRestoreStore(file, () => true).takeSession(new Set(['p1']))).toEqual(snapshot())
  })

  it('非同期の書き込みの途中で終了しても（flushSync）、最後の中身が残り、途中のもので戻さない', async () => {
    const dir = fresh()
    const file = join(dir, 'terminal-restore.json')
    const store = new TerminalRestoreStore(file, () => true)
    store.save(snapshot({ savedAt: 1 }))
    const pending = store.flush()
    store.save(snapshot({ savedAt: 2 }))
    store.finish()
    await pending
    expect(parseRestoreFile(readFileSync(file, 'utf8')).session?.savedAt).toBe(2)
    expect(readdirSync(dir)).toEqual(['terminal-restore.json'])
  })

  it('非同期の書き込みが終わる前に終了しても、その中身を失わない（同期で書き直す）', async () => {
    const dir = fresh()
    const file = join(dir, 'terminal-restore.json')
    const store = new TerminalRestoreStore(file, () => true)
    store.save(snapshot({ savedAt: 3 }))
    const pending = store.flush()
    store.flushSync()
    expect(parseRestoreFile(readFileSync(file, 'utf8')).session?.savedAt).toBe(3)
    await pending
    expect(parseRestoreFile(readFileSync(file, 'utf8')).session?.savedAt).toBe(3)
  })

  it('非同期の書き込みの途中で消したら、終わったあとにファイルを作り直さない', async () => {
    const dir = fresh()
    const file = join(dir, 'terminal-restore.json')
    const store = new TerminalRestoreStore(file, () => true)
    store.save(snapshot())
    const pending = store.flush()
    store.clear()
    await pending
    expect(existsSync(file)).toBe(false)
    expect(readdirSync(dir)).toEqual([])
  })

  posixOnly('置いてあったリンクの先には書かない・リンクは読まない', () => {
    const dir = fresh()
    const victim = join(dir, 'victim.txt')
    writeFileSync(victim, 'keep')
    const file = join(dir, 'terminal-restore.json')
    symlinkSync(victim, file)
    expect(new TerminalRestoreStore(file, () => true).takeSession(new Set(['p1']))).toBeNull()
    const store = new TerminalRestoreStore(file, () => true)
    store.save(snapshot())
    store.flushSync()
    expect(readFileSync(victim, 'utf8')).toBe('keep')
    expect(parseRestoreFile(readFileSync(file, 'utf8')).session).toEqual(snapshot())
  })

  it('Claude Code の会話があるフォルダだけ --continue で続ける', async () => {
    const config = fresh()
    const cwd = fresh()
    expect(await hasClaudeConversation(cwd, config)).toBe(false)
    const conversations = join(config, 'projects', claudeProjectDirName(cwd))
    mkdirSync(conversations, { recursive: true })
    expect(await hasClaudeConversation(cwd, config)).toBe(false)
    writeFileSync(join(conversations, 'a.jsonl'), '{}\n')
    expect(await hasClaudeConversation(cwd, config)).toBe(true)
  })
})

describe('終了のときの最後の画面の文字（src/main/index.ts）', () => {
  it('終了の手順に入ってから renderer に頼むので、shuttingDown で止まる send() を使わず直接送る（E2E で見つかった、最後の分が書かれない不具合）', () => {
    const main = readFileSync(join(__dirname, '../../src/main/index.ts'), 'utf8')
    // send() は shuttingDown なら何も送らない
    expect(main).toMatch(/function send<C extends IpcEventChannel>\(channel: C, \.\.\.args: Parameters<IpcEvents\[C\]>\): void \{\n {2}if \(shuttingDown\) return/)
    const start = main.indexOf('function collectTerminalRestore()')
    expect(start).toBeGreaterThan(0)
    const block = main.slice(start, main.indexOf('\n}\n', start))
    expect(block).toContain("window.webContents.send('terminal:restoreCollect')")
    expect(block).not.toMatch(/(^|[^.])send\('terminal:restoreCollect'\)/m)
    // 頼むのは beginShutdown が shuttingDown を立てたあと（drainTerminalsAndQuit）
    const shutdown = main.slice(main.indexOf('function beginShutdown(): boolean'), main.indexOf('function drainTerminalsNow(): void'))
    expect(shutdown.indexOf('shuttingDown = true')).toBeGreaterThan(0)
    expect(shutdown.indexOf('collectTerminalRestore()')).toBeGreaterThan(shutdown.indexOf('shuttingDown = true'))
    // 返事（terminal:restoreSave）も、終了の手順に入ってから届く。IPC の受け口はそれだけを通す
    expect(main).toContain("if (shuttingDown && channel !== 'terminal:restoreSave') return null")
    expect(main).not.toMatch(/\n\s+if \(shuttingDown\) return null\n\s+\/\/ アプリの窓の本体のフレーム/)
  })
})
