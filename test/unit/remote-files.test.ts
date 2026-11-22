import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFile, execFileSync } from 'node:child_process'
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  isValidNewFolderName,
  isValidRemoteRelPath,
  parseRemoteBrowse,
  parseRemoteListing,
  parseRemoteReport,
  parseRemoteSearch,
  posixParent,
  remoteBrowseCommand,
  isCopyNameOf,
  remoteCopyCommand,
  remoteCopyInput,
  remoteCreateCommand,
  remoteCreated,
  remoteInputText,
  remoteListCommand,
  remoteMoveCommand,
  remoteMoveInput,
  remoteRenameCommand,
  remoteRenameInput,
  remoteTrashCommand,
  remoteTrashInput,
  trimTrailingSlashes,
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
  tmuxCapturePaneCommand,
  tmuxLeaveCopyModeCommand,
  tmuxSessionName
} from '../../src/shared/sshCommand'
import {
  browseRemoteFolders,
  copyRemoteEntries,
  createRemoteEntry,
  createRemoteFolder,
  writeRemoteFile,
  captureTmuxPane,
  killTmuxSession,
  leaveTmuxCopyMode,
  TMUX_LEAVE_COPY_MODE_TIMEOUT_MS,
  listRemoteDirectory,
  moveRemoteEntries,
  readRemoteFile,
  remotePathsForClipboard,
  renameRemoteEntry,
  searchRemoteNames,
  REMOTE_BOOTSTRAP,
  remoteStdin,
  SSH_SEND_FAILED_EXIT,
  sshExitCode,
  sshMultiplexOptions,
  SSH_TIMEOUT_EXIT,
  tmuxSessionExists,
  trashRemoteEntries,
  type SshRunner
} from '../../src/main/remoteFiles'
import { browseLocalFolders, createLocalFolder, forgetBrowsedFolders, isBrowsedFolder } from '../../src/main/folderBrowse'
import { joinFolder, registeredSshConnections } from '../../src/renderer/lib/newProjectPlaces'
import type { Project } from '../../src/shared/types'

const posix = process.platform !== 'win32'

