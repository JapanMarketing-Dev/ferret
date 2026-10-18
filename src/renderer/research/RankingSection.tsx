import { useEffect, useState } from 'react'
import { RotateCcw } from 'lucide-react'
import { DEFAULT_CUTOFFS, DEFAULT_WEIGHTS, MONETIZATION_SIDES, ORDER_SCENES, SCORE_KEYS, type Candidate, type ResearchData, type ScoreKey } from '@shared/research/model'
import type { ResearchSnapshot } from '@shared/research/ipc'
import { attractiveness, cutoffHits, normalizeWeights, scoreReliability, weightedScore } from '@shared/research/scoring'
import { effectiveCac, ltvSensitivity, paybackMonths } from '@shared/research/economics'
import { breakEvenRate, monetizationTable } from '@shared/research/monetization'
import { errorMessage } from '../lib/errors'
import { useT } from '../lib/i18n'
import { Badge, Button, useToast } from '../ui'
import { useResearchApi } from './api'
import { Block, EnumSelect, IdListField, NumField, ScoreSelect, Txt } from './fields'
import type { EditCandidate } from './Sections'
import {
  formatAttractiveness,
  formatMonths,
  formatPercent,
  formatRatio,
  formatScore,
  formatYen,
  parseConversionScenarios,
  parseCutoff,
  parseScenarios,
  parseWeight,
  sameJson,
  scenariosToInput,
  scoreState,
  weightsTotal
} from './view'

/**
 * 5 採点・ランキングと経済性（Ranking＋How）。
 * 6項目の点（1〜5）と根拠の証拠。根拠の無い点は数として数えず「根拠なし」と出す（weightedScore の unbacked）。
 * 重み・足切りは research.yaml（全候補に効く）。How の数から CAC・LTV（継続月数の感度分析）・回収期間を出す
 */
