import { describe, expect, it } from 'vitest'
import { clampMenuTop } from '../../src/renderer/lib/menuPosition'

describe('右クリックのメニューの位置（下の項目が切れない）', () => {
  it('収まるならそのまま', () => {
    expect(clampMenuTop(100, 320, 800)).toBe(100)
  })
  it('下からはみ出す分だけ上へ寄せる（最後の「削除」まで見える）', () => {
    expect(clampMenuTop(700, 320, 800)).toBe(800 - 320 - 4)
  })
  it('ちょうど下端に届くときは動かさない', () => {
    expect(clampMenuTop(476, 320, 800)).toBe(476)
  })
  it('入れ物より高いメニューは上端に揃える（負にしない）', () => {
    expect(clampMenuTop(300, 900, 800)).toBe(4)
  })
  it('上端より上では開かない', () => {
    expect(clampMenuTop(-20, 100, 800)).toBe(4)
  })
  it('余白を変えられる', () => {
    expect(clampMenuTop(790, 100, 800, 10)).toBe(690)
  })
})
