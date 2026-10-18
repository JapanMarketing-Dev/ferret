import { describe, expect, it } from 'vitest'
import { en } from '../../src/shared/i18n/en'
import {
  CANDIDATE_STAGES,
  CHANNEL_AXES,
  CHANNELS,
  COMPARISON_METHODS,
  CUSTOMER_STATES,
  DEMAND_FACTORS,
  DEMAND_LEVELS,
  DIFFERENTIATORS,
  EVIDENCE_GRADES,
  EVIDENCE_KINDS,
  EXPERIMENT_METHODS,
  EXPERIMENT_STATUSES,
  GATE_IDS,
  METRIC_KEYS,
  PRINCIPLE_KEYS,
  PROBLEM_TYPES,
  RELIABILITY_LEVELS,
  RESEARCH_SECTIONS,
  SCORE_KEYS,
  SEGMENT_AXES,
  TRIGGER_KINDS,
  WHO_CONDITIONS,
  WHY_RESEARCH_ITEMS,
  BEHAVIOR_LEVELS,
  BUSINESS_STAGES,
  CONDITION_KEYS,
  CONDITION_STATUSES,
  EVIDENCE_STATES,
  EXECUTION_KEYS,
  EXIT_KEYS,
  MONETIZATION_SIDES,
  NEXT_DECISIONS,
  ORDER_SCENES,
  READING_KEYS,
  READING_LEVELS,
  ROLE_KEYS,
  SCENE_KEYS,
  type Candidate,
  type ResearchData
} from '../../src/shared/research/model'
import { RESEARCH_PROMPT_IDS } from '../../src/shared/research/ipc'
import { emptyCandidate, emptyEvidence, emptyExperiment, emptyResearch } from '../../src/shared/research/records'
import { principleStatus } from '../../src/shared/research/principles'
import { autoGates } from '../../src/shared/research/gates'
import { businessStage } from '../../src/shared/research/stage'
import { exitChecks, nextDecision } from '../../src/shared/research/decision'
import {
  CANDIDATE_SORT_KEYS,
  FLOW_SECTIONS,
  FLOW_STEPS,
  MAX_FOLDER_NAME,
  MAX_INPUT_NUMBER,
  SERVER_OWNED_CANDIDATE_FIELDS,
  WORKSPACE_TABS,
  barWidths,
  candidateDirty,
  droppedCount,
  evidenceDraftIssues,
  evidenceForCandidate,
  filterCandidates,
  flowCounts,
  flowStepOf,
  folderNameFrom,
  folderNameIssue,
  formatAttractiveness,
  formatCount,
  formatMonths,
  formatPercent,
  formatRatio,
  formatScore,
  formatYen,
  funnelRows,
  hostOf,
  isHttpUrl,
  isIsoDate,
  localDate,
  mergeCandidateDraft,
  moveAt,
  normalizeNumberText,
  numberToInput,
  parseCutoff,
  parseIdList,
  parseNumberField,
  parseRateField,
  parseScenarios,
  parseWeight,
  placeholdersIn,
  progressPercent,
  promptNeedsCandidate,
  promptsForTab,
  rateToInput,
  removeAt,
  sameJson,
  scoreState,
  stripUnfilled,
  sceneMissing,
  parseConversionScenarios,
  scenariosToInput,
  evidenceCompleteness,
  timingNotes,
  readingTone,
  bothSides,
  EXECUTION_ORDER,
  sectionNumber,
  sortCandidateRows,
  updateAt,
  weightsTotal,
  type CandidateRowInput
} from '../../src/renderer/research/view'

const NOW = '2026-10-18T09:00:00.000Z'

function candidate(id: string, patch: Partial<Candidate> = {}): Candidate {
  return { ...emptyCandidate(id, NOW), ...patch }
}

function data(patch: Partial<ResearchData> = {}): ResearchData {
  return { root: '/r', research: emptyResearch('R', NOW), candidates: [], evidence: [], experiments: [], problems: [], ...patch }
}

function row(id: string, patch: Partial<CandidateRowInput> = {}): CandidateRowInput {
  return { id, title: id, stage: 'discovered', value: null, attractiveness: null, held: false, cutoffs: [], evidenceLevel: 'none', evidenceCount: 0, nextGate: 'G1', updatedAt: '', ...patch }
}

const dict = en as Record<string, string>

// ================================================================ 流れ

describe('flowStepOf / flowCounts', () => {
  it('段階ごとに流れの段へ。dropped は null', () => {
    expect(flowStepOf({ id: 'C001', stage: 'discovered' })).toBe('discovery')
    expect(flowStepOf({ id: 'C001', stage: 'evidenced' })).toBe('evidence')
    expect(flowStepOf({ id: 'C001', stage: 'qualified' })).toBe('ranking')
    expect(flowStepOf({ id: 'C001', stage: 'testing' })).toBe('experiment')
    expect(flowStepOf({ id: 'C001', stage: 'selected' })).toBe('promote')
    expect(flowStepOf({ id: 'C001', stage: 'dropped' })).toBeNull()
  })

  it('testing は自分の終わった実験（done・stopped）があれば learning。他の候補の実験・実施中は数えない', () => {
    const c = { id: 'C001', stage: 'testing' as const }
    expect(flowStepOf(c, [{ candidate: 'C002', status: 'done' }])).toBe('experiment')
    expect(flowStepOf(c, [{ candidate: 'C001', status: 'running' }, { candidate: 'C001', status: 'planned' }])).toBe('experiment')
    expect(flowStepOf(c, [{ candidate: 'C001', status: 'stopped' }])).toBe('learning')
    expect(flowStepOf(c, [{ candidate: 'C001', status: 'done' }])).toBe('learning')
  })

  it('知らない stage（壊れた記録）は null', () => {
    expect(flowStepOf({ id: 'C001', stage: 'weird' as never })).toBeNull()
  })

  it('数は全段そろい、dropped は数えない', () => {
    const d = data({ candidates: [candidate('C001'), candidate('C002', { stage: 'dropped' }), candidate('C003', { stage: 'selected' })] })
    const n = flowCounts(d)
    expect(Object.keys(n)).toEqual([...FLOW_STEPS])
    expect(n).toEqual({ discovery: 1, evidence: 0, ranking: 0, experiment: 0, learning: 0, promote: 1 })
    expect(flowCounts(data())).toEqual({ discovery: 0, evidence: 0, ranking: 0, experiment: 0, learning: 0, promote: 0 })
  })

  it('流れの各段は6機能のどれかへ移れる', () => {
    for (const step of FLOW_STEPS) {
      expect(FLOW_SECTIONS[step].length).toBeGreaterThan(0)
      for (const s of FLOW_SECTIONS[step]) expect(RESEARCH_SECTIONS).toContain(s)
    }
  })
})

