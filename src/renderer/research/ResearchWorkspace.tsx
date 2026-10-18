import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ChevronsLeft, FolderPlus, Save, Settings2, Undo2 } from 'lucide-react'
import { SECTION_GATES, SECTION_PRINCIPLES, nextResearchId, type Candidate, type ResearchSection } from '@shared/research/model'
import type { ResearchIssue, ResearchSnapshot } from '@shared/research/ipc'
import { emptyCandidate } from '@shared/research/records'
import { principleStatus } from '@shared/research/principles'
import { errorMessage } from '../lib/errors'
import { useT } from '../lib/i18n'
import { Badge, Button, EmptyState, IconButton, useToast } from '../ui'
import { ResearchApiProvider, createWindowResearchApi, useResearchApi, type ResearchApi } from './api'
import { useResearch } from './useResearch'
import { AgentPanel } from './AgentPanel'
import { CandidateList, FlowFunnel } from './Overview'
import { EvidenceLedger } from './EvidenceLedger'
import { ExperimentSection } from './ExperimentSection'
import { GatePanel } from './GatePanel'
import { NewCandidateModal, PromoteModal, SettingsModal, StageModal, UnsavedModal } from './Modals'
import { RankingSection } from './RankingSection'
import { OverviewForm, PrincipleChecks, SectionGuide, WhatForm, WhereForm, WhoForm, WhyForm, type EditCandidate } from './Sections'
import { Block, toFieldIssues } from './fields'
import { ConditionsTable, DecisionPanel, SceneBlock } from './Evaluation'
import { ExecutionList } from './ExecutionList'
import { FLOW_SECTIONS, WORKSPACE_TABS, candidateDirty, mergeCandidateDraft, promptsForTab, sectionNumber, type FlowStep, type WorkspaceTab } from './view'
import '../styles/business.css'
import '../styles/research.css'

/** ビジネスリサーチの画面。projectKey が変わったら読み直す。onOpenProject は「プロジェクトにする」の後に開く */
export function ResearchWorkspace(props: { projectKey: string | null; onOpenProject: (id: string) => void; api?: ResearchApi; now?: () => Date }) {
  const api = useMemo(() => props.api ?? createWindowResearchApi(), [props.api])
  return (
    <ResearchApiProvider value={api}>
      <ResearchRoot api={api} projectKey={props.projectKey} onOpenProject={props.onOpenProject} now={props.now ?? (() => new Date())} />
    </ResearchApiProvider>
  )
}

function ResearchRoot({ api, projectKey, onOpenProject, now }: { api: ResearchApi; projectKey: string | null; onOpenProject: (id: string) => void; now: () => Date }) {
  const t = useT()
  const state = useResearch(api, projectKey)
  if (state.status === null) return <div className="biz rs" data-testid="research-loading" aria-busy="true" />
  if (!state.status.isResearch || !state.snapshot) {
    if (state.error) {
      return (
        <div className="biz rs biz--center" data-testid="research-error">
          <EmptyState title={t('research.ws.cannotOpen')} description={state.error} actions={<Button onClick={() => void state.reload()}>{t('research.ws.reload')}</Button>} />
        </div>
      )
    }
    if (state.status.isResearch) return <div className="biz rs" data-testid="research-loading" aria-busy="true" />
    return <InitResearch hasProject={state.status.root !== null} onDone={state.setSnapshot} />
  }
  return <ResearchWorkspaceBody snapshot={state.snapshot} setSnapshot={state.setSnapshot} loadError={state.error} onOpenProject={onOpenProject} now={now} />
}

