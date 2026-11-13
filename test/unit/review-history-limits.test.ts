import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import * as history from '../../src/main/sessions/history'
import * as limits from '../../src/main/sessions/limits'

const dirs: string[] = []
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })))
})

async function project(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'acme-shop-'))
  dirs.push(dir)
  return dir
}

/** n 件のレビューのフォルダ（古い順に 20260101-000000, 20260101-000001 …） */
function ids(n: number): string[] {
  return Array.from({ length: n }, (_, i) => `20260101-${String(Math.floor(i / 3600)).padStart(2, '0')}${String(Math.floor(i / 60) % 60).padStart(2, '0')}${String(i % 60).padStart(2, '0')}`)
}

async function reviews(root: string, names: string[], files: Record<string, string> = {}): Promise<void> {
  for (const name of names) {
    const dir = join(root, '.ferret', 'reviews', name)
    await mkdir(dir, { recursive: true })
    for (const [file, body] of Object.entries(files)) await writeFile(join(dir, file), body)
  }
}

const LISTED = (limits as { HISTORY_LIMITS?: { listed: number } }).HISTORY_LIMITS?.listed ?? 500

describe('security-4 [10] レビューの一覧は件数・読む量・時間に上限がある', () => {
  it('security-4 [10] 上限より多いレビューがあっても、新しい順に上限までしか返さない', async () => {
    // 500 件を作ると遅いので、上限を小さくして同じ動きを確かめる（既定の上限は LISTED）
    const dir = await project()
    const names = ids(30)
    await reviews(dir, names)
    const list = (await history.listSessionsPage(dir, { ...limits.HISTORY_LIMITS, listed: 10 })).sessions
    expect(list).toHaveLength(10)
    expect(list.map((s) => s.id)).toEqual(names.slice(-10).reverse())
    expect(LISTED).toBe(500)
    expect((await history.listSessions(dir)).length).toBe(30)
  })

  it('security-4 [10] 打ち切ったことを truncated で返す。見る名前の数にも上限がある', async () => {
    const dir = await project()
    await reviews(dir, ids(30))
    const page = await history.listSessionsPage(dir, { ...limits.HISTORY_LIMITS, listed: 10 })
    expect(page.sessions).toHaveLength(10)
    expect(page.truncated).toBe(true)
    // 日時の形でない名前を大量に置かれても、見る数で止まる
    const noisy = await project()
    for (let i = 0; i < 40; i++) await mkdir(join(noisy, '.ferret', 'reviews', `junk-${i}`), { recursive: true })
    await reviews(noisy, ['20990101-000000'])
    const scanned = await history.listSessionsPage(noisy, { ...limits.HISTORY_LIMITS, scannedNames: 10 })
    expect(scanned.truncated).toBe(true)
  })

  it('security-4 [10] 要約の無い記録を組み立てる（session.json を解析する）のは1回の一覧で決めた数だけ。残りは軽い形', async () => {
    const dir = await project()
    await reviews(dir, ids(12), { 'session.json': JSON.stringify({ version: 1, pad: 'x'.repeat(1000) }) })
    const page = await history.listSessionsPage(dir, { ...limits.HISTORY_LIMITS, heavyBuilds: 3 })
    expect(page.sessions).toHaveLength(12)
    expect(page.sessions.filter((s) => s.pending)).toHaveLength(9)
  })

  it('security-4 [10] 読むバイト数の合計で止まる', async () => {
    const dir = await project()
    await reviews(dir, ids(10), { 'session.json': 'x'.repeat(64 * 1024) })
    const page = await history.listSessionsPage(dir, { ...limits.HISTORY_LIMITS, readBytes: 100 * 1024 })
    // 64KB の記録は1件しか組み立てられない
    expect(page.sessions.filter((s) => !s.pending).length).toBeLessThanOrEqual(1)
  })

  it('security-4 [10] 時間を使い切ったら、残りはファイルを読まない', async () => {
    const dir = await project()
    await reviews(dir, ids(5), { 'label.json': JSON.stringify({ name: 'n' }) })
    let clock = 0
    const page = await history.listSessionsPage(dir, { ...limits.HISTORY_LIMITS, budgetMs: 10 }, () => (clock += 6))
    expect(page.sessions.filter((s) => s.pending).length).toBeGreaterThanOrEqual(4)
  })

  it('security-4 [10] セットアップの確認は全部の履歴を読まず、新しい数件の名前だけを見る', async () => {
    const dir = await project()
    const names = ids(history.ACTIVITY_SCAN + 10)
    await reviews(dir, names)
    // いちばん古いものだけ送った印 → 見る範囲の外
    await writeFile(join(dir, '.ferret', 'reviews', names[0]!, 'label.json'), JSON.stringify({ sentAt: '2026-01-01T00:00:00Z' }))
    expect(await history.sessionActivity(dir)).toEqual({ recorded: true, sent: false })
    await writeFile(join(dir, '.ferret', 'reviews', names[names.length - 1]!, 'label.json'), JSON.stringify({ sentAt: '2026-01-02T00:00:00Z' }))
    expect(await history.sessionActivity(dir)).toEqual({ recorded: true, sent: true })
    expect(await history.sessionActivity(await project())).toEqual({ recorded: false, sent: false })
    const hook = await readFile(join(__dirname, '../../src/renderer/onboarding/useSetupChecklist.ts'), 'utf8')
    expect(hook).not.toContain("'review:list'")
    expect(hook).toContain("'review:activity'")
  })
})
