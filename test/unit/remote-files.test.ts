import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  isValidNewFolderName,
  isValidRemoteRelPath,
  parseRemoteBrowse,
  parseRemoteListing,
  parseRemoteSearch,
  posixParent,
  remoteBrowseCommand,
  remoteCreateCommand,
  remoteCreated,
  remoteListCommand,
  remoteWriteCommand,
  remoteMkdirCommand,
  remoteReadCommand,
  remoteSearchCommand,
  MAX_REMOTE_SEARCH
} from '../../src/shared/remoteFiles'
import {
  isValidTmuxSessionName,
  remoteShellCommand,
  sshShellSpec,
  tmuxHasSessionCommand,
  tmuxKillSessionCommand,
  tmuxLeaveCopyModeCommand,
  tmuxSessionName
} from '../../src/shared/sshCommand'
import {
  browseRemoteFolders,
  createRemoteEntry,
  createRemoteFolder,
  writeRemoteFile,
  killTmuxSession,
  leaveTmuxCopyMode,
  TMUX_LEAVE_COPY_MODE_TIMEOUT_MS,
  listRemoteDirectory,
  readRemoteFile,
  searchRemoteNames,
  sshMultiplexOptions,
  tmuxSessionExists,
  type SshRunner
} from '../../src/main/remoteFiles'
import { browseLocalFolders, createLocalFolder, forgetBrowsedFolders, isBrowsedFolder } from '../../src/main/folderBrowse'
import { joinFolder, registeredSshConnections } from '../../src/renderer/lib/newProjectPlaces'
import type { Project } from '../../src/shared/types'

const posix = process.platform !== 'win32'

/** ssh の代わりに、手元の sh でリモートの1行を動かす（HOME を一時フォルダにする）。組み立てた1行の引用が本当に効くかを見る */
function localShell(home: string): SshRunner & { calls: Array<{ host: string; command: string }> } {
  const calls: Array<{ host: string; command: string }> = []
  const run: SshRunner = (host, command, options = {}) => {
    calls.push({ host, command })
    return new Promise((resolve) => {
      const child = execFile('sh', ['-c', command], { env: { PATH: process.env.PATH, HOME: home, SHELL: '/bin/sh' }, encoding: 'buffer', cwd: home },
        (error, stdout, stderr) => {
          const code = error ? (typeof (error as { code?: unknown }).code === 'number' ? (error as { code: number }).code : 255) : 0
          resolve({ code, stdout: Buffer.from(stdout), stderr: Buffer.from(stderr).toString('utf8') })
        })
      child.stdin?.on('error', () => undefined)
      child.stdin?.end(options.input)
    })
  }
  return Object.assign(run, { calls })
}

describe('リモートの相対パスとフォルダ名の判定', () => {
  it.each([
    ['', true], ['src', true], ['src/app.ts', true], ['a b/c d', true], ["it's/x", true],
    ['/etc', false], ['../x', false], ['src/../../x', false], ['src/./x', false], ['src//x', false], ['~/x', false], ['-rf', false], ['a\nb', false], ['a\0b', false]
  ])('%j → %s', (rel, ok) => {
    expect(isValidRemoteRelPath(rel)).toBe(ok)
  })

  it('長すぎるパスは受け付けない', () => {
    expect(isValidRemoteRelPath('a/'.repeat(3000))).toBe(false)
  })

  it.each([
    ['my-app', true], ['日本語 フォルダ', true], ['  pad  ', true], ['.hidden', true],
    ['', false], ['   ', false], ['.', false], ['..', false], ['a/b', false], ['a\\b', false], ['a\tb', false], ['x'.repeat(256), false]
  ])('フォルダ名 %j → %s', (name, ok) => {
    expect(isValidNewFolderName(name)).toBe(ok)
  })

  it('posixParent は上のフォルダを返し、/ では null', () => {
    expect(posixParent('/home/me/src')).toBe('/home/me')
    expect(posixParent('/home')).toBe('/')
    expect(posixParent('/home/me/')).toBe('/home')
    expect(posixParent('/')).toBeNull()
  })
})

