/**
 * 内蔵ブラウザのメモリを抑える決まり（src/shared/browserMemory.ts）。
 * 後ろのタブを眠らせる・メモリの割合で眠らせる/知らせる・別タブのリンクは外部ブラウザ
 */
import { describe, expect, it } from 'vitest'
import {
  LIVE_TABS,
  MEMORY_CHECK_MS,
  MEMORY_NOTICE_INTERVAL_MS,
  MEMORY_NOTICE_RATIO,
  MEMORY_SLEEP_RATIO,
  formatGb,
  memoryAction,
  pageTabDestination,
  tabsToSleep,
  type TabSleepInfo
} from '../../src/shared/browserMemory'

const tab = (id: string, lastActiveAt: number, extra: Partial<TabSleepInfo> = {}): TabSleepInfo => ({ id, lastActiveAt, sleeping: false, pinned: false, ...extra })
const GB = 1024 ** 3

describe('決まりの値', () => {
  it('ページを持たせるのは3枚・30秒ごと・25% で眠らせ 35% で知らせる・30分は繰り返さない', () => {
    expect(LIVE_TABS).toBe(3)
    expect(MEMORY_CHECK_MS).toBe(30_000)
    expect(MEMORY_SLEEP_RATIO).toBe(0.25)
    expect(MEMORY_NOTICE_RATIO).toBe(0.35)
    expect(MEMORY_NOTICE_INTERVAL_MS).toBe(30 * 60_000)
  })
})

describe('眠らせるタブ', () => {
  it('3枚以下なら眠らせない', () => {
    expect(tabsToSleep([tab('a', 1), tab('b', 2), tab('c', 3)], 'a')).toEqual([])
  })

  it('前のタブ＋最近使った2枚を残し、古いものから眠らせる', () => {
    const tabs = [tab('a', 50), tab('b', 10), tab('c', 40), tab('d', 30), tab('e', 20)]
    expect(tabsToSleep(tabs, 'a').sort()).toEqual(['b', 'e'])
  })

  it('前のタブは古くても眠らせない', () => {
    const tabs = [tab('old', 1), tab('b', 10), tab('c', 20), tab('d', 30)]
    expect(tabsToSleep(tabs, 'old')).toEqual(['b'])
  })

  it('既に眠っているタブは数えず、もう一度は返さない', () => {
    const tabs = [tab('a', 50), tab('b', 40), tab('c', 30), tab('z', 1, { sleeping: true })]
    expect(tabsToSleep(tabs, 'a')).toEqual([])
  })

  it('録画中・Agent が操作中（pinned）は眠らせず、枚数に数える', () => {
    const tabs = [tab('a', 50), tab('p1', 1, { pinned: true }), tab('p2', 2, { pinned: true }), tab('c', 40)]
    expect(tabsToSleep(tabs, 'a')).toEqual(['c'])
  })

  it('keepLive 1（メモリが多いとき）は前のタブと pinned 以外を全部眠らせる', () => {
    const tabs = [tab('a', 50), tab('b', 40), tab('c', 30), tab('p', 1, { pinned: true })]
    expect(tabsToSleep(tabs, 'a', 1).sort()).toEqual(['b', 'c'])
  })

  it('keepLive が 0 以下でも前のタブは残す', () => {
    expect(tabsToSleep([tab('a', 1), tab('b', 2)], 'a', 0)).toEqual(['b'])
  })

  it('前のタブが一覧に無くても、最近使ったものから残す', () => {
    expect(tabsToSleep([tab('a', 1), tab('b', 2), tab('c', 3), tab('d', 4)], 'gone')).toEqual(['a'])
  })

  it('タブが無ければ空', () => {
    expect(tabsToSleep([], 'a')).toEqual([])
  })
})

describe('メモリの割合ですること（GB では決めない）', () => {
  const total = 16 * GB
  it('25% 未満は何もしない', () => {
    expect(memoryAction(total * 0.249, total, 0, null)).toEqual({ sleep: false, notice: false })
  })

  it('25% 以上で眠らせる。眠らせる前の確認では知らせない', () => {
    expect(memoryAction(total * 0.25, total, 0, null)).toEqual({ sleep: true, notice: false })
    expect(memoryAction(total * 0.5, total, 0, null, false)).toEqual({ sleep: true, notice: false })
  })

  it('眠らせたあとも 35% 以上なら知らせる。35% 未満なら知らせない', () => {
    expect(memoryAction(total * 0.35, total, 0, null, true)).toEqual({ sleep: true, notice: true })
    expect(memoryAction(total * 0.34, total, 0, null, true)).toEqual({ sleep: true, notice: false })
  })

  it('知らせてから30分は繰り返さない', () => {
    const now = 10 * 60 * 60_000
    expect(memoryAction(total * 0.4, total, now, now - 29 * 60_000, true).notice).toBe(false)
    expect(memoryAction(total * 0.4, total, now, now - 30 * 60_000, true).notice).toBe(true)
  })

  it('同じ使用量でも、PC のメモリが大きければ何もしない（割合で決める）', () => {
    expect(memoryAction(6 * GB, 16 * GB, 0, null).sleep).toBe(true)
    expect(memoryAction(6 * GB, 64 * GB, 0, null).sleep).toBe(false)
  })

  it('読めない値では何もしない', () => {
    expect(memoryAction(1, 0, 0, null)).toEqual({ sleep: false, notice: false })
    expect(memoryAction(Number.NaN, total, 0, null)).toEqual({ sleep: false, notice: false })
    expect(memoryAction(-1, total, 0, null)).toEqual({ sleep: false, notice: false })
  })

  it('GB の表示', () => {
    expect(formatGb(7.84 * GB)).toBe('7.8')
    expect(formatGb(-5)).toBe('0.0')
  })
})

describe('ページが別タブで開くリンクの行き先', () => {
  it('外のサイトは外部ブラウザ', () => {
    expect(pageTabDestination('https://github.com/x/y/pull/1')).toBe('external')
    expect(pageTabDestination('http://example.com/')).toBe('external')
  })

  it('手元の開発中のページは内蔵ブラウザのタブ', () => {
    for (const url of ['http://localhost:3000/a', 'http://127.0.0.1:5173/', 'http://[::1]:8080/', 'http://app.localhost/', 'https://shop.test/']) {
      expect(pageTabDestination(url)).toBe('tab')
    }
  })

  it('http / https でないもの・読めないものは今までどおり内蔵', () => {
    expect(pageTabDestination('ade-preview://x/index.html')).toBe('tab')
    expect(pageTabDestination('about:blank')).toBe('tab')
    expect(pageTabDestination('not a url')).toBe('tab')
  })
})
