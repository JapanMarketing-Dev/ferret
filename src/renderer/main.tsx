import { createRoot } from 'react-dom/client'
import { App } from './App'
import { initTheme } from './lib/theme'
import { initLocale } from './lib/i18n'
import { initRendererCrashReporting } from './lib/telemetry'
import './styles/fonts.css'
import './styles/tokens.css'
import './styles/ui.css'
import './styles/app.css'
import './styles/gallery.css'
import './styles/shell.css'
import './styles/review.css'
import './styles/feedback.css'
import './styles/reviews.css'
import './styles/progress.css'
import '@xterm/xterm/css/xterm.css'

// OS差のある見た目（macOS の信号機ボタン分の余白）はクラスで切り替え、
// 分岐をCSS側に閉じ込める。
document.documentElement.classList.remove('platform-unknown')
document.documentElement.classList.add(`platform-${window.ade.platform}`)
// 配色（data-theme）は最初の描画より前に決める。ちらつかせないため
initTheme()
// クラッシュレポート。配布版で設定が ON のときだけ（main が判断する）
void initRendererCrashReporting()

// 画面の言語も最初の描画より前に決める（今の言語の辞書だけを読み込んでから描く）
void initLocale().then(() => {
  // StrictMode は使わない。effect が2回走るとPTYとWebContentsViewを
  // 二重に作ってしまい、開発時だけ挙動が変わるため。
  createRoot(document.getElementById('root') as HTMLElement).render(<App />)
})
