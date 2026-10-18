import { useEffect, useMemo, useRef, useState } from 'react'
import { ChevronsRight, Send } from 'lucide-react'
import type { BusinessSendTarget } from '@shared/business/ipc'
import type { ResearchPromptId } from '@shared/research/ipc'
import { errorMessage } from '../lib/errors'
import { useT } from '../lib/i18n'
import { Badge, Button, IconButton, useToast } from '../ui'
import { useResearchApi } from './api'
import { placeholdersIn, promptNeedsCandidate } from './view'

type TargetValue = 'active' | 'claude' | 'codex'
const TARGETS: ReadonlyArray<{ value: TargetValue; target: BusinessSendTarget }> = [
  { value: 'active', target: { kind: 'active' } },
  { value: 'claude', target: { kind: 'new', agent: 'claude' } },
  { value: 'codex', target: { kind: 'new', agent: 'codex' } }
]

type PromptState = { key: string; text: string; base: string }

/**
 * 右の「Agent への依頼」。区分に対応する依頼（RESEARCH_PROMPT_IDS）の全文を出し、直して送る。
 * 送り方は business の StepPanel と同じ: 押した直後に research:armSend で札をもらい、新しい Agent なら起動を待ってから research:send。
 * 送った結果は正直に出す（送れていなければ送れていないと出す）。
 */
