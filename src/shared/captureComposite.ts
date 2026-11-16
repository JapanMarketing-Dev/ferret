/**
 * 複数の画面・ウインドウを同時に録るとき、1本の動画に並べる配置（録画ウインドウ recorder.ts の DesktopCompositor が使う）。
 * Electron・DOM に依存しない純粋な計算だけを置く（単体テストで確かめる）。
 *
 * - 枠（cell）は格子に並べる。2つは横に2つ、3〜4つは 2×2
 * - 動画の大きさは録画の途中で変えない（WebM の途中で解像度が変わると見返しで乱れる）。最初に分かった大きさで枠を決め、
 *   あとでウインドウの大きさが変わっても、枠の中に縦横比を保って収める（fitInto）
 * - 横幅は videoMaxWidth を超えない。0（原寸）のときも 3840px で止める
 */

export interface Size {
  width: number
  height: number
}

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

/** 1本の動画に並べる映像の数の上限（最初の対象を含む）。映像ごとに取り込みと縮小が走るので、重くしすぎない */
export const MAX_COMPOSITE_SOURCES = 4

/** 原寸（videoMaxWidth が 0）のときの横幅の上限 */
export const COMPOSITE_MAX_WIDTH = 3840
/** 縦の上限（縦長の画面が並んでも大きくしすぎない） */
export const COMPOSITE_MAX_HEIGHT = 2160
/** 枠の間の隙間(px) */
export const COMPOSITE_GAP = 8

/** 何列に並べるか（1 → 1列、2 → 2列、3〜4 → 2列、5〜9 → 3列） */
export function compositeColumns(count: number): number {
  if (count <= 1) return 1
  return Math.ceil(Math.sqrt(count))
}

/** 符号化しやすいよう偶数にする（VP8 は奇数の幅でも動くが、縮小のときにずれが出にくい） */
function even(n: number): number {
  return Math.max(2, Math.round(n / 2) * 2)
}

/**
 * 並べ方を決める。sizes は各映像の大きさ（まだ分からないものは 16:10 とみなす）。
 * 枠の幅はどれも同じで、高さは「その幅に合わせたときに一番高くなる映像」に合わせる（行ごとではなく全体で揃える）。
 */
export function compositeLayout(sizes: readonly Size[], maxWidth: number): { width: number; height: number; cells: Rect[] } {
  const count = Math.max(1, sizes.length)
  const cols = compositeColumns(count)
  const rows = Math.ceil(count / cols)
  const known = sizes.map((s) => (s.width > 0 && s.height > 0 ? s : { width: 1600, height: 1000 }))
  const widest = Math.max(...known.map((s) => s.width), 1)
  const limit = maxWidth > 0 ? maxWidth : COMPOSITE_MAX_WIDTH
  // 横幅は「一番広い映像を原寸で並べた幅」と上限の小さい方
  const total = Math.min(limit, COMPOSITE_MAX_WIDTH, widest * cols + COMPOSITE_GAP * (cols - 1))
  let cellWidth = Math.max(16, Math.floor((total - COMPOSITE_GAP * (cols - 1)) / cols))
  // 枠の高さ: その幅に合わせたときの各映像の高さの最大
  let cellHeight = Math.max(...known.map((s) => (s.height * cellWidth) / s.width))
  const height = cellHeight * rows + COMPOSITE_GAP * (rows - 1)
  if (height > COMPOSITE_MAX_HEIGHT) {
    // 縦に入りきらなければ全体を縮める
    const scale = (COMPOSITE_MAX_HEIGHT - COMPOSITE_GAP * (rows - 1)) / (cellHeight * rows)
    cellWidth = Math.max(16, Math.floor(cellWidth * scale))
    cellHeight = cellHeight * scale
  }
  cellHeight = Math.max(16, Math.floor(cellHeight))
  const width = even(cellWidth * cols + COMPOSITE_GAP * (cols - 1))
  const outHeight = even(cellHeight * rows + COMPOSITE_GAP * (rows - 1))
  const cells: Rect[] = []
  for (let i = 0; i < count; i++) {
    const row = Math.floor(i / cols)
    // 最後の行が埋まらないとき（3つなら下の1つ）は、その行を真ん中に寄せる
    const inRow = row === rows - 1 ? count - row * cols : cols
    const offset = ((cols - inRow) * (cellWidth + COMPOSITE_GAP)) / 2
    const col = i % cols
    cells.push({ x: Math.round(offset + col * (cellWidth + COMPOSITE_GAP)), y: row * (cellHeight + COMPOSITE_GAP), width: cellWidth, height: cellHeight })
  }
  return { width, height: outHeight, cells }
}

