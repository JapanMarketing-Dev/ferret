/**
 * 取り込みの重複の除去（mergeImports）: 支払いは paymentId、ほかは元・日・経路・キャンペーン。後のファイルを優先、並びは与えた順
 */
import { describe, expect, it } from 'vitest'
import { mergeImports, parseImportFile, rowKey } from '../../src/shared/venture/import'
import type { ImportResult, MetricRow } from '../../src/shared/venture/model'

const row = (over: Partial<MetricRow>): MetricRow => ({
  date: '2026-10-01',
  source: 'google-ads',
  channel: 'google-ads',
  values: { clicks: 1 },
  file: 'imports/google-ads/a.csv',
  line: 2,
  ...over
})
const result = (rows: MetricRow[], extra: Partial<ImportResult> = {}): ImportResult => ({ rows, issues: [], skipped: 0, ...extra })

describe('mergeImports', () => {
  it('空', () => {
    expect(mergeImports([])).toEqual({ rows: [], issues: [], skipped: 0 })
  })

  it('1つのファイルはそのまま（同じ鍵の行も残す）', () => {
    const rows = [row({ line: 2 }), row({ line: 3 })]
    expect(mergeImports([result(rows)]).rows).toEqual(rows)
  })

  it('同じ元・日・経路・キャンペーンは後のファイルを優先し、捨てた側に duplicate', () => {
    const a = row({ file: 'imports/google-ads/a.csv', line: 2, campaign: 'A', values: { clicks: 1 } })
    const b = row({ file: 'imports/google-ads/b.csv', line: 5, campaign: 'A', values: { clicks: 9 } })
    const r = mergeImports([result([a]), result([b])])
    expect(r.rows).toEqual([b])
    expect(r.issues).toEqual([{ file: 'imports/google-ads/a.csv', line: 2, code: 'duplicate', detail: 'imports/google-ads/b.csv' }])
  })

  it('後のファイルの同じ鍵の行は全部残す（端末別に分けた行）', () => {
    const a = row({ file: 'a', campaign: 'A' })
    const b1 = row({ file: 'b', line: 2, campaign: 'A', values: { clicks: 1 } })
    const b2 = row({ file: 'b', line: 3, campaign: 'A', values: { clicks: 2 } })
    const r = mergeImports([result([a]), result([b1, b2])])
    expect(r.rows).toEqual([b1, b2])
    expect(r.issues).toHaveLength(1)
  })

  it('前のファイルの同じ鍵の行は全部捨てる', () => {
    const a1 = row({ file: 'a', line: 2 })
    const a2 = row({ file: 'a', line: 3 })
    const b = row({ file: 'b' })
    const r = mergeImports([result([a1, a2]), result([b])])
    expect(r.rows).toEqual([b])
    expect(r.issues.map((i) => i.line)).toEqual([2, 3])
  })

  it('キャンペーン・日・経路・元のどれかが違えば別の行', () => {
    const base = row({ file: 'a' })
    const others = [row({ file: 'b', campaign: 'X' }), row({ file: 'b', date: '2026-10-02' }), row({ file: 'b', channel: 'other' }), row({ file: 'b', source: 'canonical' })]
    const r = mergeImports([result([base]), result(others)])
    expect(r.rows).toHaveLength(5)
    expect(r.issues).toEqual([])
  })

  it('キャンペーンなしと空のキャンペーンは同じ', () => {
    expect(rowKey(row({}))).toBe(rowKey(row({ campaign: '' })))
  })

  it('支払いは paymentId で、元が違っても重複（Agent の JSON と Stripe の CSV）', () => {
    const csv = row({ source: 'stripe', channel: 'stripe', paymentId: 'ch_1', file: 'imports/stripe/a.csv', line: 2, values: { revenue: 100 } })
    const agent = row({ source: 'canonical', channel: 'stripe', paymentId: 'ch_1', file: 'agent/s.json', line: 1, values: { revenue: 100 } })
    const r = mergeImports([result([csv]), result([agent])])
    expect(r.rows).toEqual([agent])
    expect(r.issues).toEqual([{ file: 'imports/stripe/a.csv', line: 2, code: 'duplicate', detail: 'agent/s.json:1' }])
  })

  it('支払い id の重複は同じファイルの中でも後の1行だけ残す', () => {
    const p1 = row({ paymentId: 'ch_1', line: 2 })
    const p2 = row({ paymentId: 'ch_1', line: 3 })
    const r = mergeImports([result([p1, p2])])
    expect(r.rows).toEqual([p2])
    expect(r.issues[0]).toMatchObject({ line: 2, code: 'duplicate', detail: 'imports/google-ads/a.csv:3' })
  })

  it('違う支払い id は同じ日でも別', () => {
    const r = mergeImports([result([row({ paymentId: 'ch_1' }), row({ paymentId: 'ch_2' })])])
    expect(r.rows).toHaveLength(2)
  })

  it('支払い id のある行と無い行は鍵が違う', () => {
    const r = mergeImports([result([row({ file: 'a' })]), result([row({ file: 'b', paymentId: 'ch_1' })])])
    expect(r.rows).toHaveLength(2)
  })

  it('並びは与えた順（ファイルの順、その中の行の順）', () => {
    const a = [row({ file: 'a', campaign: '1' }), row({ file: 'a', campaign: '2' }), row({ file: 'a', campaign: '3' })]
    const b = [row({ file: 'b', campaign: '2' }), row({ file: 'b', campaign: '4' })]
    const r = mergeImports([result(a), result(b)])
    expect(r.rows.map((x) => `${x.file}${x.campaign}`)).toEqual(['a1', 'a3', 'b2', 'b4'])
  })

  it('3つのファイルでは一番後が残る', () => {
    const r = mergeImports([result([row({ file: 'a' })]), result([row({ file: 'b' })]), result([row({ file: 'c' })])])
    expect(r.rows.map((x) => x.file)).toEqual(['c'])
    expect(r.issues.map((i) => [i.file, i.detail])).toEqual([
      ['a', 'c'],
      ['b', 'c']
    ])
  })

  it('各ファイルの問題と skipped を足し、duplicate はそのあと', () => {
    const r = mergeImports([
      result([row({ file: 'a' })], { issues: [{ file: 'a', line: 9, code: 'badDate' }], skipped: 2 }),
      result([row({ file: 'b' })], { issues: [{ file: 'b', line: null, code: 'noHeader' }], skipped: 3 })
    ])
    expect(r.skipped).toBe(5)
    expect(r.issues.map((i) => i.code)).toEqual(['badDate', 'noHeader', 'duplicate'])
  })

  it('duplicate の detail は 80 文字まで', () => {
    const long = `imports/x/${'n'.repeat(200)}.csv`
    const r = mergeImports([result([row({ file: 'a' })]), result([row({ file: long })])])
    expect(r.issues[0].detail).toHaveLength(80)
  })

  it('同じ書き出しを2回置いても数は1回分', () => {
    const text = 'Day,Campaign,Clicks\n2026-10-01,A,3\n2026-10-02,A,4'
    const read = (name: string) =>
      parseImportFile({ path: `data/imports/google-ads/${name}`, source: 'google-ads', bytes: new TextEncoder().encode(text), currency: 'JPY' })
    const r = mergeImports([read('a.csv'), read('b.csv')])
    expect(r.rows.map((x) => [x.file, x.values.clicks])).toEqual([
      ['imports/google-ads/b.csv', 3],
      ['imports/google-ads/b.csv', 4]
    ])
    expect(r.issues.map((i) => [i.file, i.line, i.code])).toEqual([
      ['imports/google-ads/a.csv', 2, 'duplicate'],
      ['imports/google-ads/a.csv', 3, 'duplicate']
    ])
  })

  it('期間が重なる書き出しは重なった日だけ後のファイル', () => {
    const read = (name: string, text: string) =>
      parseImportFile({ path: `data/imports/x/${name}`, source: 'x', bytes: new TextEncoder().encode(text), currency: 'JPY' })
    const r = mergeImports([read('sep.csv', 'Date,Impressions\n2026-09-30,1\n2026-10-01,2'), read('oct.csv', 'Date,Impressions\n2026-10-01,5\n2026-10-02,6')])
    expect(r.rows.map((x) => [x.date, x.values.impressions])).toEqual([
      ['2026-09-30', 1],
      ['2026-10-01', 5],
      ['2026-10-02', 6]
    ])
  })

  it('入力を書き換えない', () => {
    const input = [result([row({ file: 'a' })]), result([row({ file: 'b' })])]
    const copy = JSON.parse(JSON.stringify(input))
    mergeImports(input)
    expect(input).toEqual(copy)
  })
})
