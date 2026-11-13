/**
 * 既定のプロジェクト「work」（src/main/workProject.ts）。置き場・一覧へ1回だけ足す・フォルダの作り直し
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WORK_PROJECT_NAME, ensureWorkFolder, isWorkProject, withWorkProject, workFolderPath } from '../../src/main/workProject'
import { setArchived } from '../../src/shared/projectArchive'
import type { Project } from '../../src/shared/types'

const p = (id: string, extra: Partial<Project> = {}): Project => ({ id, name: id, folderPath: `/f/${id}`, urls: [], ...extra })
const NOW = new Date('2026-11-13T00:00:00Z')

describe('置き場', () => {
  it('配布版は ~/Ferret/work、開発版・E2E は設定フォルダの下', () => {
    expect(workFolderPath({ home: '/home/taro', configDir: '/home/taro/.ferret', shared: true })).toBe(join('/home/taro', 'Ferret', 'work'))
    expect(workFolderPath({ home: '/home/taro', configDir: '/home/taro/.ferret/dev', shared: false })).toBe(join('/home/taro/.ferret/dev', 'work'))
  })
})

describe('一覧に足す', () => {
  it('無ければ最後に「work」の名前と印で足す', () => {
    const next = withWorkProject([p('a')], '/home/taro/Ferret/work', 'w1', NOW)
    expect(next).toHaveLength(2)
    expect(next[1]).toMatchObject({ id: 'w1', name: WORK_PROJECT_NAME, folderPath: '/home/taro/Ferret/work', work: true, urls: [], addedAt: NOW.toISOString() })
    expect(isWorkProject(next[1]!)).toBe(true)
    expect(isWorkProject(next[0]!)).toBe(false)
  })

  it('空の一覧（初めての起動）にも足す', () => {
    expect(withWorkProject([], '/w', 'w1', NOW).map((x) => x.id)).toEqual(['w1'])
  })

  it('もう印のあるものがあれば何もしない（同じ配列を返す）。アーカイブして隠していても足し直さない', () => {
    const list = [p('a'), p('w', { work: true, name: 'mine', folderPath: '/elsewhere' })]
    expect(withWorkProject(list, '/w')).toBe(list)
    const hidden = setArchived(list, 'w', true)
    expect(withWorkProject(hidden, '/w')).toBe(hidden)
  })

  it('同じフォルダを自分で登録していれば、それに印を付ける（二重に登録しない）', () => {
    const next = withWorkProject([p('a'), p('mine', { folderPath: '/w/' })], '/w')
    expect(next).toHaveLength(2)
    expect(next[1]).toMatchObject({ id: 'mine', name: 'mine', work: true })
  })

  it('外された（一覧から消えた）ときは、次の起動でまた足す', () => {
    const first = withWorkProject([p('a')], '/w', 'w1', NOW)
    const removed = first.filter((x) => !x.work)
    expect(withWorkProject(removed, '/w', 'w2', NOW).map((x) => x.id)).toEqual(['a', 'w2'])
  })
})

describe('フォルダ', () => {
  let dir = ''
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'ferret-work-')) })
  afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

  it('無ければ（消されていても）親ごと作る。あればそのまま', async () => {
    const folder = join(dir, 'Ferret', 'work')
    expect(ensureWorkFolder(folder)).toBe(true)
    expect((await stat(folder)).isDirectory()).toBe(true)
    await writeFile(join(folder, 'note.txt'), 'keep')
    expect(ensureWorkFolder(folder)).toBe(true)
    expect((await stat(join(folder, 'note.txt'))).isFile()).toBe(true)
    await rm(folder, { recursive: true })
    expect(ensureWorkFolder(folder)).toBe(true)
  })

  it('同じ名前のファイルがあれば false（投げない）', async () => {
    const file = join(dir, 'work')
    await writeFile(file, 'x')
    expect(ensureWorkFolder(file)).toBe(false)
  })
})
