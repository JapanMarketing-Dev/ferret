import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { translate } from '@shared/i18n'

// 画面の言語のフック・トーストはサーバー描画で使えないので差し替える
vi.mock('../../src/renderer/lib/i18n', () => ({
  useT: () => (key: Parameters<typeof translate>[1], params?: Parameters<typeof translate>[2]) => translate('en', key, params)
}))
vi.mock('../../src/renderer/ui', async (orig) => ({ ...(await orig<Record<string, unknown>>()), useToast: () => () => undefined }))

// 型を追わせない（テストの tsconfig は renderer を含まないため）
const modulePath = '../../src/renderer/components/ReviewHub'
type Hub = { ReviewHub: (p: unknown) => unknown; loadHistoryOpen: () => boolean }
const load = async () => await import(/* @vite-ignore */ modulePath) as Hub

function stubStorage(values: Record<string, string>, opts: { throws?: boolean } = {}) {
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => { if (opts.throws) throw new Error('blocked'); return values[k] ?? null },
    setItem: (k: string, v: string) => { if (opts.throws) throw new Error('blocked'); values[k] = v }
  })
}

const render = async (props: Record<string, unknown> = {}) => {
  const { ReviewHub } = await load()
  return renderToStaticMarkup(createElement(ReviewHub as never, {
    sessions: [], selectedId: null, onSelect: () => undefined, onHistoryChanged: () => undefined, onNewReview: () => undefined, ...props
  }, createElement('div', { id: 'findings' })))
}

afterEach(() => vi.unstubAllGlobals())

describe('指摘ページの履歴の列', { timeout: 60_000 }, () => {
  it('既定では閉じている（何も覚えていない・ストレージが使えない・壊れた値）', async () => {
    const { loadHistoryOpen } = await load()
    stubStorage({})
    expect(loadHistoryOpen()).toBe(false)
    stubStorage({}, { throws: true })
    expect(loadHistoryOpen()).toBe(false)
    stubStorage({ 'ferret.reviewHub.historyOpen': 'true' })
    expect(loadHistoryOpen()).toBe(false)
    stubStorage({ 'ferret.reviewHub.historyOpen': '1' })
    expect(loadHistoryOpen()).toBe(true)
  })

  it('閉じていても新しいレビュー・MTG の取り込み・指摘は出て、履歴の列は出ない', async () => {
    stubStorage({})
    const html = await render({ onImportMeeting: () => undefined })
    expect(html).toContain('rv-hub--closed')
    expect(html).not.toContain('data-testid="review-hub-history"')
    expect(html).toContain('data-testid="review-hub-new"')
    expect(html).toContain('data-testid="review-hub-import-meeting"')
    expect(html).toContain('aria-expanded="false"')
    expect(html).toContain('History (0)')
    expect(html).toContain('id="findings"')
  })

  it('開くと覚えていれば履歴の列が出る', async () => {
    stubStorage({ 'ferret.reviewHub.historyOpen': '1' })
    const html = await render()
    expect(html).not.toContain('rv-hub--closed')
    expect(html).toContain('data-testid="review-hub-history"')
    expect(html).toContain('aria-expanded="true"')
  })

  it('録画中は新しいレビューを押せない。取り込みの手段が無ければ出さない', async () => {
    stubStorage({})
    const html = await render({ recording: true })
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*data-testid="review-hub-new"/)
    expect(html).not.toContain('review-hub-import-meeting')
  })
})