// ================================================================ ファンネル

describe('funnelRows', () => {
  const targets = { discovered: 1000, evidenced: 100, qualified: 20, testing: 5, selected: 2 }

  it('候補が無ければ全部 0、率は null、目安はそのまま', () => {
    const rows = funnelRows([], targets)
    expect(rows.map((r) => r.reached)).toEqual([0, 0, 0, 0, 0])
    expect(rows.map((r) => r.rate)).toEqual([null, null, null, null, null])
    expect(rows.map((r) => r.target)).toEqual([1000, 100, 20, 5, 2])
  })

  it('そこまで来た数（後ろの段階にいるものも前を通ったとみなす）。dropped と知らない段階は数えない', () => {
    const list = [
      { stage: 'discovered' }, { stage: 'discovered' }, { stage: 'evidenced' }, { stage: 'qualified' }, { stage: 'selected' },
      { stage: 'dropped' }, { stage: 'nonsense' }
    ] as Array<Pick<Candidate, 'stage'>>
    const rows = funnelRows(list, targets)
    expect(rows.map((r) => [r.stage, r.reached, r.here])).toEqual([
      ['discovered', 5, 2], ['evidenced', 3, 1], ['qualified', 2, 1], ['testing', 1, 0], ['selected', 1, 1]
    ])
    expect(rows[1]!.rate).toBeCloseTo(3 / 5)
    expect(rows[4]!.rate).toBe(1)
  })

  it('目安の不正（負・NaN・Infinity・文字・欠け・null）は null、小数は丸める', () => {
    const rows = funnelRows([], { discovered: -1, evidenced: Number.NaN, qualified: Number.POSITIVE_INFINITY, testing: '5' as never, selected: 2.6 })
    expect(rows.map((r) => r.target)).toEqual([null, null, null, null, 3])
    expect(funnelRows([], null).every((r) => r.target === null)).toBe(true)
    expect(funnelRows([], undefined).map((r) => r.target)).toEqual([null, null, null, null, null])
  })

  it('除外の数', () => {
    expect(droppedCount([{ stage: 'dropped' }, { stage: 'dropped' }, { stage: 'testing' }])).toBe(2)
    expect(droppedCount([])).toBe(0)
  })
})

describe('progressPercent / barWidths', () => {
  it('目安に対する % は 0〜100 に収める', () => {
    expect(progressPercent(0, 100)).toBe(0)
    expect(progressPercent(50, 100)).toBe(50)
    expect(progressPercent(150, 100)).toBe(100)
    expect(progressPercent(1, 3)).toBe(33)
  })

  it('負・NaN の実数は 0、目安が 0・null・負なら実数があれば 100', () => {
    expect(progressPercent(-5, 10)).toBe(0)
    expect(progressPercent(Number.NaN, 10)).toBe(0)
    expect(progressPercent(3, 0)).toBe(100)
    expect(progressPercent(3, null)).toBe(100)
    expect(progressPercent(3, -1)).toBe(100)
    expect(progressPercent(0, null)).toBe(0)
  })

  it('バーの幅は先頭を 100 とする。null・負・NaN は 0', () => {
    expect(barWidths([1000, 50, 20, 5])).toEqual([100, 5, 2, 0.5])
    expect(barWidths([100, null, -3, Number.NaN, 50])).toEqual([100, 0, 0, 0, 50])
  })

  it('先頭が 0・null なら最大値を基準、全部 0 なら全部 0。先頭より大きい値は 100 で止める', () => {
    expect(barWidths([null, 20, 10])).toEqual([0, 100, 50])
    expect(barWidths([0, 0])).toEqual([0, 0])
    expect(barWidths([])).toEqual([])
    expect(barWidths([10, 30])).toEqual([100, 100])
  })
})

// ================================================================ 区分と依頼

describe('区分と依頼', () => {
  it('タブは 概要・6機能・証拠台帳 の順', () => {
    expect(WORKSPACE_TABS).toEqual(['overview', 'who', 'what', 'where', 'why', 'ranking', 'experiment', 'evidence'])
  })

  it('区分の番号は 1〜6、それ以外は null', () => {
    expect(RESEARCH_SECTIONS.map((s) => sectionNumber(s))).toEqual([1, 2, 3, 4, 5, 6])
    expect(sectionNumber('overview')).toBeNull()
    expect(sectionNumber('evidence')).toBeNull()
  })

  it('区分ごとの依頼はすべて RESEARCH_PROMPT_IDS にあり、どの依頼もどこかの区分から送れる', () => {
    const used = new Set<string>()
    for (const tab of WORKSPACE_TABS) {
      const ids = promptsForTab(tab)
      expect(ids.length).toBeGreaterThan(0)
      for (const id of ids) {
        expect(RESEARCH_PROMPT_IDS).toContain(id)
        used.add(id)
      }
    }
    expect([...used].sort()).toEqual([...RESEARCH_PROMPT_IDS].sort())
    expect(promptsForTab('overview')).toEqual(['decide', 'discover', 'evaluate'])
    expect(promptsForTab('evidence')[0]).toBe('evaluate')
    expect(promptsForTab('experiment')).toEqual(['experiment', 'learning'])
  })

  it('decide・discover・learning・evaluate だけは候補が無くても送れる', () => {
    expect(RESEARCH_PROMPT_IDS.filter((id) => !promptNeedsCandidate(id)).sort()).toEqual(['decide', 'discover', 'evaluate', 'learning'])
  })
})

// ================================================================ 候補の一覧

