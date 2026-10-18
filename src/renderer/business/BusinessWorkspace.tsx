import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ChevronsLeft, TrendingUp } from 'lucide-react'
import { nextId, type RecordKind, type RecordTypes, type Stage, type StepId } from '@shared/business/model'
import { emptyRecord } from '@shared/business/records'
import type { BusinessSnapshot } from '@shared/business/ipc'
import { Badge, Button, CountBadge, EmptyState, IconButton, useToast } from '../ui'
import { BusinessApiProvider, useBusinessApi, type BusinessApi } from './api'
import { useBusiness } from './useBusiness'
import { Dashboard } from './Dashboard'
import { RecordList } from './lists'
import { RecordEditor, type EditorGuard } from './RecordEditor'
import { AlternativeForm, DecisionForm, EvidenceForm, ExperimentForm, HypothesisForm, InterviewForm } from './forms'
import { ExperimentPage } from './ExperimentPage'
import { Approvals, SentHistory } from './Approvals'
import { StepPanel } from './StepPanel'
import { NextSteps } from './NextSteps'
import { AdvanceStageModal, CloseLoopModal, UnsavedModal } from './modals'
import { errorText, nextStage, recordsOf } from './view'
import '../styles/business.css'

export type BusinessView = 'dashboard' | Exclude<RecordKind, 'approval'> | 'approval' | 'history'
type EditableKind = Exclude<RecordKind, 'approval'>

const NAV: ReadonlyArray<{ view: BusinessView; label: string }> = [
  { view: 'dashboard', label: 'ダッシュボード' },
  { view: 'hypothesis', label: '仮説' },
  { view: 'evidence', label: '証拠' },
  { view: 'alternative', label: '代替' },
  { view: 'interview', label: '聞き取り' },
  { view: 'experiment', label: '実験' },
  { view: 'decision', label: '結論' },
  { view: 'approval', label: '承認' },
  { view: 'history', label: '履歴' }
]

function isEditable(view: BusinessView): view is EditableKind {
  return view !== 'dashboard' && view !== 'approval' && view !== 'history'
}

/**
 * 中央の「ビジネス」タブ。本文（ローカルのナビと中身）＋右のステップパネルの2列。
 * ビジネスでないプロジェクトでは「ビジネスを始める」を出す。
 */
export function BusinessWorkspace(props: {
  api: BusinessApi
  /** プロジェクトが変わったら読み直す */
  projectKey?: string | null
  initialView?: BusinessView
  panelOpenInitial?: boolean
}) {
  return (
    <BusinessApiProvider value={props.api}>
      <BusinessRoot {...props} />
    </BusinessApiProvider>
  )
}

function BusinessRoot({ api, projectKey = null, initialView = 'dashboard', panelOpenInitial = true }: {
  api: BusinessApi
  projectKey?: string | null
  initialView?: BusinessView
  panelOpenInitial?: boolean
}) {
  const state = useBusiness(api, projectKey)
  if (state.status === null) {
    // 最初の1回だけ。枠は出しておき、中身を一度にそろえて出す
    return <div className="biz" data-testid="business-loading" aria-busy="true" />
  }
  if (!state.status.isBusiness || !state.snapshot) {
    if (state.status.isBusiness && state.error) {
      return (
        <div className="biz biz--center" data-testid="business-error">
          <EmptyState title="ビジネスを開けません" description={state.error} actions={<Button onClick={() => void state.reload()}>読み直す</Button>} />
        </div>
      )
    }
    if (state.status.isBusiness) return <div className="biz" data-testid="business-loading" aria-busy="true" />
    return <InitBusiness api={api} hasProject={state.status.root !== null} onDone={state.setSnapshot} />
  }
  return <Workspace snapshot={state.snapshot} setSnapshot={state.setSnapshot} initialView={initialView} panelOpenInitial={panelOpenInitial} loadError={state.error} />
}

