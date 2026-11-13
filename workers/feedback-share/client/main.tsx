import { createRoot } from 'react-dom/client'
import { switchLocale } from '../../../src/shared/i18n'
import { App } from './App'
import { pageLocale } from './strings'
import '../../../src/renderer/styles/tokens.css'
import '../../../src/renderer/styles/ui.css'
import '../../../src/renderer/styles/feedback.css'
import './share.css'

/**
 * 共有リンクの相手の画面の入口。アプリの部品（FeedbackToolbar など）が使う window.ade を、ブラウザの中で足りる分だけ用意する:
 * 戻る・進む … ライブのページ（iframe）の履歴（App が navigate を入れる）、拡張機能の一覧 … 空、ほかの通知 … 何もしない
 */
type Shim = { platform: string; navigate?: (direction: 'back' | 'forward') => void; on: () => () => void; invoke: (channel: string) => Promise<unknown> }
const shim: Shim = {
  platform: /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent) ? 'darwin' : /Win/.test(navigator.platform || '') ? 'win32' : 'linux',
  on: () => () => {},
  invoke: async (channel: string) => {
    if (channel === 'browser:back') shim.navigate?.('back')
    if (channel === 'browser:forward') shim.navigate?.('forward')
    if (channel === 'browserExtensions:list') return []
    return undefined
  }
}
;(window as unknown as { ade: Shim }).ade = shim

document.documentElement.lang = pageLocale
const applyTheme = (dark: boolean) => { document.documentElement.dataset.theme = dark ? 'dark' : 'light' }
const query = window.matchMedia('(prefers-color-scheme: dark)')
applyTheme(query.matches)
query.addEventListener('change', (e) => applyTheme(e.matches))

// アプリの辞書は実行時に読む（src/shared/i18n。このまとめでは1本の JS に入っている）。読んでから描く
void switchLocale(pageLocale).then(() => createRoot(document.getElementById('root')!).render(<App />))
