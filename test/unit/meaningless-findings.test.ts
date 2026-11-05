import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { buildDraft } from '../../src/main/pipeline/draft'
import { buildDraftDocument } from '../../src/main/pipeline/decompose'
import { assembleFromOrganized } from '../../src/main/pipeline/assemble'
import { appendTake } from '../../src/main/sessions/takes'
import type { SessionRecord } from '../../src/main/sessions/store'
import type { Material, OrganizeOutput, TranscriptSegment } from '../../src/main/pipeline/types'
import { setLocale } from '@shared/i18n'
import { events, frames, material, meta, transcript } from './fixtures'

vi.mock('electron', () => ({
  app: { getPath: () => join(tmpdir(), 'ferret-meaningless-unit'), getLocale: () => 'ja' },
  clipboard: {}, shell: {}, nativeImage: { createFromPath: () => ({ isEmpty: () => true }) }
}))

setLocale('ja')

const seg = (t0: number, t1: number, text: string): TranscriptSegment => ({ t0, t1, speaker: 'self', text, source: 'mic' })
const REASON = '意味の通じない発話（聞き取りの誤り・つなぎ言葉）'

/** fixtures の4区間に、離れた時刻の「Shh.」だけのまとまりを足す */
const withShh: Material = { ...material, transcript: [...transcript, seg(32_000, 33_000, 'Shh.')] }
/** 整理の出力が引いている発話だけの素材（出力に無い発話は、話したそのままの指摘として足される。assemble.ts の uncoveredSpeech） */
const onlySpoken = (m: Material, ts: number[]): Material => ({ ...m, transcript: m.transcript.filter((s) => ts.includes(s.t0)) })

describe('意味の通じない発話を指摘にしない（下書き）', () => {
  it('意味の無い発話だけで書き込みの無いまとまりは指摘にせず、除外した発話に入れる', () => {
    const { draft, document } = buildDraftDocument(withShh)
    expect(draft.items.some((d) => d.segments.some((s) => s.text === 'Shh.'))).toBe(false)
    expect(draft.meaningless?.map((s) => s.text)).toEqual(['Shh.'])
    expect(document.items.some((it) => it.title.includes('Shh'))).toBe(false)
    expect(document.items).toHaveLength(buildDraftDocument(material).document.items.length)
    expect(document.dropped).toEqual([{ t: 32_000, text: 'Shh.', reason: REASON }])
  })

  it('書き込みに添えた意味の無い発話は外し、書き込みだけの指摘（囲んだ要素の見出し・要望は空）にする', () => {
    // p3（18.2〜19.65s、「申し込む」ボタン）と重なる発話を「Thank you.」だけにする
    const m: Material = { ...material, transcript: [transcript[0]!, transcript[1]!, seg(18_000, 21_000, 'Thank you.'), transcript[3]!] }
    const { document } = buildDraftDocument(m)
    const pen = document.items.find((it) => it.annotationIds.includes('p3'))!
    expect(pen.quotes).toEqual([])
    expect(pen.request).toBe('')
    expect(pen.title).toBe('ペンで囲んだ箇所: “申し込む”')
    expect(document.dropped.map((d) => d.text)).toEqual(['Thank you.'])
  })

  it('意味のある発話と混ざったまとまりは、意味の無い発話だけを外す', () => {
    const m: Material = { ...material, transcript: [seg(2_000, 3_000, 'えーっと'), seg(3_500, 4_500, 'この見出しが小さいですね'), seg(5_000, 5_400, 'はい'), seg(5_500, 7_000, 'もう少し大きくしてください')] }
    const { draft, document } = buildDraftDocument(m)
    const first = draft.items.find((d) => d.origin === 'speech')!
    expect(first.segments.map((s) => s.text)).toEqual(['この見出しが小さいですね', 'もう少し大きくしてください'])
    expect(first.t).toBe(3_500)
    const item = document.items.find((it) => it.draftIds.includes(first.id))!
    expect(item.title).toBe('この見出しが小さいですね もう少し大きくしてください')
    expect(document.dropped.map((d) => d.text)).toEqual(['えーっと', 'はい'])
  })

  it('返事（「はい」「OK」）だけは、書き込みのあるまとまりなら残す', () => {
    const m: Material = { ...material, transcript: [seg(18_000, 19_000, 'はい'), seg(30_000, 30_500, 'OK')] }
    const { draft, document } = buildDraftDocument(m)
    expect(draft.items.find((d) => d.annotationIds.includes('p3'))!.segments.map((s) => s.text)).toEqual(['はい'])
    expect(document.dropped.map((d) => d.text)).toEqual(['OK'])
  })

  it('短くても指示になる発話は残す', () => {
    const m: Material = { ...material, events: [], transcript: [seg(2_000, 2_500, '消して'), seg(10_000, 10_500, 'Bigger'), seg(20_000, 20_500, 'No.')] }
    const { draft, document } = buildDraftDocument(m)
    expect(draft.items.map((d) => d.segments.map((s) => s.text).join())).toEqual(['消して', 'Bigger', 'No.'])
    expect(document.dropped).toEqual([])
  })

  it('意味の無い発話は、まとまり同士をつながない', () => {
    // 「Shh.」が無ければ 2 つのまとまりは 4 秒離れている
    const m: Material = { ...material, events: [], transcript: [seg(2_000, 3_000, 'ここを消して'), seg(4_500, 5_500, 'Shh.'), seg(7_000, 8_000, '色を赤に')] }
    expect(buildDraft(m).items.map((d) => d.segments.map((s) => s.text))).toEqual([['ここを消して'], ['色を赤に']])
  })
})

