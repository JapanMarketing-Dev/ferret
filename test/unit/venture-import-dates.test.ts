/**
 * 取り込みの日付 → YYYY-MM-DD: ISO・スラッシュ・YYYYMMDD・年月日・和暦・英語の月名・日時・タイムゾーン・曖昧な月日・存在しない日
 */
import { describe, expect, it } from 'vitest'
import { isValidYmd, parseDate, toYmd } from '../../src/shared/venture/import/dates'

describe('parseDate: 読める形', () => {
  it.each([
    ['2026-10-01', '2026-10-01'],
    ['2026-1-5', '2026-01-05'],
    ['2026/10/1', '2026-10-01'],
    ['2026/1/09', '2026-01-09'],
    ['2026.10.01', '2026-10-01'],
    ['20261001', '2026-10-01'],
    ['2026年10月1日', '2026-10-01'],
    ['2026年 10月 1日', '2026-10-01'],
    ['２０２６年１０月１日', '2026-10-01'],
    ['2026年10月1日(木)', '2026-10-01'],
    ['2026年10月1日（木）', '2026-10-01'],
    ['2026年10月1日 12:00', '2026-10-01'],
    ['令和8年10月1日', '2026-10-01'],
    ['令和元年5月1日', '2019-05-01'],
    ['平成31年4月30日', '2019-04-30'],
    ['Oct 1, 2026', '2026-10-01'],
    ['Oct. 1, 2026', '2026-10-01'],
    ['October 1, 2026', '2026-10-01'],
    ['october 1 2026', '2026-10-01'],
    ['Sept 30, 2026', '2026-09-30'],
    ['May 31, 2026', '2026-05-31'],
    ['Oct 1st, 2026', '2026-10-01'],
    ['1 Oct 2026', '2026-10-01'],
    ['1 October 2026', '2026-10-01'],
    ['01-Oct-2026', '2026-10-01'],
    ['Thu, Oct 1, 2026', '2026-10-01'],
    ['Thursday, October 1, 2026', '2026-10-01'],
    ['Wed, Oct 01, 2026', '2026-10-01'],
    ['  2026-10-01  ', '2026-10-01']
  ])('%s → %s', (raw, expected) => {
    expect(parseDate(raw)).toBe(expected)
  })
})

describe('parseDate: 日時つき', () => {
  it('タイムゾーンなしは日付の部分', () => {
    expect(parseDate('2026-10-01 12:34:56')).toBe('2026-10-01')
    expect(parseDate('2026-10-01 23:59')).toBe('2026-10-01')
    expect(parseDate('2026/10/1 0:00')).toBe('2026-10-01')
    expect(parseDate('2026-10-01T23:30:00')).toBe('2026-10-01')
    expect(parseDate('2026-10-01T23:30:00.123')).toBe('2026-10-01')
  })
  it('Z は UTC の日付', () => {
    expect(parseDate('2026-10-01T03:00:00Z')).toBe('2026-10-01')
    expect(parseDate('2026-10-01T23:59:59.999Z')).toBe('2026-10-01')
  })
  it('+09:00 は UTC に直した日付（日本の朝 3 時は前の日の UTC）', () => {
    expect(parseDate('2026-10-01T03:00:00+09:00')).toBe('2026-09-30')
    expect(parseDate('2026-10-01T09:00:00+09:00')).toBe('2026-10-01')
    expect(parseDate('2026-10-01T03:00:00+0900')).toBe('2026-09-30')
  })
  it('マイナスのずれは次の日になることがある', () => {
    expect(parseDate('2026-10-01T22:00:00-05:00')).toBe('2026-10-02')
  })
  it('月・年をまたぐ', () => {
    expect(parseDate('2026-01-01T01:00:00+09:00')).toBe('2025-12-31')
    expect(parseDate('2026-03-01T00:30:00+01:00')).toBe('2026-02-28')
  })
  it('"UTC" と "GMT" の表記', () => {
    expect(parseDate('2026-10-01 03:04:05 UTC')).toBe('2026-10-01')
    expect(parseDate('2026-10-01 03:04:05 GMT')).toBe('2026-10-01')
  })
  it('時刻が壊れていれば null', () => {
    expect(parseDate('2026-10-01 25:00')).toBeNull()
    expect(parseDate('2026-10-01 12:60')).toBeNull()
    expect(parseDate('2026-10-01 12:00:61')).toBeNull()
  })
})

describe('parseDate: 月日の順が曖昧な形', () => {
  it('2つ目が 13 以上なら 月/日/年', () => {
    expect(parseDate('10/13/2026')).toBe('2026-10-13')
    expect(parseDate('1/31/2026')).toBe('2026-01-31')
  })
  it('1つ目が 13 以上なら 日/月/年', () => {
    expect(parseDate('13/10/2026')).toBe('2026-10-13')
    expect(parseDate('31.12.2026')).toBe('2026-12-31')
    expect(parseDate('25-12-2026')).toBe('2026-12-25')
  })
  it('どちらも 12 以下で違えば決まらないので null', () => {
    expect(parseDate('10/01/2026')).toBeNull()
    expect(parseDate('01/10/2026')).toBeNull()
    expect(parseDate('3/4/2026')).toBeNull()
  })
  it('月と日が同じならどちらでも同じ日', () => {
    expect(parseDate('05/05/2026')).toBe('2026-05-05')
  })
  it('時刻つきでも同じ決まり', () => {
    expect(parseDate('10/13/2026 10:00')).toBe('2026-10-13')
    expect(parseDate('10/11/2026 10:00')).toBeNull()
  })
  it('どちらも 13 以上は null', () => {
    expect(parseDate('13/13/2026')).toBeNull()
  })
  it('2桁の年は読まない', () => {
    expect(parseDate('10/13/26')).toBeNull()
  })
})

describe('parseDate: 読めない', () => {
  it.each([
    [''],
    ['   '],
    ['2026-02-30'],
    ['2026-02-29'],
    ['2026-13-01'],
    ['2026-00-10'],
    ['2026-10-00'],
    ['2026-04-31'],
    ['20260230'],
    ['2026年2月30日'],
    ['Feb 30, 2026'],
    ['Foo 1, 2026'],
    ['1 Foo 2026'],
    ['46296'],
    ['46296.5'],
    ['2026-10'],
    ['2026'],
    ['Total'],
    ['合計'],
    ['1899-12-31'],
    ['2101-01-01'],
    ['2026-10/01'],
    ['2026-10-01T'],
    ['202610011'],
    ['October 1'],
    ['昨日']
  ])('%j', (raw) => {
    expect(parseDate(raw)).toBeNull()
  })
  it('うるう年の 2 月 29 日は読める', () => {
    expect(parseDate('2028-02-29')).toBe('2028-02-29')
    expect(parseDate('2000-02-29')).toBe('2000-02-29')
  })
  it('1900 年はうるう年でない', () => {
    expect(parseDate('1900-02-29')).toBeNull()
  })
})

describe('isValidYmd・toYmd', () => {
  it('月末', () => {
    expect(isValidYmd(2026, 1, 31)).toBe(true)
    expect(isValidYmd(2026, 6, 31)).toBe(false)
  })
  it('整数でなければ false', () => {
    expect(isValidYmd(2026, 1.5, 1)).toBe(false)
  })
  it('0 埋め', () => {
    expect(toYmd(2026, 1, 2)).toBe('2026-01-02')
  })
})
