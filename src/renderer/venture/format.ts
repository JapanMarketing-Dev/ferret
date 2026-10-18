/**
 * ビジネスの画面の数の書き方（純粋。test/unit/venture-format.test.ts）。
 * 分からない数（null・undefined・NaN・無限）は 0 にせず「—」で出す。
 */
export type VentureUiLocale = 'ja' | 'en'

/** 分からない数の印 */
export const DASH = '—'

const INTL_TAG: Record<VentureUiLocale, string> = { ja: 'ja-JP', en: 'en-US' }

export function intlTag(locale: VentureUiLocale): string {
  return INTL_TAG[locale] ?? 'en-US'
}

/** 使える数か（有限の number） */
export function isNum(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

/** ISO 4217 の形か（3文字の英字） */
export function isCurrencyCode(code: unknown): code is string {
  return typeof code === 'string' && /^[A-Za-z]{3}$/.test(code)
}

/** 金額。通貨の小数の桁は Intl に任せる（JPY は 0 桁、USD は 2 桁）。知らない通貨は「1,234 XXX」 */
export function formatMoney(value: number | null | undefined, currency: string, locale: VentureUiLocale): string {
  if (!isNum(value)) return DASH
  const code = isCurrencyCode(currency) ? currency.toUpperCase() : null
  if (code) {
    try {
      return new Intl.NumberFormat(intlTag(locale), { style: 'currency', currency: code }).format(value)
    } catch {
      // 知らない通貨の符号は下の形にする
    }
  }
  const n = new Intl.NumberFormat(intlTag(locale), { maximumFractionDigits: 2 }).format(value)
  return code ? `${n} ${code}` : n
}

/** 件数（整数は桁区切り、端数は小数1桁まで） */
export function formatCount(value: number | null | undefined, locale: VentureUiLocale): string {
  if (!isNum(value)) return DASH
  return new Intl.NumberFormat(intlTag(locale), { maximumFractionDigits: 1 }).format(value)
}

/** 率（0〜1 を % に）。digits は小数の桁 */
export function formatRate(rate: number | null | undefined, locale: VentureUiLocale, digits = 1): string {
  if (!isNum(rate)) return DASH
  const d = Math.max(0, Math.min(4, Math.floor(digits)))
  return new Intl.NumberFormat(intlTag(locale), { style: 'percent', minimumFractionDigits: 0, maximumFractionDigits: d }).format(rate)
}

/** 月数（回収期間など）。負は意味を持たないので「—」 */
export function formatMonths(months: number | null | undefined, locale: VentureUiLocale): string {
  if (!isNum(months) || months < 0) return DASH
  const n = new Intl.NumberFormat(intlTag(locale), { maximumFractionDigits: 1 }).format(months)
  return locale === 'ja' ? `${n}か月` : `${n} mo`
}

/** 倍率（LTV/CAC など）。「3.2×」 */
export function formatRatio(ratio: number | null | undefined, locale: VentureUiLocale): string {
  if (!isNum(ratio)) return DASH
  return `${new Intl.NumberFormat(intlTag(locale), { maximumFractionDigits: 1 }).format(ratio)}×`
}

/** 日時（ISO の文字列）。日付だけならそのまま、時刻つきは画面の言語の短い形。読めなければ元の文字列（空なら「—」） */
export function formatDateTime(value: string | null | undefined, locale: VentureUiLocale): string {
  if (typeof value !== 'string' || value.trim() === '') return DASH
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value
  const ms = Date.parse(value)
  if (!Number.isFinite(ms)) return value
  return new Intl.DateTimeFormat(intlTag(locale), { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(ms)
}

/** 期間（両端を含む）。無ければ「—」 */
export function formatPeriodRange(period: { from: string; to: string } | null | undefined): string {
  if (!period || typeof period.from !== 'string' || typeof period.to !== 'string') return DASH
  return period.from === period.to ? period.from : `${period.from} – ${period.to}`
}

/** 金額として出す差し込みの名前（注意・フェーズの params） */
const MONEY_PARAMS: ReadonlySet<string> = new Set(['monthSpend', 'monthly', 'daily', 'revenue', 'spend', 'profit'])
/** 率として出す差し込みの名前 */
const RATE_PARAMS: ReadonlySet<string> = new Set(['marginRate'])

/**
 * 注意・フェーズの差し込み（params）を画面の文字に直す。金額の名前は通貨で、率は % で、空文字は「—」。
 * 文字（経路の名前など）はそのまま
 */
export function formatParams(params: Record<string, number | string> | undefined, currency: string, locale: VentureUiLocale): Record<string, string> {
  const out: Record<string, string> = {}
  if (!params) return out
  for (const [key, value] of Object.entries(params)) {
    if (value === '' || value === null || value === undefined) out[key] = DASH
    else if (typeof value === 'number') {
      if (MONEY_PARAMS.has(key)) out[key] = formatMoney(value, currency, locale)
      else if (RATE_PARAMS.has(key)) out[key] = formatRate(value, locale)
      else out[key] = formatCount(value, locale)
    } else out[key] = String(value)
  }
  return out
}

/** 入力欄の金額を読む。空は null（上限なし）、読めない・負は undefined（入力の誤り）。桁区切り・全角・通貨記号は許す */
export function parseAmount(text: string): number | null | undefined {
  const normalized = String(text ?? '')
    .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/[，,＿_\s]/g, '')
    .replace(/[¥￥$€£]/g, '')
    .replace(/．/g, '.')
  if (normalized === '') return null
  if (!/^\d+(\.\d+)?$/.test(normalized)) return undefined
  const n = Number(normalized)
  return Number.isFinite(n) && n >= 0 ? n : undefined
}
