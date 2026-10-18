import { useMemo } from 'react'
import { Lock, Plus, Trash2 } from 'lucide-react'
import {
  ACQUISITION_KEYS,
  CONDITION_METRICS,
  DEMAND_KEYS,
  EXPERIMENT_STATUSES,
  PROVISION_KEYS,
  READ_STATUSES,
  SCORE_LABELS,
  SOURCE_KINDS,
  STAGES,
  UNKNOWN,
  VERDICTS,
  type AcquisitionKey,
  type BusinessData,
  type Condition,
  type DemandKey,
  type ExperimentNumbers,
  type ProvisionKey,
  type Score,
  type ScoreKey,
  type YesNo
} from '@shared/business/model'
import { acquisitionTotal, countability, demandTotal, totalLabel } from '@shared/business/scoring'
import { acquisitionCost, cac, judge, marginAfterDelivery, moneyLabel, paybackMonths, type Money, type Payback } from '@shared/business/experiment'
import { Badge, Button, IconButton, Tooltip } from '../ui'
import type { FormProps } from './RecordEditor'
import { ChoicePicker, FieldRow, IdPicker, IssueLines, NumberInput, Section, SelectInput, TextArea, TextInput } from './fields'
import { DETAIL_LABELS, NUMBER_FIELDS, contentKeys, issuesFor, linesToList, provisionText } from './view'

/** 用語の説明（見出しに重ねたときだけ出す） */
const SCORE_TIPS: Record<ScoreKey | ProvisionKey, string> = {
  D1: '期限・頻度など、急いで解決したい理由',
  D2: '放置したときの損失（時間・費用・機会）',
  D3: 'すでに取っている解決の行動',
  D4: '今の手段で残る不足',
  D5: 'だれが払い、どう決めるか',
  A1: '対象者を見分けられるか',
  A2: '対象者に届く接点があるか',
  A3: '買う時期が分かるか',
  A4: 'これまでに獲得できた実績',
  P1: '約束した結果を出せるか',
  P2: '相手の業務に導入できるか',
  P3: '提供して採算が合うか',
  P4: '結果の責任を担えるか'
}

function hypothesisOptions(data: BusinessData) {
  return data.hypotheses.map((h) => ({ value: h.id, label: `${h.id}　${h.name || '名前なし'}` }))
}

function evidenceOptions(data: BusinessData) {
  return data.evidence.map((e) => ({ id: e.id, label: `${e.party || e.medium || '当事者なし'}${e.readStatus === '発見のみ' ? '（発見のみ）' : ''}` }))
}

function HypothesisSelect({ value, onChange, data, issues, testId }: { value: string; onChange: (v: string) => void; data: BusinessData; issues?: ReturnType<typeof issuesFor>; testId?: string }) {
  return (
    <SelectInput
      label="仮説"
      value={value}
      options={[{ value: '', label: '選んでいません' }, ...hypothesisOptions(data)]}
      onChange={onChange}
      issues={issues}
      testId={testId}
    />
  )
}

// ---- 仮説（15.3） ----

