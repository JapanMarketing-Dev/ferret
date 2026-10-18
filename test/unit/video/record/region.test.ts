import { describe, expect, it } from 'vitest'
import {
  MIN_REGION_PX, displayPixels, dragRect, fitRegion, isWholeDisplay, normalizeCursor, parseRegion, regionForDisplay, regionFromDip, regionPercent,
  regionScreenBounds, streamCrop, type DisplayInfo, type Region
} from '../../../../src/video/app/shared/record/region'

const retina: DisplayInfo = { id: '1', bounds: { x: 0, y: 0, width: 1440, height: 900 }, scaleFactor: 2 }
const side: DisplayInfo = { id: '2', bounds: { x: 1440, y: -200, width: 1920, height: 1080 }, scaleFactor: 1 }
const odd: DisplayInfo = { id: '3', bounds: { x: -1280, y: 0, width: 1280, height: 800 }, scaleFactor: 1.5 }

describe('parseRegion', () => {
  it('accepts a valid region and rounds numbers', () => {
    expect(parseRegion({ displayId: '1', x: 10.4, y: 0, width: 100, height: 64.6 })).toEqual({ displayId: '1', x: 10, y: 0, width: 100, height: 65 })
  })
  it('accepts exactly the minimum size', () => {
    expect(parseRegion({ displayId: '1', x: 0, y: 0, width: MIN_REGION_PX, height: MIN_REGION_PX })).not.toBeNull()
  })
  it('drops unknown keys', () => {
    expect(parseRegion({ displayId: '1', x: 0, y: 0, width: 100, height: 100, evil: '<script>' })).toEqual({ displayId: '1', x: 0, y: 0, width: 100, height: 100 })
  })
  it.each([
    ['null', null],
    ['undefined', undefined],
    ['array', [1, 2]],
    ['string', 'region'],
    ['number', 42],
    ['no display', { x: 0, y: 0, width: 100, height: 100 }],
    ['numeric display', { displayId: 1, x: 0, y: 0, width: 100, height: 100 }],
    ['empty display', { displayId: '', x: 0, y: 0, width: 100, height: 100 }],
    ['negative x', { displayId: '1', x: -5, y: 0, width: 100, height: 100 }],
    ['negative y', { displayId: '1', x: 0, y: -1, width: 100, height: 100 }],
    ['too narrow', { displayId: '1', x: 0, y: 0, width: MIN_REGION_PX - 1, height: 100 }],
    ['too short', { displayId: '1', x: 0, y: 0, width: 100, height: MIN_REGION_PX - 1 }],
    ['zero size', { displayId: '1', x: 0, y: 0, width: 0, height: 0 }],
    ['NaN', { displayId: '1', x: Number.NaN, y: 0, width: 100, height: 100 }],
    ['Infinity', { displayId: '1', x: 0, y: 0, width: Number.POSITIVE_INFINITY, height: 100 }],
    ['string numbers', { displayId: '1', x: '0', y: 0, width: 100, height: 100 }]
  ])('rejects %s', (_n, v) => {
    expect(parseRegion(v)).toBeNull()
  })
})

describe('dragRect', () => {
  const lim = { width: 1440, height: 900 }
  it('normalizes any drag direction', () => {
    expect(dragRect({ x: 100, y: 200 }, { x: 50, y: 20 }, lim)).toEqual({ x: 50, y: 20, width: 50, height: 180 })
    expect(dragRect({ x: 50, y: 20 }, { x: 100, y: 200 }, lim)).toEqual({ x: 50, y: 20, width: 50, height: 180 })
    expect(dragRect({ x: 100, y: 20 }, { x: 50, y: 200 }, lim)).toEqual({ x: 50, y: 20, width: 50, height: 180 })
  })
  it('clamps to the display', () => {
    expect(dragRect({ x: -30, y: -10 }, { x: 2000, y: 1000 }, lim)).toEqual({ x: 0, y: 0, width: 1440, height: 900 })
  })
  it('a drag entirely outside collapses to an edge', () => {
    expect(dragRect({ x: 2000, y: 10 }, { x: 3000, y: 50 }, lim)).toEqual({ x: 1440, y: 10, width: 0, height: 40 })
  })
  it('a click is an empty rect', () => {
    expect(dragRect({ x: 5, y: 5 }, { x: 5, y: 5 }, lim)).toEqual({ x: 5, y: 5, width: 0, height: 0 })
  })
})

