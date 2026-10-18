import { useEffect, useState } from 'react'
import { Check, X } from 'lucide-react'
import type { Approval } from '@shared/business/model'
import type { BusinessSnapshot } from '@shared/business/ipc'
import type { SentPrompt } from '@shared/business/model'
import { Badge, Button, EmptyState, useToast } from '../ui'
import { useBusinessApi } from './api'
import { dateTimeText, errorText, sortApprovals } from './view'

/** 承認待ち1件（選択肢つき。推奨は先頭） */
function PendingApproval({ approval, onDecided, highlight }: { approval: Approval; onDecided: (s: BusinessSnapshot) => void; highlight: boolean }) {
  const api = useBusinessApi()
  const toast = useToast()
  const [choice, setChoice] = useState<string>(approval.options[0] ?? '')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState<null | '承認' | '却下'>(null)
  const decide = async (status: '承認' | '却下') => {
    setBusy(status)
    try {
      const answer = [choice, note.trim()].filter(Boolean).join('：')
      const next = await api.invoke('business:decideApproval', approval.id, status, answer)
      onDecided(next)
      toast({ tone: 'success', message: `${approval.id} を${status}しました` })
    } catch (err) {
      toast({ tone: 'danger', message: `${status}できませんでした`, detail: errorText(err) })
    } finally {
      setBusy(null)
    }
  }
  const nameBase = `approval-${approval.id}`
  return (
    <article className={`biz-approval${highlight ? ' is-highlight' : ''}`} data-testid={`approval-${approval.id}`} aria-label={approval.title}>
      <header className="biz-approval__head">
        <span className="biz-mono biz-muted">{approval.id}</span>
        <Badge tone="warning">{approval.kind}</Badge>
        <h3 className="biz-approval__title" title={approval.title}>{approval.title || '件名なし'}</h3>
        <span className="biz-spacer" />
        <span className="biz-muted biz-nowrap">{approval.requestedBy || '依頼元なし'}・{dateTimeText(approval.requestedAt)}</span>
      </header>
      {approval.detail && <p className="biz-approval__detail">{approval.detail}</p>}
      {approval.refs.length > 0 && (
        <div className="biz-approval__refs">{approval.refs.map((r) => <span key={r} className="biz-id-chip"><span>{r}</span></span>)}</div>
      )}
      {approval.options.length > 0 && (
        <fieldset className="biz-options">
          <legend className="biz-sr">選択肢</legend>
          {approval.options.map((o, i) => (
            <label key={o} className={`biz-option${choice === o ? ' is-checked' : ''}`}>
              <input type="radio" name={nameBase} value={o} checked={choice === o} onChange={() => setChoice(o)} />
              <span className="biz-ellipsis" title={o}>{o}</span>
              {i === 0 && <Badge tone="brand">推奨</Badge>}
            </label>
          ))}
        </fieldset>
      )}
      <div className="biz-approval__foot">
        <div className="field biz-approval__note">
          <input className="field__input" aria-label={`${approval.id} の回答`} placeholder="回答" value={note} onChange={(e) => setNote(e.target.value)} data-testid={`${nameBase}-note`} />
        </div>
        <Button variant="danger" icon={<X size={13} />} busy={busy === '却下'} disabled={busy !== null} onClick={() => void decide('却下')} data-testid={`${nameBase}-reject`}>却下</Button>
        <Button variant="primary" icon={<Check size={13} />} busy={busy === '承認'} disabled={busy !== null} onClick={() => void decide('承認')} data-testid={`${nameBase}-approve`}>承認</Button>
      </div>
    </article>
  )
}