/** research.yaml が無いフォルダ: 名前と対象範囲を決めて始める */
function InitResearch({ hasProject, onDone }: { hasProject: boolean; onDone: (s: ResearchSnapshot) => void }) {
  const t = useT()
  const api = useResearchApi()
  const [name, setName] = useState('')
  const [scope, setScope] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const nameRef = useRef<HTMLInputElement>(null)
  useEffect(() => { if (hasProject) nameRef.current?.focus() }, [hasProject])
  if (!hasProject) return <div className="biz rs biz--center" data-testid="research-noproject"><EmptyState title={t('research.init.noProject')} /></div>
  const submit = async () => {
    setBusy(true)
    setError(null)
    try {
      onDone(await api.invoke('research:init', { name: name.trim(), scope: scope.trim() }))
    } catch (err) {
      setError(errorMessage(err) || t('research.init.failed'))
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="biz rs biz--center" data-testid="research-init">
      <form className="biz-init rs-init" onSubmit={(e) => { e.preventDefault(); if (name.trim()) void submit() }}>
        <h2 className="biz-init__title">{t('research.init.title')}</h2>
        <p className="biz-muted">{t('research.init.lead')}</p>
        <label className="biz-modal__label" htmlFor="rs-init-name">{t('research.init.name')}</label>
        <div className="field"><input id="rs-init-name" className="field__input" value={name} onChange={(e) => setName(e.target.value)} ref={nameRef} placeholder={t('research.init.namePlaceholder')} data-testid="research-init-name" /></div>
        <label className="biz-modal__label" htmlFor="rs-init-scope">{t('research.init.scope')}</label>
        <textarea id="rs-init-scope" className="biz-textarea" rows={3} value={scope} onChange={(e) => setScope(e.target.value)} placeholder={t('research.init.scopePlaceholder')} data-testid="research-init-scope" />
        <ol className="rs-init__steps">
          {(['1', '2', '3'] as const).map((n) => <li key={n}>{t(`research.init.step${n}` as const)}</li>)}
        </ol>
        {error && <p className="biz-issue biz-issue--error" role="alert">{error}</p>}
        <div className="biz-init__actions">
          <Button variant="primary" disabled={!name.trim()} busy={busy} onClick={() => void submit()} data-testid="research-init-submit">{t('research.init.submit')}</Button>
        </div>
      </form>
    </div>
  )
}

type ModalState = null | { kind: 'new' } | { kind: 'stage' } | { kind: 'promote' } | { kind: 'settings' } | { kind: 'unsaved'; next: () => void }

/**
 * 読み込んだ後の画面（ResearchApiProvider の中で使う）。
 * initialTab・initialCandidateId は高速 E2E・スクリーンショットのハーネスが最初の表示を選ぶためのもの
 */
export function ResearchWorkspaceBody({ snapshot, setSnapshot, loadError, onOpenProject, now, initialTab = 'overview', initialCandidateId = null }: {
  snapshot: ResearchSnapshot
  setSnapshot: (s: ResearchSnapshot) => void
  loadError: string | null
  onOpenProject: (id: string) => void
  now: () => Date
  initialTab?: WorkspaceTab
  initialCandidateId?: string | null
}) {
  const t = useT()
  const api = useResearchApi()
  const toast = useToast()
  const data = snapshot.data
  const [tab, setTab] = useState<WorkspaceTab>(initialTab)
  const [selectedId, setSelectedId] = useState<string | null>(initialCandidateId)
  const [draft, setDraft] = useState<Candidate | null>(null)
  const [issues, setIssues] = useState<ResearchIssue[]>([])
  const [saving, setSaving] = useState(false)
  const [panelOpen, setPanelOpen] = useState(true)
  const [modal, setModal] = useState<ModalState>(null)

  const base = data.candidates.find((c) => c.id === selectedId) ?? null
  // 選んだ候補が消えた（Agent が消した・ゴミ箱へ移した）ら選びを外す
  useEffect(() => {
    if (selectedId && !base) { setSelectedId(null); setDraft(null) }
  }, [selectedId, base])
  const current = base && draft && draft.id === base.id ? mergeCandidateDraft(base, draft) : base
  const dirty = candidateDirty(base, draft && draft.id === base?.id ? draft : null)

  const edit: EditCandidate = useCallback((fn) => {
    setDraft((d) => {
      const b = data.candidates.find((c) => c.id === selectedId)
      if (!b) return d
      return fn(d && d.id === b.id ? d : b)
    })
  }, [data.candidates, selectedId])

  const guarded = (action: () => void) => {
    if (dirty) setModal({ kind: 'unsaved', next: action })
    else action()
  }

  const select = (id: string | null) => guarded(() => { setSelectedId(id); setDraft(null); setIssues([]) })

  const save = async (): Promise<boolean> => {
    if (!base || !current) return false
    setSaving(true)
    try {
      const res = await api.invoke('research:saveRecord', 'candidate', mergeCandidateDraft(base, current), null)
      setIssues(res.issues)
      if (!res.ok) {
        toast({ tone: 'danger', message: t('research.ws.notSavedIssues') })
        return false
      }
      setSnapshot(res.snapshot)
      setDraft(null)
      toast({ tone: res.issues.length ? 'warning' : 'success', message: res.issues.length ? t('research.ws.savedWithWarnings') : t('research.ws.saved') })
      return true
    } catch (err) {
      toast({ tone: 'danger', message: t('research.ws.saveFailed'), detail: errorMessage(err) })
      return false
    } finally {
      setSaving(false)
    }
  }

  const createCandidate = async (input: { title: string; market: string; problem: string; customer: string }) => {
    const id = nextResearchId('candidate', data.candidates.map((c) => c.id))
    const record = { ...emptyCandidate(id, now().toISOString()), ...input }
    try {
      const res = await api.invoke('research:saveRecord', 'candidate', record, null)
      if (!res.ok) {
        toast({ tone: 'danger', message: t('research.ws.notSavedIssues'), detail: toFieldIssues(t, res.issues).map((i) => i.message).join(' / ') })
        return false
      }
      setSnapshot(res.snapshot)
      setSelectedId(id)
      setDraft(null)
      setIssues(res.issues)
      toast({ tone: 'success', message: t('research.newCandidate.created', { id }) })
      return true
    } catch (err) {
      toast({ tone: 'danger', message: t('research.ws.saveFailed'), detail: errorMessage(err) })
      return false
    }
  }

  const pickFlow = (step: FlowStep) => setTab(FLOW_SECTIONS[step][0] ?? 'overview')

  const status = current ? principleStatus(current, data) : null
  const section = tab !== 'overview' && tab !== 'evidence' ? (tab as ResearchSection) : null
  const prompts = promptsForTab(tab)

  const renderSection = () => {
    if (tab === 'evidence') return <EvidenceLedger data={data} candidateId={current?.id ?? null} onSnapshot={setSnapshot} now={now} />
    if (tab === 'overview') {
      return (
        <>
          {current && <DecisionPanel c={current} edit={edit} data={data} />}
          <CandidateList data={data} selectedId={selectedId} onSelect={(id) => select(id === selectedId ? null : id)} onNew={() => setModal({ kind: 'new' })} />
          {current && (
            <>
              <SceneBlock c={current} edit={edit} full />
              <ConditionsTable c={current} edit={edit} data={data} />
              <Block title={t('research.overview.candidate', { id: current.id })} testId="research-overview">
                <OverviewForm c={current} edit={edit} />
              </Block>
            </>
          )}
        </>
      )
    }
    if (!current || !status || !section) {
      return <EmptyState size="sm" title={t('research.ws.pickCandidate')} description={t('research.ws.pickCandidateHint')} actions={<Button onClick={() => setTab('overview')}>{t('research.ws.toList')}</Button>} testId="research-pick-candidate" />
    }
    const gates = SECTION_GATES[section]
    return (
      <>
        <SceneBlock c={current} edit={edit} full={false} />
        <SectionGuide section={section} />
        {section === 'ranking' && <ConditionsTable c={current} edit={edit} data={data} />}
        {section === 'who' && <WhoForm c={current} edit={edit} data={data} />}
        {section === 'what' && <WhatForm c={current} edit={edit} data={data} />}
        {section === 'where' && <WhereForm c={current} edit={edit} />}
        {section === 'why' && <WhyForm c={current} edit={edit} data={data} />}
        {section === 'ranking' && <RankingSection c={current} edit={edit} data={data} onSnapshot={setSnapshot} />}
        {section === 'experiment' && <ExperimentSection c={current} data={data} onSnapshot={setSnapshot} />}
        {section === 'experiment' && (
          <Block title={t('research.exec.title')} note={t('research.exec.note')} testId="research-execution-block">
            <ExecutionList value={current.execution} onChange={(k, item) => edit((x) => ({ ...x, execution: { ...x.execution, [k]: item } }))} testId="research-execution" />
          </Block>
        )}
        <Block title={t('research.ws.checks')} note={t('research.ws.checksNote')} testId="research-section-checks">
          {SECTION_PRINCIPLES[section].map((p) => (
            <div key={p} className="rs-principle">
              {SECTION_PRINCIPLES[section].length > 1 && <h4 className="rs-subhead">{t(`research.enum.principle.${p}` as const)}</h4>}
              <PrincipleChecks principle={p} status={status[p]} />
            </div>
          ))}
        </Block>
        {gates.length > 0 && (
          <Block title={t('research.ws.gates')} note={t('research.ws.gatesNote')} testId="research-section-gates">
            <GatePanel candidate={base!} data={data} gates={gates} dirty={dirty} onSnapshot={setSnapshot} testId={`research-gates-${section}`} />
          </Block>
        )}
        {section === 'why' && <PromoteCallout candidate={base!} onPromote={() => setModal({ kind: 'promote' })} note={t('research.why.promoteNote')} />}
        {section === 'experiment' && <PromoteCallout candidate={base!} onPromote={() => setModal({ kind: 'promote' })} note={t('research.exp.promoteNote')} />}
      </>
    )
  }

  return (
    <div className={`biz rs${panelOpen ? '' : ' biz--panel-closed'}`} data-testid="research-workspace">
      <div className="biz-body">
        <main className="biz-main" aria-label={t('research.ws.label')}>
          <header className="rs-head" data-testid="research-head">
            <div className="rs-head__title">
              <h2 className="biz-h2" title={data.research.name}>{data.research.name}</h2>
              <span className="biz-muted biz-ellipsis" title={data.research.scope}>{data.research.scope || t('research.ws.noScope')}</span>
            </div>
            <span className="biz-spacer" />
            <IconButton size="sm" label={t('research.settings.title')} icon={<Settings2 size={14} />} onClick={() => setModal({ kind: 'settings' })} data-testid="research-settings-open" />
            {!panelOpen && <IconButton size="sm" label={t('research.agent.open')} icon={<ChevronsLeft size={14} />} onClick={() => setPanelOpen(true)} data-testid="research-agent-open" />}
          </header>
          <FlowFunnel data={data} selected={current} onPickStep={pickFlow} />
          {data.problems.length > 0 && (
            <div className="biz-notice rs-problems" role="status" data-testid="research-problems">
              <span>{t('research.ws.problems', { n: data.problems.length })}</span>
              <ul>{data.problems.slice(0, 5).map((p, i) => <li key={`${i}:${p.path}`}><span className="biz-mono">{p.path}</span> {p.message}</li>)}</ul>
            </div>
          )}
          {loadError && <div className="biz-notice" role="status"><span>{loadError}</span></div>}
          <div className="rs-candidate-bar" data-testid="research-candidate-bar">
            <label className="biz-muted" htmlFor="rs-candidate-select">{t('research.ws.candidate')}</label>
            <select id="rs-candidate-select" className="biz-select" value={selectedId ?? ''} onChange={(e) => select(e.target.value || null)} data-testid="research-candidate-select">
              <option value="">{t('research.ws.noCandidate')}</option>
              {data.candidates.map((c) => <option key={c.id} value={c.id}>{c.id} {c.title}</option>)}
            </select>
            {base && (
              <>
                <Badge tone={base.stage === 'dropped' ? 'danger' : base.stage === 'selected' ? 'success' : 'neutral'}>{t(`research.enum.stage.${base.stage}` as const)}</Badge>
                <Button variant="ghost" onClick={() => setModal({ kind: 'stage' })} data-testid="research-stage-open">{t('research.stage.change')}</Button>
                <Button variant="ghost" icon={<FolderPlus size={13} />} onClick={() => setModal({ kind: 'promote' })} data-testid="research-promote-open">{base.promotedTo ? t('research.promote.promoted') : t('research.promote.open')}</Button>
              </>
            )}
            <span className="biz-spacer" />
            {dirty && (
              <span className="rs-savebar" data-testid="research-savebar">
                <Badge tone="warning">{t('research.ws.unsaved')}</Badge>
                <Button variant="ghost" icon={<Undo2 size={13} />} onClick={() => { setDraft(null); setIssues([]) }} data-testid="research-discard">{t('research.ws.discard')}</Button>
                <Button variant="primary" icon={<Save size={13} />} busy={saving} onClick={() => void save()} data-testid="research-save">{t('research.ws.save')}</Button>
              </span>
            )}
          </div>
          {issues.length > 0 && (
            <ul className="biz-issues rs-issues" data-testid="research-issues">
              {toFieldIssues(t, issues).map((i) => <li key={`${i.field}:${i.message}`} className={`biz-issue biz-issue--${i.severity}`}><span className="biz-mono">{i.field}</span> {i.message}</li>)}
            </ul>
          )}
          <div className="biz-nav rs-nav" role="tablist" aria-label={t('research.ws.sections')}>
            {WORKSPACE_TABS.map((x) => {
              const n = sectionNumber(x)
              return (
                <button key={x} type="button" role="tab" aria-selected={tab === x} className="biz-nav__item" onClick={() => setTab(x)} data-testid={`research-tab-${x}`}>
                  {n !== null && <span className="rs-nav__num biz-mono">{n}</span>}
                  <span>{t(`research.tab.${x}` as const)}</span>
                </button>
              )
            })}
          </div>
          <div className="biz-content rs-content" data-testid={`research-section-${tab}`}>
            {section && <p className="rs-section-lead" data-testid="research-section-lead"><span className="biz-muted">{t(`research.section.${section}.flow` as const)}</span></p>}
            {renderSection()}
          </div>
        </main>
        {panelOpen && (
          <aside className="biz-panel" aria-label={t('research.agent.title')}>
            <AgentPanel prompts={prompts} candidateId={current?.id ?? null} candidateTitle={current?.title ?? null} refreshKey={snapshot} onCollapse={() => setPanelOpen(false)} />
          </aside>
        )}
      </div>

      {modal?.kind === 'new' && <NewCandidateModal onClose={() => setModal(null)} onCreate={createCandidate} />}
      {modal?.kind === 'stage' && base && <StageModal candidate={base} onClose={() => setModal(null)} onSnapshot={setSnapshot} />}
      {modal?.kind === 'promote' && base && <PromoteModal candidate={base} data={data} onClose={() => setModal(null)} onSnapshot={setSnapshot} onOpenProject={onOpenProject} />}
      {modal?.kind === 'settings' && <SettingsModal data={data} onClose={() => setModal(null)} onSnapshot={setSnapshot} />}
      {modal?.kind === 'unsaved' && base && (
        <UnsavedModal
          id={base.id}
          onChoose={async (choice) => {
            const next = modal.next
            if (choice === 'cancel') { setModal(null); return }
            if (choice === 'save' && !(await save())) { setModal(null); return }
            setDraft(null)
            setModal(null)
            next()
          }}
        />
      )}
    </div>
  )
}

function PromoteCallout({ candidate, onPromote, note }: { candidate: Candidate; onPromote: () => void; note: string }) {
  const t = useT()
  return (
    <Block title={t('research.promote.title')} note={note} testId="research-promote-callout">
      {candidate.promotedTo ? (
        <p className="biz-issue biz-issue--ok">{t('research.promote.already', { folder: candidate.promotedTo.folder })}</p>
      ) : (
        <Button icon={<FolderPlus size={13} />} onClick={onPromote} data-testid="research-promote-callout-open">{t('research.promote.open')}</Button>
      )}
    </Block>
  )
}
