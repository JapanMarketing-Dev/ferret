/**
 * 無限ホワイトボード（src/shared/whiteboard.ts）の計算。拡大縮小の中心・段・全体表示・ホイール・壊れた値
 */
import { describe, expect, it } from 'vitest'
import {
  FIT_PADDING,
  MAX_SCALE,
  MIN_SCALE,
  ZOOM_STEPS,
  applyWheel,
  clampScale,
  fitContent,
  fitRect,
  gridSize,
  scaleLabel,
  stepScale,
  zoomAt,
  type BoardView
} from '../../src/shared/whiteboard'

/** 世界の点 p が画面のどこに出るか */
const toScreen = (view: BoardView, p: { x: number; y: number }): { x: number; y: number } => ({ x: p.x * view.scale + view.x, y: p.y * view.scale + view.y })
const wheel = (over: Partial<{ deltaX: number; deltaY: number; deltaMode: number; ctrlKey: boolean; metaKey: boolean }> = {}) => ({ deltaX: 0, deltaY: 0, deltaMode: 0, ctrlKey: false, metaKey: false, ...over })

describe('倍率の範囲', () => {
  it('10%〜400% に収める。数でない・0 以下は 100%', () => {
    expect(clampScale(0.01)).toBe(MIN_SCALE)
    expect(clampScale(99)).toBe(MAX_SCALE)
    expect(clampScale(0.5)).toBe(0.5)
    expect(clampScale(Number.NaN)).toBe(1)
    expect(clampScale(Number.POSITIVE_INFINITY)).toBe(1)
    expect(clampScale(0)).toBe(1)
    expect(clampScale(-2)).toBe(1)
  })
})

describe('点を中心に拡大縮小', () => {
  it('カーソルの下の点は動かない', () => {
    const view = { x: 120, y: -40, scale: 0.8 }
    const cursor = { x: 300, y: 200 }
    const world = { x: (cursor.x - view.x) / view.scale, y: (cursor.y - view.y) / view.scale }
    for (const scale of [0.1, 0.5, 1, 2.5, 4]) {
      const next = zoomAt(view, scale, cursor)
      const at = toScreen(next, world)
      expect(at.x).toBeCloseTo(cursor.x, 6)
      expect(at.y).toBeCloseTo(cursor.y, 6)
    }
  })

  it('範囲の外は端で止まり、そのときも中心の点は動かない', () => {
    const next = zoomAt({ x: 0, y: 0, scale: 1 }, 50, { x: 100, y: 100 })
    expect(next.scale).toBe(MAX_SCALE)
    expect(toScreen(next, { x: 100, y: 100 }).x).toBeCloseTo(100 * MAX_SCALE - 300, 6)
    expect(zoomAt({ x: 0, y: 0, scale: 1 }, 0.001, { x: 0, y: 0 }).scale).toBe(MIN_SCALE)
  })
})

describe('＋・− の段', () => {
  it('段の上では隣の段へ', () => {
    expect(stepScale(1, 1)).toBe(1.25)
    expect(stepScale(1, -1)).toBe(0.8)
    expect(stepScale(0.1, -1)).toBe(MIN_SCALE)
    expect(stepScale(4, 1)).toBe(MAX_SCALE)
  })

  it('段の間（全体表示のあとなど）はその向きのいちばん近い段', () => {
    expect(stepScale(0.62, 1)).toBe(0.67)
    expect(stepScale(0.62, -1)).toBe(0.5)
    // ほぼ段の上（丸めの誤差）は、その段を飛ばして次へ
    expect(stepScale(0.9999999, 1)).toBe(1.25)
  })

  it('段は小さい順で、範囲の端を含む', () => {
    expect([...ZOOM_STEPS]).toEqual([...ZOOM_STEPS].sort((a, b) => a - b))
    expect(ZOOM_STEPS[0]).toBe(MIN_SCALE)
    expect(ZOOM_STEPS.at(-1)).toBe(MAX_SCALE)
  })
})

