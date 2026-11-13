import { lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { entryNameProblem, isInsideGitDir, isSameOrUnder, movedPath } from '@shared/files'
import { MAX_TRASH_ENTRIES, createEntry, renameEntry, trashEntries } from '../../src/main/fileOps'

// 期待値は日本語の文言。画面の言語を日本語に固定する（既定は英語）
import { setLocale } from '@shared/i18n'
setLocale('ja')

describe('entryNameProblem（名前の検査）', () => {
  it('ふつうの名前は通す', () => {
    for (const name of ['a.ts', '.env', '..name', 'README', 'ファイル.md', 'con-fig.ts', 'a b.txt', 'auxiliary.ts']) expect(entryNameProblem(name)).toBeNull()
  })

  it('空・. と ..・区切り・制御文字を断る', () => {
    expect(entryNameProblem('')).toBe('empty')
    expect(entryNameProblem('   ')).toBe('empty')
    expect(entryNameProblem('.')).toBe('dots')
    expect(entryNameProblem('..')).toBe('dots')
    expect(entryNameProblem('../a')).toBe('chars')
    expect(entryNameProblem('a/b')).toBe('chars')
    expect(entryNameProblem('a\\b')).toBe('chars')
    expect(entryNameProblem('a\0b')).toBe('control')
    expect(entryNameProblem('a\nb')).toBe('control')
    expect(entryNameProblem('a\u007fb')).toBe('control')
  })

  it('Windows で使えない文字・予約名・末尾の空白やドットを断る', () => {
    for (const ch of ['<', '>', ':', '"', '|', '?', '*']) expect(entryNameProblem(`a${ch}b`)).toBe('chars')
    for (const name of ['CON', 'con', 'nul.txt', 'Aux.md', 'COM1', 'lpt9.log', 'PRN']) expect(entryNameProblem(name)).toBe('reserved')
    expect(entryNameProblem('a.')).toBe('trailing')
    expect(entryNameProblem('a ')).toBe('trailing')
  })

  it('.git と長すぎる名前を断る', () => {
    expect(entryNameProblem('.git')).toBe('git')
    expect(entryNameProblem('.GIT')).toBe('git')
    expect(entryNameProblem('a'.repeat(255))).toBeNull()
    expect(entryNameProblem('a'.repeat(256))).toBe('tooLong')
    // バイト数で数える（日本語は1文字3バイト）
    expect(entryNameProblem('あ'.repeat(86))).toBe('tooLong')
  })
})

describe('パスの小さな関数', () => {
  it('isInsideGitDir', () => {
    expect(isInsideGitDir('.git')).toBe(true)
    expect(isInsideGitDir('.git/config')).toBe(true)
    expect(isInsideGitDir('sub/.Git/hooks')).toBe(true)
    expect(isInsideGitDir('.github/workflows')).toBe(false)
    expect(isInsideGitDir('')).toBe(false)
  })

  it('isSameOrUnder と movedPath は名前の前方一致を取り違えない', () => {
    expect(isSameOrUnder('src/a.ts', 'src')).toBe(true)
    expect(isSameOrUnder('src2/a.ts', 'src')).toBe(false)
    expect(movedPath('src/a.ts', 'src', 'lib')).toBe('lib/a.ts')
    expect(movedPath('src', 'src', 'lib')).toBe('lib')
    expect(movedPath('src2/a.ts', 'src', 'lib')).toBeNull()
  })
})

describe('作成・名前の変更・ゴミ箱（src/main/fileOps.ts）', () => {
  let base: string
  let root: string

  beforeEach(async () => {
    base = await mkdtemp(join(tmpdir(), 'ade-fileops-'))
    root = join(base, 'project')
    await mkdir(join(root, 'src'), { recursive: true })
    await mkdir(join(root, '.git'), { recursive: true })
    await writeFile(join(root, '.git', 'config'), '[core]\n')
    await writeFile(join(root, 'src', 'a.ts'), 'export const a = 1\n')
    await writeFile(join(root, 'README.md'), '# hi\n')
    await mkdir(join(base, 'outside'))
    await writeFile(join(base, 'outside', 'secret.txt'), 'secret')
    await symlink(join(base, 'outside'), join(root, 'leakdir'))
    await symlink(join(root, '.git'), join(root, 'gitlink'))
  })

  afterEach(async () => {
    await rm(base, { recursive: true, force: true })
  })

  describe('createEntry', () => {
    it('空のファイルとフォルダを作り、相対パスを返す', async () => {
      await expect(createEntry(root, 'src', 'b.ts', 'file')).resolves.toEqual({ path: 'src/b.ts', top: 'src/b.ts' })
      expect(await readFile(join(root, 'src', 'b.ts'), 'utf8')).toBe('')
      await expect(createEntry(root, '', 'docs', 'directory')).resolves.toEqual({ path: 'docs', top: 'docs' })
      expect((await lstat(join(root, 'docs'))).isDirectory()).toBe(true)
    })

    it('既にある名前は上書きせずに断る', async () => {
      await expect(createEntry(root, 'src', 'a.ts', 'file')).rejects.toThrow('「a.ts」は既にあります')
      expect(await readFile(join(root, 'src', 'a.ts'), 'utf8')).toBe('export const a = 1\n')
      await expect(createEntry(root, '', 'src', 'directory')).rejects.toThrow('既にあります')
      await expect(createEntry(root, '', 'src', 'file')).rejects.toThrow('既にあります')
    })

    it('外へ出る親・外を指すリンクの中・絶対パスは断る', async () => {
      await expect(createEntry(root, '..', 'x.txt', 'file')).rejects.toThrow('プロジェクトフォルダの外')
      await expect(createEntry(root, 'leakdir', 'x.txt', 'file')).rejects.toThrow('プロジェクトフォルダの外')
      await expect(createEntry(root, join(base, 'outside'), 'x.txt', 'file')).rejects.toThrow('プロジェクトフォルダの外')
      expect(existsSync(join(base, 'outside', 'x.txt'))).toBe(false)
      expect(existsSync(join(base, 'x.txt'))).toBe(false)
    })

    it('名前で外へ出ようとするもの・使えない名前は断る', async () => {
      // 「/」は途中のフォルダの区切りとして読む。「..」の階層は断る
      await expect(createEntry(root, 'src', '../x.txt', 'file')).rejects.toThrow('「.」と「..」')
      await expect(createEntry(root, 'src', '..\\x.txt', 'file')).rejects.toThrow('/ \\ < > : " | ? *')
      await expect(createEntry(root, 'src', 'a//b.ts', 'file')).rejects.toThrow('名前を入力')
      await expect(createEntry(root, 'src', '/etc/x', 'file')).rejects.toThrow('名前を入力')
      await expect(createEntry(root, 'src', '..', 'directory')).rejects.toThrow('「.」と「..」')
      await expect(createEntry(root, 'src', 'NUL', 'file')).rejects.toThrow('Windows で予約')
      await expect(createEntry(root, 'src', 'x.', 'file')).rejects.toThrow('空白やドット')
      await expect(createEntry(root, 'src', 'a\u0001', 'file')).rejects.toThrow('制御文字')
      await expect(createEntry(root, 'src', '', 'file')).rejects.toThrow('名前を入力')
      expect(await readdir(join(root, 'src'))).toEqual(['a.ts'])
    })

    it('.git の中（リンク経由も）と .git という名前は断る', async () => {
      await expect(createEntry(root, '.git', 'x', 'file')).rejects.toThrow('.git の中')
      await expect(createEntry(root, 'gitlink', 'x', 'file')).rejects.toThrow('.git の中')
      await expect(createEntry(root, 'src', '.git', 'directory')).rejects.toThrow('.git の中')
      expect(existsSync(join(root, '.git', 'x'))).toBe(false)
    })

    it('親がファイル・無いフォルダ・種類の誤りは断る', async () => {
      await expect(createEntry(root, 'README.md', 'x', 'file')).rejects.toThrow('フォルダの中にだけ')
      await expect(createEntry(root, 'nope', 'x', 'file')).rejects.toThrow('見つかりません')
      await expect(createEntry(root, '', 'x', 'socket' as never)).rejects.toThrow()
    })
  })

  describe('renameEntry', () => {
    it('ファイルとフォルダの名前を変え、新しい相対パスを返す', async () => {
      await expect(renameEntry(root, 'src/a.ts', 'b.ts')).resolves.toBe('src/b.ts')
      expect(existsSync(join(root, 'src', 'a.ts'))).toBe(false)
      await expect(renameEntry(root, 'src', 'lib')).resolves.toBe('lib')
      expect(await readFile(join(root, 'lib', 'b.ts'), 'utf8')).toBe('export const a = 1\n')
    })

    it('同じ名前は何もしない。大文字小文字だけの変更は通す', async () => {
      await expect(renameEntry(root, 'README.md', 'README.md')).resolves.toBe('README.md')
      await expect(renameEntry(root, 'README.md', 'readme.md')).resolves.toBe('readme.md')
      expect(await readdir(root)).toContain('readme.md')
      expect(await readdir(root)).not.toContain('README.md')
    })

    it('既にある名前へは上書きせずに断る', async () => {
      await writeFile(join(root, 'src', 'b.ts'), 'keep\n')
      await expect(renameEntry(root, 'src/a.ts', 'b.ts')).rejects.toThrow('「b.ts」は既にあります')
      expect(await readFile(join(root, 'src', 'b.ts'), 'utf8')).toBe('keep\n')
      expect(existsSync(join(root, 'src', 'a.ts'))).toBe(true)
    })

    it('外への名前・外のパス・根・.git は断る', async () => {
      await expect(renameEntry(root, 'src/a.ts', '../../escaped.ts')).rejects.toThrow('/ \\ < > : " | ? *')
      await expect(renameEntry(root, '../outside', 'x')).rejects.toThrow('プロジェクトフォルダの外')
      await expect(renameEntry(root, 'leakdir/secret.txt', 'x.txt')).rejects.toThrow('プロジェクトフォルダの外')
      await expect(renameEntry(root, '', 'x')).rejects.toThrow('プロジェクトのフォルダそのもの')
      await expect(renameEntry(root, '.', 'x')).rejects.toThrow('プロジェクトのフォルダそのもの')
      await expect(renameEntry(root, '.git', 'git2')).rejects.toThrow('.git の中')
      await expect(renameEntry(root, '.git/config', 'c')).rejects.toThrow('.git の中')
      await expect(renameEntry(root, 'src', '.git')).rejects.toThrow('.git の中')
      await expect(renameEntry(root, 'missing.ts', 'x.ts')).rejects.toThrow('見つかりません')
      expect(existsSync(join(base, 'escaped.ts'))).toBe(false)
      expect(existsSync(join(base, 'outside', 'secret.txt'))).toBe(true)
    })
  })

  describe('trashEntries', () => {
    it('ゴミ箱の口へ絶対パス（確かめた実体のパス）を渡し、送った相対パスを返す。親と子を両方選んだら親だけ', async () => {
      const trash = vi.fn(async (_absolute: string) => {})
      await expect(trashEntries(root, ['src', 'src/a.ts', 'README.md', 'README.md'], trash)).resolves.toEqual(['src', 'README.md'])
      const real = await realpath(root)
      expect(trash.mock.calls.map(([p]) => p)).toEqual([join(real, 'src'), join(real, 'README.md')])
    })

    it('1つでも断るものがあれば何も送らない（外・根・.git・無いもの）', async () => {
      const trash = vi.fn(async (_absolute: string) => {})
      await expect(trashEntries(root, ['README.md', '../outside'], trash)).rejects.toThrow('プロジェクトフォルダの外')
      await expect(trashEntries(root, ['README.md', 'leakdir'], trash)).rejects.toThrow('プロジェクトフォルダの外')
      await expect(trashEntries(root, ['README.md', ''], trash)).rejects.toThrow('プロジェクトのフォルダそのもの')
      await expect(trashEntries(root, ['README.md', '.git'], trash)).rejects.toThrow('.git の中')
      await expect(trashEntries(root, ['README.md', 'gitlink/config'], trash)).rejects.toThrow('.git の中')
      await expect(trashEntries(root, ['README.md', join(root, 'src')], trash)).rejects.toThrow('プロジェクトフォルダの外')
      await expect(trashEntries(root, ['README.md', 'missing'], trash)).rejects.toThrow('見つかりません')
      expect(trash).not.toHaveBeenCalled()
    })

    it('形の誤り（配列でない・空・多すぎる）は断る', async () => {
      const trash = vi.fn(async (_absolute: string) => {})
      await expect(trashEntries(root, 'README.md', trash)).rejects.toThrow()
      await expect(trashEntries(root, [], trash)).rejects.toThrow()
      await expect(trashEntries(root, Array.from({ length: MAX_TRASH_ENTRIES + 1 }, () => 'README.md'), trash)).rejects.toThrow()
      expect(trash).not.toHaveBeenCalled()
    })

    it('ゴミ箱へ送れなければ、パスを含まない文言で知らせる', async () => {
      const trash = vi.fn(async () => { throw new Error(`EPERM: ${join(root, 'README.md')}`) })
      const err = await trashEntries(root, ['README.md'], trash).catch((e: Error) => e)
      expect((err as Error).message).toBe('「README.md」を削除できませんでした')
    })
  })
})
