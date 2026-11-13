import { delimiter as hostDelimiter } from 'node:path'

/**
 * 内蔵ターミナルに渡さない、Ferret を起動した側の環境変数（純粋な関数。単体テストの対象）。
 *
 * - 親の端末の名乗り（TERM_PROGRAM・GHOSTTY_*・WT_SESSION・TMUX など）: Ferret の中のシェルや TUI が、
 *   Ghostty や tmux の中で動いていると誤認して、その端末用の処理やキーの送り方に切り替わる（Orca #10613）
 * - Chromium の Crashpad の接続先: 中で起動した Electron / Chromium 製のアプリ（利用者が開発中のアプリなど）が
 *   Ferret の Crashpad につながる（Orca #19792）
 * - 開発起動の NODE_ENV: electron-vite の dev の値が、中で動かす npm run build などに漏れる（Orca #9057）
 * - AppImage の実行時の変数: zsh は ARGV0 を外部コマンドの名前に使うので arecord などが壊れる。PATH・LD_LIBRARY_PATH の
 *   AppImage の中のフォルダも外す（Orca #7022。~/bench/orca/src/main/pty/appimage-terminal-env.ts）
 */
const HOST_TERMINAL_KEYS = new Set([
  'TERM_PROGRAM', 'TERM_PROGRAM_VERSION', 'TERM_SESSION_ID', 'TERMINAL_EMULATOR',
  'ITERM_SESSION_ID', 'ITERM_PROFILE', 'LC_TERMINAL', 'LC_TERMINAL_VERSION',
  'WT_SESSION', 'WT_PROFILE_ID', 'KITTY_WINDOW_ID', 'KITTY_PID', 'KITTY_PUBLIC_KEY', 'KITTY_INSTALLATION_DIR',
  'ALACRITTY_SOCKET', 'ALACRITTY_LOG', 'ALACRITTY_WINDOW_ID', 'KONSOLE_VERSION', 'KONSOLE_DBUS_SESSION', 'KONSOLE_DBUS_WINDOW',
  'VTE_VERSION', 'TMUX', 'TMUX_PANE', 'STY',
  'CHROME_CRASHPAD_PIPE_NAME', 'NODE_ENV',
  'APPIMAGE', 'APPDIR', 'ARGV0', 'OWD', 'APPIMAGE_LIBRARY_PATH'
])
const HOST_TERMINAL_PREFIXES = ['GHOSTTY_', 'WEZTERM_', 'WARP_']

export function isHostTerminalEnv(key: string): boolean {
  return HOST_TERMINAL_KEYS.has(key) || HOST_TERMINAL_PREFIXES.some((prefix) => key.startsWith(prefix))
}

/** AppImage の中（APPDIR の下）を指す PATH・LD_LIBRARY_PATH の項目を外す。空になれば消す */
export function stripAppImagePaths(env: Record<string, string>, appDir: string | undefined, delimiter: string = hostDelimiter): void {
  const root = appDir?.trim().replace(/\/+$/, '') ?? ''
  if (!root.startsWith('/')) return
  for (const key of ['PATH', 'LD_LIBRARY_PATH']) {
    const value = env[key]
    if (value === undefined) continue
    const kept = value.split(delimiter).filter((entry) => {
      const normalized = entry.replace(/\/+$/, '')
      return normalized !== root && !normalized.startsWith(`${root}/`)
    })
    if (kept.length > 0) env[key] = kept.join(delimiter)
    else delete env[key]
  }
}

/**
 * Finder や Dock から起動した macOS のアプリには LANG が無く、中のシェルが UTF-8 を使わない
 * （日本語のファイル名が ? になる・git や Python が文字化けする）。どの言語の変数も無いときだけ補う（Orca と同じ値）
 */
export function defaultLocaleEnv(env: Record<string, string>, platform: NodeJS.Platform): Record<string, string> {
  if (platform !== 'darwin' || env.LANG || env.LC_ALL || env.LC_CTYPE) return {}
  return { LANG: 'en_US.UTF-8' }
}

/**
 * PATH の先頭にフォルダを足す（内蔵ブラウザの ferret-browser の CLI。src/main/browserAutomation.ts）。
 * Codex は shell_environment_policy.inherit = "core" などで独自の環境変数をコマンドに渡さないことがあるが、PATH は渡す。
 * Windows は大文字小文字の違う Path を1つにまとめて書く
 */
export function prependPathEntry(env: Record<string, string>, dir: string, platform: NodeJS.Platform = process.platform, delimiter: string = hostDelimiter): void {
  if (!dir) return
  const keys = platform === 'win32' ? Object.keys(env).filter((key) => key.toUpperCase() === 'PATH') : ['PATH'].filter((key) => key in env)
  const key = keys[0] ?? (platform === 'win32' ? 'Path' : 'PATH')
  const entries = [...new Set(keys.flatMap((k) => (env[k] ?? '').split(delimiter)))].filter((entry) => entry && entry !== dir)
  for (const extra of keys.slice(1)) delete env[extra]
  env[key] = [dir, ...entries].join(delimiter)
}
