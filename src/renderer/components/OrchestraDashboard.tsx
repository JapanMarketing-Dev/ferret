import { Fragment, useCallback, useEffect, useState, type ReactNode } from 'react'
import { BookOpen, ExternalLink, FileText, History, ListChecks, Play, RefreshCw, Send, ShieldCheck, Sparkles, Video } from 'lucide-react'
import type { Project } from '@shared/types'
import { formatUsd, type CostPeriod } from '@shared/extraCost'
import type { OrchestraOverview } from '@shared/orchestraOverview'
import { BUILTIN_SECTIONS, DEFAULT_SECTIONS, type BuiltinSection, type DashboardSection } from '@shared/dashboardLayout'
import { checklistGroups, isChecklistKey, optionAnswer, pageItems } from '@shared/humanChecklist'
import { CODEX_AUDIT_PRESET } from '@shared/codexAudit'
import { requestAgentLaunch } from '../lib/agentLaunchRequest'
import { errorMessage } from '../lib/errors'
import { useT } from '../lib/i18n'
import { useProjectActivity } from '../terminal/agentActivity'
import { Button, useToast } from '../ui'
import { AgentRequestsSection } from './AgentRequestsSection'
import { AllowedOperations, ChecklistAnswer, useOrchestraRules } from './ChecklistAnswer'
import { OrchestraComposer } from './OrchestraComposer'
import { OrchestraCost, forecastUsd, periodUsd } from './OrchestraCost'

/**
 * 全体（すべてのプロダクト）のダッシュボード。オーケストラ全体を見て、まとめて指示する。
 * - 一番上：人が確認すべきこと（全体の Agent が human.md に書いたもの。URL の無い承認・用意・決めることも）。
 *   「Agent に書き出してもらう」で全プロダクトから集めて human.md に書く依頼を送る。開くとフィードバックの画面でそのページを開く。
 *   各項目に番号の選択肢（おすすめ付き）か自由な文で答え（human.md の「## 回答」に書く）、「回答をまとめて Agent に送る」で全部を1回で渡す。
 *   その下に、全体として人の確認なしで進めてよい操作（orchestra.allowed）
 * - 全体の数字（対象のプロダクト・未対応・確認待ち・今月のコスト）と、全体への指示の欄
 * - 全プロダクトを1回の録画でフィードバック（帯のタブでプロダクトを切り替えると、指摘の宛先も切り替わる）・確認の巡回・Codex の監査
 * - Agent への依頼（雛形を選んで送る・まとめて送る・1回きりのものは隠す）
 * - プロジェクトの表：オーケストラの対象・対象外、Agent の動き、未対応・確認待ち、コスト（インフラなどを含む）
 * - フィードバックの記録（feedback/log.md）とプレイブック（feedback/playbook.md）をエディタで開く（@shared/feedbackLog）
 */
