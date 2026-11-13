import { describe, expect, it } from 'vitest'
import { currentDockGroup, groupDockTargets } from '../../src/shared/dockGroups'

const shop = { id: 'shop', name: '営業企業DB', urls: [{ label: 'prd', url: 'https://shop.example.com/' }, { label: 'local', url: 'http://localhost:3000' }, { label: 'figma' }] }
const abm = { id: 'abm', name: 'abm-targeting', urls: [{ label: 'prd', url: 'https://abm.example.com' }, { label: '', url: 'http://localhost:3001' }] }
const idle = { id: 'idle', name: 'site', urls: [] }

describe('全体のフィードバックの帯（2段のタブ）', () => {
  it('上の段はプロダクト（登録の順）、下の段はその確認先。URL の無い確認先・確認先の無いプロダクトは出さない', () => {
    const groups = groupDockTargets([shop, abm, idle])
    expect(groups.map((g) => g.id)).toEqual(['p:shop', 'p:abm'])
    expect(groups[0]!.items).toEqual([{ label: 'prd', url: 'https://shop.example.com/' }, { label: 'local', url: 'http://localhost:3000' }])
    // 名前の無い確認先は URL を名前にする
    expect(groups[1]!.items[1]).toEqual({ label: 'http://localhost:3001', url: 'http://localhost:3001' })
    expect(groupDockTargets([])).toEqual([])
  })

  it('開いているページのプロダクト：同じ URL を先に、無ければ同じオリジン。どれでもなければ null', () => {
    const groups = groupDockTargets([shop, abm])
    expect(currentDockGroup(groups, 'https://shop.example.com')).toBe('p:shop')
    expect(currentDockGroup(groups, 'http://localhost:3001/settings')).toBe('p:abm')
    expect(currentDockGroup(groups, 'about:blank')).toBeNull()
    expect(currentDockGroup(groups, 'not a url')).toBeNull()
  })
})