/** ssh の代わりに、手元の sh でリモートの1行を動かす（HOME を一時フォルダにする）。組み立てた1行の引用が本当に効くかを見る */
function localShell(home: string, extraEnv: Record<string, string> = {}): SshRunner & { calls: Array<{ host: string; command: string }> } {
  const calls: Array<{ host: string; command: string }> = []
  const run: SshRunner = (host, command, options = {}) => {
    calls.push({ host, command })
    return new Promise((resolve) => {
      const child = execFile('sh', ['-c', command], { env: { PATH: process.env.PATH, HOME: home, SHELL: '/bin/sh', ...extraEnv }, encoding: 'buffer', cwd: home },
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

  it('コピーモードを抜ける1行: 入っていたか（1 / 0）を出して抜け、今の画面を出す（中のコマンドにも -t を書く）', () => {
    expect(tmuxLeaveCopyModeCommand('ferret-a-1-t')).toBe(
      `tmux display-message -p -t '=ferret-a-1-t:' '#{pane_in_mode}' ';' if-shell -F -t '=ferret-a-1-t:' '#{pane_in_mode}' 'send-keys -X -t =ferret-a-1-t: cancel' ';' capture-pane -p -t '=ferret-a-1-t:'`
    )
    expect(tmuxCapturePaneCommand('ferret-a-1-t')).toBe(`tmux capture-pane -p -t '=ferret-a-1-t:'`)
    for (const bad of ["a'b", 'a;b', 'a b', 'a:b', '$(x)', '']) {
      expect(() => tmuxLeaveCopyModeCommand(bad), bad).toThrow()
      expect(() => tmuxCapturePaneCommand(bad), bad).toThrow()
    }
  })

  it('leaveTmuxCopyMode: 1 行目が 1 なら抜けた・0 なら入っていない。残りは今の画面。それ以外（失敗・接続できない・分からない出力）は null。待つのは短く', async () => {
    const calls: Array<{ command: string; timeoutMs?: number }> = []
    const reply = (code: number, stdout: string): SshRunner => async (_h, command, options) => {
      calls.push({ command, timeoutMs: options?.timeoutMs })
      return { code, stdout: Buffer.from(stdout), stderr: '' }
    }
    expect(await leaveTmuxCopyMode('h', 'ferret-a-1-t', reply(0, '1\nline 1\n› Ask Codex to do anything\n\n'))).toEqual({ left: true, screen: 'line 1\n› Ask Codex to do anything' })
    expect(await leaveTmuxCopyMode('h', 'ferret-a-1-t', reply(0, '0\n$ \n'))).toEqual({ left: false, screen: '$ ' })
    expect(await leaveTmuxCopyMode('h', 'ferret-a-1-t', reply(0, '1'))).toEqual({ left: true, screen: '' })
    // 無いセッション（capture-pane が失敗して 1）、ツリーのモード（cancel が効かず 1）、分からない出力
    expect(await leaveTmuxCopyMode('h', 'ferret-a-1-t', reply(1, '\n'))).toBeNull()
    expect(await leaveTmuxCopyMode('h', 'ferret-a-1-t', reply(1, '1\n'))).toBeNull()
    expect(await leaveTmuxCopyMode('h', 'ferret-a-1-t', reply(0, 'sh: tmux: not found\n'))).toBeNull()
    expect(await leaveTmuxCopyMode('h', 'ferret-a-1-t', reply(255, ''))).toBeNull()
    expect(await leaveTmuxCopyMode('h', 'ferret-a-1-t', () => Promise.reject(new Error('x')))).toBeNull()
    // 名前がおかしければ送らずに null（投げない）
    expect(await leaveTmuxCopyMode('h', "a'; rm -rf ~", reply(0, '1\n'))).toBeNull()
    expect(calls).toHaveLength(7)
    expect(calls[0]).toEqual({ command: tmuxLeaveCopyModeCommand('ferret-a-1-t'), timeoutMs: TMUX_LEAVE_COPY_MODE_TIMEOUT_MS })
    expect(TMUX_LEAVE_COPY_MODE_TIMEOUT_MS).toBeLessThanOrEqual(5000)
  })

  it('captureTmuxPane: 今の画面（末尾の空行は落とす）。失敗・接続できない・名前がおかしいときは null', async () => {
    const commands: string[] = []
    const reply = (code: number, stdout: string): SshRunner => async (_h, command) => {
      commands.push(command)
      return { code, stdout: Buffer.from(stdout), stderr: '' }
    }
    expect(await captureTmuxPane('h', 'ferret-a-1-t', reply(0, 'a\nb\n\n'))).toBe('a\nb')
    expect(await captureTmuxPane('h', 'ferret-a-1-t', reply(1, ''))).toBeNull()
    expect(await captureTmuxPane('h', 'ferret-a-1-t', () => Promise.reject(new Error('x')))).toBeNull()
    expect(await captureTmuxPane('h', 'a b', reply(0, 'x'))).toBeNull()
    expect(commands).toEqual([tmuxCapturePaneCommand('ferret-a-1-t'), tmuxCapturePaneCommand('ferret-a-1-t')])
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

describe('リモートの削除・名前の変更・移動・コピーの1行（注入対策）', () => {
  const commands = () => [remoteTrashCommand(), remoteRenameCommand(), remoteMoveCommand(), remoteCopyCommand()]

  it('ログインシェルが読むコマンド行は値を含まない決まった1行（値はすべて標準入力で渡す）', () => {
    for (const command of commands()) {
      expect(command.startsWith("/bin/sh -c '")).toBe(true)
      expect(command.endsWith("' ferret")).toBe(true)
    }
    expect(commands()).toEqual(commands())
    expect(remoteRenameInput('~/proj', "a/it's $(x).ts", 'new; rm -rf ~', false)).toBe("~/proj\na/it's $(x).ts\nnew; rm -rf ~\n0\n")
    expect(remoteMoveInput('/srv', '', ['a', 'b c'])).toBe('/srv\n.\na\nb c\n')
    expect(remoteCopyInput('~', 'x/y', ['z'])).toBe('~\nx/y\nz\n')
    expect(remoteTrashInput('/srv', ['a\\b', "it's"])).toBe("/srv\na\\b\nit's\n")
  })

  it('fish でも引用が崩れない（コマンド行に \\\\ と、引用の中の \\\' が無い）', () => {
    for (const command of commands()) {
      expect(command).not.toContain('\\\\')
      // \' は POSIX の引用の外の '\'' の形だけ（fish でも引用の外の \' は ' 1文字）
      expect(command.split("'\\''").join('')).not.toContain("\\'")
    }
  })

  it('使えないパス・名前・移動先・値は組み立てない', () => {
    expect(() => remoteTrashInput('relative/path', ['a'])).toThrow()
    expect(() => remoteTrashInput('/a\nb', ['a'])).toThrow()
    expect(() => remoteTrashInput('/srv', [''])).toThrow()
    expect(() => remoteTrashInput('/srv', ['.git/config'])).toThrow()
    expect(() => remoteTrashInput('/srv', ['a\nb'])).toThrow()
    expect(() => remoteRenameInput('/srv', '', 'x', false)).toThrow()
    expect(() => remoteRenameInput('/srv', '../x', 'y', false)).toThrow()
    expect(() => remoteRenameInput('/srv', 'a', 'b/c', false)).toThrow()
    expect(() => remoteRenameInput('/srv', 'a', '.git', false)).toThrow()
    expect(() => remoteRenameInput('/srv', 'a', 'x\ry', false)).toThrow()
    expect(() => remoteMoveInput('/srv', '../out', ['a'])).toThrow()
    expect(() => remoteMoveInput('/srv', '.git/hooks', ['a'])).toThrow()
    expect(() => remoteCopyInput('/srv', '/etc', ['a'])).toThrow()
    expect(() => remoteInputText(['ok', 'x\0y'])).toThrow()
  })

  it('出力を読む（ログインシェルの設定が出した行など、知らない行は無視する）', () => {
    const report = parseRemoteReport('welcome from .bashrc\nok 1\nsame 2\nok 3 a copy 2.ts\nskip 5\nbad 4\n')
    expect([...report.ok]).toEqual([[1, ''], [3, 'a copy 2.ts']])
    expect([...report.same]).toEqual([2])
    expect([...report.skip]).toEqual([5])
    expect(report.bad).toBe(4)
    expect(parseRemoteReport('').bad).toBeNull()
  })

  it('コピーの名前は元の名前か copyName の形だけを受け付ける', () => {
    for (const [name, original, ok] of [
      ['a.ts', 'a.ts', true], ['a copy.ts', 'a.ts', true], ['a copy 2.ts', 'a.ts', true], ['a copy 10.ts', 'a.ts', true],
      ['src copy', 'src', true], ['src copy 3', 'src', true], ['.env copy', '.env', true], ['a.tar copy.gz', 'a.tar.gz', true], ['a.tar.gz copy', 'a.tar.gz', true],
      ['docs\\notes copy.txt', 'docs\\notes.txt', true], ['tab\tname copy', 'tab\tname', true],
      ['docs', 'docs\\notes.txt', false], ['a copy 1.ts', 'a.ts', false], ['a copy 02.ts', 'a.ts', false], ['b copy.ts', 'a.ts', false], ['x/a copy.ts', 'a.ts', false], ['', 'a.ts', false]
    ] as const) {
      expect(isCopyNameOf(name, original), `${name} ← ${original}`).toBe(ok)
    }
  })

  it('末尾の / は正規表現を使わずに落とす', () => {
    expect(trimTrailingSlashes('/srv/app///')).toBe('/srv/app')
    expect(trimTrailingSlashes('/')).toBe('/')
    expect(trimTrailingSlashes('~/')).toBe('~')
  })

  it('待ち時間で止めた ssh は 124（接続できなかった 255 とは分ける）', () => {
    expect(sshExitCode(null)).toBe(0)
    expect(sshExitCode({ code: 255 })).toBe(255)
    expect(sshExitCode({ code: 1 })).toBe(1)
    expect(sshExitCode({ code: null, killed: true, signal: 'SIGTERM' })).toBe(SSH_TIMEOUT_EXIT)
    expect(sshExitCode({ code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER', killed: true })).toBe(255)
    expect(sshExitCode({ code: 'ENOENT' })).toBe(255)
  })
})

describe.runIf(posix)('リモートのファイルツリーの削除・名前の変更・移動・コピー（手元の sh で結合）', () => {
  let home: string
  let proj: string
  let run: ReturnType<typeof localShell>
  const target = () => ({ host: 'dev-box', path: '~/proj' })
  const trash = () => join(home, '.local', 'share', 'Trash')
  /** .trashinfo の Path（URL の形）を元のパスに直す */
  const trashedFrom = (info: string) => decodeURIComponent(/^Path=(.*)$/m.exec(info)?.[1] ?? '')

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'ferret-remote-ops-'))
    proj = join(home, 'proj')
    mkdirSync(join(proj, 'src', 'deep'), { recursive: true })
    mkdirSync(join(proj, "we'ird dir"))
    mkdirSync(join(proj, '.git'))
    mkdirSync(join(home, 'outside'))
    writeFileSync(join(proj, 'README.md'), '# hi\n')
    writeFileSync(join(proj, 'src', 'main.ts'), 'export {}\n')
    writeFileSync(join(proj, 'src', 'deep', 'a.test.ts'), 'x\n')
    writeFileSync(join(proj, '日本語 メモ.md'), 'メモ\n')
    writeFileSync(join(proj, '.env'), 'A=1\n')
    writeFileSync(join(proj, '.git', 'config'), '[core]\n')
    writeFileSync(join(home, 'outside', 'secret.txt'), 'keep\n')
    symlinkSync(join(proj, 'src'), join(proj, 'link-to-src'))
    symlinkSync(join(home, 'outside'), join(proj, 'outside-link'))
    symlinkSync(join(proj, '.git'), join(proj, 'git-link'))
    run = localShell(home)
  })
  afterEach(() => rmSync(home, { recursive: true, force: true }))

  it('削除: ファイルとフォルダをリモートのゴミ箱へ移し、元のパスと日時を .trashinfo に書く', async () => {
    expect(await trashRemoteEntries(target(), ['README.md', 'src'], run)).toEqual(['README.md', 'src'])
    expect(existsSync(join(proj, 'README.md'))).toBe(false)
    expect(existsSync(join(proj, 'src'))).toBe(false)
    expect(readFileSync(join(trash(), 'files', 'README.md'), 'utf8')).toBe('# hi\n')
    expect(readFileSync(join(trash(), 'files', 'src', 'main.ts'), 'utf8')).toBe('export {}\n')
    const info = readFileSync(join(trash(), 'info', 'README.md.trashinfo'), 'utf8')
    expect(info).toMatch(/^\[Trash Info\]\nPath=\S+\nDeletionDate=\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\n$/)
    expect(trashedFrom(info)).toBe(join(realpathSync(proj), 'README.md'))
    expect(trashedFrom(readFileSync(join(trash(), 'info', 'src.trashinfo'), 'utf8'))).toBe(join(realpathSync(proj), 'src'))
  })

  it('削除: 日本語・空白・引用符を含む名前は、元のパスを %XX の形で書く（ゴミ箱から戻せる形）', async () => {
    expect(await trashRemoteEntries(target(), ['日本語 メモ.md', "we'ird dir"], run)).toEqual(['日本語 メモ.md', "we'ird dir"])
    const info = readFileSync(join(trash(), 'info', '日本語 メモ.md.trashinfo'), 'utf8')
    expect(info).toContain('%E6%97%A5%E6%9C%AC%E8%AA%9E%20%E3%83%A1%E3%83%A2.md')
    expect(trashedFrom(info)).toBe(join(realpathSync(proj), '日本語 メモ.md'))
    expect(trashedFrom(readFileSync(join(trash(), 'info', "we'ird dir.trashinfo"), 'utf8'))).toBe(join(realpathSync(proj), "we'ird dir"))
  })

  it('削除: ゴミ箱に同じ名前があれば「名前.2」にする（前に消したものを上書きしない）', async () => {
    await trashRemoteEntries(target(), ['README.md'], run)
    writeFileSync(join(proj, 'README.md'), 'second\n')
    await trashRemoteEntries(target(), ['README.md'], run)
    expect(readFileSync(join(trash(), 'files', 'README.md'), 'utf8')).toBe('# hi\n')
    expect(readFileSync(join(trash(), 'files', 'README.md.2'), 'utf8')).toBe('second\n')
    expect(existsSync(join(trash(), 'info', 'README.md.2.trashinfo'))).toBe(true)
  })

  it('削除: $XDG_DATA_HOME があれば、そこのゴミ箱へ移す', async () => {
    const data = join(home, 'xdg-data')
    await trashRemoteEntries(target(), ['.env'], localShell(home, { XDG_DATA_HOME: data }))
    expect(readFileSync(join(data, 'Trash', 'files', '.env'), 'utf8')).toBe('A=1\n')
    expect(existsSync(trash())).toBe(false)
  })

  it('削除: 選んだフォルダの下にあるものは、親と一緒に送る（重ねて送らない）。リンクはリンクだけを送る', async () => {
    expect(await trashRemoteEntries(target(), ['src/main.ts', 'src', 'src'], run)).toEqual(['src'])
    expect(await trashRemoteEntries(target(), ['outside-link'], run)).toEqual(['outside-link'])
    expect(readFileSync(join(home, 'outside', 'secret.txt'), 'utf8')).toBe('keep\n')
  })

  it('削除: 1つでも断るものがあれば何も移さない（無いもの・.git の中・外を指すリンクの先・プロジェクトそのもの）', async () => {
    await expect(trashRemoteEntries(target(), ['README.md', 'nope.md'], run)).rejects.toThrow()
    expect(existsSync(join(proj, 'README.md'))).toBe(true)
    await expect(trashRemoteEntries(target(), ['README.md', 'outside-link/secret.txt'], run)).rejects.toThrow()
    expect(existsSync(join(home, 'outside', 'secret.txt'))).toBe(true)
    expect(existsSync(join(proj, 'README.md'))).toBe(true)
    // リンクをたどった先が .git の中
    await expect(trashRemoteEntries(target(), ['git-link/config'], run)).rejects.toThrow()
    expect(existsSync(join(proj, '.git', 'config'))).toBe(true)
    const calls = run.calls.length
    for (const bad of [[''], ['.git'], ['.git/config'], ['../outside'], ['/etc/passwd'], [], 'README.md']) {
      await expect(trashRemoteEntries(target(), bad, run)).rejects.toThrow()
    }
    expect(run.calls.length).toBe(calls)
    expect(existsSync(trash()) ? readdirSync(join(trash(), 'files')) : []).toEqual([])
  })

  it('名前の変更: ファイル・フォルダ・引用符を含む名前。新しい相対パスを返す', async () => {
    expect(await renameRemoteEntry(target(), 'README.md', "READ ME's.md", run)).toBe("READ ME's.md")
    expect(readFileSync(join(proj, "READ ME's.md"), 'utf8')).toBe('# hi\n')
    expect(await renameRemoteEntry(target(), 'src/deep', 'さらに深く', run)).toBe('src/さらに深く')
    expect(existsSync(join(proj, 'src', 'さらに深く', 'a.test.ts'))).toBe(true)
    expect(await renameRemoteEntry(target(), "we'ird dir", 'plain', run)).toBe('plain')
  })

  it('名前の変更: 既にある名前には上書きしない。同じ名前なら何もしない。使えない名前・場所は断る', async () => {
    await expect(renameRemoteEntry(target(), 'README.md', '.env', run)).rejects.toThrow(/\.env/)
    expect(readFileSync(join(proj, '.env'), 'utf8')).toBe('A=1\n')
    expect(readFileSync(join(proj, 'README.md'), 'utf8')).toBe('# hi\n')
    await expect(renameRemoteEntry(target(), 'src', 'link-to-src', run)).rejects.toThrow(/link-to-src/)
    await expect(renameRemoteEntry(target(), 'nope.md', 'x.md', run)).rejects.toThrow()
    await expect(renameRemoteEntry(target(), 'outside-link/secret.txt', 'x.txt', run)).rejects.toThrow()
    expect(existsSync(join(home, 'outside', 'secret.txt'))).toBe(true)
    const calls = run.calls.length
    expect(await renameRemoteEntry(target(), 'README.md', 'README.md', run)).toBe('README.md')
    for (const [rel, name] of [['README.md', 'a/b'], ['README.md', '..'], ['README.md', '.git'], ['', 'x'], ['.git/config', 'x'], ['../x', 'y']]) {
      await expect(renameRemoteEntry(target(), rel, name, run)).rejects.toThrow()
    }
    expect(run.calls.length).toBe(calls)
  })

  it('移動: フォルダへ動かし、from → to の組を返す。もともとそのフォルダにあるものは動かさない', async () => {
    expect(await moveRemoteEntries(target(), ['README.md', "we'ird dir"], 'src', run)).toEqual([
      { from: 'README.md', to: 'src/README.md' },
      { from: "we'ird dir", to: "src/we'ird dir" }
    ])
    expect(readFileSync(join(proj, 'src', 'README.md'), 'utf8')).toBe('# hi\n')
    expect(statSync(join(proj, 'src', "we'ird dir")).isDirectory()).toBe(true)
    const calls = run.calls.length
    expect(await moveRemoteEntries(target(), ['src/main.ts'], 'src', run)).toEqual([{ from: 'src/main.ts', to: 'src/main.ts' }])
    expect(run.calls.length).toBe(calls)
    // 根へ戻す
    expect(await moveRemoteEntries(target(), ['src/README.md'], '', run)).toEqual([{ from: 'src/README.md', to: 'README.md' }])
    expect(existsSync(join(proj, 'README.md'))).toBe(true)
  })

  it('移動: 先に同じ名前がある・同じ名前を2つ・それ自身の中へ・外を指すリンク・ファイルへは、何も動かさない', async () => {
    writeFileSync(join(proj, 'src', 'README.md'), 'other\n')
    await expect(moveRemoteEntries(target(), ['.env', 'README.md'], 'src', run)).rejects.toThrow(/README\.md/)
    expect(existsSync(join(proj, '.env'))).toBe(true)
    expect(readFileSync(join(proj, 'src', 'README.md'), 'utf8')).toBe('other\n')
    await expect(moveRemoteEntries(target(), ['README.md', 'src/README.md'], "we'ird dir", run)).rejects.toThrow(/README\.md/)
    await expect(moveRemoteEntries(target(), ['src'], 'src/deep', run)).rejects.toThrow()
    // 文字の上では別でも、リンクをたどると自分の中
    await expect(moveRemoteEntries(target(), ['src'], 'link-to-src/deep', run)).rejects.toThrow()
    await expect(moveRemoteEntries(target(), ['README.md'], 'outside-link', run)).rejects.toThrow()
    await expect(moveRemoteEntries(target(), ['README.md'], 'git-link', run)).rejects.toThrow()
    await expect(moveRemoteEntries(target(), ['.env'], 'README.md', run)).rejects.toThrow()
    await expect(moveRemoteEntries(target(), ['README.md'], '.git', run)).rejects.toThrow()
    expect(readdirSync(join(home, 'outside'))).toEqual(['secret.txt'])
    expect(readdirSync(join(proj, '.git'))).toEqual(['config'])
    expect(existsSync(join(proj, 'README.md'))).toBe(true)
    expect(existsSync(join(proj, 'src', 'deep', 'src'))).toBe(false)
  })

  it('コピー: 別のフォルダへ同じ名前で、同じフォルダ（複製）なら「名前 copy」「名前 copy 2」にする', async () => {
    expect(await copyRemoteEntries(target(), ['README.md'], 'src', run)).toEqual([{ from: 'README.md', to: 'src/README.md' }])
    expect(readFileSync(join(proj, 'src', 'README.md'), 'utf8')).toBe('# hi\n')
    expect(readFileSync(join(proj, 'README.md'), 'utf8')).toBe('# hi\n')
    expect(await copyRemoteEntries(target(), ['README.md'], '', run)).toEqual([{ from: 'README.md', to: 'README copy.md' }])
    expect(await copyRemoteEntries(target(), ['README.md'], '', run)).toEqual([{ from: 'README.md', to: 'README copy 2.md' }])
    // 先頭のドットだけの名前・フォルダは拡張子を分けない
    expect(await copyRemoteEntries(target(), ['.env', 'src'], '', run)).toEqual([{ from: '.env', to: '.env copy' }, { from: 'src', to: 'src copy' }])
    expect(readFileSync(join(proj, 'src copy', 'deep', 'a.test.ts'), 'utf8')).toBe('x\n')
  })

  it('コピー: フォルダは中身ごと、リンクはリンクのまま写す。引用符・日本語の名前も', async () => {
    expect(await copyRemoteEntries(target(), ['src', 'link-to-src', '日本語 メモ.md'], "we'ird dir", run)).toEqual([
      { from: 'src', to: "we'ird dir/src" },
      { from: 'link-to-src', to: "we'ird dir/link-to-src" },
      { from: '日本語 メモ.md', to: "we'ird dir/日本語 メモ.md" }
    ])
    expect(readFileSync(join(proj, "we'ird dir", 'src', 'deep', 'a.test.ts'), 'utf8')).toBe('x\n')
    expect(lstatSync(join(proj, "we'ird dir", 'link-to-src')).isSymbolicLink()).toBe(true)
    expect(readlinkSync(join(proj, "we'ird dir", 'link-to-src'))).toBe(join(proj, 'src'))
  })

  it('コピー: それ自身の中へ・外を指すリンクの先・.git の中へは写さない', async () => {
    await expect(copyRemoteEntries(target(), ['src'], 'src/deep', run)).rejects.toThrow()
    await expect(copyRemoteEntries(target(), ['src'], 'link-to-src/deep', run)).rejects.toThrow()
    await expect(copyRemoteEntries(target(), ['outside-link/secret.txt'], '', run)).rejects.toThrow()
    await expect(copyRemoteEntries(target(), ['README.md'], 'outside-link', run)).rejects.toThrow()
    await expect(copyRemoteEntries(target(), ['README.md'], 'git-link', run)).rejects.toThrow()
    expect(readdirSync(join(home, 'outside'))).toEqual(['secret.txt'])
    expect(readdirSync(join(proj, '.git'))).toEqual(['config'])
    expect(readdirSync(join(proj, 'src', 'deep'))).toEqual(['a.test.ts'])
  })

  it('パスをコピー: 登録したフォルダの書き方のまま（ssh は使わない）', () => {
    expect(remotePathsForClipboard(target(), ['src/main.ts', ''], 'absolute')).toBe('~/proj/src/main.ts\n~/proj')
    expect(remotePathsForClipboard({ host: 'h', path: '/srv/app/' }, ['a b.ts'], 'absolute')).toBe('/srv/app/a b.ts')
    expect(remotePathsForClipboard({ host: 'h', path: '/' }, ['etc'], 'absolute')).toBe('/etc')
    expect(remotePathsForClipboard(target(), ['src/main.ts', ''], 'relative')).toBe('src/main.ts\n.')
    expect(() => remotePathsForClipboard(target(), ['../x'], 'absolute')).toThrow()
    expect(() => remotePathsForClipboard(target(), [], 'absolute')).toThrow()
    expect(run.calls).toEqual([])
  })

  it('\\ を含む名前もそのまま扱う（コピーの名前は printf で返すので、\\c・\\n などが読み替えられない）', async () => {
    writeFileSync(join(proj, 'docs\\notes.txt'), 'n\n')
    writeFileSync(join(proj, 'a\\cb.txt'), 'c\n')
    mkdirSync(join(proj, 'docs'))
    expect(await copyRemoteEntries(target(), ['docs\\notes.txt', 'a\\cb.txt'], '', run)).toEqual([
      { from: 'docs\\notes.txt', to: 'docs\\notes copy.txt' },
      { from: 'a\\cb.txt', to: 'a\\cb copy.txt' }
    ])
    expect(readFileSync(join(proj, 'docs\\notes copy.txt'), 'utf8')).toBe('n\n')
    // 元に戻すと同じ（作ったコピーだけをゴミ箱へ。docs/ は残る）
    expect(await trashRemoteEntries(target(), ['docs\\notes copy.txt'], run)).toEqual(['docs\\notes copy.txt'])
    expect(statSync(join(proj, 'docs')).isDirectory()).toBe(true)
    // \\ を含む名前から普通の名前へ（新しい名前に \\ は使えない。ローカルと同じ決まり）
    expect(await renameRemoteEntry(target(), 'a\\cb.txt', 'plain.txt', run)).toBe('plain.txt')
    expect(readFileSync(join(proj, 'plain.txt'), 'utf8')).toBe('c\n')
    await expect(renameRemoteEntry(target(), 'plain.txt', 'x\\y.txt', run)).rejects.toThrow()
  })

  it('タブなど制御文字を含む名前も複製できる（成功したコピーを失敗にしない）', async () => {
    writeFileSync(join(proj, 'tab\tname.md'), 't\n')
    expect(await copyRemoteEntries(target(), ['tab\tname.md'], '', run)).toEqual([{ from: 'tab\tname.md', to: 'tab\tname copy.md' }])
    expect(readFileSync(join(proj, 'tab\tname copy.md'), 'utf8')).toBe('t\n')
  })

  it('CDPATH があっても、入れ子のパスを扱える', async () => {
    const cd = localShell(home, { CDPATH: '.' })
    expect(await moveRemoteEntries(target(), ['src/main.ts'], "we'ird dir", cd)).toEqual([{ from: 'src/main.ts', to: "we'ird dir/main.ts" }])
    expect(await moveRemoteEntries(target(), ['README.md'], 'src/deep', cd)).toEqual([{ from: 'README.md', to: 'src/deep/README.md' }])
    expect(await trashRemoteEntries(target(), ['src/deep/a.test.ts'], cd)).toEqual(['src/deep/a.test.ts'])
    expect(await copyRemoteEntries(target(), ['src/deep'], '', cd)).toEqual([{ from: 'src/deep', to: 'deep' }])
  })

  it('大文字小文字だけの名前の変更（ファイル・フォルダ。大文字小文字を区別しない FS でも一時的な名前を経由して変える）', async () => {
    expect(await renameRemoteEntry(target(), 'README.md', 'readme.md', run)).toBe('readme.md')
    expect(readdirSync(proj)).toContain('readme.md')
    expect(readdirSync(proj)).not.toContain('README.md')
    expect(await renameRemoteEntry(target(), 'src', 'Src', run)).toBe('Src')
    expect(readdirSync(proj)).toContain('Src')
    expect(readFileSync(join(proj, 'Src', 'main.ts'), 'utf8')).toBe('export {}\n')
    expect(readdirSync(proj).some((n) => n.startsWith('.ferret-rename'))).toBe(false)
  })

  it.runIf(process.platform === 'linux')('大文字小文字だけの名前の変更でも、別の項目（同じものを指すリンク）には上書きしない', async () => {
    writeFileSync(join(proj, 'foo'), 'data\n')
    symlinkSync('foo', join(proj, 'Foo'))
    await expect(renameRemoteEntry(target(), 'foo', 'Foo', run)).rejects.toThrow(/Foo/)
    await expect(renameRemoteEntry(target(), 'Foo', 'foo', run)).rejects.toThrow(/foo/)
    expect(readFileSync(join(proj, 'foo'), 'utf8')).toBe('data\n')
    expect(lstatSync(join(proj, 'Foo')).isSymbolicLink()).toBe(true)
  })

  it('入れ子の .git（リンクをたどった先）の中は、削除も移動先にもしない', async () => {
    mkdirSync(join(proj, 'sub', '.git'), { recursive: true })
    writeFileSync(join(proj, 'sub', '.git', 'config'), '[core]\n')
    symlinkSync(join(proj, 'sub', '.git'), join(proj, 'nested-git'))
    await expect(trashRemoteEntries(target(), ['nested-git/config'], run)).rejects.toThrow()
    await expect(moveRemoteEntries(target(), ['README.md'], 'nested-git', run)).rejects.toThrow()
    await expect(copyRemoteEntries(target(), ['README.md'], 'nested-git', run)).rejects.toThrow()
    expect(readdirSync(join(proj, 'sub', '.git'))).toEqual(['config'])
    expect(existsSync(join(proj, 'README.md'))).toBe(true)
  })

  it.runIf(typeof process.getuid === 'function' && process.getuid() !== 0)('書けないフォルダの中は、権限が無いと伝えて何も変えない', async () => {
    mkdirSync(join(proj, 'locked'))
    writeFileSync(join(proj, 'locked', 'file.txt'), 'x\n')
    chmodSync(join(proj, 'locked'), 0o555)
    try {
      await expect(trashRemoteEntries(target(), ['README.md', 'locked/file.txt'], run)).rejects.toThrow(/file\.txt/)
      await expect(moveRemoteEntries(target(), ['README.md'], 'locked', run)).rejects.toThrow()
      await expect(moveRemoteEntries(target(), ['.env', 'locked/file.txt'], 'src', run)).rejects.toThrow(/file\.txt/)
      expect(existsSync(join(proj, 'README.md'))).toBe(true)
      expect(existsSync(join(proj, '.env'))).toBe(true)
      expect(existsSync(join(proj, 'locked', 'file.txt'))).toBe(true)
    } finally {
      chmodSync(join(proj, 'locked'), 0o755)
    }
  })

  it.runIf(process.platform === 'linux' && existsSync('/dev/shm'))('ゴミ箱と別のディスクにあるものは移さない（ホームへのコピーにしない）', async () => {
    const shm = mkdtempSync('/dev/shm/ferret-xdg-')
    try {
      await expect(trashRemoteEntries(target(), ['README.md'], localShell(home, { XDG_DATA_HOME: shm }))).rejects.toThrow(/README\.md/)
      expect(existsSync(join(proj, 'README.md'))).toBe(true)
      expect(readdirSync(join(shm, 'Trash', 'files'))).toEqual([])
    } finally {
      rmSync(shm, { recursive: true, force: true })
    }
  })

  it('長い名前は ferret-trash.N の名前で入れ、元のパスは .trashinfo に残す。info が切れたリンクなら次の番号へ', async () => {
    const long = `${'a'.repeat(220)}.txt`
    writeFileSync(join(proj, long), 'long\n')
    expect(await trashRemoteEntries(target(), [long], run)).toEqual([long])
    expect(readFileSync(join(trash(), 'files', 'ferret-trash'), 'utf8')).toBe('long\n')
    expect(trashedFrom(readFileSync(join(trash(), 'info', 'ferret-trash.trashinfo'), 'utf8'))).toBe(join(realpathSync(proj), long))
    symlinkSync(join(home, 'missing'), join(trash(), 'info', 'README.md.trashinfo'))
    expect(await trashRemoteEntries(target(), ['README.md'], run)).toEqual(['README.md'])
    expect(readFileSync(join(trash(), 'files', 'README.md.2'), 'utf8')).toBe('# hi\n')
  })

  it('パイプなど普通のファイルでないものは写さない（ローカルと同じ）', async () => {
    execFileSync('mkfifo', [join(proj, 'pipe')])
    expect(await copyRemoteEntries(target(), ['pipe', 'README.md'], 'src', run)).toEqual([{ from: 'README.md', to: 'src/README.md' }])
    expect(existsSync(join(proj, 'src', 'pipe'))).toBe(false)
  })
})

describe('ssh に渡す1行（ログインシェルが読む）', () => {
  it('値を含まない決まった1行で、\\ も改行も無い（fish・tcsh でも引用が崩れない）', () => {
    // \\ と改行に加え、tcsh の履歴展開の ! も使わない
    expect(REMOTE_BOOTSTRAP).not.toMatch(/[!\\\n]/)
    expect(REMOTE_BOOTSTRAP.startsWith("exec /bin/sh -c '")).toBe(true)
    expect(remoteStdin('echo hi', Buffer.from('rest')).toString('utf8')).toBe('7\necho hirest')
    expect(remoteStdin('日本').toString('utf8')).toBe('6\n日本')
  })

  /** ssh の先と同じく、ログインシェルで `-c <決まった1行>` を動かし、標準入力に remoteStdin を渡す */
  function viaLoginShell(home: string, login: string): SshRunner {
    return (_host, command, options = {}) => new Promise((resolve) => {
      const child = execFile(login, ['-c', REMOTE_BOOTSTRAP], { env: { PATH: process.env.PATH, HOME: home, SHELL: login }, encoding: 'buffer', cwd: home },
        (error, stdout, stderr) => resolve({ code: sshExitCode(error), stdout: Buffer.from(stdout), stderr: Buffer.from(stderr).toString('utf8') }))
      child.stdin?.on('error', () => undefined)
      child.stdin?.end(remoteStdin(command, options.input))
    })
  }
  // Windows では動かさない（each の表は空にしない）
  const shells = posix ? ['/bin/sh', '/bin/bash', '/bin/zsh', '/usr/bin/zsh'].filter((s) => existsSync(s)) : ['/bin/sh']

  it.runIf(posix)('標準入力が途中で切れたら、短くなった1行を動かさない', async () => {
    const home = mkdtempSync(join(tmpdir(), 'ferret-boot-'))
    try {
      const full = remoteStdin(`touch ${join(home, 'done-file')}`)
      const cut = full.subarray(0, full.length - 5)
      const code = await new Promise<number>((resolve) => {
        const child = execFile('/bin/sh', ['-c', REMOTE_BOOTSTRAP], { env: { PATH: process.env.PATH, HOME: home } }, (error) => resolve(sshExitCode(error)))
        child.stdin?.end(cut)
      })
      expect(code).toBe(SSH_SEND_FAILED_EXIT)
      expect(readdirSync(home)).toEqual([])
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it.runIf(posix).each(shells)('%s: 一覧・読み込み・保存・作成・名前の変更・コピー・削除が、危ない名前でも崩れない', async (login) => {
    const home = mkdtempSync(join(tmpdir(), 'ferret-boot-'))
    try {
      const proj = join(home, 'proj')
      const evil = "a\\';touch pwned;\\'b"
      mkdirSync(join(proj, "we'ird dir"), { recursive: true })
      writeFileSync(join(proj, evil), 'evil\n')
      writeFileSync(join(proj, 'README.md'), '# hi\n')
      const run = viaLoginShell(home, login)
      const target = { host: 'dev-box', path: '~/proj' }
      expect((await listRemoteDirectory(target, '', run)).map((e) => e.name).sort()).toEqual(['README.md', evil, "we'ird dir"].sort())
      expect(await readRemoteFile(target, evil, run)).toMatchObject({ kind: 'text', content: 'evil\n' })
      await writeRemoteFile(target, "we'ird dir/メモ.md", '本文\n', run)
      expect(readFileSync(join(proj, "we'ird dir", 'メモ.md'), 'utf8')).toBe('本文\n')
      expect(await createRemoteEntry(target, "we'ird dir", 'sub', 'directory', run)).toMatchObject({ path: "we'ird dir/sub" })
      expect(await copyRemoteEntries(target, [evil], "we'ird dir", run)).toEqual([{ from: evil, to: `we'ird dir/${evil}` }])
      expect(await renameRemoteEntry(target, evil, 'safe.txt', run)).toBe('safe.txt')
      expect(await trashRemoteEntries(target, ['safe.txt', `we'ird dir/${evil}`], run)).toEqual(['safe.txt', `we'ird dir/${evil}`])
      expect(await moveRemoteEntries(target, ['README.md'], "we'ird dir", run)).toEqual([{ from: 'README.md', to: "we'ird dir/README.md" }])
      // 名前の中の ; touch pwned は動かない
      expect(existsSync(join(home, 'pwned'))).toBe(false)
      expect(existsSync(join(proj, 'pwned'))).toBe(false)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})

describe('リモートのファイルの操作の失敗の伝え方', () => {
  const target = { host: 'dev-box', path: '~/proj' }
  const fail = (code: number, stdout = ''): SshRunner => async () => ({ code, stdout: Buffer.from(stdout), stderr: 'mv: cannot move /home/someone/x: Permission denied\n' })

  it('接続できなければ接続先の名前で、ゴミ箱へ移せなければどの項目かを伝える（OS の文言・絶対パスは出さない）', async () => {
    await expect(trashRemoteEntries(target, ['a.md'], fail(255))).rejects.toThrow(/dev-box/)
    await expect(trashRemoteEntries(target, ['a.md', 'dir/b.md'], fail(27, 'ok 1\nbad 2\n'))).rejects.toThrow(/b\.md/)
    await expect(trashRemoteEntries(target, ['a.md'], fail(1, 'bad 1\n'))).rejects.toThrow(/a\.md/)
    await expect(trashRemoteEntries(target, ['a.md'], fail(1, 'bad 1\n'))).rejects.not.toThrow(/someone/)
    await expect(moveRemoteEntries(target, ['a.md'], 'dir', fail(1, 'bad 1\n'))).rejects.not.toThrow(/someone/)
  })

  it('待ち時間を過ぎたら「接続できない」ではなく、途中まで進んだかもしれないと伝える。tmux のセッションは分からない（null）', async () => {
    await expect(trashRemoteEntries(target, ['a.md'], fail(SSH_TIMEOUT_EXIT))).rejects.toThrow(/時間内|in time/)
    await expect(copyRemoteEntries(target, ['a.md'], '', fail(SSH_TIMEOUT_EXIT))).rejects.not.toThrow(/dev-box/)
    expect(await tmuxSessionExists('dev-box', 'ferret-a-1-t', fail(SSH_TIMEOUT_EXIT))).toBeNull()
    // 1行を送り切れなかった（125）も、操作の失敗（無い）と分けて null
    expect(await tmuxSessionExists('dev-box', 'ferret-a-1-t', fail(SSH_SEND_FAILED_EXIT))).toBeNull()
    await expect(listRemoteDirectory(target, '', fail(SSH_SEND_FAILED_EXIT))).rejects.toThrow(/送り切れ|in full/)
    await expect(searchRemoteNames(target, 'x', fail(SSH_SEND_FAILED_EXIT))).rejects.toThrow()
  })

  it('途中で失敗したら、どの項目かを伝える。権限・別のディスクも項目の名前で', async () => {
    await expect(moveRemoteEntries(target, ['a.md', 'dir/b.md'], 'x', fail(1, 'ok 1\nbad 2\n'))).rejects.toThrow(/b\.md/)
    await expect(trashRemoteEntries(target, ['a.md', 'big'], fail(30, 'bad 2\n'))).rejects.toThrow(/big/)
    await expect(trashRemoteEntries(target, ['a.md'], fail(31, 'bad 1\n'))).rejects.toThrow(/a\.md/)
  })

  it('コピーの出力の名前が copyName の形でなければ、写したものとして返さない（元に戻すで関係ないものを消さない）', async () => {
    const odd: SshRunner = async () => ({ code: 0, stdout: Buffer.from('ok 1 docs\nok 2 b copy.md\n'), stderr: '' })
    expect(await copyRemoteEntries(target, ['docs\\notes.txt', 'b.md'], '', odd)).toEqual([{ from: 'b.md', to: 'b copy.md' }])
  })

  it('コピーの上限は、ローカルと同じ文言で伝える', async () => {
    await expect(copyRemoteEntries(target, ['big'], '', fail(28, 'bad 1\n'))).rejects.toThrow(/10,000/)
    await expect(copyRemoteEntries(target, ['big'], '', fail(29, 'bad 1\n'))).rejects.toThrow(/1/)
  })
})

describe('SSH のツリーからターミナルへ落とす', () => {
  it('登録したリモートのフォルダからのパスにし、~/ は引用の外に出す（引用すると ~ が展開されない）', async () => {
    const { remoteTreePathsText } = await import('../../src/shared/externalDrop')
    expect(remoteTreePathsText(['src/a.ts', ''], '~/proj')).toBe('~/proj/src/a.ts ~/proj ')
    expect(remoteTreePathsText(["it's.md"], '~/my proj')).toBe(`~/'my proj/it'\\''s.md' `)
    expect(remoteTreePathsText(['a b.ts'], '/home/user/p/')).toBe("'/home/user/p/a b.ts' ")
    expect(remoteTreePathsText(['x'], '/')).toBe('/x ')
    expect(remoteTreePathsText([''], '~')).toBe('~ ')
    expect(remoteTreePathsText([], '~/p')).toBe('')
    expect(remoteTreePathsText(['a\nb'], '~/p')).toBe('')
  })

  it('TerminalPane はツリーのドラッグを、SSH ならリモートのパスで入れる', () => {
    const pane = readFileSync('src/renderer/components/TerminalPane.tsx', 'utf8')
    expect(pane).toContain('remoteTreePathsText(tree, sshProject.ssh.path)')
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

describe('SSH のファイルツリーのつなぎ込み（作成・名前の変更・削除・移動・コピー）', () => {
  it('main は SSH ならリモートで作る・名前を変える・ゴミ箱へ移す・動かす・コピーする。この PC からの取り込みだけを断る', () => {
    const main = readFileSync('src/main/index.ts', 'utf8')
    expect(main).toContain('createRemoteEntry(remote, parentRel, name, kind)')
    expect(main).toContain('renameRemoteEntry(remote, relPath, newName)')
    expect(main).toContain('trashRemoteEntries(remote, relPaths)')
    expect(main).toContain('moveRemoteEntries(remote, relPaths, destRel)')
    expect(main).toContain('copyRemoteEntries(remote, relPaths, destRel)')
    expect(main).toContain('remotePathsForClipboard(remote, relPaths, which)')
    expect(main).toContain("'fs:import': (absolutePaths, destRel) => { assertLocalImport();")
    expect(main).not.toContain('assertLocalFiles')
    expect(main.match(/assertLocalImport\(\)/g)).toHaveLength(3)
  })

  it('ツリーは SSH でもローカルと同じ操作を出し、この PC のファイルを扱うものだけを出さない', () => {
    expect(readFileSync('src/renderer/App.tsx', 'utf8')).toContain('remote={remoteWorkspace}')
    const explorer = readFileSync('src/renderer/components/FileExplorer.tsx', 'utf8')
    // 「読むだけ・作成だけ」の作りは残っていない（名前の欄の <input readOnly> は打っている間の印なので別）
    expect(explorer).not.toContain('createOnly')
    expect(explorer).not.toMatch(/readOnly = false|readOnly\?: boolean/)
    // 外部のアプリ・Finder で表示・ターミナルで開く・⌘P は SSH では出さない
    expect(explorer).toContain("{!remote && <MenuItem icon={<ExternalLink")
    expect(explorer).toMatch(/\{!remote && <>\s*\{sep\}\s*<MenuItem icon=\{<FolderOpen/)
    expect(explorer).toContain('{!remote && <IconButton size="sm" label={t(\'fileExplorer.quickOpen\'')
    expect(explorer).toContain("if (!remote && code === 'KeyR'")
    // 外から落としたもの・OS のクリップボードは取り込まずに知らせる。削除の確認と元に戻すはリモートのゴミ箱の文言
    expect(explorer).toContain("setActionError(t('remoteFiles.errors.noImport'))")
    expect(explorer).toContain("setNotice(t('fileExplorer.pasteNothingRemote'))")
    expect(explorer).toContain("remote ? t('fileExplorer.deleteBodyRemote')")
    expect(explorer).toContain("remote ? t('fileExplorer.undoTrashRemote')")
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