describe('リモートで動かす1行の組み立て（注入対策）', () => {
  it('一覧: 相対パスは単一引用符で囲み、~ はリモートの $HOME にする', () => {
    expect(remoteListCommand('~/src/app', "a'b; rm -rf ~")).toBe(`cd "$HOME"/'src/app' && cd -- 'a'\\''b; rm -rf ~' && LC_ALL=C ls -1ApL`)
    expect(remoteListCommand('/srv/app', '')).toBe(`cd '/srv/app' && cd -- '.' && LC_ALL=C ls -1ApL`)
  })

  it('外へ出る相対パスは組み立てない', () => {
    expect(() => remoteListCommand('/srv', '../etc')).toThrow()
    expect(() => remoteReadCommand('/srv', '/etc/passwd', 10)).toThrow()
    expect(() => remoteReadCommand('/srv', '', 10)).toThrow()
  })

  it('読み込みは上限＋1バイトまで', () => {
    expect(remoteReadCommand('/srv', 'a.txt', 100)).toContain('head -c 101 -- ')
  })

  it('検索の glob の特別な文字は打ち消す', () => {
    expect(remoteSearchCommand('/srv', 'a*b?[c]')).toContain(`-iname '*a\\*b\\?\\[c\\]*'`)
  })

  it('場所の一覧: 相対パスは受け付けない', () => {
    expect(remoteBrowseCommand(null)).toBe('cd "$HOME" && pwd && LC_ALL=C ls -1pL')
    expect(() => remoteBrowseCommand('src')).toThrow()
    expect(() => remoteBrowseCommand('/a\nb')).toThrow()
  })

  it('フォルダ作成: 親は絶対パス、名前は確かめる', () => {
    expect(() => remoteMkdirCommand('relative', 'x')).toThrow()
    expect(() => remoteMkdirCommand('/srv', '../x')).toThrow()
    expect(remoteMkdirCommand('/srv', "it's")).toContain(`mkdir -- 'it'\\''s'`)
  })
})

describe('リモートに書く1行', () => {
  it('名前は単一引用符で囲み、大きさは数だけ。使えないパス・大きさは組み立てない', () => {
    const cmd = remoteWriteCommand('~/proj', "a/it's.md", 12)
    expect(cmd).toContain(`'a/it'\\''s.md'`)
    expect(cmd).toContain("= '12' ]")
    expect(() => remoteWriteCommand('~/proj', '/etc/passwd', 1)).toThrow()
    expect(() => remoteWriteCommand('~/proj', '', 1)).toThrow()
    expect(() => remoteWriteCommand('~/proj', 'a.md', -1)).toThrow()
    expect(() => remoteWriteCommand('~/proj', 'a.md', 1.5)).toThrow()
  })
})

describe('リモートに作る1行', () => {
  it('名前は単一引用符で囲み、- で始まる名前もオプションにしない', () => {
    const cmd = remoteCreateCommand('~/proj', 'src', '-rf', 'file')
    expect(cmd).toContain("( set -C; : > '-rf' )")
    expect(remoteCreateCommand('~/proj', '', 'a/b', 'directory')).toContain("mkdir -- 'a'")
    expect(remoteCreateCommand('~/proj', '', 'a/b', 'directory')).toContain("mkdir -- 'b'")
  })

  it('使えない相対パス・名前・種類は組み立てない', () => {
    expect(() => remoteCreateCommand('~/proj', '/etc', 'x', 'file')).toThrow()
    expect(() => remoteCreateCommand('~/proj', '', 'a\\b', 'file')).toThrow()
    expect(() => remoteCreateCommand('~/proj', '', 'x', 'link' as never)).toThrow()
    expect(() => remoteCreateCommand('~/proj', '.git', 'x', 'file')).toThrow()
  })

  it('出力から作ったものと新しくできたいちばん上を読む', () => {
    expect(remoteCreated('', '', 'a.ts')).toEqual({ path: 'a.ts', top: 'a.ts' })
    expect(remoteCreated('top 1\n', 'src', 'a/b/c.ts')).toEqual({ path: 'src/a/b/c.ts', top: 'src/a/b' })
    expect(remoteCreated('top 9\n', '', 'a/b')).toEqual({ path: 'a/b', top: 'a/b' })
  })
})

