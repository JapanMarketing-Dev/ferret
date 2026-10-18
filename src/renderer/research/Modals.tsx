import { useEffect, useState, type ReactNode } from 'react'
import { FolderPlus } from 'lucide-react'
import { CANDIDATE_STAGES, FUNNEL_STAGES, type Candidate, type CandidateStage, type FunnelStage, type ResearchData } from '@shared/research/model'
import type { ResearchSnapshot } from '@shared/research/ipc'
import { canPromote } from '@shared/research/gates'
import { orchestraList } from '@shared/orchestras'
import type { Project } from '@shared/types'
import { errorMessage } from '../lib/errors'
import { useT } from '../lib/i18n'
import { Badge, Button, Modal, useToast } from '../ui'
import { useResearchApi } from './api'
import { NumField, Txt } from './fields'
import { folderNameFrom, folderNameIssue } from './view'

function RsModal({ label, children, testId, onClose, foot }: { label: string; children: ReactNode; testId: string; onClose: () => void; foot: ReactNode }) {
  return (
    <Modal className="biz-modal" label={label} onClose={onClose}>
      <div className="biz-modal__panel rs-modal" data-testid={testId}>
        <header className="biz-modal__head"><h2>{label}</h2></header>
        <div className="biz-modal__body">{children}</div>
        <footer className="biz-modal__foot">{foot}</footer>
      </div>
    </Modal>
  )
}

/** 新しい候補（題名だけ先に決めて保存する。中身は区分ごとに埋める） */
export function NewCandidateModal({ onClose, onCreate }: { onClose: () => void; onCreate: (input: { title: string; market: string; problem: string; customer: string }) => Promise<boolean> }) {
  const t = useT()
  const [v, setV] = useState({ title: '', market: '', problem: '', customer: '' })
  const [busy, setBusy] = useState(false)
  const submit = async () => {
    setBusy(true)
    const ok = await onCreate({ title: v.title.trim(), market: v.market.trim(), problem: v.problem.trim(), customer: v.customer.trim() })
    setBusy(false)
    if (ok) onClose()
  }
  return (
    <RsModal
      label={t('research.newCandidate.title')}
      testId="research-new-candidate"
      onClose={onClose}
      foot={<><Button variant="ghost" onClick={onClose}>{t('research.ws.cancel')}</Button><Button variant="primary" disabled={!v.title.trim()} busy={busy} onClick={() => void submit()} data-testid="research-new-candidate-submit">{t('research.newCandidate.create')}</Button></>}
    >
      <p className="biz-muted">{t('research.newCandidate.hint')}</p>
      <div className="biz-form biz-form--tight">
        <Txt label={t('research.field.title')} value={v.title} onChange={(title) => setV({ ...v, title })} wide testId="research-new-candidate-title" />
        <Txt label={t('research.field.market')} value={v.market} onChange={(market) => setV({ ...v, market })} wide />
        <Txt label={t('research.field.problem')} value={v.problem} onChange={(problem) => setV({ ...v, problem })} rows={2} />
        <Txt label={t('research.field.customer')} value={v.customer} onChange={(customer) => setV({ ...v, customer })} wide />
      </div>
    </RsModal>
  )
}

