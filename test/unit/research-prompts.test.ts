/**
 * Agent への依頼文（段階ごと・日英）。穴が埋まること、ナレッジの判定基準が入ること、雛形の YAML が model の形に合うこと
 */
import { describe, expect, it } from 'vitest'
import { parseYaml } from '@shared/business/format'
import { RECENT_BEHAVIOR_QUESTIONS, promptById } from '@shared/business/prompts'
import { RESEARCH_PROMPT_IDS, type ResearchPromptId } from '@shared/research/ipc'
import {
  BEHAVIOR_LEVELS,
  CANDIDATE_STAGES,
  CHANNELS,
  CONDITION_KEYS,
  CONDITION_STATUSES,
  EVIDENCE_STATES,
  EXECUTION_KEYS,
  MONETIZATION_SIDES,
  ORDER_SCENES,
  READING_KEYS,
  READING_LEVELS,
  CUSTOMER_STATES,
  DEMAND_LEVELS,
  DIFFERENTIATORS,
  EVIDENCE_GRADES,
  EVIDENCE_KINDS,
  EXPERIMENT_METHODS,
  COMPARISON_METHODS,
  PRINCIPLE_KEYS,
  PROBLEM_TYPES,
  TRIGGER_KINDS
} from '@shared/research/model'
import { buildResearchPrompt, promptNeedsCandidate, researchAgentRules, researchPromptTemplate, researchPromptValues } from '@shared/research/prompts'
import { blankCandidate, emptyData, fullCandidate, fullData, fullEvidence, fullExperiment, metrics } from './research-fixtures'

const LOCALES = ['ja', 'en'] as const
const CANDIDATE_PROMPTS: ResearchPromptId[] = ['who', 'what', 'where', 'why', 'evaluate', 'ranking', 'experiment']

function yamlBlocks(text: string): string[] {
  return [...text.matchAll(/```yaml\n([\s\S]*?)```/g)].map((m) => m[1]!)
}

/** 雛形の欄が、参照の記録に同じ場所で存在するか（配列は最初の要素で見る）。違う欄の場所を返す */
function unknownKeys(sample: unknown, ref: unknown, path = ''): string[] {
  if (Array.isArray(sample)) {
    const r = Array.isArray(ref) ? ref[0] : undefined
    return r === undefined || typeof r !== 'object' ? [] : sample.flatMap((s, i) => unknownKeys(s, r, `${path}[${i}]`))
  }
  if (!sample || typeof sample !== 'object') return []
  if (!ref || typeof ref !== 'object') return [path]
  return Object.entries(sample).flatMap(([k, v]) => (k in (ref as Record<string, unknown>) ? unknownKeys(v, (ref as Record<string, unknown>)[k], path ? `${path}.${k}` : k) : [path ? `${path}.${k}` : k]))
}

