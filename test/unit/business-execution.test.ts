import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseYaml } from '@shared/business/format'
import { EXECUTION_QUESTIONS, coerceBusiness, defaultExecution, emptyBusiness } from '@shared/business/records'
import { EXECUTION_KEYS } from '@shared/business/model'
import { BusinessStore, LIMITS, mergeExecution } from '../../src/main/business/store'

const NOW = '2026-10-18T03:00:00.000Z'

describe('business.yaml の実行条件（execution）', () => {
  it('無い古い business.yaml は欄ごと無いまま読む（直しの知らせなし）', () => {
    const { value, fixes } = coerceBusiness({ name: '経理', step: 'S3' }, 'x', NOW)
    expect('execution' in value).toBe(false)
    expect(fixes).toEqual([])
    expect('execution' in emptyBusiness('x', NOW)).toBe(false)
    expect('execution' in coerceBusiness({ name: 'x', execution: null }, 'x', NOW).value).toBe(false)
  })

  it('書いてあれば4項目そろえて読む。決める内容だけの書き方・型違いも寄せる', () => {
    const { value, fixes } = coerceBusiness({ name: 'x', execution: { supply: '誰が提供するか', firstDeal: { plan: 'p', confirmed: true }, profitOps: { confirmed: 'たぶん' }, extra: 1 } }, 'x', NOW)
    expect(value.execution).toEqual({
      firstDeal: { plan: 'p', confirmed: true },
      supply: { plan: '誰が提供するか', confirmed: false },
      firstExperiment: { plan: '', confirmed: false },
      profitOps: { plan: '', confirmed: false }
    })
    expect(fixes.map((f) => f.field)).toEqual(['execution.profitOps.confirmed'])
    expect(coerceBusiness({ name: 'x', execution: 'x' }, 'x', NOW).fixes[0]?.field).toBe('execution')
  })

  it('defaultExecution: 空の plan は既定の問い（ナレッジの「決める内容」）、書いた plan と確認は保つ', () => {
    const d = defaultExecution('ja')
    expect(Object.keys(d)).toEqual([...EXECUTION_KEYS])
    for (const k of EXECUTION_KEYS) expect(d[k]).toEqual({ plan: EXECUTION_QUESTIONS[k].ja, confirmed: false })
    expect(d.supply.plan).toContain('誰が何を提供するか')
    expect(defaultExecution('en').firstDeal.plan).toMatch(/^Who orders what/)
    const kept = defaultExecution('ja', { supply: { plan: '協力会社2社', confirmed: true }, firstDeal: { plan: '  ' } })
    expect(kept.supply).toEqual({ plan: '協力会社2社', confirmed: true })
    expect(kept.firstDeal.plan).toBe(EXECUTION_QUESTIONS.firstDeal.ja)
    for (const k of EXECUTION_KEYS) expect(EXECUTION_QUESTIONS[k].en).not.toMatch(/[ぁ-んァ-ン一-龯]/)
  })

  it('mergeExecution: 一部だけ変える。知らない項目・型違い・長すぎる文は断る', () => {
    const base = defaultExecution('ja', { supply: { plan: 's', confirmed: false } })
    expect(mergeExecution(base, { supply: { confirmed: true } }).supply).toEqual({ plan: 's', confirmed: true })
    expect(mergeExecution(undefined, { firstDeal: { plan: '発注者は営業部長' } }).firstDeal.plan).toBe('発注者は営業部長')
    expect(mergeExecution(undefined, {}).profitOps.plan).toBe(EXECUTION_QUESTIONS.profitOps.ja)
    for (const bad of [null, [], 'x', { other: {} }, { supply: 'x' }, { supply: { confirmed: 'yes' } }, { supply: { plan: 3 } }, { supply: { plan: 'a'.repeat(LIMITS.executionPlan + 1) } }]) {
      expect(() => mergeExecution(base, bad), JSON.stringify(bad)?.slice(0, 40)).toThrow()
    }
  })
})

describe('BusinessStore.updateBusiness の execution', () => {
  let dir: string
  let store: BusinessStore
  beforeEach(async () => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'business-exec-')))
    store = new BusinessStore({ root: dir, now: () => new Date(NOW), manual: '# 手法' })
    await store.init({ name: '経理', target: 't' })
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('保存して読み直せる。ほかの欄は変えない', async () => {
    const snap = await store.updateBusiness({ execution: { supply: { plan: '協力会社', confirmed: true } } })
    expect(snap.data.business.execution?.supply).toEqual({ plan: '協力会社', confirmed: true })
    expect(snap.data.business.execution?.firstDeal.plan).toBe(EXECUTION_QUESTIONS.firstDeal.ja)
    expect(snap.data.business.name).toBe('経理')
    const yaml = parseYaml(readFileSync(join(dir, 'business.yaml'), 'utf8')) as { execution: Record<string, unknown> }
    expect(yaml.execution.supply).toEqual({ plan: '協力会社', confirmed: true })
    // 続けて別の項目を変えても前の値は残る
    const again = await store.updateBusiness({ execution: { firstExperiment: { confirmed: true } } })
    expect(again.data.business.execution?.supply).toEqual({ plan: '協力会社', confirmed: true })
    expect(again.data.business.execution?.firstExperiment.confirmed).toBe(true)
  })

  it('execution を渡さない変更では欄を作らない（古い business.yaml を勝手に変えない）', async () => {
    const snap = await store.updateBusiness({ name: '経理2' })
    expect(snap.data.business.execution).toBeUndefined()
    expect(readFileSync(join(dir, 'business.yaml'), 'utf8')).not.toContain('execution')
  })

  it('不正な execution は断り、ファイルを変えない', async () => {
    const before = readFileSync(join(dir, 'business.yaml'), 'utf8')
    await expect(store.updateBusiness({ execution: { supply: { confirmed: 1 } } })).rejects.toThrow('はい／いいえ')
    await expect(store.updateBusiness({ execution: { magic: {} } })).rejects.toThrow('項目')
    expect(readFileSync(join(dir, 'business.yaml'), 'utf8')).toBe(before)
  })

  it('手で書いた execution（Agent・人）も読む', async () => {
    writeFileSync(join(dir, 'business.yaml'), 'name: 経理\nstep: S6\nexecution:\n  supply: 誰が提供するか未確認\n')
    const snap = await store.load()
    expect(snap.data.business.execution?.supply).toEqual({ plan: '誰が提供するか未確認', confirmed: false })
  })
})
