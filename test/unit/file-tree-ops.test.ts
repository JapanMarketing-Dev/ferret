import { lstat, mkdir, mkdtemp, open, readdir, readFile, readlink, rm, symlink, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MAX_COPY_BYTES, MAX_COPY_ENTRIES, copyName, nestedNameProblem, uniqueName } from '@shared/files'
import { MAX_TRANSFER_ENTRIES, copyEntries, createEntry, importEntries, moveEntries, pathsForClipboard, terminalDirFor } from '../../src/main/fileOps'

// 期待値は日本語の文言。画面の言語を日本語に固定する（既定は英語）
import { setLocale } from '@shared/i18n'
setLocale('ja')

/**
 * ファイルツリーの一式の操作（貼り付け・複製・移動・取り込み・パスのコピー・ターミナルで開く・入れ子の作成）の main 側の検査。
 * どれもプロジェクトの外・.git の中・外を指すリンクを断り、上書きしない。
 */

describe('重ならない名前（copyName / uniqueName）', () => {
  it('Finder・VS Code と同じ「名前 copy」「名前 copy 2」', () => {
    expect(copyName('a.ts', 1, 'file')).toBe('a copy.ts')
    expect(copyName('a.ts', 2, 'file')).toBe('a copy 2.ts')
    expect(copyName('a.test.ts', 1, 'file')).toBe('a.test copy.ts')
    expect(copyName('.env', 1, 'file')).toBe('.env copy')
    expect(copyName('Makefile', 3, 'file')).toBe('Makefile copy 3')
    // フォルダは拡張子を分けない
    expect(copyName('v1.2', 1, 'directory')).toBe('v1.2 copy')
  })

  it('重ならなければそのまま、重なれば空いている番号。大文字小文字は区別しない', () => {
    expect(uniqueName('a.ts', 'file', ['b.ts'])).toBe('a.ts')
    expect(uniqueName('a.ts', 'file', ['a.ts'])).toBe('a copy.ts')
    expect(uniqueName('a.ts', 'file', ['A.TS', 'a copy.ts'])).toBe('a copy 2.ts')
    expect(uniqueName('src', 'directory', ['src', 'src copy', 'SRC COPY 2'])).toBe('src copy 3')
  })

  it('入れ子の名前は1階層ずつ確かめる', () => {
    expect(nestedNameProblem('a/b/c.ts')).toBeNull()
    expect(nestedNameProblem('a/../b')).toBe('dots')
    expect(nestedNameProblem('a//b')).toBe('empty')
    expect(nestedNameProblem('/a')).toBe('empty')
    expect(nestedNameProblem('a/')).toBe('empty')
    expect(nestedNameProblem('a\\b')).toBe('chars')
    expect(nestedNameProblem('a/.git/x')).toBe('git')
    expect(nestedNameProblem('a/CON/x')).toBe('reserved')
  })
})

