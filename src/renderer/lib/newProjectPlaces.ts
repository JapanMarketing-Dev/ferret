import type { Project } from '@shared/types'

/** 左サイドバーの「新しいプロジェクト」（NewProjectPanel.tsx）の小さな部品 */

/** パスに名前をつなぐ（Windows の \ と POSIX の / の両方） */
export function joinFolder(path: string, name: string, windows: boolean): string {
  const sep = windows && !path.startsWith('/') ? '\\' : '/'
  return path.endsWith('/') || path.endsWith('\\') ? `${path}${name}` : `${path}${sep}${name}`
}

/** 登録済みの SSH 接続（host とフォルダ。同じものは1つに） */
export function registeredSshConnections(projects: readonly Project[]): Array<{ host: string; path: string; name: string }> {
  const seen = new Set<string>()
  const out: Array<{ host: string; path: string; name: string }> = []
  for (const project of projects) {
    if (project.source !== 'ssh' || !project.ssh) continue
    const key = `${project.ssh.host}\n${project.ssh.path}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ host: project.ssh.host, path: project.ssh.path, name: project.name })
  }
  return out
}