describe('sortCandidateRows', () => {
  it('score の降順。保留は後ろ、null は最後、同じ値は ID の昇順', () => {
    const rows = [row('C004', { value: 80, held: true }), row('C003', { value: null }), row('C002', { value: 60 }), row('C001', { value: 60 }), row('C005', { value: 90 })]
    expect(sortCandidateRows(rows, 'score').map((r) => r.id)).toEqual(['C005', 'C001', 'C002', 'C003', 'C004'])
  })

  it('昇順でも null は最後', () => {
    const rows = [row('C001', { value: null }), row('C002', { value: 10 }), row('C003', { value: 5 })]
    expect(sortCandidateRows(rows, 'score', 'asc').map((r) => r.id)).toEqual(['C003', 'C002', 'C001'])
  })

  it('NaN・Infinity の点は null と同じ扱い（最後）', () => {
    const rows = [row('C001', { value: Number.NaN }), row('C002', { value: 1 }), row('C003', { value: Number.POSITIVE_INFINITY })]
    expect(sortCandidateRows(rows, 'score').map((r) => r.id)).toEqual(['C002', 'C001', 'C003'])
  })

  it('証拠は強さ→件数、段階はファンネルの順、ID・更新日は文字の順', () => {
    const rows = [
      row('C001', { evidenceLevel: 'weak', evidenceCount: 10, stage: 'testing', updatedAt: '2026-10-01' }),
      row('C002', { evidenceLevel: 'strong', evidenceCount: 1, stage: 'discovered', updatedAt: '' }),
      row('C003', { evidenceLevel: 'strong', evidenceCount: 3, stage: 'dropped', updatedAt: '2026-10-05' })
    ]
    expect(sortCandidateRows(rows, 'evidence').map((r) => r.id)).toEqual(['C003', 'C002', 'C001'])
    expect(sortCandidateRows(rows, 'stage', 'asc').map((r) => r.id)).toEqual(['C002', 'C001', 'C003'])
    expect(sortCandidateRows(rows, 'id', 'asc').map((r) => r.id)).toEqual(['C001', 'C002', 'C003'])
    expect(sortCandidateRows(rows, 'updated').map((r) => r.id)).toEqual(['C003', 'C001', 'C002'])
  })

  it('負の件数・巨大な件数でも順は壊れない。元の配列は変えない', () => {
    const rows = [row('C001', { evidenceLevel: 'none', evidenceCount: -5 }), row('C002', { evidenceLevel: 'none', evidenceCount: 1e9 })]
    const before = rows.map((r) => r.id)
    expect(sortCandidateRows(rows, 'evidence').map((r) => r.id)).toEqual(['C002', 'C001'])
    expect(rows.map((r) => r.id)).toEqual(before)
  })

  it('並べ替えの鍵はすべて扱える（空の一覧も）', () => {
    for (const key of CANDIDATE_SORT_KEYS) {
      expect(sortCandidateRows([], key)).toEqual([])
      expect(sortCandidateRows([row('C001')], key, 'asc')).toHaveLength(1)
    }
  })
})

describe('filterCandidates', () => {
  const list = [
    candidate('C001', { title: 'Lead lists', market: 'Sales', stage: 'discovered' }),
    candidate('C002', { title: '入札情報', problem: '案件探し', stage: 'dropped' }),
    candidate('C003', { title: 'Accounting', customer: 'SMB 経理', stage: 'testing' })
  ]

  it('active は dropped を除き、all は全部、段階を選べばその段階だけ', () => {
    expect(filterCandidates(list, '', 'active').map((c) => c.id)).toEqual(['C001', 'C003'])
    expect(filterCandidates(list, '', 'all')).toHaveLength(3)
    expect(filterCandidates(list, '', 'dropped').map((c) => c.id)).toEqual(['C002'])
    expect(filterCandidates(list, '', 'selected')).toEqual([])
  })

  it('ID・題名・市場・課題・顧客を大小文字を区別せず探す。前後の空白は無視', () => {
    expect(filterCandidates(list, '  LEAD ', 'all').map((c) => c.id)).toEqual(['C001'])
    expect(filterCandidates(list, 'c003', 'all').map((c) => c.id)).toEqual(['C003'])
    expect(filterCandidates(list, '案件', 'all').map((c) => c.id)).toEqual(['C002'])
    expect(filterCandidates(list, '経理', 'active').map((c) => c.id)).toEqual(['C003'])
    expect(filterCandidates(list, 'zzz', 'all')).toEqual([])
  })

  it('市場などの欄が無い（壊れた）候補でも落ちない', () => {
    expect(filterCandidates([{ id: 'C009', title: 'x', stage: 'discovered' }], 'x', 'all')).toHaveLength(1)
  })
})

// ================================================================ 数の見せ方

describe('数の見せ方', () => {
  it('スコアは 0〜100 の整数。null・NaN・Infinity は —', () => {
    expect(formatScore(72.4)).toBe('72')
    expect(formatScore(72.5)).toBe('73')
    expect(formatScore(0)).toBe('0')
    expect(formatScore(-3)).toBe('0')
    expect(formatScore(140)).toBe('100')
    expect(formatScore(null)).toBe('—')
    expect(formatScore(undefined)).toBe('—')
    expect(formatScore(Number.NaN)).toBe('—')
    expect(formatScore(Number.POSITIVE_INFINITY)).toBe('—')
  })

  it('魅力度は小数1桁、100 以上は整数', () => {
    expect(formatAttractiveness(0.04)).toBe('0.0')
    expect(formatAttractiveness(12.345)).toBe('12.3')
    expect(formatAttractiveness(125)).toBe('125')
    expect(formatAttractiveness(null)).toBe('—')
  })

  it('率は %。1% 未満は小数1桁、0 は 0%', () => {
    expect(formatPercent(0.35)).toBe('35%')
    expect(formatPercent(0.005)).toBe('0.5%')
    expect(formatPercent(0)).toBe('0%')
    expect(formatPercent(1)).toBe('100%')
    expect(formatPercent(1.5)).toBe('150%')
    expect(formatPercent(Number.NaN)).toBe('—')
  })

  it('円・件数は3桁区切り、巨大値・負も読める', () => {
    expect(formatYen(160000)).toBe('¥160,000')
    expect(formatYen(1234.6)).toBe('¥1,235')
    expect(formatYen(-500)).toBe('-¥500')
    expect(formatYen(-4500.4)).toBe('-¥4,500')
    expect(formatYen(-0.2)).toBe('¥0')
    expect(formatYen(0)).toBe('¥0')
    expect(formatYen(1e12)).toBe('¥1,000,000,000,000')
    expect(formatYen(null)).toBe('—')
    expect(formatCount(12345, 'en-US')).toBe('12,345')
    expect(formatCount(Number.NEGATIVE_INFINITY)).toBe('—')
  })

  it('倍率と月数', () => {
    expect(formatRatio(3)).toBe('3.0×')
    expect(formatRatio(0.25)).toBe('0.3×')
    expect(formatRatio(null)).toBe('—')
    expect(formatMonths(12)).toBe('12')
    expect(formatMonths(1.25)).toBe('1.3')
    expect(formatMonths(0)).toBe('0')
    expect(formatMonths(Number.NaN)).toBe('—')
  })
})

// ================================================================ 入力の読み取り

