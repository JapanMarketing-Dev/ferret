import { CircleAlert, TriangleAlert } from 'lucide-react'
import {
  BUSINESS_STAGES,
  CONDITION_STATUSES,
  EXIT_KEYS,
  NEXT_DECISIONS,
  SCENE_KEYS,
  type Candidate,
  type ConditionKey,
  type ConditionRow,
  type NextDecision,
  type ResearchData
} from '@shared/research/model'
import { conditionTable } from '@shared/research/conditions'
import { businessStage } from '@shared/research/stage'
import { nextDecision, researchExit, sceneSentence } from '@shared/research/decision'
import { useLocale, useT } from '../lib/i18n'
import { Badge, type BadgeTone } from '../ui'
import { Block, checkText, EnumSelect, EvidencePicker, Txt } from './fields'
import type { EditCandidate } from './Sections'
import { bothSides, sceneMissing } from './view'

const STATUS_TONE: Record<ConditionRow['status'], BadgeTone> = { supported: 'success', mixed: 'warning', refuted: 'danger', unverified: 'neutral' }
const DECISION_TONE: Record<NextDecision, BadgeTone> = { continue: 'neutral', experiment: 'brand', holdOrDrop: 'danger', invest: 'success' }

/**
 * 購買が起きる場面（調査の単位。候補ごとに必須）:「どんな企業の、誰が、何が起きたときに、どんな成果を必要とし、今はどう対処しているか」。
 * full なら5つの欄を直せる。そうでなければ一文と、空の欄の注意だけ（区分の頭に出す）
 */
export function SceneBlock({ c, edit, full }: { c: Candidate; edit: EditCandidate; full: boolean }) {
  const t = useT()
  const locale = useLocale()
  const missing = sceneMissing(c.scene)
  const sentence = missing.length === SCENE_KEYS.length ? '' : sceneSentence(c.scene, locale)
  const warn = missing.length > 0 && (
    <p className="biz-issue biz-issue--warning rs-scene__warn" role="status" data-testid="research-scene-missing">
      <TriangleAlert size={12} aria-hidden="true" />
      <span>{t('research.scene.missing', { items: missing.map((k) => t(`research.scene.${k}` as const)).join(t('research.ws.listSep')) })}</span>
    </p>
  )
  if (!full) {
    return (
      <div className={`rs-scene rs-scene--compact${missing.length ? ' is-missing' : ''}`} data-testid="research-scene-banner">
        <span className="rs-scene__label">{t('research.scene.title')}</span>
        <span className="rs-scene__sentence">{sentence || <span className="biz-muted">{t('research.scene.empty')}</span>}</span>
        {warn}
      </div>
    )
  }
  return (
    <Block title={t('research.scene.title')} note={t('research.scene.note')} testId="research-scene">
      {warn}
      <div className="biz-form">
        {SCENE_KEYS.map((k) => (
          <Txt key={k} label={t(`research.scene.${k}` as const)} placeholder={t(`research.scene.${k}.example` as const)} value={c.scene[k]} onChange={(v) => edit((x) => ({ ...x, scene: { ...x.scene, [k]: v } }))} wide testId={`research-scene-${k}`} />
        ))}
      </div>
      {sentence && <p className="rs-scene__sentence rs-scene__sentence--full" data-testid="research-scene-sentence">{sentence}</p>}
    </Block>
  )
}

/**
 * 成立条件の表（評価の主軸）。5条件 × 支持・反証・未確認・次の確認・判定。
 * 反証がある行（証拠か判定 refuted）は警告の色。支持・反証の両方に同じ証拠を置いたら知らせる
 */
