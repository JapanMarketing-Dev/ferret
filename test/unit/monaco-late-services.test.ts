import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

/**
 * FERRET-2J: TS / JSON の言語機能は、開いたときに Monaco の機能をまとめて後から読む（動的 import）。
 * サービスは最初のエディタを作った時点で固まるので、後から読むファイルだけが登録するサービス
 * （registerSingleton）があると「depends on UNKNOWN service」で落ちる。
 * monacoSetup.ts が最初から読むファイルだけで、すべてのサービスが登録されていることを確かめる。
 */
const root = path.resolve(__dirname, '../../node_modules/monaco-editor/esm/vs')
const setup = fs.readFileSync(path.resolve(__dirname, '../../src/renderer/editor/monacoSetup.ts'), 'utf8')

function entries(): string[] {
  return [...setup.matchAll(/(?:from|import) '(monaco-editor\/[^'?]+)'/g)].map((m) =>
    path.join(root, `${m[1].slice('monaco-editor/'.length)}.js`)
  )
}

function walk(starts: string[], followDynamic: boolean): Set<string> {
  const seen = new Set<string>()
  const stack = [...starts]
  while (stack.length > 0) {
    const file = stack.pop() as string
    if (seen.has(file) || !fs.existsSync(file)) continue
    seen.add(file)
    const text = fs.readFileSync(file, 'utf8')
    for (const m of text.matchAll(/(?:^|\n)\s*(?:import|export)\s[^;]*?['"](\.[^'"]+\.js)['"]/g)) {
      stack.push(path.resolve(path.dirname(file), m[1]))
    }
    if (followDynamic) {
      for (const m of text.matchAll(/import\(\s*['"](\.[^'"]+\.js)['"]\s*\)/g)) {
        stack.push(path.resolve(path.dirname(file), m[1]))
      }
    }
  }
  return seen
}

describe('monaco のサービス登録（FERRET-2J）', () => {
  const eager = walk(entries(), false)
  const all = walk(entries(), true)

  it('monacoSetup.ts の読み込み先がすべて存在する', () => {
    for (const file of entries()) expect(fs.existsSync(file), file).toBe(true)
  })

  it('動的 import で後から読むファイルがある（この検査が空回りしていない）', () => {
    expect(all.size).toBeGreaterThan(eager.size)
  })

  it('後から読むファイルだけが登録するサービスがない', () => {
    const late = [...all]
      .filter((file) => !eager.has(file))
      .filter((file) => /registerSingleton\(/.test(fs.readFileSync(file, 'utf8')))
      .map((file) => path.relative(root, file))
    expect(late).toEqual([])
  })

  it('CodeLens のキャッシュとアウトラインのサービスは最初から読む', () => {
    const rel = new Set([...eager].map((file) => path.relative(root, file)))
    expect(rel.has('editor/contrib/codelens/browser/codeLensCache.js')).toBe(true)
    expect(rel.has('editor/contrib/documentSymbols/browser/outlineModel.js')).toBe(true)
  })
})