/** 段階を変える（人が押したときだけ。除外は理由が要る） */
export function StageModal({ candidate, onClose, onSnapshot }: { candidate: Candidate; onClose: () => void; onSnapshot: (s: ResearchSnapshot) => void }) {
  const t = useT()
  const api = useResearchApi()
  const toast = useToast()
  const [stage, setStage] = useState<CandidateStage>(candidate.stage)
  const [reason, setReason] = useState(candidate.dropReason)
  const [busy, setBusy] = useState(false)
  const needsReason = stage === 'dropped' && !reason.trim()
  const submit = async () => {
    setBusy(true)
    try {
      onSnapshot(await api.invoke('research:setStage', { candidateId: candidate.id, stage, reason: reason.trim() }))
      toast({ tone: 'success', message: t('research.stage.changed', { id: candidate.id, stage: t(`research.enum.stage.${stage}` as const) }) })
      onClose()
    } catch (err) {
      toast({ tone: 'danger', message: t('research.stage.failed'), detail: errorMessage(err) })
    } finally {
      setBusy(false)
    }
  }
  return (
    <RsModal
      label={t('research.stage.title', { id: candidate.id })}
      testId="research-stage-modal"
      onClose={onClose}
      foot={<><Button variant="ghost" onClick={onClose}>{t('research.ws.cancel')}</Button><Button variant={stage === 'dropped' ? 'danger' : 'primary'} disabled={(stage === candidate.stage && stage !== 'dropped') || needsReason} busy={busy} onClick={() => void submit()} data-testid="research-stage-submit">{t('research.stage.apply')}</Button></>}
    >
      <p className="biz-muted">{t('research.stage.hint')}</p>
      <div className="rs-stage-options" role="radiogroup" aria-label={t('research.stage.label')}>
        {CANDIDATE_STAGES.map((s) => (
          <label key={s} className={`rs-stage-option${s === stage ? ' is-on' : ''}`}>
            <input type="radio" name="rs-stage" value={s} checked={s === stage} onChange={() => setStage(s)} data-testid={`research-stage-${s}`} />
            <span className="rs-stage-option__name">{t(`research.enum.stage.${s}` as const)}</span>
            <span className="biz-muted">{t(`research.enum.stage.${s}.desc` as const)}</span>
          </label>
        ))}
      </div>
      {stage === 'dropped' && (
        <Txt label={t('research.stage.reason')} value={reason} onChange={setReason} rows={2} testId="research-stage-reason" issues={needsReason ? [{ severity: 'error', ref: '', field: '', message: t('research.stage.reasonRequired') }] : []} />
      )}
    </RsModal>
  )
}

/**
 * 「プロジェクトにする」。canPromote の不足を出し、オーケストラとフォルダの名前を選ぶ。
 * 親フォルダは main がダイアログで選ばせる（null が返れば選ばなかった）。成功したら onOpenProject
 */
