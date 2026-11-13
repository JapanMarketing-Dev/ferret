/**
 * ショートカットの表記をOSごとに出し分ける。
 *
 * 割り当て自体は main の menu.ts が `CmdOrCtrl` で宣言しているので、
 * ここが作るのは「画面に出す文字」だけ。menu.ts と食い違わせないこと。
 *
 * macOS … 記号を詰めて並べる（⌘⇧M）
 * Windows / Linux … 単語を + でつなぐ（Ctrl+Shift+M）
 */

type Modifier = 'Mod' | 'Shift' | 'Alt' | 'Ctrl'

const MAC_SYMBOLS: Record<Modifier, string> = {
  Mod: '⌘',
  Shift: '⇧',
  Alt: '⌥',
  Ctrl: '⌃'
}

const OTHER_WORDS: Record<Modifier, string> = {
  Mod: 'Ctrl',
  Shift: 'Shift',
  Alt: 'Alt',
  Ctrl: 'Ctrl'
}

/** macOS だけ記号に置き換えるキー */
const MAC_KEYS: Record<string, string> = {
  Backspace: '⌫',
  Enter: '↩',
  Escape: '⎋',
  ArrowLeft: '←',
  ArrowRight: '→',
  ArrowUp: '↑',
  ArrowDown: '↓'
}

const OTHER_KEYS: Record<string, string> = {
  ArrowLeft: '←',
  ArrowRight: '→',
  ArrowUp: '↑',
  ArrowDown: '↓',
  Escape: 'Esc'
}

function isMac(): boolean {
  // window.ade が無い場面（部品見本の単体確認など）でも落ちないようにする
  return globalThis.window?.ade?.platform === 'darwin'
}

/**
 * 例: formatShortcut('Mod', 'Shift', 'M')
 *   macOS → '⌘⇧M' / Windows → 'Ctrl+Shift+M'
 */
export function formatShortcut(...parts: Array<Modifier | string>): string {
  const mac = isMac()
  const tokens = parts.map((part) => {
    if (part in MAC_SYMBOLS) {
      const modifier = part as Modifier
      return mac ? MAC_SYMBOLS[modifier] : OTHER_WORDS[modifier]
    }
    const table = mac ? MAC_KEYS : OTHER_KEYS
    return table[part] ?? part
  })
  return mac ? tokens.join('') : tokens.join('+')
}

/**
 * 画面で使うショートカット。menu.ts の accelerator と1対1で対応させる。
 * 文言を変えるときは menu.ts も一緒に直す。
 */
export const SHORTCUTS = {
  openFolder: () => formatShortcut('Mod', 'O'),
  toggleMode: () => formatShortcut('Mod', 'Shift', 'M'),
  toggleExplorer: () => formatShortcut('Mod', 'Shift', 'E'),
  quickOpen: () => formatShortcut('Mod', 'P'),
  saveFile: () => formatShortcut('Mod', 'S'),
  toggleViewport: () => formatShortcut('Mod', 'Shift', 'V'),
  focusUrl: () => formatShortcut('Mod', 'L'),
  reload: () => formatShortcut('Mod', 'R'),
  newTerminal: () => formatShortcut('Mod', 'T'),
  closeTerminal: () => formatShortcut('Mod', 'W'),
  /** menu.ts の TOGGLE_TERMINAL_ACCELERATOR（Ctrl+`。macOS も Control） */
  toggleTerminal: () => formatShortcut('Ctrl', '`')
} as const
