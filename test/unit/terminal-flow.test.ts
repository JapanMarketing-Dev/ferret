/**
 * main のメモリを守る：ターミナルの出力の流量制御と、Windows の PTY の片付け（0.4.16 の Windows の main のクラッシュ FERRET-12 の対策）。
 * node-pty は差し替え（本物のシェルは起動しない）。pid は実在しない値にして、kill がほかのプロセスに届かないようにする
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: () => '/tmp/ade-unit', getAppPath: () => '/tmp/ade-unit', isPackaged: false } }))
vi.mock('../../src/main/telemetry', () => ({ reportMainError: vi.fn() }))

type DataListener = (data: string) => void
interface FakePty { data: DataListener | null; pause: ReturnType<typeof vi.fn>; resume: ReturnType<typeof vi.fn> }
const ptys: FakePty[] = []
vi.mock('node-pty', () => ({
  spawn: () => {
    const entry: FakePty = { data: null, pause: vi.fn(), resume: vi.fn() }
    ptys.push(entry)
    return {
      // macOS・Linux の PID の上限より大きい、実在しない値
      pid: 4_100_000 + ptys.length,
      onData: (fn: DataListener) => { entry.data = fn; return { dispose: () => {} } },
      onExit: () => ({ dispose: () => {} }),
      write: () => {},
      resize: () => {},
      kill: () => {},
      pause: entry.pause,
      resume: entry.resume
    }
  }
}))

const { TerminalManager, FLOW_HIGH_WATER, FLOW_LOW_WATER, releaseWindowsConout, hardenWindowsPty } = await import('../../src/main/terminal')

describe('ターミナルの出力の流量制御', () => {
  let sent: number
  let manager: InstanceType<typeof TerminalManager>
  beforeEach(() => {
    vi.useFakeTimers()
    ptys.length = 0
    sent = 0
    manager = new TerminalManager((_id, data) => { sent += data.length }, () => {})
  })

  /** 出力を流して、まとめて送る間隔を進める */
  const emit = async (chars: number) => {
    const chunk = 'x'.repeat(64 * 1024)
    for (let left = chars; left > 0; left -= chunk.length) ptys[0].data?.(chunk.slice(0, Math.min(chunk.length, left)))
    await vi.advanceTimersByTimeAsync(2000)
  }

  it('renderer の ack が来ないまま上限を超えたら PTY を止め、ack で減ったら再開する', async () => {
    const tab = await manager.create({ size: { cols: 80, rows: 24 } })
    await emit(FLOW_HIGH_WATER - 64 * 1024)
    expect(ptys[0].pause).not.toHaveBeenCalled()
    await emit(256 * 1024)
    expect(ptys[0].pause).toHaveBeenCalledTimes(1)
    // まだ多いうちは止めたまま
    manager.ack(tab.id, FLOW_HIGH_WATER - FLOW_LOW_WATER)
    expect(ptys[0].resume).not.toHaveBeenCalled()
    manager.ack(tab.id, sent)
    expect(ptys[0].resume).toHaveBeenCalledTimes(1)
  })

  it('ack が描いた分ずつ来ていれば止めない', async () => {
    const tab = await manager.create({ size: { cols: 80, rows: 24 } })
    for (let i = 0; i < 20; i++) {
      const before = sent
      await emit(512 * 1024)
      manager.ack(tab.id, sent - before)
    }
    expect(sent).toBeGreaterThan(FLOW_HIGH_WATER * 4)
    expect(ptys[0].pause).not.toHaveBeenCalled()
  })

  it('画面を読み込み直したら（前の画面の ack は来ない）全部再開する', async () => {
    await manager.create({ size: { cols: 80, rows: 24 } })
    await emit(FLOW_HIGH_WATER + 128 * 1024)
    expect(ptys[0].pause).toHaveBeenCalledTimes(1)
    manager.resetFlow()
    expect(ptys[0].resume).toHaveBeenCalledTimes(1)
  })

  it('知らない ID・数でない値・負の値の ack は無視する', async () => {
    const tab = await manager.create({ size: { cols: 80, rows: 24 } })
    await emit(FLOW_HIGH_WATER + 128 * 1024)
    for (const bad of [Number.NaN, -1, 0, Number.POSITIVE_INFINITY]) manager.ack(tab.id, bad)
    manager.ack('t999', sent)
    expect(ptys[0].resume).not.toHaveBeenCalled()
  })
})

