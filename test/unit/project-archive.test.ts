/**
 * プロジェクトとオーケストラのアーカイブ（src/shared/projectArchive.ts）と、作業用のフォルダ「work」のサイドバー・オーケストラでの扱い
 * （src/shared/orchestras.ts・src/shared/productRound.ts）。消さずに隠し、元に戻すと前と同じ場所・設定に戻る
 */
import { describe, expect, it } from 'vitest'
import { activeProjects, archiveFallback, archivedProjects, canArchive, isArchived, setArchived } from '../../src/shared/projectArchive'
import { currentOrchestra, isLooseFolder, orchestraMembers, treeDrop, treeRows } from '../../src/shared/orchestras'
import { roundProducts } from '../../src/shared/productRound'
import { sanitize } from '../../src/main/settings'
import type { Project } from '../../src/shared/types'

const p = (id: string, extra: Partial<Project> = {}): Project => ({ id, name: id, folderPath: `/f/${id}`, urls: [], ...extra })
const o = (id: string, extra: Partial<Project> = {}) => p(id, { editorWorkspace: true, orchestrator: true, ...extra })
const ids = (list: readonly Project[]) => list.map((x) => x.id)

// O1: a・b、O2: c。w は work
const ALL: Project[] = [o('O1'), p('a'), p('b', { orchestraId: 'O1', starred: true, urls: [{ id: 'u', label: 'x', url: 'https://x.test' }] as Project['urls'] }), o('O2'), p('c', { orchestraId: 'O2' }), p('w', { work: true })]

describe('アーカイブの印', () => {
  it('印を付けると隠れ、外すと元の並び・項目のまま戻る', () => {
    const archived = setArchived(ALL, 'b', true)
    expect(archived.find((x) => x.id === 'b')).toMatchObject({ archived: true, starred: true, orchestraId: 'O1' })
    expect(ids(activeProjects(archived))).not.toContain('b')
    expect(ids(archivedProjects(archived))).toEqual(['b'])
    const restored = setArchived(archived, 'b', false)
    expect(restored).toEqual(ALL)
    expect('archived' in restored.find((x) => x.id === 'b')!).toBe(false)
  })

  it('知らない id は何も変えない。ほかのプロジェクトは同じもの（参照）のまま', () => {
    expect(setArchived(ALL, 'nope', true)).toEqual(ALL)
    const next = setArchived(ALL, 'a', true)
    expect(next[0]).toBe(ALL[0])
    expect(next[2]).toBe(ALL[2])
  })

  it('印を外すのを2回しても壊れない（印の無いものに false）', () => {
    expect(setArchived(setArchived(ALL, 'a', false), 'a', false)).toEqual(ALL)
  })

  it('オーケストラをアーカイブすると、属するプロジェクトもいっしょに隠れる（子の印は変えない）', () => {
    const next = setArchived(ALL, 'O2', true)
    expect(isArchived(next, next.find((x) => x.id === 'c')!)).toBe(true)
    expect(next.find((x) => x.id === 'c')!.archived).toBeUndefined()
    expect(ids(activeProjects(next))).toEqual(['O1', 'a', 'b', 'w'])
    // アーカイブの一覧にはオーケストラだけ（戻せば子も戻る）
    expect(ids(archivedProjects(next))).toEqual(['O2'])
    expect(ids(activeProjects(setArchived(next, 'O2', false)))).toEqual(ids(ALL))
  })

  it('orchestraId が無い・消えたオーケストラを指すプロジェクトは、先頭のオーケストラのアーカイブで隠れる', () => {
    const all = [...ALL, p('f', { orchestraId: 'gone' })]
    const next = setArchived(all, 'O1', true)
    expect(isArchived(next, next.find((x) => x.id === 'a')!)).toBe(true)
    expect(isArchived(next, next.find((x) => x.id === 'f')!)).toBe(true)
  })

  it('オーケストラが1つも無いときのプロジェクトは、自分の印だけで決まる', () => {
    const plain = [p('x'), p('y', { archived: true })]
    expect(ids(activeProjects(plain))).toEqual(['x'])
  })
})

