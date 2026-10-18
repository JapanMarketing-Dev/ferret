/**
 * 録画する範囲（動画の設定 `record.region`）。ディスプレイ1枚の中の長方形を、そのディスプレイの実ピクセル（DIP × scaleFactor）で持つ。
 * 重ねたウインドウ（regionPicker）でドラッグして決め、録画ウインドウが画面の映像をその範囲だけに切り抜き、カーソルの記録もその範囲に合わせる。
 * Electron にも DOM にも依存しない（main・録画ウインドウ・画面・単体テストで共用）。旧 Solocut の shared/region.ts から移した。
 */

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

/** `record.region`。x/y/width/height はディスプレイの左上からの実ピクセル */
export interface Region extends Rect {
  displayId: string
}

/** main が知らせるディスプレイ。bounds は画面の DIP 座標 */
export interface DisplayInfo {
  id: string
  bounds: Rect
  scaleFactor: number
}

/** 範囲の一辺の最小（実ピクセル）。これより小さいドラッグはクリックとみなす */
export const MIN_REGION_PX = 32

const even = (v: number): number => Math.max(0, Math.floor(v / 2) * 2)
const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

/** 信用できない `record.region`（設定ファイル・IPC）を確かめる。無い・壊れているときは null */
export function parseRegion(v: unknown): Region | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null
  const o = v as Record<string, unknown>
  if (typeof o.displayId !== 'string' || o.displayId === '') return null
  if (!num(o.x) || !num(o.y) || !num(o.width) || !num(o.height)) return null
  if (o.x < 0 || o.y < 0 || o.width < MIN_REGION_PX || o.height < MIN_REGION_PX) return null
  return { displayId: o.displayId, x: Math.round(o.x), y: Math.round(o.y), width: Math.round(o.width), height: Math.round(o.height) }
}

/** ディスプレイの実ピクセルの大きさ */
export function displayPixels(d: DisplayInfo): { width: number; height: number } {
  const s = d.scaleFactor > 0 ? d.scaleFactor : 1
  return { width: Math.round(d.bounds.width * s), height: Math.round(d.bounds.height * s) }
}

/** a から b へのドラッグが作る長方形（どの向きでも）。0〜limit に収める。DIP・ディスプレイの左上から */
export function dragRect(a: { x: number; y: number }, b: { x: number; y: number }, limit: { width: number; height: number }): Rect {
  const cx = (v: number) => Math.min(Math.max(v, 0), limit.width)
  const cy = (v: number) => Math.min(Math.max(v, 0), limit.height)
  const x1 = cx(Math.min(a.x, b.x))
  const y1 = cy(Math.min(a.y, b.y))
  const x2 = cx(Math.max(a.x, b.x))
  const y2 = cy(Math.max(a.y, b.y))
  return { x: x1, y: y1, width: x2 - x1, height: y2 - y1 }
}

/**
 * 重ねたウインドウの DIP の長方形 → 実ピクセルの範囲。原点と大きさは偶数（4:2:0 の符号化は偶数が要る）にし、
 * ディスプレイの中に収める。小さすぎれば null
 */
export function regionFromDip(rect: Rect, d: DisplayInfo): Region | null {
  if (![rect.x, rect.y, rect.width, rect.height].every(num)) return null
  const s = d.scaleFactor > 0 ? d.scaleFactor : 1
  const px = displayPixels(d)
  const x = even(Math.min(Math.max(rect.x * s, 0), px.width))
  const y = even(Math.min(Math.max(rect.y * s, 0), px.height))
  const width = even(Math.min(rect.width * s + (rect.x * s - x), px.width - x))
  const height = even(Math.min(rect.height * s + (rect.y * s - y), px.height - y))
  if (width < MIN_REGION_PX || height < MIN_REGION_PX) return null
  return { displayId: d.id, x, y, width, height }
}

/** 範囲をディスプレイに収める（選んだあとでディスプレイが小さくなったとき）。使えるところが残らなければ null */
export function fitRegion(r: Region, d: DisplayInfo): Region | null {
  if (r.displayId !== d.id) return null
  const px = displayPixels(d)
  const x = even(Math.min(r.x, px.width))
  const y = even(Math.min(r.y, px.height))
  const width = even(Math.min(r.width, px.width - x))
  const height = even(Math.min(r.height, px.height - y))
  if (width < MIN_REGION_PX || height < MIN_REGION_PX) return null
  return { displayId: r.displayId, x, y, width, height }
}

/** 範囲がほぼディスプレイ全体か（切り抜かなくてよい） */
export function isWholeDisplay(r: Region, d: DisplayInfo): boolean {
  const px = displayPixels(d)
  return r.x <= 1 && r.y <= 1 && r.width >= px.width - 2 && r.height >= px.height - 2
}

/** 取り込んだフレームのどこを切り抜くか。元の長方形はフレームに対する割合、出力の大きさはピクセル（偶数） */
export interface StreamCrop {
  fx: number
  fy: number
  fw: number
  fh: number
  width: number
  height: number
}

/**
 * フレームが streamW × streamH の取り込み（ディスプレイの実ピクセルから縮んでいることがある）での切り抜き。
 * 範囲が当てはまらなければ null
 */
export function streamCrop(r: Region, d: DisplayInfo, streamW: number, streamH: number): StreamCrop | null {
  const fit = fitRegion(r, d)
  if (!fit || !(streamW > 0) || !(streamH > 0)) return null
  const px = displayPixels(d)
  const fx = fit.x / px.width
  const fy = fit.y / px.height
  const fw = fit.width / px.width
  const fh = fit.height / px.height
  const width = even(fw * streamW)
  const height = even(fh * streamH)
  if (width < 2 || height < 2) return null
  return { fx, fy, fw, fh, width, height }
}

/** 範囲を画面の DIP 座標（screen.getCursorScreenPoint() と同じ）にしたもの。カーソルの記録に使う */
export function regionScreenBounds(r: Region, d: DisplayInfo): Rect {
  const s = d.scaleFactor > 0 ? d.scaleFactor : 1
  return { x: d.bounds.x + r.x / s, y: d.bounds.y + r.y / s, width: r.width / s, height: r.height / s }
}

/** 範囲をディスプレイに対する百分率にしたもの（プレビューの枠） */
export function regionPercent(r: Region, d: DisplayInfo): { left: number; top: number; width: number; height: number } {
  const px = displayPixels(d)
  const p = (v: number, of: number) => Math.round((v / (of || 1)) * 10000) / 100
  return { left: p(r.x, px.width), top: p(r.y, px.height), width: p(r.width, px.width), height: p(r.height, px.height) }
}

/** カーソルの位置（画面の DIP）を長方形に対する 0〜1 にする。0〜1 の外は「ほかのディスプレイ・範囲の外」 */
export function normalizeCursor(p: { x: number; y: number }, b: Rect): { x: number; y: number } {
  const r = (v: number) => Math.round(v * 10000) / 10000
  return { x: r((p.x - b.x) / (b.width || 1)), y: r((p.y - b.y) / (b.height || 1)) }
}

/**
 * 今の設定の範囲のうち、このディスプレイに当てはまるもの。別のディスプレイの範囲・ほぼ全体・壊れた値は null（画面全体を録る）
 */
export function regionForDisplay(saved: unknown, display: DisplayInfo | null | undefined): Region | null {
  const parsed = parseRegion(saved)
  if (!parsed || !display) return null
  const fitted = fitRegion(parsed, display)
  return fitted && !isWholeDisplay(fitted, display) ? fitted : null
}
