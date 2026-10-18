/**
 * 証拠の強さの集計（knowledge.md 第2原則「証拠の強弱」）
 */
import { describe, expect, it } from 'vitest'
import { EVIDENCE_GRADES, GRADE_RELIABILITY, type EvidenceGrade, type ResearchEvidence } from '@shared/research/model'
import { evidenceHost, evidenceSourceKey, isEvaluated, isUsableAsProof, readingScore, RELIABILITY_POINTS, reliabilityOf, summarizeEvidence } from '@shared/research/evidence'
import { fullEvidence, reading } from './research-fixtures'

describe('RELIABILITY_POINTS・reliabilityOf', () => {
  it('5区分に 5〜1 点', () => {
    expect(RELIABILITY_POINTS).toEqual({ high: 5, fairlyHigh: 4, medium: 3, lowMedium: 2, low: 1 })
  })

  it.each(EVIDENCE_GRADES.map((g) => [g, GRADE_RELIABILITY[g]]))('%s → %s', (grade, r) => {
    expect(reliabilityOf(grade as EvidenceGrade)).toBe(r)
  })

  it('知らない種類・壊れた値は low', () => {
    expect(reliabilityOf('rumor' as EvidenceGrade)).toBe('low')
    expect(reliabilityOf(undefined as unknown as EvidenceGrade)).toBe('low')
    expect(reliabilityOf('toString' as EvidenceGrade)).toBe('low')
  })
})

describe('evidenceHost', () => {
  it.each([
    ['https://www.Example.com/a', 'example.com'],
    ['http://sub.example.com', 'sub.example.com'],
    ['  https://example.com/x  ', 'example.com']
  ])('%s → %s', (url, host) => {
    expect(evidenceHost(url)).toBe(host)
  })

  it.each([[''], ['   '], ['example.com'], ['ftp://example.com'], ['javascript:alert(1)'], ['file:///etc/passwd'], ['https://'], [null], [42]])('%s は null', (url) => {
    expect(evidenceHost(url)).toBeNull()
  })
})

describe('isUsableAsProof', () => {
  it('URL・原文・事実がそろえば使える', () => {
    expect(isUsableAsProof(fullEvidence('E001'))).toBe(true)
  })

  it('原文か事実のどちらかがあればよい', () => {
    expect(isUsableAsProof(fullEvidence('E001', { quote: '' }))).toBe(true)
    expect(isUsableAsProof(fullEvidence('E001', { fact: '' }))).toBe(true)
    expect(isUsableAsProof(fullEvidence('E001', { quote: '  ', fact: '\n' }))).toBe(false)
  })

  it('AI の推測は使えない（調査すべき仮説）', () => {
    expect(isUsableAsProof(fullEvidence('E001', { grade: 'aiInference' }))).toBe(false)
  })

  it('URL が http(s) でなければ使えない', () => {
    expect(isUsableAsProof(fullEvidence('E001', { url: '' }))).toBe(false)
    expect(isUsableAsProof(fullEvidence('E001', { url: 'orders.example.com/x' }))).toBe(false)
    expect(isUsableAsProof(fullEvidence('E001', { url: 'javascript:void(0)' }))).toBe(false)
  })

  it('壊れた記録は使えない', () => {
    expect(isUsableAsProof(null as unknown as ResearchEvidence)).toBe(false)
    expect(isUsableAsProof(fullEvidence('E001', { grade: 'unknown' as EvidenceGrade }))).toBe(false)
    expect(isUsableAsProof(fullEvidence('E001', { quote: 5 as unknown as string, fact: null as unknown as string }))).toBe(false)
  })

  it('企業の状況の事実（companyFact）は裏付けに使える（中程度）', () => {
    expect(isUsableAsProof(fullEvidence('E001', { grade: 'companyFact' }))).toBe(true)
  })
})

