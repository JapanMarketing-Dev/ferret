/**
 * AudioContext の時刻（秒。worklet の currentTime）を、映像のトラックと同じ performance.now() の時計（take.json の firstFrameMs）に換算する。
 * getOutputTimestamp() が正確だが、音を出し始めるまでは {0, 0}（か undefined）で、それは最初のサンプルが届くときそのもの。
 * そのときは、同時に読んだ currentTime と performance.now() を使う。旧 Solocut の shared/audioClock.ts から移した。
 */

export interface OutputTimestamp {
  contextTime?: number
  performanceTime?: number
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

/**
 * 文脈の時刻 `t` の performance.now()（ms）。`ts` = ctx.getOutputTimestamp()、`nowMs` = performance.now()、
 * `currentTime` = ctx.currentTime（どれも worklet の知らせが届いたときに読む）。使える値が無ければ undefined
 */
export function contextTimeToPerfMs(t: number, ts: OutputTimestamp | null | undefined, nowMs: number, currentTime: number): number | undefined {
  if (!finite(t)) return undefined
  if (ts && finite(ts.performanceTime) && finite(ts.contextTime) && ts.performanceTime > 0 && ts.contextTime > 0) {
    const v = ts.performanceTime + (t - ts.contextTime) * 1000
    // 未来・ページができる前になる換算は古い。もう一方の方法にする
    if (v >= 0 && v <= nowMs + 1) return v
  }
  if (!finite(nowMs) || !finite(currentTime)) return undefined
  // 知らせはサンプルを描いたあとに届くので currentTime >= t。時計のゆらぎは切り詰める
  const v = nowMs - Math.max(0, currentTime - t) * 1000
  return v >= 0 ? v : undefined
}
