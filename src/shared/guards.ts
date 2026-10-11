/**
 * 外から読んだ値（JSON・設定・API の応答）の形を確かめる小さな関数（いくつかのファイルで同じものを書いていた）
 */

/** 配列でない object か（null は除く） */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 配列でない object ならそのまま、違えば null */
export function asRecord(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null
}