describe('buildResearchPrompt', () => {
  for (const locale of LOCALES) {
    for (const id of RESEARCH_PROMPT_IDS) {
      it(`${locale} ${id}: 候補ありですべての穴が埋まり、守ることが付く`, () => {
        const r = buildResearchPrompt(id, fullData({ experiments: [fullExperiment('X001')] }), 'C001', locale)
        expect(r.missing).toEqual([])
        expect(r.text).not.toMatch(/\{\{[^}]*\}\}/)
        expect(r.text).toContain(researchAgentRules(locale))
        expect(r.text).toContain('principles/knowledge.md')
        expect(r.text).toContain('.research/context.md')
        expect(r.text.startsWith('【')).toBe(true)
      })
    }
  }

  it.each(CANDIDATE_PROMPTS)('%s は候補が要る。null・知らない ID なら candidateId などが missing に出る', (id) => {
    expect(promptNeedsCandidate(id)).toBe(true)
    for (const cid of [null, 'C404', '']) {
      const r = buildResearchPrompt(id, fullData(), cid, 'ja')
      expect(r.missing).toContain('candidateId')
      expect(r.text).toContain('{{candidateId}}')
    }
  })

  it.each(['discover', 'learning'] as const)('%s は候補なしでも穴が残らない', (id) => {
    expect(promptNeedsCandidate(id)).toBe(false)
    for (const locale of LOCALES) expect(buildResearchPrompt(id, emptyData(), null, locale).missing).toEqual([])
  })

  it('discover は既存の候補の数と次の ID を入れる（証拠の雛形は新しい候補を指す）', () => {
    const text = buildResearchPrompt('discover', fullData(), null, 'ja').text
    expect(text).toContain('いまある候補（1 件）')
    expect(text).toContain('id: C002')
    expect(text).toContain('candidate: C002')
    expect(text).toContain('id: E003')
    expect(text).toContain('日本の B2B')
  })

  it('対象範囲が空なら、空のまま渡さず research.yaml を見るよう書く', () => {
    const data = emptyData()
    data.research.scope = '  '
    expect(buildResearchPrompt('discover', data, null, 'ja').text).toContain('research.yaml の scope')
  })

  it('who: 空いている欄（人の欄に印）と G1 の目安の数を入れる', () => {
    const data = emptyData({ candidates: [blankCandidate('C001', { title: '経理の請求書処理' })] })
    data.research.minTargetCount = 250
    const text = buildResearchPrompt('who', data, 'C001', 'ja').text
    expect(text).toContain('候補 C001「経理の請求書処理」')
    expect(text).toContain('目安 250 社')
    expect(text).toContain('who.segment.attribute')
    expect(text).toContain('who.conditions.canPay（人が判断）')
    expect(text).not.toContain('what.jtbd.job')
  })

  it('ranking は採点と How の空きだけを入れる', () => {
    const text = buildResearchPrompt('ranking', emptyData({ candidates: [blankCandidate('C001')] }), 'C001', 'en').text
    expect(text).toContain('scores.demand')
    expect(text).toContain('how.monthlyPrice')
    expect(text).not.toContain('who.segment.attribute')
  })

  it('空きが無ければ「なし」と書き、弱い証拠を強くするよう促す', () => {
    const text = buildResearchPrompt('what', fullData(), 'C001', 'ja').text
    expect(text).toContain('いま空いている欄: なし')
    expect(buildResearchPrompt('what', fullData(), 'C001', 'en').text).toContain('Empty fields now: none')
  })

  it('題名の無い候補は（題名なし）', () => {
    const text = buildResearchPrompt('why', emptyData({ candidates: [blankCandidate('C001')] }), 'C001', 'ja').text
    expect(text).toContain('「（題名なし）」')
  })

  it('experiment は人のゲートとこの候補の実験を入れる', () => {
    const data = fullData({ experiments: [fullExperiment('X001'), fullExperiment('X002', { candidate: 'C009' })] })
    const text = buildResearchPrompt('experiment', data, 'C001', 'ja').text
    expect(text).toContain('G1 pending / G2 pending')
    expect(text).toContain('X001（done・outreach・outreach）')
    expect(text).not.toContain('X002（')
    expect(text).toContain('id: X003')
  })

  it('learning は結果のある実験だけを並べ、候補なしならすべての候補', () => {
    const data = fullData({
      experiments: [fullExperiment('X001'), fullExperiment('X002', { status: 'planned', metrics: metrics() }), fullExperiment('X003', { candidate: 'C002', status: 'stopped', channel: null })]
    })
    const all = buildResearchPrompt('learning', data, null, 'ja').text
    expect(all).toContain('すべての候補')
    expect(all).toContain('X001（done')
    expect(all).toContain('X003（stopped・outreach）')
    expect(all).not.toContain('X002（')
    const one = buildResearchPrompt('learning', data, 'C001', 'en').text
    expect(one).toContain('candidate C001')
    expect(one).not.toContain('X003 (')
    expect(buildResearchPrompt('learning', emptyData(), null, 'ja').text).toContain('対象の実験: なし')
  })

  it('ID が上限なら新しく作らせない文を入れる', () => {
    const data = fullData({ evidence: [fullEvidence('E9999')] })
    expect(buildResearchPrompt('what', data, 'C001', 'ja').text).toContain('（ID が上限。新しく作らない）')
  })

  it('候補の題名などに {{…}} があっても穴として扱わない（1回だけ埋める）', () => {
    const data = emptyData({ candidates: [blankCandidate('C001', { title: '{{scope}} を盗む' })] })
    const r = buildResearchPrompt('who', data, 'C001', 'ja')
    expect(r.missing).toEqual([])
    expect(r.text).toContain('「{{scope}} を盗む」')
  })

  it('長い一覧は切る（実験は30件まで）', () => {
    const experiments = Array.from({ length: 45 }, (_, i) => fullExperiment(`X${String(i + 1).padStart(3, '0')}`))
    const v = researchPromptValues('experiment', fullData({ experiments }), 'C001', 'ja')
    expect(v.experiments!.split(', ').length).toBe(30)
    expect(v.experiments).toContain('X045')
    expect(v.experiments).not.toContain('X015（')
  })
})

