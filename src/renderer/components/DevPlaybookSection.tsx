import { useEffect, useState, type KeyboardEvent } from 'react'
import { FileText, FileUp, RotateCw, Trash2 } from 'lucide-react'
import { DEV_PLAYBOOK_DIR, DEV_PLAYBOOK_FILE, type DevPlaybookSource, type DevPlaybookState } from '@shared/devPlaybook'
import { defaultLaunchAgent } from '@shared/sendTarget'
import type { DevPlaybookAddResult } from '@shared/ipc'
import { errorMessage } from '../lib/errors'
import { useT } from '../lib/i18n'
import { subscribeIpc } from '../lib/ipcEvents'
import { launchAgentAndWait } from '../lib/sendReview'
import { Badge, Button, IconButton, Row, useToast, type BadgeTone } from '../ui'

type SendResult = { ok: boolean; message: string; noAgent?: boolean }

const STATUS_TONE: Record<DevPlaybookSource['status'], BadgeTone> = { pending: 'neutral', digesting: 'brand', done: 'success', failed: 'warning' }

/**
 * グローバルのオーケストラのダッシュボードの「開発方針」（@shared/devPlaybook）。
 * URL か文を貼って「取り込む」と、グローバルの Agent が読んでルールにまとめ、すべてのプロジェクトの Agent の指示に写る。
 * 一覧は 取り込み中 / 反映済み / 失敗 と、入れる・外す・取り込み直す・消すだけ。方針（playbook.md）はエディタで開く
 */
