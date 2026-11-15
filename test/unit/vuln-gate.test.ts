/**
 * 公開の前の依存の脆弱性の判定（scripts/vuln-gate.mjs）。osv-scanner の JSON の形の固定の入力だけで確かめる（ネットワークは使わない）
 */
import { describe, expect, it } from 'vitest'
import { BLOCK_SCORE, blockingFindings, classify } from '../../scripts/vuln-gate.mjs'

const report = (packages: unknown[]) => ({ results: [{ source: { path: '/x/pnpm-lock.yaml', type: 'lockfile' }, packages }] })
const pkg = (name: string, version: string, groups: Array<{ ids: string[]; max_severity: string }>, labels: Record<string, string> = {}) => ({
  package: { name, version, ecosystem: 'npm' },
  groups,
  vulnerabilities: groups.flatMap((g) => g.ids).map((id) => ({ id, ...(labels[id] ? { database_specific: { severity: labels[id] } } : {}) }))
})

describe('vuln-gate', () => {
  it('CVSS 7.0 以上で止める（境目）', () => {
    expect(BLOCK_SCORE).toBe(7)
    expect(classify('7.0', undefined)).toBe('block')
    expect(classify('9.8', undefined)).toBe('block')
    expect(classify('6.9', undefined)).toBe('pass')
    expect(classify('0', undefined)).toBe('pass')
  })

  it('点数が無ければ GitHub の分類で決め、どちらも無ければ unknown', () => {
    expect(classify('', 'HIGH')).toBe('block')
    expect(classify('', 'critical')).toBe('block')
    expect(classify('', 'MODERATE')).toBe('pass')
    expect(classify('', 'LOW')).toBe('pass')
    expect(classify('', undefined)).toBe('unknown')
    expect(classify(undefined, 'weird')).toBe('unknown')
    // 点数があれば点数を使う
    expect(classify('5.0', 'HIGH')).toBe('pass')
  })

  it('High・Critical だけを止めるものに、重さの分からないものは別に分ける', () => {
    const r = report([
      pkg('dompurify', '3.4.15', [
        { ids: ['GHSA-cg2g-xh64-v4q7'], max_severity: '9.2' },
        { ids: ['GHSA-6688-9rhm-gjv2'], max_severity: '' },
        { ids: ['GHSA-p98j-92pf-mc4p'], max_severity: '2.3' }
      ], { 'GHSA-6688-9rhm-gjv2': 'LOW' }),
      pkg('undici', '6.29.0', [{ ids: ['GHSA-qrxm-fqhp-jwvm'], max_severity: '' }], { 'GHSA-qrxm-fqhp-jwvm': 'HIGH' }),
      pkg('left-pad', '1.0.0', [{ ids: ['OSV-1'], max_severity: '' }])
    ])
    const { blocking, unknown } = blockingFindings(r)
    expect(blocking.map((f) => `${f.package}@${f.version} ${f.id}`)).toEqual(['dompurify@3.4.15 GHSA-cg2g-xh64-v4q7', 'undici@6.29.0 GHSA-qrxm-fqhp-jwvm'])
    expect(blocking[0]).toMatchObject({ severity: '9.2', source: '/x/pnpm-lock.yaml' })
    expect(unknown.map((f) => f.package)).toEqual(['left-pad'])
  })

  it('見つからない・空・壊れた形でも落ちず、止めない', () => {
    expect(blockingFindings({ results: [] })).toEqual({ blocking: [], unknown: [] })
    expect(blockingFindings({})).toEqual({ blocking: [], unknown: [] })
    expect(blockingFindings(null)).toEqual({ blocking: [], unknown: [] })
    expect(blockingFindings({ results: [{ packages: [{ groups: [{ max_severity: '8.0' }] }] }] }).blocking).toHaveLength(1)
  })
})
