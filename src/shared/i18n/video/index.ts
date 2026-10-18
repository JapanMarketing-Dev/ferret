import { tabEn } from './tab.en'
import { tabJa } from './tab.ja'
import { recordEn } from './record.en'
import { recordJa } from './record.ja'
import { publishEn } from './publish.en'
import { publishJa } from './publish.ja'

/**
 * 動画づくりの画面の文言。en.ts / ja.ts へ1行ずつ広げて入れる（キーは `video.` で始める）。
 * 機能ごとのファイル（tab・record・publish）はその担当だけが書き換える。
 * 英語が正本で、日本語は同じキーをすべて持つ（型で検査する）。
 */
export const videoEn = { ...tabEn, ...recordEn, ...publishEn } as const
export const videoJa: Record<keyof typeof videoEn, string> = { ...tabJa, ...recordJa, ...publishJa }
