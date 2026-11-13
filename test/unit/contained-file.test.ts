import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { open } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * security-4 [5]: 確かめたあとでシンボリックリンクに差し替えられても、プロジェクトの外を読み書きしない。
 * security-4 [9]: フォルダの一覧は上限で止まる。
 * 差し替えは「確かめた直後の stat」の時点で起こす（node:fs/promises の stat を包む）
 */
const swap = vi.hoisted(() => ({ target: '' as string, run: null as null | (() => void) }))
vi.mock('node:fs/promises', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs/promises')>()
  const stat = (async (path: Parameters<typeof real.stat>[0], options?: Parameters<typeof real.stat>[1]) => {
    if (swap.run && String(path) === swap.target) {
      const run = swap.run
      swap.run = null
      run()
    }
    return real.stat(path, options as never)
  }) as typeof real.stat
  return { ...real, default: { ...real, stat }, stat }
})

const { listDirectory, readTextFile, writeTextFile, MAX_DIRECTORY_ENTRIES } = await import('../../src/main/files')
const { assertHandleInside } = await import('../../src/main/containedFile')

let base: string
let project: string
let secret: string

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'contained-')))
  project = join(base, 'project')
  const outside = join(base, 'outside')
  for (const dir of [project, outside]) mkdirSync(dir)
  secret = join(outside, 'secret.txt')
  writeFileSync(secret, 'outside secret')
  writeFileSync(join(project, 'a.txt'), 'inside')
})

afterEach(() => {
  swap.run = null
  rmSync(base, { recursive: true, force: true })
})

/** a.txt を外のファイルへのリンクに差し替える */
function swapToOutside(): void {
  swap.target = join(project, 'a.txt')
  swap.run = () => {
    unlinkSync(join(project, 'a.txt'))
    symlinkSync(secret, join(project, 'a.txt'))
  }
}

describe('contained file I/O (security-4 [5])', () => {
  it('a save raced into an outside symlink never writes or truncates the outside file', async () => {
    swapToOutside()
    await expect(writeTextFile(project, 'a.txt', 'overwritten')).rejects.toThrow()
    expect(readFileSync(secret, 'utf8')).toBe('outside secret')
  })

  it('a read raced into an outside symlink never returns the outside content', async () => {
    swapToOutside()
    const result = await readTextFile(project, 'a.txt').catch((err: Error) => err)
    expect(result).toBeInstanceOf(Error)
  })

  it('rejects a handle whose path was swapped back after opening an outside file', async () => {
    const handle = await open(secret, 'r')
    try {
      // パスはプロジェクトの中の a.txt を指しているが、開いているのは外のファイル
      await expect(assertHandleInside(handle, project, join(project, 'a.txt'))).rejects.toThrow()
    } finally {
      await handle.close()
    }
  })

  it('still saves and creates ordinary files inside the project', async () => {
    await writeTextFile(project, 'a.txt', 'saved')
    expect(readFileSync(join(project, 'a.txt'), 'utf8')).toBe('saved')
    await writeTextFile(project, 'new.txt', 'created')
    expect(readFileSync(join(project, 'new.txt'), 'utf8')).toBe('created')
    expect(await readTextFile(project, 'a.txt')).toMatchObject({ kind: 'text', content: 'saved' })
  })
})

describe('directory listing bound (security-4 [9])', () => {
  it('stops at MAX_DIRECTORY_ENTRIES', async () => {
    // 5000 個を作ると遅いので、上限を小さくして同じ動きを確かめる
    for (let i = 0; i < 70; i++) writeFileSync(join(project, `f${i}`), '')
    expect(await listDirectory(project, '', 20)).toHaveLength(20)
    expect((await listDirectory(project, '')).length).toBeGreaterThan(70)
    expect(MAX_DIRECTORY_ENTRIES).toBe(5000)
  })
})