export function HypothesisForm({ draft, set, issues, snapshot }: FormProps<'hypothesis'>) {
  const data = snapshot.data
  const ev = evidenceOptions(data)
  const f = (field: string) => issuesFor(issues, draft.id, field)
  const d = demandTotal(draft)
  const a = acquisitionTotal(draft)

  const scoreRow = (group: 'demand' | 'acquisition', key: DemandKey | AcquisitionKey) => {
    const entry = group === 'demand' ? draft.demand[key as DemandKey] : draft.acquisition[key as AcquisitionKey]
    const update = (patch: Partial<typeof entry>) => {
      if (group === 'demand') set({ demand: { ...draft.demand, [key]: { ...entry, ...patch } } })
      else set({ acquisition: { ...draft.acquisition, [key]: { ...entry, ...patch } } })
    }
    return (
      <tr key={key} data-testid={`score-${key}`}>
        <th scope="row">
          <Tooltip label={SCORE_TIPS[key]}><span className="biz-score__key"><b>{key}</b>{SCORE_LABELS[key]}</span></Tooltip>
        </th>
        <td>
          <ChoicePicker<Score> label={`${key} ${SCORE_LABELS[key]}`} value={entry.score} choices={[0, 1, 2, UNKNOWN]} onChange={(score) => update({ score })} testId={`score-${key}-picker`} />
        </td>
        <td>
          <IdPicker label={`${key} の根拠`} value={entry.evidence} options={ev} onChange={(evidence) => update({ evidence })} testId={`score-${key}-evidence`} emptyText="証拠がありません" />
        </td>
        <td>
          <input className="biz-cell-input" aria-label={`${key} の理由`} value={entry.reason} onChange={(e) => update({ reason: e.target.value })} />
          <IssueLines issues={f(key)} />
        </td>
      </tr>
    )
  }

  const provisionRow = (key: ProvisionKey) => {
    const entry = draft.provision[key]
    const update = (patch: Partial<typeof entry>) => set({ provision: { ...draft.provision, [key]: { ...entry, ...patch } } })
    return (
      <tr key={key} data-testid={`score-${key}`}>
        <th scope="row">
          <Tooltip label={SCORE_TIPS[key]}><span className="biz-score__key"><b>{key}</b>{SCORE_LABELS[key]}</span></Tooltip>
        </th>
        <td>
          <ChoicePicker<YesNo> label={`${key} ${SCORE_LABELS[key]}`} value={entry.value} choices={['はい', 'いいえ', UNKNOWN]} onChange={(value) => update({ value })} testId={`score-${key}-picker`} />
        </td>
        <td>
          <IdPicker label={`${key} の根拠`} value={entry.evidence} options={ev} onChange={(evidence) => update({ evidence })} emptyText="証拠がありません" />
        </td>
        <td>
          <input className="biz-cell-input" aria-label={`${key} の理由`} value={entry.reason} onChange={(e) => update({ reason: e.target.value })} />
          <IssueLines issues={f(key)} />
        </td>
      </tr>
    )
  }

  const scoreHead = (
    <thead>
      <tr><th scope="col">項目</th><th scope="col">点</th><th scope="col">根拠の証拠</th><th scope="col">理由</th></tr>
    </thead>
  )

  return (
    <>
      <Section title="仮説">
        <div className="biz-form">
          <TextInput label="名前" value={draft.name} onChange={(name) => set({ name })} testId="h-name" />
          <SelectInput
            label="判定"
            value={draft.verdict ?? ''}
            options={[{ value: '', label: '未定' }, ...VERDICTS.map((v) => ({ value: v, label: v }))]}
            onChange={(v) => set({ verdict: v === '' ? null : v })}
            testId="h-verdict"
          />
          <TextInput label="対象" value={draft.target} onChange={(target) => set({ target })} tip="誰が" />
          <TextInput label="きっかけ" value={draft.trigger} onChange={(trigger) => set({ trigger })} tip="どの場面で起きるか" />
          <TextInput label="得たい結果" value={draft.outcome} onChange={(outcome) => set({ outcome })} />
          <TextInput label="確認者" value={draft.checker} onChange={(checker) => set({ checker })} />
          <TextArea label="課題の1文" value={draft.problem} onChange={(problem) => set({ problem })} rows={2} tip="［誰が］［きっかけ］に［結果］を得たいが、［障害］でできない" />
          <TextArea label="提供案" value={draft.offer} onChange={(offer) => set({ offer })} rows={2} />
          <TextArea label="現行で解決しない理由" value={draft.whyUnsolved} onChange={(whyUnsolved) => set({ whyUnsolved })} rows={2} />
          <TextArea label="最大の反証" value={draft.biggestCounter} onChange={(biggestCounter) => set({ biggestCounter })} rows={2} />
          <TextArea label="次に確認すること" value={draft.next} onChange={(next) => set({ next })} rows={2} />
          <TextInput label="確認日" type="date" value={draft.checkedAt} onChange={(checkedAt) => set({ checkedAt })} />
        </div>
        <IssueLines issues={f('stage')} />
      </Section>

      <Section title="需要 D" actions={<span className="biz-total" data-testid="h-demand-total">{totalLabel(d)}</span>}>
        <table className="biz-table biz-score">{scoreHead}<tbody>{DEMAND_KEYS.map((k) => scoreRow('demand', k))}</tbody></table>
      </Section>
      <Section title="獲得 A" actions={<span className="biz-total" data-testid="h-acq-total">{totalLabel(a)}</span>}>
        <table className="biz-table biz-score">{scoreHead}<tbody>{ACQUISITION_KEYS.map((k) => scoreRow('acquisition', k))}</tbody></table>
      </Section>
      <Section title="提供 P" actions={<span className="biz-total" data-testid="h-prov-total">{provisionText(draft)}</span>}>
        <table className="biz-table biz-score">{scoreHead}<tbody>{PROVISION_KEYS.map(provisionRow)}</tbody></table>
      </Section>

      {draft.stageHistory.length > 0 && (
        <Section title="段階の履歴">
          <table className="biz-table">
            <thead><tr><th scope="col">日時</th><th scope="col">変更</th><th scope="col">メモ</th></tr></thead>
            <tbody>
              {[...draft.stageHistory].reverse().map((s, i, all) => (
                <tr key={contentKeys(all, (x) => `${x.at}:${x.from}:${x.to}`)[i]}><td className="biz-nowrap">{s.at.slice(0, 10)}</td><td className="biz-nowrap">{s.from} → {s.to}</td><td>{s.note}</td></tr>
              ))}
            </tbody>
          </table>
        </Section>
      )}
    </>
  )
}

