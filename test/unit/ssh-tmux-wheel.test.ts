/**
 * SSH のタブ（リモートの tmux の中）のホイールとコピーモード。
 *   - tmux のセッションだけマウスを有効にする（無効だと xterm.js がホイールを ↑↓ のキーにして送り、Agent の入力の履歴が出る）
 *   - Ferret が打ち込む前（Agent への送信・スマホのキー・起動の行）にコピーモードを抜ける（入ったままだと貼り付けと Enter を tmux が受け取る）。
 *     抜けた直後とコピーモードの間の判定は、tmux から取った今の画面で行う（renderer の画面は上へ戻した位置のまま）
 *   - 右ボタンの報告は tmux に渡さない（押したまま動かして離すと、tmux のメニューの Kill などが動く）
 * node-pty と ssh は差し替える。本物の tmux の結合テストは、Linux で tmux と script があるときだけ専用のソケットで動かす
 * （利用者の tmux には触れない: TMUX を渡さず、TMUX_TMPDIR を一時フォルダにし、tmux は -L を付けるラッパー経由）
 */
import { execFile, execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_AGENT_PREFERENCES } from '../../src/shared/agentCatalog'
import { delay } from '../../src/shared/delay'
import { remoteShellCommand, tmuxLeaveCopyModeCommand } from '../../src/shared/sshCommand'
import { dropRightButtonReports, hasMouseReport } from '../../src/main/tmuxInput'
import type { SshRunner } from '../../src/main/remoteFiles'

vi.mock('electron', () => ({ app: { getPath: () => tmpdir(), getAppPath: () => tmpdir(), isPackaged: false } }))
vi.mock('../../src/main/telemetry', () => ({ reportMainError: vi.fn() }))
const state = vi.hoisted(() => ({ events: [] as string[], ptys: [] as Array<{ writes: string[]; emit: (data: string) => void }> }))
vi.mock('../../src/main/agentDetection', () => ({ searchDirs: async () => [], shellPathIsProvisional: () => false }))
vi.mock('../../src/main/accounts', () => ({
  buildAccountLoginLaunch: () => ({ argv: ['claude', 'auth', 'login', '--claudeai'], env: {}, title: 'Claude Code login' }),
  resolveAgentEnv: () => ({}),
  resolveAgentEnvForAccount: () => ({}),
  tabAccountId: () => undefined
}))
vi.mock('../../src/main/settings', () => ({
  currentSettings: () => ({ agents: { ...DEFAULT_AGENT_PREFERENCES, startupAgents: [] }, projects: [] })
}))
vi.mock('node-pty', () => ({
  spawn: () => {
    let listener: ((data: string) => void) | null = null
    const pty = { writes: [] as string[], emit: (data: string) => listener?.(data) }
    state.ptys.push(pty)
    return {
      // macOS・Linux の PID の上限より大きい、実在しない値
      pid: 4_200_000 + state.ptys.length,
      // 前面のプロセス（SSH のタブでは手元の ssh）。シェルでなければ、開いたときの Agent とみなされる
      process: 'ssh',
      cols: 80,
      rows: 24,
      onData: (cb: (data: string) => void) => { listener = cb; return { dispose: () => {} } },
      onExit: () => ({ dispose: () => {} }),
      write: (data: string) => { pty.writes.push(data); state.events.push(`write:${JSON.stringify(data)}`) },
      resize: () => {},
      kill: () => {},
      pause: () => {},
      resume: () => {}
    }
  }
}))

const root = resolve(__dirname, '../..')
const read = (p: string) => readFileSync(join(root, p), 'utf8')
const posixOnly = process.platform === 'win32' ? it.skip : it
const REMOTE = { host: 'dev-box', path: '/srv/acme-shop' }
const SIZE = { cols: 80, rows: 24 }

afterEach(() => {
  vi.restoreAllMocks()
  state.events.length = 0
})

