import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { FileIndexCache, ProjectWatcher, buildFileIndex, isExcludedFromListing, walkFiles, type FileIndex } from '../../src/main/files'
import { prepareQuickOpenFiles, rankPreparedQuickOpenFiles, rankQuickOpenFiles } from '@shared/quickOpen'

/** ⌘P・名前の検索の索引（遅い・いつまでも出ないをなくす） */

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (err: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

const idx = (...files: string[]): FileIndex => ({ files, truncated: false })

describe('FileIndexCache', () => {
  it('2回目からは歩き直さない', async () => {
    const build = vi.fn(async () => idx('a.ts'))
    const cache = new FileIndexCache(build)
    expect((await cache.get('/p')).files).toEqual(['a.ts'])
    expect((await cache.get('/p')).files).toEqual(['a.ts'])
    expect(build).toHaveBeenCalledTimes(1)
  })

  it('同時に頼まれても、読み直しは1本にまとめる', async () => {
    const d = deferred<FileIndex>()
    const build = vi.fn(() => d.promise)
    const cache = new FileIndexCache(build)
    const both = Promise.all([cache.get('/p'), cache.get('/p')])
    d.resolve(idx('x'))
    expect((await both).map((i) => i.files)).toEqual([['x'], ['x']])
    expect(build).toHaveBeenCalledTimes(1)
  })

  it('変わったら次に使うときに読み直す（速く終われば新しい方を返す）', async () => {
    let n = 0
    const cache = new FileIndexCache(async () => idx(`v${++n}`))
    expect((await cache.get('/p')).files).toEqual(['v1'])
    cache.invalidate()
    expect((await cache.get('/p')).files).toEqual(['v2'])
  })

  it('読み直しが遅いときは古いものをすぐ返し、終わったら次から新しい方', async () => {
    const slow = deferred<FileIndex>()
    const build = vi.fn().mockResolvedValueOnce(idx('old')).mockReturnValueOnce(slow.promise)
    const cache = new FileIndexCache(build, { freshWaitMs: 5, maxAgeMs: 60_000, maxRoots: 4 })
    await cache.get('/p')
    cache.invalidate('/p')
    expect((await cache.get('/p')).files).toEqual(['old'])
    slow.resolve(idx('new'))
    await slow.promise
    await Promise.resolve()
    expect((await cache.get('/p')).files).toEqual(['new'])
    expect(build).toHaveBeenCalledTimes(2)
  })

  it('読み直しに失敗したら古いものを使い、次にまた読み直す', async () => {
    const build = vi.fn().mockResolvedValueOnce(idx('old')).mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce(idx('again'))
    const cache = new FileIndexCache(build, { freshWaitMs: 50, maxAgeMs: 60_000, maxRoots: 4 })
    await cache.get('/p')
    cache.invalidate()
    expect((await cache.get('/p')).files).toEqual(['old'])
    expect((await cache.get('/p')).files).toEqual(['again'])
  })

  it('初めての読み込みに失敗したら、そのまま失敗を返す（いつまでも待たせない）', async () => {
    const cache = new FileIndexCache(async () => { throw new Error('ENOENT') })
    await expect(cache.get('/gone')).rejects.toThrow('ENOENT')
  })

  it('監視が止まっていても、古くなりすぎたら読み直す', async () => {
    let now = 0
    let n = 0
    const cache = new FileIndexCache(async () => idx(`v${++n}`), { freshWaitMs: 50, maxAgeMs: 1000, maxRoots: 4 }, () => now)
    await cache.get('/p')
    now = 999
    expect((await cache.get('/p')).files).toEqual(['v1'])
    now = 1000
    expect((await cache.get('/p')).files).toEqual(['v2'])
  })

  it('invalidate(root) はそのプロジェクトだけ', async () => {
    const build = vi.fn(async (root: string) => idx(root))
    const cache = new FileIndexCache(build)
    await cache.get('/a')
    await cache.get('/b')
    cache.invalidate('/a')
    await cache.get('/a')
    await cache.get('/b')
    expect(build.mock.calls.map((c) => c[0])).toEqual(['/a', '/b', '/a'])
  })

  it('覚えるプロジェクトの数に上限がある（古いものから捨てる）', async () => {
    const build = vi.fn(async (root: string) => idx(root))
    const cache = new FileIndexCache(build, { freshWaitMs: 50, maxAgeMs: 60_000, maxRoots: 2 })
    await cache.get('/a')
    await cache.get('/b')
    await cache.get('/c')
    await cache.get('/a')
    expect(build).toHaveBeenCalledTimes(4)
  })
})

describe('一覧の歩き方', () => {
  let root = ''
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'ade-index-'))
    await mkdir(join(root, 'src', 'deep', 'er'), { recursive: true })
    await mkdir(join(root, 'node_modules', 'x'), { recursive: true })
    await mkdir(join(root, '.claude', 'worktrees', 'agent-1', 'src'), { recursive: true })
    await mkdir(join(root, '.claude', 'commands'), { recursive: true })
    await writeFile(join(root, 'README.md'), '')
    await writeFile(join(root, 'src', 'a.ts'), '')
    await writeFile(join(root, 'src', 'deep', 'er', 'z.ts'), '')
    await writeFile(join(root, 'node_modules', 'x', 'i.js'), '')
    await writeFile(join(root, '.claude', 'worktrees', 'agent-1', 'src', 'a.ts'), '')
    await writeFile(join(root, '.claude', 'commands', 'c.md'), '')
    // 自分の親を指すリンク（辿るとループする）
    await symlink(root, join(root, 'src', 'loop'))
  })
  afterAll(async () => { await rm(root, { recursive: true, force: true }) })

  it('worktree・node_modules を外し、リンクは辿らない', async () => {
    const { files, truncated } = await walkFiles(root, { limit: 1000, timeoutMs: 5000 })
    expect(truncated).toBe(false)
    expect(files.sort()).toEqual(['.claude/commands/c.md', 'README.md', 'src/a.ts', 'src/deep/er/z.ts'])
  })

  it('上限で止めて打ち切りを示す', async () => {
    const { files, truncated } = await walkFiles(root, { limit: 2, timeoutMs: 5000 })
    expect(files).toHaveLength(2)
    expect(truncated).toBe(true)
  })

  it('時間切れならそこまでで返す（いつまでも待たせない）', async () => {
    const { truncated } = await walkFiles(root, { limit: 1000, timeoutMs: -1 })
    expect(truncated).toBe(true)
  })

  it('索引は浅い・短いものが先（rg の出てくる順に左右されない）', async () => {
    const { files } = await buildFileIndex(root)
    expect(files).toEqual(['src/a.ts', 'README.md', 'src/deep/er/z.ts', '.claude/commands/c.md'])
    expect(files.some((f) => f.startsWith('.claude/worktrees/'))).toBe(false)
    expect(files.some((f) => f.startsWith('node_modules/'))).toBe(false)
  })

  it('消えたフォルダは失敗を返す', async () => {
    await expect(buildFileIndex(join(root, 'nope'))).rejects.toThrow()
  })
})

