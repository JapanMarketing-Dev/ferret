/**
 * プロジェクトのフォルダを、AI のデスクトップアプリ（ChatGPT・Claude・Gemini）で開く（サイドバーのプロジェクトのメニュー）。
 * 2026-11-21 本人「chatgpt desktop appで開くとかの機能も入れて。claude , geminiも対象です。それでそのpjから開けるようにして」。
 *
 * 3つとも macOS のアプリがフォルダを受け取れる（Info.plist の CFBundleDocumentTypes で確かめた。2026-11）。
 * - ChatGPT（com.openai.codex）: Folder（public.folder）を開ける
 * - Claude（com.anthropic.claudefordesktop）: Folder（public.folder）を開ける
 * - Gemini（com.google.GeminiMacOS）: すべての項目（public.item）を受け取る
 * 入っているかは、各アプリが登録している URL スキームで調べる（codex:// ・ claude:// ・ googlegemini://）。
 * Windows / Linux のアプリはフォルダを渡して開く方法が決まっていないので、macOS だけで出す
 */

export const AI_DESKTOP_APP_IDS = ['chatgpt', 'claude', 'gemini'] as const
export type AiDesktopAppId = (typeof AI_DESKTOP_APP_IDS)[number]

export interface AiDesktopApp {
  id: AiDesktopAppId
  /** メニューに出す名前（製品名なので訳さない） */
  label: string
  /** macOS のアプリの bundle id（open -b で開く） */
  macBundleId: string
  /** 入っているかを調べる URL スキーム（app.getApplicationNameForProtocol） */
  protocol: string
}

export const AI_DESKTOP_APPS: readonly AiDesktopApp[] = [
  { id: 'chatgpt', label: 'ChatGPT', macBundleId: 'com.openai.codex', protocol: 'codex://' },
  { id: 'claude', label: 'Claude', macBundleId: 'com.anthropic.claudefordesktop', protocol: 'claude://' },
  { id: 'gemini', label: 'Gemini', macBundleId: 'com.google.GeminiMacOS', protocol: 'googlegemini://' }
]

export function isAiDesktopAppId(value: unknown): value is AiDesktopAppId {
  return typeof value === 'string' && (AI_DESKTOP_APP_IDS as readonly string[]).includes(value)
}

export function aiDesktopApp(id: AiDesktopAppId): AiDesktopApp {
  return AI_DESKTOP_APPS.find((app) => app.id === id)!
}

/** この OS で出せるか（macOS だけ） */
export function aiDesktopAppsSupported(platform: string): boolean {
  return platform === 'darwin'
}

/**
 * このプロジェクトで「〜で開く」を出すか。手元にフォルダがあるものだけ。
 * SSH（フォルダはリモート）と「すべてのプロダクト」（Ferret が持つ隠れたフォルダ）は出さない
 */
export function canOpenInAiApp(project: { source?: string; editorWorkspace?: true }): boolean {
  return project.source !== 'ssh' && !project.editorWorkspace
}

/** macOS で開くときの open の引数。絶対パスだけ渡す（- で始まる値をオプションとして読ませない）。渡せなければ null */
export function macOpenArgs(app: AiDesktopApp, folderPath: string): string[] | null {
  if (!folderPath.startsWith('/')) return null
  return ['-b', app.macBundleId, folderPath]
}
