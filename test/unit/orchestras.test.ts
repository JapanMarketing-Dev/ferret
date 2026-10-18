/**
 * 複数のオーケストラ（src/shared/orchestras.ts）。プロジェクトは orchestraId でどれか1つに属し、
 * サイドバーではオーケストラの下にサブフォルダのように並ぶ。ドラッグで別のオーケストラへ移し、並べ替える
 */
import { describe, expect, it } from 'vitest'
import { currentOrchestra, moveInTree, orchestraIdOf, orchestraList, orchestraMembers, orchestraTree, removeOrchestra, treeDrop, treeRows } from '../../src/shared/orchestras'
import type { Project } from '../../src/shared/types'

const p = (id: string, extra: Partial<Project> = {}): Project => ({ id, name: id, folderPath: `/f/${id}`, urls: [], ...extra })
const o = (id: string) => p(id, { editorWorkspace: true, orchestrator: true })

// O1: a（id なし → 先頭）・b、O2: c・d（外した）・e（SSH）。f は消えたオーケストラを指す → 先頭
const ALL: Project[] = [
  o('O1'), p('a'), p('b', { orchestraId: 'O1' }),
  o('O2'), p('c', { orchestraId: 'O2' }), p('d', { orchestraId: 'O2', orchestraExcluded: true }), p('e', { orchestraId: 'O2', source: 'ssh' }),
  p('f', { orchestraId: 'gone' }), p('old', { orchestrator: true, orchestraId: 'O2' })
]
const ids = (list: readonly Project[]) => list.map((x) => x.id)

describe('所属', () => {
  it('orchestraId が無い・消えたオーケストラを指すものは先頭のオーケストラ。オーケストラ自身は null', () => {
    expect(orchestraIdOf(ALL, ALL.find((x) => x.id === 'a')!)).toBe('O1')
    expect(orchestraIdOf(ALL, ALL.find((x) => x.id === 'c')!)).toBe('O2')
    expect(orchestraIdOf(ALL, ALL.find((x) => x.id === 'f')!)).toBe('O1')
    expect(orchestraIdOf(ALL, o('O2'))).toBeNull()
    expect(orchestraIdOf([p('x')], p('x'))).toBeNull()
  })

  it('メンバーは SSH・旧オーケストレーター・外したものを除く。includeExcluded なら外したものも', () => {
    expect(ids(orchestraMembers(ALL, 'O1'))).toEqual(['a', 'b', 'f'])
    expect(ids(orchestraMembers(ALL, 'O2'))).toEqual(['c'])
    expect(ids(orchestraMembers(ALL, 'O2', { includeExcluded: true }))).toEqual(['c', 'd'])
    expect(orchestraMembers(ALL, 'nope')).toEqual([])
  })

  it('開いているオーケストラ：オーケストラならそれ、プロダクトなら所属、無ければ先頭', () => {
    expect(currentOrchestra(ALL, 'O2')?.id).toBe('O2')
    expect(currentOrchestra(ALL, 'c')?.id).toBe('O2')
    expect(currentOrchestra(ALL, 'a')?.id).toBe('O1')
    expect(currentOrchestra(ALL, null)?.id).toBe('O1')
    expect(currentOrchestra(ALL, 'missing')?.id).toBe('O1')
    expect(currentOrchestra([p('x')], 'x')).toBeNull()
  })
})

describe('サイドバーの木', () => {
  it('オーケストラは全体の順、子は与えた順。子も自身も見えないグループは出さない', () => {
    const tree = orchestraTree(ALL, [ALL[2]!, ALL[1]!])
    expect(tree.map((g) => [g.orchestra.id, ids(g.children)])).toEqual([['O1', ['b', 'a']]])
    expect(orchestraTree(ALL, ALL).map((g) => [g.orchestra.id, ids(g.children)])).toEqual([['O1', ['a', 'b', 'f']], ['O2', ['c', 'd', 'e', 'old']]])
  })

  it('行は オーケストラ → 子（字下げ）。畳んだら子は出さず数だけ持つ。オーケストラが無ければ平らに並べる', () => {
    const rows = treeRows(ALL, ALL, new Set(['O2']))
    expect(rows.map((r) => [r.project.id, r.depth])).toEqual([['O1', 0], ['a', 1], ['b', 1], ['f', 1], ['O2', 0]])
    expect(rows.find((r) => r.project.id === 'O2')).toMatchObject({ collapsed: true, childCount: 4 })
    expect(treeRows([p('x'), p('y')], [p('x'), p('y')], new Set()).map((r) => [r.project.id, r.depth])).toEqual([['x', 0], ['y', 0]])
  })

  it('ビジネスリサーチのフォルダは、オーケストラに入れず最後に depth 0 で並べる。動かせず、落とし先にもならない', () => {
    const all = [...ALL, p('r', { research: true })]
    const rows = treeRows(all, all, new Set(['O2']))
    expect(rows.map((r) => [r.project.id, r.depth])).toEqual([['O1', 0], ['a', 1], ['b', 1], ['f', 1], ['O2', 0], ['r', 0]])
    expect(orchestraMembers(all, 'O1').map((x) => x.id)).not.toContain('r')
    expect(treeDrop(all, rows, 'r', 'O1', 'before')).toBeNull()
    expect(treeDrop(all, rows, 'a', 'r', 'after')).toBeNull()
  })
})