// ---- 証拠（15.1） ----

export function EvidenceForm({ draft, set, issues, snapshot }: FormProps<'evidence'>) {
  const data = snapshot.data
  const f = (field: string) => issuesFor(issues, draft.id, field)
  const count = countability(draft)
  const supportKeys: ScoreKey[] = [...DEMAND_KEYS, ...ACQUISITION_KEYS]
  return (
    <>
      <Section
        title="証拠"
        actions={count.counts ? <Badge tone="success">独立当事者に数える</Badge> : <Tooltip label={count.reason}><Badge tone="neutral">数えない</Badge></Tooltip>}
      >
        <div className="biz-form">
          <FieldRow label="仮説">
            <IdPicker label="仮説" value={draft.hypotheses} options={data.hypotheses.map((h) => ({ id: h.id, label: h.name }))} onChange={(hypotheses) => set({ hypotheses })} testId="e-hypotheses" />
          </FieldRow>
          <SelectInput label="読めたか" value={draft.readStatus} options={READ_STATUSES.map((v) => ({ value: v, label: v }))} onChange={(readStatus) => set({ readStatus })} tip="読めていなければ発見のみ。数えない" testId="e-read" />
          <TextInput label="当事者" value={draft.party} onChange={(party) => set({ party })} tip="当事者と属性（氏名は書かない）" testId="e-party" />
          <TextInput label="当事者の確認根拠" value={draft.partyBasis} onChange={(partyBasis) => set({ partyBasis })} />
          <TextInput label="重複グループ" value={draft.dupGroup} onChange={(dupGroup) => set({ dupGroup })} tip="同じ人・同じ会社は同じ値。確かめていなければ U" mono />
          <SelectInput
            label="根拠の性質"
            value={draft.sourceKind}
            options={[...SOURCE_KINDS.map((v) => ({ value: v, label: v })), { value: UNKNOWN, label: 'U' }]}
            onChange={(sourceKind) => set({ sourceKind })}
          />
          <TextInput label="媒体" value={draft.medium} onChange={(medium) => set({ medium })} tip="発注サイト、レビューサイト、X など" />
          <TextInput label="URL" type="url" value={draft.url} onChange={(url) => set({ url })} issues={f('url')} mono testId="e-url" />
          <TextInput label="公開日" type="date" value={draft.publishedAt} onChange={(publishedAt) => set({ publishedAt })} />
          <TextInput label="確認日" type="date" value={draft.checkedAt} onChange={(checkedAt) => set({ checkedAt })} />
          <TextArea label="確認した事実" value={draft.facts} onChange={(facts) => set({ facts })} issues={f('facts')} />
          <TextArea label="原文" value={draft.quote} onChange={(quote) => set({ quote })} tip="原文のまま抜いた文" />
          <TextArea label="解釈" value={draft.interpretation} onChange={(interpretation) => set({ interpretation })} tip="解釈と採点できる範囲" rows={2} />
          <FieldRow label="支える項目" wide>
            <fieldset className="biz-toggles" aria-label="支える項目">
              {supportKeys.map((k) => {
                const on = draft.supports.includes(k)
                return (
                  <Tooltip key={k} label={SCORE_LABELS[k]}>
                    <button type="button" className="biz-toggle" aria-pressed={on} onClick={() => set({ supports: on ? draft.supports.filter((s) => s !== k) : [...draft.supports, k] })}>{k}</button>
                  </Tooltip>
                )
              })}
            </fieldset>
          </FieldRow>
          <TextArea label="反証" value={draft.counter} onChange={(counter) => set({ counter })} rows={2} />
        </div>
      </Section>
      <Section title="詳細">
        <div className="biz-form">
          {(Object.keys(DETAIL_LABELS) as Array<keyof typeof DETAIL_LABELS>).map((k) => (
            <TextInput key={k} label={DETAIL_LABELS[k]} value={draft.details[k]} onChange={(v) => set({ details: { ...draft.details, [k]: v } })} />
          ))}
        </div>
      </Section>
    </>
  )
}

