import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFile, execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FsEntry } from '../../src/shared/files'
import {
  mergeListings,
  parseRemoteListingMany,
  parseRemoteReadRange,
  remoteListManyCommand,
  remoteReadRangeCommand,
  remoteTarCommand,
  remoteUntarCommand,
  MAX_REMOTE_LIST_MANY
} from '../../src/shared/remoteFiles'
import { inspectRemoteFile, listRemoteDirectories, remoteMediaResponse, REMOTE_MEDIA_CHUNK_BYTES, type SshRunner } from '../../src/main/remoteFiles'

/**
 * SSH のプロジェクトのツリーの読み直し（まとめて読む）・画像などのプレビュー（範囲を読む）・ダウンロード／アップロード（tar）の1行。
 * ssh の代わりに手元の sh で動かし、引用と出力の読み取りが本当に効くかを見る
 */

const posix = process.platform !== 'win32'

function localShell(home: string): SshRunner {
  return (_host, command, options = {}) => new Promise((resolve) => {
    const child = execFile('sh', ['-c', command], { env: { PATH: process.env.PATH, HOME: home }, encoding: 'buffer', cwd: home, maxBuffer: 64 * 1024 * 1024 },
      (error, stdout, stderr) => {
        const code = error ? (typeof (error as { code?: unknown }).code === 'number' ? (error as { code: number }).code : 255) : 0
        resolve({ code, stdout: Buffer.from(stdout), stderr: Buffer.from(stderr).toString('utf8') })
      })
    child.stdin?.on('error', () => undefined)
    child.stdin?.end(options.input)
  })
}

const target = { host: 'dev-box', path: '~/proj' }
let home: string
let proj: string

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'ferret-remote-sync-'))
  proj = join(home, 'proj')
  mkdirSync(join(proj, 'src', 'deep'), { recursive: true })
  mkdirSync(join(proj, "it's here"), { recursive: true })
  writeFileSync(join(proj, 'README.md'), '# hi\n')
  writeFileSync(join(proj, 'src', 'a.ts'), 'a')
  writeFileSync(join(proj, "it's here", '日本語.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]))
})
afterEach(() => rmSync(home, { recursive: true, force: true }))

const names = (entries: FsEntry[] | null | undefined) => entries?.map((e) => (e.kind === 'directory' ? `${e.name}/` : e.name))

describe.runIf(posix)('まとめて読み直す（fs:listMany）', () => {
  it('開いているフォルダの中身を1回で読み、フォルダが先・名前順で返す', async () => {
    const out = await listRemoteDirectories(target, ['', 'src', "it's here"], localShell(home))
    expect(names(out[''])).toEqual(["it's here/", 'src/', 'README.md'])
    expect(names(out.src)).toEqual(['deep/', 'a.ts'])
    expect(out.src![1]!.path).toBe('src/a.ts')
    expect(names(out["it's here"])).toEqual(['日本語.png'])
  })

  it('リモートで作ったファイルが次の読み直しで出る（ターミナル・Agent が作ったもの）', async () => {
    const run = localShell(home)
    expect(names((await listRemoteDirectories(target, ['src'], run)).src)).toEqual(['deep/', 'a.ts'])
    writeFileSync(join(proj, 'src', 'new.ts'), '')
    expect(names((await listRemoteDirectories(target, ['src'], run)).src)).toEqual(['deep/', 'a.ts', 'new.ts'])
  })

  it('消えたフォルダは null、空のフォルダは空の一覧', async () => {
    const out = await listRemoteDirectories(target, ['gone', 'src/deep'], localShell(home))
    expect(out.gone).toBeNull()
    expect(out['src/deep']).toEqual([])
  })

  it('外へ出るパス・形のおかしいものは読まない（ssh も呼ばない）', async () => {
    let called = false
    const spy: SshRunner = async () => { called = true; return { code: 0, stdout: Buffer.alloc(0), stderr: '' } }
    expect(await listRemoteDirectories(target, ['../x', '/etc', 3, 'a\nb'], spy)).toEqual({})
    expect(called).toBe(false)
  })

  it('つながらないときは投げる', async () => {
    const down: SshRunner = async () => ({ code: 255, stdout: Buffer.alloc(0), stderr: 'Connection refused' })
    await expect(listRemoteDirectories(target, [''], down)).rejects.toThrow(/Connection refused/)
  })

  it('一度に読むのは上限まで', () => {
    const rels = Array.from({ length: MAX_REMOTE_LIST_MANY + 10 }, (_, i) => `d${i}`)
    expect(remoteListManyCommand('~/p', rels).split('//ferret-dir ').length - 1).toBe(MAX_REMOTE_LIST_MANY)
  })

  it('引用を壊す名前はそのまま1つの引数になる', () => {
    expect(remoteListManyCommand('~/p', ["a'; rm -rf ~; '"])).toContain(`'a'\\''; rm -rf ~; '\\'''`)
    expect(() => remoteListManyCommand('~/p', ['../x'])).toThrow()
  })

  it('出力の読み取り: 区切りの無い出力・知らない番号は捨てる', () => {
    expect(parseRemoteListingMany('x\ny/\n', ['']).size).toBe(0)
    const out = parseRemoteListingMany('//ferret-dir 9\na\n//ferret-dir 0\nb/\nc\n', [''])
    expect(names(out.get(''))).toEqual(['b/', 'c'])
  })
})

