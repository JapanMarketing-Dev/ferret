import { describe, expect, it } from 'vitest'
import { RESUME_GRACE_MS, SLEEP_AFTER_BLOCK_MS, sleepNearBlock } from '../../src/shared/telemetry'

// FERRET-M（0.7.10 の Windows）：lock-screen・suspend が止まりの直後に届いた 1.1s は送らない
describe('sleepNearBlock', () => {
  const end = 100_000
  const lag = 1100
  it('止まりの直後にスリープ・ロックが来たら true', () => {
    expect(sleepNearBlock({ blockEndAt: end, lagMs: lag, sleepAt: [null, end + 30] })).toBe(true)
    expect(sleepNearBlock({ blockEndAt: end, lagMs: lag, sleepAt: [end + SLEEP_AFTER_BLOCK_MS, null] })).toBe(true)
  })
  it('止まりの間・少し前のスリープも true', () => {
    expect(sleepNearBlock({ blockEndAt: end, lagMs: lag, sleepAt: [end - 500] })).toBe(true)
    expect(sleepNearBlock({ blockEndAt: end, lagMs: lag, sleepAt: [end - lag - RESUME_GRACE_MS] })).toBe(true)
  })
  it('離れた時刻・無しは false', () => {
    expect(sleepNearBlock({ blockEndAt: end, lagMs: lag, sleepAt: [null, null] })).toBe(false)
    expect(sleepNearBlock({ blockEndAt: end, lagMs: lag, sleepAt: [end + SLEEP_AFTER_BLOCK_MS + 1] })).toBe(false)
    expect(sleepNearBlock({ blockEndAt: end, lagMs: lag, sleepAt: [end - lag - RESUME_GRACE_MS - 1] })).toBe(false)
    expect(sleepNearBlock({ blockEndAt: end, lagMs: lag, sleepAt: [Number.NaN] })).toBe(false)
  })
})