export function Approvals({ snapshot, onSnapshot, focusId }: { snapshot: BusinessSnapshot; onSnapshot: (s: BusinessSnapshot) => void; focusId: string | null }) {
  const { pending, decided } = sortApprovals(snapshot.data.approvals)
  return (
    <div className="biz-list" data-testid="approvals">
      <header className="biz-list__head">
        <h2 className="biz-h2">人の判断と承認</h2>
        <span className="biz-count">待ち {pending.length} 件</span>
      </header>
      {pending.length === 0 ? (
        <EmptyState size="sm" title="承認待ちはありません" />
      ) : (
        <div className="biz-approvals">{pending.map((a) => <PendingApproval key={a.id} approval={a} onDecided={onSnapshot} highlight={a.id === focusId} />)}</div>
      )}
      {decided.length > 0 && (
        <>
          <h3 className="biz-h3">決めたもの</h3>
          <table className="biz-table" data-testid="approvals-decided">
            <thead><tr><th scope="col">ID</th><th scope="col">種類</th><th scope="col" className="biz-col-grow">件名</th><th scope="col">結果</th><th scope="col">回答</th><th scope="col">日時</th></tr></thead>
            <tbody>
              {decided.map((a) => (
                <tr key={a.id} data-testid={`decided-${a.id}`}>
                  <td className="biz-nowrap biz-mono">{a.id}</td>
                  <td className="biz-nowrap">{a.kind}</td>
                  <td className="biz-col-grow"><span className="biz-ellipsis" title={a.title}>{a.title}</span></td>
                  <td className="biz-nowrap"><Badge tone={a.status === '承認' ? 'success' : 'danger'}>{a.status}</Badge></td>
                  <td><span className="biz-ellipsis" title={a.answer}>{a.answer}</span></td>
                  <td className="biz-nowrap">{dateTimeText(a.decidedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </div>
  )
}

export function SentHistory({ snapshot }: { snapshot: BusinessSnapshot }) {
  const api = useBusinessApi()
  const [items, setItems] = useState<SentPrompt[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [open, setOpen] = useState<string | null>(null)
  // biome-ignore lint/correctness/useExhaustiveDependencies: snapshot は読み直しの合図（送るたびに履歴が増える）
  useEffect(() => {
    let alive = true
    api.invoke('business:sentHistory').then((list) => { if (alive) { setItems(list); setError(null) } }).catch((err) => { if (alive) setError(errorText(err, '履歴を読み込めませんでした')) })
    return () => { alive = false }
  }, [api, snapshot])
  const sorted = [...(items ?? [])].sort((a, b) => b.at.localeCompare(a.at))
  return (
    <div className="biz-list" data-testid="history">
      <header className="biz-list__head">
        <h2 className="biz-h2">送った履歴</h2>
        {items && <span className="biz-count">{items.length} 件</span>}
      </header>
      {error && <p className="biz-issue biz-issue--error" role="alert">{error}</p>}
      {items && items.length === 0 && <EmptyState size="sm" title="まだ送っていません" />}
      {sorted.length > 0 && (
        <table className="biz-table">
          <thead><tr><th scope="col">日時</th><th scope="col">ステップ</th><th scope="col" className="biz-col-grow">プロンプト</th><th scope="col">送り先</th><th scope="col"><span className="biz-sr">全文</span></th></tr></thead>
          <tbody>
            {sorted.flatMap((s) => {
              const rows = [
                <tr key={s.id} data-testid={`sent-${s.id}`}>
                  <td className="biz-nowrap">{dateTimeText(s.at)}</td>
                  <td className="biz-nowrap biz-mono">{s.step}</td>
                  <td className="biz-col-grow"><span className="biz-ellipsis biz-mono">{s.promptId}</span></td>
                  <td className="biz-nowrap">{s.target}</td>
                  <td className="biz-nowrap"><Button variant="ghost" onClick={() => setOpen(open === s.id ? null : s.id)} aria-expanded={open === s.id}>{open === s.id ? '閉じる' : '全文'}</Button></td>
                </tr>
              ]
              if (open === s.id) rows.push(<tr key={`${s.id}-body`} className="biz-tr-detail"><td colSpan={5}><pre className="biz-pre">{s.body}</pre></td></tr>)
              return rows
            })}
          </tbody>
        </table>
      )}
    </div>
  )
}
