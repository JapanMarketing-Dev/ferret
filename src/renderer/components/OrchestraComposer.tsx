import { useState, type KeyboardEvent } from 'react'
import { ArrowUp } from 'lucide-react'
import { orchestraMessage } from '@shared/agentRequests'
import { getLocale } from '@shared/i18n'
import { errorMessage } from '../lib/errors'
import { useT } from '../lib/i18n'
import { useToast } from '../ui'

/**
 * 全体への指示の欄（ChatGPT の入力欄のような1行）。開いている全体（すべてのプロダクト）の Agent に文を送るだけ。
 * ダッシュボードからは全プロダクトへ並行して行うよう添え、フィードバックの帯では開いているプロダクトへの文字のフィードバックとして送る
 * （@shared/agentRequests の orchestraMessage）。Enter で送る、Shift+Enter で改行。変換の確定の Enter は送らない
 */
export function OrchestraComposer({ compact = false, product = null }: { compact?: boolean; product?: { name: string; url?: string } | null }) {
  const t = useT()
  const toast = useToast()
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)

  const send = () => {
    const body = text.trim()
    if (!body || busy) return
    setBusy(true)
    // 人が打った文そのものはオーケストラのフィードバックの記録にも残す（feedback/log.md）
    void window.ade.invoke('agent:sendText', orchestraMessage(body, getLocale() === 'ja' ? 'ja' : 'en', product), { text: body, ...(product ? { product: product.name } : {}) })
      .then((result) => {
        if (result.ok) { setText(''); toast({ tone: 'success', message: t('orchestra.composerSent') }) }
        else toast({ tone: 'warning', message: result.message })
      })
      .catch((err) => toast({ tone: 'warning', message: errorMessage(err) }))
      .finally(() => setBusy(false))
  }
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== 'Enter' || e.shiftKey || e.nativeEvent.isComposing || e.keyCode === 229) return
    e.preventDefault()
    send()
  }

  return <div className={`orchestra-composer${compact ? ' orchestra-composer--compact' : ''}`} data-testid="orchestra-composer">
    <textarea className="orchestra-composer__input" rows={compact ? 1 : 2} value={text} placeholder={product ? t('orchestra.composerProductPlaceholder', { name: product.name }) : t('orchestra.composerPlaceholder')} aria-label={t('orchestra.composerPlaceholder')}
      disabled={busy} onChange={(e) => setText(e.target.value)} onKeyDown={onKeyDown} data-testid="orchestra-composer-input" />
    <button type="button" className="orchestra-composer__send" disabled={busy || !text.trim()} onClick={send} aria-label={t('orchestra.composerSend')} title={t('orchestra.composerSend')} data-testid="orchestra-composer-send">
      <ArrowUp size={16} strokeWidth={2} aria-hidden="true" />
    </button>
  </div>
}
