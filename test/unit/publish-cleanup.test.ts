import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { removeLegacyPublishData } from '../../src/main/publishCleanup'

/** 削除した「発信」が userData に残したもの（下書き・X のトークン）の後片付け（src/main/publishCleanup.ts） */
let root: string
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'ferret-publish-cleanup-test-')) })
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

describe('removeLegacyPublishData', () => {
  it('publish/ と publish-connections.bin だけを消す', async () => {
    await mkdir(join(root, 'publish', 'work'), { recursive: true })
    await writeFile(join(root, 'publish', 'drafts.json'), '{}')
    await writeFile(join(root, 'publish-connections.bin'), 'secret')
    await writeFile(join(root, 'settings.json'), '{}')
    await writeFile(join(root, 'publish-other.json'), '{}')
    await mkdir(join(root, 'publishing'))
    const removed = await removeLegacyPublishData(root)
    expect(removed).toEqual([join(root, 'publish'), join(root, 'publish-connections.bin')])
    expect((await readdir(root)).sort()).toEqual(['publish-other.json', 'publishing', 'settings.json'])
  })

  it('無くても失敗しない（2回目・初めての起動）', async () => {
    expect(await removeLegacyPublishData(root)).toEqual([])
    expect(await removeLegacyPublishData(join(root, 'missing'))).toEqual([])
  })

  it('片方だけでも消す', async () => {
    await writeFile(join(root, 'publish-connections.bin'), 'secret')
    expect(await removeLegacyPublishData(root)).toEqual([join(root, 'publish-connections.bin')])
    expect(await readdir(root)).toEqual([])
  })

  it('リンクはリンクだけを消し、先は消さない', async () => {
    const outside = join(root, 'outside')
    await mkdir(outside)
    await writeFile(join(outside, 'keep.txt'), 'x')
    const userData = join(root, 'userData')
    await mkdir(userData)
    await symlink(outside, join(userData, 'publish'))
    expect(await removeLegacyPublishData(userData)).toEqual([join(userData, 'publish')])
    expect(await readdir(userData)).toEqual([])
    expect(await readdir(outside)).toEqual(['keep.txt'])
  })
})
