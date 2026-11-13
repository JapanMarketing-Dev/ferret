import { describe, expect, it, vi } from 'vitest'
import type { Project } from '@shared/types'
import { DEFAULT_PROJECT_VIEW, filterProjects, lastUsedAt, sanitizeProjectView, sortProjects } from '@shared/projectOrder'
import { sortByStatus } from '@shared/findingStatusFilter'
import { stepAmongVisible } from '@shared/reorder'

// settings.ts は保存先を決めるためだけに electron の app を読む。単体テストでは呼ばれない
vi.mock('electron', () => ({ app: { getPath: () => '/tmp/ade-unit' } }))
const { sanitize } = await import('../../src/main/settings')
const { markProjectOpened, newProject } = await import('../../src/main/projects')

const p = (id: string, patch: Partial<Project> = {}): Project => ({ id, name: id, folderPath: `/work/${id}`, urls: [], ...patch })
const names = (list: Project[]) => list.map((x) => x.id)

describe('プロジェクトの並び順', () => {
  const list = [
    p('beta', { addedAt: '2026-10-02T00:00:00Z', lastOpenedAt: '2026-10-03T00:00:00Z' }),
    p('Alpha', { addedAt: '2026-10-03T00:00:00Z', lastOpenedAt: '2026-10-01T00:00:00Z' }),
    p('old'), // 時刻の無い古いプロジェクト
    p('gamma10', { addedAt: '2026-10-01T00:00:00Z' }),
    p('gamma9', { addedAt: '2026-10-04T00:00:00Z' })
  ]

  it('手動は配列の順のまま', () => {
    expect(names(sortProjects(list, 'manual'))).toEqual(['beta', 'Alpha', 'old', 'gamma10', 'gamma9'])
  })

  it('名前順は大文字小文字を区別せず、数字は数として比べる', () => {
    expect(names(sortProjects(list, 'name'))).toEqual(['Alpha', 'beta', 'gamma9', 'gamma10', 'old'])
  })

  it('追加した順。時刻の無い古いものは前（手動の順）', () => {
    expect(names(sortProjects(list, 'added'))).toEqual(['old', 'gamma10', 'beta', 'Alpha', 'gamma9'])
  })

  it('最近使った順は、開いた時刻と Agent が動いた時刻の新しいほう', () => {
    const agentActiveAt = { gamma9: Date.parse('2026-10-05T00:00:00Z') }
    expect(lastUsedAt(list[4]!, { agentActiveAt })).toBe(Date.parse('2026-10-05T00:00:00Z'))
    expect(names(sortProjects(list, 'recent', { agentActiveAt }))).toEqual(['gamma9', 'beta', 'Alpha', 'old', 'gamma10'])
  })

  it('動いている順は 確認待ち → 作業中 → 終わった → それ以外（同じなら最近使った順）', () => {
    const activity = { old: 'done', gamma10: 'blocked', Alpha: 'working' } as const
    expect(names(sortProjects(list, 'active', { activity }))).toEqual(['gamma10', 'Alpha', 'old', 'beta', 'gamma9'])
  })

  it('☆ はどの並び順でも上にまとめ、その中も並び順に従う', () => {
    const starred = list.map((x) => (x.id === 'old' || x.id === 'gamma9' ? { ...x, starred: true as const } : x))
    expect(names(sortProjects(starred, 'manual'))).toEqual(['old', 'gamma9', 'beta', 'Alpha', 'gamma10'])
    expect(names(sortProjects(starred, 'name'))).toEqual(['gamma9', 'old', 'Alpha', 'beta', 'gamma10'])
  })

  it('「☆ のみ」で ☆ だけを出す', () => {
    const starred = [p('a', { starred: true }), p('b'), p('c', { starred: true })]
    expect(names(filterProjects(starred, { sort: 'manual', starredOnly: true }))).toEqual(['a', 'c'])
    expect(names(filterProjects(starred, DEFAULT_PROJECT_VIEW))).toEqual(['a', 'b', 'c'])
  })

  it('保存した並び順を読む。知らない値・壊れた形は既定', () => {
    expect(sanitizeProjectView({ sort: 'recent', starredOnly: true })).toEqual({ sort: 'recent', orchestraSort: 'manual', starredOnly: true })
    expect(sanitizeProjectView({ sort: 'size', starredOnly: 'yes' })).toEqual(DEFAULT_PROJECT_VIEW)
    expect(sanitizeProjectView(null)).toEqual(DEFAULT_PROJECT_VIEW)
  })

  it('並べ替えたあと（手動へ切り替え）の1つ上・下は、☆ の中・外のそれぞれの中で動く', () => {
    const shown = sortProjects([p('a'), p('b', { starred: true }), p('c')], 'manual')
    const ids = names(shown)
    const starredOf = (id: string) => !!shown.find((x) => x.id === id)?.starred
    const same = (id: string) => (other: string) => starredOf(other) === starredOf(id)
    expect(stepAmongVisible(ids, ids, 'a', -1, same('a'))).toBeNull()
    expect(stepAmongVisible(ids, ids, 'c', -1, same('c'))).toEqual(['b', 'c', 'a'])
  })
})

describe('☆ と時刻の保存（settings）', () => {
  it('☆ と時刻は残し、壊れた値は捨てる。古い設定はそのまま読める', () => {
    const s = sanitize({ projects: [
      { id: 'a', folderPath: '/work/a', starred: true, addedAt: '2026-10-01T00:00:00.000Z', lastOpenedAt: '2026-10-02T00:00:00.000Z' },
      { id: 'b', folderPath: '/work/b', starred: 'yes', addedAt: 'いつか', lastOpenedAt: 3 },
      { id: 'c', folderPath: '/work/c' }
    ] })
    expect(s.projects[0]).toMatchObject({ starred: true, addedAt: '2026-10-01T00:00:00.000Z', lastOpenedAt: '2026-10-02T00:00:00.000Z' })
    expect(s.projects[1]).not.toHaveProperty('starred')
    expect(s.projects[1]).not.toHaveProperty('addedAt')
    expect(s.projects[1]).not.toHaveProperty('lastOpenedAt')
    expect(names(s.projects)).toEqual(['a', 'b', 'c'])
  })

  it('追加したときと開いたときに時刻を残す', () => {
    const now = new Date('2026-10-04T01:02:03.000Z')
    expect(newProject('/work/x', 'x', now).addedAt).toBe('2026-10-04T01:02:03.000Z')
    const list = [p('a'), p('b')]
    expect(markProjectOpened(list, 'b', now)[1]!.lastOpenedAt).toBe('2026-10-04T01:02:03.000Z')
    expect(markProjectOpened(list, 'zzz', now)).toBe(list)
  })
})

describe('指摘の並び順: 進み具合の順', () => {
  it('未対応 → 対応中 → Agent からの確認 → 確認待ち → 完了。同じ中は今の並び', () => {
    const progress = { b: { status: 'done' as const }, c: { status: 'in_progress' as const }, e: { status: 'human_review' as const } }
    expect(sortByStatus(['a', 'b', 'c', 'd', 'e'], progress)).toEqual(['a', 'd', 'c', 'e', 'b'])
  })
})