describe('isExcludedFromListing', () => {
  it('根の .claude/worktrees の下と重いフォルダは外す', () => {
    expect(isExcludedFromListing('.claude/worktrees/a/src/x.ts')).toBe(true)
    expect(isExcludedFromListing('.claude/worktrees')).toBe(true)
    expect(isExcludedFromListing('a/node_modules/b.js')).toBe(true)
    expect(isExcludedFromListing('.claude/commands/x.md')).toBe(false)
    expect(isExcludedFromListing('.claude/worktrees-notes.md')).toBe(false)
    expect(isExcludedFromListing('src/.claude/worktrees.ts')).toBe(false)
  })
})

describe('rankPreparedQuickOpenFiles（上位だけ持つ絞り込み）', () => {
  // 決まった種から作る、それらしいパス
  const files: string[] = []
  let seed = 7
  const rand = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31
  const parts = ['src', 'main', 'renderer', 'shared', 'editor', 'files', 'quick', 'open', 'index', 'App', 'test', 'unit']
  for (let i = 0; i < 3000; i++) {
    const depth = 1 + Math.floor(rand() * 4)
    const segs = Array.from({ length: depth }, () => parts[Math.floor(rand() * parts.length)]!)
    files.push(`${segs.join('/')}${i % 7}.${rand() > 0.5 ? 'ts' : 'md'}`)
  }

  /** 全件を並べ替える素直なやり方（前の実装と同じ順になるか） */
  function naive(query: string, limit: number): string[] {
    return rankQuickOpenFiles(query, files, files.length).slice(0, limit).map((r) => r.path)
  }

  it.each([['q', 50], ['src', 50], ['mainidx', 10], ['open.md', 500], ['/', 1], ['zzz', 50]])('「%s」の上位 %i 件が全件の並べ替えと同じ', (query, limit) => {
    const prepared = prepareQuickOpenFiles(files)
    expect(rankPreparedQuickOpenFiles(query, prepared, limit).map((r) => r.path)).toEqual(naive(query, limit))
  })

  it('上限 0・空の問い合わせ', () => {
    const prepared = prepareQuickOpenFiles(files)
    expect(rankPreparedQuickOpenFiles('src', prepared, 0)).toEqual([])
    expect(rankPreparedQuickOpenFiles('  ', prepared, 3).map((r) => r.path)).toEqual(files.slice(0, 3))
  })

  it('20万件・1文字でも速い（打鍵のたびに固まらない）', () => {
    const many = Array.from({ length: 200_000 }, (_, i) => `pkg${i % 97}/src/module${i}/file${i}.ts`)
    const prepared = prepareQuickOpenFiles(many)
    const started = performance.now()
    expect(rankPreparedQuickOpenFiles('f', prepared, 500)).toHaveLength(500)
    expect(rankPreparedQuickOpenFiles('file199999', prepared, 50)[0]?.path).toBe(`pkg${199_999 % 97}/src/module199999/file199999.ts`)
    expect(performance.now() - started).toBeLessThan(1500)
  })
})

