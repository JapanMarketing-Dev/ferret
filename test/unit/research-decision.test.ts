/**
 * 購買が起きる場面・調査の終了条件・次の行動（knowledge.md 第2部 5・6・9章）
 */
import { describe, expect, it } from 'vitest'
import { EXIT_KEYS, type Candidate, type PurchaseScene } from '@shared/research/model'
import { EXIT_PRINCIPLES, exitChecks, nextDecision, researchExit, sceneComplete, sceneSentence } from '@shared/research/decision'
import { blankCandidate, blankScene, conditions, emptyData, fullCandidate, fullData, fullExperiment, monetization, scene } from './research-fixtures'

const full = fullCandidate('C001')
const C = (patch: Partial<Candidate>) => fullCandidate('C001', patch)

describe('sceneComplete', () => {
  it('5欄すべて埋まっていれば true', () => {
    expect(sceneComplete(scene())).toBe(true)
  })

  it.each(['company', 'who', 'event', 'outcome', 'currentHandling'] as const)('%s が空・空白なら false', (k) => {
    expect(sceneComplete(scene({ [k]: '' }))).toBe(false)
    expect(sceneComplete(scene({ [k]: ' \n ' }))).toBe(false)
  })

  it('壊れた入力', () => {
    expect(sceneComplete(null as never)).toBe(false)
    expect(sceneComplete({ ...scene(), who: 3 } as never)).toBe(false)
    expect(sceneComplete(blankScene())).toBe(false)
  })
})

describe('sceneSentence', () => {
  it('日本語の一文（event の「とき」を重ねない）', () => {
    expect(sceneSentence(scene(), 'ja')).toBe(
      '従業員20〜100人の IT 企業の新規法人営業の責任者が、営業担当を増員したときに、今週アプローチすべき企業と理由を必要とし、今は担当者が求人サイトと企業サイトを見て Excel に転記している。'
    )
    expect(sceneSentence(scene({ event: '契約更新が近い時に' }), 'ja')).toContain('契約更新が近いときに')
    expect(sceneSentence(scene({ event: '締切が迫る' }), 'ja')).toContain('締切が迫るときに')
  })

  it('末尾の句点を重ねない', () => {
    expect(sceneSentence(scene({ currentHandling: '手作業。' }), 'ja').endsWith('今は手作業。')).toBe(true)
  })

  it('英語の一文', () => {
    const s: PurchaseScene = { company: 'small IT firms', who: 'the sales lead', event: 'they hire more reps', outcome: 'a list of accounts to call this week', currentHandling: 'copying job ads into a spreadsheet.' }
    expect(sceneSentence(s, 'en')).toBe('When they hire more reps, the sales lead at small IT firms needs a list of accounts to call this week; today: copying job ads into a spreadsheet.')
  })

  it('空の欄は未記入と示す', () => {
    expect(sceneSentence(blankScene(), 'ja')).toBe('（未記入）の（未記入）が、（未記入）ときに、（未記入）を必要とし、今は（未記入）。')
    expect(sceneSentence(blankScene(), 'en')).toBe('When (not written), (not written) at (not written) needs (not written); today: (not written).')
    expect(sceneSentence(null as never, 'ja')).toContain('（未記入）')
    expect(sceneSentence(scene({ event: 'とき' }), 'ja')).toContain('（未記入）ときに')
  })
})