describe('全体を表示', () => {
  it('大きい中身は縮めて真ん中に収める（余白を残す）', () => {
    const view = fitRect({ x: 0, y: 0, width: 4000, height: 1000 }, { width: 1000, height: 800 })!
    expect(view.scale).toBeCloseTo((1000 - FIT_PADDING * 2) / 4000, 6)
    const left = toScreen(view, { x: 0, y: 0 })
    const right = toScreen(view, { x: 4000, y: 1000 })
    expect(left.x).toBeCloseTo(FIT_PADDING, 6)
    expect(right.x).toBeCloseTo(1000 - FIT_PADDING, 6)
    expect((left.y + right.y) / 2).toBeCloseTo(400, 6)
  })

  it('小さい中身は 100% より大きくしない（下書きが巨大にならない）。maxScale で変えられる', () => {
    expect(fitRect({ x: 0, y: 0, width: 200, height: 100 }, { width: 1000, height: 800 })!.scale).toBe(1)
    expect(fitRect({ x: 0, y: 0, width: 200, height: 100 }, { width: 1000, height: 800 }, { maxScale: 2 })!.scale).toBe(2)
  })

  it('世界の中の範囲（カード）へ寄る', () => {
    const view = fitRect({ x: 500, y: 300, width: 400, height: 200 }, { width: 1000, height: 800 }, { maxScale: 2 })!
    const center = toScreen(view, { x: 700, y: 400 })
    expect(center.x).toBeCloseTo(500, 6)
    expect(center.y).toBeCloseTo(400, 6)
    expect(view.scale).toBe(2)
  })

  it('全体表示は上に寄せる（見出しのカードがいつも上に来る）', () => {
    const view = fitContent({ width: 400, height: 100 }, { width: 1000, height: 800 })!
    expect(view.y).toBe(FIT_PADDING)
    expect(view.x).toBeCloseTo(300, 6)
    // 縦長で高さいっぱいなら、真ん中と同じ
    const tall = fitContent({ width: 100, height: 5000 }, { width: 1000, height: 800 })!
    expect(tall.y).toBeCloseTo(FIT_PADDING, 6)
  })

  it('中身が空・ボードの大きさが無いときは null（まだ測れない）', () => {
    expect(fitRect({ x: 0, y: 0, width: 0, height: 100 }, { width: 1000, height: 800 })).toBeNull()
    expect(fitRect({ x: 0, y: 0, width: 100, height: 100 }, { width: 0, height: 800 })).toBeNull()
    expect(fitContent({ width: Number.NaN, height: 100 }, { width: 1000, height: 800 })).toBeNull()
  })

  it('余白よりボードが小さくても、壊れた値にしない', () => {
    const view = fitRect({ x: 0, y: 0, width: 1000, height: 1000 }, { width: 40, height: 40 })!
    expect(view.scale).toBe(MIN_SCALE)
    expect(Number.isFinite(view.x) && Number.isFinite(view.y)).toBe(true)
  })
})

describe('ホイール・トラックパッド', () => {
  const view = { x: 10, y: 20, scale: 1 }

  it('2本指スクロールは動かす（中身は指と同じ向きに動く）', () => {
    expect(applyWheel(view, wheel({ deltaX: 30, deltaY: -50 }), { x: 0, y: 0 })).toEqual({ x: -20, y: 70, scale: 1 })
  })

  it('行・ページ単位のホイールは画素に直す', () => {
    expect(applyWheel(view, wheel({ deltaY: 3, deltaMode: 1 }), { x: 0, y: 0 }).y).toBe(20 - 48)
    expect(applyWheel(view, wheel({ deltaY: 1, deltaMode: 2 }), { x: 0, y: 0 }).y).toBe(20 - 400)
  })

  it('ピンチ（ctrlKey）・⌘+ホイールは拡大縮小。上へで縮小・下へで拡大の逆（指を広げると拡大）', () => {
    const zoomIn = applyWheel(view, wheel({ deltaY: -10, ctrlKey: true }), { x: 200, y: 100 })
    expect(zoomIn.scale).toBeGreaterThan(1)
    const zoomOut = applyWheel(view, wheel({ deltaY: 10, metaKey: true }), { x: 200, y: 100 })
    expect(zoomOut.scale).toBeLessThan(1)
    // カーソルの下の点は動かない
    const world = { x: (200 - view.x) / view.scale, y: (100 - view.y) / view.scale }
    expect(toScreen(zoomIn, world).x).toBeCloseTo(200, 6)
  })

  it('マウスのホイールの大きな1刻みでも、1回で変わる倍率には上限がある', () => {
    const big = applyWheel(view, wheel({ deltaY: -1000, metaKey: true }), { x: 0, y: 0 })
    const limit = applyWheel(view, wheel({ deltaY: -50, metaKey: true }), { x: 0, y: 0 })
    expect(big.scale).toBeCloseTo(limit.scale, 10)
    expect(big.scale).toBeLessThan(1.5)
  })

  it('壊れた値（NaN）は無かったことにする', () => {
    expect(applyWheel(view, wheel({ deltaX: Number.NaN, deltaY: Number.NaN }), { x: 0, y: 0 })).toEqual(view)
  })
})

describe('倍率の表示', () => {
  it('倍率は整数の %', () => {
    expect(scaleLabel(0.625)).toBe('63%')
    expect(scaleLabel(1)).toBe('100%')
    expect(scaleLabel(MAX_SCALE)).toBe('400%')
  })
})

describe('点の方眼', () => {
  it('100% で 24px。縮めても 12px 未満にはしない（2倍ずつ間引く）。拡大はそのまま', () => {
    expect(gridSize(1)).toBe(24)
    expect(gridSize(2)).toBe(48)
    expect(gridSize(0.5)).toBe(12)
    expect(gridSize(0.4)).toBeCloseTo(19.2, 6)
    expect(gridSize(0.13)).toBeCloseTo(24 * 0.13 * 4, 6)
    for (const scale of [0.1, 0.11, 0.2, 0.33, 0.49]) expect(gridSize(scale)).toBeGreaterThanOrEqual(12)
    expect(gridSize(Number.NaN)).toBe(24)
  })
})
