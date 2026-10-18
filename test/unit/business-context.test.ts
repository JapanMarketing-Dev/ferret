/**
 * .business/context.md（Agent が最初に読む）と .business/README.md（記録の形式）
 */
import { describe, expect, it } from 'vitest'
import { emptyBusiness, emptyNumbers, emptyRecord } from '@shared/business/records'
import { RECORD_KINDS, STEPS, type BusinessData } from '@shared/business/model'
import { RECORD_README, contextMarkdown } from '@shared/business/context'

const NOW = '2026-10-17T09:00:00.000Z'

function data(over: Partial<BusinessData> = {}): BusinessData {
  return { root: '/tmp/b', business: emptyBusiness('経理代行', NOW), hypotheses: [], evidence: [], alternatives: [], interviews: [], experiments: [], decisions: [], approvals: [], searches: [], problems: [], ...over }
}

function populated(): BusinessData {
  const h = { ...emptyRecord('hypothesis', 'H01', NOW), name: '月末統合', next: '経理担当に聞く' }
  h.demand.D1 = { score: 2, evidence: ['E01'], reason: '' }
  const d = data({
    hypotheses: [h, emptyRecord('hypothesis', 'H02', NOW)],
    evidence: [
      { ...emptyRecord('evidence', 'E01', NOW), hypotheses: ['H01'], readStatus: '読了', url: 'https://example.com/1', dupGroup: 'A', facts: 'x' },
      { ...emptyRecord('evidence', 'E02', NOW), hypotheses: ['H02'] }
    ],
    alternatives: [{ ...emptyRecord('alternative', 'ALT01', NOW), hypothesis: 'H01' }],
    experiments: [
      { ...emptyRecord('experiment', 'X01', NOW), hypothesis: 'H01', channel: '紹介', status: '実施中', pass: [{ metric: 'paid', op: '>=', value: 1 }], stop: [{ metric: 'contacts', op: '<=', value: 0 }], actual: { ...emptyNumbers(), contacts: 5, paid: 0, adCost: 0 } },
      { ...emptyRecord('experiment', 'X02', NOW), hypothesis: 'H02' }
    ],
    approvals: [
      { ...emptyRecord('approval', 'R01', NOW), kind: '広告出稿', title: '広告を出す' },
      { ...emptyRecord('approval', 'R02', NOW), title: '済み', status: '承認' }
    ],
    interviews: [{ ...emptyRecord('interview', 'I01', NOW), hypothesis: 'H01', transcript: '同意なしの原文' }]
  })
  d.business.step = 'S8'
  d.business.loop = 2
  d.business.target = '月末に明細を統合したい経理担当'
  d.business.currentHypothesis = 'H01'
  return d
}