describe('ファイルツリーの一式の操作（src/main/fileOps.ts）', () => {
  let base: string
  let root: string
  let outside: string

  beforeEach(async () => {
    base = await mkdtemp(join(tmpdir(), 'ade-filetree-'))
    root = join(base, 'project')
    outside = join(base, 'outside')
    await mkdir(join(root, 'src', 'lib'), { recursive: true })
    await mkdir(join(root, 'docs'))
    await mkdir(join(root, '.git'))
    await writeFile(join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n')
    await writeFile(join(root, 'src', 'a.ts'), 'export const a = 1\n')
    await writeFile(join(root, 'src', 'lib', 'util.ts'), 'export const u = 1\n')
    await writeFile(join(root, 'README.md'), '# hi\n')
    await mkdir(outside)
    await writeFile(join(outside, 'secret.txt'), 'secret')
    await symlink(outside, join(root, 'leakdir'))
    await symlink(join(root, '.git'), join(root, 'gitlink'))
  })

  afterEach(async () => {
    await rm(base, { recursive: true, force: true })
  })

  describe('createEntry（「a/b/c.ts」で途中のフォルダも作る）', () => {
    it('無い途中のフォルダを作り、いちばん上に作ったものを top で返す', async () => {
      await expect(createEntry(root, '', 'app/routes/index.ts', 'file')).resolves.toEqual({ path: 'app/routes/index.ts', top: 'app' })
      expect(await readFile(join(root, 'app', 'routes', 'index.ts'), 'utf8')).toBe('')
      // あるフォルダはそのまま使う。top は今回新しくできたところから
      await expect(createEntry(root, '', 'src/hooks/use.ts', 'file')).resolves.toEqual({ path: 'src/hooks/use.ts', top: 'src/hooks' })
      await expect(createEntry(root, 'src', 'lib/deep', 'directory')).resolves.toEqual({ path: 'src/lib/deep', top: 'src/lib/deep' })
    })

    it('途中がファイル・外を指すリンク・.git（リンク経由も）なら断る。外には何も作らない', async () => {
      await expect(createEntry(root, '', 'README.md/x.ts', 'file')).rejects.toThrow('フォルダの中にだけ')
      await expect(createEntry(root, '', 'leakdir/x.ts', 'file')).rejects.toThrow('プロジェクトフォルダの外')
      await expect(createEntry(root, '', 'leakdir/sub/x.ts', 'file')).rejects.toThrow('プロジェクトフォルダの外')
      await expect(createEntry(root, '', 'gitlink/hooks/x', 'file')).rejects.toThrow('.git の中')
      await expect(createEntry(root, '', 'a/.git/x', 'file')).rejects.toThrow('.git の中')
      expect(await readdir(outside)).toEqual(['secret.txt'])
      expect(existsSync(join(root, '.git', 'hooks'))).toBe(false)
      expect(existsSync(join(root, 'a'))).toBe(false)
    })

    it('最後の名前が既にあれば上書きしない', async () => {
      await expect(createEntry(root, '', 'src/a.ts', 'file')).rejects.toThrow('「a.ts」は既にあります')
      expect(await readFile(join(root, 'src', 'a.ts'), 'utf8')).toBe('export const a = 1\n')
    })
  })

  describe('copyEntries（貼り付け・複製）', () => {
    it('同じフォルダへのコピーは「名前 copy」「名前 copy 2」にする。中身は同じ、元はそのまま', async () => {
      await expect(copyEntries(root, ['src/a.ts'], 'src')).resolves.toEqual([{ from: 'src/a.ts', to: 'src/a copy.ts' }])
      await expect(copyEntries(root, ['src/a.ts'], 'src')).resolves.toEqual([{ from: 'src/a.ts', to: 'src/a copy 2.ts' }])
      expect(await readFile(join(root, 'src', 'a copy 2.ts'), 'utf8')).toBe('export const a = 1\n')
      expect(await readFile(join(root, 'src', 'a.ts'), 'utf8')).toBe('export const a = 1\n')
    })

    it('フォルダは中身ごと。別のフォルダで名前が重ならなければそのままの名前', async () => {
      await expect(copyEntries(root, ['src/lib', 'README.md'], 'docs')).resolves.toEqual([
        { from: 'src/lib', to: 'docs/lib' },
        { from: 'README.md', to: 'docs/README.md' }
      ])
      expect(await readFile(join(root, 'docs', 'lib', 'util.ts'), 'utf8')).toBe('export const u = 1\n')
      // 親と子を一緒に選んでも、子を2回写さない
      await expect(copyEntries(root, ['src', 'src/a.ts'], 'docs')).resolves.toEqual([{ from: 'src', to: 'docs/src' }])
    })

    // Windows のファイルには実行の権限が無い
    it.skipIf(process.platform === 'win32')('実行の権限を保つ', async () => {
      await writeFile(join(root, 'run.sh'), '#!/bin/sh\n', { mode: 0o755 })
      await copyEntries(root, ['run.sh'], '')
      expect((await lstat(join(root, 'run copy.sh'))).mode & 0o111).not.toBe(0)
    })

    it('フォルダをそれ自身の中へは写さない', async () => {
      await expect(copyEntries(root, ['src'], 'src/lib')).rejects.toThrow('それ自身の中')
      await expect(copyEntries(root, ['src'], 'src')).rejects.toThrow('それ自身の中')
      expect(await readdir(join(root, 'src', 'lib'))).toEqual(['util.ts'])
    })

    it('外・外を指すリンク・.git の中（元も先も）は断る', async () => {
      await expect(copyEntries(root, ['src/a.ts'], 'leakdir')).rejects.toThrow('プロジェクトフォルダの外')
      await expect(copyEntries(root, ['src/a.ts'], '..')).rejects.toThrow('プロジェクトフォルダの外')
      await expect(copyEntries(root, ['src/a.ts'], outside)).rejects.toThrow('プロジェクトフォルダの外')
      await expect(copyEntries(root, ['leakdir/secret.txt'], 'docs')).rejects.toThrow('プロジェクトフォルダの外')
      await expect(copyEntries(root, ['../outside/secret.txt'], 'docs')).rejects.toThrow('プロジェクトフォルダの外')
      await expect(copyEntries(root, ['src/a.ts'], '.git')).rejects.toThrow('.git の中')
      await expect(copyEntries(root, ['src/a.ts'], 'gitlink')).rejects.toThrow('.git の中')
      await expect(copyEntries(root, ['.git'], 'docs')).rejects.toThrow('.git の中')
      await expect(copyEntries(root, [''], 'docs')).rejects.toThrow('プロジェクトのフォルダそのもの')
      await expect(copyEntries(root, ['src/a.ts'], 'README.md')).rejects.toThrow('フォルダの中にだけ')
      await expect(copyEntries(root, [], 'docs')).rejects.toThrow()
      await expect(copyEntries(root, 'src/a.ts', 'docs')).rejects.toThrow()
      expect(await readdir(outside)).toEqual(['secret.txt'])
      expect(await readdir(join(root, 'docs'))).toEqual([])
    })

    it('中のリンクはリンクのまま写し、外の中身は読まない', async () => {
      await mkdir(join(root, 'linked'))
      await symlink(outside, join(root, 'linked', 'out'))
      await copyEntries(root, ['linked'], 'docs')
      expect((await lstat(join(root, 'docs', 'linked', 'out'))).isSymbolicLink()).toBe(true)
      expect(await readlink(join(root, 'docs', 'linked', 'out'))).toBe(outside)
    })

    it(`数が多すぎる（${MAX_COPY_ENTRIES} を超える）ときは何も写さずに知らせる`, async () => {
      // 1万個を作ると遅いので、上限を小さくして同じ動きを確かめる（上限の数そのものは下で確かめる）
      const limit = { entries: 20, bytes: MAX_COPY_BYTES }
      const many = join(root, 'many')
      await mkdir(many)
      await Promise.all(Array.from({ length: limit.entries }, (_, i) => writeFile(join(many, `f${i}`), '')))
      await expect(copyEntries(root, ['many'], 'docs', limit)).rejects.toThrow('一度にコピーできるのは 10,000 個まで')
      expect(await readdir(join(root, 'docs'))).toEqual([])
      // 上限ちょうど（フォルダ自身を含めて20個）なら写す
      await rm(join(many, 'f0'))
      await expect(copyEntries(root, ['many'], 'docs', limit)).resolves.toEqual([{ from: 'many', to: 'docs/many' }])
      expect(MAX_COPY_ENTRIES).toBe(10_000)
    })

    it('大きすぎる（1 GB を超える）ときは何も写さずに知らせる', async () => {
      const handle = await open(join(root, 'huge.bin'), 'w')
      await handle.truncate(MAX_COPY_BYTES + 1)
      await handle.close()
      await expect(copyEntries(root, ['huge.bin'], 'docs')).rejects.toThrow('一度にコピーできるのは 1 GB まで')
      expect(await readdir(join(root, 'docs'))).toEqual([])
    })

    it(`一度に選べるのは ${MAX_TRANSFER_ENTRIES} 個まで`, async () => {
      await expect(copyEntries(root, Array.from({ length: MAX_TRANSFER_ENTRIES + 1 }, () => 'src/a.ts'), 'docs')).rejects.toThrow()
    })
  })

  describe('moveEntries（切り取り・貼り付け、ドラッグ）', () => {
    it('別のフォルダへ動かす。名前は変えない', async () => {
      await expect(moveEntries(root, ['src/a.ts', 'src/lib'], 'docs')).resolves.toEqual([
        { from: 'src/a.ts', to: 'docs/a.ts' },
        { from: 'src/lib', to: 'docs/lib' }
      ])
      expect(existsSync(join(root, 'src', 'a.ts'))).toBe(false)
      expect(await readFile(join(root, 'docs', 'lib', 'util.ts'), 'utf8')).toBe('export const u = 1\n')
    })

    it('もともとそのフォルダにあるものは動かさない', async () => {
      await expect(moveEntries(root, ['src/a.ts'], 'src')).resolves.toEqual([{ from: 'src/a.ts', to: 'src/a.ts' }])
      expect(await readFile(join(root, 'src', 'a.ts'), 'utf8')).toBe('export const a = 1\n')
    })

    it('移動先に同じ名前（大文字小文字違いも）があれば、何も動かさずに断る', async () => {
      await writeFile(join(root, 'docs', 'A.TS'), 'other\n')
      await expect(moveEntries(root, ['README.md', 'src/a.ts'], 'docs')).rejects.toThrow('「a.ts」は既にあります')
      expect(existsSync(join(root, 'README.md'))).toBe(true)
      expect(existsSync(join(root, 'docs', 'README.md'))).toBe(false)
      expect(await readFile(join(root, 'docs', 'A.TS'), 'utf8')).toBe('other\n')
    })

    it('フォルダをそれ自身の中へは動かさない', async () => {
      await expect(moveEntries(root, ['src'], 'src/lib')).rejects.toThrow('それ自身の中')
      expect(existsSync(join(root, 'src', 'lib', 'util.ts'))).toBe(true)
    })

    it('外・外を指すリンク・.git の中へは動かさない。外のものを中へも動かさない', async () => {
      await expect(moveEntries(root, ['src/a.ts'], 'leakdir')).rejects.toThrow('プロジェクトフォルダの外')
      await expect(moveEntries(root, ['src/a.ts'], '..')).rejects.toThrow('プロジェクトフォルダの外')
      await expect(moveEntries(root, ['leakdir/secret.txt'], 'docs')).rejects.toThrow('プロジェクトフォルダの外')
      await expect(moveEntries(root, ['src/a.ts'], '.git')).rejects.toThrow('.git の中')
      await expect(moveEntries(root, ['src/a.ts'], 'gitlink')).rejects.toThrow('.git の中')
      await expect(moveEntries(root, ['.git/HEAD'], 'docs')).rejects.toThrow('.git の中')
      await expect(moveEntries(root, [''], 'docs')).rejects.toThrow('プロジェクトのフォルダそのもの')
      expect(await readdir(outside)).toEqual(['secret.txt'])
      expect(existsSync(join(root, 'src', 'a.ts'))).toBe(true)
      expect(existsSync(join(root, '.git', 'HEAD'))).toBe(true)
    })
  })

  describe('importEntries（Finder・エクスプローラーから落としたものの取り込み）', () => {
    let dropped: string
    const allow = (path: unknown) => typeof path === 'string' && path.startsWith(dropped)

    beforeEach(async () => {
      dropped = join(base, 'Downloads')
      await mkdir(join(dropped, 'assets', 'img'), { recursive: true })
      await writeFile(join(dropped, 'logo.svg'), '<svg/>')
      await writeFile(join(dropped, 'assets', 'img', 'a.png'), 'png')
      await symlink(outside, join(dropped, 'assets', 'link'))
    })

    it('ファイルとフォルダをコピーして取り込む。元はそのまま。中のリンクは写さない', async () => {
      await expect(importEntries(root, [join(dropped, 'logo.svg'), join(dropped, 'assets')], 'docs', allow)).resolves.toEqual([
        { from: 'logo.svg', to: 'docs/logo.svg' },
        { from: 'assets', to: 'docs/assets' }
      ])
      expect(await readFile(join(root, 'docs', 'assets', 'img', 'a.png'), 'utf8')).toBe('png')
      expect(existsSync(join(root, 'docs', 'assets', 'link'))).toBe(false)
      expect(await readFile(join(dropped, 'logo.svg'), 'utf8')).toBe('<svg/>')
    })

    it('同じ名前があれば「名前 copy」にする（上書きしない）', async () => {
      await writeFile(join(root, 'docs', 'logo.svg'), 'mine')
      await expect(importEntries(root, [join(dropped, 'logo.svg')], 'docs', allow)).resolves.toEqual([{ from: 'logo.svg', to: 'docs/logo copy.svg' }])
      expect(await readFile(join(root, 'docs', 'logo.svg'), 'utf8')).toBe('mine')
    })

    it('落とされていないパス・相対パスは読まない', async () => {
      await expect(importEntries(root, [join(outside, 'secret.txt')], 'docs', allow)).rejects.toThrow()
      await expect(importEntries(root, [join(outside, 'secret.txt')], 'docs')).rejects.toThrow()
      await expect(importEntries(root, ['logo.svg'], 'docs', () => true)).rejects.toThrow()
      expect(await readdir(join(root, 'docs'))).toEqual([])
    })

    it('取り込み先は中だけ（外・外を指すリンク・.git は断る）', async () => {
      await expect(importEntries(root, [join(dropped, 'logo.svg')], 'leakdir', allow)).rejects.toThrow('プロジェクトフォルダの外')
      await expect(importEntries(root, [join(dropped, 'logo.svg')], '..', allow)).rejects.toThrow('プロジェクトフォルダの外')
      await expect(importEntries(root, [join(dropped, 'logo.svg')], '.git', allow)).rejects.toThrow('.git の中')
      expect(await readdir(outside)).toEqual(['secret.txt'])
    })

    it('プロジェクトを含むフォルダを、そのプロジェクトの中へは取り込まない', async () => {
      await expect(importEntries(root, [base], 'docs', () => true)).rejects.toThrow('それ自身の中')
      expect(await readdir(join(root, 'docs'))).toEqual([])
    })

    it('ファイルでもフォルダでもないもの・リンクそのものは取り込まない', async () => {
      await expect(importEntries(root, [join(dropped, 'assets', 'link')], 'docs', allow)).rejects.toThrow('追加できません')
    })
  })

  describe('pathsForClipboard / terminalDirFor', () => {
    it('絶対パスと、OS の区切りの相対パス。複数なら1行に1つ', async () => {
      await expect(pathsForClipboard(root, ['src/a.ts'], 'absolute')).resolves.toBe(join(root, 'src', 'a.ts'))
      await expect(pathsForClipboard(root, ['src/lib/util.ts', 'README.md'], 'relative')).resolves.toBe(`src${sep}lib${sep}util.ts\nREADME.md`)
    })

    it('外のパスは出さない', async () => {
      await expect(pathsForClipboard(root, ['../outside/secret.txt'], 'absolute')).rejects.toThrow('プロジェクトフォルダの外')
      await expect(pathsForClipboard(root, ['leakdir/secret.txt'], 'relative')).rejects.toThrow('プロジェクトフォルダの外')
    })

    it('ターミナルの作業フォルダ: フォルダならそれ、ファイルならその親。外は断る', async () => {
      await expect(terminalDirFor(root, 'src/lib')).resolves.toBe(join(root, 'src', 'lib'))
      await expect(terminalDirFor(root, 'src/a.ts')).resolves.toBe(join(root, 'src'))
      await expect(terminalDirFor(root, '')).resolves.toBe(root)
      await expect(terminalDirFor(root, 'leakdir')).rejects.toThrow('プロジェクトフォルダの外')
      await expect(terminalDirFor(root, '..')).rejects.toThrow('プロジェクトフォルダの外')
    })
  })
})
