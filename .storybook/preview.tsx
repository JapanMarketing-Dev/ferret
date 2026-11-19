import type { Decorator, Preview } from '@storybook/react-vite'
import { installAdeStub } from '../src/renderer/design-system/adeStub'
import { getLocale, registerLocale, setLocale } from '@shared/i18n'
import { en } from '@shared/i18n/en'
import { ja } from '@shared/i18n/ja'
import { ToastProvider } from '../src/renderer/ui'
import '../src/renderer/styles/fonts.css'
import '../src/renderer/styles/tokens.css'
import '../src/renderer/styles/ui.css'
import '../src/renderer/styles/app.css'
import '../src/renderer/styles/review.css'
import '../src/renderer/design-system/stories.css'

// アプリでは preload が渡す window.ade を、ここでは手元の見本に差し替える（main にはつながない）
installAdeStub()
registerLocale('ja', ja)
registerLocale('en', en)

/** テーマ（ダーク既定・ライト）と言語をツールバーで切り替える。アプリと同じく data-theme と lang を html に書く */
const withAppShell: Decorator = (Story, context) => {
  const theme = context.globals.theme === 'light' ? 'light' : 'dark'
  const locale = context.globals.locale === 'en' ? 'en' : 'ja'
  document.documentElement.dataset.theme = theme
  document.documentElement.style.colorScheme = theme
  document.documentElement.lang = locale
  if (getLocale() !== locale) setLocale(locale)
  return (
    <ToastProvider>
      <Story />
    </ToastProvider>
  )
}

const preview: Preview = {
  decorators: [withAppShell],
  globalTypes: {
    theme: {
      description: 'テーマ',
      toolbar: { title: 'テーマ', icon: 'mirror', items: [{ value: 'dark', title: 'ダーク（既定）' }, { value: 'light', title: 'ライト' }], dynamicTitle: true }
    },
    locale: {
      description: '言語',
      toolbar: { title: '言語', icon: 'globe', items: [{ value: 'ja', title: '日本語' }, { value: 'en', title: 'English' }], dynamicTitle: true }
    }
  },
  initialGlobals: { theme: 'dark', locale: 'ja' },
  parameters: {
    layout: 'padded',
    controls: { expanded: true },
    options: { storySort: { order: ['はじめに', 'Foundations', 'Components', 'Screens'] } }
  }
}

export default preview
