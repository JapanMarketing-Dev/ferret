/**
 * オーケストラのフィードバックの記録の書き込み（src/main/feedbackLog.ts）と、プレイブックの雛形・指示文（src/main/orchestrator.ts・@shared/orchestrator）。
 * 一時フォルダに本当に書いて確かめる（画像の写し・段階ごとの追記・同時の書き込み・リンクを拒む・上書きしない）
 */
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { copyImage, ensureFeedbackFile, recordFeedbackMessage, recordReviewProgress, recordReviewSent, seedPlaybook } from '../../src/main/feedbackLog'
import { SubagentLinkError, syncOrchestrator } from '../../src/main/orchestrator'
import { FEEDBACK_LOG_PATH, MAX_FEEDBACK_IMAGE_BYTES, PLAYBOOK_PATH, findingKey, foldFeedback, parseFeedbackEvents } from '../../src/shared/feedbackLog'
import { renderOrchestratorGuide, renderSubagent } from '../../src/shared/orchestrator'
import { sendAgentRequestsTo } from '../../src/main/agentRequestSend'

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])
const REVIEW = '20261011-140000'

let root: string
let orchestra: string
let reviewDir: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'ferret-feedback-'))
  orchestra = join(root, 'orchestra')
  reviewDir = join(root, 'shop', '.ferret', 'reviews', REVIEW)
  await mkdir(orchestra, { recursive: true })
  await mkdir(join(reviewDir, 'after'), { recursive: true })
  await writeFile(join(reviewDir, '01.png'), PNG)
  await writeFile(join(reviewDir, 'after', 'i1.png'), PNG)
})
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

const item = (id = 'i1', images = ['./01.png']) => ({
  id, index: 1, title: 'Sign up button', request: 'Match the benchmark header', quotes: [{ speaker: 'self', text: 'too small' }],
  context: { url: 'http://localhost:3000/' }, images, annotationIds: ['p1']
})
const pens = [{ t: 1, type: 'pen', id: 'p1', t_end: 2, bbox: [10, 20, 30, 40], shape: 'rect', view: { w: 1280, h: 800 } }]

async function readLog(): Promise<{ jsonl: string; md: string }> {
  return {
    jsonl: await readFile(join(orchestra, 'feedback', 'log.jsonl'), 'utf8'),
    md: await readFile(join(orchestra, 'feedback', 'log.md'), 'utf8')
  }
}

describe('送った指摘を1組で記録する', () => {
  it('枠の描かれた画像を feedback/images に写し、枠の位置・文と一緒に log.jsonl と log.md に書く', async () => {
    const added = await recordReviewSent(orchestra, 'O', { projectId: 'proj', reviewId: REVIEW, reviewDir, items: [{ product: 'Shop', item: item() }], events: pens })
    expect(added).toHaveLength(1)
    const images = await readdir(join(orchestra, 'feedback', 'images'))
    expect(images).toEqual([`proj-${REVIEW}-i1-1.png`])
    expect(await readFile(join(orchestra, 'feedback', 'images', images[0]!))).toEqual(PNG)
    const { jsonl, md } = await readLog()
    const [event] = parseFeedbackEvents(jsonl)
    expect(event).toMatchObject({ type: 'finding', product: 'Shop', frames: [{ bbox: [10, 20, 30, 40], shape: 'rect', view: { w: 1280, h: 800 } }], images: [`images/proj-${REVIEW}-i1-1.png`] })
    expect(md).toContain('finding #1: Sign up button')
    expect(md).toContain(`(images/proj-${REVIEW}-i1-1.png)`)
  })

  it('消えた画像・形の違う名前（上へ出るパス）は写さず、写せなかった数として残す', async () => {
    await recordReviewSent(orchestra, 'O', { projectId: 'proj', reviewId: REVIEW, reviewDir, items: [{ product: 'Shop', item: item('i1', ['./02.png', '../../secret.png', './01.png']) }], events: [] })
    const [event] = parseFeedbackEvents((await readLog()).jsonl)
    expect(event).toMatchObject({ missingImages: 2, images: [`images/proj-${REVIEW}-i1-3.png`], frames: [] })
  })

  it('大きすぎる画像・リンクの画像は写さない', async () => {
    await writeFile(join(reviewDir, '05.png'), Buffer.alloc(MAX_FEEDBACK_IMAGE_BYTES + 1))
    await symlink(join(reviewDir, '01.png'), join(reviewDir, '06.png'))
    await recordReviewSent(orchestra, 'O', { projectId: 'proj', reviewId: REVIEW, reviewDir, items: [{ product: 'Shop', item: item('i1', ['./05.png', './06.png']) }], events: [] })
    const [event] = parseFeedbackEvents((await readLog()).jsonl)
    expect(event).toMatchObject({ missingImages: 2, images: [] })
  })

  it('送った指摘が無ければ何も書かない', async () => {
    expect(await recordReviewSent(orchestra, 'O', { projectId: 'proj', reviewId: REVIEW, reviewDir, items: [], events: [] })).toEqual([])
    await expect(readLog()).rejects.toThrow()
  })
})

