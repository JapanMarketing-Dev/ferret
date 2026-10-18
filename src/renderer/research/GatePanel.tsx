import { useState } from 'react'
import { Lock } from 'lucide-react'
import { GATE_IDS, type Candidate, type GateId, type GateStatus, type ResearchData } from '@shared/research/model'
import { autoGates, canDecideGate, type GateSuggestion } from '@shared/research/gates'
import { errorMessage } from '../lib/errors'
import { useT } from '../lib/i18n'
import { Badge, Button, useToast, type BadgeTone } from '../ui'
import { useResearchApi } from './api'
import { checkText } from './fields'
import type { ResearchSnapshot } from '@shared/research/ipc'

const SUGGESTION_TONE: Record<GateSuggestion['suggestion'], BadgeTone> = { pass: 'success', fail: 'danger', unknown: 'neutral' }
const STATUS_TONE: Record<GateStatus, BadgeTone> = { pass: 'success', fail: 'danger', pending: 'neutral' }

/**
 * ゲート（G1〜G7）。機械の判定（autoGates。保存しない）と理由、人が確定するボタン。
 * 前のゲートが人の pass でないものは pass にできない（押せない理由を出す）。fail・pending へはいつでも戻せる。
 * gates を渡せばその区分のゲートだけ出す
 */
export function GatePanel({ candidate, data, gates = GATE_IDS, dirty, onSnapshot, testId = 'research-gates' }: {
  candidate: Candidate
  data: ResearchData
  gates?: readonly GateId[]
  /** 下書きに保存していない変更がある（機械の判定は保存済みの記録から出すので、保存を促す） */
  dirty: boolean
  onSnapshot: (s: ResearchSnapshot) => void
  testId?: string
}) {
  const t = useT()
  const auto = autoGates(candidate, data)
  if (gates.length === 0) return null
  return (
    <div className="rs-gates" data-testid={testId}>
      {dirty && <p className="biz-issue biz-issue--warning">{t('research.gate.saveFirst')}</p>}
      {gates.map((g) => <GateRow key={g} gate={g} candidate={candidate} suggestion={auto[g]} locked={!canDecideGate(candidate, g, 'pass').ok} onSnapshot={onSnapshot} />)}
    </div>
  )
}

function GateRow({ gate, candidate, suggestion, locked, onSnapshot }: {
  gate: GateId
  candidate: Candidate
  suggestion: GateSuggestion
  locked: boolean
  onSnapshot: (s: ResearchSnapshot) => void
}) {
  const t = useT()
  const api = useResearchApi()
  const toast = useToast()
  const decision = candidate.gates[gate]
  const [note, setNote] = useState(decision?.note ?? '')
  const [busy, setBusy] = useState<GateStatus | null>(null)
  const status: GateStatus = decision?.status ?? 'pending'
  const decide = async (next: GateStatus) => {
    setBusy(next)
    try {
      onSnapshot(await api.invoke('research:decideGate', { candidateId: candidate.id, gate, status: next, note: note.trim() }))
      toast({ tone: 'success', message: t('research.gate.decided', { gate, status: t(`research.enum.gateStatus.${next}` as const) }) })
    } catch (err) {
      toast({ tone: 'danger', message: t('research.gate.decideFailed'), detail: errorMessage(err) })
    } finally {
      setBusy(null)
    }
  }
  return (
    <div className={`rs-gate rs-gate--${status}`} data-testid={`research-gate-${gate}`} data-status={status} data-suggestion={suggestion.suggestion}>
      <div className="rs-gate__head">
        <span className="rs-gate__id biz-mono">{gate}</span>
        <span className="rs-gate__title">{t(`research.gate.${gate}.title` as const)}</span>
        <span className="biz-spacer" />
        <span className="rs-gate__machine" title={t('research.gate.machineTip')}>
          <span className="biz-muted">{t('research.gate.machine')}</span>
          <Badge tone={SUGGESTION_TONE[suggestion.suggestion]}>{t(`research.enum.suggestion.${suggestion.suggestion}` as const)}</Badge>
        </span>
        <span className="rs-gate__human">
          <span className="biz-muted">{t('research.gate.human')}</span>
          <Badge tone={STATUS_TONE[status]}>{t(`research.enum.gateStatus.${status}` as const)}</Badge>
        </span>
      </div>
      <p className="biz-muted rs-gate__desc">{t(`research.gate.${gate}.desc` as const)}</p>
      {suggestion.reasons.length > 0 && (
        <ul className="rs-gate__reasons">
          {suggestion.reasons.map((r, i) => (
            <li key={`${r.id}:${i}`} className={r.ok === true ? 'is-ok' : r.ok === false ? 'is-ng' : 'is-unknown'}>
              {checkText(t, r)}
            </li>
          ))}
        </ul>
      )}
      {gate === 'G6' && <p className="biz-muted rs-gate__desc">{t('research.gate.G6.humanOnly')}</p>}
      <div className="rs-gate__decide">
        <div className="field rs-gate__note">
          <input className="field__input" value={note} placeholder={t('research.gate.notePlaceholder')} aria-label={t('research.gate.note', { gate })} onChange={(e) => setNote(e.target.value)} data-testid={`research-gate-${gate}-note`} />
        </div>
        <Button
          icon={locked ? <Lock size={13} aria-hidden="true" /> : undefined}
          disabled={locked || status === 'pass'}
          title={locked ? t('research.gate.locked') : undefined}
          busy={busy === 'pass'}
          onClick={() => void decide('pass')}
          data-testid={`research-gate-${gate}-pass`}
        >
          {t('research.gate.pass')}
        </Button>
        <Button variant="ghost" disabled={status === 'fail'} busy={busy === 'fail'} onClick={() => void decide('fail')} data-testid={`research-gate-${gate}-fail`}>{t('research.gate.fail')}</Button>
        {status !== 'pending' && <Button variant="ghost" busy={busy === 'pending'} onClick={() => void decide('pending')} data-testid={`research-gate-${gate}-reset`}>{t('research.gate.reset')}</Button>}
      </div>
      {locked && <p className="biz-muted rs-gate__lock" data-testid={`research-gate-${gate}-locked`}>{t('research.gate.locked')}</p>}
    </div>
  )
}
