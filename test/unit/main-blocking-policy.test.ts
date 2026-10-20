import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: () => '/tmp/ade-unit', getAppPath: () => '/tmp/ade-unit', isPackaged: false } }))
vi.mock('../../src/main/telemetry', () => ({ reportMainError: vi.fn() }))

const { descendantsFromListing } = await import('../../src/main/terminal')

/**
 * main を止めない（FERRET-M・FERRET-21）。ファイルを読むだけで、何も動かさない。
 *   - 子プロセスを同期で起動しない（execFileSync・execSync・spawnSync）。起動直後にエージェントを何十個も立ち上げている最中などは
 *     ps 1回でも数秒かかり、その間ウインドウが固まる（0.7.6 の macOS：ターミナルを閉じたときの ps で 5963ms）
 *   - 同期のダイアログ（show*Sync）を使わない。閉じるまで main の全部が止まる
 * どうしても要るときは ALLOWED に理由と一緒に足す
 */

const root = resolve(__dirname, '../..')

/** 同期の子プロセスを使ってよいファイルと理由 */
const ALLOWED: Record<string, string> = {
  // dev 起動のときだけ、起動時に1回 release 名の commit を取る（配布版では呼ばない）
  'src/main/telemetry.ts': 'devGitHash'
}

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(join(root, dir))) {
    const p = `${dir}/${name}`
    if (statSync(join(root, p)).isDirectory()) walk(p, out)
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(p)
  }
  return out
}
const mainFiles = [...walk('src/main'), ...walk('src/shared')]

describe('main を止める同期の呼び出し', () => {
  it('子プロセスを同期で起動しない（許したファイルを除く）', () => {
    const hits = mainFiles.filter((p) => !(p in ALLOWED) && /\b(execFileSync|execSync|spawnSync)\s*\(/.test(readFileSync(join(root, p), 'utf8')))
    expect(hits).toEqual([])
  })

  it('許したファイルは、書いた理由の関数の中でだけ使う', () => {
    for (const [p, fn] of Object.entries(ALLOWED)) {
      const text = readFileSync(join(root, p), 'utf8')
      const uses = text.split('\n').filter((line) => /\b(execFileSync|execSync|spawnSync)\s*\(/.test(line))
      expect(uses.length).toBeLessThanOrEqual(1)
      expect(text).toContain(`function ${fn}(`)
    }
  })

  it('同期のダイアログを使わない', () => {
    const hits = mainFiles.filter((p) => /\bshow(MessageBox|OpenDialog|SaveDialog)Sync\s*\(/.test(readFileSync(join(root, p), 'utf8')))
    expect(hits).toEqual([])
  })
})

describe('ターミナルの子孫の列挙（ps の出力から）', () => {
  const listing = [
    '    1     0',
    '  100     1',
    '  200   100',
    '  201   100',
    '  300   200',
    '  999     1',
    'garbage line',
    ''
  ].join('\n')

  it('子・孫をすべて集め、ほかの木は含めない', () => {
    expect(descendantsFromListing(listing, 100, 4242).sort()).toEqual([200, 201, 300])
  })

  it('子孫が無ければ空', () => {
    expect(descendantsFromListing(listing, 300, 4242)).toEqual([])
    expect(descendantsFromListing('', 100, 4242)).toEqual([])
  })

  it('自分自身と init には触らない', () => {
    expect(descendantsFromListing('  4242   100\n  1   100\n  500   4242', 100, 4242)).toEqual([])
  })

  it('壊れた出力で輪になっても止まる', () => {
    expect(descendantsFromListing('  200   100\n  100   200', 100, 4242)).toEqual([200])
  })
})
