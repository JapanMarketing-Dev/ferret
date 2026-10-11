/**
 * 所有者だけが読めるファイルの置き換え（src/main/atomicFile.ts）。
 * 以前はパスワード・閲覧履歴・共有の保存が `${path}.${pid}.tmp` という同じ一時ファイルに書いていて、
 * 同じプロセスの2つの保存が重なると、片方の失敗の片付けがもう片方の一時ファイルを消していた
 */
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { savePrivateFile, writePrivateFileAtomic, writePrivateFileAtomicSync } from '../../src/main/atomicFile'

const dirs: string[] = []
const fresh = () => {
  const dir = mkdtempSync(join(tmpdir(), 'atomic-file-'))
  dirs.push(dir)
  return dir
}
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

describe('所有者だけが読めるファイルの置き換え', () => {
  it('同時に20回保存しても、どれか1つの中身が丸ごと残り、一時ファイルは残らない', async () => {
    const dir = fresh()
    const target = join(dir, 'store.json')
    const bodies = Array.from({ length: 20 }, (_, i) => JSON.stringify({ i, pad: 'x'.repeat(1000 + i) }))
    await Promise.all(bodies.map((body) => writePrivateFileAtomic(target, body)))
    expect(bodies).toContain(readFileSync(target, 'utf8'))
    expect(readdirSync(dir)).toEqual(['store.json'])
  })

  it('文字列もバイト列も書ける。所有者だけが読める（POSIX）', async () => {
    const dir = fresh()
    const a = join(dir, 'a.bin')
    await writePrivateFileAtomic(a, new Uint8Array([1, 2, 3]))
    expect([...readFileSync(a)]).toEqual([1, 2, 3])
    const b = join(dir, 'b.txt')
    writePrivateFileAtomicSync(b, 'こんにちは')
    expect(readFileSync(b, 'utf8')).toBe('こんにちは')
    writePrivateFileAtomicSync(b, new Uint8Array([65]))
    expect(readFileSync(b, 'utf8')).toBe('A')
    if (process.platform !== 'win32') {
      expect(statSync(a).mode & 0o777).toBe(0o600)
      expect(statSync(b).mode & 0o777).toBe(0o600)
    }
  })

  it('commit が false なら置き換えず、一時ファイルも消す', async () => {
    const dir = fresh()
    const target = join(dir, 'x.json')
    writeFileSync(target, 'old')
    expect(await writePrivateFileAtomic(target, 'new', () => false)).toBe(false)
    expect(readFileSync(target, 'utf8')).toBe('old')
    expect(readdirSync(dir)).toEqual(['x.json'])
  })

  it('置き場所がリンクでも、リンクの先には書かない（リンクそのものを置き換える）', async () => {
    if (process.platform === 'win32') return
    const dir = fresh()
    const outside = join(dir, 'outside.txt')
    writeFileSync(outside, 'keep')
    const target = join(dir, 'link.json')
    symlinkSync(outside, target)
    await writePrivateFileAtomic(target, 'new')
    expect(readFileSync(outside, 'utf8')).toBe('keep')
    expect(readFileSync(target, 'utf8')).toBe('new')
  })

  it('書けないフォルダでは投げて、何も残さない', async () => {
    const dir = fresh()
    await expect(writePrivateFileAtomic(join(dir, 'missing', 'x.json'), 'a')).rejects.toThrow()
    expect(() => writePrivateFileAtomicSync(join(dir, 'missing', 'y.json'), 'a')).toThrow()
    expect(readdirSync(dir)).toEqual([])
  })

  it('savePrivateFile はフォルダを作ってから置き換える', async () => {
    const dir = fresh()
    const target = join(dir, 'a', 'b', 'c.json')
    await savePrivateFile(target, '{}')
    expect(readFileSync(target, 'utf8')).toBe('{}')
  })

  it('パスワード・閲覧履歴・共有の保存は、pid だけの一時ファイル名を使わない', () => {
    for (const file of ['src/main/browserImport/passwords.ts', 'src/main/browserImport/history.ts', 'src/main/feedbackShare/store.ts']) {
      const text = readFileSync(file, 'utf8')
      expect(text, file).not.toMatch(/\$\{process\.pid\}\.tmp/)
      expect(text, file).toContain('savePrivateFile(')
    }
  })
})

describe('リンクを通った場所から起動したアプリの画面', () => {
  it('アプリの画面の判定に、アプリの場所の実体のパスも入れる（/var → /private/var で画面の呼び出しを全部断っていた）', async () => {
    const { isAppPageUrl } = await import('../../src/main/webPolicy')
    const roots = ['file:///var/folders/x/app', 'file:///private/var/folders/x/app']
    expect(isAppPageUrl('file:///private/var/folders/x/app/out/renderer/index.html', roots)).toBe(true)
    expect(isAppPageUrl('file:///private/var/folders/x/app/out/renderer/index.html', roots.slice(0, 1))).toBe(false)
    expect(isAppPageUrl('file:///private/var/folders/x/app-evil/index.html', roots)).toBe(false)
    const main = readFileSync('src/main/index.ts', 'utf8')
    expect(main).toMatch(/function appPageRoots\(\)[\s\S]{0,400}realAppPath\(\)/)
  })
})
