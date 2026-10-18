/**
 * ビジネスの集計の期間と日付の計算（UTC で計算し、TZ に依存しない）
 */
import { describe, expect, it } from 'vitest'
import type { MetricRow } from '../../src/shared/venture/model'
import {
  addDays,
  dataRange,
  dayOf,
  daysBetween,
  inPeriod,
  isIsoDate,
  monthKey,
  monthStart,
  periodDays,
  prevMonthKey,
  resolvePeriod
} from '../../src/shared/venture/period'

const row = (date: string): MetricRow => ({ date, source: 'canonical', channel: 'x', values: { impressions: 1 }, file: 'a.json', line: 1 })

describe('日付の形', () => {
  it('暦にある YYYY-MM-DD だけを日付とする', () => {
    expect(isIsoDate('2026-10-18')).toBe(true)
    expect(isIsoDate('2024-02-29')).toBe(true)
    expect(isIsoDate('2025-02-29')).toBe(false)
    expect(isIsoDate('2026-13-01')).toBe(false)
    expect(isIsoDate('2026-04-31')).toBe(false)
    expect(isIsoDate('2026-1-01')).toBe(false)
    expect(isIsoDate('')).toBe(false)
    expect(isIsoDate(null)).toBe(false)
    expect(isIsoDate(20261018)).toBe(false)
  })

  it('2000年はうるう年、1900年・2100年は違う', () => {
    expect(isIsoDate('2000-02-29')).toBe(true)
    expect(isIsoDate('1900-02-29')).toBe(false)
    expect(isIsoDate('2100-02-29')).toBe(false)
  })

  it('日時から先頭の日付を取る。区切りが T か空白でなければ読まない', () => {
    expect(dayOf('2026-10-01T23:59:59+09:00')).toBe('2026-10-01')
    expect(dayOf('2026-10-01 09:00')).toBe('2026-10-01')
    expect(dayOf('2026-10-01')).toBe('2026-10-01')
    expect(dayOf('2026-10-01x')).toBe(null)
    expect(dayOf('2026-02-30T00:00:00Z')).toBe(null)
    expect(dayOf(undefined)).toBe(null)
    expect(dayOf('2026')).toBe(null)
  })
})

describe('日付の足し引き', () => {
  it('月・年・うるう年をまたぐ', () => {
    expect(addDays('2026-10-31', 1)).toBe('2026-11-01')
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01')
    expect(addDays('2024-02-28', 1)).toBe('2024-02-29')
    expect(addDays('2025-02-28', 1)).toBe('2025-03-01')
    expect(addDays('2024-03-01', -1)).toBe('2024-02-29')
    expect(addDays('2026-01-01', -1)).toBe('2025-12-31')
    expect(addDays('2026-10-18', 0)).toBe('2026-10-18')
  })

  it('夏時間のある月（3月・11月）でも1日ずつ進む', () => {
    expect(addDays('2026-03-08', 1)).toBe('2026-03-09')
    expect(addDays('2026-11-01', 1)).toBe('2026-11-02')
    expect(addDays('2026-03-01', 30)).toBe('2026-03-31')
  })

  it('日付でない・整数でない日数は null', () => {
    expect(addDays('2026-02-30', 1)).toBe(null)
    expect(addDays('x', 1)).toBe(null)
    expect(addDays('2026-10-18', 1.5)).toBe(null)
    expect(addDays('2026-10-18', Number.NaN)).toBe(null)
    expect(addDays('2026-10-18', Number.POSITIVE_INFINITY)).toBe(null)
  })

  it('日数の差と期間の日数（両端を含む）', () => {
    expect(daysBetween('2026-10-01', '2026-10-18')).toBe(17)
    expect(daysBetween('2026-10-18', '2026-10-01')).toBe(-17)
    expect(daysBetween('2024-01-01', '2025-01-01')).toBe(366)
    expect(daysBetween('bad', '2026-10-01')).toBe(null)
    expect(periodDays({ from: '2026-10-01', to: '2026-10-01' })).toBe(1)
    expect(periodDays({ from: '2026-10-01', to: '2026-10-31' })).toBe(31)
    expect(periodDays({ from: '2026-10-31', to: '2026-10-01' })).toBe(0)
    expect(periodDays({ from: 'x', to: '2026-10-01' })).toBe(0)
  })

  it('月の1日・月の鍵・前の月（年をまたぐ）', () => {
    expect(monthStart('2026-10-18')).toBe('2026-10-01')
    expect(monthKey('2026-10-18')).toBe('2026-10')
    expect(prevMonthKey('2026-10')).toBe('2026-09')
    expect(prevMonthKey('2026-01')).toBe('2025-12')
    expect(prevMonthKey('2026-12')).toBe('2026-11')
  })
})