describe('読み直した結果をツリーに重ねる（mergeListings）', () => {
  const e = (path: string, kind: FsEntry['kind'] = 'file'): FsEntry => ({ name: path.split('/').pop()!, path, kind })
  const current = new Map<string, FsEntry[]>([['', [e('src', 'directory'), e('a.md')]], ['src', [e('src/x.ts')]]])

  it('変わっていなければ null（描き直さない）', () => {
    expect(mergeListings(current, { '': [e('src', 'directory'), e('a.md')], src: [e('src/x.ts')] })).toBeNull()
  })

  it('増えた・減ったフォルダだけ差し替える', () => {
    const next = mergeListings(current, { src: [e('src/x.ts'), e('src/y.ts')] })!
    expect(next.get('src')!.map((x) => x.path)).toEqual(['src/x.ts', 'src/y.ts'])
    expect(next.get('')).toBe(current.get(''))
  })

  it('種類が変わったら差し替える', () => {
    expect(mergeListings(current, { src: [e('src/x.ts', 'directory')] })).not.toBeNull()
  })

  it('消えたフォルダは外すが、根は外さない', () => {
    const next = mergeListings(current, { src: null, '': null })!
    expect(next.has('src')).toBe(false)
    expect(next.has('')).toBe(true)
  })

  it('読んでいないフォルダの結果は足さない', () => {
    expect(mergeListings(current, { other: [e('other/z')] })).toBeNull()
  })
})

describe.runIf(posix)('範囲を読む（画像・PDF・動画のプレビュー）', () => {
  it('大きさと中身を返す（日本語・引用符の入ったパスも）', async () => {
    const r = await localShell(home)('h', remoteReadRangeCommand('~/proj', "it's here/日本語.png", 0, 100))
    expect(r.code).toBe(0)
    const parsed = parseRemoteReadRange(r.stdout)!
    expect(parsed.size).toBe(8)
    expect([...parsed.data]).toEqual([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3])
  })

  it('途中から決まったバイト数だけ', async () => {
    const r = await localShell(home)('h', remoteReadRangeCommand('~/proj', "it's here/日本語.png", 2, 3))
    expect([...parseRemoteReadRange(r.stdout)!.data]).toEqual([0x4e, 0x47, 0])
  })

  it('フォルダ・無いファイルは終了コード 3', async () => {
    expect((await localShell(home)('h', remoteReadRangeCommand('~/proj', 'src', 0, 1))).code).toBe(3)
    expect((await localShell(home)('h', remoteReadRangeCommand('~/proj', 'nope.png', 0, 1))).code).toBe(3)
  })

  it('外へ出るパス・根は組み立てない', () => {
    expect(() => remoteReadRangeCommand('~/p', '../x.png', 0, 1)).toThrow()
    expect(() => remoteReadRangeCommand('~/p', '', 0, 1)).toThrow()
  })

  it('形の違う出力は null', () => {
    expect(parseRemoteReadRange(Buffer.from('abc'))).toBeNull()
    expect(parseRemoteReadRange(Buffer.from('-1\nx'))).toBeNull()
    expect(parseRemoteReadRange(Buffer.from('  12\n'))).toEqual({ size: 12, data: Buffer.alloc(0) })
  })

  it('fs:inspect: 大きさと先頭のバイト', async () => {
    const info = await inspectRemoteFile(target, "it's here/日本語.png", localShell(home))
    expect(info.size).toBe(8)
    expect(info.head.length).toBe(8)
    await expect(inspectRemoteFile(target, 'src', localShell(home))).rejects.toThrow()
    await expect(inspectRemoteFile(target, '../x', localShell(home))).rejects.toThrow()
  })
})