describe('出力の読み取り', () => {
  it('ls の一覧: フォルダが先・自然順・重いフォルダは畳む', () => {
    const entries = parseRemoteListing('file10.txt\nfile2.txt\nsrc/\n.git/\nnode_modules/\n\n./\n../\n', '')
    expect(entries.map((e) => e.path)).toEqual(['.git', 'node_modules', 'src', 'file2.txt', 'file10.txt'])
    expect(entries.find((e) => e.name === 'node_modules')?.collapsed).toBe(true)
    expect(entries.find((e) => e.name === 'src')?.collapsed).toBeUndefined()
  })

  it('ls の一覧: 子のパスは親につなぐ。上限で止める', () => {
    expect(parseRemoteListing('a.ts\n', 'src/lib')[0]).toEqual({ name: 'a.ts', path: 'src/lib/a.ts', kind: 'file' })
    expect(parseRemoteListing('a\nb\nc\n', '', 2)).toHaveLength(2)
  })

  it('検索: ./ を外し、上限を超えたら打ち切りの印', () => {
    expect(parseRemoteSearch('./a.ts\n./src/b.ts\n')).toEqual({ files: ['a.ts', 'src/b.ts'], truncated: false })
    const many = Array.from({ length: MAX_REMOTE_SEARCH + 1 }, (_, i) => `./f${i}`).join('\n')
    expect(parseRemoteSearch(many)).toMatchObject({ truncated: true })
    expect(parseRemoteSearch(many).files).toHaveLength(MAX_REMOTE_SEARCH)
  })

  it('場所の一覧: 1行目が絶対パスでなければ読めない。. で始まるフォルダとファイルは出さない', () => {
    expect(parseRemoteBrowse('/home/me\nsrc/\n.cache/\nnotes.txt\nb10/\nb2/\n')).toEqual({ path: '/home/me', parent: '/home', folders: ['b2', 'b10', 'src'] })
    expect(parseRemoteBrowse('oops\n')).toBeNull()
    expect(parseRemoteBrowse('/\nusr/\n')).toEqual({ path: '/', parent: null, folders: ['usr'] })
  })
})

