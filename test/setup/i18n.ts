import { registerLocale } from '@shared/i18n'
import { en } from '@shared/i18n/en'
import { ja } from '@shared/i18n/ja'

/** 辞書は実行時に読み込む（src/shared/i18n/index.ts）。テストでは main と同じく両方を最初から入れておく */
registerLocale('en', en)
registerLocale('ja', ja)
