import { describe, expect, it } from 'vitest'
import type { Project } from '@shared/types'
import { MAX_BROWSER_TABS } from '@shared/browserTabs'
import { MAX_HISTORY_ENTRIES, recordableTabs, restorableHistory, sanitizeProjectSession, sessionTabs, startupBrowserTabs, withProjectSession } from '@shared/projectSession'

const project = (over: Partial<Project> = {}): Project => ({ id: 'a', name: 'a', folderPath: '/work/a', urls: [], ...over })

describe('プロジェクトごとの内蔵ブラウザのタブ', () => {
  it('前に開いていたタブを並びと前のタブごと戻す', () => {
    expect(sessionTabs(project({ session: { tabs: ['https://a.test/', 'https://a.test/b'], activeTab: 1 } }))).toEqual({ urls: ['https://a.test/', 'https://a.test/b'], active: 1 })
  })

  it('タブを覚えていなければ、前の URL・登録 URL の先頭の1枚（別のプロジェクトのタブは持ち込まない）', () => {
    expect(sessionTabs(project({ session: { url: 'https://a.test/x' } }))).toEqual({ urls: ['https://a.test/x'], active: 0 })
    expect(sessionTabs(project({ urls: [{ id: 'u', label: 'dev', url: 'http://localhost:3000' }] as Project['urls'] }))).toEqual({ urls: ['http://localhost:3000'], active: 0 })
    expect(sessionTabs(project()).urls).toEqual(['about:blank'])
  })

  it('壊れた値は捨て、上限で切り、範囲外の番号は持たない', () => {
    const many = Array.from({ length: MAX_BROWSER_TABS + 5 }, (_, i) => `https://a.test/${i}`)
    const s = sanitizeProjectSession({ tabs: [...many, 3, '', 'about:blank'], activeTab: 99 })
    expect(s?.tabs).toHaveLength(MAX_BROWSER_TABS)
    expect(s?.activeTab).toBeUndefined()
    expect(sanitizeProjectSession({ tabs: ['https://a.test/'], activeTab: 0 })).toEqual({ tabs: ['https://a.test/'] })
    expect(sanitizeProjectSession({ tabs: 'https://a.test/' })).toBeUndefined()
  })

  it('空のタブ・URL の無いタブは覚えない。何も無ければ null（前の値を消さない）', () => {
    expect(recordableTabs([{ id: 't1', url: '' }, { id: 't2', url: 'about:blank' }], 't1')).toBeNull()
    expect(recordableTabs([{ id: 't1', url: 'https://a.test/' }, { id: 't2', url: '' }, { id: 't3', url: 'https://a.test/c' }], 't3'))
      .toEqual({ tabs: ['https://a.test/', 'https://a.test/c'], activeTab: 1 })
    expect(recordableTabs([{ id: 't1', url: 'https://a.test/' }], 't1')).toEqual({ tabs: ['https://a.test/'] })
  })

  it('withProjectSession は他のプロジェクトのタブを変えない', () => {
    const projects = [project(), project({ id: 'b', folderPath: '/work/b', session: { tabs: ['https://b.test/'] } })]
    const next = withProjectSession(projects, 'a', { tabs: ['https://a.test/'], activeTab: undefined })
    expect(next[0]!.session).toEqual({ tabs: ['https://a.test/'] })
    expect(next[1]!.session).toEqual({ tabs: ['https://b.test/'] })
  })
})

describe('戻る・進むの履歴の持ち越し（restorableHistory）', () => {
  const allowed = (url: string) => url.startsWith('https:')
  const e = (url: string) => ({ url, title: url, pageState: '' })

  it('開いてよい項目だけを残し、前の項目の番号を合わせる', () => {
    const entries = [e('https://a.test/1'), e('file:///etc/passwd'), e('https://a.test/2'), e('https://a.test/3')]
    expect(restorableHistory(entries, 2, allowed)).toEqual({ entries: [entries[0], entries[2], entries[3]], index: 1 })
  })

  it('前の項目が開けないものなら最後の項目、全部だめなら null', () => {
    const entries = [e('https://a.test/1'), e('javascript:alert(1)')]
    expect(restorableHistory(entries, 1, allowed)).toEqual({ entries: [entries[0]], index: 0 })
    expect(restorableHistory([e('file:///x')], 0, allowed)).toBeNull()
  })

  it('長い履歴は前の項目のまわりを上限まで', () => {
    const entries = Array.from({ length: MAX_HISTORY_ENTRIES * 3 }, (_, i) => e(`https://a.test/${i}`))
    const out = restorableHistory(entries, 100, allowed)!
    expect(out.entries).toHaveLength(MAX_HISTORY_ENTRIES)
    expect(out.entries[out.index]).toBe(entries[100])
    const head = restorableHistory(entries, 0, allowed)!
    expect(head.index).toBe(0)
    const tail = restorableHistory(entries, entries.length - 1, allowed)!
    expect(tail.entries[tail.index]).toBe(entries[entries.length - 1])
  })
})

describe('起動時に開く内蔵ブラウザのタブ（別のプロジェクトのページを持ち込まない）', () => {
  it('プロジェクトに覚えたタブがあれば、それを開く', () => {
    expect(startupBrowserTabs(project({ session: { tabs: ['https://a.test/', 'https://a.test/b'], activeTab: 1 } }), 'http://localhost:4321/other'))
      .toEqual({ urls: ['https://a.test/', 'https://a.test/b'], active: 1 })
  })

  it('覚えたものが無くても、全体の最後の URL（別のプロジェクトで見ていたページ）は使わず、空の画面にする', () => {
    expect(startupBrowserTabs(project(), 'http://localhost:4321/other')).toEqual({ urls: ['about:blank'], active: 0 })
  })

  it('覚えたものが無ければ、登録 URL の先頭を開く', () => {
    expect(startupBrowserTabs(project({ urls: [{ id: 'u', label: 'dev', url: 'http://localhost:3000' }] as Project['urls'] }), 'http://localhost:4321/other'))
      .toEqual({ urls: ['http://localhost:3000'], active: 0 })
  })

  it('プロジェクトが無いときだけ、全体の最後の URL を使う（無ければ空の画面）', () => {
    expect(startupBrowserTabs(null, 'http://localhost:4321/other')).toEqual({ urls: ['http://localhost:4321/other'], active: 0 })
    expect(startupBrowserTabs(null, '')).toEqual({ urls: ['about:blank'], active: 0 })
    expect(startupBrowserTabs(null, undefined)).toEqual({ urls: ['about:blank'], active: 0 })
  })
})