export function DevPlaybookSection({ onOpenFile }: {
  /** 開いているフォルダ（グローバル）からの相対パスのファイルをエディタで開く */
  onOpenFile?: (path: string) => void
}) {
  const t = useT()
  const toast = useToast()
  const [state, setState] = useState<DevPlaybookState | null>(null)
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let cancelled = false
    void window.ade.invoke('devPlaybook:state').then((s) => { if (!cancelled) setState(s) }).catch(() => undefined)
    const off = subscribeIpc('devPlaybook:changed', (s) => setState(s), 'ui')
    return () => { cancelled = true; off() }
  }, [])

  /** Agent が居なければ既定の Agent をこのフォルダで起動し、渡し直す */
  const deliver = async (first: SendResult | undefined, retry: () => Promise<SendResult>): Promise<void> => {
    let result = first
    if (result?.noAgent) {
      const settings = await window.ade.invoke('app:settings')
      const agent = defaultLaunchAgent(settings.agents?.startupAgents ?? [], settings.agents?.disabledAgents ?? [])
      toast({ tone: 'info', message: t('devPlaybook.starting') })
      result = (await launchAgentAndWait(agent)) ? await retry() : { ok: false, message: t('devPlaybook.noAgent') }
    }
    if (!result) return
    toast(result.ok ? { tone: 'success', message: t('devPlaybook.sent') } : { tone: 'warning', message: result.message })
  }

  const afterAdd = async (added: DevPlaybookAddResult | null) => {
    if (!added) return
    setState(added.state)
    if (added.duplicate) { toast({ tone: 'info', message: t('devPlaybook.duplicate') }); return }
    setValue('')
    await deliver(added.send, () => window.ade.invoke('devPlaybook:digest', added.sourceId))
  }

  const run = (work: () => Promise<void>) => {
    if (busy) return
    setBusy(true)
    void work().catch((err) => toast({ tone: 'warning', message: errorMessage(err) })).finally(() => setBusy(false))
  }

  const add = () => {
    if (!value.trim()) return
    run(async () => afterAdd(await window.ade.invoke('devPlaybook:add', value)))
  }
  const addFile = () => run(async () => afterAdd(await window.ade.invoke('devPlaybook:addFile')))
  const digest = (id: string) => run(async () => deliver(await window.ade.invoke('devPlaybook:digest', id), () => window.ade.invoke('devPlaybook:digest', id)))
  const rebuild = () => run(async () => deliver(await window.ade.invoke('devPlaybook:rebuild'), () => window.ade.invoke('devPlaybook:rebuild')))
  const setEnabled = (id: string, enabled: boolean) => run(async () => setState(await window.ade.invoke('devPlaybook:setEnabled', id, enabled)))
  const remove = (id: string) => run(async () => setState(await window.ade.invoke('devPlaybook:remove', id)))

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // Enter で取り込む。Shift+Enter で改行。変換の確定の Enter は送らない
    if (e.key !== 'Enter' || e.shiftKey || e.nativeEvent.isComposing || e.keyCode === 229) return
    e.preventDefault()
    add()
  }

  if (state && !state.available) return null
  const sources = state?.sources ?? []

  return <section className="orchestra__section dev-playbook" data-testid="dev-playbook">
    <h3>{t('devPlaybook.title')}</h3>
    {sources.length === 0 && <p className="st-note">{t('devPlaybook.empty')}</p>}
    <div className="dev-playbook__add">
      <textarea className="st-textarea dev-playbook__input" rows={2} value={value} placeholder={t('devPlaybook.placeholder')} aria-label={t('devPlaybook.placeholder')}
        disabled={busy} onChange={(e) => setValue(e.target.value)} onKeyDown={onKeyDown} data-testid="dev-playbook-input" />
      <div className="dev-playbook__actions">
        <Button variant="primary" busy={busy} disabled={!value.trim()} onClick={add} data-testid="dev-playbook-add">{t('devPlaybook.add')}</Button>
        <Button variant="ghost" icon={<FileUp size={16} aria-hidden="true" />} disabled={busy} onClick={addFile} data-testid="dev-playbook-add-file">{t('devPlaybook.addFile')}</Button>
      </div>
    </div>
    {state?.rebuild === 'needed' && <p className="st-note dev-playbook__rebuild">
      {t('devPlaybook.rebuildNeeded')}{' '}
      <Button variant="default" disabled={busy} onClick={rebuild} data-testid="dev-playbook-rebuild">{t('devPlaybook.rebuild')}</Button>
    </p>}
    {state?.rebuild === 'running' && <p className="st-note">{t('devPlaybook.rebuilding')}</p>}
    {sources.length > 0 && <div className="dev-playbook__list">
      {sources.map((s) => <Row key={s.id} testId={`dev-playbook-row-${s.id}`} className={s.enabled ? '' : 'is-disabled'}
        title={s.title}
        meta={t(`devPlaybook.kind.${s.kind}`)}
        description={s.status === 'failed' && s.error ? s.error : s.url}
        trailing={<>
          <Badge tone={STATUS_TONE[s.status]}>{t(`devPlaybook.status.${s.status}`)}</Badge>
          <input type="checkbox" role="switch" className="st-switch" checked={s.enabled} disabled={busy} aria-label={t('devPlaybook.enabled')} title={t('devPlaybook.enabled')}
            onChange={(e) => setEnabled(s.id, e.target.checked)} data-testid={`dev-playbook-enabled-${s.id}`} />
          <IconButton size="sm" label={t('devPlaybook.redigest')} icon={<RotateCw size={14} />} disabled={busy} onClick={() => digest(s.id)} data-testid={`dev-playbook-redigest-${s.id}`} />
          <IconButton size="sm" label={t('devPlaybook.remove')} icon={<Trash2 size={14} />} disabled={busy} onClick={() => remove(s.id)} data-testid={`dev-playbook-remove-${s.id}`} />
        </>} />)}
    </div>}
    {state?.playbookPath && onOpenFile && <button type="button" className="st-link dev-playbook__open" onClick={() => onOpenFile(`${DEV_PLAYBOOK_DIR}/${DEV_PLAYBOOK_FILE}`)} title={state.playbookPath} data-testid="dev-playbook-open">
      <FileText size={14} aria-hidden="true" /> {t(state.hasPlaybook ? 'devPlaybook.open' : 'devPlaybook.openEmpty')}
    </button>}
  </section>
}
