/**
 * ターミナルの「一番下へ」のボタン（src/renderer/terminal/jumpToBottom.ts・terminalClient.ts）。
 * Agent が出力し続けている間に上を読んでいても、1回押せば最新の行まで移れる
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { isScrolledUp, viewportResyncSteps } from '../../src/renderer/terminal/jumpToBottom'

describe('一番下へのボタン', () => {
  it('上へスクロールして下に行があるときだけ出す', () => {
    expect(isScrolledUp({ viewportY: 10, baseY: 120 })).toBe(true)
    expect(isScrolledUp({ viewportY: 120, baseY: 120 })).toBe(false)
    expect(isScrolledUp({ viewportY: 0, baseY: 0 })).toBe(false)
  })

  it('押すと一番下へ移り、入力の焦点は奪わない。出力・スクロールのたびに出し直す', () => {
    const src = readFileSync('src/renderer/terminal/terminalClient.ts', 'utf8')
    expect(src).toMatch(/jumpButton\.addEventListener\('click', \(\) => \{\s*this\.term\.scrollToBottom\(\)/)
    expect(src).toMatch(/jumpButton\.addEventListener\('mousedown', \(event\) => event\.preventDefault\(\)\)/)
    expect(src).toContain("this.host.addEventListener('scroll', onViewportScroll, true)")
    expect(src).toContain('this.term.onWriteParsed(onViewportScroll)')
  })

  it('隠れていたターミナルを再表示したら、スクロール領域を測り直させる（下まで送れずに止まらない）', () => {
    expect(viewportResyncSteps({ viewportY: 2971, baseY: 2971 })).toEqual([-1, 1])
    expect(viewportResyncSteps({ viewportY: 100, baseY: 2971 })).toEqual([-1, 1])
    expect(viewportResyncSteps({ viewportY: 0, baseY: 2971 })).toEqual([1, -1])
    expect(viewportResyncSteps({ viewportY: 0, baseY: 0 })).toBeNull()
    const src = readFileSync('src/renderer/terminal/terminalClient.ts', 'utf8')
    expect(src).toMatch(/this\.term\.refresh\(0, this\.term\.rows - 1\)\s*this\.resyncViewport\(\)/)
    expect(src).toContain('for (const step of steps) this.term.scrollLines(step)')
  })
})