describe('parseNumberField', () => {
  it('空・空白は null（未確認。0 にしない）', () => {
    expect(parseNumberField('')).toEqual({ ok: true, value: null })
    expect(parseNumberField('   ')).toEqual({ ok: true, value: null })
  })

  it('桁区切り・円・¥・全角を許す', () => {
    expect(parseNumberField('1,000')).toEqual({ ok: true, value: 1000 })
    expect(parseNumberField('¥30,000')).toEqual({ ok: true, value: 30000 })
    expect(parseNumberField('３０００円')).toEqual({ ok: true, value: 3000 })
    expect(parseNumberField('１２．５')).toEqual({ ok: true, value: 12.5 })
    expect(parseNumberField('0')).toEqual({ ok: true, value: 0 })
    expect(parseNumberField('.5')).toEqual({ ok: true, value: 0.5 })
    expect(parseNumberField('1e3')).toEqual({ ok: true, value: 1000 })
  })

  it('数でないもの・途中の記号は notNumber', () => {
    for (const s of ['abc', '1.2.3', '--1', '1-', 'NaN', 'Infinity', '0x10', '1/2', '十']) {
      expect(parseNumberField(s), s).toEqual({ ok: false, error: 'notNumber' })
    }
  })

  it('既定は負を拒む。min を下げれば許す。min が 0 以外なら outOfRange', () => {
    expect(parseNumberField('-1')).toEqual({ ok: false, error: 'negative' })
    expect(parseNumberField('－１')).toEqual({ ok: false, error: 'negative' })
    expect(parseNumberField('-1', { min: Number.NEGATIVE_INFINITY })).toEqual({ ok: true, value: -1 })
    expect(parseNumberField('0', { min: 1 })).toEqual({ ok: false, error: 'outOfRange' })
  })

  it('上限・整数・巨大値', () => {
    expect(parseNumberField(String(MAX_INPUT_NUMBER))).toEqual({ ok: true, value: MAX_INPUT_NUMBER })
    expect(parseNumberField(String(MAX_INPUT_NUMBER * 10))).toEqual({ ok: false, error: 'tooLarge' })
    expect(parseNumberField('1e400')).toEqual({ ok: false, error: 'tooLarge' })
    expect(parseNumberField('6', { max: 5 })).toEqual({ ok: false, error: 'outOfRange' })
    expect(parseNumberField('1.5', { integer: true })).toEqual({ ok: false, error: 'notInteger' })
    expect(parseNumberField('2', { integer: true })).toEqual({ ok: true, value: 2 })
  })

  it('normalizeNumberText は記号を取り、全角を半角にする', () => {
    expect(normalizeNumberText(' ¥1,234 円 ')).toBe('1234')
    expect(normalizeNumberText('４５％')).toBe('45%')
    expect(normalizeNumberText('−3')).toBe('-3')
  })
})

describe('parseRateField / rateToInput', () => {
  it('入れる数はいつも %（欄の横に % が出る）。% の記号・全角・小数を許す', () => {
    expect(parseRateField('35%')).toEqual({ ok: true, value: 0.35 })
    expect(parseRateField('35 %')).toEqual({ ok: true, value: 0.35 })
    expect(parseRateField('３５％')).toEqual({ ok: true, value: 0.35 })
    expect(parseRateField('35')).toEqual({ ok: true, value: 0.35 })
    expect(parseRateField('0.5')).toEqual({ ok: true, value: 0.005 })
    expect(parseRateField('1')).toEqual({ ok: true, value: 0.01 })
    expect(parseRateField('100')).toEqual({ ok: true, value: 1 })
    expect(parseRateField('0')).toEqual({ ok: true, value: 0 })
    expect(parseRateField('')).toEqual({ ok: true, value: null })
  })

  it('100 を超える・負・% だけ・文字は拒む', () => {
    expect(parseRateField('100.01')).toEqual({ ok: false, error: 'outOfRange' })
    expect(parseRateField('150%')).toEqual({ ok: false, error: 'outOfRange' })
    expect(parseRateField('-5%')).toEqual({ ok: false, error: 'negative' })
    expect(parseRateField('%')).toEqual({ ok: false, error: 'notNumber' })
    expect(parseRateField('abc')).toEqual({ ok: false, error: 'notNumber' })
  })

  it('入力欄へ戻すと % の数（往復しても同じ値）', () => {
    expect(rateToInput(0.35)).toBe('35')
    expect(rateToInput(0.125)).toBe('12.5')
    expect(rateToInput(null)).toBe('')
    expect(rateToInput(Number.NaN)).toBe('')
    for (const v of [0, 0.0001, 0.01, 0.333, 0.8, 1]) {
      const back = parseRateField(rateToInput(v))
      expect(back.ok && back.value, String(v)).toBeCloseTo(v, 4)
    }
    expect(numberToInput(12)).toBe('12')
    expect(numberToInput(null)).toBe('')
  })
})

describe('parseScenarios', () => {
  it('区切りは , 、 空白 /。重複を除いて昇順', () => {
    expect(parseScenarios('24, 6、12 36/12')).toEqual({ value: [6, 12, 24, 36], invalid: [] })
    expect(parseScenarios('')).toEqual({ value: [], invalid: [] })
    expect(parseScenarios(' ,, ')).toEqual({ value: [], invalid: [] })
  })

  it('か月・months・全角を許す', () => {
    expect(parseScenarios('６か月 12ヶ月 24months 36mo')).toEqual({ value: [6, 12, 24, 36], invalid: [] })
  })

  it('0・負・小数・600 超・文字は invalid（読めたものは残す）', () => {
    expect(parseScenarios('0 -6 1.5 601 abc 12 600 1')).toEqual({ value: [1, 12, 600], invalid: ['0', '-6', '1.5', '601', 'abc'] })
  })
})

describe('parseIdList', () => {
  it('形の合う ID を大文字にして重複を除く。違う語は invalid', () => {
    expect(parseIdList('e001, E002 e001、E12', 'E')).toEqual({ value: ['E001', 'E002', 'E12'], invalid: [] })
    expect(parseIdList('E1 C001 E12345 X001 E0001', 'E')).toEqual({ value: ['E0001'], invalid: ['E1', 'C001', 'E12345', 'X001'] })
    expect(parseIdList('', 'C')).toEqual({ value: [], invalid: [] })
  })
})

describe('URL・日付', () => {
  it('http(s) だけを URL とみなす', () => {
    expect(isHttpUrl('https://example.com/a?b=1')).toBe(true)
    expect(isHttpUrl('  http://example.co.jp  ')).toBe(true)
    for (const s of ['', 'example.com', 'ftp://example.com', 'javascript:alert(1)', 'https://', 'file:///etc/passwd', 'mailto:a@b.c']) {
      expect(isHttpUrl(s), s).toBe(false)
    }
  })

  it('ホスト名は www. を除いて小文字。URL でなければ空', () => {
    expect(hostOf('https://WWW.Example.com/x')).toBe('example.com')
    expect(hostOf('http://sub.example.com')).toBe('sub.example.com')
    expect(hostOf('not a url')).toBe('')
  })

  it('YYYY-MM-DD の実在する日だけ', () => {
    expect(isIsoDate('2026-10-18')).toBe(true)
    expect(isIsoDate('2024-02-29')).toBe(true)
    expect(isIsoDate('2026-02-29')).toBe(false)
    expect(isIsoDate('2026-13-01')).toBe(false)
    expect(isIsoDate('2026-1-1')).toBe(false)
    expect(isIsoDate('2026-10-18T00:00')).toBe(false)
    expect(isIsoDate('')).toBe(false)
  })

  it('手元の日付は引数の時刻から。壊れた日時は空', () => {
    expect(localDate(new Date(2026, 0, 5, 23, 59))).toBe('2026-01-05')
    expect(localDate(new Date(Number.NaN))).toBe('')
  })
})

