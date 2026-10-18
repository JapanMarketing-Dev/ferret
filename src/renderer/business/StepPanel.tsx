import { useEffect, useMemo, useRef, useState } from 'react'
import { Check, ChevronsRight, Circle, FilePlus2, RotateCcw, Save, Send } from 'lucide-react'
import { STEPS, stepById, type StepId } from '@shared/business/model'
import type { BusinessSendTarget, BusinessSnapshot } from '@shared/business/ipc'
import { promptsForStep } from '@shared/business/prompts'
import { Badge, Button, IconButton, Tooltip, useToast } from '../ui'
import { useBusinessApi } from './api'
import { errorText } from './view'

const TARGETS: ReadonlyArray<{ value: string; label: string; target: BusinessSendTarget }> = [
  { value: 'active', label: '開いている Agent', target: { kind: 'active' } },
  { value: 'claude', label: '新しい Claude Code', target: { kind: 'new', agent: 'claude' } },
  { value: 'codex', label: '新しい Codex', target: { kind: 'new', agent: 'codex' } }
]

type PromptState = { id: string; text: string; base: string; body: string; missing: string[]; overridden: boolean }

/**
 * 右のステップパネル。今のステップ・出口の確認・数・プロンプトと送り先。
 * 送った結果は正直に出す（送れていなければ送れていないと出す）。
 */
