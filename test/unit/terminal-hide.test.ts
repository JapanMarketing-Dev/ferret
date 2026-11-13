import { readFile } from 'node:fs/promises'
import { afterEach, describe, expect, it, vi } from 'vitest'

/**
 * ターミナルの欄を隠す・出す（右下の「ターミナルを閉じる」はファイルの欄と重なるので削除した代わり）。
 * 表示メニューの項目と Ctrl+`、ターミナルの見出しの中の「隠す」ボタン
 */
type Item = { label?: string; role?: string; accelerator?: string; click?: () => void; submenu?: Item[] }
const built = vi.hoisted(() => ({ template: [] as Item[] }))
vi.mock('electron', () => ({
  Menu: {
    buildFromTemplate: (template: Item[]) => { built.template = template; return {} },
    setApplicationMenu: () => undefined
  }
}))

const realPlatform = process.platform
afterEach(() => {
  Object.defineProperty(process, 'platform', { value: realPlatform })
  vi.resetModules()
})

const flatten = (items: Item[]): Item[] => items.flatMap((item) => [item, ...flatten(item.submenu ?? [])])
const read = (p: string) => readFile(new URL(`../../${p}`, import.meta.url), 'utf8')

describe('表示メニューの「ターミナルを隠す/表示」', () => {
  for (const platform of ['darwin', 'win32', 'linux'] as const) {
    it(`${platform}: Ctrl+\` で toggleTerminal を送る。ほかの項目とキーがぶつからない`, async () => {
      Object.defineProperty(process, 'platform', { value: platform })
      const { installMenu, TOGGLE_TERMINAL_ACCELERATOR } = await import('../../src/main/menu')
      const commands: string[] = []
      installMenu({ onOpenFolder: () => undefined, onCommand: (command) => commands.push(command) })
      expect(TOGGLE_TERMINAL_ACCELERATOR).toBe('Ctrl+`')
      const items = flatten(built.template)
      const hits = items.filter((item) => item.accelerator === TOGGLE_TERMINAL_ACCELERATOR)
      expect(hits).toHaveLength(1)
      hits[0]!.click!()
      expect(commands).toEqual(['toggleTerminal'])
      // 表示メニューの中にある（ウインドウを切り替える ⌘` は使わない）
      const view = built.template.find((menu) => menu.submenu?.includes(hits[0]!))
      expect(view?.submenu?.some((item) => item.role === 'togglefullscreen')).toBe(true)
      expect(items.some((item) => item.accelerator === 'CmdOrCtrl+`' || item.accelerator === 'Cmd+`')).toBe(false)
      // 同じキーを2つの項目に付けていない
      const keys = items.map((item) => item.accelerator).filter((key): key is string => !!key)
      expect(new Set(keys).size).toBe(keys.length)
    })
  }
})

describe('画面の側', () => {
  it('toggleTerminal で欄を出し入れし、見出しのボタンで隠す。右下に「閉じる」は出さない', async () => {
    const app = await read('src/renderer/App.tsx')
    expect(app).toContain("case 'toggleTerminal':\n          setTerminalPeek((v) => !v)")
    expect(app).toContain("onHide={mode === 'editor' ? hideTerminalPane : undefined}")
    expect(app).not.toContain('orchestra.hideTerminal')
    const pane = await read('src/renderer/components/TerminalPane.tsx')
    // ターミナルの見出し（terminal-tabs__actions）の中に置く。浮かせない
    const actions = pane.slice(pane.indexOf('<div className="terminal-tabs__actions">'))
    expect(actions.indexOf('data-testid="terminal-hide"')).toBeGreaterThan(0)
    expect(actions.indexOf('data-testid="terminal-hide"')).toBeLessThan(actions.indexOf('</div>'))
    expect(pane).toContain('SHORTCUTS.toggleTerminal()')
  })

  it('画面の表記は menu.ts と同じ Ctrl+`（macOS は ⌃`）', async () => {
    const { SHORTCUTS } = await import('../../src/renderer/lib/shortcut')
    vi.stubGlobal('window', { ade: { platform: 'darwin' } })
    expect(SHORTCUTS.toggleTerminal()).toBe('⌃`')
    vi.stubGlobal('window', { ade: { platform: 'win32' } })
    expect(SHORTCUTS.toggleTerminal()).toBe('Ctrl+`')
    vi.unstubAllGlobals()
  })
})