describe.runIf(posix)('ade-media://project/ を SSH のプロジェクトで返す', () => {
  const url = (rel: string) => `ade-media://project/${rel.split('/').map(encodeURIComponent).join('/')}`

  it('画像は全体を 200 で返す', async () => {
    const res = await remoteMediaResponse(target, url("it's here/日本語.png"), null, localShell(home))
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('image/png')
    expect(new Uint8Array(await res.arrayBuffer()).length).toBe(8)
  })

  it('SVG は CSP を付ける', async () => {
    writeFileSync(join(proj, 'a.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>')
    const res = await remoteMediaResponse(target, url('a.svg'), null, localShell(home))
    expect(res.status).toBe(200)
    expect(res.headers.get('content-security-policy')).toContain('sandbox')
  })

  it('動画は Range に 206 で答え、1回は上限まで', async () => {
    writeFileSync(join(proj, 'v.mp4'), Buffer.alloc(100, 7))
    const res = await remoteMediaResponse(target, url('v.mp4'), 'bytes=10-19', localShell(home))
    expect(res.status).toBe(206)
    expect(res.headers.get('content-range')).toBe('bytes 10-19/100')
    expect((await res.arrayBuffer()).byteLength).toBe(10)
    const open = await remoteMediaResponse(target, url('v.mp4'), 'bytes=90-', localShell(home))
    expect(open.headers.get('content-range')).toBe('bytes 90-99/100')
    const tail = await remoteMediaResponse(target, url('v.mp4'), 'bytes=-5', localShell(home))
    expect(tail.headers.get('content-range')).toBe('bytes 95-99/100')
    expect(REMOTE_MEDIA_CHUNK_BYTES).toBeLessThanOrEqual(16 * 1024 * 1024)
  })

  it('範囲の外は 416', async () => {
    writeFileSync(join(proj, 'v.mp4'), Buffer.alloc(10))
    expect((await remoteMediaResponse(target, url('v.mp4'), 'bytes=50-', localShell(home))).status).toBe(416)
  })

  it('無いファイル・メディアでない種類・外へ出る URL は 404', async () => {
    expect((await remoteMediaResponse(target, url('nope.png'), null, localShell(home))).status).toBe(404)
    expect((await remoteMediaResponse(target, url('README.md'), null, localShell(home))).status).toBe(404)
    expect((await remoteMediaResponse(target, 'ade-media://project/%2E%2E/x.png', null, localShell(home))).status).toBe(404)
  })

  it('つながらないときは 404（例外にしない）', async () => {
    const down: SshRunner = async () => ({ code: 255, stdout: Buffer.alloc(0), stderr: '' })
    expect((await remoteMediaResponse(target, url('a.png'), null, down)).status).toBe(404)
  })
})

describe.runIf(posix)('ダウンロード・アップロードの tar', () => {
  it('選んだものを tar にし、手元で広げると同じ中身になる', () => {
    const out = mkdtempSync(join(tmpdir(), 'ferret-dl-'))
    try {
      const tarBytes = execFileSync('sh', ['-c', remoteTarCommand('~/proj', ['src', "it's here/日本語.png"])], { env: { PATH: process.env.PATH, HOME: home } })
      execFileSync('tar', ['-xf', '-', '-C', out], { input: tarBytes })
      expect(readFileSync(join(out, 'src', 'a.ts'), 'utf8')).toBe('a')
      expect(readFileSync(join(out, "it's here", '日本語.png')).length).toBe(8)
    } finally {
      rmSync(out, { recursive: true, force: true })
    }
  })

  it('アップロードは指定のフォルダへ広げ、既にあるファイルは上書きしない', () => {
    const src = mkdtempSync(join(tmpdir(), 'ferret-ul-'))
    try {
      writeFileSync(join(src, 'up.txt'), 'new')
      writeFileSync(join(src, 'a.ts'), 'overwritten?')
      const tarBytes = execFileSync('tar', ['-cf', '-', '-C', src, 'up.txt', 'a.ts'])
      try {
        execFileSync('sh', ['-c', remoteUntarCommand('~/proj', 'src')], { env: { PATH: process.env.PATH, HOME: home }, input: tarBytes, stdio: ['pipe', 'pipe', 'pipe'] })
      } catch { /* 既にあるファイルを飛ばすと tar は 0 以外で終わることがある */ }
      expect(readFileSync(join(proj, 'src', 'up.txt'), 'utf8')).toBe('new')
      expect(readFileSync(join(proj, 'src', 'a.ts'), 'utf8')).toBe('a')
    } finally {
      rmSync(src, { recursive: true, force: true })
    }
  })

  it('根・.git の中・外へ出るパスは組み立てない', () => {
    expect(() => remoteTarCommand('~/p', [''])).toThrow()
    expect(() => remoteTarCommand('~/p', ['.git/config'])).toThrow()
    expect(() => remoteTarCommand('~/p', ['../x'])).toThrow()
    expect(() => remoteTarCommand('~/p', [])).toThrow()
    expect(() => remoteUntarCommand('~/p', '.git')).toThrow()
    expect(() => remoteUntarCommand('~/p', '../x')).toThrow()
    expect(remoteUntarCommand('~/p', '')).toContain("cd -- '.'")
  })
})

describe.runIf(posix)('大きさだけを読む', () => {
  it('count 0 では中身を読まない（BSD の head -c 0 は失敗する）', async () => {
    const command = remoteReadRangeCommand('~/proj', 'README.md', 0, 0)
    expect(command).not.toContain('head -c')
    const r = await localShell(home)('h', command)
    expect(r.code).toBe(0)
    expect(parseRemoteReadRange(r.stdout)).toEqual({ size: 5, data: Buffer.alloc(0) })
  })
})
