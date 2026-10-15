/**
 * 終了の後始末を始めた後に、開いている途中だったタブが PTY を起動しない（FERRET-20）。
 * 0.6.29 の Windows で、起動時にタブを11個戻している途中で閉じると、後始末が待たなかった PTY の終了通知が
 * Node の環境の解体中に届き、main がネイティブに落ちた（cpp-exception in kernelbase.dll）。
 * node-pty は差し替え（本物のシェルは起動しない）
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: () => '/tmp/ade-unit', getAppPath: () => '/tmp/ade-unit', isPackaged: false } }))
vi.mock('../../src/main/telemetry', () => ({ reportMainError: vi.fn() }))

const spawn = vi.fn()
vi.mock('node-pty', () => ({
  spawn: (...args: unknown[]) => {
    spawn(...args)
    let exit: ((e: { exitCode: number }) => void) | null = null
    return {
      pid: 4_300_000 + spawn.mock.calls.length,
      cols: 80,
      rows: 24,
      onData: () => ({ dispose: () => {} }),
      onExit: (fn: (e: { exitCode: number }) => void) => { exit = fn; return { dispose: () => {} } },
      write: () => {},
      resize: () => {},
      kill: () => { exit?.({ exitCode: 0 }) },
      pause: () => {},
      resume: () => {}
    }
  }
}))

const { TerminalManager } = await import('../../src/main/terminal')
const { isUserFacingError } = await import('../../src/shared/errors')

const SIZE = { cols: 80, rows: 24 }

describe('終了を始めた後のタブの起動（FERRET-20）', () => {
  let manager: InstanceType<typeof TerminalManager>
  let closed: string[]
  beforeEach(() => {
    spawn.mockClear()
    closed = []
    manager = new TerminalManager(() => {}, () => {})
    manager.setCwd(process.cwd())
    manager.onSessionClosed = (id) => { closed.push(id) }
  })

  it('開いている途中（起動の準備を待っている間）に後始末が始まったら、PTY を起動せずに断る', async () => {
    let release: (() => void) | null = null
    manager.launchEnv = () => new Promise((resolve) => { release = () => resolve({}) })
    const opening = manager.create({ size: SIZE, command: 'echo hi' })
    await vi.waitFor(() => expect(release).not.toBeNull())

    // 後始末はその時点で何も待たずに終わる（開いている途中のタブは数えない）
    expect(manager.pendingCount()).toBe(0)
    await expect(manager.disposeAllAndWait({ escalateAfterMs: 10, timeoutMs: 50 })).resolves.toMatchObject({ clean: true, pending: 0 })

    release!()
    const err = await opening.then(() => null, (e: unknown) => e)
    expect(isUserFacingError(err)).toBe(true)
    expect(spawn).not.toHaveBeenCalled()
    expect(manager.pendingCount()).toBe(0)
    expect(manager.list()).toHaveLength(0)
    // そのタブに結び付けかけたもの（判定モデルの合言葉など）も無効にする
    expect(closed).toHaveLength(1)
  })

  it('PTY が1つも無いときの後始末（disposeAll）の後も、新しいタブは開かない', async () => {
    manager.disposeAll()
    const err = await manager.create({ size: SIZE, command: 'echo hi' }).then(() => null, (e: unknown) => e)
    expect(isUserFacingError(err)).toBe(true)
    expect(spawn).not.toHaveBeenCalled()
    expect(manager.pendingCount()).toBe(0)
  })

  it('後始末の前なら普通に開き、後始末はそのタブの終了を待つ', async () => {
    const tab = await manager.create({ size: SIZE, command: 'echo hi' })
    expect(spawn).toHaveBeenCalledTimes(1)
    expect(manager.pendingCount()).toBe(1)
    const result = await manager.disposeAllAndWait({ escalateAfterMs: 10, timeoutMs: 1000 })
    expect(result).toMatchObject({ clean: true, pending: 0 })
    expect(closed).toContain(tab.id)
  })
})