describe('段階ごとに更新する（直した → 人の反応）', () => {
  it('直したら AFTER を回ごとの名前で写し、NG のあと直し直すと別の画像として残す', async () => {
    await recordReviewSent(orchestra, 'O', { projectId: 'proj', reviewId: REVIEW, reviewDir, items: [{ product: 'Shop', item: item() }], events: pens })
    await recordReviewProgress(orchestra, 'O', { projectId: 'proj', reviewId: REVIEW, reviewDir, progress: { i1: { status: 'human_review', note: 'bigger', after: 'after/i1.png' } } })
    // 同じ値をもう一度：何も足さない
    expect(await recordReviewProgress(orchestra, 'O', { projectId: 'proj', reviewId: REVIEW, reviewDir, progress: { i1: { status: 'human_review', note: 'bigger', after: 'after/i1.png' } } })).toEqual([])
    const ng = { at: '2026-10-11T06:00:00.000Z', verdict: 'ng' as const, text: 'use a pill like the benchmark' }
    await recordReviewProgress(orchestra, 'O', { projectId: 'proj', reviewId: REVIEW, reviewDir, progress: { i1: { status: 'in_progress', after: 'after/i1.png', queued: true, history: [ng] } } })
    await writeFile(join(reviewDir, 'after', 'i1.png'), Buffer.concat([PNG, Buffer.from([9])]))
    await recordReviewProgress(orchestra, 'O', { projectId: 'proj', reviewId: REVIEW, reviewDir, progress: { i1: { status: 'human_review', note: 'pill now', after: 'after/i1.png', history: [ng] } } })
    const images = (await readdir(join(orchestra, 'feedback', 'images'))).sort()
    expect(images).toEqual([`proj-${REVIEW}-i1-1.png`, `proj-${REVIEW}-i1-after-1.png`, `proj-${REVIEW}-i1-after-2.png`])
    // 前の AFTER は上書きしない
    expect(await readFile(join(orchestra, 'feedback', 'images', `proj-${REVIEW}-i1-after-1.png`))).toEqual(PNG)
    const { jsonl, md } = await readLog()
    const record = foldFeedback(parseFeedbackEvents(jsonl)).findings.get(findingKey('proj', REVIEW, 'i1'))!
    expect(record.timeline.map((s) => (s.kind === 'reaction' ? s.verdict : s.kind))).toEqual(['fix', 'ng', 'fix'])
    expect(md).toContain('human NG (rejected the fix): “use a pill like the benchmark”')
    expect(md).toContain('agent fixed again, waiting for the human')
  })

  it('AFTER の画像が無くても直したことは記録する（画像なしと書く）', async () => {
    await recordReviewSent(orchestra, 'O', { projectId: 'proj', reviewId: REVIEW, reviewDir, items: [{ product: 'Shop', item: item() }], events: [] })
    const added = await recordReviewProgress(orchestra, 'O', { projectId: 'proj', reviewId: REVIEW, reviewDir, progress: { i1: { status: 'human_review', after: 'after/missing.png' } } })
    expect(added).toEqual([expect.objectContaining({ type: 'fix', status: 'human_review' })])
    expect(added[0]).not.toHaveProperty('after')
    expect((await readLog()).md).toContain('no after screenshot')
  })

  it('人の反応が無い（判断の無い）値は直しだけ。記録していないレビューは何もしない', async () => {
    expect(await recordReviewProgress(orchestra, 'O', { projectId: 'proj', reviewId: REVIEW, reviewDir, progress: { i1: { status: 'human_review' } } })).toEqual([])
    await expect(readLog()).rejects.toThrow()
  })
})