describe('evidenceDraftIssues', () => {
  const base = { ...emptyEvidence('E001', NOW), grade: 'searchDemand' as const, url: 'https://example.com', fact: '月 1,000 件検索される', checkedAt: '2026-10-01' }

  it('ちゃんとした証拠は問題なし', () => {
    expect(evidenceDraftIssues(base, '2026-10-18')).toEqual([])
  })

  it('強い種類は URL が要る。弱い種類は URL 無しでもよい。形の違う URL は error', () => {
    expect(evidenceDraftIssues({ ...base, grade: 'contract', url: '' }, '2026-10-18').map((i) => i.id)).toEqual(['urlRequired'])
    expect(evidenceDraftIssues({ ...base, grade: 'snsComplaint', url: '' }, '2026-10-18')).toEqual([])
    expect(evidenceDraftIssues({ ...base, url: 'example.com' }, '2026-10-18').map((i) => [i.id, i.level])).toEqual([['urlForm', 'error']])
  })

  it('原文も事実も空は error。事実と推論が同じなら warning（前後の空白は無視）', () => {
    expect(evidenceDraftIssues({ ...base, fact: '  ', quote: '' }, '2026-10-18').map((i) => i.id)).toEqual(['quoteOrFact'])
    expect(evidenceDraftIssues({ ...base, fact: '', quote: '原文' }, '2026-10-18')).toEqual([])
    expect(evidenceDraftIssues({ ...base, inference: ' 月 1,000 件検索される ' }, '2026-10-18').map((i) => [i.id, i.level])).toEqual([['factEqualsInference', 'warning']])
  })

  it('確認日の形・未来。今日は OK。空は OK', () => {
    expect(evidenceDraftIssues({ ...base, checkedAt: '2026/10/01' }, '2026-10-18').map((i) => i.id)).toEqual(['dateForm'])
    expect(evidenceDraftIssues({ ...base, checkedAt: '2026-10-19' }, '2026-10-18').map((i) => i.id)).toEqual(['dateFuture'])
    expect(evidenceDraftIssues({ ...base, checkedAt: '2026-10-18' }, '2026-10-18')).toEqual([])
    expect(evidenceDraftIssues({ ...base, checkedAt: '' }, '2026-10-18')).toEqual([])
    // 今日が分からない（壊れた時刻）なら未来の判定はしない
    expect(evidenceDraftIssues({ ...base, checkedAt: '2099-01-01' }, '')).toEqual([])
  })

  it('AI の推測は裏付けにならない注意', () => {
    expect(evidenceDraftIssues({ ...base, grade: 'aiInference', url: '' }, '2026-10-18').map((i) => [i.id, i.level])).toEqual([['aiInferenceAsProof', 'warning']])
  })
})

describe('evidenceForCandidate', () => {
  const ev = (id: string, candidate: string, checkedAt: string) => ({ ...emptyEvidence(id, NOW), candidate, checkedAt })

  it('その候補だけ、確認日の新しい順、同じ日・空は ID 順で、空の日付は最後', () => {
    const list = [ev('E003', 'C001', '2026-10-01'), ev('E001', 'C001', '2026-10-05'), ev('E002', 'C002', '2026-10-09'), ev('E005', 'C001', ''), ev('E004', 'C001', '2026-10-01')]
    expect(evidenceForCandidate(list, 'C001').map((e) => e.id)).toEqual(['E001', 'E003', 'E004', 'E005'])
    expect(evidenceForCandidate(list, null).map((e) => e.id)).toEqual(['E002', 'E001', 'E003', 'E004', 'E005'])
    expect(evidenceForCandidate([], 'C001')).toEqual([])
  })
})

// ================================================================ 採点

describe('採点の見せ方', () => {
  it('点が無ければ none、根拠が無ければ unbacked', () => {
    expect(scoreState(null, true)).toBe('none')
    expect(scoreState(undefined, false)).toBe('none')
    expect(scoreState(Number.NaN, true)).toBe('none')
    expect(scoreState(3, false)).toBe('unbacked')
    expect(scoreState(1, true)).toBe('backed')
  })

  it('重みの合計は正の有限な数だけ', () => {
    expect(weightsTotal({ demand: 25, spend: 20, reach: 20, profit: 15, competition: 10, delivery: 10 })).toBe(100)
    expect(weightsTotal({ demand: -5, spend: Number.NaN, reach: 'x' as never, profit: Number.POSITIVE_INFINITY, competition: 0.333, delivery: 0.333 })).toBe(0.67)
    expect(weightsTotal({})).toBe(0)
  })

  it('重みは 0〜100 の数（丸める）。空・負・100 超・文字は拒む', () => {
    expect(parseWeight('25')).toEqual({ ok: true, value: 25 })
    expect(parseWeight('12.6')).toEqual({ ok: true, value: 13 })
    expect(parseWeight('0')).toEqual({ ok: true, value: 0 })
    expect(parseWeight('100')).toEqual({ ok: true, value: 100 })
    expect(parseWeight('')).toEqual({ ok: false, error: 'notNumber' })
    expect(parseWeight('-1')).toEqual({ ok: false, error: 'negative' })
    expect(parseWeight('101')).toEqual({ ok: false, error: 'outOfRange' })
    expect(parseWeight('abc')).toEqual({ ok: false, error: 'notNumber' })
  })

  it('足切りは空（なし）か 1〜5 の整数', () => {
    expect(parseCutoff('')).toEqual({ ok: true, value: null })
    expect(parseCutoff('2')).toEqual({ ok: true, value: 2 })
    expect(parseCutoff('5')).toEqual({ ok: true, value: 5 })
    expect(parseCutoff('0')).toEqual({ ok: false, error: 'outOfRange' })
    expect(parseCutoff('6')).toEqual({ ok: false, error: 'outOfRange' })
    expect(parseCutoff('2.5')).toEqual({ ok: false, error: 'notInteger' })
  })
})

// ================================================================ プロジェクトにする