describe('意味の通じない発話を指摘にしない（整理の後）', () => {
  const base: OrganizeOutput['items'][number] = { title: '', request: '', status: 'decided', quotes: [], frame_times: [3_000], annotation_ids: [] }

  it('意味の無い引用だけの指摘は消し、除外した発話に入れる', () => {
    const doc = assembleFromOrganized(onlySpoken(withShh, [2_000, 32_000]), {
      items: [
        { ...base, title: '見出しが小さい', request: '見出しを大きくする', quotes: [{ speaker: 'self', t: 2_000, text: 'この見出しが小さいですね' }] },
        { ...base, title: 'Shh.', request: 'Shh.', quotes: [{ speaker: 'self', t: 32_000, text: 'Shh.' }] },
      ],
      dropped: [],
    })
    expect(doc.items.map((it) => it.title)).toEqual(['見出しが小さい'])
    expect(doc.dropped).toEqual([{ t: 32_000, text: 'Shh.', reason: REASON }])
  })

  it('書き込みのある指摘は残し、見出しを囲んだ要素・要望を空にする', () => {
    const doc = assembleFromOrganized(onlySpoken(withShh, [32_000]), {
      items: [{ ...base, title: 'Shh.', request: 'Shh.', quotes: [{ speaker: 'self', t: 32_000, text: 'Shh.' }], frame_times: [19_750], annotation_ids: ['p3'] }],
      dropped: [],
    })
    expect(doc.items).toHaveLength(1)
    expect(doc.items[0]!.title).toBe('ペンで囲んだ箇所: “申し込む”')
    expect(doc.items[0]!.request).toBe('')
    expect(doc.items[0]!.quotes).toEqual([])
    expect(doc.dropped.map((d) => d.text)).toEqual(['Shh.'])
  })

  it('意味のある引用と混ざった指摘は、意味の無い引用だけ外し、意味の無い見出しは引用から作り直す', () => {
    const doc = assembleFromOrganized({ ...withShh, transcript: [...withShh.transcript, seg(1_000, 1_800, 'えー')] }, {
      items: [{ ...base, title: 'えー', request: 'この見出しを大きくする', quotes: [{ speaker: 'self', t: 1_000, text: 'えー' }, { speaker: 'self', t: 2_000, text: 'この見出しが小さいですね' }] }],
      dropped: [{ t: 24_800, text: '表記がばらばらです', reason: '独り言' }],
    })
    expect(doc.items[0]!.title).toBe('この見出しが小さいですね')
    expect(doc.items[0]!.request).toBe('この見出しを大きくする')
    expect(doc.items[0]!.quotes.map((q) => q.text)).toEqual(['この見出しが小さいですね'])
    // 整理が除外したもの・外した引用・どこにも入っていない意味の無い発話（Shh.）が時刻順に並ぶ
    expect(doc.dropped.map((d) => [d.text, d.reason])).toEqual([['えー', REASON], ['表記がばらばらです', '独り言'], ['Shh.', REASON]])
  })

  it('整理が既に除外した発話は二重に入れない', () => {
    const doc = assembleFromOrganized(withShh, {
      items: [{ ...base, title: '見出しが小さい', request: '大きく', quotes: [{ speaker: 'self', t: 2_000, text: 'この見出しが小さいですね' }] }],
      dropped: [{ t: 32_000, text: 'Shh.', reason: 'つなぎ言葉' }],
    })
    expect(doc.dropped).toEqual([{ t: 32_000, text: 'Shh.', reason: 'つなぎ言葉' }])
  })
})