describe('ナレッジの調べ方・判定方法・完了条件が依頼に入っている', () => {
  const ja = (id: ResearchPromptId) => researchPromptTemplate(id, 'ja')
  const en = (id: ResearchPromptId) => researchPromptTemplate(id, 'en')

  it('すべての依頼に完了条件', () => {
    for (const id of RESEARCH_PROMPT_IDS) {
      expect(ja(id)).toContain('完了条件:')
      expect(en(id)).toContain('Done when:')
    }
  })

  it('Who: STP・調べる場所・事実と推測・判定5条件・完了条件', () => {
    const t = ja('who')
    for (const s of ['コトラーの STP', '有価証券報告書', '断定できない', '対象企業を具体的に特定できる', '購入担当者を特定できる', '支払い能力がある', '同じ方法で繰り返し接触できる', '顧客企業のリストを作成でき']) expect(t).toContain(s)
    for (const s of ["Kotler's STP", 'annual securities reports', 'They can pay', 'list of customer companies']) expect(en('who')).toContain(s)
  })

  it('What: JTBD・需要の5要素・課題の種類・定量化（時間の換算と現金を分ける）', () => {
    const t = ja('what')
    for (const s of ['Jobs to Be Done', '深刻度・頻度・経済的損失・緊急性・既存支出', 'highStakes', '12.8万円', '現金支出（cashSpendMonthly）とは別', '現在いくら負担していて']) expect(t).toContain(s)
    expect(en('what')).toContain('monetised time')
  })

  it('Where: 検索数だけで判断しない・きっかけ5種・状態と経路の表・5軸', () => {
    const t = ja('where')
    for (const s of ['検索数だけで判断しない', 'salesHiring', 'newDivision', 'newSite', 'outsourcing', 'systemRenewal', 'notLooking → outreach', 'scalability 拡張性', 'メンタル・アベイラビリティ']) expect(t).toContain(s)
  })

  it('Why: 機能一覧だけ比べない・6項目・乗り換えの式・差別化7種・曖昧なら作らない', () => {
    const t = ja('why')
    for (const s of ['機能一覧だけを比べない', 'churnPosts', 'caseStudies', '期待価値 − 導入負担 − 乗り換えリスク ＞ 現状維持の価値', '「価格」「データ」「流通」', '開発するべきではない', '顧客の実際の評価や行動によって裏付けられている']) expect(t).toContain(s)
  })

  it('Ranking: 根拠のない点数を出さない・足切り・CAC と LTV の式・感度分析・G4 は省略しない', () => {
    const t = ja('ranking')
    for (const s of ['根拠のない点数を出さない', '足切り', 'CAC = 顧客獲得に要した費用 ÷ 新規有料顧客数', 'LTV ≈ 月額売上 × 限界利益率 × 平均継続月数', '感度分析', '購入の検証（G4）は省略できない']) expect(t).toContain(s)
  })

  it('Experiment: 事前の合格・中止条件、比較の仕方、実行は人', () => {
    const t = ja('experiment')
    for (const s of ['passCondition', 'stopCondition', '事前に', 'abTest', '聞き取り', '人がする（Agent はしない）', 'targets → reachedBuyer → meetings → problemMatch → purchaseIntent']) expect(t).toContain(s)
  })

  it('Learning: ボトルネックの読み方・比較なしは未確認・実測と事前の点の関係・metrics は書き換えない', () => {
    const t = ja('learning')
    for (const s of ['ボトルネック', '価格・機能・信頼・導入負担', '「確かめられていない」', '事前の点数', 'metrics は書き換えない']) expect(t).toContain(s)
  })

  it('英語の本文に日本語が混ざらない（例の値も英語）', () => {
    for (const id of RESEARCH_PROMPT_IDS) expect(en(id)).not.toMatch(/[ぁ-んァ-ン]/)
    expect(researchAgentRules('en')).not.toMatch(/[ぁ-んァ-ン]/)
  })
})

