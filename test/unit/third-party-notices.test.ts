/**
 * THIRD_PARTY_NOTICES.md の Orca の表に、Orca 由来のコードを含むファイルが漏れなく載っているか。
 * 目印は先頭近くの `Orca由来:`（`Orca由来（MIT）:`・`Orca由来の考え方:` も同じ）のコメント。
 * 2026-11 の監査で、目印のある 106 ファイルのうち 66 しか載っていなかった（再発防止）。
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = resolve(__dirname, '../..')
const NOTICES = 'THIRD_PARTY_NOTICES.md'
/** 目印。「Orca由来の純粋関数」のようにテストが中身を説明するだけの書き方（コロンが無い）は数えない */
const ORCA_MARKER = /Orca由来[^:：\n]{0,12}[:：]/

function trackedFiles(): string[] {
  try {
    return execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).split('\0').filter(Boolean)
  } catch {
    return [] // git の無い複製
  }
}

function listedFiles(): Set<string> {
  const md = readFileSync(join(root, NOTICES), 'utf8')
  const start = md.indexOf('### Orca (MIT)')
  const end = md.indexOf('\n### ', start + 1)
  const section = md.slice(start, end === -1 ? undefined : end)
  return new Set([...section.matchAll(/^\| `([^`]+)` \|/gm)].map((m) => m[1]!))
}

describe('THIRD_PARTY_NOTICES.md の Orca の表', () => {
  const listed = listedFiles()

  it('目印の判定（コロン付きだけ）', () => {
    expect(ORCA_MARKER.test(' * Orca由来: ~/bench/orca/src/a.ts')).toBe(true)
    expect(ORCA_MARKER.test(' * Orca由来（MIT）: ~/bench/orca/src/a.ts')).toBe(true)
    expect(ORCA_MARKER.test(' * Orca由来の考え方: ~/bench/orca/src/a.ts')).toBe(true)
    expect(ORCA_MARKER.test(' * Orca由来：全角のコロン')).toBe(true)
    expect(ORCA_MARKER.test(' * Agent起動コマンドの組み立て（Orca由来の純粋関数）と')).toBe(false)
    expect(ORCA_MARKER.test(' * Orca と同じ割り当て（~/bench/orca/x.ts）')).toBe(false)
  })

  it('目印のあるファイルはすべて表に載っている', () => {
    const files = trackedFiles()
    if (files.length === 0) return
    const marked = files.filter((file) => {
      if (file === NOTICES || file === 'test/unit/third-party-notices.test.ts') return false
      const full = join(root, file)
      if (!existsSync(full)) return false
      return ORCA_MARKER.test(readFileSync(full, 'utf8'))
    })
    expect(marked.length).toBeGreaterThan(0)
    const missing = marked.filter((file) => !listed.has(file))
    expect(missing, `${NOTICES} の Orca の表に足す（ファイルと Orca の元のパス）`).toEqual([])
  })

  it('表に載っているファイルは残っていて、目印がある（消した・移したファイルを表に残さない）', () => {
    expect(listed.size).toBeGreaterThan(0)
    const stale = [...listed].filter((file) => {
      const full = join(root, file)
      return !existsSync(full) || !ORCA_MARKER.test(readFileSync(full, 'utf8'))
    })
    expect(stale).toEqual([])
  })
})
