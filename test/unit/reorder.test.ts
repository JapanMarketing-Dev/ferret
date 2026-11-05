import { describe, expect, it, vi } from 'vitest'
import { applySubsetOrder, dropPositionAt, moveAmongVisible, stepAmongVisible } from '@shared/reorder'
import { setLocale } from '@shared/i18n'
import type { Project } from '@shared/types'
import { assembleFromOrganized } from '../../src/main/pipeline/assemble'
import { renderFeedbackMarkdown } from '../../src/main/pipeline/feedback'
import { buildDraftDocument } from '../../src/main/pipeline/decompose'
import { applyEdits, type ItemEdit } from '../../src/main/sessions/edits'
import { appendTake } from '../../src/main/sessions/takes'
import type { SessionRecord } from '../../src/main/sessions/store'
import { events, frames, material, meta, transcript } from './fixtures'

// settings.ts は保存先を決めるためだけに electron の app を読む。単体テストでは呼ばれない
vi.mock('electron', () => ({ app: { getPath: () => '/tmp/ade-unit' } }))
const { sanitize } = await import('../../src/main/settings')
const { reorderProjects } = await import('../../src/main/projects')

setLocale('ja')

describe('並べ替えの純粋な関数', () => {
  it('行の上半分なら前、下半分なら後ろ', () => {
    expect(dropPositionAt(3, 28)).toBe('before')
    expect(dropPositionAt(14, 28)).toBe('after')
    expect(dropPositionAt(27, 28)).toBe('after')
  })

  it('一部の並びを、それらが占めていた位置に入れ直す（ほかは動かさない）', () => {
    expect(applySubsetOrder(['a', 'b', 'c', 'd', 'e'], ['d', 'b'])).toEqual(['a', 'd', 'c', 'b', 'e'])
    // 知らないもの・重複は捨てる
    expect(applySubsetOrder(['a', 'b', 'c'], ['c', 'x', 'c', 'a'])).toEqual(['c', 'b', 'a'])
    expect(applySubsetOrder(['a', 'b'], [])).toEqual(['a', 'b'])
  })

  it('全部見えているときは、落とした位置へそのまま動かす', () => {
    const all = ['a', 'b', 'c', 'd']
    expect(moveAmongVisible(all, all, 'a', 'c', 'after')).toEqual(['b', 'c', 'a', 'd'])
    expect(moveAmongVisible(all, all, 'd', 'a', 'before')).toEqual(['d', 'a', 'b', 'c'])
    expect(moveAmongVisible(all, all, 'b', 'c', 'before')).toBeNull() // 動かない
    expect(moveAmongVisible(all, all, 'b', 'b', 'after')).toBeNull()
    expect(moveAmongVisible(all, all, 'x', 'b', 'after')).toBeNull()
  })

  it('絞り込み中は、見えている中の相対位置で決め、見えないものの位置は保つ', () => {
    // b・d は絞り込みで隠れている
    const all = ['a', 'b', 'c', 'd', 'e']
    const visible = ['a', 'c', 'e']
    // e を a の前へ → 見えている並びは e, a, c。a・c・e が占めていた 0・2・4 番目に入れ直す
    expect(moveAmongVisible(all, visible, 'e', 'a', 'before')).toEqual(['e', 'b', 'a', 'd', 'c'])
    // 見えていない行には落とせない
    expect(moveAmongVisible(all, visible, 'a', 'b', 'after')).toBeNull()
  })

  it('キーボードの1つ上・下は、見えている隣と入れ替える。端では動かない', () => {
    const all = ['a', 'b', 'c', 'd']
    expect(stepAmongVisible(all, all, 'b', -1)).toEqual(['b', 'a', 'c', 'd'])
    expect(stepAmongVisible(all, all, 'b', 1)).toEqual(['a', 'c', 'b', 'd'])
    expect(stepAmongVisible(all, all, 'a', -1)).toBeNull()
    expect(stepAmongVisible(all, all, 'd', 1)).toBeNull()
    // 絞り込み中は見えている隣（b は隠れている）
    expect(stepAmongVisible(all, ['a', 'c', 'd'], 'c', -1)).toEqual(['c', 'b', 'a', 'd'])
  })

  it('within を渡すと、その中の隣とだけ入れ替える（対象ごとにまとめた指摘）', () => {
    const group: Record<string, string> = { a: 'x', b: 'x', c: 'y', d: 'y' }
    const same = (moving: string) => (other: string) => group[other] === group[moving]
    expect(stepAmongVisible(['a', 'b', 'c', 'd'], ['a', 'b', 'c', 'd'], 'c', -1, same('c'))).toBeNull()
    expect(stepAmongVisible(['a', 'b', 'c', 'd'], ['a', 'b', 'c', 'd'], 'd', -1, same('d'))).toEqual(['a', 'b', 'd', 'c'])
  })
})

