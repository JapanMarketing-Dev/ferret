import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { quoteShellPath, shellPathsText, shellQuotingFor, treePathsForTerminal, type DroppedEntry } from '@shared/externalDrop'
import { parseTreePaths } from '../../src/renderer/lib/treeDrag'
import { clearDroppedForTest, droppedFolder, inspectDropped, isRecentlyDropped, sanitizeDroppedPaths } from '../../src/main/droppedPaths'
import { planEditorDrop } from '../../src/renderer/lib/externalDrop'

/** 外からのドロップ: ターミナルへ入れるパスの引用、main での確かめ、エディタへのドロップの振り分け */

describe('ターミナルへ入れるパスの引用（posix: zsh / bash）', () => {
  it('引用の要らないパスはそのまま', () => {
    expect(quoteShellPath('/Users/taro/shop/src/index.ts', 'posix')).toBe('/Users/taro/shop/src/index.ts')
    expect(quoteShellPath('/tmp/日本語のフォルダ/画像.png', 'posix')).toBe('/tmp/日本語のフォルダ/画像.png')
  })
  it('空白を含む名前は \'…\' で囲む', () => {
    expect(quoteShellPath('/Users/taro/My Pictures/shot 1.png', 'posix')).toBe("'/Users/taro/My Pictures/shot 1.png'")
  })
  it('日本語と空白（全角の空白も）を含む名前', () => {
    expect(quoteShellPath('/tmp/スクリーンショット 2026-10-04 9.41.png', 'posix')).toBe("'/tmp/スクリーンショット 2026-10-04 9.41.png'")
    expect(quoteShellPath('/tmp/資料　最終.pdf', 'posix')).toBe("'/tmp/資料　最終.pdf'")
  })
  it("' を含む名前は '\\'' で閉じて開き直す", () => {
    expect(quoteShellPath("/tmp/it's here.txt", 'posix')).toBe(`'/tmp/it'\\''s here.txt'`)
  })
  it('" $ ` ! * などシェルが解釈する文字は展開されない形にする', () => {
    expect(quoteShellPath('/tmp/a"b.txt', 'posix')).toBe(`'/tmp/a"b.txt'`)
    expect(quoteShellPath('/tmp/$HOME`id`!*.txt', 'posix')).toBe("'/tmp/$HOME`id`!*.txt'")
    expect(quoteShellPath('/tmp/~user', 'posix')).toBe("'/tmp/~user'")
  })
})

describe('ターミナルへ入れるパスの引用（Windows）', () => {
  it('cmd: 空白などがあれば "…" で囲む', () => {
    expect(quoteShellPath('C:\\Users\\acme\\shop\\index.ts', 'cmd')).toBe('C:\\Users\\acme\\shop\\index.ts')
    expect(quoteShellPath('C:\\Users\\acme\\My Documents\\a.png', 'cmd')).toBe('"C:\\Users\\acme\\My Documents\\a.png"')
    expect(quoteShellPath('C:\\tmp\\a&b.txt', 'cmd')).toBe('"C:\\tmp\\a&b.txt"')
    expect(quoteShellPath("C:\\tmp\\it's.txt", 'cmd')).toBe(`"C:\\tmp\\it's.txt"`)
    expect(quoteShellPath('C:\\資料\\日本語 ファイル.txt', 'cmd')).toBe('"C:\\資料\\日本語 ファイル.txt"')
  })
  it('PowerShell: \'…\' で囲み、\' は \'\' にする（$ や ` を展開させない）', () => {
    expect(quoteShellPath('C:\\Users\\acme\\My Documents\\a.png', 'powershell')).toBe("'C:\\Users\\acme\\My Documents\\a.png'")
    expect(quoteShellPath("C:\\tmp\\it's $x`.txt", 'powershell')).toBe("'C:\\tmp\\it''s $x`.txt'")
  })
})

