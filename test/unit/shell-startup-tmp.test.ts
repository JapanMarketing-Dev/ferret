/**
 * シェルの起動ファイルの置き場所（security-2 [7]）。
 * 決まった名前の共有の一時フォルダを使わず、先回りで置かれたフォルダ・ファイル・リンクを使わないこと、
 * 書き換えられたら使わないことを、一時フォルダの中だけで確かめる（シェルは起動しない）。
 */
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync, statSync } from 'node:fs'
import { tmpdir, userInfo } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { bashStartupRcfile, createWrapperRoot, planStartupDelivery, verifyWrapperRoot, wrapperRootVanished, zshStartupWrapper } from '../../src/main/shellStartup'

const base = mkdtempSync(join(tmpdir(), 'ade-sec7-'))
afterAll(() => rmSync(base, { recursive: true, force: true }))
const posix = process.platform !== 'win32'

describe('security-2 [7] シェルの起動ファイルの置き場所', () => {
  it('security-2 [7] 決まった名前（ade-shell-<user>）に先回りで置かれたフォルダ・リンクは使わない', () => {
    // 攻撃者が以前の決まった名前で、仕込んだ起動ファイルとリンクを置いておく
    const predictable = join(base, `ade-shell-${userInfo().username}`)
    mkdirSync(join(predictable, 'zsh'), { recursive: true })
    writeFileSync(join(predictable, 'zsh', '.zshenv'), 'echo pwned\n')
    writeFileSync(join(predictable, 'bashrc'), 'echo pwned\n')
    const root = createWrapperRoot(base)
    expect(root).not.toBe(predictable)
    expect(root.startsWith(join(base, 'ade-shell-'))).toBe(true)
    expect(readFileSync(join(root, 'zsh', '.zshenv'), 'utf8')).toBe(zshStartupWrapper())
    expect(readFileSync(join(root, 'bashrc'), 'utf8')).toBe(bashStartupRcfile())
    // 仕込まれたものには触れない
    expect(readFileSync(join(predictable, 'bashrc'), 'utf8')).toBe('echo pwned\n')
  })

  it('security-2 [7] 毎回推測できない別のフォルダを作り、利用者だけが読み書きできる', () => {
    const a = createWrapperRoot(base)
    const b = createWrapperRoot(base)
    expect(a).not.toBe(b)
    expect(verifyWrapperRoot(a)).toBe(true)
    if (posix) {
      expect(statSync(a).mode & 0o777).toBe(0o700)
      expect(statSync(join(a, 'zsh')).mode & 0o777).toBe(0o700)
      expect(statSync(join(a, 'bashrc')).mode & 0o777).toBe(0o600)
    }
  })

  it.skipIf(!posix)('security-2 [7] 起動ファイルがリンクに差し替えられたら使わない', () => {
    const root = createWrapperRoot(base)
    const evil = join(base, 'evil-rc')
    writeFileSync(evil, bashStartupRcfile())
    unlinkSync(join(root, 'bashrc'))
    symlinkSync(evil, join(root, 'bashrc'))
    expect(verifyWrapperRoot(root)).toBe(false)
  })

  it.skipIf(!posix)('security-2 [7] 中身が書き換えられた・ほかの人が書ける権限にされたら使わない', () => {
    const tampered = createWrapperRoot(base)
    writeFileSync(join(tampered, 'zsh', '.zshenv'), 'echo pwned\n')
    expect(verifyWrapperRoot(tampered)).toBe(false)

    const loosened = createWrapperRoot(base)
    chmodSync(loosened, 0o777)
    expect(verifyWrapperRoot(loosened)).toBe(false)
    const looseFile = createWrapperRoot(base)
    chmodSync(join(looseFile, 'bashrc'), 0o666)
    expect(verifyWrapperRoot(looseFile)).toBe(false)
  })

  it('security-2 [7] 置き場所が無い・壊れていれば false（例外にしない）', () => {
    expect(verifyWrapperRoot(join(base, 'missing'))).toBe(false)
  })

  it('security-2 [7] zsh / bash の起動は、確かめた置き場所の起動ファイルを指す', () => {
    const zsh = planStartupDelivery({ file: '/bin/zsh', args: ['-l'] }, 'claude', undefined)
    const bash = planStartupDelivery({ file: '/bin/bash', args: ['-l'] }, 'codex')
    expect(zsh.kind).toBe('shell-hook')
    const zdotdir = zsh.env.ZDOTDIR!
    const rcfile = bash.shell.args[1]!
    const root = join(zdotdir, '..')
    expect(root).not.toBe(join(tmpdir(), `ade-shell-${userInfo().username}`))
    expect(join(rcfile, '..')).toBe(root)
    expect(verifyWrapperRoot(root)).toBe(true)
  })

  it.skipIf(!posix)('security-2 [7] 使っている置き場所が書き換えられたら、次の起動では作り直した場所を使う', () => {
    const first = planStartupDelivery({ file: '/bin/bash', args: ['-l'] }, 'codex').shell.args[1]!
    writeFileSync(first, 'echo pwned\n')
    const second = planStartupDelivery({ file: '/bin/bash', args: ['-l'] }, 'codex').shell.args[1]!
    expect(second).not.toBe(first)
    expect(readFileSync(second, 'utf8')).toBe(bashStartupRcfile())
  })
})

describe('一時フォルダの掃除で消えた置き場所（FERRET-2F）', () => {
  it('消えただけ（フォルダごと・ファイルだけ）なら「消えた」、中身の書き換えなら「消えていない」', () => {
    const whole = createWrapperRoot(base)
    expect(wrapperRootVanished(whole)).toBe(false)
    rmSync(whole, { recursive: true, force: true })
    expect(wrapperRootVanished(whole)).toBe(true)
    const partial = createWrapperRoot(base)
    unlinkSync(join(partial, 'bashrc'))
    expect(wrapperRootVanished(partial)).toBe(true)
    expect(verifyWrapperRoot(partial)).toBe(false)
    const edited = createWrapperRoot(base)
    writeFileSync(join(edited, 'bashrc'), 'echo pwned\n')
    expect(wrapperRootVanished(edited)).toBe(false)
    expect(verifyWrapperRoot(edited)).toBe(false)
  })
})
