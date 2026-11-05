import { describe, expect, it } from 'vitest'
import { buildDraftDocument, refineWithLlm, decompose } from '../../src/main/pipeline/decompose'
import { MockRunner } from '../../src/main/pipeline/organize/runners/mock'
import { RunnerError } from '../../src/main/pipeline/organize/runner'
import { buildPayload, buildPrompt } from '../../src/main/pipeline/organize/prompt'
import { renderFeedbackMarkdown } from '../../src/main/pipeline/feedback'
import { material } from './fixtures'

const goodOutput = JSON.stringify({
  items: [
    {
      title: 'ボタンの色が薄い',
      request: '申し込むボタンの色を濃くする',
      status: 'decided',
      quote_ts: [18_000],
      frame_times: [19_750],
      annotation_ids: ['p3'],
    },
  ],
  dropped: [],
})

describe('パイプライン全体', () => {
  it('停止直後は下書きだけで一覧と feedback.md を作れる', () => {
    const stage = buildDraftDocument(material)
    expect(stage.document.items.length).toBeGreaterThan(0)
    expect(stage.document.organizedByLlm).toBe(false)
    expect(renderFeedbackMarkdown(stage.document, { locale: 'ja' })).toContain('# UIフィードバック（')
  })

  it('LLM が成功したら整理後の一覧に差し替える', async () => {
    const stage = buildDraftDocument(material)
    const runner = new MockRunner({ kind: 'raw', raw: goodOutput })
    const r = await refineWithLlm(material, stage, { runner, cwd: '/tmp' })

    expect(r.fellBack).toBe(false)
    expect(r.document.organizedByLlm).toBe(true)
    const organizedItem = r.document.items.find((it) => it.request === '申し込むボタンの色を濃くする')
    expect(organizedItem).toBeDefined()
    // 整理が書き漏らした発話（00:02・00:05・00:24）は消さず、話したそのままの指摘として残る
    const restored = r.document.items.filter((it) => it !== organizedItem)
    expect(restored.map((it) => it.quotes.map((q) => q.t))).toEqual([[2_000, 5_500], [24_800]])
    expect(restored.every((it) => it.include && it.status === 'decided')).toBe(true)
  })

  it('LLM が失敗したら下書きのまま使う（EXT-11）', async () => {
    const stage = buildDraftDocument(material)
    const runner = new MockRunner({ kind: 'error', error: new RunnerError('落ちた', 'exit') })
    const r = await refineWithLlm(material, stage, { runner, cwd: '/tmp' })

    expect(r.fellBack).toBe(true)
    expect(r.document).toBe(stage.document)
    expect(r.organize.ok).toBe(false)
  })

  it('LLM の出力がJSONでなければ下書きへフォールバックする', async () => {
    const stage = buildDraftDocument(material)
    const runner = new MockRunner({ kind: 'raw', raw: '{壊れたJSON' })
    const r = await refineWithLlm(material, stage, { runner, cwd: '/tmp' })
    expect(r.fellBack).toBe(true)
    expect(r.organize.ok).toBe(false)
  })

  it('LLM の出力が検証に通らなければ下書きへフォールバックする', async () => {
    const stage = buildDraftDocument(material)
    const bad = JSON.stringify({ items: [], dropped: [] })
    const runner = new MockRunner({ kind: 'raw', raw: bad })
    const r = await refineWithLlm(material, stage, { runner, cwd: '/tmp' })
    expect(r.fellBack).toBe(true)
  })

  it('タイムアウトしたら下書きへフォールバックする', async () => {
    const stage = buildDraftDocument(material)
    const runner = new MockRunner({ kind: 'hang' })
    const r = await refineWithLlm(material, stage, { runner, cwd: '/tmp', timeoutMs: 20 })
    expect(r.fellBack).toBe(true)
  })

  it('LLM 未設定なら下書きで完結する', async () => {
    const r = await decompose(material, undefined)
    expect(r.fellBack).toBe(true)
    expect(r.document.organizedByLlm).toBe(false)
  })

  it('runner にはセッションフォルダとタイムアウトとスキーマを渡す', async () => {
    const stage = buildDraftDocument(material)
    const runner = new MockRunner({ kind: 'raw', raw: goodOutput })
    await refineWithLlm(material, stage, { runner, cwd: '/session/dir', timeoutMs: 1234, model: 'haiku' })

    expect(runner.calls).toHaveLength(1)
    expect(runner.calls[0]!.cwd).toBe('/session/dir')
    expect(runner.calls[0]!.timeoutMs).toBe(1234)
    expect(runner.calls[0]!.model).toBe('haiku')
    expect(runner.calls[0]!.schema).toMatchObject({ type: 'object' })
  })
})

describe('LLMへの入力', () => {
  it('静止画の時刻一覧だけを渡し、画像のパスは渡さない', () => {
    const stage = buildDraftDocument(material)
    const payload = buildPayload(stage.organizeInput)
    expect(payload.frame_times).toEqual([0, 3_000, 13_200, 19_750, 25_400, 41_100])
    expect(JSON.stringify(payload)).not.toContain('work/')
  })

  it('文字起こし・画面遷移・クリック・書き込み・下書きを含める', () => {
    const stage = buildDraftDocument(material)
    const payload = buildPayload(stage.organizeInput)
    expect(payload.transcript).toHaveLength(4)
    expect(payload.screen.map((s) => s.title)).toEqual(['トップ', '料金'])
    expect(payload.clicks[0]).toMatchObject({ text: '料金', selector: 'a.nav-pricing' })
    expect(payload.annotations.map((a) => a.id)).toEqual(['p3', 'p9'])
    expect(payload.draft.length).toBe(stage.draft.items.length)
  })

  it('動かした・元に戻した書き込みは、最後の形だけを渡す（取り消し済みの ID を見せない）', () => {
    const events = [
      ...material.events,
      { t: 42_000, type: 'pen' as const, id: 'p10', replaces: 'p9', t_end: 42_300, bbox: [40, 10, 20, 20] as [number, number, number, number] },
      { t: 43_000, type: 'erase' as const, ids: ['p3'] },
    ]
    const stage = buildDraftDocument({ ...material, events })
    const payload = buildPayload(stage.organizeInput)
    expect(payload.annotations.map((a) => a.id)).toEqual(['p10'])
    expect(stage.draft.items.flatMap((i) => i.annotationIds)).toEqual(['p10'])
  })

  it('プロンプトに指示と入力JSONの両方が入る', () => {
    const stage = buildDraftDocument(material)
    const prompt = buildPrompt(stage.organizeInput, 'ja')
    expect(prompt).toContain('発話の意味を変えない。言っていない要望を足さない。')
    expect(prompt).toContain('"transcript"')
    expect(prompt).toContain('このボタンの色が薄いです')
  })

  it('プロンプトは画面の言語に合わせる（既定は英語。入力の発話はそのまま）', () => {
    const stage = buildDraftDocument(material)
    const prompt = buildPrompt(stage.organizeInput)
    expect(prompt).toContain('Do not change what was said.')
    expect(prompt).toContain('## Input')
    expect(prompt).toContain('このボタンの色が薄いです')
  })

  it('英語の条文では見出しと要望を英語で書かせる', () => {
    const stage = buildDraftDocument(material)
    expect(buildPrompt(stage.organizeInput, 'en')).toContain('Write title and request in English.')
  })
})