describe('context.md', () => {
  it('空のビジネスでも書ける', () => {
    const md = contextMarkdown(data(), '2026-10-17 09:00')
    expect(md).toContain('# いまの状況（経理代行）')
    expect(md).toContain('更新: 2026-10-17 09:00')
    expect(md).toContain('- ステップ: S1 対象決め（発見）／ 1 周目')
    expect(md).toContain('- 対象: U')
    expect(md).toContain('- 今の仮説: なし')
    expect(md).toContain('- 需要点 D: — ／ 獲得点 A: — ／ U の残り: 0')
    expect(md).toContain('- 人の承認待ち: 0 件')
    expect(md).toContain('U（仮説ファイルの next に書く）')
    expect(md).toContain('- business.yaml')
    expect(md).not.toContain('## 実験')
    expect(md).not.toContain('## 人の承認待ち')
    expect(md).not.toContain('## 記録の注意')
    expect(md.endsWith('\n')).toBe(true)
  })

  it('ステップ・出口条件・チェック・U の数・次に確かめること', () => {
    const md = contextMarkdown(populated(), 'now')
    expect(md).toContain('- ステップ: S8 有料試行・集客（アクション）／ 2 周目')
    expect(md).toContain('- 対象: 月末に明細を統合したい経理担当')
    expect(md).toContain('- 今の仮説: H01 月末統合／段階 探索メモ')
    expect(md).toContain('- 需要点 D: 未完了（U 残り 4） ／ 獲得点 A: 未完了（U 残り 4） ／ U の残り: 12')
    expect(md).toContain('- 独立当事者: 1')
    expect(md).toContain('- 記録の数: 仮説 2、証拠 2（読了 1）、代替 1、聞き取り 1、実験 2')
    expect(md).toContain('計画した期間・費用・接触数を消化した（手法.md 10〜11章）')
    expect(md).toContain('- [x] 実施中か完了の実験がある')
    expect(md).toContain('- [x] 経路ごとの接触数の実測がある')
    expect(md).toContain('経理担当に聞く')
  })

  it('今の仮説の実験だけを、判定と CAC（0 社なら未成立）つきで出す', () => {
    const md = contextMarkdown(populated(), 'now')
    expect(md).toContain('## 実験')
    expect(md).toContain('- X01（実施中）紹介: 判定 判定できない（合格条件を満たしていない（実施中なら続ける））、CAC 未成立')
    expect(md).not.toContain('- X02')
  })

  it('承認待ちだけを出す（承認済みは出さない）', () => {
    const md = contextMarkdown(populated(), 'now')
    expect(md).toContain('- 人の承認待ち: 1 件')
    expect(md).toContain('## 人の承認待ち（これらは実行しない）')
    expect(md).toContain('- R01 広告出稿: 広告を出す')
    expect(md).not.toContain('R02')
  })

  it('記録の注意（error は「直す」、warning は「注意」）', () => {
    const d = populated()
    d.problems.push({ path: 'evidence/E03.md', message: 'YAML を読めません' })
    const md = contextMarkdown(d, 'now')
    expect(md).toContain('## 記録の注意')
    expect(md).toContain('- 直す I01 transcript: 同意が無い聞き取りの原文は保存できません')
    expect(md).toContain('- 注意 evidence/E03.md : YAML を読めません')
  })

  it('記録の注意は 20 件まで', () => {
    const d = data({ problems: Array.from({ length: 30 }, (_, i) => ({ path: `evidence/E${i}.md`, message: '壊れ' })) })
    const md = contextMarkdown(d, 'now')
    expect(md.split('\n').filter((l) => l.startsWith('- 注意 '))).toHaveLength(20)
  })

  it('関係するファイル: 今の仮説・その証拠・代替・実験だけ', () => {
    const md = contextMarkdown(populated(), 'now')
    const files = md.split('## 関係するファイル')[1]!
    for (const f of ['business.yaml', 'hypotheses/H01.md', 'evidence/E01.md', 'alternatives/ALT01.md', 'experiments/X01.md']) expect(files).toContain(`- ${f}`)
    for (const f of ['hypotheses/H02.md', 'evidence/E02.md', 'experiments/X02.md']) expect(files).not.toContain(f)
  })

  it('証拠のファイルは 30 件まで', () => {
    const d = data({
      hypotheses: [emptyRecord('hypothesis', 'H01', NOW)],
      evidence: Array.from({ length: 40 }, (_, i) => ({ ...emptyRecord('evidence', `E${String(i + 1).padStart(2, '0')}`, NOW), hypotheses: ['H01'] }))
    })
    const md = contextMarkdown(d, 'now')
    expect(md.split('\n').filter((l) => l.startsWith('- evidence/'))).toHaveLength(30)
  })

  it('名前の無い仮説は（名前なし）', () => {
    expect(contextMarkdown(data({ hypotheses: [emptyRecord('hypothesis', 'H01', NOW)] }), 'now')).toContain('- 今の仮説: H01 （名前なし）／段階 探索メモ')
  })
})

describe('README.md（記録の形式）', () => {
  it('すべての記録の種類の置き場所と ID を書いている', () => {
    for (const k of Object.values(RECORD_KINDS)) {
      expect(RECORD_README).toContain(`${k.dir}/${k.prefix}01.md`)
      expect(RECORD_README).toContain(`${k.prefix}01…`)
    }
    expect(RECORD_README).toContain('business.yaml')
    expect(RECORD_README).toContain('searches.jsonl')
  })

  it('守るルール（U・D と A を足さない・発見のみ・未成立・同意）を書いている', () => {
    for (const s of ['U を 0 として合計しない', '足さない', '発見のみ', '未成立', 'consent: true', 'dupGroup', '計画のみ']) expect(RECORD_README).toContain(s)
  })

  it('すべてのステップと出口条件を書いている', () => {
    for (const s of STEPS) expect(RECORD_README).toContain(`- ${s.id} ${s.name}: ${s.exit}`)
  })
})
