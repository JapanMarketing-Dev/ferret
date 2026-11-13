/**
 * 何もしていない間の読み直しの間隔（フッターの git・Resource Manager）。画面の部品から分けて、単体テストで確かめる
 */

/** フッターの git：変化の通知（.git の HEAD・index、ファイルの変更）が届かなかったときの予備の読み直し */
export const GIT_STATUS_POLL_MS = 5 * 60_000
/** ウインドウを前に出したときは、前回の読み取りからこれ以上たっていれば読み直す */
export const FOCUS_RELOAD_MIN_GAP_MS = 30_000
/** ファイルの変更の通知をまとめる待ちと、続けて読み直すときの最小の間（Agent が書き続けている間も git を走らせ続けない） */
export const FS_RELOAD_DEBOUNCE_MS = 2_000
export const FS_RELOAD_MIN_GAP_MS = 30_000

/** いまから次に読み直すまでの待ち（前回の読み取りの開始 lastAt から minGap は空ける。まだ読んでいなければ debounce だけ） */
export function reloadDelay(now: number, lastAt: number | null, debounceMs: number, minGapMs: number): number {
  return Math.max(debounceMs, lastAt === null ? 0 : lastAt + minGapMs - now)
}

/** Resource Manager を開いている間の間隔 */
export const RESOURCE_OPEN_POLL_MS = 1500
/** 閉じていて、フッターの数字だけを保つ間隔 */
export const RESOURCE_CLOSED_POLL_MS = 60_000

/** Resource Manager のいまの間隔（null は取らない。数字も「…」に隠れているとき） */
export function resourcePollMs(open: boolean, numberVisible: boolean): number | null {
  if (open) return RESOURCE_OPEN_POLL_MS
  return numberVisible ? RESOURCE_CLOSED_POLL_MS : null
}
