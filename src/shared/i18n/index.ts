import { en, type MessageKey, type Messages } from './en'
import { ja } from './ja'

/**
 * 画面の言語（UI の文言）。日本語と英語だけ（ほかの言語は保守の手間に見合わないので 0.6.14 でやめた）。
 * main と renderer の両方が同じ t() を使う。
 * 文字起こしの言語（CapturePreferences.language）とは別の軸で、互いに影響しない。
 *
 * 言語を足すには:
 *   1. このフォルダに <code>.ts を置き、`export const xx: LocaleMessages = { ... }` を書く
 *      （en.ts のキーが正本。欠け・余分・{{変数}} の不一致は test/unit/i18n.test.ts が落とす。
 *       ja だけは型でも欠けを検査する）
 *   2. 下の LOCALES・LOCALE_LABELS・INTL_TAG に1行ずつ足す
 * 欠けたキーは実行時に英語で出る。
 *
 * 大きなライブラリ（i18next）は持ち込まず、小さな自前の t() にしている。
 * 使うのは「キー → 文」「{{name}} の置き換え」「数による単数・複数」「英語への後退」だけで、
 * 辞書は数千キーの文字列なので、遅延読み込みや名前空間は要らないため。
 */

export type { MessageKey, Messages } from './en'

export const LOCALES = {
  en,
  ja
} satisfies Record<string, Readonly<Record<string, string>>>
export type SupportedLocale = keyof typeof LOCALES
export type LocalePreference = 'system' | SupportedLocale

export const DEFAULT_LOCALE: SupportedLocale = 'en'

/** 画面に出す製品名。どの言語でも同じ表記（辞書の文中の名前もこれにそろえる） */
export const PRODUCT_NAME = 'Ferret'
export const SUPPORTED_LOCALES = Object.keys(LOCALES) as SupportedLocale[]
export const LOCALE_PREFERENCES: readonly LocalePreference[] = ['system', ...SUPPORTED_LOCALES]

/** 言語の名前は、どの言語の画面でもその言語自身の表記で出す（Orca と同じ） */
export const LOCALE_LABELS: Record<SupportedLocale, string> = {
  en: 'English',
  ja: '日本語'
}

export function isSupportedLocale(value: unknown): value is SupportedLocale {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(LOCALES, value)
}

/** 保存値の検査。未設定は system、知らない言語は英語にする（設定の sanitize が使う） */
export function normalizeLocalePreference(value: unknown): LocalePreference {
  if (value === undefined || value === null || value === '' || value === 'system') return 'system'
  return isSupportedLocale(value) ? value : DEFAULT_LOCALE
}

/**
 * OS の言語タグ（ja-JP / en_US など）を、持っている辞書（日本語・英語）へ寄せる。無ければ英語。
 * Orca由来: ~/bench/orca/src/shared/ui-locale.ts の normalizeSupportedUiLocale（MIT）
 */
function matchLocale(tag: string | null | undefined): SupportedLocale | null {
  const norm = (tag ?? '').trim().toLowerCase().replace(/_/g, '-')
  const [primary] = norm.split('-')
  if (!primary) return null
  return isSupportedLocale(primary) ? primary : null
}

export function normalizeSystemLocale(tag: string | null | undefined): SupportedLocale {
  return matchLocale(tag) ?? DEFAULT_LOCALE
}

/**
 * 設定値と OS の言語から、実際に使う言語を決める。
 * systemLocales は優先順の並び（app.getPreferredSystemLanguages() / navigator.languages）。
 * 先頭が対応外でも、2番目以降に対応する言語があればそれを使う。
 */
export function resolveLocale(preference: LocalePreference | undefined, systemLocales: readonly string[] | string = []): SupportedLocale {
  if (preference && preference !== 'system' && isSupportedLocale(preference)) return preference
  const list = typeof systemLocales === 'string' ? [systemLocales] : systemLocales
  for (const tag of list) {
    const match = matchLocale(tag)
    if (match) return match
  }
  return DEFAULT_LOCALE
}

// ---- 今の言語（プロセスごとに1つ） ----

let current: SupportedLocale = DEFAULT_LOCALE
const listeners = new Set<(locale: SupportedLocale) => void>()

export function getLocale(): SupportedLocale {
  return current
}

export function setLocale(locale: SupportedLocale): void {
  if (!isSupportedLocale(locale) || locale === current) return
  current = locale
  for (const listener of listeners) listener(locale)
}

export function onLocaleChange(listener: (locale: SupportedLocale) => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

// ---- 文の取り出し ----

export type MessageParams = Record<string, string | number | null | undefined>

/** `foo_one` / `foo_other` の組は、`foo` と数（count）で引ける */
type PluralBase<K extends string> = K extends `${infer B}_other` ? B : never
export type TranslationKey = MessageKey | PluralBase<MessageKey>

/**
 * {{name}} を params で置き換える。足りない変数は {{name}} のまま残す（欠けに気づけるように）。
 * Orca由来: ~/bench/orca/src/renderer/src/i18n/i18n.ts の interpolation（i18next の {{name}} 記法、MIT）
 */
export function interpolate(text: string, params?: MessageParams): string {
  if (!params) return text
  return text.replace(/\{\{\s*(\w+)\s*\}\}/g, (whole, name: string) => {
    const value = params[name]
    return value === undefined || value === null ? whole : String(value)
  })
}

function lookup(dict: Partial<Messages>, key: string): string | undefined {
  const value = (dict as Record<string, string | undefined>)[key]
  return typeof value === 'string' ? value : undefined
}

/**
 * キーから今の言語の文を返す。
 * - params.count が数なら、Intl.PluralRules で `key_one` / `key_other` を選ぶ（i18next と同じ接尾辞）
 * - 今の言語に無いキーは英語へ、英語にも無ければキーそのものを返す
 *   （Orca の fallbackLng: 'en' と同じ。画面が空になるより、英語やキーが見えるほうが気づける）
 */
export function translate(locale: SupportedLocale, key: TranslationKey, params?: MessageParams): string {
  const dict: Partial<Messages> = LOCALES[locale] ?? en
  let text: string | undefined
  if (typeof params?.count === 'number') {
    const form = new Intl.PluralRules(locale).select(params.count)
    text = lookup(dict, `${key}_${form}`) ?? lookup(dict, `${key}_other`) ?? lookup(en, `${key}_${form}`) ?? lookup(en, `${key}_other`)
  }
  text ??= lookup(dict, key) ?? lookup(en, key) ?? key
  return interpolate(text, params)
}

export function t(key: TranslationKey, params?: MessageParams): string {
  return translate(current, key, params)
}

// ---- 日付と数の書式 ----
// Orca由来: ~/bench/orca/src/renderer/src/i18n/relative-time-format.ts（MIT）
//   言葉を含む書式は OS の地域ではなく画面の言語に合わせ、言語ごとに書式器を作り直す。

const INTL_TAG: Record<SupportedLocale, string> = {
  en: 'en-US',
  ja: 'ja-JP'
}

export function intlLocale(locale: SupportedLocale = current): string {
  return INTL_TAG[locale] ?? 'en-US'
}

export function formatDate(value: number | Date, options?: Intl.DateTimeFormatOptions): string {
  return new Date(value).toLocaleDateString(intlLocale(), options)
}

export function formatTime(value: number | Date, options: Intl.DateTimeFormatOptions = { hour: '2-digit', minute: '2-digit' }): string {
  return new Date(value).toLocaleTimeString(intlLocale(), options)
}

export function formatDateTime(value: number | Date, options?: Intl.DateTimeFormatOptions): string {
  return new Date(value).toLocaleString(intlLocale(), options)
}