// ---- 代替（15.2） ----

export function AlternativeForm({ draft, set, issues, snapshot }: FormProps<'alternative'>) {
  const f = (field: string) => issuesFor(issues, draft.id, field)
  return (
    <Section title="代替比較">
      <div className="biz-form">
        <HypothesisSelect value={draft.hypothesis} onChange={(hypothesis) => set({ hypothesis })} data={snapshot.data} issues={f('hypothesis')} />
        <TextInput label="今の方法" value={draft.method} onChange={(method) => set({ method })} tip="既存SaaS、Excel、汎用AI、手作業、外注、何もしない" testId="alt-method" />
        <TextInput label="提供内容" value={draft.offering} onChange={(offering) => set({ offering })} />
        <TextInput label="総費用" value={draft.cost} onChange={(cost) => set({ cost })} tip="基本料・従量・初期費・移行・確認作業" />
        <TextArea label="残る不足" value={draft.gap} onChange={(gap) => set({ gap })} rows={2} />
        <TextArea label="次に確認すること" value={draft.nextCheck} onChange={(nextCheck) => set({ nextCheck })} rows={2} />
        <TextInput label="URL" type="url" value={draft.url} onChange={(url) => set({ url })} mono />
        <TextInput label="確認日" type="date" value={draft.checkedAt} onChange={(checkedAt) => set({ checkedAt })} />
      </div>
    </Section>
  )
}

// ---- 聞き取り ----

export function InterviewForm({ draft, set, issues, snapshot }: FormProps<'interview'>) {
  const f = (field: string) => issuesFor(issues, draft.id, field)
  return (
    <Section title="聞き取り">
      <div className="biz-form">
        <HypothesisSelect value={draft.hypothesis} onChange={(hypothesis) => set({ hypothesis })} data={snapshot.data} issues={f('hypothesis')} />
        <TextInput label="相手の役割" value={draft.role} onChange={(role) => set({ role })} tip="氏名は書かない" testId="i-role" />
        <TextInput label="日付" type="date" value={draft.date} onChange={(date) => set({ date })} />
        <FieldRow label="同意">
          <label className="biz-check">
            <input type="checkbox" checked={draft.consent} onChange={(e) => set({ consent: e.target.checked })} data-testid="i-consent" />
            <span>記録の同意を得た</span>
          </label>
        </FieldRow>
        <TextArea label="要約" value={draft.summary} onChange={(summary) => set({ summary })} issues={f('summary')} rows={4} />
        <TextArea
          label="原文"
          value={draft.transcript}
          onChange={(transcript) => set({ transcript })}
          issues={f('transcript')}
          disabled={!draft.consent && !draft.transcript}
          placeholder={draft.consent ? '' : '同意を得ると入力できます'}
          rows={6}
          testId="i-transcript"
        />
        <FieldRow label="出てきた証拠" wide>
          <IdPicker label="出てきた証拠" value={draft.evidence} options={evidenceOptions(snapshot.data)} onChange={(evidence) => set({ evidence })} />
        </FieldRow>
      </div>
    </Section>
  )
}

// ---- 結論（15.5） ----

