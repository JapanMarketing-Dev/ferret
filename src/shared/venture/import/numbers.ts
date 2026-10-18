/**
 * 取り込みの数の読み取り（純粋）。
 *
 * 受ける形: "1234"・"1,234"・"1,234.56"・"¥1,234"・"￥1,234"・"$12.30"・"JPY 1000"・"1000 円"・全角の「１２３」・
 * "(123)" と "-123"・"−123"（負数）・"12.5%"（0.125）・"1e3"。通貨の3文字は大文字だけ（ISO 4217。"12abc" は読まない）。
 * 値なし（null）: ""・"-"・"--"・"—"・"n/a"・"NaN"・"Infinity"、計算して有限でない数（"1e999" など）。
 *
 * 欧州の形（"1.234,56"・"12,5"）は読まない（ok: false）。"1.234" は小数の 1.234 と読む。
 * 取り込む元（Google・Meta・Stripe ほか）は日英の書き出しで小数点が "."。カンマを小数点とみなすと
 * "1,234"（千二百三十四）を 1.234 と取り違えるので、どちらとも決められない形は人に見せて直してもらう（badNumber）。
 */

export type NumberParse = { ok: true; value: number | null; percent: boolean } | { ok: false }

const EMPTY_MARKERS = new Set(['', '-', '--', '---', '—', '–', '―', 'n/a', 'na', 'null', 'none', 'nan', 'infinity', '+infinity', '-infinity', '∞'])

const PLAIN = /^(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?$/
const LEADING_DOT = /^\.\d+$/
const EXPONENT = /^\d+(?:\.\d+)?e[+-]?\d+$/i
const CURRENCY_PREFIX = /^(?:US\$|[¥$€£₩]|[A-Z]{3}(?=[\d.(]))/
const CURRENCY_SUFFIX = /(?:[¥$€£₩]|円|(?<=[\d.])[A-Z]{3})$/

export function parseNumber(raw: string): NumberParse {
  let s = raw.normalize('NFKC').replace(/\s+/g, '')
  if (EMPTY_MARKERS.has(s.toLowerCase())) return { ok: true, value: null, percent: false }
  s = s.replace(/[−‒﹣]/g, '-')
  let negative = false
  const paren = /^\((.*)\)$/.exec(s)
  if (paren) {
    negative = true
    s = paren[1]
  }
  const sign = (): boolean => {
    if (s.startsWith('-') || s.startsWith('+')) {
      if (s.startsWith('-')) {
        if (negative) return false
        negative = true
      }
      s = s.slice(1)
    }
    return true
  }
  if (!sign()) return { ok: false }
  s = s.replace(CURRENCY_PREFIX, '')
  if (!sign()) return { ok: false }
  s = s.replace(CURRENCY_SUFFIX, '')
  let percent = false
  if (s.endsWith('%')) {
    percent = true
    s = s.slice(0, -1)
  }
  if (!(PLAIN.test(s) || LEADING_DOT.test(s) || EXPONENT.test(s))) return { ok: false }
  let value = Number(s.replace(/,/g, ''))
  if (!Number.isFinite(value)) return { ok: true, value: null, percent }
  if (percent) value = value / 100
  if (negative) value = -value
  return { ok: true, value: value === 0 ? 0 : value, percent }
}

/** 金額などの小さな誤差（0.1 + 0.2）を丸める */
export function roundAmount(n: number): number {
  const r = Math.round(n * 1e6) / 1e6
  return r === 0 ? 0 : r
}
