import { describe, expect, it } from 'vitest'
import { AX_REBUILD_GRACE_MS, AX_REBUILD_MAX_LAG_MS, axRebuildNearBlock } from '../../src/shared/telemetry'

// FERRET-M（0.8.29 の macOS）：他のアプリが補助技術を切り替えた 3.1 秒後の 1.0s。重い処理は無し。送らない
describe('axRebuildNearBlock', () => {
  it('切り替えの直後の、手がかりの無い止まりは true', () => {
    expect(axRebuildNearBlock({ lagMs: 1000, axChangedMsAgo: 3150, slowOps: 0 })).toBe(true)
    expect(axRebuildNearBlock({ lagMs: 1000, axChangedMsAgo: 0, slowOps: 0 })).toBe(true)
    expect(axRebuildNearBlock({ lagMs: 1000, axChangedMsAgo: 1000 + AX_REBUILD_GRACE_MS, slowOps: 0 })).toBe(true)
    expect(axRebuildNearBlock({ lagMs: AX_REBUILD_MAX_LAG_MS - 1, axChangedMsAgo: 100, slowOps: 0 })).toBe(true)
  })
  it('重い処理があれば送る（アプリの手がかり）', () => {
    expect(axRebuildNearBlock({ lagMs: 1000, axChangedMsAgo: 500, slowOps: 1 })).toBe(false)
  })
  it('切り替えから離れている・無いときは送る', () => {
    expect(axRebuildNearBlock({ lagMs: 1000, axChangedMsAgo: 1000 + AX_REBUILD_GRACE_MS + 1, slowOps: 0 })).toBe(false)
    expect(axRebuildNearBlock({ lagMs: 1000, axChangedMsAgo: null, slowOps: 0 })).toBe(false)
    expect(axRebuildNearBlock({ lagMs: 1000, axChangedMsAgo: Number.NaN, slowOps: 0 })).toBe(false)
    expect(axRebuildNearBlock({ lagMs: 1000, axChangedMsAgo: -1, slowOps: 0 })).toBe(false)
  })
  it('作り直しでは説明できない長い止まりは送る', () => {
    expect(axRebuildNearBlock({ lagMs: AX_REBUILD_MAX_LAG_MS, axChangedMsAgo: 100, slowOps: 0 })).toBe(false)
    expect(axRebuildNearBlock({ lagMs: 10_400, axChangedMsAgo: 100, slowOps: 0 })).toBe(false)
    expect(axRebuildNearBlock({ lagMs: Number.NaN, axChangedMsAgo: 100, slowOps: 0 })).toBe(false)
  })
})
