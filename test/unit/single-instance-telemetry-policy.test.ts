import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * 2つ目の起動は Sentry を始めない。始めると、動いている1つ目のまだ終わっていないセッションを
 * 「前回は異常終了（abnormal）」として送り、クラッシュしていないのにクラッシュ率が下がる（0.8.17 の Windows）
 */
const source = readFileSync(join(__dirname, '../../src/main/index.ts'), 'utf8')

describe('二重起動と Sentry の順番', () => {
  it('単一起動の鍵を、Sentry を始めるより前に1回だけ取る', () => {
    const lock = source.indexOf('app.requestSingleInstanceLock()')
    const init = source.indexOf('initCrashReporting()')
    expect(lock).toBeGreaterThan(0)
    expect(init).toBeGreaterThan(lock)
    expect(source.split('app.requestSingleInstanceLock()').length - 1).toBe(1)
  })
  it('鍵が取れなかった起動では Sentry を始めず、終わる', () => {
    expect(source).toMatch(/if \(singleInstanceLock\) initCrashReporting\(\)/)
    expect(source).toMatch(/if \(!singleInstanceLock\) \{\s*app\.quit\(\)\s*return/)
    expect(source.match(/^\s*initCrashReporting\(\)/gm) ?? []).toHaveLength(0)
  })
})
