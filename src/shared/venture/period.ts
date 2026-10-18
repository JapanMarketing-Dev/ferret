/**
 * 集計の期間と日付の小さな計算（docs/venture.md 4章）。日付は YYYY-MM-DD の文字列で持ち、UTC で計算する（TZ に依存しない）。
 */
import type { MetricRow, Period, PeriodPreset } from './model'

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/
const DAY_MS = 86_400_000

/** YYYY-MM-DD の UTC の 0 時（ms）。暦に無い日（2月30日など）・形の違う値は null */
function toUtc(date: unknown): number | null {
  if (typeof date !== 'string') return null
  const m = ISO_DATE.exec(date)
  if (!m) return null
  const y = Number(m[1])
  const mo = Number(m[2])
  const d = Number(m[3])
  const t = Date.UTC(y, mo - 1, d)
  const back = new Date(t)
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) return null
  return t
}

function fromUtc(t: number): string {
  return new Date(t).toISOString().slice(0, 10)
}

/** 暦にある YYYY-MM-DD か */
export function isIsoDate(value: unknown): value is string {
  return toUtc(value) !== null
}

/** 日付か日時（2026-10-01T09:00:00Z など）の先頭の日付。暦に無い・形の違う値は null */
export function dayOf(value: unknown): string | null {
  if (typeof value !== 'string' || value.length < 10) return null
  const d = value.slice(0, 10)
  if (value.length > 10 && !/^[T ]/.test(value.slice(10, 11))) return null
  return isIsoDate(d) ? d : null
}

/** date の n 日後（負なら前）。日付でない・n が整数でなければ null */
export function addDays(date: string, n: number): string | null {
  const t = toUtc(date)
  if (t === null || !Number.isInteger(n)) return null
  return fromUtc(t + n * DAY_MS)
}

/** from から to までの日数（to − from。同じ日なら 0）。どちらかが日付でなければ null */
export function daysBetween(from: string, to: string): number | null {
  const a = toUtc(from)
  const b = toUtc(to)
  if (a === null || b === null) return null
  return Math.round((b - a) / DAY_MS)
}

/** 期間の日数（両端を含む。from > to や日付でなければ 0） */
export function periodDays(period: Period): number {
  const n = daysBetween(period.from, period.to)
  return n === null || n < 0 ? 0 : n + 1
}

/** その月の1日 */
export function monthStart(date: string): string {
  return `${date.slice(0, 7)}-01`
}

/** 月の鍵（YYYY-MM） */
export function monthKey(date: string): string {
  return date.slice(0, 7)
}

/** 前の月の鍵（2026-01 → 2025-12） */
export function prevMonthKey(key: string): string {
  const y = Number(key.slice(0, 4))
  const m = Number(key.slice(5, 7))
  return m <= 1 ? `${String(y - 1).padStart(4, '0')}-12` : `${key.slice(0, 4)}-${String(m - 1).padStart(2, '0')}`
}

/** 日付が期間に入るか（両端を含む）。period が null なら期間で絞らない（日付として正しければ true） */
export function inPeriod(date: unknown, period: Period | null): boolean {
  if (!isIsoDate(date)) return false
  if (period === null) return true
  return date >= period.from && date <= period.to
}

/** 行の日付の最小〜最大（正しい日付の行が無ければ null） */
export function dataRange(rows: readonly MetricRow[]): Period | null {
  let from: string | null = null
  let to: string | null = null
  for (const r of Array.isArray(rows) ? rows : []) {
    const d = r?.date
    if (!isIsoDate(d)) continue
    if (from === null || d < from) from = d
    if (to === null || d > to) to = d
  }
  return from !== null && to !== null ? { from, to } : null
}

/**
 * 期間の決まり（両端を含む）。
 * 30d・90d … today を含む過去 N 日 / month … today の月の1日〜today / all … データの最小〜最大日（データが無ければ null）。
 * today が日付でなければ（all 以外は）null
 */
export function resolvePeriod(preset: PeriodPreset, today: string, rows: readonly MetricRow[]): Period | null {
  if (preset === 'all') return dataRange(rows)
  if (!isIsoDate(today)) return null
  if (preset === 'month') return { from: monthStart(today), to: today }
  const days = preset === '90d' ? 90 : 30
  const from = addDays(today, -(days - 1))
  return from === null ? null : { from, to: today }
}
