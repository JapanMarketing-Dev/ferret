import { useEffect, useState, type ReactNode } from 'react'
import { Check, Circle, CircleAlert, RefreshCcw, TriangleAlert } from 'lucide-react'
import { PHASE_GOALS, RECORD_KINDS, STEPS, type BusinessData, type StepDefinition, type StepId } from '@shared/business/model'
import { exitChecks, type ExitCheck } from '@shared/business/steps'
import type { BusinessSnapshot } from '@shared/business/ipc'
import { cac, funnel, judge, moneyLabel } from '@shared/business/experiment'
import { Badge, Button, EmptyState, Tooltip } from '../ui'
import { JudgeBadge } from './forms'
import { HypothesisTable } from './lists'
import { Section } from './fields'
import { ExecutionPanel } from './ExecutionPanel'
import { contentKeys, lastLoopText } from './view'

const PHASES = ['発見', 'アクション', 'チェック'] as const
/** ループの表示の1段の数（10のステップを2段に分ける） */
const LOOP_COLUMNS = 5

/** ステップの状態（済み＝出口の確認がすべて済み・いま＝今のステップ・これから） */
type StepState = 'done' | 'current' | 'todo'
const STATE_LABEL: Record<StepState, string> = { done: '済み', current: 'いま', todo: 'これから' }

export function LoopView({ data, onCloseLoop, onPickStep, onGo, onUpdateBusiness }: {
  data: BusinessData
  /** S1 の説明の中で、ビジネス名と対象の1文を直す */
  onUpdateBusiness: (patch: { name: string; target: string }) => Promise<void>
  onCloseLoop: () => void
  onPickStep: (step: StepId) => void
  /** 記録する画面へ移る */
  onGo: (view: NonNullable<StepDefinition['view']>) => void
}) {
  const step = data.business.step
  // 見ているステップ（押しただけでは今のステップを変えない。変えるのは「このステップにする」）
  const [viewing, setViewing] = useState<StepId>(step)
  useEffect(() => setViewing(step), [step])
  const progress = STEPS.map((s) => {
    const checks = exitChecks(s.id, data)
    const done = checks.filter((c) => c.done).length
    const state: StepState = s.id === step ? 'current' : checks.length > 0 && done === checks.length ? 'done' : 'todo'
    return { def: s, checks, done, state }
  })
  const shown = progress.find((p) => p.def.id === viewing) ?? progress[0]!
  const last = lastLoopText(data.business)

  return (
    <div className="biz-loop" data-testid="loop-view">
      <div className="biz-loop__meta">
        <Badge tone="brand">{data.business.loop}周目</Badge>
        {last && <span className="biz-muted biz-ellipsis" data-testid="loop-last">{last}</span>}
        <span className="biz-spacer" />
        <Button icon={<RefreshCcw size={13} />} onClick={onCloseLoop} data-testid="close-loop">周を閉じる</Button>
      </div>
      {/* 2段×5つ（発見 S1〜S5 ／ アクション S6〜S8・チェック S9〜S10）。名前は省略せず1行で出す */}
      <ol className="biz-loop__steps">
        {progress.map(({ def: s, checks, done, state }, i) => {
          const phaseStart = i === 0 || STEPS[i - 1]!.phase !== s.phase
          const rowStart = i % LOOP_COLUMNS === 0
          return (
            <li key={s.id} className={`biz-loop__step is-${state}${s.id === viewing ? ' is-viewing' : ''}${phaseStart && !rowStart ? ' is-phase-gap' : ''}`} data-phase={PHASES.indexOf(s.phase)}>
              {phaseStart && <span className="biz-loop__phase">{s.phase}</span>}
              <button
                type="button"
                className="biz-loop__btn"
                aria-current={state === 'current' ? 'step' : undefined}
                aria-pressed={s.id === viewing}
                onClick={() => setViewing(s.id)}
                title={`${s.id} ${s.name}（${STATE_LABEL[state]}・出口 ${done}/${checks.length}）`}
                data-testid={`loop-${s.id}`}
              >
                <span className="biz-loop__top">
                  <span className="biz-loop__id">{s.id}</span>
                  <span className={`biz-loop__state biz-loop__state--${state}`} data-testid={`loop-${s.id}-state`}>
                    {state === 'done' && <Check size={11} aria-hidden />}
                    {STATE_LABEL[state]}
                  </span>
                </span>
                <span className="biz-loop__name">{s.name}</span>
                <span className="biz-loop__bar" aria-hidden><span style={{ width: `${checks.length ? (done / checks.length) * 100 : 0}%` }} /></span>
              </button>
            </li>
          )
        })}
      </ol>
      <StepGuide item={shown} onPickStep={onPickStep} onGo={onGo}>
        {shown.def.id === 'S1' && <TargetForm name={data.business.name} target={data.business.target} onSave={onUpdateBusiness} />}
      </StepGuide>
    </div>
  )
}