describe('folderNameFrom / folderNameIssue', () => {
  it('使えない文字・空白を - にまとめ、前後の . と - を除く', () => {
    expect(folderNameFrom('営業リスト / 作成  ツール', 'C001')).toBe('営業リスト-作成-ツール')
    expect(folderNameFrom('a:b*c?d"e<f>g|h\\i', 'C001')).toBe('a-b-c-d-e-f-g-h-i')
    expect(folderNameFrom('...hidden...', 'C001')).toBe('hidden')
    expect(folderNameFrom('tab\there\nline', 'C001')).toBe('tab-here-line')
  })

  it('空・記号だけ・. だけなら候補の ID', () => {
    expect(folderNameFrom('', 'C001')).toBe('C001')
    expect(folderNameFrom('   ', 'C001')).toBe('C001')
    expect(folderNameFrom('///', 'C002')).toBe('C002')
    expect(folderNameFrom('..', 'C003')).toBe('C003')
  })

  it('60 文字で切る（サロゲートペアを割らない）。切った後の末尾の - も除く', () => {
    const long = 'あ'.repeat(100)
    expect([...folderNameFrom(long, 'C001')]).toHaveLength(MAX_FOLDER_NAME)
    expect([...folderNameFrom('😀'.repeat(70), 'C001')]).toHaveLength(MAX_FOLDER_NAME)
    expect(folderNameFrom(`${'a'.repeat(59)} b`, 'C001')).toBe('a'.repeat(59))
  })

  it('作った名前は欄の検査を通る', () => {
    for (const title of ['営業リスト / 作成', '...x', 'a'.repeat(200), 'C:\\path', '']) {
      expect(folderNameIssue(folderNameFrom(title, 'C001')), title).toBeNull()
    }
  })

  it('欄の検査: 空は OK、使えない文字・長すぎ・. で始まる', () => {
    expect(folderNameIssue('')).toBeNull()
    expect(folderNameIssue('  ')).toBeNull()
    expect(folderNameIssue('ok-name')).toBeNull()
    expect(folderNameIssue('a/b')).toBe('invalidChars')
    expect(folderNameIssue('a\u0001b')).toBe('invalidChars')
    expect(folderNameIssue('x'.repeat(61))).toBe('tooLong')
    expect(folderNameIssue('x'.repeat(60))).toBeNull()
    expect(folderNameIssue('.git')).toBe('dotName')
    expect(folderNameIssue('..')).toBe('dotName')
  })
})

// ================================================================ 依頼文・配列・下書き

describe('placeholdersIn', () => {
  it('残った穴を出た順に重複なく', () => {
    expect(placeholdersIn('a {{x}} b {{ y }} {{x}} {{}} {{ z w }}')).toEqual(['x', 'y'])
    expect(placeholdersIn('')).toEqual([])
    expect(placeholdersIn(`{{${'a'.repeat(41)}}}`)).toEqual([])
  })
})

describe('stripUnfilled', () => {
  it('差し込まれなかった穴を含む括弧書きを消す（全角・半角）', () => {
    expect(stripUnfilled('担当が分かる（{{filled}}/{{total}}、{{percent}}%）')).toBe('担当が分かる')
    expect(stripUnfilled('Buyer known for 80% ({{filled}}/{{total}})')).toBe('Buyer known for 80%')
    expect(stripUnfilled('担当が分かる（3/4、75%）')).toBe('担当が分かる（3/4、75%）')
  })

  it('括弧の外の穴は — にする。穴が無ければそのまま', () => {
    expect(stripUnfilled('対象 {{count}} 社')).toBe('対象 — 社')
    expect(stripUnfilled('plain text')).toBe('plain text')
    expect(stripUnfilled('')).toBe('')
  })
})

describe('配列の編集', () => {
  const list = ['a', 'b', 'c']

  it('updateAt / removeAt は範囲の外・小数・負なら何もしない（写しを返す）', () => {
    expect(updateAt([{ v: 1 }, { v: 2 }], 1, { v: 9 })).toEqual([{ v: 1 }, { v: 9 }])
    expect(updateAt([{ v: 1 }], 5, { v: 9 })).toEqual([{ v: 1 }])
    expect(updateAt([{ v: 1 }], -1, { v: 9 })).toEqual([{ v: 1 }])
    expect(removeAt(list, 1)).toEqual(['a', 'c'])
    expect(removeAt(list, 3)).toEqual(list)
    expect(removeAt(list, 0.5)).toEqual(list)
    expect(removeAt([], 0)).toEqual([])
  })

  it('moveAt は範囲の中だけ動かす', () => {
    expect(moveAt(list, 0, 1)).toEqual(['b', 'a', 'c'])
    expect(moveAt(list, 2, -2)).toEqual(['c', 'a', 'b'])
    expect(moveAt(list, 0, -1)).toEqual(list)
    expect(moveAt(list, 2, 1)).toEqual(list)
    expect(moveAt(list, 1, 0.5)).toEqual(list)
    expect(list).toEqual(['a', 'b', 'c'])
  })
})

describe('sameJson', () => {
  it('キーの順・undefined の欄は違いに数えない。配列の順は数える', () => {
    expect(sameJson({ a: 1, b: [1, 2] }, { b: [1, 2], a: 1 })).toBe(true)
    expect(sameJson({ a: 1, c: undefined }, { a: 1 })).toBe(true)
    expect(sameJson([1, 2], [2, 1])).toBe(false)
    expect(sameJson({ a: null }, { a: 0 })).toBe(false)
    expect(sameJson(null, undefined)).toBe(false)
    expect(sameJson('x', 'x')).toBe(true)
  })
})

describe('候補の下書き', () => {
  const saved = candidate('C001', { title: 'old', stage: 'qualified' })
  saved.gates.G1 = { status: 'pass', note: 'ok', at: NOW }

  it('下書きに保存済みの server 側の欄（ゲート・段階…）を重ねる', () => {
    const draft = { ...saved, title: 'new', stage: 'discovered' as const, gates: { ...saved.gates, G1: { status: 'pending' as const, note: '', at: '' } }, updatedAt: 'x' }
    const merged = mergeCandidateDraft(saved, draft)
    expect(merged.title).toBe('new')
    for (const k of SERVER_OWNED_CANDIDATE_FIELDS) expect(merged[k]).toEqual(saved[k])
  })

  it('server 側の欄だけが違うなら未保存ではない。中身が違えば未保存', () => {
    expect(candidateDirty(saved, null)).toBe(false)
    expect(candidateDirty(saved, { ...saved, stage: 'dropped', updatedAt: 'later' })).toBe(false)
    expect(candidateDirty(saved, { ...saved, title: 'x' })).toBe(true)
    expect(candidateDirty(saved, { ...saved, who: { ...saved.who, targetCount: 0 } })).toBe(true)
    expect(candidateDirty(null, saved)).toBe(true)
  })
})

// ================================================================ v3

