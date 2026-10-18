import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { AlertTriangle, Check, CheckCircle2, ExternalLink, ImagePlus, Link2, Send, Sparkles, Upload, X, XCircle } from 'lucide-react'
import { Badge, Button, EmptyState, Field, IconButton, Progress, useToast } from '@/ui'
import { useT } from '@/lib/i18n'
import { errorMessage } from '@/lib/errors'
import { formatDateTime, type TranslationKey } from '@shared/i18n'
import { projectMediaUrl } from '@shared/fileViewer'
import {
  TARGET_LABEL,
  TIKTOK_PRIVACY,
  YT_DESCRIPTION_MAX_BYTES,
  YT_PRIVACY,
  YT_TAGS_MAX,
  YT_TITLE_MAX,
  charCount,
  chaptersFromDescription,
  issueText,
  okState,
  tagsLength,
  utf8Bytes,
  type OkState,
  type PublishIssue,
  type PublishTargetId,
  type PublishTargetResult,
  type VideoPublishAccount,
  type VideoPublishAccounts,
  type VideoPublishState,
  type VideoThumbFile
} from '../../shared/publish'
import type { VideoPublishPromptKind } from '../../shared/ipc/publish'
import { sendVideoPrompt } from '../agentSend'
import './publish.css'

/**
 * 投稿前の確認（1本の動画）。完成動画・サムネイル・AI が publish.json に書いたもの（タイトル・説明・タグ・投稿先ごとの公開範囲・チャプター）を見せ、
 * 人が確かめて「OK・投稿する」を押すと、投稿プロンプトをエージェントへ送る。エージェントが publish.json を見直して
 * `ferret-video publish upload` を実行し、アプリ（main）が自分のトークンで上げ、結果がここに出る。**OK まで何も投稿しない。**
 * 直したいところは「AI に直してもらう」に一言書いて送る。動画タブの画面に埋め込んで使う（担当: 投稿）。
 */
