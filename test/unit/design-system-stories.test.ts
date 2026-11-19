import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Ferret 自身のデザインシステム（Storybook）が部品と離れないようにする。
 * src/renderer/ui の入口から出している部品は、どれかの story に必ず出てくる（足したら見本も足す）。
 * 画面を動かすテストではなく、ファイルを読むだけ（速い）。描けるかは `pnpm storybook:build` で見る
 */
const root = join(__dirname, '..', '..')
const storiesDir = join(root, 'src/renderer/design-system')

/** 見本にしない入口（画面を持たない仕組み・アプリ全体の外枠） */
const NOT_VISUAL = new Set(['ErrorBoundary', 'ToastProvider', 'setToastNoticeFallback', 'useToast', 'StepsArt'])

function uiExports(): string[] {
  const index = readFileSync(join(root, 'src/renderer/ui/index.ts'), 'utf8')
  const names: string[] = []
  for (const m of index.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const part of m[1]!.split(',')) {
      const name = part.trim()
      if (name && !name.startsWith('type ')) names.push(name)
    }
  }
  return names
}

function storiesText(): string {
  return readdirSync(storiesDir).filter((f) => f.endsWith('.stories.tsx')).map((f) => readFileSync(join(storiesDir, f), 'utf8')).join('\n')
}

describe('Ferret のデザインシステム（Storybook）', () => {
  it('ui の入口の部品は、どれも story に出てくる', () => {
    const text = storiesText()
    const missing = uiExports().filter((name) => !NOT_VISUAL.has(name) && !new RegExp(`<${name}[\\s/>]|component: ${name}\\b`).test(text))
    expect(missing).toEqual([])
  })

  it('入口の読み取りが空にならない（読み方が壊れたら気づく）', () => {
    expect(uiExports()).toContain('Button')
    expect(uiExports().length).toBeGreaterThan(10)
  })

  it('トークンの見本は tokens.css に無い名前を使わない', () => {
    const tokens = readFileSync(join(root, 'src/renderer/styles/tokens.css'), 'utf8')
    const foundations = readFileSync(join(storiesDir, 'Foundations.stories.tsx'), 'utf8')
    const used = [...new Set([...foundations.matchAll(/'(--[a-z0-9-]+)'/g)].map((m) => m[1]!))]
    expect(used.length).toBeGreaterThan(40)
    expect(used.filter((name) => !tokens.includes(`${name}:`))).toEqual([])
  })

  it('Storybook 自身の案内とお知らせは出さない設定になっている', () => {
    const main = readFileSync(join(root, '.storybook/main.ts'), 'utf8')
    expect(main).toContain('disableWhatsNewNotifications: true')
    expect(main).toContain('sidebarOnboardingChecklist: false')
  })
})
