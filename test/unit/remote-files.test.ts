import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync, existsSync } from 'node:fs'
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
  remoteListCommand,
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
  tmuxSessionName
} from '../../src/shared/sshCommand'
import {
  browseRemoteFolders,
  createRemoteFolder,
  killTmuxSession,
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
  const run: SshRunner = (host, command) => {
    calls.push({ host, command })
    return new Promise((resolve) => {
      execFile('sh', ['-c', command], { env: { PATH: process.env.PATH, HOME: home, SHELL: '/bin/sh' }, encoding: 'buffer', cwd: home },
        (error, stdout, stderr) => {
          const code = error ? (typeof (error as { code?: unknown }).code === 'number' ? (error as { code: number }).code : 255) : 0
          resolve({ code, stdout: Buffer.from(stdout), stderr: Buffer.from(stderr).toString('utf8') })
        })
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
    expect(line).toContain(`exec tmux new-session -A -s 'ferret-app-1-t'`)
    expect(line).toContain(`printf '%s\\r\\n' 'no tmux; it'\\''s fine'`)
    expect(line).toContain('exec "$SHELL" -l; fi')
    expect(() => remoteShellCommand('~/app', { session: 'bad name', notice: '' })).toThrow()
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
