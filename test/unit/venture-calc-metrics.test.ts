/**
 * ビジネスの行の集計（データなしと 0 の区別・通貨・壊れた数・支払いからの契約と継続）
 */
import { describe, expect, it } from 'vitest'
import type { Channel, MetricRow } from '../../src/shared/venture/model'
import {
  aggregateBy,
  channelOf,
  cleanNumber,
  hasRowsInPeriod,
  isPaymentRow,
  newCustomers,
  payingCustomers,
  rowValue,
  sameCurrency,
  totals,
  totalsByChannel,
  totalsByDay,
  totalsByMonth
} from '../../src/shared/venture/metrics'

let line = 0
const row = (date: string, channel: Channel, values: MetricRow['values'], extra: Partial<MetricRow> = {}): MetricRow => ({
  date,
  source: 'canonical',
  channel,
  values,
  file: 'agent/a.json',
  line: ++line,
  ...extra
})
const pay = (date: string, customer: string, revenue: number, extra: Partial<MetricRow> = {}): MetricRow =>
  row(date, 'stripe', { revenue }, { source: 'stripe', customer, paymentId: `ch_${++line}`, ...extra })
const OCT = { from: '2026-10-01', to: '2026-10-31' }

describe('数の扱い', () => {
  it('有限で 0 以上の数だけ', () => {
    expect(cleanNumber(0)).toBe(0)
    expect(cleanNumber(12.5)).toBe(12.5)
    expect(cleanNumber(-1)).toBe(null)
    expect(cleanNumber(Number.NaN)).toBe(null)
    expect(cleanNumber(Number.POSITIVE_INFINITY)).toBe(null)
    expect(cleanNumber('3')).toBe(null)
    expect(cleanNumber(null)).toBe(null)
  })
  it('通貨: 未指定・同じ通貨（大文字小文字・空白を問わない）は数える', () => {
    expect(sameCurrency({}, 'JPY')).toBe(true)
    expect(sameCurrency({ currency: '' }, 'JPY')).toBe(true)
    expect(sameCurrency({ currency: 'jpy ' }, 'JPY')).toBe(true)
    expect(sameCurrency({ currency: 'USD' }, 'JPY')).toBe(false)
  })
  it('支払い行は customer と paymentId の両方がある行', () => {
    expect(isPaymentRow(pay('2026-10-01', 'cus_1', 100))).toBe(true)
    expect(isPaymentRow(row('2026-10-01', 'stripe', { revenue: 1 }, { customer: 'cus_1' }))).toBe(false)
    expect(isPaymentRow(row('2026-10-01', 'stripe', { revenue: 1 }, { paymentId: 'ch' }))).toBe(false)
    expect(isPaymentRow(row('2026-10-01', 'stripe', { revenue: 1 }, { customer: '', paymentId: 'ch' }))).toBe(false)
  })
  it('通貨違いの金額は数えないが、金額でない数は数える', () => {
    const r = row('2026-10-01', 'google-ads', { spend: 100, clicks: 5 }, { currency: 'USD' })
    expect(rowValue(r, 'spend', 'JPY')).toBe(null)
    expect(rowValue(r, 'clicks', 'JPY')).toBe(5)
  })
  it('支払い行に書かれた contracts・retained は使わない', () => {
    const r = pay('2026-10-01', 'cus_1', 100, { values: { revenue: 100, contracts: 5, retained: 3 } })
    expect(rowValue(r, 'contracts', 'JPY')).toBe(null)
    expect(rowValue(r, 'retained', 'JPY')).toBe(null)
    expect(rowValue(r, 'revenue', 'JPY')).toBe(100)
  })
  it('知らない経路は other', () => {
    expect(channelOf(row('2026-10-01', 'nope' as Channel, {}))).toBe('other')
    expect(channelOf(row('2026-10-01', 'x', {}))).toBe('x')
  })
})