describe('期間に入るか', () => {
  const p = { from: '2026-10-01', to: '2026-10-31' }
  it('両端を含む', () => {
    expect(inPeriod('2026-10-01', p)).toBe(true)
    expect(inPeriod('2026-10-31', p)).toBe(true)
    expect(inPeriod('2026-09-30', p)).toBe(false)
    expect(inPeriod('2026-11-01', p)).toBe(false)
  })
  it('日付でなければ入らない。period が null なら絞らない', () => {
    expect(inPeriod('2026-10-32', p)).toBe(false)
    expect(inPeriod(undefined, p)).toBe(false)
    expect(inPeriod('2026-10-05', null)).toBe(true)
    expect(inPeriod('bad', null)).toBe(false)
  })
})

describe('期間の決まり', () => {
  it('30d は today を含む過去30日', () => {
    expect(resolvePeriod('30d', '2026-10-18', [])).toEqual({ from: '2026-09-19', to: '2026-10-18' })
  })
  it('90d は today を含む過去90日（年をまたぐ）', () => {
    expect(resolvePeriod('90d', '2026-10-18', [])).toEqual({ from: '2026-07-21', to: '2026-10-18' })
    expect(resolvePeriod('90d', '2026-01-15', [])).toEqual({ from: '2025-10-18', to: '2026-01-15' })
  })
  it('30d がうるう年の2月をまたぐ', () => {
    expect(resolvePeriod('30d', '2024-03-10', [])).toEqual({ from: '2024-02-10', to: '2024-03-10' })
    expect(resolvePeriod('30d', '2025-03-10', [])).toEqual({ from: '2025-02-09', to: '2025-03-10' })
  })
  it('month は today の月の1日〜today。1日なら1日だけ', () => {
    expect(resolvePeriod('month', '2026-10-18', [])).toEqual({ from: '2026-10-01', to: '2026-10-18' })
    expect(resolvePeriod('month', '2026-10-01', [])).toEqual({ from: '2026-10-01', to: '2026-10-01' })
  })
  it('all はデータの最小〜最大日（並びに依らない。壊れた日付は無視）', () => {
    const rows = [row('2026-05-03'), row('2025-12-31'), row('2026-02-30'), row('2026-10-01')]
    expect(resolvePeriod('all', '2026-10-18', rows)).toEqual({ from: '2025-12-31', to: '2026-10-01' })
  })
  it('all でデータが無ければ null。壊れた日付しか無くても null', () => {
    expect(resolvePeriod('all', '2026-10-18', [])).toBe(null)
    expect(resolvePeriod('all', '2026-10-18', [row('bad')])).toBe(null)
  })
  it('all は today が壊れていてもデータから決める', () => {
    expect(resolvePeriod('all', 'bad', [row('2026-01-01')])).toEqual({ from: '2026-01-01', to: '2026-01-01' })
  })
  it('today が日付でなければ 30d・90d・month は null', () => {
    expect(resolvePeriod('30d', '2026-02-30', [])).toBe(null)
    expect(resolvePeriod('month', '', [])).toBe(null)
    expect(resolvePeriod('90d', 'x', [])).toBe(null)
  })
  it('データの範囲: 行が配列でなくても壊れない', () => {
    expect(dataRange(null as unknown as MetricRow[])).toBe(null)
    expect(dataRange([null as unknown as MetricRow, row('2026-01-02')])).toEqual({ from: '2026-01-02', to: '2026-01-02' })
  })
})
