import { describe, expect, it, vi } from 'vitest'
import { markAt, markOnce, reportInteractive } from '../../src/main/startup'

describe('起動の節目', () => {
  it('markOnce は最初の1回だけ記録する（renderer:firstIpc など、何度も通る場所の最初）', () => {
    vi.useFakeTimers({ now: Date.now() })
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      markOnce('renderer:firstIpc')
      const first = reportInteractive().marks['renderer:firstIpc']
      vi.advanceTimersByTime(500)
      markOnce('renderer:firstIpc')
      expect(reportInteractive().marks['renderer:firstIpc']).toBe(first)
    } finally {
      log.mockRestore()
      warn.mockRestore()
      vi.useRealTimers()
    }
  })

  it('markAt は画面の時刻（epoch ms）を節目にする。基準より前・今より後・数でない値は捨てる', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      const now = Date.now()
      markAt('renderer:painted', now - 1, now)
      const painted = reportInteractive().marks['renderer:painted']
      expect(typeof painted).toBe('number')
      expect(painted).toBeGreaterThanOrEqual(0)
      for (const bad of [now + 60_000, 0, -1, Number.NaN, Number.POSITIVE_INFINITY, '123', null, undefined]) {
        markAt('renderer:bad', bad, now)
      }
      expect(reportInteractive().marks['renderer:bad']).toBeUndefined()
    } finally {
      log.mockRestore()
      warn.mockRestore()
    }
  })
})
