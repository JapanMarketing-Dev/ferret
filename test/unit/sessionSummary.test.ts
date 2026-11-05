import { mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { appendEvents, createSession, listSessions, saveSession, type SessionRecord } from '../../src/main/sessions/index'
import { SEARCH_TEXT_MAX, SUMMARY_VERSION, buildStoredSummary, parseStoredSummary, readFreshSummary } from '../../src/main/sessions/summary'
import { assembleFromOrganized } from '../../src/main/pipeline/assemble'
import { events, material } from './fixtures'

/**
 * 一覧用の要約（summary.json）。一覧を開くたびに session.json と events.jsonl を読まずに済ませる。
 */

// 整理の出力が引いている発話だけの素材（出力に無い発話は、話したそのままの指摘として足される。assemble.ts の uncoveredSpeech）
const spokenOnly = { ...material, transcript: [] }
const organized = {
  items: [
    {
      title: '見出しが小さい',
      request: '大きくする',
      status: 'decided' as const,
      quotes: [{ speaker: 'self' as const, t: 2_000, text: 'この見出しが小さいですね' }],
      frame_times: [3_000],
      annotation_ids: [] as string[]
    }
  ],
  dropped: []
}
const record = (): SessionRecord => ({
  version: 1, meta: material.meta, transcript: material.transcript, removedDuplicates: [], frames: material.frames,
  draft: [], document: assembleFromOrganized(spokenOnly, organized), edits: []
})

let project: string
beforeEach(async () => { project = await mkdtemp(join(tmpdir(), 'ade-summary-')) })
afterEach(async () => { await rm(project, { recursive: true, force: true }) })

describe('要約を作る', () => {
  it('タイトルは最初の（空でない）遷移のもの。件数・長さ・URL・検索用の本文が入る', () => {
    const s = buildStoredSummary(record(), [{ url: 'http://localhost:3000/', title: '' }, { url: 'http://localhost:3000/pricing', title: '料金' }])
    expect(s).toMatchObject({ version: SUMMARY_VERSION, startedAt: material.meta.startedAt, durationMs: 60_000, itemCount: 1, needsCheckCount: 0, targetUrl: 'http://localhost:3000/', title: '料金' })
    for (const text of ['料金', 'http://localhost:3000/pricing', '見出しが小さい', '大きくする', 'この見出しが小さいですね']) expect(s.searchText).toContain(text)
  })

  it('検索用の本文は上限で切る', () => {
    const long = 'あ'.repeat(SEARCH_TEXT_MAX * 2)
    expect(buildStoredSummary(record(), [{ url: 'http://x/', title: long }]).searchText).toHaveLength(SEARCH_TEXT_MAX)
  })

  it('形の合わない summary.json は使わない', () => {
    expect(parseStoredSummary({ version: 99, startedAt: 'x', durationMs: 1, itemCount: 0, needsCheckCount: 0 })).toBeNull()
    expect(parseStoredSummary({ version: 1, startedAt: 'x', durationMs: -1, itemCount: 0, needsCheckCount: 0 })).toBeNull()
    expect(parseStoredSummary('x')).toBeNull()
  })
})

describe('一覧は summary.json を読む', () => {
  async function saved() {
    const p = await createSession(project, new Date(2026, 9, 3, 10, 0, 0))
    await appendEvents(p, events)
    await saveSession(p, record())
    return p
  }

  it('session.json を保存すると summary.json も書かれる', async () => {
    const p = await saved()
    expect(existsSync(p.summaryJson)).toBe(true)
    expect(JSON.parse(await readFile(p.summaryJson, 'utf8'))).toMatchObject({ title: 'トップ', itemCount: 1 })
  })

  it('summary.json があれば、操作ログを読まずにそれを使う', async () => {
    const p = await saved()
    await rm(p.eventsJsonl)
    const stored = JSON.parse(await readFile(p.summaryJson, 'utf8'))
    await writeFile(p.summaryJson, JSON.stringify({ ...stored, title: '控えのタイトル' }))
    const [summary] = await listSessions(project)
    expect(summary?.title).toBe('控えのタイトル')
    expect(summary?.itemCount).toBe(1)
    expect(summary?.searchText).toContain('見出しが小さい')
  })

  it('summary.json が無い古いレビューは、その場で作って控える', async () => {
    const p = await saved()
    await rm(p.summaryJson)
    const [summary] = await listSessions(project)
    expect(summary?.title).toBe('トップ')
    expect(existsSync(p.summaryJson)).toBe(true)
  })

  it('session.json より古い summary.json は作り直す', async () => {
    const p = await saved()
    const stored = JSON.parse(await readFile(p.summaryJson, 'utf8'))
    await writeFile(p.summaryJson, JSON.stringify({ ...stored, title: '古い控え' }))
    const old = new Date(Date.now() - 60_000)
    await utimes(p.summaryJson, old, old)
    expect(await readFreshSummary(p)).toBeNull()
    const [summary] = await listSessions(project)
    expect(summary?.title).toBe('トップ')
  })

  it('付けた名前は label.json から読み、検索にも効く（summary.json を作り直さなくてよい）', async () => {
    const p = await saved()
    await writeFile(p.labelJson, JSON.stringify({ name: '料金ページの確認' }))
    const [summary] = await listSessions(project)
    expect(summary?.name).toBe('料金ページの確認')
    expect(summary?.searchText).toContain('料金ページの確認')
  })
})