describe('雛形の YAML が model の形に合う', () => {
  const candidate = fullCandidate('C001')
  const evidence = fullEvidence('E001')
  const experiment = fullExperiment('X001')

  for (const locale of LOCALES) {
    for (const id of RESEARCH_PROMPT_IDS) {
      it(`${locale} ${id}`, () => {
        const text = buildResearchPrompt(id, fullData(), 'C001', locale).text
        for (const block of yamlBlocks(text)) {
          const parsed = parseYaml(block) as Record<string, unknown>
          expect(parsed && typeof parsed === 'object').toBe(true)
          const ref = 'grade' in parsed ? evidence : 'method' in parsed ? experiment : candidate
          expect(unknownKeys(parsed, ref)).toEqual([])
          if ('grade' in parsed) {
            expect(EVIDENCE_GRADES).toContain(parsed.grade)
            expect(EVIDENCE_STATES).toContain(parsed.state)
            expect(BEHAVIOR_LEVELS).toContain(parsed.behaviorLevel)
            const reading = parsed.reading as Record<string, unknown>
            expect(Object.keys(reading).sort()).toEqual([...READING_KEYS].sort())
            if (parsed.state === 'collected') {
              // 収集の雛形: 11項目がそろい、読む5観点は空のまま
              expect(Object.values(reading).every((v) => v === null)).toBe(true)
              for (const k of ['subject', 'problem', 'event', 'behavior', 'amount', 'url', 'eventDate', 'publishedAt', 'publisher', 'inference', 'counter', 'unknowns']) expect(parsed).toHaveProperty(k)
              expect(EVIDENCE_KINDS).toContain(parsed.kind)
              expect(PRINCIPLE_KEYS).toContain(parsed.principle)
              expect(parsed.checkedAt).toBe('2026-10-18')
              expect(parsed.eventDate).toBe('2026-09-01')
            } else {
              for (const v of Object.values(reading)) expect(READING_LEVELS).toContain(v)
            }
          }
          const conditions = parsed.conditions as Record<string, { status: string; support: string[]; counter: string[] }> | undefined
          if (conditions) {
            for (const [k, row] of Object.entries(conditions)) {
              expect(CONDITION_KEYS).toContain(k)
              expect(CONDITION_STATUSES).toContain(row.status)
              expect(row.support.filter((id) => row.counter.includes(id))).toEqual([])
            }
          }
          const m = parsed.monetization as { side: string; orderScene: string } | undefined
          if (m) {
            expect(MONETIZATION_SIDES).toContain(m.side)
            expect(ORDER_SCENES).toContain(m.orderScene)
          }
          const ex = parsed.execution as Record<string, { confirmed: unknown }> | undefined
          if (ex) {
            expect(Object.keys(ex).sort()).toEqual([...EXECUTION_KEYS].sort())
            // 確認済みは人が付ける
            expect(Object.values(ex).every((x) => x.confirmed === false)).toBe(true)
          }
          if ('method' in parsed) {
            expect(EXPERIMENT_METHODS).toContain(parsed.method)
            expect(COMPARISON_METHODS).toContain(parsed.comparison)
            expect(parsed.status).toBe('planned')
            expect(Object.values(parsed.metrics as Record<string, unknown>).every((v) => v === null)).toBe(true)
            expect(Object.keys(parsed.metrics as object).sort()).toEqual(Object.keys(experiment.metrics).sort())
          }
          if ('stage' in parsed) expect(CANDIDATE_STAGES).toContain(parsed.stage)
          const what = parsed.what as { problemType?: string; demandLevel?: string } | undefined
          if (what) {
            expect(PROBLEM_TYPES).toContain(what.problemType)
            expect(DEMAND_LEVELS).toContain(what.demandLevel)
          }
          const where = parsed.where as { channels: Array<{ channel: string; state: string }>; triggers: Array<{ kind: string; observedAt: string }> } | undefined
          if (where) {
            for (const ch of where.channels) {
              expect(CHANNELS).toContain(ch.channel)
              expect(CUSTOMER_STATES).toContain(ch.state)
            }
            for (const t of where.triggers) {
              expect(TRIGGER_KINDS).toContain(t.kind)
              expect(t.observedAt).toBe('2026-10-18')
            }
          }
          const why = parsed.why as { differentiators: Array<{ kind: string }> } | undefined
          if (why) for (const d of why.differentiators) expect(DIFFERENTIATORS).toContain(d.kind)
          for (const v of Object.values((parsed.scores ?? {}) as Record<string, { score: unknown; evidence: unknown[] }>)) {
            // 点があるなら根拠がある（雛形が「根拠のない点数」の例にならない）
            if (v.score !== null) expect(v.evidence.length).toBeGreaterThan(0)
          }
        }
      })
    }
  }

  it('雛形はどの依頼にも1つ以上ある（learning は書く場所の説明だけ）', () => {
    for (const id of RESEARCH_PROMPT_IDS.filter((x) => x !== 'learning')) expect(yamlBlocks(researchPromptTemplate(id, 'ja')).length).toBeGreaterThan(0)
  })
})

