/** 録画を止めたあとのレビュー作成の進み具合（@shared/reviewFinishing） */
import { describe, expect, it } from 'vitest'
import { finishPercent, nextPercent, transcribeFraction } from '../../src/shared/reviewFinishing'

describe('レビュー作成の進み具合', () => {
  it('段階ごとの幅（音声 0〜5、文字起こし 5〜85、まとめ 85〜99）。済むまで 100 にしない', () => {
    expect(finishPercent('audio', 0)).toBe(0)
    expect(finishPercent('audio', 1)).toBe(5)
    expect(finishPercent('transcribe', 0)).toBe(5)
    expect(finishPercent('transcribe', 0.5)).toBe(45)
    expect(finishPercent('transcribe', 1)).toBe(85)
    expect(finishPercent('review', 0)).toBe(85)
    expect(finishPercent('review', 1)).toBe(99)
  })

  it('範囲の外・数でない進みは端に寄せる', () => {
    expect(finishPercent('transcribe', -1)).toBe(5)
    expect(finishPercent('transcribe', 2)).toBe(85)
    expect(finishPercent('review', Number.NaN)).toBe(85)
  })

  it('文字起こしは、始めたときの残りの区切りに対して済んだ数で進む。残りが無ければ済み', () => {
    expect(transcribeFraction(4, 4)).toBe(0)
    expect(transcribeFraction(4, 3)).toBe(0.25)
    expect(transcribeFraction(4, 0)).toBe(1)
    expect(transcribeFraction(0, 0)).toBe(1)
    // 区切りが後から足されても 0 より下げない・負の数は 0
    expect(transcribeFraction(4, 6)).toBe(0)
    expect(transcribeFraction(4, -1)).toBe(1)
  })

  it('割合は下げない（0〜100 の整数）', () => {
    expect(nextPercent(40, 30)).toBe(40)
    expect(nextPercent(40, 41.6)).toBe(42)
    expect(nextPercent(0, 150)).toBe(100)
    expect(nextPercent(0, -5)).toBe(0)
  })
})