describe('regionFromDip', () => {
  it('scales by the Retina scale factor', () => {
    expect(regionFromDip({ x: 0, y: 25, width: 1440, height: 800 }, retina)).toEqual({ displayId: '1', x: 0, y: 50, width: 2880, height: 1600 })
  })
  it('keeps origin and size even', () => {
    const r = regionFromDip({ x: 101, y: 33, width: 401, height: 301 }, odd)!
    for (const v of [r.x, r.y, r.width, r.height]) expect(v % 2).toBe(0)
    expect(r.x).toBeLessThanOrEqual(101 * 1.5)
    expect(r.x + r.width).toBeGreaterThanOrEqual(Math.floor((101 + 401) * 1.5) - 2)
  })
  it('stays inside the display', () => {
    const r = regionFromDip({ x: 1400, y: 880, width: 500, height: 500 }, retina)
    // 40 x 20 DIP は 80 x 40 px 残る
    expect(r).not.toBeNull()
    expect(r!.x + r!.width).toBeLessThanOrEqual(2880)
    expect(r!.y + r!.height).toBeLessThanOrEqual(1800)
  })
  it('null when too small or not finite', () => {
    expect(regionFromDip({ x: 0, y: 0, width: 10, height: 10 }, side)).toBeNull()
    expect(regionFromDip({ x: 0, y: 0, width: 31, height: 400 }, side)).toBeNull()
    expect(regionFromDip({ x: 1430, y: 0, width: 100, height: 100 }, retina)).toBeNull() // 中に 20px しか残らない
    expect(regionFromDip({ x: Number.NaN, y: 0, width: 100, height: 100 }, side)).toBeNull()
    expect(regionFromDip({ x: 0, y: 0, width: Number.POSITIVE_INFINITY, height: 100 }, side)).toBeNull()
  })
  it('a drag starting left of the display is clipped to its edge', () => {
    expect(regionFromDip({ x: -50, y: 0, width: 200, height: 100 }, side)).toEqual({ displayId: '2', x: 0, y: 0, width: 150, height: 100 })
  })
  it('treats a non-positive scale factor as 1', () => {
    expect(regionFromDip({ x: 0, y: 0, width: 100, height: 100 }, { ...side, scaleFactor: 0 })).toEqual({ displayId: '2', x: 0, y: 0, width: 100, height: 100 })
    expect(regionFromDip({ x: 0, y: 0, width: 100, height: 100 }, { ...side, scaleFactor: -2 })).toEqual({ displayId: '2', x: 0, y: 0, width: 100, height: 100 })
  })
})

describe('fitRegion / isWholeDisplay', () => {
  it('null for another display', () => {
    expect(fitRegion({ displayId: '2', x: 0, y: 0, width: 100, height: 100 }, retina)).toBeNull()
  })
  it('clips a region to a display that got smaller', () => {
    expect(fitRegion({ displayId: '2', x: 1800, y: 0, width: 400, height: 2000 }, side)).toEqual({ displayId: '2', x: 1800, y: 0, width: 120, height: 1080 })
  })
  it('null when the region is now off the display', () => {
    expect(fitRegion({ displayId: '2', x: 5000, y: 0, width: 400, height: 400 }, side)).toBeNull()
    expect(fitRegion({ displayId: '2', x: 1900, y: 0, width: 400, height: 400 }, side)).toBeNull() // 20px しか残らない
  })
  it('detects the whole display', () => {
    expect(isWholeDisplay({ displayId: '1', x: 0, y: 0, width: 2880, height: 1800 }, retina)).toBe(true)
    expect(isWholeDisplay({ displayId: '1', x: 1, y: 1, width: 2878, height: 1798 }, retina)).toBe(true)
    expect(isWholeDisplay({ displayId: '1', x: 0, y: 50, width: 2880, height: 1700 }, retina)).toBe(false)
  })
  it('display pixels round the scaled size', () => {
    expect(displayPixels(odd)).toEqual({ width: 1920, height: 1200 })
    expect(displayPixels({ ...side, scaleFactor: 0 })).toEqual({ width: 1920, height: 1080 })
  })
})

