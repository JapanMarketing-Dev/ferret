import { describe, expect, it, vi } from 'vitest'
import { cleanLeakedSessions } from '../../src/shared/projectSession'

vi.mock('electron', () => ({ app: { getPath: () => '/tmp/ferret-unit', isPackaged: false } }))
const { mergeSettings, splitSettings } = await import('../../src/main/settingsFile')

/**
 * 0.7.13 までの不具合で別のプロジェクトのページが入り込んだ記憶を、1度だけ片付ける（ferret に official_website の localhost:4321）
 */
const site = { id: 'site', urls: [{ url: 'http://localhost:4321' }, { url: 'https://www.example.co.jp/' }] }
const ferret = { id: 'ferret', urls: [] }
const other = { id: 'other', urls: [{ url: 'http://localhost:5173' }] }

describe('cleanLeakedSessions', () => {
  it('ほかのプロジェクトが登録している origin のページを、登録していないプロジェクトから外す', () => {
    const out = cleanLeakedSessions([site, ferret], {
      ferret: { url: 'http://localhost:4321/products', tabs: ['http://localhost:4321/products'] },
      site: { url: 'http://localhost:4321/products', tabs: ['http://localhost:4321/products'] }
    })
    expect(out.ferret).toBeUndefined()
    expect(out.site).toEqual({ url: 'http://localhost:4321/products', tabs: ['http://localhost:4321/products'] })
  })

  it('自分で登録している origin は残す（同じポートを両方が登録）', () => {
    const both = { id: 'b', urls: [{ url: 'http://localhost:4321/' }] }
    const out = cleanLeakedSessions([site, both], { b: { url: 'http://localhost:4321/x', tabs: ['http://localhost:4321/x'] } })
    expect(out.b?.url).toBe('http://localhost:4321/x')
  })

  it('誰も登録していないページ・ade-page・壊れた URL は残す', () => {
    const tabs = ['https://figma.com/a', 'ade-page://project/a.html', 'not a url']
    const out = cleanLeakedSessions([site, ferret], { ferret: { url: tabs[0], tabs } })
    expect(out.ferret).toEqual({ url: tabs[0], tabs })
  })

  it('混ざったタブだけを外し、前のタブの番号と url を合わせる', () => {
    const out = cleanLeakedSessions([site, ferret, other], {
      ferret: { url: 'https://github.com/x', tabs: ['http://localhost:4321/a', 'https://docs.test/', 'https://github.com/x'], activeTab: 2, centerTab: 'browser' }
    })
    expect(out.ferret).toEqual({ url: 'https://github.com/x', tabs: ['https://docs.test/', 'https://github.com/x'], activeTab: 1, centerTab: 'browser' })
  })

  it('前のタブが外れたら url は残った先頭のタブにする', () => {
    const out = cleanLeakedSessions([site, ferret], { ferret: { url: 'http://localhost:4321/a', tabs: ['http://localhost:4321/a', 'https://docs.test/'], activeTab: 0 } })
    expect(out.ferret).toEqual({ url: 'https://docs.test/', tabs: ['https://docs.test/'] })
  })

  it('タブ以外の記憶（開いていたファイルなど）は残す', () => {
    const out = cleanLeakedSessions([site, ferret], { ferret: { url: 'http://localhost:4321/a', openFiles: ['README.md'] } })
    expect(out.ferret).toEqual({ openFiles: ['README.md'] })
  })

  it('プロジェクトの一覧に無い id の記憶も同じ規則で見る・壊れた値は捨てる', () => {
    const out = cleanLeakedSessions([site], { gone: { url: 'http://localhost:4321/a' }, bad: null as never })
    expect(out).toEqual({})
  })
})

describe('state.json の読み込みで1度だけ片付ける', () => {
  const config = { projects: [{ ...site, name: 'site', folderPath: '/s' }, { ...ferret, name: 'ferret', folderPath: '/f' }] }
  const leaked = { sessions: { ferret: { url: 'http://localhost:4321/products', tabs: ['http://localhost:4321/products'] } } }

  it('印の無い state.json なら片付ける', () => {
    const merged = mergeSettings(config, leaked) as { projects: Array<{ id: string; session?: unknown }> }
    expect(merged.projects.find((p) => p.id === 'ferret')?.session).toBeUndefined()
  })

  it('印のある state.json は、そのまま読む（自分で開いたページを消さない）', () => {
    const merged = mergeSettings(config, { ...leaked, sessionsCleaned: 1 }) as { projects: Array<{ id: string; session?: unknown }> }
    expect(merged.projects.find((p) => p.id === 'ferret')?.session).toEqual(leaked.sessions.ferret)
  })

  it('書くときは必ず印を付ける', () => {
    const { state } = splitSettings({ projects: [], url: 'about:blank', folderPath: null, activeProjectId: null, viewport: { width: 1280, height: 800 } } as never)
    expect(state.sessionsCleaned).toBe(1)
  })
})