describe('合計', () => {
  it('行が無ければ空（0 ではなく undefined）', () => {
    expect(totals([], OCT, 'JPY')).toEqual({})
    expect(totals([], OCT, 'JPY').spend).toBeUndefined()
  })
  it('1行も無い数は undefined、0 と書いた数は 0', () => {
    const t = totals([row('2026-10-01', 'x', { impressions: 100, clicks: 0 })], OCT, 'JPY')
    expect(t.impressions).toBe(100)
    expect(t.clicks).toBe(0)
    expect(t.leads).toBeUndefined()
  })
  it('期間の端（初日・最終日）は入り、外は入らない', () => {
    const rows = [
      row('2026-09-30', 'x', { impressions: 1 }),
      row('2026-10-01', 'x', { impressions: 10 }),
      row('2026-10-31', 'x', { impressions: 100 }),
      row('2026-11-01', 'x', { impressions: 1000 })
    ]
    expect(totals(rows, OCT, 'JPY').impressions).toBe(110)
  })
  it('period が null なら全部', () => {
    const rows = [row('2026-09-30', 'x', { impressions: 1 }), row('2026-11-01', 'x', { impressions: 2 })]
    expect(totals(rows, null, 'JPY').impressions).toBe(3)
  })
  it('通貨違いの金額は合計に入れない。全部違えば undefined', () => {
    const rows = [row('2026-10-01', 'google-ads', { spend: 100 }), row('2026-10-02', 'google-ads', { spend: 50 }, { currency: 'USD' })]
    expect(totals(rows, OCT, 'JPY').spend).toBe(100)
    expect(totals([rows[1]], OCT, 'JPY').spend).toBeUndefined()
  })
  it('NaN・負数・Infinity・文字は数えない（ほかの数は数える）', () => {
    const rows = [
      row('2026-10-01', 'x', { impressions: Number.NaN, clicks: 3 }),
      row('2026-10-02', 'x', { impressions: -5 }),
      row('2026-10-03', 'x', { impressions: Number.POSITIVE_INFINITY }),
      row('2026-10-04', 'x', { impressions: '7' as unknown as number })
    ]
    const t = totals(rows, OCT, 'JPY')
    expect(t.impressions).toBeUndefined()
    expect(t.clicks).toBe(3)
  })
  it('壊れた行（日付・values・null）は飛ばす', () => {
    const rows = [
      row('2026-10-32', 'x', { impressions: 1 }),
      { ...row('2026-10-01', 'x', {}), values: null } as unknown as MetricRow,
      null as unknown as MetricRow,
      row('2026-10-02', 'x', { impressions: 2 })
    ]
    expect(totals(rows, OCT, 'JPY').impressions).toBe(2)
    expect(totals(null as unknown as MetricRow[], OCT, 'JPY')).toEqual({})
  })
  it('支払い行でない行の contracts はそのまま足す', () => {
    const rows = [row('2026-10-01', 'x', { contracts: 2 }), row('2026-10-05', 'x', { contracts: 1, retained: 4 })]
    const t = totals(rows, OCT, 'JPY')
    expect(t.contracts).toBe(3)
    expect(t.retained).toBe(4)
  })
})

describe('支払いからの契約（初回の判定は全期間）', () => {
  it('期間内に初めて払った顧客だけを契約に数える', () => {
    const rows = [pay('2026-09-10', 'a', 1000), pay('2026-10-10', 'a', 1000), pay('2026-10-12', 'b', 1000), pay('2026-10-20', 'b', 1000)]
    const t = totals(rows, OCT, 'JPY')
    expect(t.contracts).toBe(1)
    expect(t.revenue).toBe(3000)
    expect(newCustomers(rows, OCT)).toEqual(['b'])
  })
  it('期間に既存の顧客の支払いしか無ければ契約 0（データなしではない）', () => {
    const rows = [pay('2026-09-10', 'a', 1000), pay('2026-10-10', 'a', 1000)]
    expect(totals(rows, OCT, 'JPY').contracts).toBe(0)
  })
  it('支払い行と canonical の契約を足す（支払い行の書いた contracts は二重にしない）', () => {
    const rows = [pay('2026-10-01', 'a', 500, { values: { revenue: 500, contracts: 1 } }), row('2026-10-02', 'referral', { contracts: 2 })]
    expect(totals(rows, OCT, 'JPY').contracts).toBe(3)
  })
  it('並びが逆でも一番早い支払いが初回', () => {
    const rows = [pay('2026-10-10', 'a', 1), pay('2026-09-01', 'a', 1)]
    expect(totals(rows, OCT, 'JPY').contracts).toBe(0)
    expect(newCustomers(rows, { from: '2026-09-01', to: '2026-09-30' })).toEqual(['a'])
  })
  it('同じ日の2回の支払いは先の行だけが初回', () => {
    const rows = [pay('2026-10-10', 'a', 1), pay('2026-10-10', 'a', 2)]
    expect(totals(rows, OCT, 'JPY').contracts).toBe(1)
  })
  it('通貨違いの支払いも顧客としては数える（売上には入れない）', () => {
    const rows = [pay('2026-10-10', 'a', 10, { currency: 'USD' })]
    const t = totals(rows, OCT, 'JPY')
    expect(t.contracts).toBe(1)
    expect(t.revenue).toBeUndefined()
    expect(payingCustomers(rows, OCT)).toEqual(['a'])
  })
  it('期間に払った顧客（重複なし・並べる）', () => {
    const rows = [pay('2026-10-10', 'b', 1), pay('2026-10-11', 'a', 1), pay('2026-10-12', 'b', 1), pay('2026-11-01', 'c', 1)]
    expect(payingCustomers(rows, OCT)).toEqual(['a', 'b'])
    expect(payingCustomers([], OCT)).toEqual([])
  })
})

