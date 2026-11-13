import { shell, systemPreferences } from 'electron'
import type { MediaAccessStatus, PermissionKind, PermissionsState } from '@shared/onboarding'
import { openScreenSettings, screenAccess } from './recording/sources'

/**
 * 初回起動のセットアップの「許可」の手順。マイクと画面収録の OS の許可を読む／求める。
 * 求めるのは利用者がボタンを押したときだけ（起動や手順を開いただけでは確認を出さない）。
 *
 * Orca由来: ~/bench/orca/src/main/browser/browser-media-access.ts の hasSystemMediaAccess と
 *           ~/bench/orca/src/main/ipc/developer-permissions.ts の考え方（MIT）。
 * 許可が要るのは macOS だけ。Windows・Linux は常に granted を返す。
 */

function microphoneAccess(): MediaAccessStatus {
  if (process.platform !== 'darwin') return 'granted'
  try {
    return systemPreferences.getMediaAccessStatus('microphone')
  } catch {
    return 'unknown'
  }
}

export function permissionsState(): PermissionsState {
  return { microphone: microphoneAccess(), screen: screenAccess() }
}

export async function requestPermission(kind: PermissionKind): Promise<PermissionsState> {
  if (process.platform === 'darwin') {
    if (kind === 'microphone') {
      // 未確認なら OS の確認が出る。一度断ったものは出ないので、システム設定を開いて案内する
      if (microphoneAccess() === 'not-determined') await systemPreferences.askForMediaAccess('microphone').catch(() => false)
      else if (microphoneAccess() !== 'granted') await openMicrophoneSettings()
    } else if (kind === 'screen') {
      // 画面収録はアプリから確認を出せないので、システム設定の「画面収録」を開く
      await openScreenSettings()
    }
  }
  return permissionsState()
}

async function openMicrophoneSettings(): Promise<void> {
  await shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone')
}
