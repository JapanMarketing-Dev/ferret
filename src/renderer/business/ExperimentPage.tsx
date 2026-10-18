import { useEffect, useState } from 'react'
import { ExternalLink, Send, ShieldCheck, Square, Download, BarChart3 } from 'lucide-react'
import { nextId, type Experiment } from '@shared/business/model'
import { emptyRecord } from '@shared/business/records'
import type { BusinessSnapshot, PageConfig, PageContent, PageStats } from '@shared/business/ipc'
import { Badge, Button, useToast } from '../ui'
import { useBusinessApi } from './api'
import { FieldRow, Section, TextArea, TextInput } from './fields'
import { errorText, linesToList, numberText } from './view'

const EMPTY_CONTENT: PageContent = {
  headline: '',
  subhead: '',
  bullets: [],
  priceText: '',
  ctaLabel: '相談する',
  formIntro: '',
  consentText: '',
  footerNote: ''
}

/**
 * 実験ページ（Cloudflare の Worker）。下書きを送る・公開の承認を依頼する・公開を止める・数を取る。
 * 公開は「実験ページの公開」の承認が済んだ実験だけ（main が確かめる）。
 */
export function ExperimentPage({ experiment, snapshot, onSnapshot, disabled }: {
  experiment: Experiment
  snapshot: BusinessSnapshot
  onSnapshot: (s: BusinessSnapshot) => void
  /** フォームが未保存のあいだは送らない */
  disabled: boolean
}) {
  const api = useBusinessApi()
  const toast = useToast()
  const [config, setConfig] = useState<PageConfig | null>(null)
  const [endpoint, setEndpoint] = useState('')
  const [token, setToken] = useState('')
  const [slug, setSlug] = useState(experiment.page?.slug ?? experiment.id.toLowerCase())
  const [title, setTitle] = useState('')
  const [content, setContent] = useState<PageContent>(EMPTY_CONTENT)
  const [stats, setStats] = useState<PageStats | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    api.invoke('business:pageConfig').then((c) => { if (alive) { setConfig(c); setEndpoint(c.endpoint) } }).catch(() => { if (alive) setConfig({ endpoint: '', hasToken: false }) })
    return () => { alive = false }
  }, [api])

  // 前に送った中身があれば、フォームへ戻す（無ければ空のまま）
  useEffect(() => {
    let alive = true
    api.invoke('business:pageContent', experiment.id).then((saved) => {
      if (!alive || !saved) return
      setSlug(saved.slug)
      setTitle(saved.title)
      setContent(saved.content)
    }).catch(() => undefined)
    return () => { alive = false }
  }, [api, experiment.id])

  const approvals = snapshot.data.approvals.filter((a) => a.kind === '実験ページの公開' && a.refs.includes(experiment.id))
  const approved = approvals.some((a) => a.status === '承認')
  const pending = approvals.some((a) => a.status === '待ち')
  const status = experiment.page?.status ?? 'なし'
  const connected = !!config?.endpoint && !!config.hasToken
  const canApply = experiment.status === '実施中' || experiment.status === '完了'

  const run = async (key: string, fn: () => Promise<void>) => {
    setBusy(key)
    try { await fn() } catch (err) { toast({ tone: 'danger', message: '実行できませんでした', detail: errorText(err) }) } finally { setBusy(null) }
  }

  const push = (publish: boolean) => run(publish ? 'publish' : 'push', async () => {
    const next = await api.invoke('business:pushPage', { experimentId: experiment.id, slug: slug.trim(), title: title.trim(), content, publish })
    onSnapshot(next)
    // 公開は承認済みのときだけ main が行う。結果の状態で知らせる（公開していないのに「公開しました」と言わない）
    const after = next.data.experiments.find((x) => x.id === experiment.id)?.page?.status
    if (publish && after === '公開中') toast({ tone: 'success', message: '公開しました' })
    else if (publish) toast({ tone: 'info', message: '承認がまだなので下書きとして送りました。承認の一覧で判断してください' })
    else toast({ tone: 'success', message: '下書きを送りました' })
  })

  const requestPublish = () => run('request', async () => {
    const id = nextId('approval', snapshot.data.approvals.map((a) => a.id))
    const record = {
      ...emptyRecord('approval', id, new Date().toISOString()),
      kind: '実験ページの公開' as const,
      title: `${experiment.id} の実験ページを公開`,
      detail: `${slug.trim() || experiment.id} を公開して、関心表明を集めます。`,
      refs: [experiment.id, experiment.hypothesis].filter(Boolean),
      options: ['公開する', '公開しない'],
      requestedBy: '画面'
    }
    const res = await api.invoke('business:saveRecord', 'approval', record, '')
    if (!res.ok) {
      toast({ tone: 'danger', message: '依頼できませんでした', detail: res.issues[0]?.message })
      return
    }
    onSnapshot(res.snapshot)
    toast({ tone: 'success', message: `${id} で承認を依頼しました` })
  })

  const set = (patch: Partial<PageContent>) => setContent((c) => ({ ...c, ...patch }))

  return (
    <Section
      title="実験ページ"
      testId="x-page"
      actions={<Badge tone={status === '公開中' ? 'success' : status === '下書き' ? 'brand' : 'neutral'}>{status}</Badge>}
    >
      {!connected && config && (
        <div className="biz-form biz-form--tight" data-testid="x-page-config">
          <TextInput label="接続先" value={endpoint} onChange={setEndpoint} mono placeholder="https://<your-worker>.<your-subdomain>.workers.dev" type="url" />
          <FieldRow label="トークン" id="biz-page-token">
            <div className="field">
              <input id="biz-page-token" className="field__input field__input--mono" type="password" value={token} onChange={(e) => setToken(e.target.value)} autoComplete="off" />
            </div>
          </FieldRow>
          <div className="biz-form__actions">
            <Button
              busy={busy === 'config'}
              onClick={() => void run('config', async () => { const c = await api.invoke('business:setPageConfig', { endpoint: endpoint.trim(), token }); setConfig(c); setToken(''); toast({ tone: 'success', message: '接続を保存しました' }) })}
            >
              接続を保存
            </Button>
          </div>
        </div>
      )}
      <div className="biz-form">
        <TextInput label="スラッグ" value={slug} onChange={setSlug} mono testId="x-page-slug" />
        <TextInput label="ページ名" value={title} onChange={setTitle} />
        <TextInput label="見出し" value={content.headline} onChange={(headline) => set({ headline })} wide testId="x-page-headline" />
        <TextInput label="小見出し" value={content.subhead} onChange={(subhead) => set({ subhead })} wide />
        <TextArea label="箇条書き（1行1件）" value={content.bullets.join('\n')} onChange={(v) => set({ bullets: linesToList(v) })} rows={3} />
        <TextInput label="価格の表記" value={content.priceText} onChange={(priceText) => set({ priceText })} />
        <TextInput label="ボタンの文言" value={content.ctaLabel} onChange={(ctaLabel) => set({ ctaLabel })} />
        <TextInput label="フォームの前置き" value={content.formIntro} onChange={(formIntro) => set({ formIntro })} wide />
        <TextInput label="同意の文" value={content.consentText} onChange={(consentText) => set({ consentText })} wide />
        <TextInput label="注記" value={content.footerNote} onChange={(footerNote) => set({ footerNote })} wide />
      </div>
      <div className="biz-actions" data-testid="x-page-actions">
        <Button icon={<Send size={13} />} disabled={disabled || !connected || !slug.trim()} busy={busy === 'push'} onClick={() => void push(false)} data-testid="x-page-push">下書きを送る</Button>
        {approved ? (
          <Button variant="primary" icon={<ExternalLink size={13} />} disabled={disabled || !connected || status === '公開中'} busy={busy === 'publish'} onClick={() => void push(true)} data-testid="x-page-publish">公開する</Button>
        ) : (
          <Button icon={<ShieldCheck size={13} />} disabled={disabled || pending} busy={busy === 'request'} onClick={() => void requestPublish()} data-testid="x-page-request">
            {pending ? '承認待ち' : '公開の承認を依頼'}
          </Button>
        )}
        <Button icon={<Square size={13} />} disabled={status !== '公開中'} busy={busy === 'unpublish'} onClick={() => void run('unpublish', async () => { onSnapshot(await api.invoke('business:unpublishPage', experiment.id)); toast({ tone: 'success', message: '公開を止めました' }) })}>公開を止める</Button>
        <span className="biz-spacer" />
        <Button variant="ghost" icon={<BarChart3 size={13} />} disabled={!connected || status === 'なし'} busy={busy === 'stats'} onClick={() => void run('stats', async () => setStats(await api.invoke('business:pageStats', experiment.id)))}>数を取得</Button>
        <Button variant="ghost" icon={<Download size={13} />} disabled={!stats || !canApply || disabled} busy={busy === 'apply'} title={!canApply ? '実施中か完了の実験だけ入れられます' : undefined} onClick={() => void run('apply', async () => { onSnapshot(await api.invoke('business:applyPageStats', experiment.id)); toast({ tone: 'success', message: '実測へ入れました' }) })}>実測へ入れる</Button>
      </div>
      {stats && (
        <dl className="biz-stats" data-testid="x-page-stats">
          <div><dt>表示</dt><dd>{numberText(stats.views)}</dd></div>
          <div><dt>訪問者</dt><dd>{numberText(stats.uniqueVisitors)}</dd></div>
          <div><dt>ボタン</dt><dd>{numberText(stats.ctaClicks)}</dd></div>
          <div><dt>関心表明</dt><dd>{numberText(stats.interests)}</dd></div>
          <div><dt>期間</dt><dd>{stats.from.slice(0, 10)}〜{stats.to.slice(0, 10)}</dd></div>
        </dl>
      )}
    </Section>
  )
}