export function OrchestraDashboard({ projects, onOpenProject, onOpenUrl, onReviewChecklist, onRecordAll, onStartRound, onOpenFile }: {
  projects: readonly Project[]
  /** オーケストラのフォルダからの相対パスのファイルをエディタで開く */
  onOpenFile?: (path: string) => void
  onOpenProject: (projectId: string) => void
  /** フィードバックの画面でそのページを開く（録画中なら録画を止めずに移る） */
  onOpenUrl: (url: string) => void
  /** 確認リストを上から順に開きながら、1回の録画でフィードバックする */
  onReviewChecklist: (urls: string[]) => void
  /** 全体のフィードバックの画面で録画を始める（1回の録画で全プロダクト） */
  onRecordAll: () => void
  onStartRound: (kind: 'confirm') => void
}) {
  const t = useT()
  const toast = useToast()
  const activity = useProjectActivity()
  const [overview, setOverview] = useState<OrchestraOverview | null>(null)
  const [loading, setLoading] = useState(false)

  const load = useCallback(() => {
    setLoading(true)
    void window.ade.invoke('orchestra:overview')
      .then(setOverview)
      .catch((err) => toast({ tone: 'warning', message: errorMessage(err) }))
      .finally(() => setLoading(false))
  }, [toast])
  useEffect(() => { load() }, [load, projects])
  useEffect(() => {
    const timer = setInterval(load, 30_000)
    return () => clearInterval(timer)
  }, [load])

  const toggleIncluded = (id: string, included: boolean) => {
    // 押したらすぐ表示を変える（保存に失敗したら読み直して戻す）
    setOverview((prev) => prev && { ...prev, projects: prev.projects.map((r) => (r.id === id ? { ...r, included } : r)) })
    void window.ade.invoke('project:update', { id, orchestraExcluded: !included }).then(load)
      .catch((err) => { toast({ tone: 'warning', message: errorMessage(err) }); load() })
  }

  const rows = overview?.projects ?? []
  const included = rows.filter((r) => r.included)
  const monthCost = periodUsd(overview, 'month')
  const checklist = overview?.checklist ?? []
  const pages = pageItems(checklist)
  const rowUsd = (r: (typeof rows)[number], p: CostPeriod) => r.extra[p].usd
  const [rules, updateRules] = useOrchestraRules()
  const answered = checklist.filter((c) => c.answer).length
  const recommendable = checklist.filter((c) => !c.answer && c.options?.some((o) => o.recommended))
  /** 答えを human.md に書き、書いたあとの確認リストに入れ替える */
  const saveAnswers = useCallback(async (entries: Array<{ key: string; answer: string }>) => {
    try {
      const items = await window.ade.invoke('orchestra:answer', entries)
      setOverview((prev) => prev && { ...prev, checklist: items })
    } catch (err) {
      toast({ tone: 'warning', message: errorMessage(err) })
    }
  }, [toast])
  const fillRecommended = () => void saveAnswers(recommendable.map((c) => ({ key: c.key, answer: optionAnswer(c.options!.find((o) => o.recommended)!) })))
  const [sending, setSending] = useState(false)
  const sendAnswers = () => {
    if (sending) return
    setSending(true)
    void window.ade.invoke('orchestra:sendAnswers')
      .then((result) => toast({ tone: result.ok ? 'success' : 'warning', message: result.message }))
      .catch((err) => toast({ tone: 'warning', message: errorMessage(err) }))
      .finally(() => setSending(false))
  }
  const allowFromItem = (text: string) => {
    if (!rules || !text.trim()) return
    const lines = (rules.allowed ?? '').split('\n').map((l) => l.trim()).filter(Boolean)
    if (!lines.includes(text.trim())) updateRules({ ...rules, allowed: [...lines, text.trim()].join('\n') })
  }
  const [asking, setAsking] = useState(false)
  /** 人が確認すべきことを全プロダクトから集めて human.md に書く依頼（@shared/agentRequests の human-checklist）を送る */
  const askChecklist = () => {
    if (asking) return
    setAsking(true)
    void window.ade.invoke('agentRequests:send', ['human-checklist'])
      .then((result) => toast({ tone: result.ok ? 'success' : 'warning', message: result.ok ? t('orchestra.checklistAsked') : result.message }))
      .catch((err) => toast({ tone: 'warning', message: errorMessage(err) }))
      .finally(() => setAsking(false))
  }

  /** フィードバックの記録・プレイブックを（無ければ作ってから）エディタで開く */
  const openFeedbackFile = (which: 'log' | 'playbook') => {
    void window.ade.invoke('orchestra:feedbackFile', which)
      .then((path) => onOpenFile?.(path))
      .catch((err) => toast({ tone: 'warning', message: errorMessage(err) }))
  }

  const builtin: Record<BuiltinSection, ReactNode> = {
    checklist: <>
    <section className="orchestra__section" data-testid="orchestra-checklist">
      <div className="orchestra__section-head">
        <h3>{t('orchestra.checklistTitle')}</h3>
        <div className="orchestra__section-actions">
          <Button icon={<FileText size={13} />} disabled={asking} title={t('orchestra.checklistAskHint')} onClick={askChecklist} data-testid="orchestra-checklist-ask">{t('orchestra.checklistAsk')}</Button>
          {recommendable.length > 0 && <Button icon={<Sparkles size={13} />} title={t('orchestra.answerFillHint')} onClick={fillRecommended} data-testid="orchestra-answer-fill">{t('orchestra.answerFill', { count: recommendable.length })}</Button>}
          {answered > 0 && <Button variant="primary" icon={<Send size={13} />} disabled={sending} title={t('orchestra.answersSendHint')} onClick={sendAnswers} data-testid="orchestra-answers-send">{t('orchestra.answersSend', { count: answered })}</Button>}
          {pages.length > 0 && <Button variant="primary" icon={<Play size={13} />} onClick={() => onReviewChecklist(pages.map((c) => c.url))} data-testid="orchestra-checklist-review">{t('orchestra.checklistReview', { count: pages.length })}</Button>}
        </div>
      </div>
      {checklist.length === 0
        ? <p className="st-note">{t('orchestra.checklistEmpty')}</p>
        : <table className="orchestra__table">
          <tbody>
            {checklistGroups(checklist).map(({ product, items }) => <Fragment key={`group-${product}`}>
              <tr className="orchestra__group-row" data-testid={`orchestra-check-group-${product || 'none'}`}>
                <th colSpan={4}>{product || t('orchestra.checklistNoProduct')}<span className="orchestra__group-count">{items.filter((c) => c.answer).length}/{items.length}</span></th>
              </tr>
              {items.map((item, i) => <Fragment key={`${item.key}-${i}`}>
              <tr className="orchestra__check-row" data-testid={`orchestra-check-${item.key}`}>
                <td className="orchestra__key">{item.key}</td>
                <td>{item.label}</td>
                <td className="orchestra__note">{item.note}</td>
                <td className="orchestra__cell-actions">
                  {item.url && <button type="button" className="st-link" title={item.url} onClick={() => onOpenUrl(item.url)} data-testid={`orchestra-check-open-${item.key}`}>
                    {t('orchestra.open')}<ExternalLink size={11} aria-hidden="true" />
                  </button>}
                </td>
              </tr>
              {isChecklistKey(item.key) && <tr className={`orchestra__answer-row${item.answer ? ' is-answered' : ''}`}>
                <td />
                <td colSpan={3}><ChecklistAnswer item={item} onSave={(key, answer) => saveAnswers([{ key, answer }])} onAllow={rules ? allowFromItem : undefined} /></td>
              </tr>}
              </Fragment>)}
            </Fragment>)}
          </tbody>
        </table>}
      {rules && <AllowedOperations rules={rules} onChange={updateRules} />}
    </section>
  </>,
    stats: <>
    <div className="orchestra__stats">
      <Stat label={t('orchestra.statProducts')} value={`${included.length}/${rows.length}`} testId="orchestra-stat-products" />
      <Stat label={t('orchestra.statOpen')} value={String(included.reduce((n, r) => n + r.open, 0))} testId="orchestra-stat-open" />
      <Stat label={t('orchestra.statPending')} value={String(included.reduce((n, r) => n + r.pending, 0))} testId="orchestra-stat-pending" />
      <Stat label={t('orchestra.statCostMonth')} value={formatUsd(monthCost)} testId="orchestra-stat-cost" />
      <Stat label={t('orchestra.costForecast')} value={formatUsd(forecastUsd(overview))} testId="orchestra-stat-forecast" />
    </div>
  </>,
    composer: <OrchestraComposer />,
    actions: <>
    <div className="orchestra__actions">
      <Button icon={<Video size={13} />} title={t('orchestra.recordAllHint')} onClick={onRecordAll} data-testid="orchestra-record-all">{t('orchestra.recordAll')}</Button>
      <Button icon={<ListChecks size={13} />} onClick={() => onStartRound('confirm')} data-testid="orchestra-round-confirm">{t('round.startConfirm')}</Button>
      <Button icon={<ShieldCheck size={13} />} title={t('orchestra.codexAuditHint')} onClick={() => requestAgentLaunch('codex', CODEX_AUDIT_PRESET)} data-testid="orchestra-codex-audit">{t('orchestra.codexAudit')}</Button>
      {onOpenFile && <Button variant="ghost" icon={<History size={13} />} title={t('orchestra.feedbackLogHint')} onClick={() => openFeedbackFile('log')} data-testid="orchestra-feedback-log">{t('orchestra.feedbackLog')}</Button>}
      {onOpenFile && <Button variant="ghost" icon={<BookOpen size={13} />} title={t('orchestra.playbookHint')} onClick={() => openFeedbackFile('playbook')} data-testid="orchestra-playbook">{t('orchestra.playbook')}</Button>}
    </div>
  </>,
    requests: <>
    <section className="orchestra__section" data-testid="orchestra-requests">
      <h3>{t('orchestra.requestsTitle')}</h3>
      <AgentRequestsSection />
    </section>
  </>,
    projects: <>
    <section className="orchestra__section" data-testid="orchestra-projects">
      <h3>{t('orchestra.projectsTitle')}</h3>
      {rows.length === 0 ? <p className="st-note">{t('orchestra.noProducts')}</p> : <table className="orchestra__table">
        <thead>
          <tr>
            <th>{t('orchestra.colIncluded')}</th>
            <th>{t('orchestra.colProject')}</th>
            <th>{t('orchestra.colAgent')}</th>
            <th>{t('orchestra.colOpen')}</th>
            <th>{t('orchestra.colPending')}</th>
            <th>{t('orchestra.costMonth')}</th>
            <th>{t('orchestra.costYear')}</th>
            <th>{t('orchestra.costTotal')}</th>
            <th>{t('orchestra.costForecast')}</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const state = activity[r.id]
            return <tr key={r.id} className={r.included ? '' : 'is-excluded'} data-testid={`orchestra-row-${r.id}`}>
              <td><input type="checkbox" checked={r.included} aria-label={t('orchestra.colIncluded')} onChange={(e) => toggleIncluded(r.id, e.target.checked)} data-testid={`orchestra-include-${r.id}`} /></td>
              <td className="orchestra__name">{r.name}</td>
              <td><span className={`orchestra__state orchestra__state--${state ?? 'idle'}`}>{t(state === 'working' ? 'orchestra.stateWorking' : state === 'blocked' ? 'orchestra.stateBlocked' : 'orchestra.stateIdle')}</span></td>
              <td>{r.open}</td>
              <td>{r.pending}</td>
              <td>{formatUsd(rowUsd(r, 'month'))}</td>
              <td>{formatUsd(rowUsd(r, 'year'))}</td>
              <td>{formatUsd(rowUsd(r, 'total'))}</td>
              <td>{formatUsd(r.forecast.usd)}</td>
              <td className="orchestra__cell-actions"><button type="button" className="st-link" onClick={() => onOpenProject(r.id)} data-testid={`orchestra-open-${r.id}`}>{t('orchestra.openProject')}</button></td>
            </tr>
          })}
        </tbody>
      </table>}
    </section>
  </>,
    costs: <OrchestraCost overview={overview} />
  }
  const dashboard = overview?.dashboard
  const sections = dashboard?.sections ?? DEFAULT_SECTIONS

  return <div className="orchestra" data-testid="orchestra-dashboard">
    <header className="orchestra__head">
      <h2 className="orchestra__title">{t('orchestra.dashboardTitle')}</h2>
      <Button variant="ghost" icon={<RefreshCw size={13} />} disabled={loading} onClick={load} data-testid="orchestra-reload">{t('common.reload')}</Button>
    </header>
    {dashboard?.invalid && <p className="st-note st-note--warn" role="alert" data-testid="orchestra-dashboard-invalid">{t('orchestra.dashboardInvalid')}</p>}
    {sections.map((section, i) => <Fragment key={`${section.type}-${i}`}>
      {isBuiltinSection(section) ? builtin[section.type] : <CustomSection section={section} notes={dashboard?.notes ?? {}} />}
    </Fragment>)}
  </div>
}

