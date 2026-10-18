import { describe, expect, it } from 'vitest'
import type { Project } from '@shared/types'
import type { BusinessSnapshot } from '@shared/business/ipc'
import { evidenceToast, latestResearchProject, researchProjects, ventureTabFor } from '../../src/renderer/lib/businessShell'

const project = (id: string, extra: Partial<Project> = {}): Project => ({ id, name: id, folderPath: `/tmp/${id}`, urls: [], ...extra }) as Project
const orchestra = project('all', { editorWorkspace: true, orchestrator: true, lastOpenedAt: '2026-10-17T10:00:00.000Z' })

describe('中央の先頭のタブ（ビジネス）', () => {
  const business = [{ projectId: 'biz' }]
  const all = [orchestra, project('dev'), project('biz'), project('res', { research: true }), project('ssh', { source: 'ssh', research: true })]

  it('ビジネスのフォルダは business。リサーチのフォルダはタブを出さない（上のモード切替で開く）', () => {
    expect(ventureTabFor(all, 'biz', business)).toBe('business')
    expect(ventureTabFor(all, 'res', business)).toBeNull()
  })

  it('ふつうの開発のプロジェクト・オーケストラ・SSH・未選択・知らない id は null', () => {
    expect(ventureTabFor(all, 'dev', business)).toBeNull()
    expect(ventureTabFor(all, 'all', [{ projectId: 'all' }])).toBeNull()
    expect(ventureTabFor(all, 'ssh', [{ projectId: 'ssh' }])).toBeNull()
    expect(ventureTabFor(all, null, business)).toBeNull()
    expect(ventureTabFor(all, 'gone', business)).toBeNull()
  })

  it('リサーチの印が先（同じフォルダに business.yaml があってもビジネスのタブは出さない）', () => {
    expect(ventureTabFor(all, 'res', [{ projectId: 'res' }])).toBeNull()
  })
})

describe('モードの「ビジネスリサーチ」に入ったとき開くフォルダ', () => {
  it('最後に開いたリサーチのフォルダ。日時が無い・壊れているものは後回し、どれにも無ければ並びの先頭', () => {
    const a = project('a', { research: true })
    const b = project('b', { research: true, lastOpenedAt: 'broken' })
    const c = project('c', { research: true, lastOpenedAt: '2026-10-01T00:00:00.000Z' })
    const d = project('d', { research: true, lastOpenedAt: '2026-10-05T00:00:00.000Z' })
    const dev = project('dev', { lastOpenedAt: '2026-10-18T00:00:00.000Z' })
    expect(latestResearchProject([a, b, c, d, dev])?.id).toBe('d')
    expect(latestResearchProject([a, b])?.id).toBe('a')
  })

  it('リサーチのフォルダが無い・SSH だけなら null（ふつうのプロジェクトやオーケストラは開かない）', () => {
    expect(latestResearchProject([])).toBeNull()
    expect(latestResearchProject([orchestra, project('dev')])).toBeNull()
    expect(latestResearchProject([project('s', { research: true, source: 'ssh', lastOpenedAt: '2026-10-05T00:00:00.000Z' })])).toBeNull()
  })
})

describe('モードの「ビジネスリサーチ」の上に並べるフォルダ', () => {
  it('research の印のものだけを、並びのまま出す（オーケストラ・SSH は出さない）', () => {
    const list = [project('b', { research: true }), orchestra, project('dev'), project('a', { research: true }), project('s', { research: true, source: 'ssh' })]
    expect(researchProjects(list).map((p) => p.id)).toEqual(['b', 'a'])
    expect(researchProjects([orchestra, project('dev')])).toEqual([])
    expect(researchProjects([])).toEqual([])
  })
})

describe('「証拠に追加」の知らせ', () => {
  const snapshot = (evidence: Array<{ id: string; readStatus: string }>) => ({ data: { evidence } }) as unknown as BusinessSnapshot

  it('原文を選んで追加したもの（読了）は成功として知らせる', () => {
    expect(evidenceToast({ id: 'E03', snapshot: snapshot([{ id: 'E03', readStatus: '読了' }]) })).toEqual({ tone: 'success', message: 'E03 を証拠に追加しました' })
  })

  it('選んだ文が無いもの（発見のみ）は、読了と見せずにそう知らせる', () => {
    const toast = evidenceToast({ id: 'E04', snapshot: snapshot([{ id: 'E04', readStatus: '発見のみ' }]) })
    expect(toast.tone).toBe('warning')
    expect(toast.message).toContain('発見のみ')
  })

  it('一覧に見当たらないときも、読了とは言わない', () => {
    expect(evidenceToast({ id: 'E09', snapshot: snapshot([]) }).tone).toBe('warning')
  })
})