export function PublishView({ videoDir, videoTitle, onClose }: { videoDir: string; videoTitle: string; onClose: () => void }) {
  const t = useT()
  const toast = useToast()
  const [view, setView] = useState<VideoPublishState | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [accounts, setAccounts] = useState<VideoPublishAccounts | null>(null)
  const [thumbs, setThumbs] = useState<VideoThumbFile[] | null>(null)
  const [sentAt, setSentAt] = useState<number | null>(null)
  const [fix, setFix] = useState('')
  const [busy, setBusy] = useState<'ok' | 'fix' | 'thumbs' | 'connect' | null>(null)
  const [now, setNow] = useState(() => Date.now())

  const load = useCallback(async () => {
    try {
      const [state, list] = await Promise.all([
        window.ade.invoke('video:publish:load', videoDir),
        window.ade.invoke('video:publish:thumbnails', videoDir)
      ])
      setView(state)
      setThumbs(list)
      setLoadError(null)
    } catch (err) {
      setLoadError(errorMessage(err))
    }
  }, [videoDir])

  useEffect(() => {
    setView(null)
    setThumbs(null)
    setSentAt(null)
    void load()
    void window.ade.invoke('video:publish:accounts').then(setAccounts, () => undefined)
  }, [load])
  // main が見張っている publish.json・thumbnails/・受け渡しの結果が変わった
  useEffect(() => window.ade.on('video:publish:changed', () => void load()), [load])
  // 「送った」の保留は時間で解ける
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 15_000)
    return () => clearInterval(id)
  }, [])
  // エージェントがアップロードを始めた: 保留は終わり
  useEffect(() => {
    if (view?.result?.state === 'running') setSentAt(null)
  }, [view?.result?.state, view?.result?.id])

  const send = async (kind: VideoPublishPromptKind, busyKey: 'ok' | 'fix' | 'thumbs', text?: string) => {
    if (busy) return
    setBusy(busyKey)
    try {
      const prompt = await window.ade.invoke('video:publish:prompt', videoDir, kind, text)
      const res = await sendVideoPrompt(prompt.text, (agent) => toast({ tone: 'info', message: t('video.publish.starting', { agent }) }))
      if (!res.ok) {
        toast({ tone: 'warning', message: res.message })
        return
      }
      if (kind === 'publish') setSentAt(Date.now())
      if (kind === 'fix') setFix('')
      toast({ tone: 'success', message: t(kind === 'publish' ? 'video.publish.sentOk' : kind === 'thumbnails' ? 'video.publish.thumbSent' : 'video.publish.sentFix') })
    } catch (err) {
      toast({ tone: 'warning', message: errorMessage(err) })
    } finally {
      setBusy(null)
    }
  }

  const connect = async (target: PublishTargetId) => {
    if (busy) return
    setBusy('connect')
    try {
      setAccounts(await window.ade.invoke('video:publish:connect', target))
      toast({ tone: 'success', message: t('video.publish.connectDone', { target: TARGET_LABEL[target] }) })
    } catch (err) {
      toast({ tone: 'warning', message: errorMessage(err) })
    } finally {
      setBusy(null)
    }
  }

  const update = async (work: () => Promise<VideoPublishState>) => {
    try {
      setView(await work())
    } catch (err) {
      toast({ tone: 'warning', message: errorMessage(err) })
    }
  }
  const setPrivacy = (target: PublishTargetId, value: string) => void update(() => window.ade.invoke('video:publish:setPrivacy', videoDir, target, value))
  const pickThumb = (img: VideoThumbFile) => {
    const next = view?.spec?.thumbnail === img.rel ? null : img.rel
    void update(() => window.ade.invoke('video:publish:setThumbnail', videoDir, next))
  }

  const header = (
    <header className="vpub__head">
      <div className="vpub__heading">
        <h2>{t('video.publish.heading')}</h2>
        <span className="vpub__video-title">{videoTitle}</span>
      </div>
      <IconButton label={t('common.close')} icon={<X size={16} />} onClick={onClose} data-testid="video-publish-close" />
    </header>
  )

  if (!view) {
    return <section className="vpub" data-testid="video-publish">
      {header}
      {loadError ? <p className="vpub__error" role="alert">{loadError}</p> : <p className="vpub__muted">{t('video.publish.loading')}</p>}
    </section>
  }

  const spec = view.spec
  if (!view.exists || !spec) {
    return <section className="vpub" data-testid="video-publish">
      {header}
      <EmptyState
        title={view.exists ? t('video.publish.brokenTitle') : t('video.publish.noFileTitle')}
        description={view.exists ? view.issues.map(issueText).join(' / ') : t('video.publish.noFileText')}
        actions={<Button variant="primary" icon={<Sparkles size={14} />} busy={busy === 'fix'} onClick={() => void send(view.exists ? 'fix' : 'make', 'fix')}>
          {view.exists ? t('video.publish.askFix') : t('video.publish.askMake')}
        </Button>}
      />
    </section>
  }

  const state = okState(view, accounts, sentAt, now)
  const errors = view.issues.filter((i) => i.level === 'error')
  const warnings = view.issues.filter((i) => i.level === 'warning')
  const chapters = chaptersFromDescription(spec.description)
  const privacyLabel = (target: PublishTargetId) => target === 'youtube'
    ? t(`video.publish.privacy.${spec.youtube.privacy}` as TranslationKey)
    : t(`video.publish.ttPrivacy.${spec.tiktok.privacy}` as TranslationKey)

  return <section className="vpub" data-testid="video-publish">
    {header}
    <div className="vpub__body">
      <div className="vpub__media">
        {view.videoMedia
          ? <video key={`${view.videoMedia}:${view.videoSize ?? 0}`} className="vpub__video" src={projectMediaUrl(view.videoMedia, view.videoSize)} controls preload="metadata"
            poster={view.thumbnailMedia ? projectMediaUrl(view.thumbnailMedia) : undefined} data-testid="video-publish-player" />
          : <div className="vpub__video vpub__video--missing"><AlertTriangle size={16} aria-hidden="true" />{t('video.publish.noVideo', { path: spec.video })}</div>}

        <Thumbnails thumbs={thumbs} selected={spec.thumbnail ?? null} busy={busy === 'thumbs'} onPick={pickThumb} onAsk={() => void send('thumbnails', 'thumbs')} />
        <ResultPanel view={view} />
      </div>

      <div className="vpub__side">
        <Block label={t('video.publish.field.title')} count={`${charCount(spec.title)}/${YT_TITLE_MAX}`} over={charCount(spec.title) > YT_TITLE_MAX}>
          <p className="vpub__title" data-testid="video-publish-title">{spec.title || '—'}</p>
        </Block>
        <Block label={t('video.publish.field.description')} count={t('video.publish.bytes', { n: utf8Bytes(spec.description), max: YT_DESCRIPTION_MAX_BYTES })} over={utf8Bytes(spec.description) > YT_DESCRIPTION_MAX_BYTES}>
          <p className="vpub__desc">{spec.description || '—'}</p>
        </Block>
        <Block label={t('video.publish.field.tags')} count={`${tagsLength(spec.tags)}/${YT_TAGS_MAX}`} over={tagsLength(spec.tags) > YT_TAGS_MAX}>
          <div className="vpub__tags">{spec.tags.length ? spec.tags.map((x) => <Badge key={x}>#{x}</Badge>) : <span className="vpub__muted">—</span>}</div>
        </Block>
        {spec.youtube.enabled && spec.youtube.chapters && <Block label={t('video.publish.field.chapters')}>
          {chapters.length
            ? <ol className="vpub__chapters">{chapters.map((c) => <li key={`${c.at}-${c.title}`}><span className="vpub__mono">{c.label}</span>{c.title}</li>)}</ol>
            : <span className="vpub__muted">{t('video.publish.noChapters')}</span>}
        </Block>}

        <TargetRow target="youtube" on={spec.youtube.enabled} account={accounts?.youtube} published={view.published.youtube?.url}
          privacy={{
            value: spec.youtube.privacy,
            options: YT_PRIVACY.map((v) => ({ value: v, label: t(`video.publish.privacy.${v}` as TranslationKey) })),
            defaulted: spec.youtube.privacyDefaulted,
            locked: Boolean(spec.youtube.publishAt),
            onChange: (v) => setPrivacy('youtube', v)
          }}
          details={[
            spec.youtube.publishAt ? t('video.publish.scheduled', { at: formatDateTime(new Date(spec.youtube.publishAt)) }) : '',
            spec.youtube.madeForKids ? t('video.publish.forKids') : t('video.publish.notForKids'),
            spec.youtube.containsSyntheticMedia ? t('video.publish.synthetic') : ''
          ]}
          busy={busy === 'connect'} onConnect={() => void connect('youtube')} />
        <TargetRow target="tiktok" on={spec.tiktok.enabled} account={accounts?.tiktok} published={view.published.tiktok?.url}
          privacy={{
            value: spec.tiktok.privacy,
            options: TIKTOK_PRIVACY.map((v) => ({ value: v, label: t(`video.publish.ttPrivacy.${v}` as TranslationKey) })),
            defaulted: spec.tiktok.privacyDefaulted,
            onChange: (v) => setPrivacy('tiktok', v)
          }}
          details={[spec.tiktok.isAigc ? t('video.publish.aigc') : '']}
          caption={spec.tiktok.enabled ? spec.tiktok.caption : undefined}
          busy={busy === 'connect'} onConnect={() => void connect('tiktok')}
          onManual={() => void window.ade.invoke('video:publish:openTikTokUpload', videoDir).catch((err: unknown) => toast({ tone: 'warning', message: errorMessage(err) }))} />

        {(errors.length > 0 || warnings.length > 0) && <Issues errors={errors} warnings={warnings} />}

        <div className="vpub__fix">
          <Field className="vpub__grow" value={fix} maxLength={500} placeholder={t('video.publish.fixPlaceholder')} aria-label={t('video.publish.askFix')}
            onChange={(e) => setFix(e.target.value)} data-testid="video-publish-fix"
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) void send('fix', 'fix', fix) }} />
          <Button icon={<Sparkles size={14} />} busy={busy === 'fix'} disabled={busy !== null && busy !== 'fix'} onClick={() => void send('fix', 'fix', fix)} data-testid="video-publish-fix-send">
            {t('video.publish.askFix')}
          </Button>
        </div>

        <div className="vpub__go">
          {state.kind === 'ready' && <ul className="vpub__confirm" data-testid="video-publish-confirm">
            {state.targets.map((x) => <li key={x}>{t('video.publish.confirmPrivacy', { target: TARGET_LABEL[x], privacy: privacyLabel(x) })}</li>)}
          </ul>}
          <OkButton state={state} busy={busy === 'ok'} onOk={() => void send('publish', 'ok')} onConnect={(x) => void connect(x)} />
          <p className="vpub__muted">{errors.length > 0 && state.kind === 'ready' ? t('video.publish.okWithIssues') : t('video.publish.okNothingYet')}</p>
        </div>
      </div>
    </div>
  </section>
}

