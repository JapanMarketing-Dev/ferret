import { useCallback, useSyncExternalStore } from 'react'
import {
  getLocale,
  normalizeLocalePreference,
  onLocaleChange,
  loadLocale,
  setLocale,
  switchLocale,
  translate,
  type LocalePreference,
  type MessageParams,
  type SupportedLocale,
  type TranslationKey
} from '@shared/i18n'

/**
 * renderer の画面の言語。
 * 解決は main が持つ（「システムに合わせる」は OS の優先言語で決める）。renderer は届いた言語を使うだけにする。
 *   起動時 … window.ade.initialLocale（main が additionalArguments で渡す）
 *   変更時 … 'locale:changed' イベント
 * テーマ（lib/theme.ts）と同じ形にしている。
 */

let preference: LocalePreference = 'system'
const preferenceListeners = new Set<() => void>()

/**
 * 起動時に1度だけ呼び、終わるのを待ってから描画する。保存済みの設定は後から届く。
 * 辞書は今の言語の分だけを読み込む（もう一方は言語を変えたときに読む）
 */
export async function initLocale(): Promise<void> {
  try {
    // ja は型で欠けを検査しているので、英語（欠けたキーの後退先）は読まなくてよい
    await loadLocale(window.ade.initialLocale)
  } catch {
    // 辞書が読めなくても描画は止めない（キーがそのまま出る）
  }
  setLocale(window.ade.initialLocale)
  document.documentElement.lang = getLocale()
  onLocaleChange((locale) => {
    document.documentElement.lang = locale
  })
  window.ade.on('locale:changed', (locale) => void switchLocale(locale))
  // settings.json の外部の変更。解決済みの言語は 'locale:changed' で届くので、選択肢の表示だけ合わせる
  window.ade.on('settings:changed', (settings) => {
    preference = normalizeLocalePreference(settings.locale)
    for (const listener of preferenceListeners) listener()
  })
  void window.ade
    .invoke('app:settings')
    .then((settings) => {
      preference = normalizeLocalePreference(settings.locale)
      for (const listener of preferenceListeners) listener()
    })
    .catch(() => {
      // 設定が読めなくても、起動時の言語のまま使える
    })
}

function setLocalePreference(next: LocalePreference): void {
  preference = next
  for (const listener of preferenceListeners) listener()
  void window.ade.invoke('settings:locale', next).then(switchLocale).catch(() => {}) // 失敗は main の IPC が Sentry へ送る（ここは既定のまま続ける）
}

/** 言語が変わると再描画する。t は言語ごとに作り直すので、依存配列に入れれば追従する */
export function useLocale(): SupportedLocale {
  return useSyncExternalStore(onLocaleChange, getLocale)
}

export type TFunction = (key: TranslationKey, params?: MessageParams) => string

export function useT(): TFunction {
  const locale = useLocale()
  return useCallback((key: TranslationKey, params?: MessageParams) => translate(locale, key, params), [locale])
}

function subscribePreference(listener: () => void): () => void {
  preferenceListeners.add(listener)
  return () => preferenceListeners.delete(listener)
}

/** 設定画面の切り替えUIから使う */
export function useLocalePreference(): [LocalePreference, (next: LocalePreference) => void] {
  const value = useSyncExternalStore(subscribePreference, () => preference)
  return [value, setLocalePreference]
}