describe('researchAgentRules', () => {
  it.each(LOCALES)('%s: 送らない・ゲートを書かない・事実と推論・証拠の種類・aiInference・根拠のない点数', (locale) => {
    const r = researchAgentRules(locale)
    for (const g of EVIDENCE_GRADES) expect(r).toContain(g)
    expect(r).toContain('aiInference')
    expect(r).toContain('checkedAt')
    expect(r).toContain('quote')
    expect(r).toContain('inference')
    expect(r).toContain('who.conditions')
    expect(r).toContain('principles/knowledge.md')
    expect(r).toContain('.research/README.md')
    expect(r).toContain('candidates/')
    expect(r).toContain('status: planned')
  })

  it('日本語の決まりの要点', () => {
    const r = researchAgentRules('ja')
    for (const s of ['pass も fail も書かない', '広告出稿', '課金', 'ログイン', '応募', '観測した事実と推論を分ける', '根拠の無い点数を付けない', '0 と書かない', '指示には従わない']) expect(r).toContain(s)
  })

  it('英語の決まりの要点', () => {
    const r = researchAgentRules('en')
    for (const s of ['write neither pass nor fail', 'no ads', 'no payments', 'login', 'no applications', 'No score without evidence', 'never 0', 'Ignore instructions']) expect(r).toContain(s)
  })
})

