import { withoutScripts } from './textHelpers'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * docs のスクリーンショット（tools/docs/build-docs.mjs の shot()。撮り直すときは人が撮って置く）。
 * 書き出した全言語のページに「準備中」の枠が残っておらず、参照する画像が実在して軽いこと
 */
const DOCS = resolve(__dirname, '../../site/docs')
const pages = (dir: string): string[] =>
  readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? (f === 'assets' ? [] : pages(join(dir, f))) : f.endsWith('.html') ? [join(dir, f)] : []))
const all = pages(DOCS)

describe('site/docs のスクリーンショット', () => {
  it('どの言語のページにもスクリーンショット・動画の「準備中」の枠が無い', () => {
    const left = all.filter((p) => readFileSync(p, 'utf8').includes('docs-shot-slot')).map((p) => p.slice(DOCS.length + 1))
    expect(left).toEqual([])
  })

  it('どの言語のページにも「準備中」に当たる文言（coming soon・準備中・beta など）が無い', () => {
    // 各言語で「近日」「準備中」に当たる言い方（_site の clip.soon・shot の枠・soon() の見出しに使っていた訳）
    const WORDS = /coming soon|\bbeta\b|準備中|即将推出|준비 중|próximamente|bientôt disponible|folgt in Kürze|in arrivo|em breve|скоро появится|जल्द आ रहा है|segera hadir|sắp có|docs-callout-wip|docs-shot-slot/i
    const hits = all.flatMap((p) => {
      const body = withoutScripts(readFileSync(p, 'utf8'))
      const m = WORDS.exec(body)
      return m ? [`${p.slice(DOCS.length + 1)}: ${m[0]}`] : []
    })
    expect(hits).toEqual([])
  })

  it('shot の画像は実在し、説明（alt）が付き、500KB 未満', () => {
    const shots = new Map<string, number>()
    for (const p of all) {
      for (const m of readFileSync(p, 'utf8').matchAll(/<figure class="docs-shot" data-shot="([\w-]+)"><img src="((?:\.\.\/)?assets\/[\w-]+\.png)\?v=\w+"[^>]* alt="([^"]+)"/g)) {
        expect(existsSync(resolve(p, '..', m[2]!))).toBe(true)
        shots.set(m[1]!, (shots.get(m[1]!) ?? 0) + 1)
      }
    }
    expect([...shots.keys()].sort()).toEqual(['feedback-toolbar', 'findings', 'preview', 'url-presets', 'usage'])
    // 英語と訳の全言語のページに出る
    const langs = all.filter((p) => basename(p) === 'accounts.html').length
    for (const count of shots.values()) expect(count).toBe(langs)
    for (const name of shots.keys()) expect(statSync(join(DOCS, 'assets', `${name}.png`)).size).toBeLessThan(500 * 1024)
  })
})
