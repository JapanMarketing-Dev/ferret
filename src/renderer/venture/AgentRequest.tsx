import { useEffect, useMemo, useRef, useState } from 'react'
import { Send } from 'lucide-react'
import { venturePromptMeta } from '@shared/venture/prompts'
import type { VenturePromptId } from '@shared/venture/ipc'
import { errorMessage } from '../lib/errors'
import { useLocale, useT } from '../lib/i18n'
import { Badge, Button, useToast } from '../ui'
import { useVentureApi } from './api'
import { AGENT_TARGETS, targetOf, type TargetValue } from './view'

type PromptState = { id: string; text: string; base: string }

/** 依頼の題と一文（知らない id でも画面は落とさない） */
function metaOf(id: string, locale: 'ja' | 'en'): { title: string; desc: string } {
  try {
    return venturePromptMeta(id, locale)
  } catch {
    return { title: id, desc: '' }
  }
}

/**
 * Agent への依頼の欄。依頼を選び（説明を出す）、全文を開いて直し、送り先を選んで送る。
 * 送り方は AgentPanel と同じ: 押した直後に venture:armSend で札をもらい、新しい Agent なら起動を待ってから venture:send。
 * 送った結果は正直に出す（送れていなければ送れていないと出す）
 */
export function AgentRequest({ prompts, refreshKey, testId = 'venture-agent' }: {
  /** 出す依頼の id（先頭が既定） */
  prompts: readonly VenturePromptId[]
  /** 変われば全文を埋め直す（記録が変わった合図。直している途中なら埋め直さない） */
  refreshKey: unknown
  testId?: string
}) {
  const t = useT()
  const locale = useLocale()
  const api = useVentureApi()
  const toast = useToast()
  const [promptId, setPromptId] = useState<VenturePromptId>(prompts[0] ?? '')
  const [prompt, setPrompt] = useState<PromptState | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [open, setOpen] = useState(false)
  const [target, setTarget] = useState<TargetValue>('active')
  const [busy, setBusy] = useState(false)
  const [launching, setLaunching] = useState(false)
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null)

  useEffect(() => {
    if (!prompts.includes(promptId)) {
      setPromptId(prompts[0] ?? '')
      setResult(null)
    }
  }, [prompts, promptId])

  const editing = prompt !== null && prompt.id === promptId && prompt.text !== prompt.base
  const editingRef = useRef(false)
  editingRef.current = editing

  // biome-ignore lint/correctness/useExhaustiveDependencies: refreshKey は埋め直しの合図
  useEffect(() => {
    if (!promptId || editingRef.current) return
    let alive = true
    api.invoke('venture:prompt', { promptId }).then((p) => {
      if (!alive) return
      setPrompt({ id: promptId, text: p.text, base: p.text })
      setLoadError(null)
    }).catch((err) => {
      if (!alive) return
      setPrompt(null)
      setLoadError(errorMessage(err))
    })
    return () => { alive = false }
  }, [api, promptId, refreshKey, locale])

  const current = prompt && prompt.id === promptId ? prompt : null
  const meta = useMemo(() => (promptId ? metaOf(promptId, locale) : null), [promptId, locale])

  const send = async () => {
    if (!current) return
    const fail = (message: string) => {
      setResult({ ok: false, message })
      toast({ tone: 'danger', message: t('venture.agent.sendFailed'), detail: message })
    }
    setBusy(true)
    setResult(null)
    try {
      let to = targetOf(target)
      const text = current.text
      // 送る許可は押した直後にしか取れないので、最初に札をもらう（本文・送り先に結び付く）
      const { ticket } = await api.invoke('venture:armSend', { promptId, textHash: await sha256Hex(text), target: to })
      if (to.kind === 'new') {
        setLaunching(true)
        const agent = to.agent
        const id = await api.launchAgent(agent).finally(() => setLaunching(false))
        if (!id) return fail(t('venture.agent.launchFailed', { agent: agent === 'codex' ? 'Codex' : 'Claude Code' }))
        to = { kind: 'terminal', id }
      }
      const res = await api.invoke('venture:send', { promptId, text, target: to, ticket })
      if (res.ok) {
        setResult(res)
        toast({ tone: 'success', message: res.message || t('venture.agent.sent') })
      } else fail(res.message)
    } catch (err) {
      fail(errorMessage(err) || t('venture.agent.sendFailed'))
    } finally {
      setBusy(false)
    }
  }

  if (prompts.length === 0) return null
  const selectId = `${testId}-prompt`
  const targetId = `${testId}-target`

  return <section className="vt-card vt-agent" data-testid={testId}>
    <h3 className="vt-card__title">{t('venture.agent.title')}</h3>
    <label className="vt-label" htmlFor={selectId}>{t('venture.agent.prompt')}</label>
    <select id={selectId} className="vt-select" value={promptId} onChange={(e) => { setPromptId(e.target.value); setResult(null); setOpen(false) }} data-testid={`${testId}-select`}>
      {prompts.map((id) => <option key={id} value={id}>{metaOf(id, locale).title}</option>)}
    </select>
    {meta?.desc && <p className="vt-muted" data-testid={`${testId}-desc`}>{meta.desc}</p>}
    {loadError && <p className="vt-issue vt-issue--danger" role="alert">{t('venture.agent.loadFailed', { reason: loadError })}</p>}
    <div className="vt-row">
      <Button onClick={() => setOpen((o) => !o)} aria-expanded={open} disabled={!current} data-testid={`${testId}-fulltext`}>{open ? t('venture.agent.closeText') : t('venture.agent.openText')}</Button>
      {editing && <Badge tone="warning">{t('venture.agent.edited')}</Badge>}
    </div>
    {open && current && <div className="vt-agent__text">
      <textarea
        className="vt-textarea vt-textarea--mono"
        aria-label={t('venture.agent.text')}
        rows={14}
        value={current.text}
        onChange={(e) => setPrompt({ ...current, text: e.target.value })}
        data-testid={`${testId}-text`}
      />
      {editing && <div className="vt-row"><Button variant="ghost" onClick={() => setPrompt({ ...current, text: current.base })}>{t('venture.agent.revert')}</Button></div>}
    </div>}
    <label className="vt-label" htmlFor={targetId}>{t('venture.agent.target')}</label>
    <div className="vt-row">
      <select id={targetId} className="vt-select" value={target} onChange={(e) => setTarget(e.target.value as TargetValue)} data-testid={`${testId}-target`}>
        {AGENT_TARGETS.map((x) => <option key={x.value} value={x.value}>{t(`venture.agent.target.${x.value}`)}</option>)}
      </select>
      <Button variant="primary" icon={<Send size={13} />} disabled={!current?.text.trim()} busy={busy} onClick={() => void send()} data-testid={`${testId}-send`}>{t('venture.agent.send')}</Button>
    </div>
    {launching && <p className="vt-muted" role="status">{t('venture.agent.launching')}</p>}
    {result && <p className={`vt-issue vt-issue--${result.ok ? 'ok' : 'danger'}`} role={result.ok ? 'status' : 'alert'} data-testid={`${testId}-result`}>
      {result.ok ? result.message || t('venture.agent.sent') : t('venture.agent.notSent', { reason: result.message || t('venture.agent.unknownReason') })}
    </p>}
    <p className="vt-muted vt-small">{t('venture.agent.rule')}</p>
  </section>
}

/** 本文の sha256（送る札に結び付ける。main が同じ本文か確かめる） */
async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}
