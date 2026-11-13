/**
 * 全体のフィードバックの帯（src/renderer/components/OrchestraDock.tsx）の並び
 */
import { describe, expect, it } from 'vitest'

describe('全体のフィードバックの帯（OrchestraDock）', () => {
  it('札が多くても画面の列は窓の幅のまま（列を固定し、帯と札の並びは縮められる）', async () => {
    const { readFile } = await import('node:fs/promises')
    const css = await readFile(new URL('../../src/renderer/styles/app.css', import.meta.url), 'utf8')
    const block = (selector: string) => new RegExp(`(^|\\n)${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\{([^}]*)\\}`).exec(css)?.[2] ?? ''
    expect(block('.shell')).toContain('grid-template-columns: minmax(0, 1fr)')
    expect(block('.round-dock')).toContain('min-width: 0')
    expect(block('.orchestra-dock')).toContain('min-width: 0')
    expect(css).toMatch(/\.orchestra-dock__groups,\n\.orchestra-dock__items \{[^}]*min-width: 0[^}]*overflow-x: auto/)
  })
})