describe('ProjectWatcher の通知があふれたとき', () => {
  type Inner = { onFsEvent: (event: string, filename: string | null) => void }

  it('上限を超えた分は捨てるが、捨てたことを overflow で知らせる', () => {
    vi.useFakeTimers()
    try {
      const events: Array<{ paths: string[]; overflow?: boolean }> = []
      const watcher = new ProjectWatcher((e) => events.push(e))
      const inner = watcher as unknown as Inner
      for (let i = 0; i < 1200; i++) inner.onFsEvent('rename', `out/f${i}.js`)
      inner.onFsEvent('change', 'docs/plan.md')
      vi.advanceTimersByTime(200)
      expect(events).toHaveLength(1)
      expect(events[0]!.paths).toHaveLength(1000)
      expect(events[0]!.overflow).toBe(true)
      // 次のまとまりは、あふれていなければ overflow を付けない
      inner.onFsEvent('change', 'docs/plan.md')
      vi.advanceTimersByTime(200)
      expect(events[1]).toEqual({ paths: ['docs/plan.md'] })
      watcher.close()
    } finally {
      vi.useRealTimers()
    }
  })

  it('既に入っているパスの通知はあふれ扱いにしない', () => {
    vi.useFakeTimers()
    try {
      const events: Array<{ paths: string[]; overflow?: boolean }> = []
      const watcher = new ProjectWatcher((e) => events.push(e))
      const inner = watcher as unknown as Inner
      for (let i = 0; i < 1000; i++) inner.onFsEvent('rename', `f${i}`)
      inner.onFsEvent('change', 'f0')
      vi.advanceTimersByTime(200)
      expect(events[0]!.overflow).toBeUndefined()
      watcher.close()
    } finally {
      vi.useRealTimers()
    }
  })

  it('対象外のフォルダ（node_modules）の通知はあふれに数えない', () => {
    vi.useFakeTimers()
    try {
      const events: Array<{ paths: string[]; overflow?: boolean }> = []
      const watcher = new ProjectWatcher((e) => events.push(e))
      const inner = watcher as unknown as Inner
      for (let i = 0; i < 5000; i++) inner.onFsEvent('rename', `node_modules/x/${i}.js`)
      inner.onFsEvent('change', null)
      vi.advanceTimersByTime(200)
      expect(events).toEqual([])
      watcher.close()
    } finally {
      vi.useRealTimers()
    }
  })
})