describe('tmux のセッション（SSH のタブの常駐）', () => {
  const target = { host: 'dev-box', path: '~/src/my.app' }

  it('セッション名は tmux で使える文字だけで、接続先とタブの印で決まる', () => {
    const name = tmuxSessionName(target, 'abc123')
    expect(isValidTmuxSessionName(name)).toBe(true)
    expect(name).toMatch(/^ferret-my-app-[0-9a-f]{8}-abc123$/)
    expect(tmuxSessionName(target, 'abc123')).toBe(name)
    expect(tmuxSessionName(target, 'zzz')).not.toBe(name)
    expect(tmuxSessionName({ host: 'other', path: target.path }, 'abc123')).not.toBe(name)
    expect(tmuxSessionName({ host: 'h', path: '~' }, 'x;rm')).toMatch(/^ferret-home-[0-9a-f]{8}-xrm$/)
  })

  it.each([['a.b', false], ['a:b', false], ['', false], ['ok_1-2', true], ['x'.repeat(101), false]])('名前 %j → %s', (name, ok) => {
    expect(isValidTmuxSessionName(name)).toBe(ok)
  })

  it('tmux を渡さないときは今まで通りログインシェル', () => {
    expect(remoteShellCommand('/srv/app')).toBe(`cd '/srv/app' && exec "$SHELL" -l`)
  })

  it('tmux があればそのセッションにつなぐ（無ければ作る）。無ければ知らせてログインシェル', () => {
    const line = remoteShellCommand('~/app', { session: 'ferret-app-1-t', notice: "no tmux; it's\nfine" })
    expect(line).toContain(`exec tmux new-session -A -s 'ferret-app-1-t' ';' `)
    expect(line).toContain(`printf '%s\\r\\n' 'no tmux; it'\\''s fine'`)
    expect(line).toContain('exec "$SHELL" -l; fi')
    expect(() => remoteShellCommand('~/app', { session: 'bad name', notice: '' })).toThrow()
  })

  it('つないだらそのセッションだけマウスを有効にする（ホイールで tmux のコピーモード。-g は使わない）', () => {
    const line = remoteShellCommand('~/app', { session: 'ferret-app-1-t', notice: 'n' })
    // ; は引用して tmux に1語で渡す（コマンドの区切り）。set-option の -t はペインの形（= 名前 :）でないと見つからない
    expect(line).toContain(`exec tmux new-session -A -s 'ferret-app-1-t' ';' set-option -q -t '=ferret-app-1-t:' mouse on; else`)
    expect(line).not.toMatch(/set-option[^;]*-g/)
    expect(line).not.toMatch(/bind-key|unbind|-L |-S /)
  })

  it('sshShellSpec は -t -- host <1行>', () => {
    const spec = sshShellSpec(target, { session: 'ferret-x-1-t', notice: 'n' })
    expect(spec.file).toBe('ssh')
    expect(spec.args.slice(0, 3)).toEqual(['-t', '--', 'dev-box'])
    expect(spec.args[3]).toContain('tmux new-session -A -s')
  })

  it('has-session / kill-session は = で名前を完全一致にする', () => {
    expect(tmuxHasSessionCommand('ferret-a-1-t')).toBe(`tmux has-session -t '=ferret-a-1-t'`)
    expect(tmuxKillSessionCommand('ferret-a-1-t')).toBe(`tmux kill-session -t '=ferret-a-1-t'`)
    expect(() => tmuxKillSessionCommand('a;b')).toThrow()
  })

  it('コピーモードを抜ける1行: 入っていれば cancel して 1、いなければ 0（中のコマンドにも -t を書く）', () => {
    expect(tmuxLeaveCopyModeCommand('ferret-a-1-t')).toBe(
      `tmux display-message -p -t '=ferret-a-1-t:' '#{pane_in_mode}' ';' if-shell -F -t '=ferret-a-1-t:' '#{pane_in_mode}' 'send-keys -X -t =ferret-a-1-t: cancel'`
    )
    for (const bad of ["a'b", 'a;b', 'a b', 'a:b', '$(x)', '']) expect(() => tmuxLeaveCopyModeCommand(bad), bad).toThrow()
  })

  it('leaveTmuxCopyMode: 1 なら抜けた・0 なら入っていない・それ以外（失敗・接続できない・分からない出力）は null。待つのは短く', async () => {
    const calls: Array<{ command: string; timeoutMs?: number }> = []
    const reply = (code: number, stdout: string): SshRunner => async (_h, command, options) => {
      calls.push({ command, timeoutMs: options?.timeoutMs })
      return { code, stdout: Buffer.from(stdout), stderr: '' }
    }
    expect(await leaveTmuxCopyMode('h', 'ferret-a-1-t', reply(0, '1\n'))).toBe(true)
    expect(await leaveTmuxCopyMode('h', 'ferret-a-1-t', reply(0, '0\n'))).toBe(false)
    // 無いセッションは何も出さずに 0 で終わる（tmux 3.5a で確かめた）。ツリーのモードは cancel が効かず 1
    expect(await leaveTmuxCopyMode('h', 'ferret-a-1-t', reply(0, ''))).toBeNull()
    expect(await leaveTmuxCopyMode('h', 'ferret-a-1-t', reply(1, '1\n'))).toBeNull()
    expect(await leaveTmuxCopyMode('h', 'ferret-a-1-t', reply(255, ''))).toBeNull()
    expect(await leaveTmuxCopyMode('h', 'ferret-a-1-t', () => Promise.reject(new Error('x')))).toBeNull()
    expect(calls[0]).toEqual({ command: tmuxLeaveCopyModeCommand('ferret-a-1-t'), timeoutMs: TMUX_LEAVE_COPY_MODE_TIMEOUT_MS })
    expect(TMUX_LEAVE_COPY_MODE_TIMEOUT_MS).toBeLessThanOrEqual(5000)
  })

  it.runIf(posix)('tmux が無いリモートでは知らせを出してシェルになる（手元の sh で確かめる）', async () => {
    const home = mkdtempSync(join(tmpdir(), 'ferret-tmux-'))
    try {
      // PATH から tmux を外し、シェルは即終わる sh -c 'echo shell' の代わりに SHELL=/bin/echo
      const line = remoteShellCommand('~', { session: 'ferret-h-1-t', notice: 'NO TMUX' })
      const out = await new Promise<string>((resolve) => execFile('/bin/sh', ['-c', line], { env: { PATH: '/nonexistent', HOME: home, SHELL: '/bin/echo' } }, (_e, stdout) => resolve(String(stdout))))
      expect(out).toContain('NO TMUX')
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('tmuxSessionExists: 0 ならある・1 なら無い・接続できなければ null', async () => {
    const code = (c: number): SshRunner => async () => ({ code: c, stdout: Buffer.alloc(0), stderr: '' })
    expect(await tmuxSessionExists('h', 'ferret-a-1-t', code(0))).toBe(true)
    expect(await tmuxSessionExists('h', 'ferret-a-1-t', code(1))).toBe(false)
    expect(await tmuxSessionExists('h', 'ferret-a-1-t', code(255))).toBeNull()
    expect(await tmuxSessionExists('h', 'ferret-a-1-t', () => Promise.reject(new Error('x')))).toBeNull()
  })

  it('killTmuxSession は kill-session を送る（失敗しても投げない）', async () => {
    const calls: string[] = []
    killTmuxSession('h', 'ferret-a-1-t', async (_h, c) => { calls.push(c); throw new Error('down') })
    await new Promise((r) => setTimeout(r, 0))
    expect(calls).toEqual([`tmux kill-session -t '=ferret-a-1-t'`])
  })
})

describe('接続の使い回し', () => {
  it('macOS・Linux は ControlMaster、Windows は使わない', () => {
    expect(sshMultiplexOptions('darwin', '/Users/me')).toEqual(['-o', 'ControlMaster=auto', '-o', 'ControlPath=/Users/me/.ssh/ferret-cm-%C', '-o', 'ControlPersist=120'])
    expect(sshMultiplexOptions('win32', 'C:\\Users\\u')).toEqual([])
  })
})

describe.runIf(posix)('リモートのファイルツリー（手元の sh で結合）', () => {
  let home: string
  let run: ReturnType<typeof localShell>
  const target = () => ({ host: 'dev-box', path: '~/proj' })

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'ferret-remote-'))
    const proj = join(home, 'proj')
    mkdirSync(join(proj, 'src', 'deep'), { recursive: true })
    mkdirSync(join(proj, "we'ird dir"))
    mkdirSync(join(proj, 'node_modules', 'pkg'), { recursive: true })
    writeFileSync(join(proj, 'README.md'), '# hi\n')
    writeFileSync(join(proj, 'src', 'main.ts'), 'export {}\n')
    writeFileSync(join(proj, 'src', 'deep', 'Main.test.ts'), 'x\n')
    writeFileSync(join(proj, 'node_modules', 'pkg', 'main.js'), 'x\n')
    writeFileSync(join(proj, 'bin.dat'), Buffer.from([0, 1, 2, 3]))
    writeFileSync(join(proj, 'big.txt'), 'a'.repeat(50))
    symlinkSync(join(proj, 'src'), join(proj, 'link-to-src'))
    symlinkSync(join(proj, 'missing'), join(proj, 'broken'))
    run = localShell(home)
  })
  afterEach(() => rmSync(home, { recursive: true, force: true }))

  it('根の一覧（リンク先のフォルダはフォルダ、切れたリンクがあっても出す）', async () => {
    const entries = await listRemoteDirectory(target(), '', run)
    const names = entries.map((e) => `${e.kind === 'directory' ? 'd' : 'f'}:${e.name}`)
    expect(names).toEqual(expect.arrayContaining(['d:src', 'd:link-to-src', "d:we'ird dir", 'd:node_modules', 'f:README.md', 'f:bin.dat']))
    expect(names.indexOf('d:src')).toBeLessThan(names.indexOf('f:README.md'))
    expect(run.calls[0]!.host).toBe('dev-box')
  })

  it('子のフォルダ・引用符を含む名前のフォルダも読める', async () => {
    expect((await listRemoteDirectory(target(), 'src', run)).map((e) => e.path)).toEqual(['src/deep', 'src/main.ts'])
    expect(await listRemoteDirectory(target(), "we'ird dir", run)).toEqual([])
  })

  it('無いフォルダはエラーにする', async () => {
    await expect(listRemoteDirectory(target(), 'nope', run)).rejects.toThrow()
  })

  it('文字のファイルを読む・バイナリと大きすぎるものは理由を返す', async () => {
    expect(await readRemoteFile(target(), 'README.md', run)).toEqual({ kind: 'text', path: 'README.md', content: '# hi\n', mtimeMs: 0 })
    expect((await readRemoteFile(target(), 'bin.dat', run)).kind).toBe('binary')
    const big = await readRemoteFile(target(), 'big.txt', run, 10)
    expect(big.kind).toBe('tooLarge')
    expect((await readRemoteFile(target(), 'big.txt', run, 50)).kind).toBe('text')
  })

  it('フォルダや無いファイルは読まない', async () => {
    await expect(readRemoteFile(target(), 'src', run)).rejects.toThrow()
    await expect(readRemoteFile(target(), 'nope.txt', run)).rejects.toThrow()
  })

  it('名前で絞り込む（大文字小文字を問わず、node_modules と .git は見ない）', async () => {
    const result = await searchRemoteNames(target(), 'main', run)
    expect(result.files.sort()).toEqual(['src/deep/Main.test.ts', 'src/main.ts'])
    expect(result.truncated).toBe(false)
    expect((await searchRemoteNames(target(), '  ', run)).files).toEqual([])
  })

  it('場所の一覧: ホームから・指定の場所・上のフォルダ', async () => {
    const top = await browseRemoteFolders('dev-box', null, run)
    expect(top.folders).toEqual(['proj'])
    const proj = await browseRemoteFolders('dev-box', '~/proj', run)
    expect(proj.folders).toEqual(['link-to-src', 'node_modules', 'src', "we'ird dir"])
    expect(proj.parent).toBe(top.path)
    await expect(browseRemoteFolders('dev-box', '/nope/nowhere', run)).rejects.toThrow()
  })

  it('フォルダを作る。既にあれば作らずに知らせる', async () => {
    const top = await browseRemoteFolders('dev-box', null, run)
    const made = await createRemoteFolder('dev-box', top.path, 'new app', run)
    expect(made.endsWith('/new app')).toBe(true)
    expect(existsSync(join(home, 'new app'))).toBe(true)
    await expect(createRemoteFolder('dev-box', top.path, 'new app', run)).rejects.toThrow(/new app/)
  })

  it('ssh が失敗（255）したら接続できなかったと伝える', async () => {
    const down: SshRunner = async () => ({ code: 255, stdout: Buffer.alloc(0), stderr: 'ssh: connect to host dev-box port 22: Connection refused\n' })
    await expect(listRemoteDirectory(target(), '', down)).rejects.toThrow(/dev-box/)
  })

  it('ツリーから空のファイル・フォルダを作る（根・子のフォルダ・引用符を含む名前）', async () => {
    expect(await createRemoteEntry(target(), '', 'notes.md', 'file', run)).toEqual({ path: 'notes.md', top: 'notes.md' })
    expect(readFileSync(join(home, 'proj', 'notes.md'), 'utf8')).toBe('')
    expect(await createRemoteEntry(target(), 'src', 'lib', 'directory', run)).toEqual({ path: 'src/lib', top: 'src/lib' })
    expect(statSync(join(home, 'proj', 'src', 'lib')).isDirectory()).toBe(true)
    expect(await createRemoteEntry(target(), "we'ird dir", "it's $(x).ts", 'file', run)).toEqual({ path: "we'ird dir/it's $(x).ts", top: "we'ird dir/it's $(x).ts" })
    expect(existsSync(join(home, 'proj', "we'ird dir", "it's $(x).ts"))).toBe(true)
  })

  it('エディタの保存: 既にあるファイルへ上書きし（日本語・引用符を含む名前も）、無ければ作る', async () => {
    expect(await writeRemoteFile(target(), 'README.md', '# 見出し\n本文\n', run)).toEqual({ mtimeMs: 0 })
    expect(readFileSync(join(home, 'proj', 'README.md'), 'utf8')).toBe('# 見出し\n本文\n')
    await writeRemoteFile(target(), "we'ird dir/it's.md", 'x', run)
    expect(readFileSync(join(home, 'proj', "we'ird dir", "it's.md"), 'utf8')).toBe('x')
    await writeRemoteFile(target(), 'src/main.ts', '', run)
    expect(readFileSync(join(home, 'proj', 'src', 'main.ts'), 'utf8')).toBe('')
    // 一時ファイルは残さない
    expect(existsSync(join(home, 'proj', 'src')) && (await listRemoteDirectory(target(), 'src', run)).map((e) => e.name)).toEqual(['deep', 'main.ts'])
  })

  it('リンク先のファイルには、リンクを保ったまま中身だけ書く', async () => {
    await writeRemoteFile(target(), 'link-to-src/main.ts', 'via link\n', run)
    expect(readFileSync(join(home, 'proj', 'src', 'main.ts'), 'utf8')).toBe('via link\n')
  })

  it('フォルダ・外のパス・届いた大きさが違うときは書かない（元のファイルはそのまま）', async () => {
    await expect(writeRemoteFile(target(), 'src', 'x', run)).rejects.toThrow()
    await expect(writeRemoteFile(target(), '../out.txt', 'x', run)).rejects.toThrow()
    await expect(writeRemoteFile(target(), '', 'x', run)).rejects.toThrow()
    expect(existsSync(join(home, 'out.txt'))).toBe(false)
    const short: SshRunner = (host, command, options) => run(host, command, { ...options, input: Buffer.from('trunc') })
    await expect(writeRemoteFile(target(), 'README.md', 'a much longer body', short)).rejects.toThrow()
    expect(readFileSync(join(home, 'proj', 'README.md'), 'utf8')).toBe('# hi\n')
    expect((await listRemoteDirectory(target(), '', run)).some((e) => e.name.startsWith('.ferret-save'))).toBe(false)
  })

  it('a/b/c.ts のように途中のフォルダも作り、新しくできたいちばん上を返す（あるフォルダはそのまま使う）', async () => {
    expect(await createRemoteEntry(target(), '', 'src/x/y/z.ts', 'file', run)).toEqual({ path: 'src/x/y/z.ts', top: 'src/x' })
    expect(existsSync(join(home, 'proj', 'src', 'x', 'y', 'z.ts'))).toBe(true)
    expect(await createRemoteEntry(target(), 'src', 'x/w', 'directory', run)).toEqual({ path: 'src/x/w', top: 'src/x/w' })
  })

  it('既にあれば上書きせずに知らせる（ファイル・フォルダ・リンク切れ）', async () => {
    await expect(createRemoteEntry(target(), '', 'README.md', 'file', run)).rejects.toThrow(/README\.md/)
    expect(readFileSync(join(home, 'proj', 'README.md'), 'utf8')).toBe('# hi\n')
    await expect(createRemoteEntry(target(), '', 'src', 'directory', run)).rejects.toThrow(/src/)
    await expect(createRemoteEntry(target(), '', 'broken', 'file', run)).rejects.toThrow(/broken/)
    expect(existsSync(join(home, 'proj', 'missing'))).toBe(false)
  })

  it('途中にファイルがある・親が無い・使えない名前・.git の中は作らない', async () => {
    await expect(createRemoteEntry(target(), '', 'README.md/x.ts', 'file', run)).rejects.toThrow()
    await expect(createRemoteEntry(target(), 'nope', 'x.ts', 'file', run)).rejects.toThrow()
    for (const bad of ['', '..', 'a:b', 'a\nb', 'x/../y', '.git', 'sub/.git/hooks']) {
      await expect(createRemoteEntry(target(), '', bad, 'file', run)).rejects.toThrow()
    }
    await expect(createRemoteEntry(target(), '../out', 'x.ts', 'file', run)).rejects.toThrow()
    await expect(createRemoteEntry(target(), '.git', 'x.ts', 'file', run)).rejects.toThrow()
    expect(run.calls.length).toBe(2)
    expect(existsSync(join(home, 'out'))).toBe(false)
  })
})

