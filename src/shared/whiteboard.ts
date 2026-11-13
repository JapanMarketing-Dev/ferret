/**
 * 無限ホワイトボード（ビジュアルレビュー・価値ユースケースのタブ。renderer/components/Whiteboard.tsx）の計算（純粋な関数。単体テストの対象）。
 *
 * 見ている位置は { x, y, scale }。中身（ボードの上の世界）の点 p は、画面の上では (p * scale + x, p * scale + y) に出る。
 */

export interface BoardView {
  x: number
  y: number
  scale: number
}

export interface Size {
  width: number
  height: number
}

export interface Rect extends Size {
  x: number
  y: number
}

export const MIN_SCALE = 0.1
export const MAX_SCALE = 4
/** 全体を表示するときの余白（画面の上の画素） */
export const FIT_PADDING = 32
/** ＋・− で止まる倍率 */
export const ZOOM_STEPS = [0.1, 0.15, 0.25, 0.33, 0.5, 0.67, 0.8, 1, 1.25, 1.5, 2, 3, 4] as const

export const DEFAULT_VIEW: BoardView = { x: 0, y: 0, scale: 1 }

export function clampScale(scale: number): number {
  if (!Number.isFinite(scale) || scale <= 0) return 1
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale))
}

/** 画面の上の点 point（ボードの左上から）を動かさずに、倍率を scale にする */
export function zoomAt(view: BoardView, scale: number, point: { x: number; y: number }): BoardView {
  const next = clampScale(scale)
  const ratio = next / view.scale
  return { x: point.x - (point.x - view.x) * ratio, y: point.y - (point.y - view.y) * ratio, scale: next }
}

/** ＋（dir 1）・−（dir -1）で次に止まる倍率。今の倍率が段の間なら、その向きのいちばん近い段 */
export function stepScale(scale: number, dir: 1 | -1): number {
  const eps = 1e-3
  if (dir > 0) return ZOOM_STEPS.find((step) => step > scale + eps) ?? MAX_SCALE
  return [...ZOOM_STEPS].reverse().find((step) => step < scale - eps) ?? MIN_SCALE
}

/**
 * 中身の範囲 rect（世界の座標）を、ボードの大きさ viewport に収める位置と倍率。
 * 小さい中身は拡大しすぎない（maxScale まで。既定は 100%）。中身が空・ボードが無い大きさなら null
 */
export function fitRect(rect: Rect, viewport: Size, opts: { padding?: number; maxScale?: number } = {}): BoardView | null {
  const padding = opts.padding ?? FIT_PADDING
  if (!(rect.width > 0 && rect.height > 0 && viewport.width > 0 && viewport.height > 0)) return null
  const room = { width: Math.max(1, viewport.width - padding * 2), height: Math.max(1, viewport.height - padding * 2) }
  const scale = clampScale(Math.min(room.width / rect.width, room.height / rect.height, opts.maxScale ?? 1))
  return {
    x: (viewport.width - rect.width * scale) / 2 - rect.x * scale,
    y: (viewport.height - rect.height * scale) / 2 - rect.y * scale,
    scale
  }
}

/**
 * 全体を表示。上は余白を空けて上に寄せる（横長・縦長のどちらでも、見出しのカードがいつも同じ所に来るように）。
 * 中身は世界の (0,0) から size の大きさ
 */
export function fitContent(content: Size, viewport: Size, opts: { padding?: number; maxScale?: number } = {}): BoardView | null {
  const fit = fitRect({ x: 0, y: 0, ...content }, viewport, opts)
  if (!fit) return null
  return { ...fit, y: Math.min(fit.y, opts.padding ?? FIT_PADDING) }
}

export interface WheelInput {
  deltaX: number
  deltaY: number
  /** 0 画素・1 行・2 ページ（WheelEvent.deltaMode） */
  deltaMode: number
  /** トラックパッドのピンチは ctrlKey が付いて届く */
  ctrlKey: boolean
  metaKey: boolean
}

const LINE = 16
const PAGE = 400
/** 1回のホイールで変える倍率の上限（マウスのホイールの1刻みが大きすぎないように） */
const WHEEL_ZOOM_LIMIT = 50
const WHEEL_ZOOM_RATE = 0.006

/**
 * ホイール・トラックパッド。ピンチ・⌘/Ctrl+ホイールは point を中心に拡大縮小、そのほかは動かす（2本指スクロール）
 */
export function applyWheel(view: BoardView, wheel: WheelInput, point: { x: number; y: number }): BoardView {
  const unit = wheel.deltaMode === 1 ? LINE : wheel.deltaMode === 2 ? PAGE : 1
  const dx = (Number.isFinite(wheel.deltaX) ? wheel.deltaX : 0) * unit
  const dy = (Number.isFinite(wheel.deltaY) ? wheel.deltaY : 0) * unit
  if (wheel.ctrlKey || wheel.metaKey) {
    const delta = Math.max(-WHEEL_ZOOM_LIMIT, Math.min(WHEEL_ZOOM_LIMIT, dy))
    return zoomAt(view, view.scale * Math.exp(-delta * WHEEL_ZOOM_RATE), point)
  }
  return { ...view, x: view.x - dx, y: view.y - dy }
}

/** 倍率の表示（62%） */
export function scaleLabel(scale: number): string {
  return `${Math.round(scale * 100)}%`
}

/** 点の方眼の間隔（世界では 24px）。縮めても画面の上で 12px より詰めない（網に見えないよう、2倍ずつ間引く） */
export function gridSize(scale: number): number {
  let size = 24 * clampScale(scale)
  while (size < 12) size *= 2
  return size
}