export function DecisionForm({ draft, set, issues, snapshot }: FormProps<'decision'>) {
  const f = (field: string) => issuesFor(issues, draft.id, field)
  return (
    <>
      <Section title="結論">
        <div className="biz-form">
          <HypothesisSelect value={draft.hypothesis} onChange={(hypothesis) => set({ hypothesis })} data={snapshot.data} issues={f('hypothesis')} />
          <SelectInput label="判定" value={draft.verdict} options={VERDICTS.map((v) => ({ value: v, label: v }))} onChange={(verdict) => set({ verdict })} testId="c-verdict" />
          <SelectInput label="段階" value={draft.stage} options={STAGES.map((v) => ({ value: v, label: v }))} onChange={(stage) => set({ stage })} />
          <SelectInput label="打ち手" value={draft.worked} options={(['効いた', '効かなかった', '不明'] as const).map((v) => ({ value: v, label: v }))} onChange={(worked) => set({ worked })} />
          <TextInput label="誰が" value={draft.who} onChange={(who) => set({ who })} />
          <TextInput label="支払主体" value={draft.payer} onChange={(payer) => set({ payer })} />
          <TextInput label="損失" value={draft.loss} onChange={(loss) => set({ loss })} />
          <TextInput label="支出・時間" value={draft.spent} onChange={(spent) => set({ spent })} />
          <TextInput label="現行の不足" value={draft.gap} onChange={(gap) => set({ gap })} />
          <TextInput label="経路" value={draft.channel} onChange={(channel) => set({ channel })} />
          <TextArea label="提供" value={draft.offer} onChange={(offer) => set({ offer })} rows={2} />
          <FieldRow label="根拠" wide>
            <IdPicker label="根拠" value={draft.evidence} options={evidenceOptions(snapshot.data)} onChange={(evidence) => set({ evidence })} />
          </FieldRow>
          <TextArea label="反証" value={draft.counter} onChange={(counter) => set({ counter })} rows={2} />
          <TextArea label="未確認" value={draft.unknowns} onChange={(unknowns) => set({ unknowns })} rows={2} />
          <TextArea label="次に確認すること" value={draft.next} onChange={(next) => set({ next })} rows={2} />
          <TextArea label="合格・中止条件" value={draft.passStop} onChange={(passStop) => set({ passStop })} rows={2} />
        </div>
      </Section>
      <Section title="学び">
        <div className="biz-form">
          <TextArea label="学び（1行1件）" value={draft.learnings.join('\n')} onChange={(v) => set({ learnings: linesToList(v) })} rows={4} tip="次の周のプロンプトに入る" testId="c-learnings" />
        </div>
      </Section>
    </>
  )
}

// ---- 実験（15.4） ----

const METRIC_LABELS: Record<Condition['metric'], string> = {
  contacts: '接触', replies: '返信', qualified: '適格商談', priced: '価格提示', paid: '有料顧客', payments: '入金',
  accepted: '成果受入', repurchased: '再購入', interest: '関心表明', quoteRequests: '見積依頼', revenue: '入金額', cac: 'CAC'
}

function ConditionEditor({ label, value, onChange, testId }: { label: string; value: Condition[]; onChange: (v: Condition[]) => void; testId: string }) {
  const update = (i: number, patch: Partial<Condition>) => onChange(value.map((c, j) => (j === i ? { ...c, ...patch } : c)))
  return (
    <div className="biz-conds" data-testid={testId}>
      {value.length === 0 && <span className="biz-muted">決めていません</span>}
      {value.map((c, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: 条件の行は位置で決まる。中身で key を作ると、選び直すたびに行が作り直されて入力位置が外れる
        <div className="biz-cond" key={i}>
          <select className="biz-select" aria-label={`${label}${i + 1} の指標`} value={c.metric} onChange={(e) => update(i, { metric: e.target.value as Condition['metric'] })}>
            {CONDITION_METRICS.map((m) => <option key={m} value={m}>{METRIC_LABELS[m]}</option>)}
          </select>
          <select className="biz-select biz-select--op" aria-label={`${label}${i + 1} の比べ方`} value={c.op} onChange={(e) => update(i, { op: e.target.value as Condition['op'] })}>
            <option value=">=">以上</option>
            <option value="<=">以下</option>
          </select>
          <NumberInput placeholder="" label={`${label}${i + 1} の値`} value={c.value} onChange={(v) => update(i, { value: v ?? 0 })} />
          <IconButton size="sm" icon={<Trash2 size={13} />} label={`${label}${i + 1} を削除`} onClick={() => onChange(value.filter((_, j) => j !== i))} />
        </div>
      ))}
      <Button variant="ghost" icon={<Plus size={13} />} onClick={() => onChange([...value, { metric: 'paid', op: '>=', value: 1 }])} data-testid={`${testId}-add`}>条件を追加</Button>
    </div>
  )
}