describe('Windows: シェルが自分で終わったときに出力用の Worker を片付ける', () => {
  it('win32 では node-pty の conout の Worker を dispose する。ほかの OS では触らない', () => {
    const dispose = vi.fn()
    const pty = { _agent: { _conoutSocketWorker: { dispose } } } as never
    releaseWindowsConout(pty, 'darwin')
    releaseWindowsConout(pty, 'linux')
    expect(dispose).not.toHaveBeenCalled()
    releaseWindowsConout(pty, 'win32')
    expect(dispose).toHaveBeenCalledTimes(1)
    // 形が違っても投げない
    expect(() => releaseWindowsConout({} as never, 'win32')).not.toThrow()
  })

  it('win32 では、後回しにされた resize・kill が終わった PTY で投げても main の例外にしない', () => {
    const agent = {
      cols: 0,
      resize(this: { cols: number }, cols: number, _rows?: number) { this.cols = cols },
      kill: () => { throw new Error('Cannot kill a pty that has already exited') }
    }
    const pty = { _agent: agent } as never
    hardenWindowsPty(pty, 'win32')
    agent.resize(120, 30)
    // this は元の agent のまま
    expect(agent.cols).toBe(120)
    expect(() => agent.kill()).not.toThrow()
    const exited = { _agent: { resize: () => { throw new Error('Cannot resize a pty that has already exited') } } }
    hardenWindowsPty(exited as never, 'win32')
    expect(() => exited._agent.resize()).not.toThrow()
  })

  it('win32 では同じ PTY の kill は1回だけ（2回目は ConPTY を二重に閉じて main が落ちる）', () => {
    let kills = 0
    const agent = { kill: () => { kills++ } }
    hardenWindowsPty({ _agent: agent } as never, 'win32')
    agent.kill()
    agent.kill()
    agent.kill()
    expect(kills).toBe(1)
  })

  it('win32 では kill（ConPTY を閉じる同期の処理）が長ければ pty:kill として控える（FERRET-M 0.6.30）', async () => {
    const { clearSlowOps, recentSlowOps } = await import('../../src/shared/report')
    clearSlowOps()
    let clock = 1_000_000
    const now = vi.spyOn(Date, 'now').mockImplementation(() => clock)
    try {
      const slow = { kill: () => { clock += 3200 } }
      hardenWindowsPty({ _agent: slow } as never, 'win32')
      slow.kill()
      expect(recentSlowOps(clock)).toEqual([{ op: 'pty:kill', ms: 3200 }])
      // 短い kill・投げた kill は控えない（投げても main の例外にしない）
      clearSlowOps()
      const fast = { kill: () => { clock += 5 } }
      hardenWindowsPty({ _agent: fast } as never, 'win32')
      fast.kill()
      const failing = { kill: () => { throw new Error('gone') } }
      hardenWindowsPty({ _agent: failing } as never, 'win32')
      expect(() => failing.kill()).not.toThrow()
      expect(recentSlowOps(clock)).toEqual([])
      // resize は測らない
      const resize = { resize: () => { clock += 3000 } }
      hardenWindowsPty({ _agent: resize } as never, 'win32')
      resize.resize()
      expect(recentSlowOps(clock)).toEqual([])
    } finally {
      now.mockRestore()
    }
  })

  it('win32 以外の PTY には触らない', () => {
    const resize = () => { throw new Error('x') }
    const pty = { _agent: { resize } }
    hardenWindowsPty(pty as never, 'darwin')
    expect(pty._agent.resize).toBe(resize)
  })

  it('入っている node-pty が、片付けに使う中の名前（_agent・_conoutSocketWorker・dispose）を持っている', () => {
    const lib = join(process.cwd(), 'node_modules', 'node-pty', 'lib')
    expect(readFileSync(join(lib, 'windowsTerminal.js'), 'utf8')).toMatch(/_this\._agent = new windowsPtyAgent_1\.WindowsPtyAgent/)
    const agent = readFileSync(join(lib, 'windowsPtyAgent.js'), 'utf8')
    expect(agent).toMatch(/this\._conoutSocketWorker = /)
    // 後回しの resize・kill は WindowsTerminal が this._agent.resize / this._agent.kill を呼ぶ（hardenWindowsPty が包む）
    const terminal = readFileSync(join(lib, 'windowsTerminal.js'), 'utf8')
    expect(terminal).toContain('_this._agent.resize(cols, rows)')
    expect(terminal).toContain('_this._agent.kill()')
    expect(readFileSync(join(lib, 'windowsConoutConnection.js'), 'utf8')).toMatch(/ConoutConnection\.prototype\.dispose = function/)
  })

  it('node-pty は ptyHandles を mutex で守る版（Windows の終了と resize・kill の競合でのクラッシュの修正）', () => {
    const conpty = readFileSync(join(process.cwd(), 'node_modules', 'node-pty', 'src', 'win', 'conpty.cc'), 'utf8')
    expect(conpty).toContain('g_ptyHandlesMutex')
    const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as { dependencies: Record<string, string> }
    // beta なので範囲指定にしない（中の名前に頼っているため、上げるときはこのテストを見直す）
    expect(pkg.dependencies['node-pty']).toMatch(/^\d+\.\d+\.\d+(-[\w.]+)?$/)
  })
})
