import { describe, expect, it } from 'vitest'
import { centerTabGroups, isViewTab } from '../../src/renderer/editor/centerTabGroups'

const groups = (over: Partial<Parameters<typeof centerTabGroups>[0]> = {}) =>
  centerTabGroups({ dashboard: false, settingsOpen: false, files: [], order: [], ...over })

describe('中央のタブ列（いつもある画面とファイルを別の軸に分ける）', () => {
  it('ブラウザ・指摘・ビジュアルレビューは固定の側にだけ並び、ファイルの側には入らない', () => {
    const { views, docs } = groups({ files: ['file:/p/a.md', 'file:/p/b.md'] })
    expect(views).toEqual(['browser', 'findings', 'visual-review', 'value-usecases'])
    expect(docs).toEqual(['file:/p/a.md', 'file:/p/b.md'])
  })

  it('全体（すべてのプロダクト）のときだけ、ダッシュボードを先頭に出す', () => {
    expect(groups({ dashboard: true }).views).toEqual(['dashboard', 'browser', 'findings', 'visual-review', 'value-usecases'])
    expect(groups({ dashboard: false }).views).not.toContain('dashboard')
  })

  it('ファイルを開いていなければ、ファイルの側は空', () => {
    expect(groups().docs).toEqual([])
  })

  it('設定を開いている間だけ、設定のタブをファイルの側の先頭に出す', () => {
    expect(groups({ settingsOpen: true, files: ['file:/p/a.md'] }).docs).toEqual(['settings', 'file:/p/a.md'])
    expect(groups({ settingsOpen: false, files: ['file:/p/a.md'] }).docs).toEqual(['file:/p/a.md'])
  })

  it('ドラッグの並びはファイル・設定の中だけに効き、覚えていないものは後ろに付く', () => {
    const { docs } = groups({ settingsOpen: true, files: ['file:/p/a.md', 'file:/p/b.md', 'file:/p/c.md'], order: ['file:/p/c.md', 'settings', 'file:/p/a.md'] })
    expect(docs).toEqual(['file:/p/c.md', 'settings', 'file:/p/a.md', 'file:/p/b.md'])
  })

  it('以前の並び（ブラウザ・指摘・ダッシュボードを含む）を渡されても、それらはファイルの側に混ざらない', () => {
    const { views, docs } = groups({ dashboard: true, files: ['file:/p/a.md', 'file:/p/b.md'], order: ['file:/p/b.md', 'findings', 'visual-review', 'browser', 'dashboard', 'file:/p/a.md'] })
    expect(views).toEqual(['dashboard', 'browser', 'findings', 'visual-review', 'value-usecases'])
    expect(docs).toEqual(['file:/p/b.md', 'file:/p/a.md'])
  })

  it('並びに閉じたファイルが残っていても出さない', () => {
    expect(groups({ files: ['file:/p/a.md'], order: ['file:/p/gone.md', 'file:/p/a.md'] }).docs).toEqual(['file:/p/a.md'])
  })

  it('いつもある画面の判定', () => {
    expect(['dashboard', 'browser', 'findings', 'visual-review', 'value-usecases'].every(isViewTab)).toBe(true)
    expect(isViewTab('settings')).toBe(false)
    expect(isViewTab('file:/p/browser')).toBe(false)
    expect(isViewTab('')).toBe(false)
  })
})
