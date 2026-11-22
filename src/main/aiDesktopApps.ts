import { execFile } from 'node:child_process'
import { app } from 'electron'
import { t } from '@shared/i18n'
import { AI_DESKTOP_APPS, aiDesktopApp, aiDesktopAppsSupported, canOpenInAiApp, isAiDesktopAppId, macOpenArgs, type AiDesktopAppId } from '@shared/aiDesktopApps'
import type { Project } from '@shared/types'
import { UserFacingError } from '@shared/errors'

export interface AiDesktopAppDeps {
  platform: string
  /** URL スキームを開くアプリの名前（無ければ空文字。Electron の app.getApplicationNameForProtocol） */
  appNameForProtocol: (protocol: string) => string
  /** open コマンドを動かす（失敗したら reject） */
  runOpen: (args: string[]) => Promise<void>
}

const defaultDeps = (): AiDesktopAppDeps => ({
  platform: process.platform,
  appNameForProtocol: (protocol) => app.getApplicationNameForProtocol(protocol),
  runOpen: (args) => new Promise((resolve, reject) => {
    execFile('/usr/bin/open', args, { timeout: 15_000 }, (err) => (err ? reject(err) : resolve()))
  })
})

/** 入っている AI のデスクトップアプリ（macOS だけ。それ以外は空） */
export function installedAiApps(deps: AiDesktopAppDeps = defaultDeps()): AiDesktopAppId[] {
  if (!aiDesktopAppsSupported(deps.platform)) return []
  return AI_DESKTOP_APPS.filter((entry) => {
    try {
      return deps.appNameForProtocol(entry.protocol).trim().length > 0
    } catch {
      return false
    }
  }).map((entry) => entry.id)
}

/** 登録済みのプロジェクトのフォルダを AI のデスクトップアプリで開く。フォルダは renderer からではなく設定から取る */
export async function openProjectInAiApp(projects: readonly Project[], id: unknown, appId: unknown, deps: AiDesktopAppDeps = defaultDeps()): Promise<void> {
  if (!isAiDesktopAppId(appId)) throw new UserFacingError(t('errors.projectNotFound'))
  const target = aiDesktopApp(appId)
  const project = typeof id === 'string' ? projects.find((p) => p.id === id) : undefined
  if (!project || !canOpenInAiApp(project)) throw new UserFacingError(t('errors.projectNotFound'))
  if (!installedAiApps(deps).includes(appId)) throw new UserFacingError(t('errors.aiAppNotInstalled', { app: target.label }))
  const args = macOpenArgs(target, project.folderPath)
  if (!args) throw new UserFacingError(t('errors.aiAppOpenFailed', { app: target.label }))
  try {
    await deps.runOpen(args)
  } catch {
    throw new UserFacingError(t('errors.aiAppOpenFailed', { app: target.label }))
  }
}