export function StepPanel({ snapshot, onSnapshot, onCollapse, onCaptured }: {
  snapshot: BusinessSnapshot
  onSnapshot: (s: BusinessSnapshot) => void
  onCollapse: () => void
  /** 証拠の下書きができた（開く） */
  onCaptured: (id: string) => void
}) {
  const api = useBusinessApi()
  const toast = useToast()
  const { summary } = snapshot
  const step = stepById(summary.step)
  const prompts = useMemo(() => promptsForStep(summary.step), [summary.step])
  const [promptId, setPromptId] = useState(prompts[0]?.id ?? '')
  const [prompt, setPrompt] = useState<PromptState | null>(null)
  const [open, setOpen] = useState(false)
  const [target, setTarget] = useState('active')
  const [busy, setBusy] = useState<null | 'send' | 'save' | 'reset' | 'capture' | 'step'>(null)
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null)
  const [launching, setLaunching] = useState(false)
  /** ひな型（{{…}} の穴が残った本文）を直している途中の文。null は閉じている */
  const [templateDraft, setTemplateDraft] = useState<string | null>(null)

  useEffect(() => {
    if (!prompts.some((p) => p.id === promptId)) setPromptId(prompts[0]?.id ?? '')
  }, [prompts, promptId])

  // プロンプトの全文。人が直している途中なら上書きしない
  const editing = prompt !== null && prompt.text !== prompt.base
  // 直している途中かどうかは読むだけ（変わっても読み直さない）
  const editingIdRef = useRef<string | null>(null)
  editingIdRef.current = editing ? prompt.id : null
  // biome-ignore lint/correctness/useExhaustiveDependencies: snapshot は読み直しの合図（変われば埋める値も変わる）
  useEffect(() => {
    if (!promptId || editingIdRef.current === promptId) return
    let alive = true
    api.invoke('business:prompt', promptId).then((p) => {
      if (alive) setPrompt({ id: promptId, text: p.text, base: p.text, body: p.body, missing: p.missing, overridden: p.overridden })
    }).catch(() => { if (alive) setPrompt(null) })
    return () => { alive = false }
  }, [api, promptId, snapshot])

  const liveMissing = useMemo(() => (prompt ? [...new Set([...prompt.text.matchAll(/\{\{\s*([^{}\s]{1,40})\s*\}\}/g)].map((m) => m[1]!))] : []), [prompt])

  const run = async <T,>(key: NonNullable<typeof busy>, fn: () => Promise<T>): Promise<T | undefined> => {
    setBusy(key)
    try { return await fn() } catch (err) {
      toast({ tone: 'danger', message: '実行できませんでした', detail: errorText(err) })
      return undefined
    } finally { setBusy(null) }
  }

  const send = () => run('send', async () => {
    if (!prompt) return
    const t = TARGETS.find((x) => x.value === target)!
    const fail = (message: string) => {
      setResult({ ok: false, message })
      toast({ tone: 'danger', message: '送れませんでした', detail: message })
    }
    try {
      let to = t.target
      // 送る許可は押した直後（約1秒）にしか取れないので、最初に札をもらう（本文・送り先に結び付く。新しい Agent の起動を待つ前）
      const text = prompt.text
      const { ticket } = await api.invoke('business:armSend', { promptId: prompt.id, textHash: await sha256Hex(text), target: to })
      // 新しい Agent は、先にタブを開いて入力を受け付けるまで待ち、そのターミナルへ送る
      if (to.kind === 'new') {
        setResult(null)
        setLaunching(true)
        const id = await api.launchAgent(to.agent).finally(() => setLaunching(false))
        if (!id) return fail(`${to.agent === 'codex' ? 'Codex' : 'Claude Code'} を起動できませんでした`)
        to = { kind: 'terminal', id }
      }
      const res = await api.invoke('business:send', { promptId: prompt.id, text, target: to, ticket })
      if (res.ok) {
        setResult(res)
        toast({ tone: 'success', message: res.message || '送りました' })
      } else fail(res.message)
    } catch (err) {
      fail(errorText(err, '送れませんでした'))
    }
  })

  const saveOverride = (body: string | null) => run(body === null ? 'reset' : 'save', async () => {
    if (!prompt) return
    const p = await api.invoke('business:savePromptOverride', prompt.id, body)
    setPrompt({ id: prompt.id, text: p.text, base: p.text, body: p.body, missing: p.missing, overridden: p.overridden })
    setTemplateDraft(null)
    toast({ tone: 'success', message: body === null ? '既定に戻しました' : 'このビジネス用に保存しました' })
  })

  const capture = () => run('capture', async () => {
    const res = await api.invoke('business:captureEvidence', { hypothesisId: summary.hypothesis?.id ?? null })
    onSnapshot(res.snapshot)
    toast({ tone: 'success', message: `${res.id} の下書きを作りました` })
    onCaptured(res.id)
  })

  const changeStep = (next: StepId) => run('step', async () => {
    onSnapshot(await api.invoke('business:updateBusiness', { step: next }))
  })

  const counts: Array<[string, string]> = [
    ['仮説', `${summary.counts.hypotheses}`],
    ['証拠', `${summary.counts.evidence}（読了 ${summary.counts.readEvidence}）`],
    ['代替', `${summary.counts.alternatives}`],
    ['聞き取り', `${summary.counts.interviews}`],
    ['実験', `${summary.counts.experiments}`],
    ['承認待ち', `${summary.counts.pendingApprovals}`]
  ]

  return (
    <div className="biz-panel__inner" data-testid="step-panel">
      <header className="biz-panel__head">
        <span className="biz-panel__step biz-mono">{summary.step}</span>
        <h2 className="biz-panel__title">{summary.name}</h2>
        <Badge>{step.phase}</Badge>
        <span className="biz-spacer" />
        <IconButton size="sm" label="パネルを畳む" icon={<ChevronsRight size={14} />} onClick={onCollapse} data-testid="panel-collapse" />
      </header>

      <div className="biz-panel__block">
        <label className="biz-panel__label" htmlFor="biz-step-select">ステップ</label>
        <div className="biz-panel__row">
          <select id="biz-step-select" className="biz-select" value={summary.step} disabled={busy === 'step'} onChange={(e) => void changeStep(e.target.value as StepId)} data-testid="panel-step">
            {STEPS.map((s) => <option key={s.id} value={s.id}>{s.id} {s.name}</option>)}
          </select>
          <Badge tone="brand">{summary.loop}周目</Badge>
        </div>
      </div>

      <div className="biz-panel__block">
        <h3 className="biz-panel__label">出口の確認</h3>
        <ul className="biz-checks" data-testid="panel-checks">
          {summary.checks.map((c) => (
            <li key={c.label} className={c.done ? 'is-done' : ''}>
              {c.done ? <Check size={13} aria-label="済み" /> : <Circle size={11} aria-label="未" />}
              <span>{c.label}</span>
            </li>
          ))}
        </ul>
      </div>

      <div className="biz-panel__block">
        <h3 className="biz-panel__label">データ</h3>
        <dl className="biz-panel__kv">
          {counts.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}
        </dl>
        {summary.hypothesis && (
          <dl className="biz-panel__kv biz-panel__kv--hyp" data-testid="panel-hypothesis">
            <div className="biz-panel__kv-wide"><dt>今の仮説</dt><dd title={summary.hypothesis.name}><span className="biz-mono">{summary.hypothesis.id}</span> {summary.hypothesis.name}</dd></div>
            <div className="biz-panel__kv-wide"><dt>段階</dt><dd>{summary.hypothesis.stage}</dd></div>
            <div className="biz-panel__kv-wide"><dt>需要 D</dt><dd data-testid="panel-demand">{summary.demand}</dd></div>
            <div className="biz-panel__kv-wide"><dt>獲得 A</dt><dd>{summary.acquisition}</dd></div>
            <div><dt>U の残り</dt><dd data-testid="panel-unknowns">{summary.unknowns}</dd></div>
            <div><dt>当事者</dt><dd>{summary.independentParties}</dd></div>
            {summary.next && <div className="biz-panel__kv-wide"><dt>次に確認</dt><dd title={summary.next}>{summary.next}</dd></div>}
          </dl>
        )}
      </div>

      <div className="biz-panel__block">
        <label className="biz-panel__label" htmlFor="biz-prompt-select">プロンプト</label>
        <select id="biz-prompt-select" className="biz-select" value={promptId} onChange={(e) => { setPromptId(e.target.value); setPrompt(null); setResult(null) }} data-testid="panel-prompt">
          {prompts.map((p) => <option key={p.id} value={p.id}>{p.title}</option>)}
        </select>
        <div className="biz-panel__row">
          <Button onClick={() => setOpen((o) => !o)} aria-expanded={open} data-testid="panel-fulltext">{open ? '全文を閉じる' : '全文を見る'}</Button>
          {prompt?.overridden && <Badge tone="brand">上書き</Badge>}
        </div>
        {open && prompt && (
          <div className="biz-panel__prompt">
            <textarea
              className="biz-textarea biz-textarea--mono"
              aria-label="送る全文"
              rows={14}
              value={prompt.text}
              onChange={(e) => setPrompt({ ...prompt, text: e.target.value })}
              data-testid="panel-prompt-text"
            />
            {liveMissing.length > 0 && (
              <p className="biz-issue biz-issue--warning" data-testid="panel-missing">埋まっていない項目：{liveMissing.join('、')}</p>
            )}
            <div className="biz-panel__row">
              {editing && <Button variant="ghost" onClick={() => setPrompt({ ...prompt, text: prompt.base })}>元に戻す</Button>}
              <Tooltip label="このビジネスで使うひな型を直す（{{…}} は送るときに埋まる）">
                <Button variant="ghost" onClick={() => setTemplateDraft((d) => (d === null ? prompt.body : null))} aria-expanded={templateDraft !== null} data-testid="panel-template-toggle">ひな型を直す</Button>
              </Tooltip>
              {prompt.overridden && <Button variant="ghost" icon={<RotateCcw size={13} />} busy={busy === 'reset'} onClick={() => void saveOverride(null)}>既定に戻す</Button>}
            </div>
            {templateDraft !== null && (
              <>
                <textarea
                  className="biz-textarea biz-textarea--mono"
                  aria-label="ひな型"
                  rows={10}
                  value={templateDraft}
                  onChange={(e) => setTemplateDraft(e.target.value)}
                  data-testid="panel-template-text"
                />
                <div className="biz-panel__row">
                  <Button variant="ghost" icon={<Save size={13} />} busy={busy === 'save'} disabled={!templateDraft.trim()} onClick={() => void saveOverride(templateDraft)} data-testid="panel-override">保存</Button>
                  <Button variant="ghost" onClick={() => setTemplateDraft(null)}>閉じる</Button>
                </div>
              </>
            )}
          </div>
        )}
        <label className="biz-panel__label" htmlFor="biz-target-select">送り先</label>
        <div className="biz-panel__row">
          <select id="biz-target-select" className="biz-select" value={target} onChange={(e) => setTarget(e.target.value)} data-testid="panel-target">
            {TARGETS.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
          </select>
          <Button variant="primary" icon={<Send size={13} />} disabled={!prompt?.text.trim()} busy={busy === 'send'} onClick={() => void send()} data-testid="panel-send">送る</Button>
        </div>
        {launching && <p className="biz-muted biz-panel__note" role="status" data-testid="panel-launching">Agent の起動を待っています</p>}
        {result && (
          <p className={`biz-issue biz-issue--${result.ok ? 'ok' : 'error'}`} role={result.ok ? 'status' : 'alert'} data-testid="panel-send-result">
            {result.ok ? result.message || '送りました' : `送れませんでした：${result.message || '理由が分かりません'}`}
          </p>
        )}
      </div>

      <div className="biz-panel__block">
        <Button icon={<FilePlus2 size={13} />} busy={busy === 'capture'} onClick={() => void capture()} data-testid="panel-capture">証拠に追加</Button>
      </div>
    </div>
  )
}

/** 本文の sha256（送る札に結び付ける。main が同じ本文か確かめる） */
async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}