describe('書き込みの安全', () => {
  it('同時に何件来ても行が混ざらず、全部残る（log.md も最後の状態）', async () => {
    await Promise.all(Array.from({ length: 25 }, (_, i) => recordFeedbackMessage(orchestra, 'O', { product: 'Shop', channel: 'text', text: `message ${i}` })))
    const { jsonl, md } = await readLog()
    expect(parseFeedbackEvents(jsonl)).toHaveLength(25)
    expect(jsonl.trim().split('\n')).toHaveLength(25)
    for (let i = 0; i < 25; i++) expect(md).toContain(`message ${i}\n`)
  })

  it('壊れた行が混ざった log.jsonl でも続けて足せる', async () => {
    await mkdir(join(orchestra, 'feedback'), { recursive: true })
    await writeFile(join(orchestra, 'feedback', 'log.jsonl'), '{"v":1,"type":"mess\nnot json\n')
    await recordFeedbackMessage(orchestra, 'O', { product: 'Shop', channel: 'answers', text: '- D1 → 1' })
    expect(parseFeedbackEvents((await readLog()).jsonl)).toHaveLength(1)
  })

  it('空の文は書かない', async () => {
    expect(await recordFeedbackMessage(orchestra, 'O', { product: 'Shop', channel: 'text', text: '   ' })).toEqual([])
    await expect(readLog()).rejects.toThrow()
  })

  it('feedback/ がリンクなら書かずに失敗する（別の場所を書き換えない）', async () => {
    const elsewhere = join(root, 'elsewhere')
    await mkdir(elsewhere)
    await symlink(elsewhere, join(orchestra, 'feedback'))
    await expect(recordFeedbackMessage(orchestra, 'O', { product: 'Shop', channel: 'text', text: 'hi' })).rejects.toBeInstanceOf(SubagentLinkError)
    expect(await readdir(elsewhere)).toEqual([])
  })

  it('オーケストラのフォルダが無い・書けないときは失敗を返すだけ（呼び出し側が記録だけして送信は続ける）', async () => {
    await writeFile(join(root, 'file'), 'x')
    await expect(recordFeedbackMessage(join(root, 'file'), 'O', { product: 'Shop', channel: 'text', text: 'hi' })).rejects.toThrow()
    // 失敗のあとも同じ列で次の書き込みは進む
    await recordFeedbackMessage(orchestra, 'O', { product: 'Shop', channel: 'text', text: 'after failure' })
    expect((await readLog()).md).toContain('after failure')
  })

  it('copyImage：同じ名前が既にあれば写したものとして扱う', async () => {
    await mkdir(join(orchestra, 'images'))
    expect(await copyImage(join(reviewDir, '01.png'), orchestra, 'images/a.png')).toBe(true)
    expect(await copyImage(join(reviewDir, '01.png'), orchestra, 'images/a.png')).toBe(true)
    expect(await copyImage(join(reviewDir, 'nope.png'), orchestra, 'images/b.png')).toBe(false)
    await writeFile(join(reviewDir, 'empty.png'), '')
    expect(await copyImage(join(reviewDir, 'empty.png'), orchestra, 'images/c.png')).toBe(false)
  })
})

