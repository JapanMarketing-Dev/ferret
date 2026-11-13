import { app } from 'electron'
import { registerLocale, resolveLocale, setLocale, type LocalePreference, type SupportedLocale } from '@shared/i18n'
import { en } from '@shared/i18n/en'
import { ja } from '@shared/i18n/ja'
import { reportHandled } from '@shared/report'

// main は画面と違う言語（録画の言語など）でも文を作るので、両方の辞書を最初から入れておく（renderer は今の言語だけを読む）
registerLocale('en', en)
registerLocale('ja', ja)

/**
 * main の画面の言語（メニュー・ダイアログ・エラー・通知）。
 * 「システムに合わせる」は OS の優先言語の並びから選ぶ。
 * Orca由来: ~/bench/orca/src/main/i18n/main-i18n.ts の getMainSystemLocale / setMainUiLanguage（MIT）
 */

export function systemLocales(): string[] {
  try {
    const preferred = app.getPreferredSystemLanguages()
    return preferred.length ? preferred : [app.getLocale()]
  } catch (err) {
    reportHandled(err, { area: 'settings', op: 'read system locales' })
    return []
  }
}

/** 設定値から言語を決めて切り替える。メニューは onLocaleChange で作り直される */
export function applyLocalePreference(preference: LocalePreference | undefined): SupportedLocale {
  const locale = resolveLocale(preference, systemLocales())
  setLocale(locale)
  return locale
}
