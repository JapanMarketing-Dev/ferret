/**
 * ターミナルを速く開く：次の素のシェルを先に起動しておき、タブを開くときにそれを渡す（src/main/terminal.ts の spare）。
 * node-pty は差し替え（本物のシェルは起動しない）。pid は実在しない値にして、kill がほかのプロセスに届かないようにする
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: () => '/tmp/ade-unit', getAppPath: () => '/tmp/ade-unit', isPackaged: false } }))
vi.mock('../../src/main/telemetry', () => ({ reportMainError: vi.fn() }))

interface FakePty {
  cwd: string
  data: ((data: string) => void) | null
  exit: ((e: { exitCode: number }) => void) | null
  resize: ReturnType<typeof vi.fn<(cols: number, rows: number) => void>>
  kill: ReturnType<typeof vi.fn<(...args: unknown[]) => void>>
}
const ptys: FakePty[] = []
vi.mock('node-pty', () => ({
  spawn: (_file: string, _args: string[], opts: { cwd: string }) => {
    const entry: FakePty = { cwd: opts.cwd, data: null, exit: null, resize: vi.fn<(cols: number, rows: number) => void>(), kill: vi.fn<(...args: unknown[]) => void>() }
    ptys.push(entry)
    return {
      // macOS・Linux の PID の上限より大きい、実在しない値
      pid: 4_200_000 + ptys.length,
      cols: 80,
      rows: 24,
      onData: (fn: (data: string) => void) => { entry.data = fn; return { dispose: () => {} } },
      onExit: (fn: (e: { exitCode: number }) => void) => { entry.exit = fn; return { dispose: () => {} } },
      write: () => {},
      resize: entry.resize,
      kill: (...args: unknown[]) => { entry.kill(...args); entry.exit?.({ exitCode: 0 }) },
      pause: () => {},
      resume: () => {}
    }
  }
}))

const { TerminalManager } = await import('../../src/main/terminal')

const SIZE = { cols: 100, rows: 30 }
const posix = process.platform !== 'win32'

describe.runIf(posix)('先に起動しておくシェル', () => {
  let sent: Array<[string, string]>
  let manager: InstanceType<typeof TerminalManager>
  let context: string
  beforeEach(() => {
    vi.useFakeTimers()
    ptys.length = 0
    sent = []
    context = 'a'
    manager = new TerminalManager((id, data) => { sent.push([id, data]) }, () => {})
    manager.spareShells = true
    manager.spareContext = () => context
    manager.setCwd(process.cwd())
  })

  const warm = async () => {
    manager.prewarm(SIZE)
    await vi.advanceTimersByTimeAsync(50)
  }

  it('先に起動したシェルを素のシェルのタブに渡し、それまでの出力（プロンプト）を返す。渡すまでは画面へ送らない', async () => {
    await warm()
    expect(ptys).toHaveLength(1)
    ptys[0]!.data?.('prompt$ ')
    await vi.advanceTimersByTimeAsync(100)
    expect(sent).toHaveLength(0)
    // 一覧（Resource Manager・送信先）にも、渡すまでは出さない
    expect(manager.list()).toHaveLength(0)

    const tab = await manager.create({ size: { cols: 100, rows: 40 } })
    expect(ptys).toHaveLength(1)
    expect(tab.history).toBe('prompt$ ')
    expect(tab.title).toMatch(/^\d+: /)
    expect(ptys[0]!.resize).toHaveBeenCalledWith(100, 40)
    expect(manager.list().map((s) => s.id)).toEqual([tab.id])

    // 渡したあとの出力は普通に送る
    ptys[0]!.data?.('ls\r\n')
    await vi.advanceTimersByTimeAsync(100)
    expect(sent).toEqual([[tab.id, 'ls\r\n']])
  })

  it('起動したときと幅が違うタブには、前の幅で描いた出力を流し直さない（zsh の行末の印 % が残らない）。次は最後のタブの寸法で起動する', async () => {
    await warm()
    ptys[0]!.data?.('%' + ' '.repeat(99) + '\rprompt$ ')
    const tab = await manager.create({ size: { cols: 60, rows: 20 } })
    expect(tab.history).toBeFalsy()
    expect(ptys[0]!.resize).toHaveBeenCalledWith(60, 20)
    // 幅を合わせたあとに描き直したプロンプトは普通に送る
    ptys[0]!.data?.('prompt$ ')
    await vi.advanceTimersByTimeAsync(100)
    expect(sent).toEqual([[tab.id, 'prompt$ ']])
  })

  it('渡したあと、次の分を少し待ってから裏で起動する', async () => {
    await warm()
    await manager.create({ size: SIZE })
    expect(ptys).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(2000)
    expect(ptys).toHaveLength(2)
    const second = await manager.create({ size: SIZE })
    expect(ptys).toHaveLength(2)
    expect(second.history).toBe('')
  })

  it('コマンドを実行するタブには渡さない（普通に起動する）', async () => {
    await warm()
    const tab = await manager.create({ size: SIZE, command: 'echo hi' })
    expect(tab.history).toBeUndefined()
    expect(ptys).toHaveLength(2)
    expect(manager.list().map((s) => s.id)).toEqual([tab.id])
  })

  it('別のフォルダで開くタブには渡さず、先に起動したものは残す', async () => {
    await warm()
    const tab = await manager.create({ size: SIZE, cwd: '/' })
    expect(tab.history).toBeUndefined()
    expect(ptys).toHaveLength(2)
    expect(ptys[0]!.kill).not.toHaveBeenCalled()
  })

  it('文脈（プロジェクト・判定モデルの設定）が変わっていたら捨てて普通に起動する', async () => {
    await warm()
    context = 'b'
    const tab = await manager.create({ size: SIZE })
    expect(tab.history).toBeUndefined()
    // 子孫を ps（非同期）で数えてから落とす
    await vi.waitFor(() => expect(ptys[0]!.kill).toHaveBeenCalled())
    expect(ptys).toHaveLength(2)
  })

  it('プロジェクトを替えたら捨てる', async () => {
    await warm()
    manager.setCwd('/')
    await vi.waitFor(() => expect(ptys[0]!.kill).toHaveBeenCalled())
    const tab = await manager.create({ size: SIZE })
    expect(tab.history).toBeUndefined()
  })

  it('渡す前に終わったシェルは渡さない', async () => {
    await warm()
    ptys[0]!.exit?.({ exitCode: 1 })
    const tab = await manager.create({ size: SIZE })
    expect(tab.history).toBeUndefined()
    expect(ptys).toHaveLength(2)
  })

  it('終了のときは先に起動したシェルも片付け、終わるのを待つ数に入れる', async () => {
    await warm()
    expect(manager.pendingCount()).toBe(1)
    const result = await manager.disposeAllAndWait({ escalateAfterMs: 10, timeoutMs: 50 })
    expect(ptys[0]!.kill).toHaveBeenCalled()
    expect(result.clean).toBe(true)
    // 閉じたあとは先に起動しない
    manager.prewarm(SIZE)
    await vi.advanceTimersByTimeAsync(2000)
    expect(ptys).toHaveLength(1)
  })

  it('有効にしていなければ先に起動しない', async () => {
    manager.spareShells = false
    await warm()
    await manager.create({ size: SIZE })
    await vi.advanceTimersByTimeAsync(2000)
    expect(ptys).toHaveLength(1)
  })
})