function moneyCell(m: Money | Payback, testId?: string) {
  const text = moneyLabel(m)
  const reason = 'reason' in m ? m.reason : null
  const cell = <span className={m.kind === 'value' || m.kind === 'months' ? 'biz-num-text' : 'biz-muted'} data-testid={testId}>{text}</span>
  return reason ? <Tooltip label={reason}>{cell}</Tooltip> : cell
}

export function ExperimentForm({ draft, set, issues, snapshot, page }: FormProps<'experiment'> & { page?: React.ReactNode }) {
  const f = (field: string) => issuesFor(issues, draft.id, field)
  const planOnly = draft.status === '計画のみ'
  const verdict = useMemo(() => judge(draft), [draft])
  const setNum = (side: 'plan' | 'actual', key: keyof ExperimentNumbers, v: number | null) => set({ [side]: { ...draft[side], [key]: v } } as Partial<typeof draft>)

  const calcRows: Array<{ label: string; plan: Money | Payback; actual: Money | Payback; id: string }> = [
    { label: '獲得費', plan: acquisitionCost(draft.plan), actual: acquisitionCost(draft.actual), id: 'acq' },
    { label: 'CAC', plan: cac(draft.plan), actual: cac(draft.actual), id: 'cac' },
    { label: '提供後に残る額', plan: marginAfterDelivery(draft.plan), actual: marginAfterDelivery(draft.actual), id: 'margin' },
    { label: '回収月数', plan: paybackMonths(draft.plan), actual: paybackMonths(draft.actual), id: 'payback' }
  ]

  return (
    <>
      <Section title="実験">
        <div className="biz-form">
          <SelectInput label="状態" value={draft.status} options={EXPERIMENT_STATUSES.map((v) => ({ value: v, label: v }))} onChange={(status) => set({ status })} testId="x-status" />
          <HypothesisSelect value={draft.hypothesis} onChange={(hypothesis) => set({ hypothesis })} data={snapshot.data} issues={f('hypothesis')} />
          <TextInput label="確かめること" value={draft.question} onChange={(question) => set({ question })} />
          <TextInput label="対象の条件" value={draft.targetCondition} onChange={(targetCondition) => set({ targetCondition })} />
          <TextInput label="経路" value={draft.channel} onChange={(channel) => set({ channel })} testId="x-channel" />
          <TextInput label="価格" value={draft.price} onChange={(price) => set({ price })} />
          <TextArea label="提供" value={draft.offer} onChange={(offer) => set({ offer })} rows={2} />
          <TextInput label="開始日" type="date" value={draft.period.start} onChange={(start) => set({ period: { ...draft.period, start } })} issues={f('period')} />
          <TextInput label="終了日" type="date" value={draft.period.end} onChange={(end) => set({ period: { ...draft.period, end } })} />
          <FieldRow label="上限の費用">
            <NumberInput label="上限の費用" placeholder="未設定" unit="円" value={draft.limits.yen} onChange={(yen) => set({ limits: { ...draft.limits, yen } })} />
          </FieldRow>
          <FieldRow label="上限の工数" issues={f('limits')}>
            <NumberInput label="上限の工数" placeholder="未設定" unit="時間" value={draft.limits.hours} onChange={(hours) => set({ limits: { ...draft.limits, hours } })} />
          </FieldRow>
        </div>
      </Section>

      <Section title="合格条件と中止条件">
        <div className="biz-form">
          <FieldRow label="合格条件" issues={f('pass')} wide>
            <ConditionEditor label="合格条件" value={draft.pass} onChange={(pass) => set({ pass })} testId="x-pass" />
          </FieldRow>
          <FieldRow label="中止条件" issues={f('stop')} wide>
            <ConditionEditor label="中止条件" value={draft.stop} onChange={(stop) => set({ stop })} testId="x-stop" />
          </FieldRow>
        </div>
      </Section>

      <Section title="数">
        <table className="biz-table biz-plan" data-testid="x-numbers">
          <thead>
            <tr>
              <th scope="col">項目</th>
              <th scope="col" className="biz-plan__col biz-plan__col--plan">計画</th>
              <th scope="col" className="biz-plan__col biz-plan__col--actual">
                <span className="biz-plan__head">
                  実測
                  {planOnly && <Tooltip label="実施中にすると入力できます"><Lock size={12} aria-label="計画のみの間は入力できません" /></Tooltip>}
                </span>
              </th>
            </tr>
          </thead>
          <tbody>
            {NUMBER_FIELDS.map((field, i) => (
              <tr key={field.key} className={i > 0 && NUMBER_FIELDS[i - 1]!.group !== field.group ? 'biz-row-break' : undefined}>
                <th scope="row">{field.label}</th>
                <td className="biz-plan__col--plan">
                  <NumberInput label={`計画 ${field.label}`} unit={field.unit} value={draft.plan[field.key]} onChange={(v) => setNum('plan', field.key, v)} testId={`x-plan-${field.key}`} />
                </td>
                <td className="biz-plan__col--actual">
                  <NumberInput label={`実測 ${field.label}`} unit={field.unit} value={draft.actual[field.key]} onChange={(v) => setNum('actual', field.key, v)} disabled={planOnly && draft.actual[field.key] === null} testId={`x-actual-${field.key}`} />
                  <IssueLines issues={f(`actual.${field.key}`)} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <IssueLines issues={[...f('plan'), ...issues.filter((i) => i.ref === draft.id && i.field === 'actual')]} />
      </Section>

      <Section title="計算と判定" actions={<JudgeBadge verdict={verdict.verdict} />}>
        <table className="biz-table biz-plan" data-testid="x-calc">
          <thead><tr><th scope="col">項目</th><th scope="col" className="biz-plan__col biz-plan__col--plan">計画</th><th scope="col" className="biz-plan__col biz-plan__col--actual">実測</th></tr></thead>
          <tbody>
            {calcRows.map((r) => (
              <tr key={r.id}>
                <th scope="row">{r.label}</th>
                <td className="biz-plan__col--plan">{moneyCell(r.plan, `x-calc-plan-${r.id}`)}</td>
                <td className="biz-plan__col--actual">{moneyCell(r.actual, `x-calc-actual-${r.id}`)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="biz-judge" data-testid="x-judge">
          {verdict.verdict === '判定できない' && <p className="biz-muted">{verdict.reason}</p>}
          {[...verdict.pass.map((r) => ({ ...r, side: '合格' })), ...verdict.stop.map((r) => ({ ...r, side: '中止' }))].map((r, i, all) => (
            <div key={contentKeys(all, (x) => `${x.side}:${x.label}`)[i]} className="biz-judge__row">
              <span className="biz-judge__side">{r.side}</span>
              <span>{r.label}</span>
              <Badge tone={r.state === '満たす' ? (r.side === '合格' ? 'success' : 'danger') : 'neutral'}>{r.state}</Badge>
            </div>
          ))}
        </div>
      </Section>

      <Section title="結果">
        <div className="biz-form">
          <TextInput label="入金・受入の記録" value={draft.proof} onChange={(proof) => set({ proof })} tip="確かめられる記録の場所" />
          <TextInput label="品質" value={draft.quality} onChange={(quality) => set({ quality })} />
          <TextArea label="理由" value={draft.reasons} onChange={(reasons) => set({ reasons })} rows={2} />
          <TextArea label="結論" value={draft.conclusion} onChange={(conclusion) => set({ conclusion })} rows={2} />
        </div>
      </Section>
      {page}
    </>
  )
}

export function JudgeBadge({ verdict }: { verdict: '合格' | '中止' | '判定できない' }) {
  return <Badge tone={verdict === '合格' ? 'success' : verdict === '中止' ? 'danger' : 'neutral'}>{verdict}</Badge>
}
