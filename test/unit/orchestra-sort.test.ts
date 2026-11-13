/**
 * オーケストラとプロジェクトの並び順を別々に選ぶ（src/shared/projectOrder.ts の sortOrchestras・src/shared/orchestras.ts の treeRows）。
 * 例: オーケストラは手動、プロジェクトは最近使った順
 */
import { describe, expect, it } from 'vitest'
import { DEFAULT_PROJECT_VIEW, ORCHESTRA_SORTS, filterProjects, sanitizeProjectView, sortOrchestras, sortProjects } from '../../src/shared/projectOrder'
import { treeRows } from '../../src/shared/orchestras'
import type { Project } from '../../src/shared/types'

const p = (id: string, extra: Partial<Project> = {}): Project => ({ id, name: id, folderPath: `/f/${id}`, urls: [], ...extra })
const o = (id: string, extra: Partial<Project> = {}) => p(id, { editorWorkspace: true, orchestrator: true, ...extra })
const at = (day: number) => new Date(Date.UTC(2026, 10, day)).toISOString()
const ids = (list: readonly Project[]) => list.map((x) => x.id)

// 手動の順: Zeta（中に a・b）→ Alpha（中に c・d）→ Mid（空）。w は work
const ALL: Project[] = [
  o('Z', { name: 'Zeta', lastOpenedAt: at(1) }), p('a', { lastOpenedAt: at(2) }), p('b', { orchestraId: 'Z', lastOpenedAt: at(9) }),
  o('A', { name: 'Alpha', lastOpenedAt: at(5) }), p('c', { orchestraId: 'A' }), p('d', { orchestraId: 'A', lastOpenedAt: at(7) }),
  o('M', { name: 'Mid' }),
  p('w', { work: true, lastOpenedAt: at(12) })
]

describe('オーケストラの並び順', () => {
  it('手動は全体の並び（settings の順）のまま', () => {
    expect(ids(sortOrchestras(ALL, 'manual'))).toEqual(['Z', 'A', 'M'])
  })

  it('名前順（大文字小文字・数字を人の感覚で）', () => {
    expect(ids(sortOrchestras(ALL, 'name'))).toEqual(['A', 'M', 'Z'])
    const numbered = [o('x', { name: 'Team 10' }), o('y', { name: 'team 2' })]
    expect(ids(sortOrchestras(numbered, 'name'))).toEqual(['y', 'x'])
  })

  it('最近使った順は、オーケストラ自身と中のプロジェクトのうち一番新しい時刻で比べる', () => {
    // Zeta: b が 9日 / Alpha: d が 7日 / Mid: 時刻なし
    expect(ids(sortOrchestras(ALL, 'recent'))).toEqual(['Z', 'A', 'M'])
    const touched = ALL.map((x) => (x.id === 'c' ? { ...x, lastOpenedAt: at(10) } : x))
    expect(ids(sortOrchestras(touched, 'recent'))).toEqual(['A', 'Z', 'M'])
  })

  it('Agent が動いた時刻（この端末で見ていたもの）も使った時刻に入れる', () => {
    expect(ids(sortOrchestras(ALL, 'recent', { agentActiveAt: { M: Date.parse(at(20)) } }))).toEqual(['M', 'Z', 'A'])
  })

  it('時刻の無いものは後ろ。同じ時刻・どれも時刻なしなら手動の順', () => {
    const none = [o('1'), o('2'), o('3')]
    expect(ids(sortOrchestras(none, 'recent'))).toEqual(['1', '2', '3'])
    const tie = [o('1', { lastOpenedAt: at(3) }), o('2'), o('3', { lastOpenedAt: at(3) })]
    expect(ids(sortOrchestras(tie, 'recent'))).toEqual(['1', '3', '2'])
    const sameName = [o('1', { name: 'Same' }), o('2', { name: 'same' })]
    expect(ids(sortOrchestras(sameName, 'name'))).toEqual(['1', '2'])
  })

  it('読めない時刻は時刻なしとして扱う', () => {
    const broken = [o('1', { lastOpenedAt: 'not a date' }), o('2', { lastOpenedAt: at(1) })]
    expect(ids(sortOrchestras(broken, 'recent'))).toEqual(['2', '1'])
  })

  it('オーケストラが無ければ空。プロジェクトは入れない', () => {
    expect(sortOrchestras([p('a'), p('b')], 'recent')).toEqual([])
    expect(sortOrchestras([], 'name')).toEqual([])
  })

  it('並べても元の配列を変えない', () => {
    const copy = [...ALL]
    sortOrchestras(ALL, 'name')
    expect(ALL).toEqual(copy)
  })
})