describe('支払いからの継続', () => {
  it('前の月にも払っていた顧客が今の月も払った数を、月ごとに足す', () => {
    const rows = [
      pay('2026-08-05', 'a', 1),
      pay('2026-09-05', 'a', 1),
      pay('2026-10-05', 'a', 1),
      pay('2026-09-07', 'b', 1),
      pay('2026-10-20', 'c', 1)
    ]
    const t = totals(rows, { from: '2026-09-01', to: '2026-10-31' }, 'JPY')
    // 9月: a（8月にも）=1、b（8月なし）=0 / 10月: a=1、c=0
    expect(t.retained).toBe(2)
  })
  it('同じ月に2回払っても1回', () => {
    const rows = [pay('2026-09-05', 'a', 1), pay('2026-10-05', 'a', 1), pay('2026-10-25', 'a', 1)]
    expect(totals(rows, OCT, 'JPY').retained).toBe(1)
  })
  it('1か月空いたら継続に数えない', () => {
    const rows = [pay('2026-08-05', 'a', 1), pay('2026-10-05', 'a', 1)]
    expect(totals(rows, OCT, 'JPY').retained).toBe(0)
  })
  it('年をまたぐ（12月 → 1月）', () => {
    const rows = [pay('2025-12-20', 'a', 1), pay('2026-01-03', 'a', 1)]
    expect(totals(rows, { from: '2026-01-01', to: '2026-01-31' }, 'JPY').retained).toBe(1)
  })
  it('支払いのデータの最初の月は前が分からないので、継続はデータなし', () => {
    const rows = [pay('2026-10-05', 'a', 1), pay('2026-10-06', 'b', 1)]
    expect(totals(rows, OCT, 'JPY').retained).toBeUndefined()
  })
})

describe('経路別・日別・月別', () => {
  const rows = [
    row('2026-10-01', 'x', { impressions: 100 }),
    row('2026-10-01', 'google-ads', { impressions: 50, spend: 300 }),
    row('2026-10-02', 'x', { impressions: 10 }),
    row('2026-09-30', 'x', { impressions: 1 }),
    row('2026-10-03', 'nope' as Channel, { impressions: 7 })
  ]
  it('経路別は CHANNELS の順、行の無い経路は出さない、知らない経路は other', () => {
    const by = totalsByChannel(rows, OCT, 'JPY')
    expect(by.map((c) => c.channel)).toEqual(['google-ads', 'x', 'other'])
    expect(by[1].totals.impressions).toBe(110)
    expect(by[0].totals.spend).toBe(300)
  })
  it('日別は日付の順', () => {
    const by = totalsByDay(rows, OCT, 'JPY')
    expect(by.map((d) => d.date)).toEqual(['2026-10-01', '2026-10-02', '2026-10-03'])
    expect(by[0].totals.impressions).toBe(150)
  })
  it('月別は月の順（月をまたぐ）', () => {
    const by = totalsByMonth(rows, null, 'JPY')
    expect(by.map((m) => m.month)).toEqual(['2026-09', '2026-10'])
    expect(by[0].totals.impressions).toBe(1)
    expect(by[1].totals.impressions).toBe(167)
  })
  it('経路別の契約は初回の支払いの経路に付く', () => {
    const r = [pay('2026-10-01', 'a', 1, { channel: 'x' }), pay('2026-10-05', 'a', 1)]
    const by = totalsByChannel(r, OCT, 'JPY')
    expect(by.find((c) => c.channel === 'x')?.totals.contracts).toBe(1)
    expect(by.find((c) => c.channel === 'stripe')?.totals.contracts).toBe(0)
  })
  it('groupOf が null の行は数えない', () => {
    const m = aggregateBy(rows, OCT, 'JPY', (r) => (r.channel === 'x' ? 'x' : null))
    expect([...m.keys()]).toEqual(['x'])
  })
  it('期間に行があるか', () => {
    expect(hasRowsInPeriod(rows, OCT)).toBe(true)
    expect(hasRowsInPeriod(rows, { from: '2027-01-01', to: '2027-01-31' })).toBe(false)
    expect(hasRowsInPeriod([], null)).toBe(false)
  })
})