/** 映像を枠に縦横比を保って収める位置（余りは上下か左右に均等に空ける）。大きさが分からなければ枠いっぱい */
export function fitInto(size: Size, cell: Rect): Rect {
  if (!(size.width > 0 && size.height > 0)) return { ...cell }
  const scale = Math.min(cell.width / size.width, cell.height / size.height)
  const width = Math.max(1, Math.round(size.width * scale))
  const height = Math.max(1, Math.round(size.height * scale))
  return { x: cell.x + Math.round((cell.width - width) / 2), y: cell.y + Math.round((cell.height - height) / 2), width, height }
}

/**
 * 1つずつの映像を取り込むときの横幅の上限。並べると枠は全体より小さいので、枠の幅より大きく取り込んでも見えない。
 * 静止画（指摘の画像）は合成した映像から切り出すので、枠の幅で足りる。小さすぎると文字が潰れるので 640px は残す
 */
export function sourceMaxWidth(count: number, maxWidth: number): number {
  if (count <= 1) return maxWidth
  const limit = maxWidth > 0 ? maxWidth : COMPOSITE_MAX_WIDTH
  return Math.max(640, Math.ceil(limit / compositeColumns(count)))
}

/**
 * 内蔵ブラウザの場所に映すもの（recorder/mirror.js の URL の source）。複数なら , でつなぐ（mirror.js が並べて映す）。
 * desktopCapturer の ID（screen:… / window:…）の形でないものは入れない
 */
export function mirrorSourceParam(ids: readonly string[]): string {
  return ids.filter((id) => MIRROR_SOURCE_ID.test(id)).slice(0, MAX_COMPOSITE_SOURCES).join(',')
}

/** mirror.js と同じ決まり（mirror.js は素の JS なので、同じ正規表現をそちらにも書いてある） */
export const MIRROR_SOURCE_ID = /^(screen|window):[\w:-]+$/

/** mirror.js が受け取る source を ID に分ける（mirror.js と同じ処理。単体テストで形を確かめる） */
export function parseMirrorSourceParam(param: string): string[] {
  return param.split(',').filter((id) => MIRROR_SOURCE_ID.test(id)).slice(0, MAX_COMPOSITE_SOURCES)
}

/**
 * 録画中の画面を映す枠（mirror）が、録っている画面そのものの上にあるとき、映像の中でその枠が写る場所（画面に対する 0〜1 の割合）。
 * そこを映像に出すと、枠の中に枠が映り、無限に重なる（合わせ鏡。2026-11-16、画面全体を録ったら画面が入れ子になって録画が崩れた）。
 * mirror.js はこの場所を塗りつぶして、映像の中の枠を映さない。重なっていなければ null。
 * 値は小数4桁に丸めた文字列（URL のハッシュ "mask=x,y,w,h" に入れる）
 */
export function mirrorMaskParam(mirrorOnScreen: Rect, display: Rect): string | null {
  if (!(display.width > 0 && display.height > 0 && mirrorOnScreen.width > 0 && mirrorOnScreen.height > 0)) return null
  const left = Math.max(mirrorOnScreen.x, display.x)
  const top = Math.max(mirrorOnScreen.y, display.y)
  const right = Math.min(mirrorOnScreen.x + mirrorOnScreen.width, display.x + display.width)
  const bottom = Math.min(mirrorOnScreen.y + mirrorOnScreen.height, display.y + display.height)
  if (right <= left || bottom <= top) return null
  const round = (n: number) => String(Math.round(n * 10000) / 10000)
  return [(left - display.x) / display.width, (top - display.y) / display.height, (right - left) / display.width, (bottom - top) / display.height].map(round).join(',')
}


/** 映すページ（mirror.js）が最初の映像を出した・映せないと分かったときの題名。main はこれでビューを出す */
export const MIRROR_TITLE_READY = 'mirror-ready'
export const MIRROR_TITLE_FAILED = 'mirror-failed'
/** 題名が来なくても、この時間でビューを出す（映像が遅い・題名の知らせが来ない） */
export const MIRROR_READY_FALLBACK_MS = 2500

export function isMirrorShownTitle(title: string): boolean {
  return title === MIRROR_TITLE_READY || title === MIRROR_TITLE_FAILED
}

/**
 * 映すページへ渡すハッシュ（src=映すもの&msg=映せないときの文&mask=塗りつぶす場所）。
 * 録る対象を切り替えるときもページを読み込み直さず、このハッシュだけを替える（mirror.js が新しい映像の最初の1枚を待って入れ替える）
 */
export function mirrorHash(state: { source: string; message?: string; mask?: string | null }): string {
  const params = new URLSearchParams({ src: state.source })
  if (state.message) params.set('msg', state.message)
  if (state.mask) params.set('mask', state.mask)
  return params.toString()
}

/**
 * 窓がその画面に少しでも入っているか（Ferret の窓がある画面を録るなら、録画の映像を Ferret の中に映さない。映すと二重・入れ子になる）
 */
export function windowOnDisplay(window: Rect, display: Rect): boolean {
  return mirrorMaskParam(window, display) !== null
}
