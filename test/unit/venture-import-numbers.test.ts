/**
 * 取り込みの数: 桁区切り・通貨・全角・負数・割合・値なし・読めない形
 */
import { describe, expect, it } from 'vitest'
import { parseNumber, roundAmount } from '../../src/shared/venture/import/numbers'

const v = (raw: string): number | null | 'bad' => {
  const r = parseNumber(raw)
  return r.ok ? r.value : 'bad'
}

describe('parseNumber: 読める形', () => {
  it.each([
    ['0', 0],
    ['1234', 1234],
    ['1,234', 1234],
    ['1,234,567', 1234567],
    ['1,234.56', 1234.56],
    ['12.30', 12.3],
    ['.5', 0.5],
    ['007', 7],
    ['¥1,234', 1234],
    ['￥1,234', 1234],
    ['$12.30', 12.3],
    ['US$12.30', 12.3],
    ['€9.99', 9.99],
    ['£3', 3],
    ['JPY 1000', 1000],
    ['JPY1,000', 1000],
    ['1000 JPY', 1000],
    ['1,000円', 1000],
    ['１２３', 123],
    ['１，２３４', 1234],
    ['￥１，２３４', 1234],
    [' 42 ', 42],
    ['1 234', 1234],
    ['1e3', 1000],
    ['2.5E-1', 0.25],
    ['+5', 5]
  ])('%s → %s', (raw, expected) => {
    expect(v(raw)).toBe(expected)
  })
})

describe('parseNumber: 負数', () => {
  it.each([
    ['-123', -123],
    ['(123)', -123],
    ['(1,234.50)', -1234.5],
    ['−123', -123],
    ['－１２３', -123],
    ['¥-1,234', -1234],
    ['-¥1,234', -1234],
    ['(¥500)', -500],
    ['-$1.50', -1.5]
  ])('%s → %s', (raw, expected) => {
    expect(v(raw)).toBe(expected)
  })
  it('-0 は 0', () => {
    expect(Object.is(v('-0'), 0)).toBe(true)
  })
  it('括弧と - の二重の負は読めない', () => {
    expect(v('(-5)')).toBe('bad')
  })
  it('-- の付いた数は読めない', () => {
    expect(v('--5')).toBe('bad')
  })
})

describe('parseNumber: 割合', () => {
  it('12.5% は 0.125（percent の印つき）', () => {
    expect(parseNumber('12.5%')).toEqual({ ok: true, value: 0.125, percent: true })
  })
  it('全角の ％', () => {
    expect(parseNumber('５０％')).toEqual({ ok: true, value: 0.5, percent: true })
  })
  it('100%', () => {
    expect(v('100%')).toBe(1)
  })
  it('-3%', () => {
    expect(v('-3%')).toBe(-0.03)
  })
  it('ふつうの数は percent: false', () => {
    expect(parseNumber('3')).toEqual({ ok: true, value: 3, percent: false })
  })
})

describe('parseNumber: 値なし', () => {
  it.each(['', '  ', '-', '--', '---', '—', '–', 'n/a', 'N/A', 'NaN', 'nan', 'Infinity', '-Infinity', '∞', 'null', 'none'])('%j → null', (raw) => {
    expect(v(raw)).toBeNull()
  })
  it('有限でない数（1e999）は値なし', () => {
    expect(v('1e999')).toBeNull()
  })
})

describe('parseNumber: 読めない形', () => {
  it.each([
    ['abc'],
    ['1.234,56'],
    ['12,5'],
    ['12,34'],
    ['1,23,456'],
    ['1,2345'],
    [',123'],
    ['1.2.3'],
    ['¥'],
    ['円'],
    ['12abc'],
    ['< 10'],
    ['0x10'],
    ['1/2'],
    ['１２ab'],
    ['12-'],
    ['1e'],
    ['¥¥100']
  ])('%s', (raw) => {
    expect(v(raw)).toBe('bad')
  })
  it('1.234 は欧州の千ではなく小数の 1.234', () => {
    expect(v('1.234')).toBe(1.234)
  })
})

describe('roundAmount', () => {
  it('浮動小数の誤差を丸める', () => {
    expect(roundAmount(0.1 + 0.2)).toBe(0.3)
    expect(roundAmount(12.3 - 2.1)).toBe(10.2)
  })
  it('-0 は 0', () => {
    expect(Object.is(roundAmount(-0.0000001), 0)).toBe(true)
  })
  it('整数はそのまま', () => {
    expect(roundAmount(1234)).toBe(1234)
  })
})