describe('この PC の場所選び', () => {
  let home: string
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'ferret-browse-'))
    mkdirSync(join(home, 'src', 'app'), { recursive: true })
    mkdirSync(join(home, '.hidden'))
    mkdirSync(join(home, 'b10'))
    mkdirSync(join(home, 'b2'))
    writeFileSync(join(home, 'file.txt'), 'x')
    forgetBrowsedFolders()
  })
  afterEach(() => rmSync(home, { recursive: true, force: true }))

  it('ホームから始め、フォルダだけを自然順で出す（. で始まるものは出さない）', async () => {
    const listing = await browseLocalFolders(null, home)
    expect(listing.path).toBe(home)
    expect(listing.folders).toEqual(['b2', 'b10', 'src'])
    expect(listing.parent).not.toBeNull()
  })

  it('相対パスや無いフォルダ・ファイルは開かない', async () => {
    await expect(browseLocalFolders('src', home)).rejects.toThrow()
    await expect(browseLocalFolders(join(home, 'nope'), home)).rejects.toThrow()
    await expect(browseLocalFolders(join(home, 'file.txt'), home)).rejects.toThrow()
  })

  it('一覧に出した場所の下にだけフォルダを作れる', async () => {
    await expect(createLocalFolder(join(home, 'src'), 'x')).rejects.toThrow()
    await browseLocalFolders(join(home, 'src'), home)
    expect(isBrowsedFolder(join(home, 'src'))).toBe(true)
    const made = await createLocalFolder(join(home, 'src'), ' my-app ')
    expect(made).toBe(join(home, 'src', 'my-app'))
    expect(existsSync(made)).toBe(true)
    expect(isBrowsedFolder(made)).toBe(true)
  })

  it('既にある名前・使えない名前は断る', async () => {
    await browseLocalFolders(join(home, 'src'), home)
    await expect(createLocalFolder(join(home, 'src'), 'app')).rejects.toThrow(/app/)
    await expect(createLocalFolder(join(home, 'src'), '../escape')).rejects.toThrow()
    await expect(createLocalFolder(join(home, 'src'), '..')).rejects.toThrow()
    expect(existsSync(join(home, 'escape'))).toBe(false)
  })

  it('一覧に出していない場所は登録に使えない', () => {
    expect(isBrowsedFolder('/etc')).toBe(false)
  })
})

