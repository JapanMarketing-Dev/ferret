import { describe, expect, it } from 'vitest'
import { PROJECT_DRAG_TYPE, droppedProjectPath, hasProjectDrag } from '../../src/renderer/lib/projectDrag'
import type { Project } from '../../src/shared/types'

/** サイドバーのプロジェクトの行をターミナルへ落としたときのパス（src/renderer/lib/projectDrag.ts） */

function transfer(data: Record<string, string>): DataTransfer {
  return { types: Object.keys(data), getData: (type: string) => data[type] ?? '' } as unknown as DataTransfer
}

const projects = [
  { id: 'a', name: 'A', folderPath: '/work/a' },
  { id: 'o', name: 'O', folderPath: '/work', orchestrator: true },
  { id: 's', name: 'S', folderPath: '/local/reviews/s', source: 'ssh', ssh: { host: 'box', path: '/srv/app' } }
] as unknown as Project[]

describe('projectDrag', () => {
  it('プロジェクトのドラッグだけを見分ける', () => {
    expect(hasProjectDrag(transfer({ [PROJECT_DRAG_TYPE]: 'a' }))).toBe(true)
    expect(hasProjectDrag(transfer({ 'text/plain': 'a' }))).toBe(false)
    expect(hasProjectDrag(null)).toBe(false)
  })

  it('プロジェクト・オーケストラはフォルダの絶対パス、SSH はリモートのフォルダ', () => {
    expect(droppedProjectPath(transfer({ [PROJECT_DRAG_TYPE]: 'a' }), projects)).toBe('/work/a')
    expect(droppedProjectPath(transfer({ [PROJECT_DRAG_TYPE]: 'o' }), projects)).toBe('/work')
    expect(droppedProjectPath(transfer({ [PROJECT_DRAG_TYPE]: 's' }), projects)).toBe('/srv/app')
  })

  it('知らない id・空・別の種類のドラッグは null（何も入れない）', () => {
    expect(droppedProjectPath(transfer({ [PROJECT_DRAG_TYPE]: 'zzz' }), projects)).toBeNull()
    expect(droppedProjectPath(transfer({ [PROJECT_DRAG_TYPE]: '' }), projects)).toBeNull()
    expect(droppedProjectPath(transfer({ 'text/plain': '/etc' }), projects)).toBeNull()
  })
})