function Stat({ label, value, testId }: { label: string; value: string; testId: string }) {
  return <div className="orchestra__stat" data-testid={testId}>
    <span className="orchestra__stat-value">{value}</span>
    <span className="orchestra__stat-label">{label}</span>
  </div>
}

function isBuiltinSection(section: DashboardSection): section is Extract<DashboardSection, { type: BuiltinSection }> {
  return (BUILTIN_SECTIONS as readonly string[]).includes(section.type)
}

/** .ferret/dashboard.json に書いた自由な部品。中身は文字として出す（HTML にしない） */
function CustomSection({ section, notes }: { section: Exclude<DashboardSection, { type: BuiltinSection }>; notes: Record<string, string | null> }) {
  const t = useT()
  const toast = useToast()
  const head = section.title ? <h3>{section.title}</h3> : null
  if (section.type === 'metrics') return <section className="orchestra__section" data-testid="orchestra-custom-metrics">
    {head}
    <div className="orchestra__stats">
      {section.items.map((m, i) => <div key={`${m.label}-${i}`} className="orchestra__stat" title={m.hint}>
        <span className="orchestra__stat-value">{m.value}</span>
        <span className="orchestra__stat-label">{m.label}</span>
        {m.hint && <span className="orchestra__stat-hint">{m.hint}</span>}
      </div>)}
    </div>
  </section>
  if (section.type === 'note') {
    const text = notes[section.file]
    return <section className="orchestra__section" data-testid="orchestra-custom-note">
      {head}
      {text == null ? <p className="st-note st-note--warn">{t('orchestra.dashboardNoteMissing', { file: section.file })}</p> : <pre className="orchestra__note-text">{text}</pre>}
    </section>
  }
  if (section.type === 'links') return <section className="orchestra__section" data-testid="orchestra-custom-links">
    {head}
    <ul className="orchestra__links">
      {section.items.map((l, i) => <li key={`${l.url}-${i}`}>
        <button type="button" className="st-link" title={l.url} onClick={() => void window.ade.invoke('app:openExternal', l.url).catch((err: unknown) => toast({ tone: 'warning', message: errorMessage(err) }))}>
          {l.label}<ExternalLink size={11} aria-hidden="true" />
        </button>
      </li>)}
    </ul>
  </section>
  return <section className="orchestra__section" data-testid="orchestra-custom-table">
    {head}
    <table className="orchestra__table">
      <thead><tr>{section.columns.map((c, i) => <th key={i}>{c}</th>)}</tr></thead>
      <tbody>{section.rows.map((r, i) => <tr key={i}>{r.map((cell, j) => <td key={j}>{cell}</td>)}</tr>)}</tbody>
    </table>
  </section>
}