describe('プレイブックの雛形', () => {
  it('無ければ作り、あれば決して上書きしない', async () => {
    expect(await seedPlaybook(orchestra, 'My orchestra')).toBe(true)
    const path = join(orchestra, 'feedback', 'playbook.md')
    expect(await readFile(path, 'utf8')).toContain('# Playbook — My orchestra')
    await writeFile(path, 'my lessons')
    expect(await seedPlaybook(orchestra, 'My orchestra')).toBe(false)
    expect(await readFile(path, 'utf8')).toBe('my lessons')
  })

  it('playbook.md がリンクなら作らずに失敗する', async () => {
    await mkdir(join(orchestra, 'feedback'))
    await symlink(join(root, 'target.md'), join(orchestra, 'feedback', 'playbook.md'))
    await expect(seedPlaybook(orchestra, 'O')).rejects.toBeInstanceOf(SubagentLinkError)
  })

  it('オーケストラを合わせると雛形を作り、2回目以降・利用者の書いたものは上書きしない。やめたときは作らない', async () => {
    await syncOrchestrator(orchestra, [], true, [], 'en', undefined, 'Shop group')
    const path = join(orchestra, 'feedback', 'playbook.md')
    expect(await readFile(path, 'utf8')).toContain('# Playbook — Shop group')
    await writeFile(path, 'edited by agent')
    await syncOrchestrator(orchestra, [], true, [], 'en', undefined, 'Shop group')
    expect(await readFile(path, 'utf8')).toBe('edited by agent')
    const other = join(root, 'off')
    await mkdir(other)
    await syncOrchestrator(other, [], false)
    await expect(readFile(join(other, 'feedback', 'playbook.md'), 'utf8')).rejects.toThrow()
  })

  it('feedback がリンクでも、オーケストラのほかの同期は続ける', async () => {
    await mkdir(join(root, 'x'))
    await symlink(join(root, 'x'), join(orchestra, 'feedback'))
    await expect(syncOrchestrator(orchestra, [], true)).resolves.toBeDefined()
    expect(await readdir(join(root, 'x'))).toEqual([])
  })

  it('画面から開く前に用意する：記録は空の log.md、プレイブックは雛形。相対パスを返す', async () => {
    expect(await ensureFeedbackFile(orchestra, 'O', 'log')).toBe(FEEDBACK_LOG_PATH)
    expect(await readFile(join(orchestra, FEEDBACK_LOG_PATH), 'utf8')).toContain('(No feedback recorded yet.)')
    expect(await ensureFeedbackFile(orchestra, 'O', 'playbook')).toBe(PLAYBOOK_PATH)
    expect(await readFile(join(orchestra, PLAYBOOK_PATH), 'utf8')).toContain('# Playbook — O')
    // 既にある log.md は書き直さない
    await writeFile(join(orchestra, FEEDBACK_LOG_PATH), 'kept')
    await ensureFeedbackFile(orchestra, 'O', 'log')
    expect(await readFile(join(orchestra, FEEDBACK_LOG_PATH), 'utf8')).toBe('kept')
  })
})

describe('指示文（全体の CLAUDE.md と subagent）', () => {
  it('全体：プレイブックを読む・記録から学ぶ（NG の組を特に）・人は枠、Agent はテスター・具体的に頼む', () => {
    const guide = renderOrchestratorGuide([])
    for (const word of ['feedback/playbook.md', 'feedback/log.md', 'feedback/images/', 'learn most from these pairs', 'what the agent got wrong', 'the human sets the critical frame', 'benchmark products', 'concrete gaps with evidence', 'ask the human only about frame-level decisions', 'Requests must be specific', 'acceptance criteria']) expect(guide).toContain(word)
  })
  it('subagent：オーケストラのフォルダの絶対パスでプレイブックを指す。分からなければ言い方で', () => {
    const child = { dir: 'shop', path: '/w/shop', name: 'Shop', agent: 'ferret-shop' }
    const withFolder = renderSubagent({ ...child, orchestraFolder: '/w' })
    expect(withFolder).toContain('`/w/feedback/playbook.md`')
    expect(withFolder).toContain('learn most from the fixes the human rejected or corrected')
    expect(withFolder).toContain('acceptance criteria')
    expect(renderSubagent(child)).toContain("the orchestra folder's feedback/playbook.md")
  })
})

describe('依頼の送信と記録', () => {
  const base = { ids: ['human-checklist'], prefs: undefined, lang: 'en' as const, project: { editorWorkspace: true as const }, folder: '/o' }
  it('送れたら送った依頼を渡す。記録が投げても送信の結果は変えない', async () => {
    const seen: string[] = []
    const result = await sendAgentRequestsTo({
      resolveTarget: async () => 't', send: async () => ({ ok: true, message: 'sent' }), noAgentMessage: '',
      onSent: (picked) => { seen.push(...picked.map((p) => p.id)); throw new Error('disk full') }
    }, base)
    expect(result).toEqual({ ok: true, message: 'sent' })
    expect(seen).toEqual(['human-checklist'])
  })
  it('送れなかった・Agent が居ないときは記録しない', async () => {
    let called = 0
    await sendAgentRequestsTo({ resolveTarget: async () => 't', send: async () => ({ ok: false, message: 'x' }), noAgentMessage: '', onSent: () => { called++ } }, base)
    await sendAgentRequestsTo({ resolveTarget: async () => null, send: async () => ({ ok: true, message: 'x' }), noAgentMessage: '', onSent: () => { called++ } }, base)
    expect(called).toBe(0)
  })
})