function Block({ label, count, over, children }: { label: string; count?: string; over?: boolean; children: ReactNode }) {
  return <div className="vpub__block">
    <div className="vpub__block-head">
      <span className="vpub__label">{label}</span>
      {count && <span className={`vpub__mono vpub__count${over ? ' is-over' : ''}`}>{count}</span>}
    </div>
    {children}
  </div>
}

function Thumbnails({ thumbs, selected, busy, onPick, onAsk }: {
  thumbs: VideoThumbFile[] | null
  selected: string | null
  busy: boolean
  onPick: (img: VideoThumbFile) => void
  onAsk: () => void
}) {
  const t = useT()
  return <div className="vpub__block">
    <div className="vpub__block-head">
      <span className="vpub__label">{t('video.publish.field.thumbnail')}</span>
      <span className="vpub__mono vpub__muted">{selected ?? t('video.publish.noThumb')}</span>
      <Button variant="ghost" icon={<ImagePlus size={14} />} busy={busy} onClick={onAsk} data-testid="video-publish-thumbs-ask">{t('video.publish.thumbAsk')}</Button>
    </div>
    {thumbs && thumbs.length > 0
      ? <>
        <p className="vpub__muted">{t('video.publish.thumbHint')}</p>
        <div className="vpub__thumbs" data-testid="video-publish-thumbs">
          {thumbs.map((img) => <button key={img.rel} type="button" className={`vpub__thumb${selected === img.rel ? ' is-selected' : ''}`} aria-pressed={selected === img.rel}
            title={img.rel} onClick={() => onPick(img)}>
            <img src={projectMediaUrl(img.media, Math.round(img.mtimeMs))} alt={img.rel} loading="lazy" />
            {selected === img.rel && <Check size={14} className="vpub__thumb-check" aria-hidden="true" />}
          </button>)}
        </div>
      </>
      : thumbs && <p className="vpub__muted">{t('video.publish.thumbEmpty')}</p>}
  </div>
}