describe('tmux への入力（main/tmuxInput.ts）', () => {
  it('マウスの報告（SGR）を含むか', () => {
    expect(hasMouseReport('\x1b[<64;10;5M')).toBe(true)
    expect(hasMouseReport('\x1b[<0;1;1m')).toBe(true)
    expect(hasMouseReport('abc\x1b[<65;3;4Mdef')).toBe(true)
    expect(hasMouseReport('hello')).toBe(false)
    expect(hasMouseReport('\x1b[A')).toBe(false)
    expect(hasMouseReport('\x1b[<64;10')).toBe(false)
  })

  it('右ボタン（押す・離す・押したままの移動・修飾キー付き）だけを落とし、ほかの報告とキーはそのまま順番どおり残す', () => {
    for (const right of ['\x1b[<2;5;5M', '\x1b[<2;5;5m', '\x1b[<34;6;7M', '\x1b[<10;5;5M', '\x1b[<18;5;5M', '\x1b[<26;5;5m', '\x1b[<42;9;9M']) {
      expect(dropRightButtonReports(right), JSON.stringify(right)).toBe('')
    }
    // 左・中・左のドラッグ・ボタンなしの移動・ホイール（上下左右）・8 番以降のボタン
    for (const keep of ['\x1b[<0;5;5M', '\x1b[<0;5;5m', '\x1b[<1;5;5M', '\x1b[<32;5;5M', '\x1b[<35;5;5M', '\x1b[<64;5;5M', '\x1b[<65;5;5M', '\x1b[<66;5;5M', '\x1b[<67;5;5M', '\x1b[<130;5;5M']) {
      expect(dropRightButtonReports(keep), JSON.stringify(keep)).toBe(keep)
    }
    expect(dropRightButtonReports('a\x1b[<64;1;1M\x1b[<2;1;1Mb\x1b[<2;1;1m\x1b[<65;1;1Mc')).toBe('a\x1b[<64;1;1Mb\x1b[<65;1;1Mc')
    expect(dropRightButtonReports('plain text \x1b[A')).toBe('plain text \x1b[A')
  })
})