function InitBusiness({ api, hasProject, onDone }: { api: BusinessApi; hasProject: boolean; onDone: (s: BusinessSnapshot) => void }) {
  const [name, setName] = useState('')
  const [target, setTarget] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // 画面の唯一の入力なので、出たときに名前の欄へ入力位置を置く（autoFocus 属性は使わない）
  const nameRef = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (hasProject) nameRef.current?.focus()
  }, [hasProject])
  if (!hasProject) {
    return <div className="biz biz--center" data-testid="business-noproject"><EmptyState title="プロジェクトを開くとビジネスを始められます" /></div>
  }
  const submit = async () => {
    setBusy(true)
    setError(null)
    try {
      onDone(await api.invoke('business:init', { name: name.trim(), target: target.trim() }))
    } catch (err) {
      setError(errorText(err, 'ビジネスを作れませんでした'))
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="biz biz--center" data-testid="business-init">
      <form className="biz-init" onSubmit={(e) => { e.preventDefault(); void submit() }}>
        <h2 className="biz-init__title">ビジネスを始める</h2>
        <label className="biz-modal__label" htmlFor="biz-init-name">ビジネス名</label>
        <div className="field"><input id="biz-init-name" className="field__input" value={name} onChange={(e) => setName(e.target.value)} ref={nameRef} data-testid="init-name" /></div>
        <label className="biz-modal__label" htmlFor="biz-init-target">対象の1文</label>
        <textarea id="biz-init-target" className="biz-textarea" rows={3} value={target} onChange={(e) => setTarget(e.target.value)} placeholder="誰が・どの場面で・何を完了したいか" data-testid="init-target" />
        {error && <p className="biz-issue biz-issue--error" role="alert">{error}</p>}
        <div className="biz-init__actions">
          <Button variant="primary" disabled={!name.trim()} busy={busy} onClick={() => void submit()} data-testid="init-submit">始める</Button>
        </div>
      </form>
    </div>
  )
}