export function PromoteModal({ candidate, data, onClose, onSnapshot, onOpenProject }: {
  candidate: Candidate
  data: ResearchData
  onClose: () => void
  onSnapshot: (s: ResearchSnapshot) => void
  onOpenProject: (projectId: string) => void
}) {
  const t = useT()
  const api = useResearchApi()
  const toast = useToast()
  const check = canPromote(candidate, data)
  const [orchestras, setOrchestras] = useState<Project[] | null>(null)
  const [orchestraId, setOrchestraId] = useState<string>('')
  const [folderName, setFolderName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let alive = true
    api.projects().then((state) => {
      if (!alive) return
      const list = orchestraList(state.projects)
      setOrchestras(list)
      setOrchestraId((cur) => cur || list[0]?.id || '')
    }).catch(() => { if (alive) setOrchestras([]) })
    return () => { alive = false }
  }, [api])
  const suggested = folderNameFrom(candidate.title, candidate.id)
  const nameIssue = folderNameIssue(folderName)
  const submit = async () => {
    setBusy(true)
    setError(null)
    try {
      const res = await api.invoke('research:promote', { candidateId: candidate.id, orchestraId: orchestraId || null, folderName: folderName.trim() || suggested })
      if (!res) return
      onSnapshot(res.snapshot)
      toast({ tone: 'success', message: t('research.promote.done', { id: candidate.id }) })
      onClose()
      onOpenProject(res.projectId)
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }
  return (
    <RsModal
      label={t('research.promote.title')}
      testId="research-promote-modal"
      onClose={onClose}
      foot={<><Button variant="ghost" onClick={onClose}>{t('research.ws.cancel')}</Button><Button variant="primary" icon={<FolderPlus size={13} />} disabled={!check.ok || nameIssue !== null} busy={busy} onClick={() => void submit()} data-testid="research-promote-submit">{t('research.promote.submit')}</Button></>}
    >
      <p className="biz-muted">{t('research.promote.hint')}</p>
      <p><Badge tone="brand"><span className="biz-mono">{candidate.id}</span></Badge> {candidate.title}</p>
      {check.ok ? (
        <p className="biz-issue biz-issue--ok" data-testid="research-promote-ready">{t('research.promote.ready')}</p>
      ) : (
        <div data-testid="research-promote-missing">
          <p className="biz-issue biz-issue--warning">{t('research.promote.missingTitle')}</p>
          <ul className="biz-missing">
            {check.missing.map((m) => <li key={m} data-missing={m}>{t(`research.promote.missing.${m}` as const)}</li>)}
          </ul>
        </div>
      )}
      <div className="biz-form biz-form--tight">
        <div className="biz-field biz-field--wide">
          <label className="biz-field__label" htmlFor="rs-promote-orchestra">{t('research.promote.orchestra')}</label>
          <div className="biz-field__control">
            {orchestras === null ? <span className="biz-muted">{t('research.ws.loading')}</span> : orchestras.length === 0 ? (
              <span className="biz-muted">{t('research.promote.noOrchestra')}</span>
            ) : (
              <select id="rs-promote-orchestra" className="biz-select" value={orchestraId} onChange={(e) => setOrchestraId(e.target.value)} data-testid="research-promote-orchestra">
                {orchestras.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
              </select>
            )}
          </div>
        </div>
        <Txt
          label={t('research.promote.folderName')}
          placeholder={suggested}
          value={folderName}
          onChange={setFolderName}
          wide
          testId="research-promote-folder"
          issues={nameIssue ? [{ severity: 'error', ref: '', field: '', message: t(`research.promote.folder.${nameIssue}` as const) }] : []}
        />
      </div>
      <p className="biz-muted rs-hint">{t('research.promote.after')}</p>
      {error && <p className="biz-issue biz-issue--error" role="alert" data-testid="research-promote-error">{error}</p>}
    </RsModal>
  )
}

/** リサーチの設定（名前・対象範囲・ファンネルの目安・G1 の目安） */
export function SettingsModal({ data, onClose, onSnapshot }: { data: ResearchData; onClose: () => void; onSnapshot: (s: ResearchSnapshot) => void }) {
  const t = useT()
  const api = useResearchApi()
  const toast = useToast()
  const [name, setName] = useState(data.research.name)
  const [scope, setScope] = useState(data.research.scope)
  const [targets, setTargets] = useState<Record<FunnelStage, number | null>>({ ...data.research.funnelTargets })
  const [minTarget, setMinTarget] = useState<number | null>(data.research.minTargetCount)
  const [busy, setBusy] = useState(false)
  const complete = FUNNEL_STAGES.every((s) => targets[s] !== null) && minTarget !== null && name.trim() !== ''
  const submit = async () => {
    if (!complete) return
    setBusy(true)
    try {
      onSnapshot(await api.invoke('research:updateResearch', { name: name.trim(), scope: scope.trim(), funnelTargets: targets as Record<FunnelStage, number>, minTargetCount: minTarget }))
      toast({ tone: 'success', message: t('research.ws.saved') })
      onClose()
    } catch (err) {
      toast({ tone: 'danger', message: t('research.ws.saveFailed'), detail: errorMessage(err) })
    } finally {
      setBusy(false)
    }
  }
  return (
    <RsModal
      label={t('research.settings.title')}
      testId="research-settings"
      onClose={onClose}
      foot={<><Button variant="ghost" onClick={onClose}>{t('research.ws.cancel')}</Button><Button variant="primary" disabled={!complete} busy={busy} onClick={() => void submit()} data-testid="research-settings-save">{t('research.ws.save')}</Button></>}
    >
      <div className="biz-form biz-form--tight">
        <Txt label={t('research.init.name')} value={name} onChange={setName} wide testId="research-settings-name" />
        <Txt label={t('research.init.scope')} value={scope} onChange={setScope} rows={2} />
        {FUNNEL_STAGES.map((s) => (
          <NumField key={s} label={t('research.settings.target', { stage: t(`research.enum.stage.${s}` as const) })} kind="integer" value={targets[s]} onChange={(v) => setTargets({ ...targets, [s]: v })} />
        ))}
        <NumField label={t('research.settings.minTargetCount')} kind="integer" value={minTarget} onChange={setMinTarget} unit={t('research.ws.unit.companies')} />
      </div>
    </RsModal>
  )
}

/** 保存していない変更があるまま別の候補へ移るとき */
export function UnsavedModal({ id, onChoose }: { id: string; onChoose: (choice: 'save' | 'discard' | 'cancel') => void }) {
  const t = useT()
  return (
    <RsModal
      label={t('research.unsaved.title')}
      testId="research-unsaved"
      onClose={() => onChoose('cancel')}
      foot={<><Button variant="ghost" onClick={() => onChoose('cancel')}>{t('research.ws.cancel')}</Button><Button variant="danger" onClick={() => onChoose('discard')} data-testid="research-unsaved-discard">{t('research.unsaved.discard')}</Button><Button variant="primary" onClick={() => onChoose('save')} data-testid="research-unsaved-save">{t('research.ws.save')}</Button></>}
    >
      <p>{t('research.unsaved.body', { id })}</p>
    </RsModal>
  )
}