describe('sceneMissing', () => {
  it('空・空白だけ・文字でない欄を出す（並びは SCENE_KEYS の順）', () => {
    expect(sceneMissing({ company: 'A', who: '  ', event: 'x', outcome: 1 as never })).toEqual(['who', 'outcome', 'currentHandling'])
    expect(sceneMissing({ company: 'a', who: 'b', event: 'c', outcome: 'd', currentHandling: 'e' })).toEqual([])
    expect(sceneMissing(null)).toEqual([...SCENE_KEYS])
    expect(sceneMissing(undefined)).toEqual([...SCENE_KEYS])
    expect(sceneMissing({})).toEqual([...SCENE_KEYS])
  })
})

describe('parseConversionScenarios / scenariosToInput', () => {
  it('数はいつも %。重複を除いて昇順（0〜1 で持つ）', () => {
    expect(parseConversionScenarios('5, 0.5、2 2%')).toEqual({ value: [0.005, 0.02, 0.05], invalid: [] })
    expect(parseConversionScenarios('')).toEqual({ value: [], invalid: [] })
    expect(parseConversionScenarios('１００')).toEqual({ value: [1], invalid: [] })
  })

  it('0・負・100 超・文字は invalid（読めたものは残す）', () => {
    expect(parseConversionScenarios('0 -1 101 abc 3')).toEqual({ value: [0.03], invalid: ['0', '-1', '101', 'abc'] })
  })

  it('入力欄へ戻すと往復しても同じ', () => {
    expect(scenariosToInput([0.005, 0.02, 0.05])).toBe('0.5, 2, 5')
    expect(scenariosToInput([Number.NaN, 0.1])).toBe('10')
    expect(scenariosToInput([])).toBe('')
    expect(parseConversionScenarios(scenariosToInput([0.005, 0.02, 0.05])).value).toEqual([0.005, 0.02, 0.05])
  })
})

describe('evidenceCompleteness', () => {
  it('11項目。出来事の日と掲載日はどちらかで1項目', () => {
    expect(evidenceCompleteness({})).toEqual({ filled: 0, total: 11, missing: [...EVIDENCE_ITEM_KEYS_FOR_TEST] })
    const all = Object.fromEntries(EVIDENCE_ITEM_KEYS_FOR_TEST.map((k) => [k, 'x']))
    expect(evidenceCompleteness(all)).toEqual({ filled: 11, total: 11, missing: [] })
    expect(evidenceCompleteness({ eventDate: '2026-01-01' }).filled).toBe(1)
    expect(evidenceCompleteness({ eventDate: '2026-01-01', publishedAt: '2026-01-02' }).filled).toBe(1)
  })

  it('空白だけ・文字でない値は空', () => {
    expect(evidenceCompleteness({ subject: '   ', problem: 3 as never, event: null as never }).filled).toBe(0)
  })
})

const EVIDENCE_ITEM_KEYS_FOR_TEST = ['subject', 'problem', 'event', 'behavior', 'amount', 'url', 'eventDate', 'publishedAt', 'publisher', 'inference', 'counter', 'unknowns'] as const

describe('timingNotes', () => {
  it('掲載日が出来事の日より前', () => {
    expect(timingNotes({ eventDate: '2026-05-01', publishedAt: '2026-04-01' }, '2026-10-18')).toEqual(['publishedBeforeEvent'])
    expect(timingNotes({ eventDate: '2026-05-01', publishedAt: '2026-05-01' }, '2026-10-18')).toEqual([])
  })

  it('2年以上前の出来事（無ければ掲載日）は old。ちょうど2年前は old にしない', () => {
    expect(timingNotes({ eventDate: '2014-01-01', publishedAt: '2023-06-01' }, '2026-10-18')).toEqual(['old'])
    expect(timingNotes({ eventDate: '', publishedAt: '2024-10-17' }, '2026-10-18')).toEqual(['old'])
    expect(timingNotes({ eventDate: '', publishedAt: '2024-10-18' }, '2026-10-18')).toEqual([])
  })

  it('形の違う日・今日が分からないときは見ない', () => {
    expect(timingNotes({ eventDate: '2026/05/01', publishedAt: '2026-04-01' }, '2026-10-18')).toEqual([])
    expect(timingNotes({ eventDate: '2010-01-01', publishedAt: '' }, '')).toEqual([])
    expect(timingNotes({ eventDate: '', publishedAt: '' }, '2026-10-18')).toEqual([])
  })
})

describe('readingTone', () => {
  const keys = ['match', 'specificity', 'timing', 'independence', 'selectionBias']
  it('ng が1つでもあれば ng、未評価だけなら unset', () => {
    expect(readingTone({ match: 'ok', timing: 'ng' }, keys)).toBe('ng')
    expect(readingTone({}, keys)).toBe('unset')
    expect(readingTone(null, keys)).toBe('unset')
    expect(readingTone({ match: 'bogus' }, keys)).toBe('unset')
  })

  it('weak があれば weak、全部 ok なら ok、一部だけ ok なら partial', () => {
    expect(readingTone({ match: 'ok', specificity: 'weak' }, keys)).toBe('weak')
    expect(readingTone(Object.fromEntries(keys.map((k) => [k, 'ok'])), keys)).toBe('ok')
    expect(readingTone({ match: 'ok' }, keys)).toBe('partial')
    expect(readingTone({ match: 'ok' }, [])).toBe('unset')
  })
})

describe('bothSides / EXECUTION_ORDER', () => {
  it('支持と反証の両方にある ID（重複なし）', () => {
    expect(bothSides(['E001', 'E002', 'E001'], ['E001', 'E003'])).toEqual(['E001'])
    expect(bothSides([], ['E001'])).toEqual([])
  })

  it('実行条件は4点とも並び、供給が先頭', () => {
    expect([...EXECUTION_ORDER].sort()).toEqual([...EXECUTION_KEYS].sort())
    expect(EXECUTION_ORDER[0]).toBe('supply')
  })
})

// ================================================================ 文言（動的に組み立てるキーの欠け）

