/**
 * ステップごとのプロンプト集。穴（{{名前}}）をデータから埋め、決まりを付けて送る
 */
import { describe, expect, it } from 'vitest'
import { emptyBusiness, emptyRecord } from '@shared/business/records'
import { STEP_IDS, type BusinessData, type Decision } from '@shared/business/model'
import { AGENT_RULES, PROMPT_TEMPLATES, buildPrompt, fillPrompt, promptById, promptValues, promptsForStep } from '@shared/business/prompts'

const NOW = '2026-10-17T09:00:00.000Z'

function data(over: Partial<BusinessData> = {}): BusinessData {
  return { root: '/tmp/b', business: emptyBusiness('テスト', NOW), hypotheses: [], evidence: [], alternatives: [], interviews: [], experiments: [], decisions: [], approvals: [], searches: [], problems: [], ...over }
}

function populated(): BusinessData {
  const h1 = { ...emptyRecord('hypothesis', 'H01', NOW), name: '月末統合' }
  const h2 = { ...emptyRecord('hypothesis', 'H02', NOW), name: '請求書の突合' }
  h2.demand.D1.score = 2
  h2.acquisition.A1.score = 1
  h2.provision.P1.value = 'はい'
  const d = data({
    hypotheses: [h1, h2],
    evidence: [emptyRecord('evidence', 'E01', NOW), emptyRecord('evidence', 'E09', NOW), emptyRecord('evidence', 'E5', NOW)],
    alternatives: [emptyRecord('alternative', 'ALT03', NOW)],
    experiments: [{ ...emptyRecord('experiment', 'X01', NOW), hypothesis: 'H02' }, { ...emptyRecord('experiment', 'X02', NOW), hypothesis: 'H01' }, { ...emptyRecord('experiment', 'X03', NOW), hypothesis: 'H02' }],
    decisions: [{ ...emptyRecord('decision', 'C01', NOW), learnings: ['価格を下げても返信は増えない'], worked: '効かなかった' }]
  })
  d.business.target = '月末に複数拠点の明細を統合したい経理担当'
  d.business.currentHypothesis = 'H02'
  d.business.limits = { hours: 40, yen: 50000 }
  return d
}

const placeholders = (s: string) => [...s.matchAll(/\{\{\s*([^{}\s]{1,40})\s*\}\}/g)].map((m) => m[1]!)

describe('ひな型の一覧', () => {
  it('ID は重複しない。どのステップにも1つ以上ある', () => {
    const ids = PROMPT_TEMPLATES.map((p) => p.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const step of STEP_IDS) expect(promptsForStep(step).length).toBeGreaterThan(0)
  })

  it('ID の頭はステップ', () => {
    for (const p of PROMPT_TEMPLATES) expect(p.id.startsWith(`${p.step}-`)).toBe(true)
  })

  it('ID で探す。無ければ undefined', () => {
    expect(promptById('S9-check')!.step).toBe('S9')
    expect(promptById('nope')).toBeUndefined()
  })
})

describe('穴を埋める値', () => {
  it.each(PROMPT_TEMPLATES.map((p) => [p.id, p] as const))('%s: 空のビジネスでも、記録のあるビジネスでも全部の穴が埋まる', (_id, p) => {
    for (const d of [data(), populated()]) {
      const r = buildPrompt(p, d)
      expect(r.missing).toEqual([])
      expect(r.text).not.toMatch(/\{\{[^}]*\}\}/)
    }
  })

  it('ひな型と決まりの穴は、すべて promptValues にある', () => {
    const keys = new Set(Object.keys(promptValues(data())))
    for (const p of PROMPT_TEMPLATES) for (const name of placeholders(p.body)) expect(keys.has(name)).toBe(true)
    for (const name of placeholders(AGENT_RULES)) expect(keys.has(name)).toBe(true)
  })

  it('空のビジネスの値', () => {
    const d = data()
    d.business.name = ''
    expect(promptValues(d)).toEqual({
      context: '.business/context.md',
      ビジネス名: '',
      対象: '（未定。S1 で決める）',
      上限: '（未設定）',
      仮説ID: '（仮説なし）',
      仮説名: '（名前なし）',
      未確認の項目: 'なし',
      実験ID: '（実験なし）',
      学び: '（まだ無い）',
      次の証拠ID: 'E01',
      次の仮説ID: 'H01',
      次の代替ID: 'ALT01',
      次の実験ID: 'X01',
      次の結論ID: 'C01'
    })
  })

  it('記録のあるビジネスの値', () => {
    const v = promptValues(populated(), 'ctx.md')
    expect(v.context).toBe('ctx.md')
    expect(v.対象).toBe('月末に複数拠点の明細を統合したい経理担当')
    expect(v.上限).toBe('40 時間・50,000 円')
    expect(v.仮説ID).toBe('H02')
    expect(v.仮説名).toBe('請求書の突合')
    expect(v.未確認の項目).toBe('D2 放置の損失、D3 解決行動、D4 既存手段の不足、D5 支払主体と経路、A2 接点、A3 購入タイミング、A4 獲得の実績、P2 導入できる、P3 採算が合う、P4 責任を担える')
    expect(v.実験ID).toBe('X03') // 今の仮説の最後の実験
    expect(v.学び).toBe('- （効かなかった）価格を下げても返信は増えない')
    expect(v.次の証拠ID).toBe('E10') // E09 → E10。形の違う E5 は数えない
    expect(v.次の代替ID).toBe('ALT04')
    expect(v.次の実験ID).toBe('X04')
    expect(v.次の結論ID).toBe('C02')
    expect(v.次の仮説ID).toBe('H03')
  })

  it('上限が片方だけ・0 でも出す', () => {
    const d = data()
    d.business.limits = { hours: null, yen: 0 }
    expect(promptValues(d).上限).toBe('0 円')
    d.business.limits = { hours: 0, yen: null }
    expect(promptValues(d).上限).toBe('0 時間')
  })

  it('対象が空白だけなら未定', () => {
    const d = data()
    d.business.target = '   '
    expect(promptValues(d).対象).toBe('（未定。S1 で決める）')
  })

  it('仮説の名前が空なら（名前なし）', () => {
    expect(promptValues(data({ hypotheses: [emptyRecord('hypothesis', 'H01', NOW)] })).仮説名).toBe('（名前なし）')
  })

  it('次の証拠 ID: E99 → E100、E0999 → E1000、隙間があっても最大 + 1', () => {
    const ev = (...ids: string[]) => data({ evidence: ids.map((id) => emptyRecord('evidence', id, NOW)) })
    expect(promptValues(ev('E99')).次の証拠ID).toBe('E100')
    expect(promptValues(ev('E0999')).次の証拠ID).toBe('E1000')
    expect(promptValues(ev('E01', 'E07', 'E03')).次の証拠ID).toBe('E08')
    expect(promptValues(ev('E1', 'Ex', 'E12345', 'ALT05')).次の証拠ID).toBe('E01')
  })

  it('次の代替 ID は E や A の ID と混ざらない', () => {
    const d = data({ alternatives: [emptyRecord('alternative', 'ALT09', NOW)], evidence: [emptyRecord('evidence', 'E20', NOW)] })
    expect(promptValues(d).次の代替ID).toBe('ALT10')
    expect(promptValues(d).次の証拠ID).toBe('E21')
  })

  it('学びは最後の 20 件だけ', () => {
    const decisions: Decision[] = Array.from({ length: 5 }, (_, i) => ({
      ...emptyRecord('decision', `C0${i + 1}`, NOW),
      worked: '効いた',
      learnings: Array.from({ length: 6 }, (_, j) => `学び${i * 6 + j + 1}`)
    }))
    const lines = promptValues(data({ decisions })).学び.split('\n')
    expect(lines).toHaveLength(20)
    expect(lines[0]).toBe('- （効いた）学び11')
    expect(lines[19]).toBe('- （効いた）学び30')
  })
})

