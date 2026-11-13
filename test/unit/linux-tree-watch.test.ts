import { afterEach, describe, expect, it } from 'vitest'
import { EventEmitter } from 'node:events'
import type { FSWatcher } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LinuxTreeWatcher, shouldWatchDir, type WatchDir } from '../../src/main/linuxTreeWatch'

describe('shouldWatchDir', () => {
  it('重いフォルダには降りないが、指摘の進み具合の置き場までは降りる', () => {
    expect(shouldWatchDir('')).toBe(true)
    expect(shouldWatchDir('src/components')).toBe(true)
    expect(shouldWatchDir('node_modules')).toBe(false)
    expect(shouldWatchDir('packages/a/node_modules')).toBe(false)
    expect(shouldWatchDir('.git')).toBe(false)
    expect(shouldWatchDir('.ferret')).toBe(true)
    expect(shouldWatchDir('.ferret/reviews')).toBe(true)
    expect(shouldWatchDir('.ferret/reviews/20261003-120000')).toBe(true)
    expect(shouldWatchDir('.ferret/reviews/20261003-120000/shots')).toBe(false)
    expect(shouldWatchDir('.ferret/recordings')).toBe(false)
  })
})

describe('LinuxTreeWatcher', () => {
  let root = ''
  let watcher: LinuxTreeWatcher | null = null
  afterEach(async () => {
    watcher?.close()
    if (root) await rm(root, { recursive: true, force: true })
  })

  /**
   * OS の通知（fs.watch）の代わり。張ったフォルダごとに通知の口を覚え、テストが自分で出す。
   * 以前は本物の fs.watch を待っていたので、全部のテストを並べて流すと通知が遅れて落ちることがあった
   */
  function fakeWatch(): { watchDir: WatchDir; fire: (dir: string, event: string, name: string) => void; open: () => string[] } {
    const listeners = new Map<string, (event: string, filename: string | null) => void>()
    const watchDir: WatchDir = (path, listener) => {
      const watcher = new EventEmitter() as EventEmitter & { close: () => void }
      watcher.close = () => { if (listeners.get(path) === listener) listeners.delete(path) }
      listeners.set(path, listener)
      return watcher as unknown as FSWatcher
    }
    return {
      watchDir,
      fire: (dir, event, name) => listeners.get(dir ? join(root, dir) : root)?.(event, name),
      open: () => [...listeners.keys()].map((path) => path.slice(root.length + 1)).sort()
    }
  }

  /** 見張りの探索（opendir・stat）は非同期なので、終わるまで少し待つ（OS の通知は待たない） */
  const until = async (check: () => boolean): Promise<void> => {
    const deadline = Date.now() + 2000
    while (!check() && Date.now() < deadline) await new Promise((done) => setTimeout(done, 5))
  }

  it('対象のフォルダの変更を拾い、node_modules は見張らない。あとから作ったフォルダも見張り、消したら外す', async () => {
    root = await mkdtemp(join(tmpdir(), 'tree-watch-'))
    await mkdir(join(root, 'src'), { recursive: true })
    await mkdir(join(root, 'node_modules', 'pkg'), { recursive: true })
    const seen: string[] = []
    const fake = fakeWatch()
    watcher = new LinuxTreeWatcher(root, (_event, name) => seen.push(name), undefined, fake.watchDir)
    await until(() => watcher!.size === 2)
    expect(watcher.size).toBe(2) // 直下と src
    expect(fake.open()).toEqual(['', 'src'])

    await writeFile(join(root, 'src', 'a.ts'), 'x')
    fake.fire('src', 'rename', 'a.ts')
    expect(seen).toContain('src/a.ts')
    // ファイルが増えても、見張るフォルダは増えない
    await new Promise((done) => setTimeout(done, 20))
    expect(watcher.size).toBe(2)

    await mkdir(join(root, 'lib'))
    fake.fire('', 'rename', 'lib')
    await until(() => watcher!.size === 3)
    expect(fake.open()).toEqual(['', 'lib', 'src'])
    await writeFile(join(root, 'lib', 'b.ts'), 'x')
    fake.fire('lib', 'change', 'b.ts')
    expect(seen).toContain('lib/b.ts')

    // node_modules には張っていないので、その下の変更は届かない
    fake.fire('node_modules/pkg', 'change', 'c.js')
    expect(seen.some((name) => name.startsWith('node_modules'))).toBe(false)

    await rm(join(root, 'lib'), { recursive: true })
    fake.fire('', 'rename', 'lib')
    await until(() => watcher!.size === 2)
    expect(fake.open()).toEqual(['', 'src'])
  })

  it('閉じたら全部外す', async () => {
    root = await mkdtemp(join(tmpdir(), 'tree-watch-'))
    await mkdir(join(root, 'a', 'b'), { recursive: true })
    const fake = fakeWatch()
    watcher = new LinuxTreeWatcher(root, () => undefined, undefined, fake.watchDir)
    await until(() => watcher!.size === 3)
    watcher.close()
    expect(watcher.size).toBe(0)
    expect(fake.open()).toEqual([])
  })
})