describe('researchExit', () => {
  it('全欄を埋めた候補は6項目すべて満たす', () => {
    expect(researchExit(full, fullData())).toEqual({ done: true, items: Object.fromEntries(EXIT_KEYS.map((k) => [k, true])) })
  })

  it('何も無ければすべて false', () => {
    const r = researchExit(blankCandidate('C001'), emptyData())
    expect(r.done).toBe(false)
    expect(Object.values(r.items).every((v) => v === false)).toBe(true)
  })

  it('targetCustomer: 場面の企業とセグメントの軸のどれか', () => {
    expect(researchExit(C({ scene: scene({ company: '' }) }), fullData()).items.targetCustomer).toBe(false)
    const seg = { attribute: '', situation: '', behavior: '', problem: '', purchase: '' }
    expect(researchExit(C({ who: { ...full.who, segment: seg } }), fullData()).items.targetCustomer).toBe(false)
    expect(researchExit(C({ who: { ...full.who, segment: { ...seg, behavior: '求人を出している' } } }), fullData()).items.targetCustomer).toBe(true)
  })

  it('situation・currentHandling・deliverable', () => {
    expect(researchExit(C({ scene: scene({ event: ' ' }) }), fullData()).items.situation).toBe(false)
    expect(researchExit(C({ scene: scene({ currentHandling: '' }) }), fullData()).items.currentHandling).toBe(false)
    expect(researchExit(C({ deliverable: '' }), fullData()).items.deliverable).toBe(false)
  })

  it('contactPoint: 経路か、企業の到達経路', () => {
    const noCh = { ...full.where, channels: [] }
    expect(researchExit(C({ where: noCh }), fullData()).items.contactPoint).toBe(true)
    const noReach = full.who.companies.map((x) => ({ ...x, reachPath: '' }))
    expect(researchExit(C({ where: noCh, who: { ...full.who, companies: noReach } }), fullData()).items.contactPoint).toBe(false)
    expect(researchExit(C({ where: { ...full.where, channels: [{ ...full.where.channels[0], channel: 'tv' as never }] }, who: { ...full.who, companies: noReach } }), fullData()).items.contactPoint).toBe(false)
  })

  it('revenueLink: 無料から有料へのつながりの文、または月額 > 0', () => {
    const noPath = monetization({ freeToPaidPath: '' })
    expect(researchExit(C({ monetization: noPath }), fullData()).items.revenueLink).toBe(true)
    expect(researchExit(C({ monetization: noPath, how: { ...full.how, monthlyPrice: 0 } }), fullData()).items.revenueLink).toBe(false)
    expect(researchExit(C({ monetization: noPath, how: { ...full.how, monthlyPrice: NaN } }), fullData()).items.revenueLink).toBe(false)
    expect(researchExit(C({ monetization: monetization(), how: { ...full.how, monthlyPrice: null } }), fullData()).items.revenueLink).toBe(true)
  })

  it('壊れた候補でも落ちない', () => {
    expect(researchExit({ id: 'C001' } as never, emptyData()).done).toBe(false)
  })
})

describe('exitChecks', () => {
  it('6項目の Check（満たさないものは null）と原則の対応', () => {
    const checks = exitChecks(C({ deliverable: '' }), fullData())
    expect(checks.map((c) => `${c.principle}.${c.id}`)).toEqual(EXIT_KEYS.map((k) => `${EXIT_PRINCIPLES[k]}.${k}`))
    expect(checks.find((c) => c.id === 'deliverable')?.ok).toBeNull()
    expect(checks.filter((c) => c.ok === true)).toHaveLength(5)
  })
})

describe('nextDecision', () => {
  it('調べることが残っていれば continue（理由はまだの終了条件）', () => {
    const r = nextDecision(C({ deliverable: '', scene: scene({ event: '' }) }), fullData())
    expect(r.suggestion).toBe('continue')
    expect(r.reasons.map((c) => c.id)).toEqual(['situation', 'deliverable'])
  })

  it('終了条件を満たし、反応・支払いが未確認なら experiment', () => {
    const r = nextDecision(full, fullData())
    expect(r.suggestion).toBe('experiment')
    expect(r.reasons.map((c) => c.id)).toEqual(['stageFirstDeal', 'stageRepeatability', 'stageUnitEconomics'])
  })

  it('初回取引の後も、再現性と採算がそろうまでは experiment', () => {
    expect(nextDecision(full, fullData({ experiments: [fullExperiment('X001')] })).suggestion).toBe('experiment')
  })

  it('再現性と採算が確認できれば invest', () => {
    const r = nextDecision(full, fullData({ experiments: [fullExperiment('X001'), fullExperiment('X002')] }))
    expect(r.suggestion).toBe('invest')
    expect(r.reasons.every((c) => c.ok === true)).toBe(true)
  })

  it('重要な条件に反証があれば、ほかがそろっていても holdOrDrop', () => {
    const c = C({ conditions: conditions({ support: ['E001'], status: 'supported' }, { revenue: { counter: ['E002'] }, problemStrong: { status: 'refuted' } }) })
    const r = nextDecision(c, fullData({ experiments: [fullExperiment('X001'), fullExperiment('X002')] }))
    expect(r.suggestion).toBe('holdOrDrop')
    expect(r.reasons).toEqual([
      { id: 'conditionAlarm', principle: 'what', ok: false, params: { condition: 'problemStrong' } },
      { id: 'conditionAlarm', principle: 'how', ok: false, params: { condition: 'revenue' } }
    ])
  })

  it('何も無ければ continue（6項目すべてが理由）', () => {
    const r = nextDecision(blankCandidate('C001'), emptyData())
    expect(r.suggestion).toBe('continue')
    expect(r.reasons).toHaveLength(6)
  })

  it('人の decision は機械の目安に影響しない', () => {
    expect(nextDecision(C({ decision: 'invest' }), fullData()).suggestion).toBe('experiment')
  })

  it('壊れた候補でも落ちない', () => {
    expect(nextDecision({ id: 'C001' } as never, emptyData()).suggestion).toBe('continue')
  })
})
