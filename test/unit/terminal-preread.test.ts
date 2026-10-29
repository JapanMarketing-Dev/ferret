import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: () => '/tmp/ade-unit', getAppPath: () => '/tmp/ade-unit', isPackaged: false } }))
vi.mock('../../src/main/telemetry', () => ({ reportMainError: vi.fn() }))

const { prereadNodePtyBinaries } = await import('../../src/main/terminal')

/**
 * 更新した直後の Windows で、node-pty のネイティブモジュールを先に読んで OS の検査を済ませる（FERRET-M）。
 * 読むだけで読み込み（dlopen）はしない。無いファイル・読めない場所は飛ばす
 */
describe('node-pty のファイルを先に読む', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  })
  function fakePackage(layout: Record<string, string[]>): string {
    const root = mkdtempSync(join(tmpdir(), 'ferret-pty-'))
    dirs.push(root)
    for (const [sub, names] of Object.entries(layout)) {
      mkdirSync(join(root, sub), { recursive: true })
      for (const name of names) writeFileSync(join(root, sub, name), 'MZ')
    }
    return root
  }

  it('Windows では prebuilds の .node を CPU に合わせて読む（配布版に無い build/Release は飛ばす）', async () => {
    const root = fakePackage({ 'prebuilds/win32-x64': ['conpty.node', 'conpty_console_list.node'], 'prebuilds/win32-arm64': ['conpty.node'] })
    expect(await prereadNodePtyBinaries('win32', 'x64', () => root)).toBe(2)
    expect(await prereadNodePtyBinaries('win32', 'arm64', () => root)).toBe(1)
  })

  it('配布版の app.asar の中のパスは app.asar.unpacked に読み替える', async () => {
    const base = mkdtempSync(join(tmpdir(), 'ferret-asar-'))
    dirs.push(base)
    const unpacked = join(base, 'app.asar.unpacked', 'node_modules', 'node-pty', 'prebuilds', 'win32-x64')
    mkdirSync(unpacked, { recursive: true })
    writeFileSync(join(unpacked, 'conpty.node'), 'MZ')
    expect(await prereadNodePtyBinaries('win32', 'x64', () => join(base, 'app.asar', 'node_modules', 'node-pty'))).toBe(1)
    // app.asar で始まるだけの別の名前は読み替えない
    expect(await prereadNodePtyBinaries('win32', 'x64', () => join(base, 'app.asarx', 'node-pty'))).toBe(0)
  })

  it('Windows 以外・場所が分からない・何も無いときは何も読まずに 0', async () => {
    const root = fakePackage({ 'prebuilds/win32-x64': ['conpty.node'] })
    expect(await prereadNodePtyBinaries('darwin', 'arm64', () => root)).toBe(0)
    expect(await prereadNodePtyBinaries('linux', 'x64', () => root)).toBe(0)
    expect(await prereadNodePtyBinaries('win32', 'x64', () => { throw new Error('Cannot find module') })).toBe(0)
    expect(await prereadNodePtyBinaries('win32', 'x64', () => join(root, 'missing'))).toBe(0)
  })
})
