import { describe, expect, it } from 'vitest'
import { assembleFromOrganized, uncoveredSpeech } from '../../src/main/pipeline/assemble'
import { buildDraftDocument } from '../../src/main/pipeline/decompose'
import { buildDraft } from '../../src/main/pipeline/draft'
import { validateOrganizeOutput } from '../../src/main/pipeline/organize/validate'
import type { Material, OrganizeOutput, TranscriptSegment } from '../../src/main/pipeline/types'
import { material } from './fixtures'
import { setLocale } from '@shared/i18n'

setLocale('ja')

/*
 * 整理（LLM）が発話を書き漏らしても、話した内容は指摘の一覧から消えない。
 * これまでは、整理の出力のどの指摘にも「除外した発話」にも入らなかった発話は、確認画面のどこにも出ず取り戻せなかった
 */
const seg = (t0: number, text: string): TranscriptSegment => ({ t0, t1: t0 + 1_500, speaker: 'self', text, source: 'mic' })
const item = (t: number, text: string, extra: Partial<OrganizeOutput['items'][number]> = {}): OrganizeOutput['items'][number] =>
  ({ title: text, request: text, status: 'decided', quotes: [{ speaker: 'self', t, text }], frame_times: [], annotation_ids: [], ...extra })

describe('整理が書き漏らした発話を指摘に戻す', () => {
  it('整理の出力が一部の発話しか引いていなくても、残りは話したそのままの指摘になる', () => {
    const doc = assembleFromOrganized(material, { items: [item(18_000, 'このボタンの色が薄いです')], dropped: [] })
    const times = doc.items.map((it) => it.quotes.map((q) => q.t))
    expect(times).toEqual([[2_000, 5_500], [18_000], [24_800]])
    const restored = doc.items.filter((it) => it.id.startsWith('i-missed-'))
    expect(restored.map((it) => it.request)).toEqual(['この見出しが小さいですね もう少し大きくしてください', '表記がばらばらです'])
    expect(restored.every((it) => it.include && it.status === 'decided')).toBe(true)
    // 番号は時刻順に振り直す
    expect(doc.items.map((it) => it.index)).toEqual([1, 2, 3])
  })

  it('整理が指摘を1件も返さなくても（空の出力）、発話は全部残る', () => {
    const doc = assembleFromOrganized(material, { items: [], dropped: [] })
    expect(doc.items.flatMap((it) => it.quotes.map((q) => q.t))).toEqual([2_000, 5_500, 18_000, 24_800])
  })

  it('整理が理由を付けて除外した発話は、指摘に戻さない（除外した発話に残る）', () => {
    const doc = assembleFromOrganized(material, {
      items: [item(18_000, 'このボタンの色が薄いです')],
      dropped: [{ t: 2_000, text: 'この見出しが小さいですね', reason: '雑談' }, { t: 5_500, text: 'もう少し大きくしてください', reason: '雑談' }, { t: 24_800, text: '表記がばらばらです', reason: '重複' }]
    })
    expect(doc.items).toHaveLength(1)
    expect(doc.dropped.map((d) => d.t)).toEqual([2_000, 5_500, 24_800])
  })

  it('全部の発話を引いていれば、何も足さない', () => {
    const doc = assembleFromOrganized(material, {
      items: [item(2_000, 'この見出しが小さいですね', { quotes: [{ speaker: 'self', t: 2_000, text: 'この見出しが小さいですね' }, { speaker: 'self', t: 5_500, text: 'もう少し大きくしてください' }] }),
        item(18_000, 'このボタンの色が薄いです'), item(24_800, '表記がばらばらです')],
      dropped: []
    })
    expect(doc.items.some((it) => it.id.startsWith('i-missed-'))).toBe(false)
    expect(doc.items).toHaveLength(3)
  })

  it('書き漏らした発話が意味の通じないものなら、指摘にせず除外した発話へ入れる', () => {
    const m: Material = { ...material, transcript: [seg(2_000, 'ここを赤に'), seg(10_000, 'Thank you.')] }
    const doc = assembleFromOrganized(m, { items: [item(2_000, 'ここを赤に')], dropped: [] })
    expect(doc.items).toHaveLength(1)
    expect(doc.dropped.map((d) => d.text)).toEqual(['Thank you.'])
  })

  it('書き漏らした発話に、整理が使った書き込みを付け直さない（同じ印の指摘を二重に作らない）', () => {
    const doc = assembleFromOrganized(material, { items: [item(18_000, 'このボタンの色が薄いです', { annotation_ids: ['p3'] })], dropped: [] })
    const withPen = doc.items.filter((it) => it.annotationIds.includes('p3'))
    expect(withPen).toHaveLength(1)
  })

  it('文字起こしが空なら何も足さない', () => {
    expect(uncoveredSpeech({ ...material, transcript: [] }, { items: [], dropped: [] })).toEqual({ items: [], meaningless: [] })
  })

  it('検証（時刻の寄せ）を通った出力でも、ずれた引用の時刻で発話を二重にしない', () => {
    const input = buildDraftDocument(material).organizeInput
    // 引用の時刻が文字起こしと 300ms ずれている（検証が実在の区間の時刻へ寄せる）
    const raw = { review_title: '', items: [{ title: 'ボタン', request: '濃く', status: 'decided', target: '', quote_ts: [18_300], frame_times: [], annotation_ids: [] }], dropped: [] }
    const checked = validateOrganizeOutput(raw, input)
    expect(checked.ok).toBe(true)
    const doc = assembleFromOrganized(material, checked.value!)
    expect(doc.items.filter((it) => it.quotes.some((q) => q.t === 18_000))).toHaveLength(1)
  })
})

describe('短すぎる発話を黙って捨てない（下書き）', () => {
  it('1字の発話（「赤」）は指摘にしないが、除外した発話に入れて戻せるようにする', () => {
    const m: Material = { ...material, events: [], frames: [], transcript: [seg(2_000, '赤'), seg(30_000, 'この文字を大きく')] }
    const draft = buildDraft(m)
    expect(draft.items.map((d) => d.segments.map((s) => s.text))).toEqual([['この文字を大きく']])
    expect(draft.meaningless!.map((s) => s.text)).toEqual(['赤'])
    expect(buildDraftDocument(m).document.dropped.map((d) => d.text)).toEqual(['赤'])
  })
})