describe('プロジェクトの並べ替え（settings の projects の並び）', () => {
  const project = (id: string): Project => ({ id, name: id, folderPath: `/work/${id}`, urls: [] })
  const list = ['a', 'b', 'c'].map(project)

  it('送られた並びにする。知らない ID・重複・形の違う値は捨て、無いものはその位置のまま', () => {
    expect(reorderProjects(list, ['c', 'a', 'b']).map((p) => p.id)).toEqual(['c', 'a', 'b'])
    expect(reorderProjects(list, ['c', 'zzz', 'c', 7, 'a']).map((p) => p.id)).toEqual(['c', 'b', 'a'])
    expect(reorderProjects(list, 'こわれた値').map((p) => p.id)).toEqual(['a', 'b', 'c'])
    expect(reorderProjects(list, [])).toEqual(list)
  })

  it('並びは配列の順そのもの。並べ替えより前の設定もそのままの順で読み、保存した順も読み直しで保つ', () => {
    const before = sanitize({ projects: [{ id: 'b', folderPath: '/work/b' }, { id: 'a', folderPath: '/work/a' }] })
    expect(before.projects.map((p) => p.id)).toEqual(['b', 'a'])
    const reordered = reorderProjects(before.projects, ['a', 'b'])
    const reloaded = sanitize(JSON.parse(JSON.stringify({ ...before, projects: reordered })))
    expect(reloaded.projects.map((p) => p.id)).toEqual(['a', 'b'])
  })
})

const organized = {
  items: [
    { title: '見出しが小さい', request: '大きくする', status: 'decided' as const,
      quotes: [{ speaker: 'self' as const, t: 2_000, text: 'この見出しが小さいですね' }, { speaker: 'self' as const, t: 5_500, text: 'もう少し大きくしてください' }], frame_times: [3_000], annotation_ids: [] },
    { title: 'ボタンの色が薄い', request: '濃くする', status: 'decided' as const,
      quotes: [{ speaker: 'self' as const, t: 18_000, text: 'このボタンの色が薄いです' }], frame_times: [19_750], annotation_ids: ['p3'] },
    { title: '表記をどうするか', request: '決める', status: 'decided' as const,
      quotes: [{ speaker: 'self' as const, t: 24_800, text: '表記がばらばらです' }], frame_times: [25_400], annotation_ids: ['x1'] }
  ],
  dropped: []
}