export function AgentPanel({ prompts, candidateId, candidateTitle, refreshKey, onCollapse }: {
  /** この区分で出す依頼（先頭が既定） */
  prompts: readonly ResearchPromptId[]
  candidateId: string | null
  candidateTitle: string | null
  /** 変われば全文を埋め直す（記録が変わった合図） */
  refreshKey: unknown
  onCollapse: () => void
}) {
  const t = useT()
  const api = useResearchApi()
  const toast = useToast()
  const [promptId, setPromptId] = useState<ResearchPromptId>(prompts[0] ?? 'discover')
  const [prompt, setPrompt] = useState<PromptState | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [open, setOpen] = useState(false)
  const [target, setTarget] = useState<TargetValue>('active')
  const [busy, setBusy] = useState(false)
  const [launching, setLaunching] = useState(false)
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null)

  useEffect(() => {
    if (!prompts.includes(promptId)) setPromptId(prompts[0] ?? 'discover')
  }, [prompts, promptId])

  const needsCandidate = promptNeedsCandidate(promptId)
  const blocked = needsCandidate && candidateId === null
  // discover は候補を出す入口なので候補に結び付けない。learning は選んでいればその候補、無ければ全体
  const forCandidate = promptId === 'discover' ? null : candidateId
  const key = `${promptId}:${forCandidate ?? ''}`
  const editing = prompt !== null && prompt.key === key && prompt.text !== prompt.base
  const editingRef = useRef(false)
  editingRef.current = editing

  // biome-ignore lint/correctness/useExhaustiveDependencies: refreshKey は埋め直しの合図
  useEffect(() => {
    if (blocked || editingRef.current) return
    let alive = true
    api.invoke('research:prompt', { promptId, candidateId: forCandidate }).then((p) => {
      if (!alive) return
      setPrompt({ key, text: p.text, base: p.text })
      setLoadError(null)
    }).catch((err) => {
      if (!alive) return
      setPrompt(null)
      setLoadError(errorMessage(err))
    })
    return () => { alive = false }
  }, [api, promptId, forCandidate, blocked, key, refreshKey])

  const current = prompt && prompt.key === key ? prompt : null
  const missing = useMemo(() => (current ? placeholdersIn(current.text) : []), [current])

  const send = async () => {
    if (!current) return
    const fail = (message: string) => {
      setResult({ ok: false, message })
      toast({ tone: 'danger', message: t('research.agent.sendFailed'), detail: message })
    }
    setBusy(true)
    try {
      let to = TARGETS.find((x) => x.value === target)!.target
      const text = current.text
      // 送る許可は押した直後にしか取れないので、最初に札をもらう（本文・送り先に結び付く）
      const { ticket } = await api.invoke('research:armSend', { promptId, textHash: await sha256Hex(text), target: to })
      if (to.kind === 'new') {
        setResult(null)
        setLaunching(true)
        const agent = to.agent
        const id = await api.launchAgent(agent).finally(() => setLaunching(false))
        if (!id) return fail(t('research.agent.launchFailed', { agent: agent === 'codex' ? 'Codex' : 'Claude Code' }))
        to = { kind: 'terminal', id }
      }
      const res = await api.invoke('research:send', { promptId, candidateId: forCandidate, text, target: to, ticket })
      if (res.ok) {
        setResult(res)
        toast({ tone: 'success', message: res.message || t('research.agent.sent') })
      } else fail(res.message)
    } catch (err) {
      fail(errorMessage(err) || t('research.agent.sendFailed'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="biz-panel__inner rs-agent" data-testid="research-agent">
      <header className="biz-panel__head">
        <h2 className="biz-panel__title">{t('research.agent.title')}</h2>
        <span className="biz-spacer" />
        <IconButton size="sm" label={t('research.agent.collapse')} icon={<ChevronsRight size={14} />} onClick={onCollapse} data-testid="research-agent-collapse" />
      </header>

      <div className="biz-panel__block">
        <label className="biz-panel__label" htmlFor="rs-prompt-select">{t('research.agent.prompt')}</label>
        <select id="rs-prompt-select" className="biz-select" value={promptId} onChange={(e) => { setPromptId(e.target.value as ResearchPromptId); setResult(null) }} data-testid="research-agent-prompt">
          {prompts.map((p) => <option key={p} value={p}>{t(`research.prompt.${p}.title` as const)}</option>)}
        </select>
        <p className="biz-muted rs-agent__desc" data-testid="research-agent-desc">{t(`research.prompt.${promptId}.desc` as const)}</p>
        <p className="rs-agent__for">
          {forCandidate ? (
            <><Badge tone="brand"><span className="biz-mono">{forCandidate}</span></Badge> <span className="biz-ellipsis" title={candidateTitle ?? ''}>{candidateTitle}</span></>
          ) : (
            <span className="biz-muted">{t('research.agent.forAll')}</span>
          )}
        </p>
        {blocked && <p className="biz-issue biz-issue--warning" data-testid="research-agent-needs-candidate">{t('research.agent.needsCandidate')}</p>}
        {loadError && <p className="biz-issue biz-issue--error" role="alert">{t('research.agent.loadFailed', { reason: loadError })}</p>}
        <div className="biz-panel__row">
          <Button onClick={() => setOpen((o) => !o)} aria-expanded={open} disabled={!current} data-testid="research-agent-fulltext">{open ? t('research.agent.closeText') : t('research.agent.openText')}</Button>
          {editing && <Badge tone="warning">{t('research.agent.edited')}</Badge>}
        </div>
        {open && current && (
          <div className="biz-panel__prompt">
            <textarea
              className="biz-textarea biz-textarea--mono"
              aria-label={t('research.agent.text')}
              rows={16}
              value={current.text}
              onChange={(e) => setPrompt({ ...current, text: e.target.value })}
              data-testid="research-agent-text"
            />
            {missing.length > 0 && <p className="biz-issue biz-issue--warning" data-testid="research-agent-missing">{t('research.agent.missing', { items: missing.join(', ') })}</p>}
            {editing && <div className="biz-panel__row"><Button variant="ghost" onClick={() => setPrompt({ ...current, text: current.base })}>{t('research.agent.revert')}</Button></div>}
          </div>
        )}
        <label className="biz-panel__label" htmlFor="rs-target-select">{t('research.agent.target')}</label>
        <div className="biz-panel__row">
          <select id="rs-target-select" className="biz-select" value={target} onChange={(e) => setTarget(e.target.value as TargetValue)} data-testid="research-agent-target">
            {TARGETS.map((x) => <option key={x.value} value={x.value}>{t(`research.agent.target.${x.value}` as const)}</option>)}
          </select>
          <Button variant="primary" icon={<Send size={13} />} disabled={!current?.text.trim() || blocked} busy={busy} onClick={() => void send()} data-testid="research-agent-send">{t('research.agent.send')}</Button>
        </div>
        {launching && <p className="biz-muted biz-panel__note" role="status">{t('research.agent.launching')}</p>}
        {result && (
          <p className={`biz-issue biz-issue--${result.ok ? 'ok' : 'error'}`} role={result.ok ? 'status' : 'alert'} data-testid="research-agent-result">
            {result.ok ? result.message || t('research.agent.sent') : t('research.agent.notSent', { reason: result.message || t('research.agent.unknownReason') })}
          </p>
        )}
        <p className="biz-muted rs-agent__rule">{t('research.agent.rule')}</p>
      </div>
    </div>
  )
}

/** 本文の sha256（送る札に結び付ける。main が同じ本文か確かめる） */
async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}