describe('SSH のタブ: Ferret が打ち込む前に tmux のコピーモードを抜ける（TerminalManager）', () => {
  /** 戻した SSH の Agent のタブ（つなぎ直し。起動の行は打ち込まない） */
  async function reattachedAgentTab() {
    const { TerminalManager } = await import('../../src/main/terminal')
    const proto = TerminalManager.prototype as unknown as { tmuxExists: () => Promise<boolean | null> }
    const exists = vi.spyOn(proto, 'tmuxExists').mockResolvedValue(true)
    const manager = new TerminalManager(() => {}, () => {})
    manager.setRemote(REMOTE)
    const tab = await manager.create({ size: SIZE, agent: 'claude', tmuxToken: 'abcd1234' })
    exists.mockRestore()
    expect(tab.reattached).toBe(true)
    return { manager, tab, pty: state.ptys.at(-1)! }
  }

  posixOnly('入力: SSH のタブでは右ボタンの報告を tmux に渡さない（ホイール・左クリック・キーは渡す）。手元のタブはそのまま', async () => {
    const { manager, tab, pty } = await reattachedAgentTab()
    manager.write(tab.id, '\x1b[<2;20;10M')
    manager.write(tab.id, '\x1b[<34;22;12M')
    manager.write(tab.id, '\x1b[<2;22;12m')
    expect(pty.writes).toEqual([])
    manager.write(tab.id, '\x1b[<64;20;10M')
    manager.write(tab.id, '\x1b[<0;20;10M\x1b[<0;20;10m')
    manager.write(tab.id, 'hi')
    expect(pty.writes).toEqual(['\x1b[<64;20;10M', '\x1b[<0;20;10M\x1b[<0;20;10m', 'hi'])
    manager.setRemote(null)
    const local = await manager.create({ size: SIZE })
    const localPty = state.ptys.at(-1)!
    manager.write(local.id, '\x1b[<2;20;10M')
    expect(localPty.writes).toEqual(['\x1b[<2;20;10M'])
    manager.disposeAll()
  })

  posixOnly('スマホのキー（writeKey）: SSH のタブは抜けてから書き、抜けるのが遅くても順番どおり。手元のタブはすぐ書く', async () => {
    const remoteFiles = await import('../../src/main/remoteFiles')
    const waits = [120, 0, 0]
    const leave = vi.spyOn(remoteFiles, 'leaveTmuxCopyMode').mockImplementation(async (host, session) => {
      state.events.push(`leave:${host}:${session}`)
      await delay(waits.shift() ?? 0)
      return null
    })
    const { manager, tab, pty } = await reattachedAgentTab()
    // ↓ ↓ Enter を続けて押した（最初の抜けるのが遅い）
    await Promise.all([manager.writeKey(tab.id, '\x1b[B'), manager.writeKey(tab.id, '\x1b[B'), manager.writeKey(tab.id, '\r')])
    expect(pty.writes).toEqual(['\x1b[B', '\x1b[B', '\r'])
    expect(leave).toHaveBeenCalledTimes(3)
    expect(leave.mock.calls[0]![1]).toMatch(/^ferret-acme-shop-[0-9a-f]{8}-abcd1234$/)
    expect(state.events.filter((e) => e.startsWith('leave:')).length).toBe(3)
    // 1つ目の write の前に抜けている
    expect(state.events.findIndex((e) => e.startsWith('leave:'))).toBeLessThan(state.events.findIndex((e) => e.startsWith('write:')))
    // 確かめられたら、またマウスを使うまでは ssh を動かさない
    leave.mockResolvedValueOnce({ left: false, screen: '' })
    await manager.writeKey(tab.id, '1')
    await manager.writeKey(tab.id, '2')
    expect(leave).toHaveBeenCalledTimes(4)
    manager.write(tab.id, '\x1b[<64;10;10M')
    await manager.writeKey(tab.id, '3')
    expect(leave).toHaveBeenCalledTimes(5)
    expect(pty.writes.slice(-4)).toEqual(['1', '2', '\x1b[<64;10;10M', '3'])
    manager.setRemote(null)
    const local = await manager.create({ size: SIZE })
    const localPty = state.ptys.at(-1)!
    await manager.writeKey(local.id, 'y')
    expect(localPty.writes).toEqual(['y'])
    expect(leave).toHaveBeenCalledTimes(5)
    await manager.writeKey('t999', 'y')
    manager.disposeAll()
  })

  posixOnly('今の画面（liveScreenText）: SSH のタブは tmux から取る（取れなければ renderer の画面）。手元のタブは renderer の画面', async () => {
    const remoteFiles = await import('../../src/main/remoteFiles')
    const capture = vi.spyOn(remoteFiles, 'captureTmuxPane').mockResolvedValueOnce('live bottom').mockResolvedValueOnce(null)
    const { manager, tab } = await reattachedAgentTab()
    // 上へ戻した位置の画面（昔の上限の知らせ）
    manager.updateScreen(tab.id, "You've hit your session limit · resets 3:45pm")
    expect(await manager.liveScreenText(tab.id)).toBe('live bottom')
    expect(capture.mock.calls[0]![0]).toBe('dev-box')
    expect(await manager.liveScreenText(tab.id)).toBe("You've hit your session limit · resets 3:45pm")
    manager.setRemote(null)
    const local = await manager.create({ size: SIZE })
    manager.updateScreen(local.id, 'local screen')
    expect(await manager.liveScreenText(local.id)).toBe('local screen')
    expect(capture).toHaveBeenCalledTimes(2)
    manager.disposeAll()
  })

  posixOnly('送信: 先にコピーモードを抜け、tmux から取った今の画面で判定してから貼り付けと Enter を送る（上へ戻した位置の画面で断らない）', async () => {
    const remoteFiles = await import('../../src/main/remoteFiles')
    const { manager, tab } = await reattachedAgentTab()
    // 上へ戻した位置の画面（renderer が知らせたもの）には、昔の確認の表示が見えている
    manager.updateScreen(tab.id, 'Do you want to proceed?\n❯ 1. Yes\n  2. No')
    vi.spyOn(remoteFiles, 'leaveTmuxCopyMode').mockImplementation(async (host, session) => {
      state.events.push(`leave:${host}:${session}`)
      // 抜ける前に始まった renderer の知らせ（上へ戻した位置の画面）が、抜けたあとに遅れて届く
      setTimeout(() => {
        state.events.push('stale screen')
        manager.updateScreen(tab.id, 'Do you want to proceed?\n❯ 1. Yes\n  2. No\n[3/120]')
      }, 0)
      return { left: true, screen: 'live\n✻ Working… (4s · esc to interrupt)' }
    })
    const result = await manager.sendReview(tab.id, 'Read feedback.md')
    expect(result).toMatchObject({ ok: true, submitted: true })
    expect(state.events[0]).toMatch(/^leave:dev-box:ferret-acme-shop-[0-9a-f]{8}-abcd1234$/)
    const paste = state.events.findIndex((e) => e.includes('Read feedback.md'))
    const enter = state.events.lastIndexOf('write:"\\r"')
    expect(paste).toBeGreaterThan(0)
    expect(enter).toBeGreaterThan(paste)
    // 遅れて届いた古い画面は Enter の前の確かめ（sendToAgent の④）より前に届いているが、今の画面を上書きしていない
    expect(state.events.indexOf('stale screen')).toBeGreaterThan(0)
    expect(state.events.indexOf('stale screen')).toBeLessThan(enter)
    expect(manager.screenText(tab.id)).toContain('esc to interrupt')
    manager.disposeAll()
  })

  posixOnly('抜けたあと tmux の画面を使うのはしばらくだけ。過ぎたら renderer の知らせに戻る', async () => {
    const remoteFiles = await import('../../src/main/remoteFiles')
    vi.spyOn(remoteFiles, 'leaveTmuxCopyMode').mockResolvedValue({ left: true, screen: 'live from tmux' })
    const { manager, tab } = await reattachedAgentTab()
    await manager.writeKey(tab.id, 'y')
    expect(manager.screenText(tab.id)).toBe('live from tmux')
    manager.updateScreen(tab.id, 'stale copy-mode view')
    expect(manager.screenText(tab.id)).toBe('live from tmux')
    const later = Date.now() + 2000
    vi.spyOn(Date, 'now').mockReturnValue(later)
    manager.updateScreen(tab.id, 'renderer again')
    expect(manager.screenText(tab.id)).toBe('renderer again')
    manager.disposeAll()
  })

  posixOnly('送信: 上へ戻した位置の画面のまま抜けられなければ、今まで通りその画面で判定する（確認待ちなら断る）', async () => {
    const remoteFiles = await import('../../src/main/remoteFiles')
    const { manager, tab, pty } = await reattachedAgentTab()
    manager.updateScreen(tab.id, 'Do you want to proceed?\n❯ 1. Yes\n  2. No')
    vi.spyOn(remoteFiles, 'leaveTmuxCopyMode').mockResolvedValue(null)
    expect(await manager.sendReview(tab.id, 'Read feedback.md')).toMatchObject({ ok: false })
    expect(pty.writes).toEqual([])
    manager.disposeAll()
  })

  posixOnly('送信: 入っていない・つながらないときは renderer の画面のまま送る。マウスを使っていなければ ssh を動かさない', async () => {
    const remoteFiles = await import('../../src/main/remoteFiles')
    const { manager, tab, pty } = await reattachedAgentTab()
    manager.updateScreen(tab.id, '✻ Working… (3s · esc to interrupt)')
    const leave = vi.spyOn(remoteFiles, 'leaveTmuxCopyMode').mockResolvedValueOnce({ left: false, screen: '$ ' }).mockResolvedValueOnce(null)
    const send = async (text: string) => {
      const started = performance.now()
      expect(await manager.sendReview(tab.id, text)).toMatchObject({ ok: true, submitted: true })
      expect(performance.now() - started).toBeLessThan(1500)
      expect(manager.screenText(tab.id)).toBe('✻ Working… (3s · esc to interrupt)')
      expect(pty.writes.some((w) => w.includes(text))).toBe(true)
    }
    // 戻したタブは分からないので確かめる（入っていなかった）
    await send('first')
    expect(leave).toHaveBeenCalledTimes(1)
    // マウスを使っていない間は確かめない
    await send('second')
    expect(leave).toHaveBeenCalledTimes(1)
    // ホイールのあとは確かめる（つながらなくても送る）
    manager.write(tab.id, '\x1b[<64;10;10M')
    await send('third')
    expect(leave).toHaveBeenCalledTimes(2)
    manager.disposeAll()
  })

  posixOnly('新しく開いた SSH のタブで、マウスを使っていなければ送信の前に ssh を動かさない', async () => {
    const remoteFiles = await import('../../src/main/remoteFiles')
    const leave = vi.spyOn(remoteFiles, 'leaveTmuxCopyMode').mockResolvedValue(null)
    const { TerminalManager } = await import('../../src/main/terminal')
    const manager = new TerminalManager(() => {}, () => {})
    manager.setRemote(REMOTE)
    const tab = await manager.create({ size: SIZE, agent: 'claude' })
    manager.updateScreen(tab.id, '✻ Working… (3s · esc to interrupt)')
    expect(await manager.sendReview(tab.id, 'hello')).toMatchObject({ ok: true })
    await manager.writeKey(tab.id, 'y')
    expect(leave).not.toHaveBeenCalled()
    manager.disposeAll()
  })

  posixOnly('起動の行: 打ち込む前にマウスを使ったタブだけ、先にコピーモードを抜けてから打ち込む', async () => {
    const remoteFiles = await import('../../src/main/remoteFiles')
    const leave = vi.spyOn(remoteFiles, 'leaveTmuxCopyMode').mockImplementation(async (_host, session) => {
      state.events.push(`leave:${session}`)
      return { left: true, screen: '$ ' }
    })
    const { TerminalManager } = await import('../../src/main/terminal')
    const manager = new TerminalManager(() => {}, () => {})
    manager.setRemote(REMOTE)
    const scrolled = await manager.create({ size: SIZE, agent: 'claude' })
    const scrolledPty = state.ptys.at(-1)!
    const untouched = await manager.create({ size: SIZE, agent: 'claude' })
    const untouchedPty = state.ptys.at(-1)!
    // 起動を待つ間にホイールで上へ戻した
    manager.write(scrolled.id, '\x1b[<64;10;10M')
    state.events.length = 0
    // 最初のプロンプトが出て出力が止まると、起動の行を打ち込む
    scrolledPty.emit('$ ')
    untouchedPty.emit('$ ')
    const launched = (writes: string[]) => writes.some((w) => w.length > 1 && w.endsWith('\r'))
    const end = Date.now() + 3000
    while (Date.now() < end && !(launched(scrolledPty.writes) && launched(untouchedPty.writes))) await delay(20)
    expect(launched(scrolledPty.writes)).toBe(true)
    expect(launched(untouchedPty.writes)).toBe(true)
    expect(leave).toHaveBeenCalledTimes(1)
    expect(leave.mock.calls[0]![1]).toContain(scrolled.tmuxToken!)
    const leftAt = state.events.findIndex((e) => e.startsWith('leave:'))
    const typedAt = state.events.findIndex((e, i) => i > leftAt && e.startsWith('write:') && e.endsWith('\\r"') && e.length > 'write:"\\r"'.length)
    expect(leftAt).toBeGreaterThanOrEqual(0)
    expect(typedAt).toBeGreaterThan(leftAt)
    manager.disposeAll()
  })
})

