import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * main で、静的にも読んでいるモジュールを `import('x').then(({ a, b }) => …)` で分けて読まない（FERRET-2A）。
 * 配布版のビルド（Rollup）は、静的にも読まれているモジュールの動的 import を、その場の名前空間のオブジェクトに置き換える。
 * そのとき then の引数の分割代入で取り出す名前を「使われている」と数えず、ほかで使っていない export を消すことがある。
 * 0.8.6 で memoryAction・formatGb が消え、30秒ごとに「t is not a function」になった。
 * 静的に読んでいるなら静的に import する（分けて読む意味も無い）。ファイルを読むだけで、何も動かさない
 */

const root = resolve(__dirname, '../..')

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(join(root, dir))) {
    const p = `${dir}/${name}`
    if (statSync(join(root, p)).isDirectory()) walk(p, out)
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(p)
  }
  return out
}

/** import の指定を、拡張子なしのリポジトリからのパスにする（node: や外のパッケージは null） */
function resolveSpecifier(from: string, spec: string): string | null {
  let p: string
  if (spec.startsWith('@shared/')) p = `src/shared/${spec.slice('@shared/'.length)}`
  else if (spec.startsWith('.')) p = join(dirname(from), spec)
  else return null
  return p.replace(/\\/g, '/').replace(/\.tsx?$/, '').replace(/\/index$/, '')
}

const files = walk('src/main')
const sources = new Map(files.map((p) => [p, readFileSync(join(root, p), 'utf8')]))

/** main のどこかで静的に（型だけでなく）import しているモジュール */
const staticTargets = new Set<string>()
for (const [p, text] of sources) {
  for (const m of text.matchAll(/^import\s+(?!type\b)[^'"]*?from\s+['"]([^'"]+)['"]/gm)) {
    const target = resolveSpecifier(p, m[1])
    if (target) staticTargets.add(target)
  }
}

describe('main の動的 import', () => {
  it('静的にも読んでいるモジュールを、then の分割代入で取り出さない', () => {
    const hits: string[] = []
    for (const [p, text] of sources) {
      for (const m of text.matchAll(/import\(\s*['"]([^'"]+)['"]\s*\)\s*\.then\(\s*(?:async\s*)?\(\s*\{/g)) {
        const target = resolveSpecifier(p, m[1])
        if (target && staticTargets.has(target)) hits.push(`${p}: import('${m[1]}')`)
      }
    }
    expect(hits).toEqual([])
  })

  it('指定の読み方を確かめる', () => {
    expect(resolveSpecifier('src/main/index.ts', '@shared/browserMemory')).toBe('src/shared/browserMemory')
    expect(resolveSpecifier('src/main/index.ts', './browser')).toBe('src/main/browser')
    expect(resolveSpecifier('src/main/decision/a.ts', '../telemetry')).toBe('src/main/telemetry')
    expect(resolveSpecifier('src/main/index.ts', 'node:os')).toBeNull()
    expect(staticTargets.has('src/shared/browserMemory')).toBe(true)
  })
})
