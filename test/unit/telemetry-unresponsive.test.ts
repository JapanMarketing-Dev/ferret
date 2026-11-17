/** Ferret の画面の「応答なし」を送るか（@shared/telemetry の shouldReportUnresponsive。FERRET-2C） */
import { describe, expect, it } from 'vitest'
import { UNRESPONSIVE_WAKE_GRACE_MS, shouldReportUnresponsive } from '../../src/shared/telemetry'

const base = { now: 1_000_000, powerTransitionAt: [] as Array<number | null>, quitting: false, visible: true }

describe('画面の応答なしを送るか', () => {
  it('ふだん（スリープ・ロックの出入りが無い、窓が見えている）は送る', () => {
    expect(shouldReportUnresponsive(base)).toBe(true)
    expect(shouldReportUnresponsive({ ...base, powerTransitionAt: [null, null] })).toBe(true)
  })

  it('ロック解除・スリープ明けから1分の間は送らない（FERRET-2C：8時間ロックして、解除の17秒後）', () => {
    expect(shouldReportUnresponsive({ ...base, powerTransitionAt: [base.now - 17_000] })).toBe(false)
    expect(shouldReportUnresponsive({ ...base, powerTransitionAt: [base.now - 8 * 3600_000, base.now - 1] })).toBe(false)
    expect(shouldReportUnresponsive({ ...base, powerTransitionAt: [base.now] })).toBe(false)
  })

  it('1分を過ぎたら送る（境目ちょうどは送る）。未来の時刻・数でない値は数えない', () => {
    expect(shouldReportUnresponsive({ ...base, powerTransitionAt: [base.now - UNRESPONSIVE_WAKE_GRACE_MS] })).toBe(true)
    expect(shouldReportUnresponsive({ ...base, powerTransitionAt: [base.now - UNRESPONSIVE_WAKE_GRACE_MS + 1] })).toBe(false)
    expect(shouldReportUnresponsive({ ...base, powerTransitionAt: [base.now + 5000, Number.NaN] })).toBe(true)
  })

  it('窓が隠れている・最小化している、終了の途中は送らない', () => {
    expect(shouldReportUnresponsive({ ...base, visible: false })).toBe(false)
    expect(shouldReportUnresponsive({ ...base, quitting: true })).toBe(false)
  })
})