function TargetRow({ target, on, account, published, privacy, details, caption, busy, onConnect, onManual }: {
  target: PublishTargetId
  on: boolean
  account?: VideoPublishAccount
  published?: string
  privacy: { value: string; options: { value: string; label: string }[]; defaulted: boolean; locked?: boolean; onChange: (v: string) => void }
  details: string[]
  caption?: string
  busy: boolean
  onConnect: () => void
  onManual?: () => void
}) {
  const t = useT()
  const label = TARGET_LABEL[target]
  return <div className={`vpub__target${on ? '' : ' is-off'}`} data-target={target} data-testid={`video-publish-target-${target}`}>
    <div className="vpub__target-head">
      <strong>{label}</strong>
      <Badge tone={on ? 'brand' : 'neutral'}>{on ? t('video.publish.on') : t('video.publish.off')}</Badge>
      <span className="vpub__spacer" />
      {!account ? null : account.connected
        ? <span className="vpub__status"><CheckCircle2 size={13} aria-hidden="true" />{account.name ?? t('video.publish.connected')}</span>
        : account.configured
          ? <Button variant="ghost" icon={<Link2 size={14} />} busy={busy} onClick={onConnect}>{t('video.publish.connectTo', { target: label })}</Button>
          : <span className="vpub__muted">{target === 'tiktok' ? t('video.publish.ttPreparing') : t('video.publish.ytNoClient')}</span>}
    </div>
    {on && <label className="vpub__privacy">
      <span className="vpub__label">{t('video.publish.privacyLabel')}</span>
      <select className="vpub__select" value={privacy.value} disabled={privacy.locked} aria-label={`${label} ${t('video.publish.privacyLabel')}`}
        onChange={(e) => privacy.onChange(e.target.value)} data-testid={`video-publish-privacy-${target}`}>
        {privacy.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
      <span className="vpub__muted">{privacy.locked ? t('video.publish.privacyScheduled') : privacy.defaulted ? t('video.publish.privacyFromSettings') : t('video.publish.privacyThisVideo')}</span>
    </label>}
    {on && details.some(Boolean) && <p className="vpub__muted">{details.filter(Boolean).join(' · ')}</p>}
    {caption !== undefined && <p className="vpub__caption">{caption}</p>}
    {target === 'tiktok' && on && account?.connected && <p className="vpub__muted">{account.directPost ? t('video.publish.ttDirect') : t('video.publish.ttInboxNote')}</p>}
    {published && <ExternalUrl url={published} />}
    {target === 'tiktok' && on && account && !account.configured && onManual && <div>
      <Button icon={<ExternalLink size={14} />} onClick={onManual} data-testid="video-publish-tiktok-manual">{t('video.publish.ttManual')}</Button>
    </div>}
  </div>
}

function ExternalUrl({ url }: { url: string }) {
  return <a className="vpub__link" href={url} onClick={(e) => { e.preventDefault(); void window.ade.invoke('app:openExternal', url) }}>
    <ExternalLink size={12} aria-hidden="true" />{url}
  </a>
}

function Issues({ errors, warnings }: { errors: PublishIssue[]; warnings: PublishIssue[] }) {
  const t = useT()
  return <div className="vpub__issues" data-testid="video-publish-issues">
    {errors.length > 0 && <>
      <span className="vpub__label">{t('video.publish.errorsTitle', { n: errors.length })}</span>
      <ul>{errors.map((i, k) => <li key={`e${k}`} className="is-error"><XCircle size={12} aria-hidden="true" />{issueText(i)}</li>)}</ul>
    </>}
    {warnings.length > 0 && <details>
      <summary className="vpub__label">{t('video.publish.warningsTitle', { n: warnings.length })}</summary>
      <ul>{warnings.map((i, k) => <li key={`w${k}`}><AlertTriangle size={12} aria-hidden="true" />{issueText(i)}</li>)}</ul>
    </details>}
  </div>
}

const OK_LABEL: Record<Exclude<OkState['kind'], 'connect'>, TranslationKey> = {
  ready: 'video.publish.ok',
  'no-file': 'video.publish.okNoFile',
  'no-video': 'video.publish.okNoVideo',
  'no-target': 'video.publish.okNoTarget',
  sent: 'video.publish.okSent',
  running: 'video.publish.okRunning',
  published: 'video.publish.okPublished'
}

function OkButton({ state, busy, onOk, onConnect }: { state: OkState; busy: boolean; onOk: () => void; onConnect: (target: PublishTargetId) => void }) {
  const t = useT()
  if (state.kind === 'connect') {
    return <Button variant="primary" className="vpub__ok" icon={<Link2 size={16} />} onClick={() => onConnect(state.target)} data-testid="video-publish-ok">
      {t('video.publish.connectFirst', { target: TARGET_LABEL[state.target] })}
    </Button>
  }
  return <Button variant="primary" className="vpub__ok" data-testid="video-publish-ok"
    icon={state.kind === 'sent' || state.kind === 'running' ? <Send size={16} /> : <Upload size={16} />}
    busy={busy || state.kind === 'running'} disabled={state.kind !== 'ready'} onClick={onOk}>
    {t(OK_LABEL[state.kind])}
  </Button>
}

function phaseText(t: ReturnType<typeof useT>, phase: string): string {
  return ['auth', 'start', 'upload', 'thumbnail', 'processing', 'done'].includes(phase) ? t(`video.publish.phase.${phase}` as TranslationKey) : phase
}

function ResultPanel({ view }: { view: VideoPublishState }) {
  const t = useT()
  const r = view.result
  if (!r) return null
  if (r.state === 'running') {
    const p = r.progress
    return <div className="vpub__result" data-testid="video-publish-result">
      <span className="vpub__label">{t('video.publish.uploading', { target: p ? TARGET_LABEL[p.target] : '' })}</span>
      <Progress {...(p?.fraction !== undefined ? { value: p.fraction } : {})} label={t('video.publish.uploading', { target: p ? TARGET_LABEL[p.target] : '' })} />
      {p?.phase && <span className="vpub__muted">{phaseText(t, p.phase)}</span>}
      {r.results.map((x) => <ResultLine key={x.target} r={x} />)}
    </div>
  }
  return <div className="vpub__result" data-testid="video-publish-result">
    <span className="vpub__label">{t('video.publish.lastResult')} {r.at && <span className="vpub__muted">{formatDateTime(new Date(r.at))}</span>}</span>
    {r.error && <p className="vpub__error">{r.error}</p>}
    {r.results.map((x) => <ResultLine key={x.target} r={x} />)}
  </div>
}

function ResultLine({ r }: { r: PublishTargetResult }) {
  const t = useT()
  const text = r.ok
    ? r.alreadyPublished ? t('video.publish.already') : r.status === 'inbox' ? t('video.publish.inbox') : r.status === 'scheduled' ? t('video.publish.scheduledDone') : t('video.publish.posted')
    : t('video.publish.failed')
  return <div className={`vpub__resline${r.ok ? ' is-ok' : ' is-fail'}`}>
    <div className="vpub__resline-head">
      {r.ok ? <CheckCircle2 size={14} aria-hidden="true" /> : <XCircle size={14} aria-hidden="true" />}
      <strong>{TARGET_LABEL[r.target]}</strong>
      <span>{text}</span>
    </div>
    {r.url && <ExternalUrl url={r.url} />}
    {r.error && <p className="vpub__error">{r.error}</p>}
    {r.warnings?.map((w) => <p key={w} className="vpub__muted">{w}</p>)}
  </div>
}