describe('配線（自動で打ち込む経路はどれもコピーモードを抜けてから）', () => {
  it('Agent への送信（TerminalManager.sendReview）は、状態を見る前・sendToAgent の前に抜ける', () => {
    const terminal = read('src/main/terminal.ts')
    const body = terminal.slice(terminal.indexOf('async sendReview('), terminal.indexOf('resize(id: string'))
    const leave = body.indexOf('await this.leaveTmuxCopyMode(session)')
    expect(leave).toBeGreaterThan(0)
    expect(leave).toBeLessThan(body.indexOf('while (session.readiness.status()'))
    expect(leave).toBeLessThan(body.indexOf('sendToAgent('))
  })

  it('上限での切り替えは今の画面で確かめる（コピーモードで上へ戻した位置の昔の知らせで切り替えない）', () => {
    const failover = read('src/main/failover/service.ts')
    expect(failover).toMatch(/limitOnScreen\(agent, await terminals\.liveScreenText\(id\)\)/)
    expect(failover).not.toMatch(/limitOnScreen\(agent, terminals\.screenText\(id\)\)/)
  })

  it('Ferret の自動の送信（引き継ぎ・続きを頼む・オーケストラ・スマホの本文）は sendReview を通る。PTY へ直接は書かない', () => {
    expect(read('src/main/failover/service.ts')).not.toMatch(/terminals\.write\(/)
    expect(read('src/main/failover/service.ts')).toMatch(/terminals\.sendReview\(/)
    expect(read('src/main/index.ts').match(/terminals[!?]?\.write\(/g) ?? []).toHaveLength(1)
    expect(read('src/main/index.ts')).toMatch(/'terminal:write': \(id, data\) => terminals\?\.write\(id, data\)/)
  })

  it('スマホのキーは writeKey（抜けてから、順番どおり）で書く', () => {
    const mobile = read('src/main/mobileRemote.ts')
    expect(mobile).toMatch(/await terminals\.writeKey\(info\.id, REMOTE_KEYS\[parsed\.key\]\)/)
    expect(mobile).not.toMatch(/terminals\.write\(/)
  })
})

/** Linux の tmux と script（util-linux。ssh -t の代わりに端末を用意する）。無ければ結合テストは飛ばす */
const linuxTools = (() => {
  if (process.platform !== 'linux') return null
  try {
    const tmux = execFileSync('sh', ['-c', 'command -v tmux'], { encoding: 'utf8' }).trim()
    const script = execFileSync('sh', ['-c', 'command -v script'], { encoding: 'utf8' }).trim()
    return tmux.startsWith('/') && script.startsWith('/') ? { tmux, script } : null
  } catch {
    return null
  }
})()

describe('本物の tmux（専用のソケット）', () => {
  it.runIf(linuxTools)('ホイールでコピーモードに入り、抜ける1行のあとの貼り付けと Enter は Agent に届く。つなぎ直してもマウスは有効のまま', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ferret-tmux-wheel-'))
    const bin = join(dir, 'bin')
    const home = join(dir, 'home')
    const sockets = join(dir, 'sockets')
    for (const d of [bin, home, join(home, 'app'), sockets]) mkdirSync(d)
    // tmux は必ず専用のソケット（-L）で動かす。値は環境変数で渡す（スクリプトに値を埋め込まない）
    writeFileSync(join(bin, 'tmux'), '#!/bin/sh\nexec "$FERRET_TEST_TMUX" -L "$FERRET_TEST_TMUX_SOCKET" -f /dev/null "$@"\n')
    chmodSync(join(bin, 'tmux'), 0o755)
    // Agent の代わり: ブラケットペーストを有効にして 60 行出し、届いた行を GOT[…] で返す
    const agent = join(dir, 'agent.sh')
    writeFileSync(agent, '#!/bin/sh\nprintf \'\\033[?2004h\'\ni=0; while [ $i -lt 60 ]; do echo "line$i"; i=$((i+1)); done\nwhile IFS= read -r l; do printf \'GOT[%s]\\n\' "$l"; done\n')
    chmodSync(agent, 0o755)
    // TMUX は渡さない（渡すと tmux はそのソケット＝利用者の tmux を使う）。TMUX_TMPDIR も一時フォルダにする
    const env = { PATH: `${bin}:/usr/bin:/bin`, HOME: home, SHELL: '/bin/sh', TERM: 'xterm-256color', LANG: 'C.UTF-8', TMUX_TMPDIR: sockets,
      FERRET_TEST_TMUX: linuxTools!.tmux, FERRET_TEST_TMUX_SOCKET: `ferret-test-${process.pid}` }
    const tmux = (...args: string[]): string | null => {
      try { return execFileSync(join(bin, 'tmux'), args, { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() } catch { return null }
    }
    const session = 'ferret-app-1a2b3c4d-wheel'
    const pane = `=${session}:`
    const inMode = () => tmux('display-message', '-p', '-t', pane, '#{pane_in_mode}')
    const until = async (cond: () => boolean, ms = 5000) => {
      const end = Date.now() + ms
      while (Date.now() < end) {
        if (cond()) return true
        await delay(50)
      }
      return cond()
    }
    // ssh の先のログインシェルの代わりに、手元の sh で1行を動かす（runSsh の代わり）
    const runLocal: SshRunner = (_host, command) => new Promise((done) => {
      execFile('/bin/sh', ['-c', command], { env, encoding: 'buffer' }, (error, stdout, stderr) => {
        const code = error ? (typeof (error as { code?: unknown }).code === 'number' ? (error as { code: number }).code : 255) : 0
        done({ code, stdout: Buffer.from(stdout), stderr: Buffer.from(stderr).toString('utf8') })
      })
    })
    const { captureTmuxPane, leaveTmuxCopyMode } = await import('../../src/main/remoteFiles')
    const line = remoteShellCommand('~/app', { session, notice: 'NO TMUX' })
    const clients: ChildProcess[] = []
    // ssh -t の代わりに script で端末を用意して、SSH のタブと同じ1行を動かす（script -c は $SHELL -c で動かす）
    const open = () => {
      const client = spawn(linuxTools!.script, ['-qfc', line, '/dev/null'], { env, cwd: home, stdio: ['pipe', 'ignore', 'ignore'] })
      // 起動できなければ下の待ちで落ちる（例外を投げっぱなしにしない）
      client.on('error', () => undefined)
      client.stdin!.on('error', () => undefined)
      clients.push(client)
      return client
    }
    const wheelUp = (client: ChildProcess) => client.stdin!.write('\x1b[<64;10;10M'.repeat(3))
    try {
      // 利用者のほかのセッションに見立てたもの（全体の設定を変えないことを見る）。新しいペインは Agent の代わりを動かす
      expect(tmux('new-session', '-d', '-s', 'other', '-x', '80', '-y', '24')).not.toBeNull()
      tmux('set-option', '-g', 'default-command', agent)
      const client = open()
      expect(await until(() => (tmux('capture-pane', '-p', '-t', pane) ?? '').includes('line59'))).toBe(true)
      expect(tmux('show-options', '-v', '-t', pane, 'mouse')).toBe('on')
      expect(tmux('show-options', '-gv', 'mouse')).toBe('off')
      expect(tmux('show-options', '-v', '-t', '=other:', 'mouse')).toBe('')

      wheelUp(client)
      expect(await until(() => inMode() === '1')).toBe(true)
      expect(Number(tmux('display-message', '-p', '-t', pane, '#{scroll_position}'))).toBeGreaterThan(0)
      // コピーモードの間も、今の画面（上へ戻した位置ではなく最後の行）が取れる。取ってもコピーモードは抜けない
      expect(await captureTmuxPane('dev-box', session, runLocal)).toContain('line59')
      expect(inMode()).toBe('1')
      const left = await leaveTmuxCopyMode('dev-box', session, runLocal)
      expect(left?.left).toBe(true)
      expect(left?.screen).toContain('line59')
      expect(inMode()).toBe('0')
      expect((await leaveTmuxCopyMode('dev-box', session, runLocal))?.left).toBe(false)
      expect(execFileSync('/bin/sh', ['-c', tmuxLeaveCopyModeCommand(session)], { env, encoding: 'utf8' }).split('\n')[0]).toBe('0')

      // sendToAgent と同じ送り方（貼り付けを1回で、少し置いて Enter を別に）
      wheelUp(client)
      expect(await until(() => inMode() === '1')).toBe(true)
      expect((await leaveTmuxCopyMode('dev-box', session, runLocal))?.left).toBe(true)
      client.stdin!.write('\x1b[200~hello from ferret\x1b[201~')
      await delay(50)
      client.stdin!.write('\r')
      expect(await until(() => /GOT\[.*hello from ferret/.test(tmux('capture-pane', '-p', '-t', pane) ?? ''))).toBe(true)

      // つなぎ直し（-A で前からあるセッションへ）でも、そのセッションのマウスを有効にし直す
      client.kill('SIGKILL')
      expect(await until(() => tmux('display-message', '-p', '-t', pane, '#{session_attached}') === '0')).toBe(true)
      tmux('set-option', '-t', pane, 'mouse', 'off')
      open()
      expect(await until(() => tmux('display-message', '-p', '-t', pane, '#{session_attached}') === '1' && tmux('show-options', '-v', '-t', pane, 'mouse') === 'on')).toBe(true)
      expect(tmux('list-sessions', '-F', '#{session_name}')?.split('\n').sort()).toEqual([session, 'other'])
      expect(tmux('show-options', '-gv', 'mouse')).toBe('off')
    } finally {
      for (const client of clients) client.kill('SIGKILL')
      tmux('kill-server')
      rmSync(dir, { recursive: true, force: true })
    }
  }, 20_000)
})