describe('新しいプロジェクトの画面の部品', () => {
  it('joinFolder は区切りを1つにする（Windows は \\）', () => {
    expect(joinFolder('/home/me', 'a', false)).toBe('/home/me/a')
    expect(joinFolder('/', 'a', false)).toBe('/a')
    expect(joinFolder('C:\\Users\\u', 'a', true)).toBe('C:\\Users\\u\\a')
    expect(joinFolder('C:\\', 'a', true)).toBe('C:\\a')
    expect(joinFolder('/srv', 'a', true)).toBe('/srv/a')
  })

  it('登録済みの SSH 接続を候補にする（同じ接続先とフォルダは1つ、SSH 以外は出さない）', () => {
    const p = (over: Partial<Project>): Project => ({ id: Math.random().toString(), name: 'n', folderPath: '/x', urls: [], ...over } as Project)
    const list = registeredSshConnections([
      p({ name: 'app', source: 'ssh', ssh: { host: 'dev', path: '~/app' } }),
      p({ name: 'app2', source: 'ssh', ssh: { host: 'dev', path: '~/app' } }),
      p({ name: 'local', source: 'local' }),
      p({ name: 'work', source: 'ssh', ssh: { host: 'gpu', path: '~/work' } })
    ])
    expect(list).toEqual([{ host: 'dev', path: '~/app', name: 'app' }, { host: 'gpu', path: '~/work', name: 'work' }])
  })
})