describe('指摘の並べ替え（review の session.json の編集）', () => {
  const base = () => assembleFromOrganized(material, organized)
  const apply = (edits: ItemEdit[], document = base()) =>
    applyEdits({ document, edits, events: material.events, frames: material.frames })

  it('並べ替えた順に番号と画像名を振り直し、customOrder を残す', () => {
    const [a, b, c] = base().items
    const { document, skipped } = apply([{ kind: 'order', ids: [c!.id, a!.id, b!.id] }])
    expect(skipped).toEqual([])
    expect(document.customOrder).toBe(true)
    expect(document.items.map((it) => it.id)).toEqual([c!.id, a!.id, b!.id])
    expect(document.items.map((it) => it.index)).toEqual([1, 2, 3])
    expect(document.items.map((it) => it.images)).toEqual([['./01.png'], ['./02.png'], ['./03.png']])
  })

  it('並べ替えたあとの別の編集（1件ずつ積む）でも、時刻順に戻らない', () => {
    const [a, b, c] = base().items
    const ordered = apply([{ kind: 'order', ids: [c!.id, a!.id, b!.id] }]).document
    const edited = apply([{ kind: 'text', id: a!.id, title: '直した' }], ordered).document
    expect(edited.items.map((it) => it.id)).toEqual([c!.id, a!.id, b!.id])
    const deleted = apply([{ kind: 'delete', id: a!.id }], edited).document
    expect(deleted.items.map((it) => [it.id, it.index])).toEqual([[c!.id, 1], [b!.id, 2]])
    expect(deleted.customOrder).toBe(true)
  })

  it('ids: null で時刻順に戻し、customOrder を外す', () => {
    const [a, b, c] = base().items
    const ordered = apply([{ kind: 'order', ids: [c!.id, a!.id, b!.id] }]).document
    const reset = apply([{ kind: 'order', ids: null }], ordered).document
    expect(reset.items.map((it) => it.id)).toEqual([a!.id, b!.id, c!.id])
    expect(reset).not.toHaveProperty('customOrder')
  })

  it('知らない ID は捨て、並びに無い指摘はその位置のまま。形の違う値は適用しない', () => {
    const [a, b, c] = base().items
    expect(apply([{ kind: 'order', ids: ['nope', c!.id, a!.id] }]).document.items.map((it) => it.id)).toEqual([c!.id, b!.id, a!.id])
    const bad = apply([{ kind: 'order', ids: 'x' as unknown as string[] }])
    expect(bad.skipped).toHaveLength(1)
    expect(bad.document.items.map((it) => it.id)).toEqual([a!.id, b!.id, c!.id])
  })

  it('並べ替えより前に保存したレビュー（customOrder の無いもの）は時刻順のまま', () => {
    const doc = base()
    const shuffled = { ...doc, items: [...doc.items].reverse() }
    expect(apply([{ kind: 'note', note: 'メモ' }], shuffled).document.items.map((it) => it.t)).toEqual(doc.items.map((it) => it.t))
  })

  it('元に戻す（正本へ編集を積み直す）と、並べ替えも1手ずつ戻る', () => {
    const [a, b, c] = base().items
    const edits: ItemEdit[] = [{ kind: 'order', ids: [c!.id, a!.id, b!.id] }, { kind: 'order', ids: [b!.id, c!.id, a!.id] }]
    expect(apply(edits).document.items.map((it) => it.id)).toEqual([b!.id, c!.id, a!.id])
    expect(apply(edits.slice(0, -1)).document.items.map((it) => it.id)).toEqual([c!.id, a!.id, b!.id])
  })

  it('feedback.md（Agent へ送る本文）の番号と並びも、並べ替えた順に従う（対象ごとの節の中で）', () => {
    const [a, b, c] = base().items
    const at = (md: string, title: string) => md.search(new RegExp(`^#+ \\d+\\. \\[[^\\]]*\\] ${title}`, 'm'))
    // 時刻順: トップ（a）→ 料金（b, c）
    const plain = renderFeedbackMarkdown(base())
    expect(at(plain, '見出しが小さい')).toBeLessThan(at(plain, 'ボタンの色が薄い'))
    expect(at(plain, 'ボタンの色が薄い')).toBeLessThan(at(plain, '表記をどうするか'))
    // c, a, b に並べ替えると、節は先に出た料金（c, b）→ トップ（a）。番号もその順
    const md = renderFeedbackMarkdown(apply([{ kind: 'order', ids: [c!.id, a!.id, b!.id] }]).document)
    expect(at(md, '表記をどうするか')).toBeGreaterThan(-1)
    expect(at(md, '表記をどうするか')).toBeLessThan(at(md, 'ボタンの色が薄い'))
    expect(at(md, 'ボタンの色が薄い')).toBeLessThan(at(md, '見出しが小さい'))
    expect(md).toMatch(/#+ 1\.[^\n]*表記をどうするか/)
  })
})

describe('並べ替えたレビューに録画を追記する', () => {
  function record(edits: ItemEdit[]): SessionRecord {
    const stage = buildDraftDocument(material)
    const document = applyEdits({ document: stage.document, edits, events, frames }).document
    return { version: 1, meta, transcript, removedDuplicates: [], frames, draft: stage.draft.items,
      originalDocument: stage.document, document, edits, captureGaps: [] }
  }
  const take = {
    n: 2, startedAt: '2026-10-02T11:00:00+09:00', addedAt: '2026-10-02T11:01:00+09:00', durationMs: 20_000,
    transcript: [{ t0: 3_000, t1: 5_000, speaker: 'self' as const, text: 'ロゴの余白が狭いです', source: 'mic' as const }],
    removedDuplicates: [],
    events: [{ t: 0, type: 'nav' as const, url: 'http://localhost:3000/about', title: '会社概要' }],
    frames: [{ t: 4_000, path: '00001.jpeg' }],
    warnings: []
  }

  it('並べ替えた順は保ち、足した指摘は末尾に並ぶ', () => {
    const ids = buildDraftDocument(material).document.items.map((it) => it.id)
    expect(ids.length).toBeGreaterThan(1)
    const reversed = [...ids].reverse()
    const next = appendTake(record([{ kind: 'order', ids: reversed }]), events, take).record
    const after = next.document.items.map((it) => it.id)
    expect(after.slice(0, ids.length)).toEqual(reversed)
    expect(after.slice(ids.length).every((id) => id.startsWith('t2-'))).toBe(true)
    expect(next.document.customOrder).toBe(true)
  })

  it('正本の無い古いレビューでも、並べ替えた順を保って足す', () => {
    const ids = buildDraftDocument(material).document.items.map((it) => it.id)
    const old = record([{ kind: 'order', ids: [...ids].reverse() }])
    delete old.originalDocument
    const next = appendTake(old, events, take).record
    expect(next.document.items.slice(0, ids.length).map((it) => it.id)).toEqual([...ids].reverse())
  })
})