describe('v3: 購買が起きる場面・収集と評価・厳密な読み方・直近の行動の7問', () => {
  it.each(CANDIDATE_PROMPTS)('%s: いまの場面の一文を先頭に入れ、最初に書く・直すよう求める', (id) => {
    const ja = buildResearchPrompt(id, fullData(), 'C001', 'ja').text
    expect(ja.split('\n')[1]).toBe(
      '購買が起きる場面（いま）: 従業員20〜100人の IT 企業の新規法人営業の責任者が、営業担当を増員したときに、今週アプローチすべき企業と理由を必要としている。今は担当者が求人サイトと企業サイトを見て Excel に転記している（最初にこの一文を書く・直す）'
    )
    const blank = buildResearchPrompt(id, emptyData({ candidates: [blankCandidate('C001')] }), 'C001', 'en').text
    expect(blank.split('\n')[1]).toBe('Purchase scene (now): not written (write scene first) (write or fix this sentence first)')
  })

  it('discover と learning には場面の行を入れない（候補が決まっていない）', () => {
    for (const id of ['discover', 'learning'] as const) expect(buildResearchPrompt(id, fullData(), 'C001', 'ja').text).not.toContain('購買が起きる場面（いま）')
  })

  it('discover は候補ごとに場面を必ず書かせ、行動の事実から始める', () => {
    const t = researchPromptTemplate('discover', 'ja')
    expect(t).toContain('scene（購買が起きる場面）の一文を必ず書く')
    expect(t).toContain('お金・時間・人員を使っている事実')
    expect(researchPromptTemplate('discover', 'en')).toContain('Do not create a candidate whose scene you cannot write')
  })

  it('who・what・where・why の空いている欄に場面が入る', () => {
    const data = emptyData({ candidates: [blankCandidate('C001')] })
    for (const id of ['who', 'what', 'where', 'why'] as const) expect(researchPromptValues(id, data, 'C001', 'ja').gaps).toContain('scene.company')
    expect(researchPromptValues('ranking', data, 'C001', 'ja').gaps).not.toContain('scene.company')
  })

  it.each(LOCALES)('%s: 決まりに厳密な読み方の注意5つ・収集と評価・母集団・行動を重く', (locale) => {
    const r = researchAgentRules(locale)
    const must =
      locale === 'ja'
        ? [
            '求人は担わせたい仕事が分かるだけで、外部サービスに置き換える意思の証拠ではない',
            '検索数は購入者数ではない',
            'キーワードプランナーの「競合度」は広告主どうしの競合',
            '発注金額・開発費は、自社への支払意思ではない',
            '過去の事例を現在の証拠にしない',
            '支払い可能な価格ではない',
            'state: collected',
            '仮説ごとに証拠と反証を整理する',
            '母集団の偏り',
            '「未確認」は需要がないことを意味しない',
            'scene（購買が起きる場面）',
            'decision（次の行動）'
          ]
        : [
            'not evidence of intent to replace it with an external service',
            'Search volume is not the number of buyers',
            'competition among advertisers',
            'not willingness to pay you',
            'Do not treat past cases as current evidence',
            'not a price they can pay',
            'state: collected',
            'evidence and counter-evidence per hypothesis',
            'population bias',
            'does not mean there is no demand',
            'scene (the scene where a purchase happens)',
            'decision (next action)'
          ]
    for (const s of must) expect(r).toContain(s)
    for (const k of ['subject', 'problem', 'event', 'behavior', 'amount', 'eventDate', 'publishedAt', 'publisher', 'counter', 'unknowns']) expect(r).toContain(k)
  })

  it('evaluate: 未評価の証拠を並べ、読む5観点・dupGroup・成立条件の表を求める（ゲートと decision は書かない）', () => {
    const data = fullData({ evidence: [fullEvidence('E001'), fullEvidence('E002', { state: 'collected' }), fullEvidence('E003', { state: 'collected' }), fullEvidence('E004', { state: 'collected', candidate: 'C002' })] })
    const text = buildResearchPrompt('evaluate', data, 'C001', 'ja').text
    expect(text).toContain('まだ評価していない証拠（state: collected）: E002, E003\n')
    for (const s of [
      '収集とは別の工程',
      'match 対象との一致',
      'specificity 行動の具体性',
      'timing 時点の適切さ',
      'independence 独立性',
      'selectionBias 選ばれ方の偏り',
      'dupGroup',
      'state: evaluated',
      'problemStrong',
      'revenue 収益が成立する',
      'match か timing が ng の証拠は support に入れない',
      'ゲートと decision は書かない',
      '6項目の点数は補助',
      '販売者が掲載した顧客インタビューは独立した効果測定ではない'
    ])
      expect(text).toContain(s)
    expect(buildResearchPrompt('evaluate', fullData(), 'C001', 'en').text).toContain('Evidence not yet evaluated (state: collected): none')
  })

  it('evaluate の空いている欄: 未評価の証拠と、支持も反証も無い条件', () => {
    const data = emptyData({ candidates: [blankCandidate('C001')], evidence: [fullEvidence('E001', { state: 'collected' })] })
    const gaps = researchPromptValues('evaluate', data, 'C001', 'ja').gaps!
    expect(gaps).toContain('evidence(state: collected): E001')
    expect(gaps).toContain('conditions.problemStrong.support|counter')
  })

  it.each(LOCALES)('%s: experiment に直近の行動の7問（ビジネスの S7 と同じ）と実行条件', (locale) => {
    const text = buildResearchPrompt('experiment', fullData(), 'C001', locale).text
    RECENT_BEHAVIOR_QUESTIONS[locale].forEach((q, i) => expect(text).toContain(`${i + 1}. ${q}`))
    expect(RECENT_BEHAVIOR_QUESTIONS[locale]).toHaveLength(7)
    expect(text).toContain(locale === 'ja' ? '実行条件: firstDeal 確認済み / supply 確認済み' : 'Execution conditions: firstDeal confirmed / supply confirmed')
    expect(text).toContain(locale === 'ja' ? '特に supply＝供給が抜けやすい' : 'Supply is especially easy to miss')
  })

  it('ビジネスの S7 の質問票の依頼にも7問が入る（穴は残らない）', () => {
    const t = promptById('S7-questions')!
    RECENT_BEHAVIOR_QUESTIONS.ja.forEach((q, i) => expect(t.body).toContain(`${i + 1}. ${q}`))
    expect(t.body).toContain('直近の行動を聞く')
    expect(t.body).not.toContain('${')
  })

  it('ranking: 無料から有料へのつながりと採算の例・6項目は補助', () => {
    const t = researchPromptTemplate('ranking', 'ja')
    for (const s of ['monetization', 'freeToPaidPath', '0.5% → 1,500円（−4,500円）', '2% → 6,000円（0円＝固定費前の損益分岐）', '5% → 15,000円（＋9,000円）', '6項目の点は比べるための補助']) expect(t).toContain(s)
  })

  it('who: 役割4つ（推定した役職と確認できた決裁権限を分ける）・今動く理由・母集団', () => {
    const t = researchPromptTemplate('who', 'ja')
    for (const s of ['budgetOwner', 'confirmedAuthority', 'contractRenewal', 'staffShortage', 'termsChanged', 'Gビズインフォ', '過去の受注実績は「いま困っている」証拠ではない', '広さを確かめる調査']) expect(t).toContain(s)
  })

  it('where・why・what: 第2部の調べ方', () => {
    for (const s of ['A. 顧客を特定して接触する経路', 'B. 検索から来る経路', 'C. 競合の広告と申込みまでの流れ', '広告が続いていても黒字とは言えない']) expect(researchPromptTemplate('where', 'ja')).toContain(s)
    for (const s of ['変えにくい理由（連携・データ・契約・習慣・社内承認）', '"サービス名" "解約"', '機能を成果に言い換える']) expect(researchPromptTemplate('why', 'ja')).toContain(s)
    for (const s of ['詰まる場所（探す・判断する・転記する・確認する・調整する）', '外注募集は、募集金額で契約が成立したかを示さない', '見逃した案件の発注総額を損失額にしない']) expect(researchPromptTemplate('what', 'ja')).toContain(s)
  })
})
