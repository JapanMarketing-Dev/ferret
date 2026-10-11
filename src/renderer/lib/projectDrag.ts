import type { Project } from '@shared/types'

/**
 * サイドバーのプロジェクト（オーケストラ・サブフォルダのプロジェクトを含む）の行をドラッグするときのデータ。中身はプロジェクトの id。
 * サイドバーの中に落とせば並べ替え、ターミナルに落とせばそのフォルダのパスを入れる（TerminalPane.tsx）
 */
export const PROJECT_DRAG_TYPE = 'application/x-ferret-project'

export function hasProjectDrag(dataTransfer: DataTransfer | null | undefined): boolean {
  return !!dataTransfer && Array.from(dataTransfer.types ?? []).includes(PROJECT_DRAG_TYPE)
}

/** drop のときに、落としたプロジェクトのフォルダのパスを返す（SSH はリモートのフォルダ）。知らない id・読めないときは null */
export function droppedProjectPath(dataTransfer: DataTransfer, projects: readonly Project[]): string | null {
  if (!hasProjectDrag(dataTransfer)) return null
  const id = dataTransfer.getData(PROJECT_DRAG_TYPE)
  const project = projects.find((p) => p.id === id)
  if (!project) return null
  return project.source === 'ssh' && project.ssh ? project.ssh.path : project.folderPath
}