export function RankingSection({ c, edit, data, onSnapshot }: { c: Candidate; edit: EditCandidate; data: ResearchData; onSnapshot: (s: ResearchSnapshot) => void }) {
  const t = useT()
  const weights = normalizeWeights(data.research.weights)
  const result = weightedScore(c.scores, weights, data)
  const attr = attractiveness(c.scores, data).value
  const cut = cutoffHits(c.scores, data.research.cutoffs)
  const evidenceIds = data.evidence.map((e) => e.id)
  const unbacked = new Set<ScoreKey>(result.unbacked)
  return (
    <>
      <p className="biz-issue biz-issue--warning rs-aux-note" data-testid="research-rank-aux-note">{t('research.rank.auxNote')}</p>
      <HowBlock c={c} edit={edit} data={data} />
      <MonetizationBlock c={c} edit={edit} />
      <Block title={t('research.rank.scores')} note={t('research.rank.scoresNote')} testId="research-rank-scores">
        <div className="rs-score-summary" data-testid="research-rank-summary">
          <div className="rs-stat">
            <span className="rs-stat__label">{t('research.rank.weighted')}</span>
            <span className="rs-stat__value biz-num-text" data-testid="research-rank-value">{formatScore(result.value)}<small>/100</small></span>
            <span className="biz-muted rs-stat__sub">{t('research.rank.scoredItems', { n: result.scored, total: SCORE_KEYS.length })}</span>
          </div>
          <div className="rs-stat">
            <span className="rs-stat__label" title={t('research.rank.attractivenessTip')}>{t('research.rank.attractiveness')}</span>
            <span className="rs-stat__value biz-num-text" data-testid="research-rank-attr">{formatAttractiveness(attr)}</span>
            <span className="biz-muted rs-stat__sub">{t('research.rank.attractivenessFormula')}</span>
          </div>
          <div className="rs-stat">
            <span className="rs-stat__label">{t('research.rank.cutoffs')}</span>
            <span className="rs-stat__value">{cut.length === 0 ? <Badge tone="success">{t('research.rank.noCutoff')}</Badge> : <Badge tone="warning">{t('research.rank.held')}</Badge>}</span>
            <span className="biz-muted rs-stat__sub">{cut.map((k) => t(`research.enum.scoreKey.${k}` as const)).join(', ')}</span>
          </div>
        </div>
        <p className="biz-muted rs-hint">{t('research.rank.g4Note')}</p>
        <div className="rs-scroll">
          <table className="biz-table rs-score-table">
            <thead>
              <tr>
                <th>{t('research.rank.item')}</th>
                <th>{t('research.rank.weight')}</th>
                <th>{t('research.rank.score')}</th>
                <th>{t('research.rank.state')}</th>
                <th>{t('research.rank.reliability')}</th>
                <th>{t('research.rank.evidence')}</th>
                <th className="biz-col-grow">{t('research.rank.reason')}</th>
              </tr>
            </thead>
            <tbody>
              {SCORE_KEYS.map((k) => {
                const entry = c.scores[k]
                const state = scoreState(entry.score, !unbacked.has(k) && entry.score !== null)
                const rel = scoreReliability(entry, data)
                return (
                  <tr key={k} data-testid={`research-score-${k}`} data-state={state}>
                    <th title={t(`research.enum.scoreKey.${k}.tip` as const)}>{t(`research.enum.scoreKey.${k}` as const)}{cut.includes(k) && <Badge tone="warning">{t('research.rank.cutoffHit')}</Badge>}</th>
                    <td className="biz-num-text">{weights[k]}</td>
                    <td><ScoreSelect compact label={t(`research.enum.scoreKey.${k}` as const)} value={entry.score} onChange={(v) => edit((x) => ({ ...x, scores: { ...x.scores, [k]: { ...x.scores[k], score: v } } }))} testId={`research-score-${k}-select`} /></td>
                    <td>
                      {state === 'none' && <span className="biz-muted">{t('research.rank.state.none')}</span>}
                      {state === 'unbacked' && <Badge tone="warning">{t('research.rank.state.unbacked')}</Badge>}
                      {state === 'backed' && <Badge tone="success">{t('research.rank.state.backed')}</Badge>}
                    </td>
                    <td>{rel ? <Badge>{t(`research.enum.reliability.${rel}` as const)}</Badge> : <span className="biz-muted">—</span>}</td>
                    <td className="rs-score-table__ids">
                      <IdListField label={t('research.rank.evidence')} prefix="E" value={entry.evidence} known={evidenceIds} onChange={(v) => edit((x) => ({ ...x, scores: { ...x.scores, [k]: { ...x.scores[k], evidence: v } } }))} />
                    </td>
                    <td><input className="biz-cell-input" aria-label={t('research.rank.reason')} value={entry.reason} onChange={(e) => edit((x) => ({ ...x, scores: { ...x.scores, [k]: { ...x.scores[k], reason: e.target.value } } }))} /></td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </Block>
      <WeightsEditor data={data} onSnapshot={onSnapshot} />
    </>
  )
}

/** 重みと足切り（research.yaml。全候補の比べ方に効く）。初期値に戻せる */
function WeightsEditor({ data, onSnapshot }: { data: ResearchData; onSnapshot: (s: ResearchSnapshot) => void }) {
  const t = useT()
  const api = useResearchApi()
  const toast = useToast()
  const saved = { weights: normalizeWeights(data.research.weights), cutoffs: data.research.cutoffs }
  const toText = (s: typeof saved) => ({
    weights: Object.fromEntries(SCORE_KEYS.map((k) => [k, String(s.weights[k])])) as Record<ScoreKey, string>,
    cutoffs: Object.fromEntries(SCORE_KEYS.map((k) => [k, s.cutoffs[k] === null || s.cutoffs[k] === undefined ? '' : String(s.cutoffs[k])])) as Record<ScoreKey, string>
  })
  const [text, setText] = useState(() => toText(saved))
  const [busy, setBusy] = useState(false)
  const savedKey = JSON.stringify(saved)
  // biome-ignore lint/correctness/useExhaustiveDependencies: savedKey は保存済みの値が変わった合図
  useEffect(() => { setText(toText(saved)) }, [savedKey])
  const parsedW = SCORE_KEYS.map((k) => [k, parseWeight(text.weights[k])] as const)
  const parsedC = SCORE_KEYS.map((k) => [k, parseCutoff(text.cutoffs[k])] as const)
  const ok = parsedW.every(([, r]) => r.ok) && parsedC.every(([, r]) => r.ok)
  const weights = Object.fromEntries(parsedW.map(([k, r]) => [k, r.ok ? r.value : 0])) as Record<ScoreKey, number>
  const cutoffs = Object.fromEntries(parsedC.map(([k, r]) => [k, r.ok ? r.value : null])) as Record<ScoreKey, number | null>
  const total = weightsTotal(weights)
  const changed = !sameJson({ weights, cutoffs }, saved)
  const isDefault = sameJson({ weights: saved.weights, cutoffs: saved.cutoffs }, { weights: DEFAULT_WEIGHTS, cutoffs: DEFAULT_CUTOFFS })
  const save = async (patch: { weights: Record<ScoreKey, number>; cutoffs: Record<ScoreKey, number | null> }) => {
    setBusy(true)
    try {
      onSnapshot(await api.invoke('research:updateResearch', patch))
      toast({ tone: 'success', message: t('research.ws.saved') })
    } catch (err) {
      toast({ tone: 'danger', message: t('research.ws.saveFailed'), detail: errorMessage(err) })
    } finally {
      setBusy(false)
    }
  }
  return (
    <Block
      title={t('research.rank.weights')}
      note={t('research.rank.weightsNote')}
      testId="research-weights"
      actions={
        <>
          <Button variant="ghost" icon={<RotateCcw size={13} />} disabled={isDefault && !changed} busy={busy} onClick={() => void save({ weights: { ...DEFAULT_WEIGHTS }, cutoffs: { ...DEFAULT_CUTOFFS } })} data-testid="research-weights-reset">{t('research.rank.resetWeights')}</Button>
          <Button disabled={!ok || !changed || total <= 0} busy={busy} onClick={() => void save({ weights, cutoffs })} data-testid="research-weights-save">{t('research.ws.save')}</Button>
        </>
      }
    >
      <table className="biz-table rs-weights">
        <thead><tr><th>{t('research.rank.item')}</th><th>{t('research.rank.weight')}</th><th>{t('research.rank.cutoff')}</th><th className="biz-col-grow" /></tr></thead>
        <tbody>
          {SCORE_KEYS.map((k, i) => {
            const w = parsedW[i]![1]
            const cu = parsedC[i]![1]
            return (
              <tr key={k}>
                <th>{t(`research.enum.scoreKey.${k}` as const)}</th>
                <td>
                  <input className={`biz-cell-input rs-num-cell${w.ok ? '' : ' is-invalid'}`} inputMode="numeric" aria-label={t('research.rank.weightOf', { item: t(`research.enum.scoreKey.${k}` as const) })} value={text.weights[k]} onChange={(e) => setText({ ...text, weights: { ...text.weights, [k]: e.target.value } })} data-testid={`research-weight-${k}`} />
                  {!w.ok && <span className="biz-issue biz-issue--error rs-cell-note">{t(`research.ws.input.${w.error}` as const)}</span>}
                </td>
                <td>
                  <input className={`biz-cell-input rs-num-cell${cu.ok ? '' : ' is-invalid'}`} inputMode="numeric" placeholder={t('research.rank.noCutoffShort')} aria-label={t('research.rank.cutoffOf', { item: t(`research.enum.scoreKey.${k}` as const) })} value={text.cutoffs[k]} onChange={(e) => setText({ ...text, cutoffs: { ...text.cutoffs, [k]: e.target.value } })} data-testid={`research-cutoff-${k}`} />
                  {!cu.ok && <span className="biz-issue biz-issue--error rs-cell-note">{t('research.rank.cutoffRange')}</span>}
                </td>
                <td />
              </tr>
            )
          })}
        </tbody>
      </table>
      <p className={`biz-issue biz-issue--${total === 100 ? 'ok' : 'warning'}`} data-testid="research-weights-total">{t('research.rank.weightsTotal', { total })}</p>
    </Block>
  )
}

/** How（価格・限界利益率・継続月数の仮定・CAC）と、CAC・LTV の感度分析・回収期間 */
function HowBlock({ c, edit, data }: { c: Candidate; edit: EditCandidate; data: ResearchData }) {
  const t = useT()
  const how = c.how
  const set = (patch: Partial<typeof how>) => edit((x) => ({ ...x, how: { ...x.how, ...patch } }))
  const [scenarioText, setScenarioText] = useState(how.retentionScenarios.join(', '))
  const parsed = parseScenarios(scenarioText)
  const joined = how.retentionScenarios.join(', ')
  useEffect(() => {
    if (parseScenarios(scenarioText).value.join(', ') !== joined) setScenarioText(joined)
    // biome-ignore lint/correctness/useExhaustiveDependencies: 保存済みの値が変わったときだけ合わせる
  }, [joined])
  const experiments = data.experiments.filter((x) => x.candidate === c.id)
  const cacv = effectiveCac(how, experiments)
  const rows = ltvSensitivity(how, cacv.value)
  const payback = paybackMonths(cacv.value, how.monthlyPrice, how.marginRate)
  const mid = rows.length ? Math.floor((rows.length - 1) / 2) : -1
  return (
    <Block title={t('research.how.title')} note={t('research.how.note')} testId="research-how">
      <div className="biz-form">
        <NumField label={t('research.how.monthlyPrice')} kind="yen" value={how.monthlyPrice} onChange={(v) => set({ monthlyPrice: v })} testId="research-how-price" />
        <NumField label={t('research.how.marginRate')} kind="rate" value={how.marginRate} onChange={(v) => set({ marginRate: v })} testId="research-how-margin" />
        <Txt
          label={t('research.how.scenarios')}
          value={scenarioText}
          placeholder="6, 12, 24, 36"
          issues={parsed.invalid.length ? [{ severity: 'error', ref: '', field: '', message: t('research.how.badScenarios', { items: parsed.invalid.join(', ') }) }] : []}
          onChange={(v) => {
            setScenarioText(v)
            set({ retentionScenarios: parseScenarios(v).value })
          }}
          testId="research-how-scenarios"
        />
        <NumField label={t('research.how.estimatedCac')} kind="yen" value={how.estimatedCac} onChange={(v) => set({ estimatedCac: v })} />
        <Txt label={t('research.how.cacBasis')} placeholder={t('research.how.cacBasisPlaceholder')} value={how.cacBasis} onChange={(v) => set({ cacBasis: v })} rows={2} />
        <Txt label={t('research.how.automation')} tip={t('research.how.automationTip')} value={how.automation} onChange={(v) => set({ automation: v })} rows={2} />
      </div>
      <dl className="rs-kv" data-testid="research-how-cac">
        <div><dt>{t('research.how.cac')}</dt><dd className="biz-num-text">{formatYen(cacv.value)} <Badge tone={cacv.source === 'measured' ? 'success' : cacv.source === 'estimated' ? 'warning' : 'neutral'}>{t(`research.enum.cacSource.${cacv.source}` as const)}</Badge></dd></div>
        <div><dt>{t('research.how.payback')}</dt><dd className="biz-num-text">{payback === null ? '—' : t('research.how.months', { n: formatMonths(payback) })}</dd></div>
      </dl>
      <h4 className="rs-subhead">{t('research.how.sensitivity')}</h4>
      {rows.length === 0 ? <p className="biz-muted">{t('research.how.noScenarios')}</p> : (
        <table className="biz-table rs-sensitivity" data-testid="research-how-sensitivity">
          <thead><tr><th>{t('research.how.retention')}</th><th>LTV</th><th>LTV / CAC</th><th>{t('research.how.payback')}</th><th>{t('research.how.viable')}</th></tr></thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={r.months} className={i === mid ? 'is-mid' : undefined} data-viable={String(r.viable)}>
                <th>{t('research.how.months', { n: r.months })}{i === mid && <Badge>{t('research.how.middle')}</Badge>}</th>
                <td className="biz-num-text">{formatYen(r.ltv)}</td>
                <td className="biz-num-text">{formatRatio(r.ratio)}</td>
                <td className="biz-num-text">{r.paybackMonths === null ? '—' : t('research.how.months', { n: formatMonths(r.paybackMonths) })}</td>
                <td>{r.viable === null ? <span className="biz-muted">—</span> : <Badge tone={r.viable ? 'success' : 'danger'}>{r.viable ? t('research.how.viableYes') : t('research.how.viableNo')}</Badge>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p className="biz-muted rs-hint">{t('research.how.sensitivityNote')}</p>
    </Block>
  )
}

/**
 * 無料から有料へのつながり（集める相手と払う相手をつなげる）。同じ期間に獲得した企業群で、有料化率ごとの期待限界利益と損益分岐の率を出す。
 * 無料登録者数だけでは採算を判断できない（確かめるのは有料化率・取引の利益・成約しない利用者も含めた費用）
 */
function MonetizationBlock({ c, edit }: { c: Candidate; edit: EditCandidate }) {
  const t = useT()
  const m = c.monetization
  const set = (patch: Partial<typeof m>) => edit((x) => ({ ...x, monetization: { ...x.monetization, ...patch } }))
  const [rateText, setRateText] = useState(scenariosToInput(m.conversionScenarios))
  const parsed = parseConversionScenarios(rateText)
  const joined = m.conversionScenarios.join(',')
  useEffect(() => {
    if (parseConversionScenarios(rateText).value.join(',') !== joined) setRateText(scenariosToInput(m.conversionScenarios))
    // biome-ignore lint/correctness/useExhaustiveDependencies: 保存済みの値が変わったときだけ合わせる
  }, [joined])
  const rows = monetizationTable(m)
  const be = breakEvenRate(m)
  return (
    <Block title={t('research.money.title')} note={t('research.money.note')} testId="research-monetization">
      <div className="biz-form">
        <EnumSelect label={t('research.money.side')} tip={t('research.money.sideTip')} value={m.side} options={MONETIZATION_SIDES} labelOf={(v) => t(`research.enum.side.${v}` as const)} onChange={(v) => v && set({ side: v })} testId="research-money-side" />
        <EnumSelect label={t('research.money.orderScene')} tip={t('research.money.orderSceneTip')} value={m.orderScene} options={ORDER_SCENES} labelOf={(v) => t(`research.enum.orderScene.${v}` as const)} onChange={(v) => v && set({ orderScene: v })} testId="research-money-scene" />
        <Txt label={t('research.money.path')} placeholder={t('research.money.pathPlaceholder')} value={m.freeToPaidPath} onChange={(v) => set({ freeToPaidPath: v })} rows={2} testId="research-money-path" />
        <NumField label={t('research.money.months')} kind="months" value={m.months} onChange={(v) => set({ months: v })} testId="research-money-months" />
        <NumField label={t('research.money.marginPerDeal')} kind="yen" value={m.marginPerDeal} onChange={(v) => set({ marginPerDeal: v })} testId="research-money-margin" />
        <NumField label={t('research.money.costPerFreeUser')} tip={t('research.money.costTip')} kind="yen" value={m.costPerFreeUser} onChange={(v) => set({ costPerFreeUser: v })} testId="research-money-cost" />
        <Txt
          label={t('research.money.rates')}
          value={rateText}
          placeholder="0.5, 2, 5"
          issues={parsed.invalid.length ? [{ severity: 'error', ref: '', field: '', message: t('research.money.badRates', { items: parsed.invalid.join(', ') }) }] : []}
          onChange={(v) => {
            setRateText(v)
            set({ conversionScenarios: parseConversionScenarios(v).value })
          }}
          testId="research-money-rates"
        />
      </div>
      {rows.length === 0 ? <p className="biz-muted">{t('research.money.noRates')}</p> : (
        <table className="biz-table rs-money-table" data-testid="research-money-table">
          <thead><tr><th>{t('research.money.rate')}</th><th>{t('research.money.expected')}</th><th>{t('research.money.net')}</th><th /></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.rate} data-net={r.net === null ? 'unknown' : r.net > 0 ? 'plus' : r.net < 0 ? 'minus' : 'zero'}>
                <th className="biz-num-text">{formatPercent(r.rate)}</th>
                <td className="biz-num-text">{formatYen(r.expected)}</td>
                <td className={`biz-num-text${r.net !== null && r.net < 0 ? ' biz-text-danger' : ''}`}>{r.net !== null && r.net > 0 ? '+' : ''}{formatYen(r.net)}</td>
                <td>{r.breakEven && <Badge>{t('research.money.breakEvenRow')}</Badge>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p className="rs-formula" data-testid="research-money-breakeven">
        <span className="biz-muted">{t('research.money.breakEven')}</span>{' '}
        <strong className="biz-num-text">{be.rate === null ? '—' : formatPercent(be.rate)}</strong>{' '}
        {be.reachable === false && <Badge tone="danger">{t('research.money.unreachable')}</Badge>}
      </p>
      <p className="biz-muted rs-hint">{t('research.money.caution')}</p>
    </Block>
  )
}