describe('SSH のファイルツリーのつなぎ込み（作成だけできる）', () => {
  it('main の fs:create は SSH ならリモートに作り、ツリーは作成だけの右クリックのメニューを出す', () => {
    const main = readFileSync('src/main/index.ts', 'utf8')
    expect(main).toContain("createRemoteEntry(remote, parentRel, name, kind)")
    expect(readFileSync('src/renderer/App.tsx', 'utf8')).toContain('createOnly={remoteWorkspace}')
    const explorer = readFileSync('src/renderer/components/FileExplorer.tsx', 'utf8')
    expect(explorer).toContain('createOnly ? ops.openMenu(e, entry) : e.preventDefault()')
    expect(explorer).toContain('createOnly={readOnly && createOnly}')
  })
})

describe('SSH のファイルの編集と保存のつなぎ込み', () => {
  it('fs:write と終了時の保存は SSH ならリモートに書き、開いたファイルは編集できる', () => {
    const main = readFileSync('src/main/index.ts', 'utf8')
    expect(main).toContain('writeRemoteFile(remote, relPath, content)')
    expect(main).toContain('writeRemoteFile(project.ssh, entry.path, entry.content)')
    const files = readFileSync('src/renderer/editor/useOpenFiles.ts', 'utf8')
    expect(files).not.toContain('info: undefined, readOnly: true')
  })
})

describe('SSH の Markdown のプレビュー', () => {
  it('読むだけのファイルもプレビュー（リッチ表示）で開き、編集はさせない', () => {
    const editor = readFileSync('src/renderer/editor/FileEditor.tsx', 'utf8')
    expect(editor).toContain('const rich = richable && !sourceFiles.has(file.id)')
    const rich = readFileSync('src/renderer/editor/richMarkdown/RichMarkdownEditor.tsx', 'utf8')
    expect(rich).toContain('editable: !readOnly')
    expect(rich).toContain('readOnly ? () => undefined : registerMarkdownDropTarget')
    expect(rich).toContain('readOnly={file.readOnly === true}')
  })
})