/** S1 の記録（ビジネス名と対象の1文）をその場で直す */
function TargetForm({ name, target, onSave }: { name: string; target: string; onSave: (patch: { name: string; target: string }) => Promise<void> }) {
  const [draft, setDraft] = useState({ name, target })
  const [busy, setBusy] = useState(false)
  useEffect(() => setDraft({ name, target }), [name, target])
  const changed = draft.name !== name || draft.target !== target
  const save = async () => {
    setBusy(true)
    try { await onSave({ name: draft.name.trim(), target: draft.target.trim() }) } finally { setBusy(false) }
  }
  return (
    <form className="biz-guide__form" onSubmit={(e) => { e.preventDefault(); void save() }} data-testid="guide-target-form">
      <label className="biz-modal__label" htmlFor="biz-guide-name">ビジネス名</label>
      <div className="field"><input id="biz-guide-name" className="field__input" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} data-testid="guide-name" /></div>
      <label className="biz-modal__label" htmlFor="biz-guide-target">対象の1文</label>
      <textarea id="biz-guide-target" className="biz-textarea" rows={2} value={draft.target} onChange={(e) => setDraft({ ...draft, target: e.target.value })} placeholder="誰が・どの場面で・何を完了したいか" data-testid="guide-target" />
      <div className="biz-panel__row">
        <Button variant="primary" disabled={!changed || !draft.name.trim()} busy={busy} onClick={() => void save()} data-testid="guide-target-save">保存</Button>
        {changed && <Button variant="ghost" onClick={() => setDraft({ name, target })}>元に戻す</Button>}
      </div>
    </form>
  )
}

/** 選んだステップの説明（段階の狙い・何をするか・記録するもの・終わりの目安と出口の確認） */
function StepGuide({ item, onPickStep, onGo, children }: {
  item: { def: StepDefinition; checks: ExitCheck[]; done: number; state: StepState }
  children?: ReactNode
  onPickStep: (step: StepId) => void
  onGo: (view: NonNullable<StepDefinition['view']>) => void
}) {
  const { def, checks, done, state } = item
  return (
    <section className="biz-guide" data-testid="step-guide" aria-label={`${def.id} ${def.name} の説明`}>
      <div className="biz-guide__head">
        <span className="biz-guide__id biz-mono">{def.id}</span>
        <h4 className="biz-guide__title">{def.name}</h4>
        <Badge tone={state === 'current' ? 'brand' : undefined}>{STATE_LABEL[state]}</Badge>
        <span className="biz-spacer" />
        {def.view && <Button onClick={() => onGo(def.view!)} data-testid="guide-go">{RECORD_KINDS[def.view].label}を開く</Button>}
        {state !== 'current' && <Button variant="primary" onClick={() => onPickStep(def.id)} data-testid="guide-pick">このステップにする</Button>}
      </div>
      <p className="biz-guide__phase"><b>{def.phase}</b>：{PHASE_GOALS[def.phase]}</p>
      <dl className="biz-guide__kv">
        <div><dt>何をする</dt><dd data-testid="guide-does">{def.does}</dd></div>
        <div><dt>記録するもの</dt><dd>{def.data}</dd></div>
        <div><dt>終わりの目安</dt><dd>{def.exit}</dd></div>
        <div>
          <dt>出口の確認 {done}/{checks.length}</dt>
          <dd>
            <ul className="biz-checks" data-testid="guide-checks">
              {checks.map((c) => (
                <li key={c.label} className={c.done ? 'is-done' : ''}>
                  {c.done ? <Check size={13} aria-label="済み" /> : <Circle size={11} aria-label="未" />}
                  <span>{c.label}</span>
                </li>
              ))}
            </ul>
          </dd>
        </div>
      </dl>
      {children}
    </section>
  )
}

