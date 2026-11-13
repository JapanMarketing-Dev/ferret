/**
 * オーケストラのプロダクトの一覧（src/shared/productRound.ts）と、全体の共通・個別のルール（src/shared/orchestrator.ts）
 */
import { describe, expect, it } from 'vitest'
import { roundProducts } from '../../src/shared/productRound'
import { renderOrchestratorGuide, renderSubagent, sanitizeOrchestraRules } from '../../src/shared/orchestrator'
import type { Project } from '../../src/shared/types'

const p = (id: string, extra: Partial<Project> = {}): Project => ({ id, name: id, folderPath: `/${id}`, urls: [], ...extra })
const all = [p('all', { editorWorkspace: true, orchestrator: true }), p('shop'), p('old', { orchestrator: true }), p('remote', { source: 'ssh' }), p('blog')]

describe('巡回するプロダクト', () => {
  it('全体・以前のオーケストレーター・SSH は入れず、サイドバーの順', () => {
    expect(roundProducts(all).map((x) => x.id)).toEqual(['shop', 'blog'])
  })
})

describe('共通のルールとプロダクトごとのルール', () => {
  const child = { dir: 'shop', path: '/w/shop', outside: '/code/shop', projectId: 'shop', name: 'shop', agent: 'ferret-shop' }
  const rules = sanitizeOrchestraRules({ shared: 'Run the security check weekly.', products: { shop: 'AWS account 1234, tag team=shop', blog: '   ', 'bad id!': 'x' } })!

  it('空のもの・使えない id は捨てる', () => {
    expect(rules).toEqual({ shared: 'Run the security check weekly.', products: { shop: 'AWS account 1234, tag team=shop' } })
    expect(sanitizeOrchestraRules({ shared: ' ' })).toBeUndefined()
  })

  it('全体の CLAUDE.md の欄と、そのプロダクトの subagent に入る（ほかのプロダクトのルールは入らない）', () => {
    const guide = renderOrchestratorGuide([child], rules)
    expect(guide).toContain('### Shared rules (set by the human in Ferret)\n\nRun the security check weekly.')
    expect(guide).toContain('### Rules only for shop (set by the human in Ferret)\n\nAWS account 1234, tag team=shop')
    const sub = renderSubagent(child, rules)
    expect(sub).toContain('Run the security check weekly.')
    expect(sub).toContain('Rules only for shop')
    expect(renderSubagent({ ...child, projectId: 'blog', name: 'blog', agent: 'ferret-blog' }, rules)).not.toContain('AWS account 1234')
  })
})
