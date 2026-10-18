import { describe, expect, it } from 'vitest'
import {
  DASH,
  formatCount,
  formatDateTime,
  formatMoney,
  formatMonths,
  formatParams,
  formatPeriodRange,
  formatRate,
  formatRatio,
  intlTag,
  isCurrencyCode,
  isNum,
  parseAmount
} from '../../src/renderer/venture/format'

describe('isNum・isCurrencyCode', () => {
  it('有限の number だけを数とみなす', () => {
    expect(isNum(0)).toBe(true)
    expect(isNum(-1.5)).toBe(true)
    expect(isNum(Number.NaN)).toBe(false)
    expect(isNum(Number.POSITIVE_INFINITY)).toBe(false)
    expect(isNum(null)).toBe(false)
    expect(isNum('1')).toBe(false)
  })
  it('通貨は3文字の英字', () => {
    expect(isCurrencyCode('JPY')).toBe(true)
    expect(isCurrencyCode('usd')).toBe(true)
    expect(isCurrencyCode('YEN!')).toBe(false)
    expect(isCurrencyCode('')).toBe(false)
    expect(isCurrencyCode(null)).toBe(false)
  })
  it('言語のタグ', () => {
    expect(intlTag('ja')).toBe('ja-JP')
    expect(intlTag('en')).toBe('en-US')
  })
})

describe('formatMoney', () => {
  it('分からない金額は 0 にせず「—」', () => {
    expect(formatMoney(null, 'JPY', 'ja')).toBe(DASH)
    expect(formatMoney(undefined, 'JPY', 'en')).toBe(DASH)
    expect(formatMoney(Number.NaN, 'USD', 'en')).toBe(DASH)
    expect(formatMoney(Number.NEGATIVE_INFINITY, 'USD', 'en')).toBe(DASH)
  })
  it('0 は 0 として出す', () => {
    expect(formatMoney(0, 'USD', 'en')).toBe('$0.00')
    expect(formatMoney(0, 'JPY', 'en')).toBe('¥0')
  })
  it('JPY は小数を持たない', () => {
    expect(formatMoney(1234.6, 'JPY', 'en')).toBe('¥1,235')
    expect(formatMoney(9800, 'JPY', 'ja')).toMatch(/^[¥￥]9,800$/)
  })
  it('USD は小数2桁', () => {
    expect(formatMoney(1234.5, 'USD', 'en')).toBe('$1,234.50')
    expect(formatMoney(1234.5, 'USD', 'ja')).toMatch(/1,234\.50/)
  })
  it('負の金額', () => {
    expect(formatMoney(-500, 'USD', 'en')).toBe('-$500.00')
    expect(formatMoney(-3000, 'JPY', 'en')).toBe('-¥3,000')
  })
  it('大きな金額は桁区切り', () => {
    expect(formatMoney(1234567890, 'JPY', 'en')).toBe('¥1,234,567,890')
  })
  it('小文字の通貨も読む', () => {
    expect(formatMoney(10, 'usd', 'en')).toBe('$10.00')
  })
  it('通貨の形でなければ数だけ', () => {
    expect(formatMoney(1500, '', 'en')).toBe('1,500')
    expect(formatMoney(1500, 'YEN!', 'en')).toBe('1,500')
  })
})

describe('formatCount', () => {
  it('null・NaN は「—」、0 は 0', () => {
    expect(formatCount(null, 'en')).toBe(DASH)
    expect(formatCount(Number.NaN, 'ja')).toBe(DASH)
    expect(formatCount(0, 'en')).toBe('0')
  })
  it('桁区切りと小数1桁', () => {
    expect(formatCount(1234567, 'en')).toBe('1,234,567')
    expect(formatCount(1.26, 'en')).toBe('1.3')
    expect(formatCount(-42, 'ja')).toBe('-42')
  })
})