describe('summarizeEvidence', () => {
  const ev = (id: string, grade: EvidenceGrade, host: string, patch: Partial<ResearchEvidence> = {}) =>
    fullEvidence(id, { grade, url: `https://${host}/${id}`, ...patch })

  it('空なら none', () => {
    expect(summarizeEvidence([])).toEqual({
      count: 0,
      byReliability: { high: 0, fairlyHigh: 0, medium: 0, lowMedium: 0, low: 0 },
      best: null,
      level: 'none',
      spend: 0,
      complaint: 0,
      spendAndComplaint: false,
      independentSources: 0
    })
  })

  it('配列でない入力は空として扱う', () => {
    expect(summarizeEvidence(null as unknown as ResearchEvidence[]).level).toBe('none')
    expect(summarizeEvidence([null, 1, 'x'] as unknown as ResearchEvidence[]).count).toBe(0)
  })

  it('high が2つの媒体から → strong', () => {
    const s = summarizeEvidence([ev('E001', 'contract', 'a.example.com'), ev('E002', 'paidUsage', 'b.example.com')])
    expect(s.level).toBe('strong')
    expect(s.best).toBe('high')
    expect(s.independentSources).toBe(2)
  })

  it('high とほかの媒体の弱い証拠でも strong（独立した媒体が2つ）', () => {
    expect(summarizeEvidence([ev('E001', 'contract', 'a.example.com'), ev('E002', 'snsComplaint', 'x.com')]).level).toBe('strong')
  })

  it('high でも媒体が1つなら moderate', () => {
    const s = summarizeEvidence([ev('E001', 'contract', 'a.example.com'), ev('E002', 'budgetedTender', 'www.a.example.com')])
    expect(s.independentSources).toBe(1)
    expect(s.level).toBe('moderate')
  })

  it('fairlyHigh だけで moderate', () => {
    expect(summarizeEvidence([ev('E001', 'competitorCase', 'a.example.com')]).level).toBe('moderate')
  })

  it('medium が2つの媒体から → moderate、1つなら weak', () => {
    expect(summarizeEvidence([ev('E001', 'searchDemand', 'a.example.com'), ev('E002', 'reviewComplaint', 'b.example.com')]).level).toBe('moderate')
    expect(summarizeEvidence([ev('E001', 'searchDemand', 'a.example.com'), ev('E002', 'reviewComplaint', 'a.example.com')]).level).toBe('weak')
  })

  it('SNS の不満が多くの媒体から集まっても weak（medium に届かない）', () => {
    const s = summarizeEvidence([ev('E001', 'snsComplaint', 'a.com'), ev('E002', 'snsComplaint', 'b.com'), ev('E003', 'snsComplaint', 'c.com')])
    expect(s.level).toBe('weak')
    expect(s.best).toBe('lowMedium')
  })

  it('AI の推測だけなら none（件数・区分には数える）', () => {
    const s = summarizeEvidence([ev('E001', 'aiInference', 'a.com'), ev('E002', 'aiInference', 'b.com')])
    expect(s.level).toBe('none')
    expect(s.best).toBeNull()
    expect(s.count).toBe(2)
    expect(s.byReliability.low).toBe(2)
    expect(s.independentSources).toBe(0)
  })

  it('URL の無い契約は裏付けに数えない', () => {
    const s = summarizeEvidence([ev('E001', 'contract', 'a.com', { url: '' })])
    expect(s.byReliability.high).toBe(1)
    expect(s.best).toBeNull()
    expect(s.spend).toBe(0)
    expect(s.level).toBe('none')
  })

  it('支出と不満が同時に確認できる', () => {
    const s = summarizeEvidence([ev('E001', 'paidUsage', 'a.com'), ev('E002', 'reviewComplaint', 'b.com')])
    expect(s.spend).toBe(1)
    expect(s.complaint).toBe(1)
    expect(s.spendAndComplaint).toBe(true)
    expect(summarizeEvidence([ev('E001', 'paidUsage', 'a.com')]).spendAndComplaint).toBe(false)
    expect(summarizeEvidence([ev('E002', 'snsComplaint', 'b.com')]).spendAndComplaint).toBe(false)
  })

  it('企業の状況の事実は支出にも不満にも数えない', () => {
    const s = summarizeEvidence([ev('E001', 'companyFact', 'a.com'), ev('E002', 'companyFact', 'b.com')])
    expect(s.spend + s.complaint).toBe(0)
    expect(s.level).toBe('moderate')
  })

  it('同じ ID は1件として数える', () => {
    const s = summarizeEvidence([ev('E001', 'contract', 'a.com'), ev('E001', 'contract', 'b.com')])
    expect(s.count).toBe(1)
    expect(s.independentSources).toBe(1)
    expect(s.level).toBe('moderate')
  })

  it('ID の無い証拠はそれぞれ数える', () => {
    expect(summarizeEvidence([ev('', 'contract', 'a.com'), ev('', 'contract', 'b.com')]).count).toBe(2)
  })

  it('大量の証拠でも数がそろう', () => {
    const list = Array.from({ length: 5000 }, (_, i) => ev(`E${i}`, 'searchDemand', `h${i % 7}.example.com`))
    const s = summarizeEvidence(list)
    expect(s.count).toBe(5000)
    expect(s.byReliability.medium).toBe(5000)
    expect(s.independentSources).toBe(7)
  })
})