export function ConditionsTable({ c, edit, data }: { c: Candidate; edit: EditCandidate; data: ResearchData }) {
  const t = useT()
  const rows = conditionTable(c, data)
  const options = data.evidence.filter((e) => e.candidate === c.id || e.candidate === '').map((e) => ({ id: e.id, label: e.fact || e.quote || e.subject || e.url }))
  const setRow = (key: ConditionKey, patch: Partial<ConditionRow>) => edit((x) => ({ ...x, conditions: { ...x.conditions, [key]: { ...x.conditions[key], ...patch } } }))
  const alarms = rows.filter((r) => r.signal.alarm).length
  return (
    <Block
      title={t('research.cond.title')}
      note={t('research.cond.note')}
      testId="research-conditions"
      actions={alarms > 0 ? <Badge tone="danger" icon={<CircleAlert size={12} aria-hidden="true" />}>{t('research.cond.alarms', { n: alarms })}</Badge> : undefined}
    >
      <div className="rs-conds">
        {rows.map(({ key, row, signal }) => {
          const dup = bothSides(row.support, row.counter)
          return (
            <section key={key} className={`rs-cond${signal.alarm ? ' is-alarm' : ''}`} data-testid={`research-cond-${key}`} data-status={signal.status} data-alarm={String(signal.alarm)} aria-label={t(`research.cond.${key}` as const)}>
              <header className="rs-cond__head">
                {signal.alarm && <CircleAlert size={14} className="rs-cond__alarm" aria-label={t('research.cond.alarm')} />}
                <h4 className="rs-cond__title">{t(`research.cond.${key}` as const)}</h4>
                <span className="biz-muted rs-cond__counts biz-num-text">{t('research.cond.counts', { support: signal.supportIndependent, counter: signal.counterIndependent })}</span>
                <span className="biz-spacer" />
                <EnumSelect compact label={t('research.cond.status')} value={row.status} options={CONDITION_STATUSES} labelOf={(v) => t(`research.enum.conditionStatus.${v}` as const)} onChange={(v) => v && setRow(key, { status: v })} testId={`research-cond-${key}-status`} />
                <Badge tone={STATUS_TONE[row.status]}>{t(`research.enum.conditionStatus.${row.status}` as const)}</Badge>
              </header>
              <div className="rs-cond__grid">
                <div className="rs-cond__col rs-cond__col--support">
                  <span className="rs-cond__label">{t('research.cond.support')}</span>
                  <span className="biz-muted rs-cond__hint">{t(`research.cond.${key}.support` as const)}</span>
                  <EvidencePicker label={t('research.cond.support')} value={row.support} options={options} onChange={(v) => setRow(key, { support: v })} testId={`research-cond-${key}-support`} />
                  <textarea className="biz-textarea" rows={2} aria-label={t('research.cond.supportNote')} value={row.supportNote} onChange={(e) => setRow(key, { supportNote: e.target.value })} />
                </div>
                <div className="rs-cond__col rs-cond__col--counter">
                  <span className="rs-cond__label">{t('research.cond.counter')}</span>
                  <span className="biz-muted rs-cond__hint">{t(`research.cond.${key}.counter` as const)}</span>
                  <EvidencePicker label={t('research.cond.counter')} value={row.counter} options={options} onChange={(v) => setRow(key, { counter: v })} testId={`research-cond-${key}-counter`} />
                  <textarea className="biz-textarea" rows={2} aria-label={t('research.cond.counterNote')} value={row.counterNote} onChange={(e) => setRow(key, { counterNote: e.target.value })} />
                </div>
                <div className="rs-cond__col">
                  <span className="rs-cond__label">{t('research.cond.unknown')}</span>
                  <span className="biz-muted rs-cond__hint">{t(`research.cond.${key}.unknown` as const)}</span>
                  <textarea className="biz-textarea" rows={2} aria-label={t('research.cond.unknown')} value={row.unknown} onChange={(e) => setRow(key, { unknown: e.target.value })} />
                </div>
                <div className="rs-cond__col">
                  <span className="rs-cond__label">{t('research.cond.next')}</span>
                  <span className="biz-muted rs-cond__hint">{t(`research.cond.${key}.next` as const)}</span>
                  <textarea className="biz-textarea" rows={2} aria-label={t('research.cond.next')} value={row.next} onChange={(e) => setRow(key, { next: e.target.value })} data-testid={`research-cond-${key}-next`} />
                </div>
              </div>
              {dup.length > 0 && <p className="biz-issue biz-issue--warning">{t('research.cond.bothSides', { ids: dup.join(', ') })}</p>}
            </section>
          )
        })}
      </div>
      <p className="biz-muted rs-hint">{t('research.cond.unverifiedNote')}</p>
    </Block>
  )
}

