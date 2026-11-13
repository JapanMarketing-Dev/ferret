/**
 * 0.6.5 のオーケストラ：1回の録画をプロダクトごとに分ける（src/shared/productSplit.ts）、
 * 作業の途中で閉じたターミナルの再開の印（src/shared/terminalRestore.ts）
 */
import { describe, expect, it } from 'vitest'
import { productForUrl, splitByProduct } from '../../src/shared/productSplit'

describe('1回の録画をプロダクトごとに分ける', () => {
  const projects = [
    { id: 'shop', name: 'Shop', folderPath: '/w/shop', urls: [{ url: 'http://localhost:3000/' }, { url: 'https://shop.example.com' }] },
    { id: 'blog', name: 'Blog', folderPath: '/w/blog', urls: [{ url: 'http://localhost:4000' }] },
    { id: 'admin', name: 'Admin', folderPath: '/w/admin', urls: [{ url: 'https://example.com/admin' }] },
    { id: 'docs', name: 'Docs', folderPath: '/w/docs', urls: [{ url: 'https://example.com/docs/' }] }
  ]

  it('同じページ・その下のページ・同じオリジンのプロダクトが1つだけ、で決める。同じオリジンが複数ならパスで', () => {
    expect(productForUrl(projects, 'http://localhost:3000/cart?x=1')).toBe('shop')
    expect(productForUrl(projects, 'https://shop.example.com/items/3')).toBe('shop')
    expect(productForUrl(projects, 'http://localhost:4000/posts')).toBe('blog')
    expect(productForUrl(projects, 'https://example.com/admin/users')).toBe('admin')
    expect(productForUrl(projects, 'https://example.com/docs')).toBe('docs')
    expect(productForUrl(projects, 'https://example.com/pricing')).toBeNull()
    expect(productForUrl(projects, 'https://example.com/administrator')).toBeNull()
    expect(productForUrl(projects, 'http://localhost:5000/')).toBeNull()
    expect(productForUrl(projects, undefined)).toBeNull()
    expect(productForUrl(projects, 'file:///etc/passwd')).toBeNull()
  })

  it('URL の無い指摘（ウインドウを映していた）は直前のプロダクト。合わない URL は決めない。並びは登録順で、決まらないものは最後', () => {
    const shares = splitByProduct(projects, [
      { index: 3, t: 30, url: 'http://localhost:4000/a' },
      { index: 1, t: 10, url: 'http://localhost:3000/' },
      { index: 2, t: 20 },
      { index: 4, t: 40, url: 'https://unknown.example/' },
      { index: 5, t: 50 },
      { index: 6, t: 60, url: 'http://localhost:3000/b' }
    ])
    expect(shares).toEqual([
      { projectId: 'shop', indexes: [1, 2, 6] },
      { projectId: 'blog', indexes: [3, 5] },
      { projectId: null, indexes: [4] }
    ])
    // 最初が URL 無しなら決めない
    expect(splitByProduct(projects, [{ index: 1, t: 0 }])).toEqual([{ projectId: null, indexes: [1] }])
  })

  it('main は全体で録ったものをプロダクトごとに並行して送り、帯は文字のフィードバックをそのプロダクトに送る', async () => {
    const { readFile } = await import('node:fs/promises')
    const main = await readFile(new URL('../../src/main/index.ts', import.meta.url), 'utf8')
    expect(main).toContain('sendSplitByProduct(paths, data.document.items')
    const split = await readFile(new URL('../../src/main/productSplitSend.ts', import.meta.url), 'utf8')
    expect(split).toMatch(/await Promise\.all\(jobs\)/)
    const dock = await readFile(new URL('../../src/renderer/components/OrchestraDock.tsx', import.meta.url), 'utf8')
    expect(dock).toContain('<OrchestraComposer compact product={product} />')
  })
})
