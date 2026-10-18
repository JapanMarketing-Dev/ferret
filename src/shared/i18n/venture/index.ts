import { uiEn } from './ui.en'
import { uiJa } from './ui.ja'
import { mainEn } from './main.en'
import { mainJa } from './main.ja'

/**
 * ビジネス（venture）の文言。en.ts / ja.ts へ1行ずつ広げて入れる（キーは `venture.` で始める）。
 * ui は画面（src/renderer/venture）、main は main のエラー・ダイアログ（src/main/venture）。それぞれの担当だけが書き換える。
 * 英語が正本で、日本語は同じキーをすべて持つ（型で検査する）。
 */
export const ventureEn = { ...uiEn, ...mainEn } as const
export const ventureJa: Record<keyof typeof ventureEn, string> = { ...uiJa, ...mainJa }