describe('読む5観点・評価の工程（第2部）', () => {
  it('readingScore は観点ごとの数（未評価・壊れた値は unset）', () => {
    expect(readingScore(fullEvidence('E001'))).toEqual({ ok: 5, weak: 0, ng: 0, unset: 0 })
    expect(readingScore(fullEvidence('E001', { reading: reading(null, { match: 'ok', timing: 'weak', independence: 'ng', selectionBias: 'bad' as never }) }))).toEqual({ ok: 1, weak: 1, ng: 1, unset: 2 })
    expect(readingScore(fullEvidence('E001', { reading: null as never }))).toEqual({ ok: 0, weak: 0, ng: 0, unset: 5 })
    expect(readingScore(null as never)).toEqual({ ok: 0, weak: 0, ng: 0, unset: 5 })
  })

  it('isEvaluated は state が evaluated のときだけ', () => {
    expect(isEvaluated(fullEvidence('E001'))).toBe(true)
    expect(isEvaluated(fullEvidence('E001', { state: 'collected' }))).toBe(false)
    expect(isEvaluated(fullEvidence('E001', { state: 'done' as never }))).toBe(false)
    expect(isEvaluated(null as never)).toBe(false)
  })

  it('未評価（collected）でも裏付けに使える', () => {
    expect(isUsableAsProof(fullEvidence('E001', { state: 'collected', reading: reading(null) }))).toBe(true)
  })

  it('対象との一致か時点の適切さが ng なら使わない', () => {
    expect(isUsableAsProof(fullEvidence('E001', { reading: reading('ok', { match: 'ng' }) }))).toBe(false)
    expect(isUsableAsProof(fullEvidence('E001', { reading: reading('ok', { timing: 'ng' }) }))).toBe(false)
  })

  it('独立性・偏り・具体性の ng、weak では外さない', () => {
    expect(isUsableAsProof(fullEvidence('E001', { reading: reading('ok', { independence: 'ng', selectionBias: 'ng', specificity: 'ng' }) }))).toBe(true)
    expect(isUsableAsProof(fullEvidence('E001', { reading: reading('weak') }))).toBe(true)
  })

  it('evidenceSourceKey: dupGroup を優先し、無ければホスト名', () => {
    expect(evidenceSourceKey(fullEvidence('E001', { dupGroup: ' Press-1 ' }))).toBe('group:press-1')
    expect(evidenceSourceKey(fullEvidence('E001', { dupGroup: '', url: 'https://www.a.com/x' }))).toBe('host:a.com')
    expect(evidenceSourceKey(fullEvidence('E001', { dupGroup: '  ', url: '' }))).toBeNull()
    expect(evidenceSourceKey(fullEvidence('E001', { dupGroup: 3 as never, url: 'https://a.com' }))).toBe('host:a.com')
    expect(evidenceSourceKey(null as never)).toBeNull()
  })

  it('同じ dupGroup（転載）は別のホストでも独立した出どころ1つ', () => {
    const list = [
      fullEvidence('E001', { url: 'https://a.com/1', dupGroup: 'press' }),
      fullEvidence('E002', { url: 'https://b.com/1', dupGroup: 'press' })
    ]
    const s = summarizeEvidence(list)
    expect(s.independentSources).toBe(1)
    expect(s.level).toBe('moderate')
    expect(s.count).toBe(2)
  })

  it('dupGroup が違えば同じホストでも別の出どころ', () => {
    const list = [
      fullEvidence('E001', { url: 'https://a.com/1', dupGroup: 'x' }),
      fullEvidence('E002', { url: 'https://a.com/2', dupGroup: 'y' })
    ]
    expect(summarizeEvidence(list)).toMatchObject({ independentSources: 2, level: 'strong' })
  })

  it('ng で外れた証拠は強さに数えない', () => {
    const s = summarizeEvidence([fullEvidence('E001', { reading: reading('ok', { timing: 'ng' }) })])
    expect(s).toMatchObject({ count: 1, best: null, level: 'none', spend: 0 })
  })
})
