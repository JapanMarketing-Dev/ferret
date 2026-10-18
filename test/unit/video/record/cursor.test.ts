import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CursorLog, type ScreenLike } from '../../../../src/video/app/main/record/cursor'

const displays = [
  { id: 1, bounds: { x: 0, y: 0, width: 1440, height: 900 }, scaleFactor: 2 },
  { id: 2, bounds: { x: 1440, y: -200, width: 1920, height: 1080 }, scaleFactor: 1 }
]

let dir: string
let cursor = { x: 1640 + 400, y: -100 + 200 }
let clock = 0
const screen: ScreenLike = {
  getAllDisplays: () => displays,
  getDisplayNearestPoint: () => displays[0]!,
  getCursorScreenPoint: () => cursor
}

beforeEach(() => {
  vi.useFakeTimers()
  dir = mkdtempSync(join(tmpdir(), 'ferret-video-cursor-'))
  cursor = { x: 1640 + 400, y: -100 + 200 }
  clock = 10_000
})
afterEach(() => {
  vi.useRealTimers()
  rmSync(dir, { recursive: true, force: true })
})

const lines = () =>
  readFileSync(join(dir, 'cursor.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as { t_ms: number; x: number; y: number })

/** 時計と時刻を一緒に進める */
function advance(log: CursorLog, ms: number) {
  void log
  for (let i = 0; i < ms; i += 10) {
    clock += 10
    vi.advanceTimersByTime(10)
  }
}

describe('cursor log', () => {
  it('normalizes to the region and records it in the info', () => {
    const log = new CursorLog(screen, () => clock)
    const region = { displayId: '2', x: 200, y: 100, width: 800, height: 400 }
    const info = log.start('t', dir, '2', 10_000, region)
    expect(info).toMatchObject({ file: 'cursor.jsonl', hz: 30, displayId: '2', window: false, region, bounds: { x: 1640, y: -100, width: 800, height: 400 } })
    advance(log, 100)
    log.stop('t')
    expect(lines()[0]).toMatchObject({ x: 0.5, y: 0.5 })
    expect(lines()[0]!.t_ms).toBeGreaterThanOrEqual(0)
  })

  it('t_ms is on the take clock (ms since the take started)', () => {
    const log = new CursorLog(screen, () => clock)
    log.start('t', dir, '2', 9_000, null)
    advance(log, 100)
    log.stop('t')
    expect(lines()[0]!.t_ms).toBeGreaterThanOrEqual(1000)
  })

  it('whole display without a region', () => {
    const log = new CursorLog(screen, () => clock)
    const info = log.start('t', dir, '2', 0, null)
    expect(info.region).toBeUndefined()
    expect(info.bounds).toEqual({ x: 1440, y: -200, width: 1920, height: 1080 })
    log.stop('t')
  })

  it('ignores a region of another display or a malformed one', () => {
    const log = new CursorLog(screen, () => clock)
    expect(log.start('t', dir, '2', 0, { displayId: '1', x: 0, y: 0, width: 100, height: 100 }).region).toBeUndefined()
    expect(log.start('t', dir, '2', 0, { displayId: '2', x: 'a' }).region).toBeUndefined()
    expect(log.start('t', dir, '2', 0, 'all').bounds.width).toBe(1920)
    log.stop('t')
  })

  it('a window (no display) uses the display near the cursor and ignores the region', () => {
    const log = new CursorLog(screen, () => clock)
    const info = log.start('t', dir, null, 0, { displayId: '1', x: 0, y: 0, width: 200, height: 200 })
    expect(info.region).toBeUndefined()
    expect(info.window).toBe(true)
    expect(info.displayId).toBe('1')
    log.stop('t')
  })

  it('an unplugged display falls back to the nearest one', () => {
    const log = new CursorLog(screen, () => clock)
    const info = log.start('t', dir, '99', 0, null)
    expect(info.window).toBe(true)
    expect(info.bounds.width).toBe(1440)
    log.stop('t')
  })

  it('clips a region larger than the display', () => {
    const log = new CursorLog(screen, () => clock)
    const info = log.start('t', dir, '1', 0, { displayId: '1', x: 0, y: 100, width: 5000, height: 5000 })
    expect(info.region).toEqual({ displayId: '1', x: 0, y: 100, width: 2880, height: 1700 })
    expect(info.bounds).toEqual({ x: 0, y: 50, width: 1440, height: 850 })
    log.stop('t')
  })

  it('keeps the file small while the cursor rests (about one line per second)', () => {
    const log = new CursorLog(screen, () => clock)
    log.start('t', dir, '2', 10_000, null)
    advance(log, 3000)
    log.stop('t')
    const n = lines().length
    expect(n).toBeGreaterThanOrEqual(2)
    expect(n).toBeLessThanOrEqual(6)
  })

  it('writes a line for each movement', () => {
    const log = new CursorLog(screen, () => clock)
    log.start('t', dir, '2', 10_000, null)
    for (let i = 0; i < 10; i++) {
      cursor = { x: 1500 + i * 10, y: 0 }
      advance(log, 40)
    }
    log.stop('t')
    expect(new Set(lines().map((l) => l.x)).size).toBeGreaterThanOrEqual(9)
  })

  it('flushes on stop, and stop twice / stopAll are harmless', () => {
    const log = new CursorLog(screen, () => clock)
    log.start('a', dir, '2', 10_000, null)
    advance(log, 50)
    log.stop('a')
    expect(lines().length).toBeGreaterThan(0)
    expect(() => log.stop('a')).not.toThrow()
    expect(() => log.stopAll()).not.toThrow()
  })

  it('a removed folder does not throw while recording', () => {
    const log = new CursorLog(screen, () => clock)
    log.start('t', dir, '2', 10_000, null)
    rmSync(dir, { recursive: true, force: true })
    expect(() => advance(log, 1500)).not.toThrow()
    expect(() => log.stop('t')).not.toThrow()
  })
})
