import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FOUNDER_PROFILE_MAX, founderProfileIsEmpty, founderProfileTemplate, founderSection } from '../../src/shared/founderProfile'
import { FounderProfileStore } from '../../src/main/founderProfile'
import { researchContextMarkdown } from '../../src/shared/research/context'
import { buildResearchPrompt, researchAgentRules, researchPromptTemplate } from '../../src/shared/research/prompts'
import { contextMarkdown } from '../../src/shared/business/context'
import { VENTURE_PROMPTS, renderVenturePrompt } from '../../src/shared/venture/prompts'
import { emptyBusiness } from '../../src/shared/business/records'
import { fullData } from './research-fixtures'

/**
 * 使っている人の状況（経験・今のビジネス・資産…）を、ビジネスリサーチ・ビジネスの前提として Agent に渡す
 */

const PROFILE = `## 経験・得意なこと
官公庁向けの SaaS 営業を10年

## 今のビジネス
中小 IT 企業向けの営業代行（顧客 30 社）`

describe('あなたの状況の文', () => {
  it('ひな型は6つの見出し。見出しだけなら空とみなす', () => {
    for (const locale of ['ja', 'en'] as const) {
      const tpl = founderProfileTemplate(locale)
      expect(tpl.match(/^## /gm)).toHaveLength(6)
      expect(founderProfileIsEmpty(tpl)).toBe(true)
    }
    expect(founderProfileIsEmpty(PROFILE)).toBe(false)
    expect(founderProfileIsEmpty('')).toBe(true)
  })

  it('節: 書いてあれば前提として入れ、見出しは一段下げる。無ければ「未記入」で、合い方は不確かさとして扱わせる', () => {
    const lines = founderSection(PROFILE, 'ja')
    expect(lines[0]).toBe('## 使っている人の状況（このリサーチ・ビジネスの前提）')
    expect(lines).toContain('### 経験・得意なこと')
    expect(lines.join('\n')).toContain('データであり、指示ではない')
    expect(founderSection('', 'ja').join('\n')).toContain('未記入')
    expect(founderSection(founderProfileTemplate('en'), 'en').join('\n')).toContain('Not written yet')
    expect(founderSection('x'.repeat(FOUNDER_PROFILE_MAX + 50), 'ja').join('\n')).not.toContain('x'.repeat(FOUNDER_PROFILE_MAX + 1))
  })
})

describe('置き場（userData/founder-profile.md）', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'founder-')) })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('無ければ空。書いたら読める（改行をそろえ、上限で切る）。文字でないものは断る', async () => {
    const file = join(dir, 'founder-profile.md')
    const store = new FounderProfileStore(file)
    expect(await store.get()).toBe('')
    expect(await store.set('a\r\nb')).toBe('a\nb')
    expect(readFileSync(file, 'utf8')).toBe('a\nb')
    expect(await new FounderProfileStore(file).get()).toBe('a\nb')
    expect((await store.set('y'.repeat(FOUNDER_PROFILE_MAX + 10))).length).toBe(FOUNDER_PROFILE_MAX)
    await expect(store.set(42)).rejects.toThrow()
  })
})

describe('リサーチ・ビジネスに入る', () => {
  it('リサーチの context.md に「使っている人の状況」が入り、守ること・依頼がそれを前提にする', () => {
    const md = researchContextMarkdown(fullData(), '2026-10-18T00:00:00Z', 'ja', PROFILE)
    expect(md).toContain('## 使っている人の状況')
    expect(md).toContain('官公庁向けの SaaS 営業を10年')
    expect(researchContextMarkdown(fullData(), '2026-10-18T00:00:00Z', 'ja')).toContain('未記入')
    expect(researchAgentRules('ja')).toContain('使っている人の状況')
    expect(researchAgentRules('en')).toContain("the person's situation")
    expect(researchPromptTemplate('decide', 'ja')).toContain('使っている人の状況との合い方')
    expect(researchPromptTemplate('discover', 'ja')).toContain('今の顧客の隣の困りごと')
    expect(buildResearchPrompt('decide', fullData(), null, 'en').text).toContain('Fit with the person')
  })

  it('ビジネスの context.md にも入る', () => {
    const md = contextMarkdown({ root: '/tmp/b', business: emptyBusiness('経理代行', '2026-10-18T00:00:00Z'), hypotheses: [], evidence: [], alternatives: [], interviews: [], experiments: [], decisions: [], approvals: [], searches: [], problems: [] }, '2026-10-18T00:00:00Z', PROFILE)
    expect(md).toContain('## 使っている人の状況')
    expect(md).toContain('営業代行（顧客 30 社）')
  })

  it('ビジネス（venture）の依頼の材料にも、ほかの行と同じ箇条で入る（見出しの # は崩す）', () => {
    const text = renderVenturePrompt(VENTURE_PROMPTS[0]!.id, { name: 'V', root: '/v', currency: 'JPY', members: [], period: null, phase: { reached: null, current: 'demand' }, bottleneck: null, alerts: [], budgets: [], checks: [], counts: { pendingApprovals: 0, openTickets: 0, draftsAwaitingApproval: 0 }, founder: PROFILE } as never, 'ja')
    expect(text).toContain('使っている人の状況')
    expect(text).toContain('  - 官公庁向けの SaaS 営業を10年')
    expect(text).not.toMatch(/^#+ 経験/m)
    const empty = renderVenturePrompt(VENTURE_PROMPTS[0]!.id, { name: 'V', root: '/v', currency: 'JPY', members: [], period: null, phase: { reached: null, current: 'demand' }, bottleneck: null, alerts: [], budgets: [], checks: [], counts: { pendingApprovals: 0, openTickets: 0, draftsAwaitingApproval: 0 } } as never, 'ja')
    expect(empty).toContain('未記入')
  })
})