/**
 * 流れの帯の近くに出す判断のまとめ: 次の行動（機械の目安と理由 → 人が決める）、調査の終了条件（6項目）、事業を進める段階（5段階）
 */
export function DecisionPanel({ c, edit, data }: { c: Candidate; edit: EditCandidate; data: ResearchData }) {
  const t = useT()
  const next = nextDecision(c, data)
  const exit = researchExit(c, data)
  const stage = businessStage(c, data)
  const reachedIndex = stage.reached ? BUSINESS_STAGES.indexOf(stage.reached) : -1
  const exitDone = EXIT_KEYS.filter((k) => exit.items[k]).length
  return (
    <div className="rs-decision" data-testid="research-decision">
      <section className="rs-decision__card" aria-label={t('research.decision.title')} data-testid="research-next-decision">
        <h4 className="rs-decision__title">{t('research.decision.title')}</h4>
        <div className="rs-decision__row">
          <span className="biz-muted">{t('research.decision.machine')}</span>
          <Badge tone={DECISION_TONE[next.suggestion]}>{t(`research.enum.decision.${next.suggestion}` as const)}</Badge>
        </div>
        <p className="biz-muted rs-decision__desc">{t(`research.enum.decision.${next.suggestion}.when` as const)}</p>
        {next.reasons.length > 0 && (
          <ul className="rs-gate__reasons">
            {next.reasons.map((r, i) => (
              <li key={`${r.id}:${i}`} className={r.ok === true ? 'is-ok' : r.ok === false ? 'is-ng' : 'is-unknown'}>
                {checkText(t, r)}
              </li>
            ))}
          </ul>
        )}
        <div className="rs-decision__row">
          <EnumSelect
            label={t('research.decision.human')}
            allowNull
            value={c.decision}
            options={NEXT_DECISIONS}
            labelOf={(v) => t(`research.enum.decision.${v}` as const)}
            onChange={(v) => edit((x) => ({ ...x, decision: v }))}
            testId="research-decision-select"
          />
        </div>
        {c.decision && c.decision !== next.suggestion && <p className="biz-muted rs-hint">{t('research.decision.differs')}</p>}
      </section>
      <section className="rs-decision__card" aria-label={t('research.exit.title')} data-testid="research-exit">
        <h4 className="rs-decision__title">
          {t('research.exit.title')}
          <Badge tone={exit.done ? 'success' : 'neutral'}>{exitDone}/{EXIT_KEYS.length}</Badge>
        </h4>
        <ul className="rs-checks">
          {EXIT_KEYS.map((k) => (
            <li key={k} className={`rs-check rs-check--${exit.items[k] ? 'ok' : 'unknown'}`} data-exit={k}>
              <span className={`rs-dot${exit.items[k] ? ' is-on' : ''}`} aria-hidden="true" />
              <span>{t(`research.exit.${k}` as const)}</span>
            </li>
          ))}
        </ul>
        <p className="biz-muted rs-hint">{exit.done ? t('research.exit.doneNote') : t('research.exit.note')}</p>
      </section>
      <section className="rs-decision__card" aria-label={t('research.stage5.title')} data-testid="research-business-stage">
        <h4 className="rs-decision__title">{t('research.stage5.title')}</h4>
        <ol className="rs-stages">
          {BUSINESS_STAGES.map((s, i) => {
            const check = stage.checks[s]
            const state = i <= reachedIndex ? 'done' : i === reachedIndex + 1 ? 'next' : 'todo'
            return (
              <li key={s} className={`rs-stage rs-stage--${state}`} data-stage={s} data-state={state}>
                <span className="rs-stage__num biz-mono">{i + 1}</span>
                <span className="rs-stage__body">
                  <span className="rs-stage__name">{t(`research.enum.businessStage.${s}` as const)}</span>
                  <span className="biz-muted rs-stage__desc">{check ? checkText(t, check) : t(`research.enum.businessStage.${s}.desc` as const)}</span>
                </span>
              </li>
            )
          })}
        </ol>
        <p className="biz-muted rs-hint">{t('research.stage5.note')}</p>
      </section>
    </div>
  )
}