describe('除外した意味の無い発話を指摘に戻す', () => {
  let projectDir = ''
  beforeEach(async () => { projectDir = await mkdtemp(join(tmpdir(), 'ferret-meaningless-')) })
  afterEach(async () => { await rm(projectDir, { recursive: true, force: true }) })

  it('「発話を指摘に戻す」で要確認の指摘になり、除外した発話から消える', async () => {
    const { sessionPaths, saveSession } = await import('../../src/main/sessions')
    const paths = sessionPaths(projectDir, '20261002-104012', '.ferret')
    await mkdir(paths.dir, { recursive: true })
    const stage = buildDraftDocument(withShh)
    const record: SessionRecord = { version: 1, meta, transcript: withShh.transcript, removedDuplicates: [], frames, draft: stage.draft.items,
      originalDocument: stage.document, document: stage.document, edits: [], captureGaps: [] }
    await saveSession(paths, record)
    const { restoreDropped } = await import('../../src/main/review')
    const review = await restoreDropped(paths, 32_000)
    expect(review.document.dropped).toEqual([])
    const restored = review.document.items.find((it) => it.quotes.some((q) => q.text === 'Shh.'))
    expect(restored).toMatchObject({ status: 'needs_check', include: false })
  })

  it('追記した録画の意味の無い発話も、時刻をずらして除外した発話に足す', () => {
    const stage = buildDraftDocument(material)
    const record: SessionRecord = { version: 1, meta, transcript, removedDuplicates: [], frames, draft: stage.draft.items,
      originalDocument: stage.document, document: stage.document, edits: [], captureGaps: [] }
    const { record: next } = appendTake(record, events, {
      n: 2, startedAt: '2026-10-02T11:00:00+09:00', addedAt: '2026-10-02T11:01:00+09:00', durationMs: 20_000,
      transcript: [seg(3_000, 5_000, 'ロゴの余白が狭いです'), seg(10_000, 11_000, 'ご視聴ありがとうございました')],
      removedDuplicates: [], events: [{ t: 0, type: 'nav', url: 'http://localhost:3000/about', title: '会社概要' }],
      frames: [{ t: 4_000, path: '00001.jpeg' }], warnings: [],
    })
    const dropped = next.document.dropped
    expect(dropped.map((d) => d.text)).toEqual(['ご視聴ありがとうございました'])
    // 戻すときに文字起こしの区間と時刻で引けること
    expect(next.transcript.some((s) => s.t0 === dropped[0]!.t && s.text === dropped[0]!.text)).toBe(true)
    expect(next.originalDocument?.dropped).toEqual(dropped)
  })
})
