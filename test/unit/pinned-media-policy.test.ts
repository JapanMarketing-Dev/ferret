import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * 裏で動く処理の非表示ウィンドウ（削った版の trimVideo.ts・mtg の取り込みの MeetingMedia）には、
 * 「いま開いているプロジェクト」で探す ade-media://review/<id>/… を渡さない。pinMedia（pinnedMedia.ts）の口を渡す。
 * 渡すと、処理の途中でプロジェクトを切り替えたときに動画が開けず失敗する（FERRET-2D の 0.8.16 の Windows）
 */
const root = join(__dirname, '../../src/main')
function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? files(path) : path.endsWith('.ts') ? [path] : []
  })
}

describe('裏の処理へ渡す動画の URL', () => {
  it('renderTrimmedVideo・new MeetingMedia には pinMedia の url だけを渡す', () => {
    const bad: string[] = []
    for (const file of files(root)) {
      const text = readFileSync(file, 'utf8')
      for (const m of text.matchAll(/(?:renderTrimmedVideo|new MeetingMedia)\(([^,)]*)/g)) {
        const arg = m[1]!.trim()
        if (file.endsWith('trimVideo.ts') && arg.startsWith('sourceUrl: string')) continue // 定義
        if (!/(^|\.)url$/.test(arg) || /videoUrl|takeVideoUrl|ade-media/.test(arg)) bad.push(`${file.replace(root, 'src/main')}: ${m[0]}`)
      }
    }
    expect(bad).toEqual([])
  })
})
