/** 内蔵ブラウザを動かす口のプロジェクトの範囲（src/main/browserScope.ts）。プロジェクトをまたいで動かさない */
import { describe, expect, it } from 'vitest'
import { CDP_OTHER_PROJECT_ERROR, cdpScopeOf, isCdpScope, splitScope } from '../../src/main/browserScope'

describe('プロジェクトの印', () => {
  it('英数字・_・- の id はそのまま、ほかは短い要約。無ければ null', () => {
    expect(cdpScopeOf('p_abc-123')).toBe('p_abc-123')
    const hashed = cdpScopeOf('日本語/../x')!
    expect(hashed).toMatch(/^h[0-9a-f]{24}$/)
    expect(cdpScopeOf('日本語/../x')).toBe(hashed)
    expect(cdpScopeOf('a'.repeat(65))).toMatch(/^h[0-9a-f]{24}$/)
    expect(cdpScopeOf(null)).toBeNull()
    expect(cdpScopeOf('')).toBeNull()
  })

  it('印として受け付ける形', () => {
    expect(isCdpScope('a')).toBe(true)
    for (const bad of ['', 'a/b', 'a b', '..', 'a'.repeat(65)]) expect(isCdpScope(bad)).toBe(false)
  })

  it('道から印を分ける（無い・形が違うときは印なし）', () => {
    expect(splitScope('/p/proj-a/json/list')).toEqual({ scope: 'proj-a', path: '/json/list' })
    expect(splitScope('/p/proj-a')).toEqual({ scope: 'proj-a', path: '/' })
    expect(splitScope('/json/version')).toEqual({ scope: null, path: '/json/version' })
    expect(splitScope('/p/a b/json')).toEqual({ scope: null, path: '/p/a b/json' })
  })

  it('Agent への理由はプロジェクトの名前を出さず、ほかの手段を示す', () => {
    expect(CDP_OTHER_PROJECT_ERROR).toContain('another project')
    expect(CDP_OTHER_PROJECT_ERROR).toContain('your own browser')
  })
})
