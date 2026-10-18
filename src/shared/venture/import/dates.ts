/**
 * 取り込みの日付 → YYYY-MM-DD（純粋）。読めなければ null（取り込みの問題 badDate）。
 *
 * 受ける形:
 * - "2026-10-01"・"2026/10/1"・"2026.10.1"（区切りはそろえる）、日時つき "2026-10-01 12:34:56"（日付の部分）
 * - タイムゾーンつき "2026-10-01T03:00:00Z"・"…+09:00"・"… UTC" は UTC の日付（Stripe の Created date (UTC) と同じ考え方）
 * - "20261001"（GA4）
 * - "2026年10月1日"・"2026年10月1日(木)"・"令和8年10月1日"（元年も）・"平成31年4月30日"
 * - "Oct 1, 2026"・"October 1, 2026"・"Sept 1, 2026"・"1 Oct 2026"・"1-Oct-2026"・"Thu, Oct 1, 2026"
 * - "10/01/2026" のような月日の順が決まらない形は、どちらかが 13 以上で決まるとき（と月日が同じとき）だけ。決まらなければ null
 *
 * Excel のシリアル値（46296 など）は読まない: 1900 年起点と 1904 年起点（Mac の旧 Excel）のどちらか書き出しからは分からず、
 * 1900 年のうるう年の誤り（存在しない 1900-02-29）も混ざるので、1日ずれた数を黙って入れるおそれがある。
 * 存在しない日（2026-02-30）・1900 年より前と 2100 年より後は null。
 */

const MONTHS: Record<string, number> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4, may: 5, jun: 6, june: 6,
  jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9, september: 9, oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12
}

const ERAS: Record<string, number> = { 令和: 2018, 平成: 1988 }

const ISO = /^(\d{4})([-/.])(\d{1,2})\2(\d{1,2})(?:(?:T|\s+)(\d{1,2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?\s*(Z|UTC|GMT|[+-]\d{2}:?\d{2})?)?$/i
const COMPACT = /^(\d{4})(\d{2})(\d{2})$/
const KANJI = /^(\d{4})年(\d{1,2})月(\d{1,2})日(?:\([^)]*\))?(?:\d{1,2}:\d{2}(?::\d{2})?)?$/
const ERA = /^(令和|平成)(\d{1,2}|元)年(\d{1,2})月(\d{1,2})日(?:\([^)]*\))?$/
const WEEKDAY = /^(?:mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun)[a-z]*\.?,?\s+/i
const MONTH_FIRST = /^([a-z]+)\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})$/i
const DAY_FIRST = /^(\d{1,2})(?:st|nd|rd|th)?[\s-]+([a-z]+)\.?,?[\s-]+(\d{4})$/i
const AMBIGUOUS = /^(\d{1,2})([/.-])(\d{1,2})\2(\d{4})(?:\s+\d{1,2}:\d{2}(?::\d{2})?)?$/

export function parseDate(raw: string): string | null {
  const s = raw.normalize('NFKC').trim().replace(/\s+/g, ' ')
  if (s === '') return null
  let m = ISO.exec(s)
  if (m) {
    const [y, mo, d] = [Number(m[1]), Number(m[3]), Number(m[4])]
    if (!isValidYmd(y, mo, d)) return null
    if (m[5] === undefined) return toYmd(y, mo, d)
    const [h, mi, sec] = [Number(m[5]), Number(m[6]), Number(m[7] ?? 0)]
    if (h > 23 || mi > 59 || sec > 59) return null
    const offset = zoneOffsetMinutes(m[8])
    if (offset === null) return toYmd(y, mo, d)
    const utc = new Date(Date.UTC(y, mo - 1, d, h, mi, sec) - offset * 60_000)
    return toYmd(utc.getUTCFullYear(), utc.getUTCMonth() + 1, utc.getUTCDate())
  }
  m = COMPACT.exec(s)
  if (m) return ymdOrNull(Number(m[1]), Number(m[2]), Number(m[3]))
  const noSpace = s.replace(/ /g, '')
  m = KANJI.exec(noSpace)
  if (m) return ymdOrNull(Number(m[1]), Number(m[2]), Number(m[3]))
  m = ERA.exec(noSpace)
  if (m) return ymdOrNull(ERAS[m[1]] + (m[2] === '元' ? 1 : Number(m[2])), Number(m[3]), Number(m[4]))
  const en = s.replace(WEEKDAY, '')
  m = MONTH_FIRST.exec(en)
  if (m) return monthName(m[1]) ? ymdOrNull(Number(m[3]), monthName(m[1])!, Number(m[2])) : null
  m = DAY_FIRST.exec(en)
  if (m) return monthName(m[2]) ? ymdOrNull(Number(m[3]), monthName(m[2])!, Number(m[1])) : null
  m = AMBIGUOUS.exec(s)
  if (m) {
    const [a, b, y] = [Number(m[1]), Number(m[3]), Number(m[4])]
    if (a === b) return ymdOrNull(y, a, b)
    if (a > 12 && b <= 12) return ymdOrNull(y, b, a)
    if (b > 12 && a <= 12) return ymdOrNull(y, a, b)
    return null
  }
  return null
}

function monthName(name: string): number | null {
  return MONTHS[name.toLowerCase()] ?? null
}

/** Z・UTC・GMT は 0、+09:00 は 540。無ければ null（日付の部分をそのまま使う） */
function zoneOffsetMinutes(zone: string | undefined): number | null {
  if (zone === undefined) return null
  if (/^(z|utc|gmt)$/i.test(zone)) return 0
  const m = /^([+-])(\d{2}):?(\d{2})$/.exec(zone)
  if (!m) return null
  const minutes = Number(m[2]) * 60 + Number(m[3])
  return m[1] === '-' ? -minutes : minutes
}

function ymdOrNull(y: number, m: number, d: number): string | null {
  return isValidYmd(y, m, d) ? toYmd(y, m, d) : null
}

/** 存在する日か（1900〜2100 年） */
export function isValidYmd(y: number, m: number, d: number): boolean {
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) return false
  if (y < 1900 || y > 2100 || m < 1 || m > 12 || d < 1) return false
  const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1]
  return d <= days
}

export function toYmd(y: number, m: number, d: number): string {
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
}