export function Dashboard({ snapshot, onOpen, onCloseLoop, onPickStep, onOpenApprovals, onGo, onUpdateBusiness, onSnapshot }: {
  snapshot: BusinessSnapshot
  /** 実行条件を保存したときの最新の中身（無ければ実行条件の欄を出さない） */
  onSnapshot?: (s: BusinessSnapshot) => void
  onOpen: (kind: 'hypothesis' | 'experiment' | 'evidence' | 'alternative' | 'interview' | 'decision' | 'approval', id: string) => void
  onCloseLoop: () => void
  onPickStep: (step: StepId) => void
  onOpenApprovals: () => void
  onGo: (view: NonNullable<StepDefinition['view']>) => void
  onUpdateBusiness: (patch: { name: string; target: string }) => Promise<void>
}) {
  const { data, issues, summary } = snapshot
  const running = data.experiments.filter((x) => x.status === '実施中')
  const pending = summary.counts.pendingApprovals
  const errors = issues.filter((i) => i.severity === 'error')
  const warnings = issues.filter((i) => i.severity === 'warning')
  const issueRows = [...errors, ...warnings]
  const issueKeys = contentKeys(issueRows, (x) => `${x.severity}:${x.ref}:${x.field}:${x.message}`)
  const kindOf = (ref: string) => {
    const m = /^(ALT|H|E|I|X|C|R)\d/.exec(ref)
    return m ? ({ ALT: 'alternative', H: 'hypothesis', E: 'evidence', I: 'interview', X: 'experiment', C: 'decision', R: 'approval' } as const)[m[1] as 'H'] : null
  }

  return (
    <div className="biz-dashboard" data-testid="dashboard">
      <Section title="ループ">
        <LoopView data={data} onCloseLoop={onCloseLoop} onPickStep={onPickStep} onGo={onGo} onUpdateBusiness={onUpdateBusiness} />
      </Section>

      {pending > 0 && (
        <button type="button" className="biz-callout" onClick={onOpenApprovals} data-testid="dash-pending">
          <span className="biz-callout__count">{pending}</span>
          <span>件の承認待ち</span>
        </button>
      )}

      {onSnapshot && <ExecutionPanel data={data} onSaved={onSnapshot} />}

      <Section title="仮説" actions={<span className="biz-count">{data.hypotheses.length} 件</span>}>
        {data.hypotheses.length > 0 ? <HypothesisTable data={data} onOpen={(id) => onOpen('hypothesis', id)} /> : <EmptyState size="sm" title="仮説はまだありません" />}
      </Section>

      <Section title="実施中の実験" actions={<span className="biz-count">{running.length} 件</span>}>
        {running.length === 0 ? (
          <EmptyState size="sm" title="実施中の実験はありません" />
        ) : (
          <div className="biz-xlist">
            {running.map((x) => {
              const j = judge(x)
              const c = cac(x.actual)
              return (
                <div key={x.id} className="biz-xcard" data-testid={`dash-x-${x.id}`}>
                  <div className="biz-xcard__head">
                    <button type="button" className="biz-link biz-mono" onClick={() => onOpen('experiment', x.id)}>{x.id}</button>
                    <span className="biz-ellipsis" title={x.channel}>{x.channel || '経路なし'}</span>
                    <span className="biz-spacer" />
                    <span className="biz-kv"><span className="biz-muted">CAC</span>
                      {c.kind === 'value' ? <b className="biz-num-text">{moneyLabel(c)}</b> : <Tooltip label={c.reason}><b className="biz-muted" data-testid={`dash-x-${x.id}-cac`}>{moneyLabel(c)}</b></Tooltip>}
                    </span>
                    {j.verdict === '判定できない' ? <Tooltip label={j.reason}><JudgeBadge verdict={j.verdict} /></Tooltip> : <JudgeBadge verdict={j.verdict} />}
                  </div>
                  <ol className="biz-funnel">
                    {funnel(x.actual).map((s) => (
                      <li key={s.key} className="biz-funnel__step">
                        <span className="biz-funnel__label">{s.label}</span>
                        <span className={s.value === null ? 'biz-funnel__value biz-muted' : 'biz-funnel__value'}>{s.value === null ? '未計測' : s.value.toLocaleString('ja-JP')}</span>
                        <span className="biz-funnel__rate">{s.rate !== null ? `${s.rate}%` : ''}</span>
                      </li>
                    ))}
                  </ol>
                </div>
              )
            })}
          </div>
        )}
      </Section>

      <Section title="記録の注意" actions={<span className="biz-count">{errors.length > 0 && <span className="biz-text-danger">エラー {errors.length}</span>}{errors.length > 0 && '・'}注意 {warnings.length}</span>}>
        {issues.length === 0 ? (
          <EmptyState size="sm" title="注意はありません" />
        ) : (
          <ul className="biz-issue-list" data-testid="dash-issues">
            {issueRows.map((issue, i) => {
              const kind = kindOf(issue.ref)
              return (
                <li key={issueKeys[i]} className={`biz-issue-row biz-issue-row--${issue.severity}`}>
                  {issue.severity === 'error' ? <CircleAlert size={13} aria-label="エラー" /> : <TriangleAlert size={13} aria-label="注意" />}
                  {kind ? <button type="button" className="biz-link biz-mono" onClick={() => onOpen(kind, issue.ref)}>{issue.ref}</button> : <span className="biz-mono biz-muted">{issue.ref === 'business' ? '全体' : 'ファイル'}</span>}
                  <span className="biz-ellipsis" title={issue.message}>{issue.message}</span>
                </li>
              )
            })}
          </ul>
        )}
      </Section>
    </div>
  )
}