describe('サイドバーの木（オーケストラは手動・プロジェクトは最近使った順）', () => {
  const shown = sortProjects(ALL, 'recent')
  const rows = (orchestraOrder?: readonly Project[]) => treeRows(ALL, shown, new Set(), orchestraOrder).map((r) => [r.project.id, r.depth])

  it('オーケストラは手動の順のまま、各オーケストラの中の子は最近使った順', () => {
    expect(rows(sortOrchestras(ALL, 'manual'))).toEqual([['Z', 0], ['b', 1], ['a', 1], ['A', 0], ['d', 1], ['c', 1], ['M', 0], ['w', 0]])
  })

  it('オーケストラを名前順にしても、子の並びはプロジェクトの並び順のまま', () => {
    expect(rows(sortOrchestras(ALL, 'name'))).toEqual([['A', 0], ['d', 1], ['c', 1], ['M', 0], ['Z', 0], ['b', 1], ['a', 1], ['w', 0]])
  })

  it('並びを渡さなければ、これまでどおり全体の並び（手動）', () => {
    expect(rows()).toEqual(rows(sortOrchestras(ALL, 'manual')))
  })

  it('work は最近使ったばかりでも最後のまま', () => {
    expect(rows(sortOrchestras(ALL, 'recent')).at(-1)).toEqual(['w', 0])
  })

  it('並びにオーケストラでないものが混じっていても無視する', () => {
    expect(rows([...sortOrchestras(ALL, 'manual'), p('a')])).toEqual(rows())
  })
})

describe('保存した好み', () => {
  it('オーケストラの並び順の既定は手動。以前の保存（項目なし）も手動', () => {
    expect(DEFAULT_PROJECT_VIEW.orchestraSort).toBe('manual')
    expect(sanitizeProjectView({ sort: 'recent' })).toEqual({ sort: 'recent', orchestraSort: 'manual', starredOnly: false })
  })

  it('選べる値だけを残す（プロジェクト専用の「動いている順」「追加した順」はオーケストラには無い）', () => {
    for (const sort of ORCHESTRA_SORTS) expect(sanitizeProjectView({ orchestraSort: sort }).orchestraSort).toBe(sort)
    expect(sanitizeProjectView({ orchestraSort: 'active' }).orchestraSort).toBe('manual')
    expect(sanitizeProjectView({ orchestraSort: 'added' }).orchestraSort).toBe('manual')
    expect(sanitizeProjectView({ orchestraSort: 42 }).orchestraSort).toBe('manual')
  })

  it('プロジェクトとオーケストラの並び順は互いに独立して残る', () => {
    expect(sanitizeProjectView({ sort: 'recent', orchestraSort: 'name', starredOnly: true })).toEqual({ sort: 'recent', orchestraSort: 'name', starredOnly: true })
  })

  it('絞り込み（☆ のみ）は並び順の項目が無くても使える', () => {
    expect(ids(filterProjects([p('a', { starred: true }), p('b')], { starredOnly: true }))).toEqual(['a'])
  })
})

describe('最近使った順で数えないもの', () => {
  it('work・リサーチのフォルダ・アーカイブしたプロジェクトを使っても、オーケストラは上がらない', () => {
    const list = [o('X'), o('Y', { lastOpenedAt: at(3) }), p('w', { work: true, lastOpenedAt: at(30) }), p('r', { research: true, lastOpenedAt: at(30) }), p('z', { orchestraId: 'X', archived: true, lastOpenedAt: at(30) })]
    expect(ids(sortOrchestras(list, 'recent'))).toEqual(['Y', 'X'])
  })
})