describe('移す・並べ替える', () => {
  it('別のオーケストラへ移すと orchestraId が変わり、before の前（無ければ最後の子の後ろ）に入る', () => {
    const next = moveInTree(ALL, 'a', 'O2', 'c')
    expect(next.find((x) => x.id === 'a')!.orchestraId).toBe('O2')
    expect(ids(orchestraMembers(next, 'O2'))).toEqual(['a', 'c'])
    const end = moveInTree(ALL, 'a', 'O2', null)
    expect(ids(end).indexOf('a')).toBe(ids(end).indexOf('old') + 1)
    expect(ids(orchestraMembers(end, 'O1'))).toEqual(['b', 'f'])
  })

  it('子の無いオーケストラへ移すと全体の最後に入る', () => {
    const next = moveInTree([...ALL, o('O3')], 'b', 'O3', null)
    expect(next.at(-1)).toMatchObject({ id: 'b', orchestraId: 'O3' })
  })

  it('オーケストラを動かすと before のオーケストラの前（無ければ最後）。子の所属は変わらない', () => {
    const next = moveInTree(ALL, 'O2', null, 'O1')
    expect(ids(orchestraList(next))).toEqual(['O2', 'O1'])
    expect(orchestraIdOf(next, next.find((x) => x.id === 'c')!)).toBe('O2')
    expect(ids(orchestraList(moveInTree(ALL, 'O1', null, null)))).toEqual(['O2', 'O1'])
  })

  it('知らない id・オーケストラでない移し先は元のまま', () => {
    expect(moveInTree(ALL, 'nope', 'O1', null)).toEqual(ALL)
    expect(moveInTree(ALL, 'a', 'c', null)).toEqual(ALL)
    expect(moveInTree(ALL, 'a', null, null)).toEqual(ALL)
  })

  it('オーケストラを消すと子は残りの先頭へ。最後の1つ・知らない id は null', () => {
    const next = removeOrchestra(ALL, 'O2')!
    expect(ids(orchestraList(next))).toEqual(['O1'])
    expect(next.find((x) => x.id === 'c')!.orchestraId).toBe('O1')
    expect(ids(orchestraMembers(next, 'O1'))).toEqual(['a', 'b', 'c', 'f'])
    expect(removeOrchestra(next, 'O1')).toBeNull()
    expect(removeOrchestra(ALL, 'c')).toBeNull()
  })
})

describe('ドロップの移動先', () => {
  const rows = treeRows(ALL, ALL, new Set())
  it('プロジェクトをオーケストラの行に落とすとその最後へ', () => {
    expect(treeDrop(ALL, rows, 'a', 'O2', 'before')).toEqual({ id: 'a', to: 'O2', before: null })
  })

  it('プロジェクトの行の上半分はその前、下半分は次の兄弟の前（最後なら null）', () => {
    expect(treeDrop(ALL, rows, 'a', 'c', 'before')).toEqual({ id: 'a', to: 'O2', before: 'c' })
    expect(treeDrop(ALL, rows, 'a', 'c', 'after')).toEqual({ id: 'a', to: 'O2', before: 'd' })
    expect(treeDrop(ALL, rows, 'a', 'old', 'after')).toEqual({ id: 'a', to: 'O2', before: null })
    // 同じオーケストラの中の並べ替え（自分は兄弟に数えない）
    expect(treeDrop(ALL, rows, 'a', 'b', 'after')).toEqual({ id: 'a', to: 'O1', before: 'f' })
  })

  it('オーケストラはオーケストラの行にだけ落とせる', () => {
    expect(treeDrop(ALL, rows, 'O2', 'O1', 'before')).toEqual({ id: 'O2', to: null, before: 'O1' })
    expect(treeDrop(ALL, rows, 'O1', 'O2', 'after')).toEqual({ id: 'O1', to: null, before: null })
    expect(treeDrop(ALL, rows, 'O1', 'c', 'before')).toBeNull()
  })

  it('自分自身・知らない id は null', () => {
    expect(treeDrop(ALL, rows, 'a', 'a', 'before')).toBeNull()
    expect(treeDrop(ALL, rows, 'x', 'a', 'before')).toBeNull()
    expect(treeDrop(ALL, rows, 'a', 'x', 'before')).toBeNull()
  })
})
