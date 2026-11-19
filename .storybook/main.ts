import { fileURLToPath } from 'node:url'
import type { StorybookConfig } from '@storybook/react-vite'

/**
 * Ferret のデザインシステム（Storybook）。画面の部品（src/renderer/ui）とトークン（styles/tokens.css）を、
 * 状態ごとに見られるようにする。Ferret の「デザインシステム」タブがそのまま埋め込む（既定の 6006 番）。
 * stories は src/renderer/design-system/ に置く。アプリのビルド（electron-vite）には入らない。
 */
const config: StorybookConfig = {
  stories: ['../src/renderer/design-system/**/*.stories.@(ts|tsx)'],
  addons: [],
  framework: { name: '@storybook/react-vite', options: {} },
  // Storybook 自身の案内（はじめにの一覧・新しい版のお知らせ）は出さない。見るのは部品だけ
  core: { disableTelemetry: true, disableWhatsNewNotifications: true },
  features: { sidebarOnboardingChecklist: false, menuOnboardingChecklist: false },
  async viteFinal(viteConfig) {
    viteConfig.resolve ??= {}
    viteConfig.resolve.alias = { ...(viteConfig.resolve.alias as Record<string, string> | undefined), '@shared': fileURLToPath(new URL('../src/shared', import.meta.url)) }
    return viteConfig
  }
}

export default config