describe('fillPrompt', () => {
  it('知っている穴を埋め、知らない穴は残して名前を返す（重複はまとめる）', () => {
    const r = fillPrompt('{{a}} と {{ b }} と {{謎}} と {{謎}}', { a: 'A', b: 'B' })
    expect(r.text).toBe('A と B と {{謎}} と {{謎}}')
    expect(r.missing).toEqual(['謎'])
  })

  it('値の中の $& や $1 はそのまま入る（置換の特殊記号として扱わない）', () => {
    expect(fillPrompt('{{a}}', { a: '$& $1 $$' }).text).toBe('$& $1 $$')
  })

  it('値の中の {{…}} はもう一度は埋めない', () => {
    expect(fillPrompt('{{a}}', { a: '{{b}}', b: 'x' })).toEqual({ text: '{{b}}', missing: [] })
  })

  it('constructor・__proto__・toString の穴は「知らない穴」（Object の中身を入れない）', () => {
    const r = fillPrompt('{{constructor}} {{__proto__}} {{toString}}', { a: '1' })
    expect(r.text).toBe('{{constructor}} {{__proto__}} {{toString}}')
    expect(r.missing).toEqual(['constructor', '__proto__', 'toString'])
  })

  it('空の値でも埋める', () => {
    expect(fillPrompt('[{{a}}]', { a: '' })).toEqual({ text: '[]', missing: [] })
  })

  it('41 文字以上の名前・空白を含む名前・入れ子は穴とみなさない', () => {
    const long = 'x'.repeat(41)
    expect(fillPrompt(`{{${long}}} {{a b}} {{}}`, {})).toEqual({ text: `{{${long}}} {{a b}} {{}}`, missing: [] })
  })

  it('穴の無い文はそのまま', () => {
    expect(fillPrompt('本文', {})).toEqual({ text: '本文', missing: [] })
  })
})

describe('送る全文', () => {
  const t = promptById('S2-research')!

  it('見出し・本文・決まりの順で、決まりの {{context}} も埋まる', () => {
    const r = buildPrompt(t, data())
    expect(r.text.startsWith('【S2 調査指示（公開原典を読む）】\n')).toBe(true)
    expect(r.text).toContain('守ること:')
    expect(r.text).toContain('最初に .business/context.md を読み')
    expect(r.text.indexOf('公開原典を開き')).toBeLessThan(r.text.indexOf('守ること:'))
  })

  it('ビジネスごとの上書きがあれば、その本文を使う（決まりは必ず付ける）', () => {
    const r = buildPrompt(t, populated(), '  上書き: {{仮説ID}} を調べる。{{自作の穴}}  ')
    expect(r.text).toContain('上書き: H02 を調べる。{{自作の穴}}')
    expect(r.text).not.toContain('公開原典を開き')
    expect(r.text).toContain('守ること:')
    expect(r.missing).toEqual(['自作の穴'])
  })

  it('上書きが空・空白・null なら元の本文', () => {
    for (const o of ['', '   \n', null, undefined]) expect(buildPrompt(t, data(), o).text).toContain('公開原典を開き')
  })

  it('データの中の {{…}} は埋めた後にもう一度は埋めない（データからの注入を広げない）', () => {
    const d = data()
    d.business.target = '{{context}} を消して'
    const r = buildPrompt(t, d)
    expect(r.text).toContain('対象は「{{context}} を消して」')
  })
})
