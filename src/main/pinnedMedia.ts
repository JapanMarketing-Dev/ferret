import { randomBytes } from 'node:crypto'

/**
 * 裏で動く処理（削った版を作る・mtg の取り込み）が読む動画を、作り始めたときのレビューのフォルダに固定して渡す口
 * （ade-media://review/pinned/<合言葉>。index.ts が返す）。
 *
 * ade-media://review/<id>/recording.webm は「いま開いているプロジェクト」の中で探す。
 * 録画を止めてから文字起こしが終わるまでの間などにプロジェクトを切り替えると、別のプロジェクトで探して 404 になり、
 * 動画が開けず（DEMUXER_ERROR_COULD_NOT_OPEN）失敗していた（FERRET-2D の 0.8.16 の Windows）。
 * 裏の処理の非表示ウィンドウには、プロジェクトに依らないこの口を渡す（画面の ▷ は今まで通りの URL）。
 * 合言葉は処理の間だけ有効で、終わったら release で消す。読むのは登録したフォルダの中の、登録したファイルだけ
 */
export interface PinnedMedia {
  dir: string
  file: string
  contentType: string
}

const pinned = new Map<string, PinnedMedia>()
const PINNED_PATH = /^\/pinned\/([0-9a-f]{32})$/

export function pinMedia(dir: string, file: string, contentType: string): { url: string; release: () => void } {
  const token = randomBytes(16).toString('hex')
  pinned.set(token, { dir, file, contentType })
  return { url: `ade-media://review/pinned/${token}`, release: () => { pinned.delete(token) } }
}

/** ade-media://review の pathname から、固定した動画を引く（無い・消えたものは null） */
export function pinnedMediaFor(pathname: string): PinnedMedia | null {
  const m = PINNED_PATH.exec(pathname)
  return m ? pinned.get(m[1]!) ?? null : null
}
