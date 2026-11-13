/**
 * Agent のタブを速く開く：ログインシェルの PATH（rc 次第で 1〜3 秒）を待たず、前回の起動の値で実行ファイルを探す
 * （src/main/agentDetection.ts の warmLoginShellPath）。ログインシェルは差し替え（本物は起動しない）
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@shared/report', () => ({ reportHandled: vi.fn(), errorKind: (e: unknown) => e }))

type Callback = (error: Error | null, stdout: string) => void
const calls: Callback[] = []
vi.mock('node:child_process', () => ({
  execFile: (_file: string, _args: string[], _opts: unknown, cb: Callback) => { calls.push(cb) }
}))

const posix = process.platform !== 'win32'

describe.runIf(posix)('ログインシェルの PATH を前回の起動の値ですぐ使う', () => {
  let dir: string
  beforeEach(() => {
    vi.resetModules()
    // このファイルはログインシェルを差し替えて確かめるので、テスト用の軽いシェル（test/setup/isolateEnv.ts）は外す
    delete process.env.FERRET_TEST_LOGIN_SHELL
    calls.length = 0
    dir = mkdtempSync(join(tmpdir(), 'ade-shell-path-'))
  })

  it('前回の値があれば、今回の値を待たずにそれで探す。今回の値が取れたら以後はそれを使い、ファイルも更新する', async () => {
    const file = join(dir, 'login-shell-path.json')
    writeFileSync(file, JSON.stringify({ shell: process.env.SHELL || '/bin/zsh', path: '/cached/bin' }))
    const mod = await import('../../src/main/agentDetection')
    await mod.warmLoginShellPath(file)
    expect(calls).toHaveLength(1)
    // ログインシェルはまだ返していない
    expect(await mod.searchDirs()).toContain('/cached/bin')
    expect(mod.shellPathIsProvisional()).toBe(true)
    calls[0]!(null, 'motd\n__ADE_PATH__/fresh/bin:/usr/bin')
    const dirs = await mod.searchDirs()
    expect(dirs).toContain('/fresh/bin')
    expect(dirs).not.toContain('/cached/bin')
    expect(mod.shellPathIsProvisional()).toBe(false)
    await vi.waitFor(() => expect(JSON.parse(readFileSync(file, 'utf8')).path).toBe('/fresh/bin:/usr/bin'))
  })

  it('fresh を頼むと今回の値を待つ（前回の値で見つからなかったときの探し直し）', async () => {
    const file = join(dir, 'login-shell-path.json')
    writeFileSync(file, JSON.stringify({ shell: process.env.SHELL || '/bin/zsh', path: '/cached/bin' }))
    const mod = await import('../../src/main/agentDetection')
    await mod.warmLoginShellPath(file)
    const fresh = mod.searchDirs({ fresh: true })
    calls[0]!(null, '__ADE_PATH__/fresh/bin')
    expect(await fresh).toContain('/fresh/bin')
  })

  it('前回の値が無ければ（初回の起動）今回の値を待つ', async () => {
    const mod = await import('../../src/main/agentDetection')
    await mod.warmLoginShellPath(join(dir, 'missing.json'))
    const pending = mod.searchDirs()
    let settled = false
    void pending.then(() => { settled = true })
    await new Promise((r) => setTimeout(r, 10))
    expect(settled).toBe(false)
    calls[0]!(null, '__ADE_PATH__/fresh/bin')
    expect(await pending).toContain('/fresh/bin')
  })

  it('別のシェルの値・壊れたファイルは使わない', async () => {
    const file = join(dir, 'login-shell-path.json')
    writeFileSync(file, JSON.stringify({ shell: '/not/my/shell', path: '/cached/bin' }))
    const mod = await import('../../src/main/agentDetection')
    await mod.warmLoginShellPath(file)
    expect(mod.shellPathIsProvisional()).toBe(false)
    calls[0]!(new Error('timeout'), '')
    expect(await mod.searchDirs()).not.toContain('/cached/bin')
  })

  it('終了コードが 0 でなくても、印が出ていれば PATH を使う（.zlogout・rc の失敗。Sentry FERRET-1S）', async () => {
    const mod = await import('../../src/main/agentDetection')
    const { reportHandled } = await import('@shared/report')
    vi.mocked(reportHandled).mockClear()
    await mod.warmLoginShellPath(join(dir, 'missing.json'))
    const pending = mod.searchDirs()
    calls[0]!(Object.assign(new Error('Command failed'), { code: 1 }), '__ADE_PATH__/fresh/bin')
    expect(await pending).toContain('/fresh/bin')
    expect(reportHandled).not.toHaveBeenCalled()
  })

  it('取れなかったときに送るもの：時間切れは送らない。終了コード・シグナルを題名にする', async () => {
    const { loginShellPathFailure } = await import('../../src/main/agentDetection')
    expect(loginShellPathFailure(Object.assign(new Error('x'), { killed: true, signal: 'SIGTERM', code: null }))).toBeNull()
    expect(loginShellPathFailure(Object.assign(new Error('x'), { code: 127 }))?.message).toBe('login shell PATH exit 127')
    expect(loginShellPathFailure(Object.assign(new Error('x'), { code: null, signal: 'SIGKILL' }))?.message).toBe('login shell PATH signal SIGKILL')
    expect(loginShellPathFailure(null)?.message).toBe('login shell PATH marker missing')
  })

  it('時間切れでは Sentry へ送らない', async () => {
    const mod = await import('../../src/main/agentDetection')
    const { reportHandled } = await import('@shared/report')
    vi.mocked(reportHandled).mockClear()
    await mod.warmLoginShellPath(join(dir, 'missing.json'))
    const pending = mod.searchDirs()
    calls[0]!(Object.assign(new Error('Command failed'), { killed: true, signal: 'SIGTERM', code: null }), '')
    await pending
    expect(reportHandled).not.toHaveBeenCalled()
  })
})