describe('shellPathsText / shellQuotingFor', () => {
  it('空白で区切り、最後に空白を1つ付ける', () => {
    expect(shellPathsText(['/a/b.png', '/c d/e.png'], 'posix')).toBe("/a/b.png '/c d/e.png' ")
  })
  it('改行などの制御文字を含むパスは入れない（貼っただけで実行されないように）', () => {
    expect(shellPathsText(['/tmp/a\nrm -rf ~', '/tmp/ok.txt'], 'posix')).toBe('/tmp/ok.txt ')
    expect(shellPathsText(['/tmp/a\rb'], 'posix')).toBe('')
    expect(shellPathsText([], 'posix')).toBe('')
  })
  it('OS とタブからシェルの書き方を選ぶ', () => {
    expect(shellQuotingFor('darwin')).toBe('posix')
    expect(shellQuotingFor('linux')).toBe('posix')
    expect(shellQuotingFor('win32', { title: '1: cmd' })).toBe('cmd')
    expect(shellQuotingFor('win32', { title: '2: pwsh' })).toBe('powershell')
    expect(shellQuotingFor('win32', { title: 'Windows PowerShell' })).toBe('powershell')
    // SSH のプロジェクトはリモートのシェル
    expect(shellQuotingFor('win32', { remote: true, title: '1: cmd' })).toBe('posix')
  })
})

describe('main: 落とされたパスの確かめ（droppedPaths.ts）', () => {
  const base = mkdtempSync(join(tmpdir(), 'ade-drop-'))
  const project = join(base, 'acme-shop')
  const outside = join(base, 'Desktop')
  mkdirSync(join(project, 'src'), { recursive: true })
  mkdirSync(outside, { recursive: true })
  writeFileSync(join(project, 'src', 'index.ts'), 'x')
  writeFileSync(join(outside, 'shot 1.png'), 'x')
  symlinkSync(join(outside, 'shot 1.png'), join(project, 'link.png'))

  beforeEach(() => clearDroppedForTest())
  afterAll(() => rmSync(base, { recursive: true, force: true }))

  it('絶対パスでないもの・NUL・文字列でないもの・重複は除く', () => {
    expect(sanitizeDroppedPaths(['relative/a', '/a\0b', 42, null, '/ok', '/ok'])).toEqual(['/ok'])
    expect(sanitizeDroppedPaths('not-an-array')).toEqual([])
  })

  it('ファイルとフォルダを見分け、無いものは除く。プロジェクトの中なら相対パスを添える', async () => {
    const entries = await inspectDropped([join(project, 'src', 'index.ts'), outside, join(base, 'missing.txt'), join(outside, 'shot 1.png')], project)
    expect(entries).toEqual<DroppedEntry[]>([
      { path: join(project, 'src', 'index.ts'), kind: 'file', relPath: 'src/index.ts' },
      { path: outside, kind: 'dir', relPath: null },
      { path: join(outside, 'shot 1.png'), kind: 'file', relPath: null }
    ])
  })

  it('プロジェクトの中のリンクが外を指すなら、中のファイルとしては扱わない', async () => {
    const [entry] = await inspectDropped([join(project, 'link.png')], project)
    expect(entry).toEqual({ path: join(project, 'link.png'), kind: 'file', relPath: null })
  })

  it('プロジェクトを開いていなければ相対パスは無い', async () => {
    const [entry] = await inspectDropped([join(project, 'src', 'index.ts')], null)
    expect(entry?.relPath).toBeNull()
  })

  it('確かめたフォルダだけを、しばらくの間プロジェクトとして追加できる', async () => {
    expect(await droppedFolder(outside)).toBeNull()
    const now = Date.now()
    await inspectDropped([outside, join(outside, 'shot 1.png')], null, now)
    expect(isRecentlyDropped(outside, now)).toBe(true)
    expect(await droppedFolder(outside, now)).toBe(outside)
    // ファイルはフォルダとしては使えない
    expect(await droppedFolder(join(outside, 'shot 1.png'), now)).toBeNull()
    // 落としていないフォルダ・時間切れ
    expect(await droppedFolder(project, now)).toBeNull()
    expect(await droppedFolder(outside, now + 60 * 60_000)).toBeNull()
    expect(await droppedFolder(42, now)).toBeNull()
  })

  it('上限より多いパスは捨てる', () => {
    const many = Array.from({ length: 500 }, (_, i) => `/tmp/f${i}`)
    expect(sanitizeDroppedPaths(many)).toHaveLength(200)
  })
})