function Workspace({ snapshot, setSnapshot, initialView, panelOpenInitial, loadError }: {
  snapshot: BusinessSnapshot
  setSnapshot: (s: BusinessSnapshot) => void
  initialView: BusinessView
  panelOpenInitial: boolean
  loadError: string | null
}) {
  const api = useBusinessApi()
  const toast = useToast()
  const [view, setView] = useState<BusinessView>(initialView)
  /** 種類ごとに開いている記録（null は一覧。'new:<ID>' は新規） */
  const [open, setOpen] = useState<Partial<Record<EditableKind, string | null>>>({})
  const [newRecords, setNewRecords] = useState<Record<string, unknown>>({})
  const [approvalFocus, setApprovalFocus] = useState<string | null>(null)
  const [panelOpen, setPanelOpen] = useState(panelOpenInitial)
  const [pending, setPending] = useState<null | (() => void)>(null)
  const [modal, setModal] = useState<null | { kind: 'advance'; id: string } | { kind: 'loop' }>(null)
  const guardRef = useRef<EditorGuard | null>(null)
  const data = snapshot.data

  /** 未保存なら確認してから動く */
  const guarded = useCallback((action: () => void) => {
    if (guardRef.current?.dirty) setPending(() => action)
    else action()
  }, [])

  const openRecord = useCallback((kind: RecordKind, id: string | null) => {
    guarded(() => {
      if (kind === 'approval') {
        setView('approval')
        setApprovalFocus(id)
        return
      }
      setView(kind)
      setOpen((o) => ({ ...o, [kind]: id }))
    })
  }, [guarded])

  const newRecord = (kind: EditableKind) => {
    guarded(() => {
      const id = nextId(kind, recordsOf(data, kind).map((r) => r.id))
      const record = emptyRecord(kind, id, new Date().toISOString())
      if (kind === 'experiment' || kind === 'alternative' || kind === 'interview' || kind === 'decision') {
        const h = data.business.currentHypothesis ?? data.hypotheses[0]?.id ?? ''
        ;(record as RecordTypes['experiment']).hypothesis = h
      }
      if (kind === 'evidence' && data.business.currentHypothesis) (record as RecordTypes['evidence']).hypotheses = [data.business.currentHypothesis]
      setNewRecords((n) => ({ ...n, [id]: record }))
      setView(kind)
      setOpen((o) => ({ ...o, [kind]: id }))
    })
  }

  const advance = async (id: string, to: Stage, note: string) => {
    try {
      setSnapshot(await api.invoke('business:advanceStage', id, to, note))
      toast({ tone: 'success', message: `${id} を${to}へ進めました` })
      return true
    } catch (err) {
      toast({ tone: 'danger', message: '段階を進められませんでした', detail: errorText(err) })
      return false
    }
  }

  const closeLoop = async (input: { changed: '対象' | '成果' | '価格' | '経路'; backTo: StepId; note: string }) => {
    try {
      setSnapshot(await api.invoke('business:closeLoop', input))
      toast({ tone: 'success', message: `${input.changed}を変えて ${input.backTo} へ戻りました` })
      return true
    } catch (err) {
      toast({ tone: 'danger', message: '周を閉じられませんでした', detail: errorText(err) })
      return false
    }
  }

  const pickStep = (step: StepId) => {
    api.invoke('business:updateBusiness', { step }).then(setSnapshot).catch((err) => toast({ tone: 'danger', message: 'ステップを変えられませんでした', detail: errorText(err) }))
  }

  const pendingApprovals = snapshot.summary.counts.pendingApprovals
  const currentId = isEditable(view) ? open[view] ?? null : null

  const editor = useMemo(() => {
    if (!isEditable(view) || !currentId) return null
    const kind = view
    const exists = recordsOf(data, kind).some((r) => r.id === currentId)
    const initial = (newRecords[currentId] as RecordTypes[typeof kind] | undefined) ?? null
    if (!exists && !initial) return 'missing' as const
    return { kind, id: currentId, initial }
  }, [view, currentId, data, newRecords])

  const back = () => guarded(() => isEditable(view) && setOpen((o) => ({ ...o, [view]: null })))

  const renderEditor = () => {
    if (editor === null) return null
    if (editor === 'missing') return <EmptyState size="sm" title="この記録はありません" actions={<Button onClick={back}>一覧へ</Button>} />
    const common = { id: editor.id, snapshot, onSaved: setSnapshot, onBack: back, guardRef, key: `${editor.kind}:${editor.id}` }
    switch (editor.kind) {
      case 'hypothesis':
        return (
          <RecordEditor
            {...common}
            kind="hypothesis"
            initial={editor.initial as RecordTypes['hypothesis'] | null}
            title={(r) => r.name}
            headerExtra={(r, dirty) => {
              const saved = data.hypotheses.find((h) => h.id === r.id)
              return (
                <span className="biz-editor__stage">
                  <Badge>{saved?.stage ?? r.stage}</Badge>
                  {saved && nextStage(saved.stage) && (
                    <Button icon={<TrendingUp size={13} />} disabled={dirty} title={dirty ? '保存してから進めます' : undefined} onClick={() => setModal({ kind: 'advance', id: r.id })} data-testid="advance-open">段階を進める</Button>
                  )}
                </span>
              )
            }}
            render={(p) => <HypothesisForm {...p} />}
          />
        )
      case 'evidence':
        return <RecordEditor {...common} kind="evidence" initial={editor.initial as RecordTypes['evidence'] | null} title={(r) => r.party} render={(p) => <EvidenceForm {...p} />} />
      case 'alternative':
        return <RecordEditor {...common} kind="alternative" initial={editor.initial as RecordTypes['alternative'] | null} title={(r) => r.method} render={(p) => <AlternativeForm {...p} />} />
      case 'interview':
        return <RecordEditor {...common} kind="interview" initial={editor.initial as RecordTypes['interview'] | null} title={(r) => r.role} render={(p) => <InterviewForm {...p} />} />
      case 'decision':
        return <RecordEditor {...common} kind="decision" initial={editor.initial as RecordTypes['decision'] | null} title={(r) => `${r.hypothesis} ${r.verdict}`} render={(p) => <DecisionForm {...p} />} />
      case 'experiment':
        return (
          <RecordEditor
            {...common}
            kind="experiment"
            initial={editor.initial as RecordTypes['experiment'] | null}
            title={(r) => r.channel}
            render={(p) => {
              const saved = data.experiments.find((x) => x.id === p.draft.id)
              return <ExperimentForm {...p} page={saved ? <ExperimentPage experiment={saved} snapshot={snapshot} onSnapshot={setSnapshot} disabled={p.dirty} /> : null} />
            }}
          />
        )
    }
  }

  const advanceTarget = modal?.kind === 'advance' ? data.hypotheses.find((h) => h.id === modal.id) : undefined

  return (
    <div className={`biz${panelOpen ? '' : ' biz--panel-closed'}`} data-testid="business-workspace">
      <div className="biz-body">
        <main className="biz-main" aria-label="ビジネス">
          <div className="biz-nav" role="tablist" aria-label="ビジネスの画面">
            {NAV.map((n) => (
              <button
                key={n.view}
                type="button"
                role="tab"
                aria-selected={view === n.view}
                className="biz-nav__item"
                onClick={() => guarded(() => { setView(n.view); if (isEditable(n.view)) setOpen((o) => ({ ...o, [n.view]: null })) })}
                data-testid={`nav-${n.view}`}
              >
                <span>{n.label}</span>
                {n.view === 'approval' && <CountBadge count={pendingApprovals} tone="warning" />}
              </button>
            ))}
            <span className="biz-spacer" />
            <NextSteps />
            {!panelOpen && (
              <>
                <IconButton size="sm" label="ステップパネルを開く" icon={<ChevronsLeft size={14} />} onClick={() => setPanelOpen(true)} data-testid="panel-open" />
              </>
            )}
          </div>
          {loadError && <div className="biz-notice" role="status"><span>{loadError}</span></div>}
          <div className="biz-content">
            {view === 'dashboard' && (
              <Dashboard
                snapshot={snapshot}
                onOpen={openRecord}
                onCloseLoop={() => setModal({ kind: 'loop' })}
                onPickStep={pickStep}
                onUpdateBusiness={(patch) => api.invoke('business:updateBusiness', patch).then(setSnapshot).then(() => toast({ tone: 'success', message: '保存しました' })).catch((err) => toast({ tone: 'danger', message: '保存できませんでした', detail: errorText(err) }))}
                onGo={(v) => guarded(() => { setView(v); setOpen((o) => ({ ...o, [v]: null })) })}
                onOpenApprovals={() => { setView('approval'); setApprovalFocus(null) }}
                onSnapshot={setSnapshot}
              />
            )}
            {isEditable(view) && (editor ? renderEditor() : <RecordList kind={view} data={data} onOpen={(id) => openRecord(view, id)} onNew={() => newRecord(view)} />)}
            {view === 'approval' && <Approvals snapshot={snapshot} onSnapshot={setSnapshot} focusId={approvalFocus} />}
            {view === 'history' && <SentHistory snapshot={snapshot} />}
          </div>
        </main>
        {panelOpen && (
          <aside className="biz-panel" aria-label="ステップパネル">
            <StepPanel snapshot={snapshot} onSnapshot={setSnapshot} onCollapse={() => setPanelOpen(false)} onCaptured={(id) => openRecord('evidence', id)} />
          </aside>
        )}
      </div>

      {pending && guardRef.current && (
        <UnsavedModal
          label={guardRef.current.label}
          onChoose={async (choice) => {
            const action = pending
            if (choice === 'cancel') { setPending(null); return }
            if (choice === 'save') {
              const ok = await guardRef.current?.save()
              if (!ok) { setPending(null); return }
            }
            guardRef.current = null
            setPending(null)
            action()
          }}
        />
      )}
      {advanceTarget && (
        <AdvanceStageModal hypothesis={advanceTarget} data={data} onClose={() => setModal(null)} onConfirm={(to, note) => advance(advanceTarget.id, to, note)} />
      )}
      {modal?.kind === 'loop' && <CloseLoopModal loop={data.business.loop} onClose={() => setModal(null)} onConfirm={closeLoop} />}
    </div>
  )
}