describe('formatRate', () => {
  it('0〜1 を % に', () => {
    expect(formatRate(0.123, 'en')).toBe('12.3%')
    expect(formatRate(0, 'en')).toBe('0%')
    expect(formatRate(1, 'ja')).toBe('100%')
  })
  it('null・NaN は「—」', () => {
    expect(formatRate(null, 'en')).toBe(DASH)
    expect(formatRate(Number.NaN, 'en')).toBe(DASH)
  })
  it('1 を超える・負の率もそのまま出す', () => {
    expect(formatRate(2.5, 'en')).toBe('250%')
    expect(formatRate(-0.05, 'en')).toBe('-5%')
  })
  it('桁を選べる（0〜4 に丸める）', () => {
    expect(formatRate(0.12345, 'en', 2)).toBe('12.35%')
    expect(formatRate(0.12345, 'en', 0)).toBe('12%')
    expect(formatRate(0.123456789, 'en', 99)).toBe('12.3457%')
    expect(formatRate(0.12, 'en', -3)).toBe('12%')
  })
})

describe('formatMonths・formatRatio', () => {
  it('月数は言語ごとの単位', () => {
    expect(formatMonths(3.25, 'ja')).toBe('3.3か月')
    expect(formatMonths(12, 'en')).toBe('12 mo')
    expect(formatMonths(0, 'en')).toBe('0 mo')
  })
  it('月数の null・負・NaN は「—」', () => {
    expect(formatMonths(null, 'ja')).toBe(DASH)
    expect(formatMonths(-1, 'ja')).toBe(DASH)
    expect(formatMonths(Number.NaN, 'en')).toBe(DASH)
  })
  it('倍率', () => {
    expect(formatRatio(3.24, 'en')).toBe('3.2×')
    expect(formatRatio(0, 'en')).toBe('0×')
    expect(formatRatio(-0.5, 'en')).toBe('-0.5×')
    expect(formatRatio(null, 'en')).toBe(DASH)
    expect(formatRatio(Number.POSITIVE_INFINITY, 'en')).toBe(DASH)
  })
})

describe('formatDateTime・formatPeriodRange', () => {
  it('日付だけはそのまま', () => {
    expect(formatDateTime('2026-10-01', 'ja')).toBe('2026-10-01')
  })
  it('空・null は「—」、読めない文字は元のまま', () => {
    expect(formatDateTime('', 'en')).toBe(DASH)
    expect(formatDateTime(null, 'en')).toBe(DASH)
    expect(formatDateTime('きのう', 'ja')).toBe('きのう')
  })
  it('時刻つきは短い形（年を含む）', () => {
    expect(formatDateTime('2026-10-18T09:00:00+09:00', 'en')).toMatch(/2026/)
  })
  it('期間', () => {
    expect(formatPeriodRange({ from: '2026-09-01', to: '2026-09-30' })).toBe('2026-09-01 – 2026-09-30')
    expect(formatPeriodRange({ from: '2026-09-01', to: '2026-09-01' })).toBe('2026-09-01')
    expect(formatPeriodRange(null)).toBe(DASH)
  })
})

describe('formatParams', () => {
  it('金額の名前は通貨で、率は % で、空文字は「—」', () => {
    expect(formatParams({ channel: 'google-ads', monthSpend: 95000, monthly: '', overDays: 2, marginRate: 0.4 }, 'JPY', 'en')).toEqual({
      channel: 'google-ads', monthSpend: '¥95,000', monthly: DASH, overDays: '2', marginRate: '40%'
    })
  })
  it('params が無ければ空', () => {
    expect(formatParams(undefined, 'JPY', 'ja')).toEqual({})
  })
  it('USD の金額', () => {
    expect(formatParams({ revenue: 12.5 }, 'USD', 'en')).toEqual({ revenue: '$12.50' })
  })
})

describe('parseAmount', () => {
  it('空は null（上限なし）', () => {
    expect(parseAmount('')).toBeNull()
    expect(parseAmount('   ')).toBeNull()
  })
  it('桁区切り・全角・通貨記号を許す', () => {
    expect(parseAmount('90,000')).toBe(90000)
    expect(parseAmount('９００００')).toBe(90000)
    expect(parseAmount('¥3,000')).toBe(3000)
    expect(parseAmount('$12.50')).toBe(12.5)
    expect(parseAmount('0')).toBe(0)
  })
  it('負・文字・指数は入力の誤り（undefined）', () => {
    expect(parseAmount('-100')).toBeUndefined()
    expect(parseAmount('abc')).toBeUndefined()
    expect(parseAmount('1e5')).toBeUndefined()
    expect(parseAmount('1.2.3')).toBeUndefined()
  })
})