describe('エディタの領域へのドロップの振り分け', () => {
  it('プロジェクトの中のファイルは開き、外のファイルはプロジェクトへコピーしてから開く', () => {
    expect(planEditorDrop([
      { path: '/p/src/a.ts', kind: 'file', relPath: 'src/a.ts' },
      { path: '/Desktop/b.png', kind: 'file', relPath: null }
    ])).toEqual({ open: ['src/a.ts'], copy: ['/Desktop/b.png'], folder: null, unreadable: false })
  })
  it('外のファイルだけなら全部コピーに回し、落とした順を保つ', () => {
    expect(planEditorDrop([
      { path: '/Desktop/z.txt', kind: 'file', relPath: null },
      { path: '/Desktop/a.csv', kind: 'file', relPath: null }
    ])).toEqual({ open: [], copy: ['/Desktop/z.txt', '/Desktop/a.csv'], folder: null, unreadable: false })
  })
  it('フォルダだけならプロジェクトとして開く', () => {
    expect(planEditorDrop([{ path: '/Desktop/other', kind: 'dir', relPath: null }])).toEqual({ open: [], copy: [], folder: '/Desktop/other', unreadable: false })
  })
  it('ファイルとフォルダが混ざっていれば、フォルダは開かない（外のファイルだけでも同じ）', () => {
    expect(planEditorDrop([
      { path: '/Desktop/other', kind: 'dir', relPath: null },
      { path: '/Desktop/b.txt', kind: 'file', relPath: null }
    ])).toEqual({ open: [], copy: ['/Desktop/b.txt'], folder: null, unreadable: false })
  })
  it('プロジェクトの中のフォルダだけでも、プロジェクトとして開く先にする（ファイルは無い）', () => {
    expect(planEditorDrop([{ path: '/p/src', kind: 'dir', relPath: 'src' }]).folder).toBe('/p/src')
  })
  it('何も読めなければ知らせる', () => {
    expect(planEditorDrop([]).unreadable).toBe(true)
  })
})

describe('ファイルツリーからターミナルへ', () => {
  it('作業フォルダがプロジェクトの根なら相対パス、ほかなら絶対パス', () => {
    expect(treePathsForTerminal(['src/index.ts', 'README.md'], { root: '/Users/taro/shop', cwd: '/Users/taro/shop/', platform: 'darwin' })).toEqual(['src/index.ts', 'README.md'])
    expect(treePathsForTerminal(['src/index.ts'], { root: '/Users/taro/shop', cwd: '/Users/taro/shop/src', platform: 'darwin' })).toEqual(['/Users/taro/shop/src/index.ts'])
    // 分からない（PTY がまだ無い）ときは絶対パス
    expect(treePathsForTerminal(['a b/c.png'], { root: '/home/taro/shop', cwd: null, platform: 'linux' })).toEqual(['/home/taro/shop/a b/c.png'])
    // Linux は大文字小文字を区別する
    expect(treePathsForTerminal(['x'], { root: '/home/taro/Shop', cwd: '/home/taro/shop', platform: 'linux' })).toEqual(['/home/taro/Shop/x'])
  })
  it('プロジェクトの根そのものは . か根の絶対パス', () => {
    expect(treePathsForTerminal([''], { root: '/p', cwd: '/p', platform: 'darwin' })).toEqual(['.'])
    expect(treePathsForTerminal([''], { root: '/p', cwd: '/tmp', platform: 'darwin' })).toEqual(['/p'])
  })
  it('Windows は区切りを \\ にし、大文字小文字を区別せずに比べる', () => {
    expect(treePathsForTerminal(['src/日本語 ファイル.ts'], { root: 'C:\\Users\\acme\\shop', cwd: 'c:\\users\\acme\\shop', platform: 'win32' })).toEqual(['src\\日本語 ファイル.ts'])
    expect(treePathsForTerminal(['src/a.ts'], { root: 'C:\\Users\\acme\\shop', cwd: 'D:\\', platform: 'win32' })).toEqual(['C:\\Users\\acme\\shop\\src\\a.ts'])
  })
  it('引用と合わせると、空白や \' を含む相対パスも1語になる', () => {
    const paths = treePathsForTerminal(["docs/it's a.md", 'src/a.ts'], { root: '/p', cwd: '/p', platform: 'darwin' })
    expect(shellPathsText(paths, 'posix')).toBe(`'docs/it'\\''s a.md' src/a.ts `)
  })
  it('ツリーのドラッグのデータは、形の合うものだけを受ける', () => {
    expect(parseTreePaths(JSON.stringify(['src/a.ts', 'README.md']))).toEqual(['src/a.ts', 'README.md'])
    expect(parseTreePaths(JSON.stringify(['/etc/passwd', '../x', 'a/../../b', 'C:/x', 'a\\b', 'ok', 42, 'a\u0000b']))).toEqual(['ok'])
    expect(parseTreePaths('not json')).toEqual([])
    expect(parseTreePaths('{"a":1}')).toEqual([])
  })
})