describe('画面が組み立てる i18n のキーがそろっている', () => {
  const need = (prefix: string, values: readonly string[], suffixes: readonly string[] = ['']) =>
    values.flatMap((v) => suffixes.map((s) => `${prefix}.${v}${s}`)).filter((k) => !(k in dict))

  it('値の表記（research.enum.*）', () => {
    expect([
      ...need('research.enum.stage', CANDIDATE_STAGES, ['', '.desc']),
      ...need('research.enum.principle', PRINCIPLE_KEYS),
      ...need('research.enum.segmentAxis', SEGMENT_AXES, ['', '.tip']),
      ...need('research.enum.whoCondition', WHO_CONDITIONS),
      ...need('research.enum.demandFactor', DEMAND_FACTORS),
      ...need('research.enum.problemType', PROBLEM_TYPES),
      ...need('research.enum.demandLevel', DEMAND_LEVELS),
      ...need('research.enum.channel', CHANNELS),
      ...need('research.enum.customerState', CUSTOMER_STATES),
      ...need('research.enum.channelAxis', CHANNEL_AXES, ['', '.tip']),
      ...need('research.enum.triggerKind', TRIGGER_KINDS),
      ...need('research.enum.intent', ['info', 'purchase', 'unknown']),
      ...need('research.enum.differentiator', DIFFERENTIATORS, ['', '.caution']),
      ...need('research.enum.whyItem', WHY_RESEARCH_ITEMS, ['', '.tip']),
      ...need('research.enum.evidenceKind', EVIDENCE_KINDS),
      ...need('research.enum.grade', EVIDENCE_GRADES, ['', '.means']),
      ...need('research.enum.reliability', RELIABILITY_LEVELS),
      ...need('research.enum.evidenceLevel', ['strong', 'moderate', 'weak', 'none']),
      ...need('research.enum.scoreKey', SCORE_KEYS, ['', '.tip']),
      ...need('research.enum.gateStatus', ['pass', 'fail', 'pending']),
      ...need('research.enum.suggestion', ['pass', 'fail', 'unknown']),
      ...need('research.enum.method', EXPERIMENT_METHODS),
      ...need('research.enum.expStatus', EXPERIMENT_STATUSES),
      ...need('research.enum.comparison', COMPARISON_METHODS),
      ...need('research.enum.metric', METRIC_KEYS),
      ...need('research.enum.verdict', ['proven', 'needsComparison', 'needsInterviews', 'inconclusive'], ['', '.hint']),
      ...need('research.enum.hint', ['targeting', 'message', 'reach', 'offer', 'retention', 'expansion']),
      ...need('research.enum.cacSource', ['measured', 'estimated', 'none'])
    ]).toEqual([])
  })

  it('区分・流れ・ゲート・依頼', () => {
    expect([
      ...need('research.tab', WORKSPACE_TABS),
      ...need('research.section', RESEARCH_SECTIONS, ['.lead', '.flow']),
      ...RESEARCH_SECTIONS.flatMap((s) => need(`research.guide.${s}`, ['theory', 'research', 'judge', 'experiment', 'done'])),
      ...need('research.flow', FLOW_STEPS, ['', '.sub']),
      ...need('research.gate', GATE_IDS, ['.title', '.desc']),
      ...need('research.prompt', RESEARCH_PROMPT_IDS, ['.title', '.desc']),
      ...need('research.promote.missing', ['G1', 'G2', 'G3', 'whyReason', 'alreadyPromoted', 'dropped', 'scene', 'exit'])
    ]).toEqual([])
  })

  it('v3: 場面・成立条件・次の行動・段階・役割・収益・実行条件・証拠の評価', () => {
    expect([
      ...need('research.scene', SCENE_KEYS, ['', '.example']),
      ...need('research.cond', CONDITION_KEYS, ['', '.support', '.counter', '.unknown', '.next']),
      ...need('research.enum.conditionStatus', CONDITION_STATUSES),
      ...need('research.enum.decision', NEXT_DECISIONS, ['', '.when']),
      ...need('research.exit', EXIT_KEYS),
      ...need('research.enum.businessStage', BUSINESS_STAGES, ['', '.desc']),
      ...need('research.enum.role', ROLE_KEYS, ['', '.tip']),
      ...need('research.enum.side', MONETIZATION_SIDES),
      ...need('research.enum.orderScene', ORDER_SCENES),
      ...need('research.exec', EXECUTION_KEYS, ['', '.plan', '.done']),
      ...need('research.enum.reading', READING_KEYS, ['', '.tip']),
      ...need('research.enum.readingLevel', READING_LEVELS),
      ...need('research.enum.behaviorLevel', BEHAVIOR_LEVELS),
      ...need('research.enum.evidenceState', EVIDENCE_STATES),
      ...need('research.ev.readingTone', ['ok', 'weak', 'ng', 'unset', 'partial']),
      ...need('research.ev.timing', ['publishedBeforeEvent', 'old'])
    ]).toEqual([])
  })

  it('principles.ts・gates.ts が出す Check の id と params はすべて文言がある', () => {
    // 空の候補と、数の埋まった候補の両方で、出てくる Check を全部拾う
    const empty = candidate('C001')
    const full = candidate('C002', {
      who: { ...empty.who, companies: [{ company: 'A', industry: 'IT', employees: 50, situation: '募集中', inferredProblem: '人手不足', evidenceUrl: 'https://a.example', buyerRole: '部長', reachPath: '窓口' }], targetCount: 120 },
      how: { ...empty.how, monthlyPrice: 30000, marginRate: 0.8, estimatedCac: 50000, automation: 'x' },
      why: { ...empty.why, switching: { expectedValue: 100, adoptionCost: 10, switchingRisk: 10, statusQuoValue: 10, coexists: null } }
    })
    const x = { ...emptyExperiment('X001'), candidate: 'C002', status: 'done' as const, method: 'outreach' as const }
    x.metrics = { ...x.metrics, targets: 100, contacted: 80, reachedBuyer: 40, responded: 20, meetings: 10, contracts: 2, spend: 100000 }
    // 5条件すべてに反証（refuted）を付けた候補（次の行動の理由 conditionAlarm を全原則で出す）
    const alarmed = candidate('C003')
    for (const k of CONDITION_KEYS) alarmed.conditions[k] = { ...alarmed.conditions[k], status: 'refuted' }
    const d = data({ candidates: [empty, full, alarmed], experiments: [x] })
    const checks = [empty, full, alarmed].flatMap((c) => {
      const st = principleStatus(c, d)
      const gates = autoGates(c, d)
      const stage = businessStage(c, d)
      return [
        ...PRINCIPLE_KEYS.flatMap((p) => [...st[p].research, ...st[p].experiment]),
        ...GATE_IDS.flatMap((g) => gates[g].reasons),
        ...nextDecision(c, d).reasons,
        ...exitChecks(c, d),
        ...BUSINESS_STAGES.map((s) => stage.checks[s])
      ]
    })
    expect(checks.some((c) => c.id === 'conditionAlarm')).toBe(true)
    expect(checks.length).toBeGreaterThan(20)
    const missing: string[] = []
    for (const c of checks) {
      const key = `research.check.${c.principle}.${c.id}`
      const text = dict[key]
      if (!text) { missing.push(key); continue }
      // 渡されない {{変数}} は括弧書きの中だけ（画面は stripUnfilled で括弧ごと消す）。括弧の外に穴が残ってはいけない
      const shown = stripUnfilled(text.replace(/\{\{\s*(\w+)\s*\}\}/g, (m, v: string) => (c.params && v in c.params ? String(c.params[v]) : m)))
      if (shown.includes('—') && !text.includes('—')) missing.push(`${key}: ${shown}`)
    }
    expect([...new Set(missing)]).toEqual([])
  })
})
