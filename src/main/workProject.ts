import { mkdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { Project } from '@shared/types'
import { findProjectByFolder, newProject } from './projects'

/**
 * Ferret が既定で用意するプロジェクト「work」。何でもない作業（ちょっと試す・使い捨ての調べもの）を、
 * どのプロジェクトにも入れずに ADE として頼めるフォルダ。
 *
 * - 置き場は配布版なら ~/Ferret/work（Finder・エクスプローラーから見つけやすい所）。開発版・E2E・--user-data-dir の起動は
 *   設定フォルダの下（<設定フォルダ>/work）にして、ふだん使う ~/Ferret に触れない
 * - git のリポジトリにはしない（ファイル・ターミナル・Agent・レビューは git の無いフォルダでも動く。git の欄は「git でない」と出るだけ）
 * - 隠すときはアーカイブにする（@shared/projectArchive。一覧に残るので、次の起動で足し直さない）。登録を外しても次の起動で戻る
 * - フォルダを消されても、起動時と開くときに作り直す
 */

export const WORK_PROJECT_NAME = 'work'

export function workFolderPath(where: { home: string; configDir: string; shared: boolean }): string {
  return where.shared ? join(where.home, 'Ferret', WORK_PROJECT_NAME) : join(where.configDir, WORK_PROJECT_NAME)
}

export function isWorkProject(p: Pick<Project, 'work'>): boolean {
  return p.work === true
}

/**
 * 一覧に work が無ければ足す（初めての起動と、以前の版からの更新で1回）。
 * - 印の付いたものがあればそのまま（アーカイブしてあっても、名前を変えてあっても、置き場を変えてあっても）
 * - 同じフォルダを利用者が自分で登録していれば、それに印を付ける
 * - 無ければ一覧の最後に足す（並びはサイドバーで work の欄に置かれる）
 * 変えなければ同じ配列を返す
 */
export function withWorkProject(projects: Project[], folder: string, id?: string, now?: Date): Project[] {
  if (projects.some(isWorkProject)) return projects
  const existing = findProjectByFolder(projects, folder)
  if (existing) return projects.map((p) => (p.id === existing.id ? { ...p, work: true as const } : p))
  const project = newProject(folder, id, now)
  return [...projects, { ...project, name: WORK_PROJECT_NAME, work: true as const }]
}

/**
 * フォルダが無ければ作る。作った・あったなら true。同じ名前のファイルがある・作れないなら false（例外は投げない。開く側がふつうのエラーを出す）
 */
export function ensureWorkFolder(folder: string): boolean {
  try {
    mkdirSync(folder, { recursive: true })
    return statSync(folder).isDirectory()
  } catch {
    return false
  }
}