describe('アーカイブできるか', () => {
  it('普通のプロジェクトはいつでも。もうアーカイブしたもの・知らない id はできない', () => {
    expect(canArchive(ALL, 'a')).toBe(true)
    expect(canArchive(ALL, 'w')).toBe(true)
    expect(canArchive(setArchived(ALL, 'a', true), 'a')).toBe(false)
    expect(canArchive(ALL, 'nope')).toBe(false)
  })

  it('最後の（アーカイブしていない）オーケストラはアーカイブできない', () => {
    expect(canArchive(ALL, 'O1')).toBe(true)
    const one = setArchived(ALL, 'O2', true)
    expect(canArchive(one, 'O1')).toBe(false)
    expect(canArchive([o('only'), p('a')], 'only')).toBe(false)
  })
})

describe('開いていたものを隠したときの移り先', () => {
  it('隠していない先頭のオーケストラ → 先頭のプロジェクト → 無し', () => {
    expect(archiveFallback(setArchived(ALL, 'O1', true))!.id).toBe('O2')
    expect(archiveFallback([p('x', { archived: true }), p('y')])!.id).toBe('y')
    expect(archiveFallback([p('x', { archived: true })])).toBeNull()
    expect(archiveFallback([])).toBeNull()
  })

  it('開いているプロダクトが無いときの今のオーケストラは、アーカイブしていないもの', () => {
    expect(currentOrchestra(setArchived(ALL, 'O1', true), null)!.id).toBe('O2')
    expect(currentOrchestra(ALL, null)!.id).toBe('O1')
  })
})

describe('オーケストラ・巡回から外す', () => {
  it('アーカイブしたプロダクトは、外したものを含めた一覧（ダッシュボード）にも出さない', () => {
    const next = setArchived(ALL, 'b', true)
    expect(ids(orchestraMembers(next, 'O1'))).toEqual(['a'])
    expect(ids(orchestraMembers(next, 'O1', { includeExcluded: true }))).toEqual(['a'])
  })

  it('巡回の対象から、アーカイブ・オーケストラごと隠したもの・work を外す', () => {
    expect(ids(roundProducts(ALL))).toEqual(['a', 'b', 'c'])
    expect(ids(roundProducts(setArchived(ALL, 'a', true)))).toEqual(['b', 'c'])
    expect(ids(roundProducts(setArchived(ALL, 'O2', true)))).toEqual(['a', 'b'])
  })
})

describe('work（作業用のフォルダ）のサイドバーでの扱い', () => {
  it('オーケストラに入れず、最後に depth 0 で並べる。リサーチのフォルダと同じく動かせず、落とし先にもならない', () => {
    expect(isLooseFolder(p('w', { work: true }))).toBe(true)
    expect(isLooseFolder(p('r', { research: true }))).toBe(true)
    expect(isLooseFolder(p('x'))).toBe(false)
    const rows = treeRows(ALL, ALL, new Set())
    expect(rows.at(-1)).toMatchObject({ project: { id: 'w' }, depth: 0 })
    expect(ids(orchestraMembers(ALL, 'O1'))).not.toContain('w')
    expect(treeDrop(ALL, rows, 'w', 'O1', 'before')).toBeNull()
    expect(treeDrop(ALL, rows, 'a', 'w', 'after')).toBeNull()
  })

  it('アーカイブした work は、隠した一覧（activeProjects）を渡せばサイドバーに出ない', () => {
    const next = setArchived(ALL, 'w', true)
    const shown = activeProjects(next)
    expect(ids(treeRows(next, shown, new Set()).map((r) => r.project))).not.toContain('w')
  })
})

describe('保存した設定の読み込み', () => {
  it('archived・work の印は true のときだけ残す。古い設定（印なし）はそのまま読める', () => {
    const settings = sanitize({ projects: [
      { id: 'a', folderPath: '/f/a', archived: true, work: true },
      { id: 'b', folderPath: '/f/b', archived: 'yes', work: 1 },
      { id: 'c', folderPath: '/f/c' }
    ] })
    expect(settings.projects[0]).toMatchObject({ archived: true, work: true })
    expect(settings.projects[1]!.archived).toBeUndefined()
    expect(settings.projects[1]!.work).toBeUndefined()
    expect(settings.projects[2]!.archived).toBeUndefined()
  })

  it('オーケストラ（editorWorkspace）に work の印は付けない', () => {
    const settings = sanitize({ projects: [{ id: 'o', folderPath: '/f/o', editorWorkspace: true, work: true, archived: true }] })
    expect(settings.projects[0]!.work).toBeUndefined()
    expect(settings.projects[0]!.archived).toBe(true)
  })
})