describe('regionForDisplay', () => {
  it('the saved region of this display', () => {
    expect(regionForDisplay({ displayId: '1', x: 0, y: 50, width: 2880, height: 1700 }, retina)).toEqual({ displayId: '1', x: 0, y: 50, width: 2880, height: 1700 })
  })
  it('null for another display, the whole display, nothing or garbage', () => {
    expect(regionForDisplay({ displayId: '2', x: 0, y: 0, width: 100, height: 100 }, retina)).toBeNull()
    expect(regionForDisplay({ displayId: '1', x: 0, y: 0, width: 2880, height: 1800 }, retina)).toBeNull()
    expect(regionForDisplay(null, retina)).toBeNull()
    expect(regionForDisplay('all', retina)).toBeNull()
    expect(regionForDisplay({ displayId: '1', x: 0, y: 0, width: 100, height: 100 }, null)).toBeNull()
  })
})

describe('streamCrop', () => {
  const r: Region = { displayId: '1', x: 0, y: 50, width: 2880, height: 1700 }
  it('crop in a full-resolution stream', () => {
    expect(streamCrop(r, retina, 2880, 1800)).toEqual({ fx: 0, fy: 50 / 1800, fw: 1, fh: 1700 / 1800, width: 2880, height: 1700 })
  })
  it('scales to a downscaled stream and keeps even output', () => {
    const c = streamCrop({ displayId: '1', x: 100, y: 100, width: 1002, height: 602 }, retina, 1440, 900)!
    expect(c.width % 2).toBe(0)
    expect(c.height % 2).toBe(0)
    expect(c.width).toBe(500)
    expect(c.height).toBe(300)
    expect(c.fx).toBeCloseTo(100 / 2880)
  })
  it('a tiny stream still yields an even, non-zero crop', () => {
    const c = streamCrop({ displayId: '1', x: 0, y: 0, width: 64, height: 64 }, retina, 100, 60)
    expect(c).not.toBeNull()
    expect(c!.width).toBeGreaterThanOrEqual(2)
  })
  it('null for a bad stream size or another display', () => {
    expect(streamCrop(r, retina, 0, 1800)).toBeNull()
    expect(streamCrop(r, retina, -1, 1800)).toBeNull()
    expect(streamCrop(r, retina, Number.NaN, 1800)).toBeNull()
    expect(streamCrop(r, side, 1920, 1080)).toBeNull()
    expect(streamCrop({ displayId: '1', x: 0, y: 0, width: 32, height: 32 }, retina, 10, 10)).toBeNull()
  })
})

describe('cursor log in region coordinates', () => {
  it('the region top-left is (0,0) and bottom-right is (1,1)', () => {
    const r: Region = { displayId: '2', x: 200, y: 100, width: 800, height: 400 }
    const b = regionScreenBounds(r, side)
    expect(b).toEqual({ x: 1640, y: -100, width: 800, height: 400 })
    expect(normalizeCursor({ x: 1640, y: -100 }, b)).toEqual({ x: 0, y: 0 })
    expect(normalizeCursor({ x: 2440, y: 300 }, b)).toEqual({ x: 1, y: 1 })
    expect(normalizeCursor({ x: 1440, y: -200 }, b).x).toBeLessThan(0)
  })
  it('divides by the scale factor (Retina)', () => {
    expect(regionScreenBounds({ displayId: '1', x: 0, y: 50, width: 2880, height: 1700 }, retina)).toEqual({ x: 0, y: 25, width: 1440, height: 850 })
  })
  it('a zero-size rectangle does not divide by zero', () => {
    const p = normalizeCursor({ x: 5, y: 5 }, { x: 0, y: 0, width: 0, height: 0 })
    expect(Number.isFinite(p.x) && Number.isFinite(p.y)).toBe(true)
  })
  it('rounds to 4 decimals', () => {
    expect(normalizeCursor({ x: 1, y: 2 }, { x: 0, y: 0, width: 3, height: 3 })).toEqual({ x: 0.3333, y: 0.6667 })
  })
})

describe('regionPercent', () => {
  it('percentages of the display for the preview frame', () => {
    expect(regionPercent({ displayId: '1', x: 720, y: 450, width: 1440, height: 900 }, retina)).toEqual({ left: 25, top: 25, width: 50, height: 50 })
  })
})
