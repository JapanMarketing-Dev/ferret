import { readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * main で外部の応答の JSON を読むときは res.json() を使わず、boundedResponse の readJsonBody で読む。
 * res.json() は本文の途中の切断・時間切れ（SyntaxError でない）と JSON でない本文を区別できず、回線の都合を
 * 「応答の形の変化」として Sentry に送っていた（FERRET-23・FERRET-2K）。上限のバイト数も効かない。
 * 画面（ブラウザ）側で動く文字列の中のスクリプトだけは対象外
 */
const root = join(__dirname, '../../src/main')
// ブラウザの中で動くページのスクリプト（文字列）を持つファイル
const BROWSER_SCRIPT_FILES = new Set(['mobileRemotePage.ts'])
function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? files(path) : path.endsWith('.ts') ? [path] : []
  })
}

describe('応答の JSON の読み方', () => {
  it('src/main では .json() を呼ばない（readJsonBody を使う）', () => {
    const bad: string[] = []
    for (const file of files(root)) {
      if (BROWSER_SCRIPT_FILES.has(basename(file))) continue
      readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
        const code = line.replace(/\/\/.*$/, '')
        if (/^\s*(\/\*\*|\*)/.test(code)) return // コメントの行
        if (/\.json\(\s*\)/.test(code)) bad.push(`${file.replace(root, 'src/main')}:${i + 1}: ${line.trim()}`)
      })
    }
    expect(bad).toEqual([])
  })
})
