import { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowDown, ArrowUp, Download, ExternalLink, GitBranch, RefreshCw } from 'lucide-react'
import { branchWebUrl, type GitActionResult, type GitRepoStatus } from '@shared/github'
import { elapsedLabel, gitActionAvailability, type GitSyncErrorKind } from '@shared/gitSync'
import type { TranslationKey } from '@shared/i18n'
import { useT, type TFunction } from '../lib/i18n'
import { errorMessage } from '../lib/errors'
import { subscribeIpc } from '../lib/ipcEvents'
import { StatusPopover } from './StatusPopover'
import { FOCUS_RELOAD_MIN_GAP_MS, FS_RELOAD_DEBOUNCE_MS, FS_RELOAD_MIN_GAP_MS, GIT_STATUS_POLL_MS as POLL_MS, reloadDelay } from '../lib/idlePolling'
import '../styles/github.css'

/**
 * フッターの「どの GitHub / GitLab（またはほかのリモート）の、どのブランチか」。例: [GitHub] JapanMarketing-Dev/ferret · develop •3 ↑1 ↓2
 *
 * 読み直すのは、プロジェクトの切り替え・.git/HEAD と index の変化（main が知らせる）・ファイルの変更（fs:changed。まとめて、前回から
 * FS_RELOAD_MIN_GAP_MS は空ける）・ウインドウを前に出したとき（前回から FOCUS_RELOAD_MIN_GAP_MS 以上たっていれば）・5 分ごとの予備。
 * 何も変わらない間は git を走らせない（以前は 30 秒ごとと前に出すたびに git を3回ずつ走らせていた）。
 * 遅れ（↓）が古くならないよう、裏で fetch する：プロジェクトを開いたとき（起動時・切り替えを含む）はすぐ、
 * あとはウインドウが見えている間 5 分ごとと前に出したとき（間隔・失敗の間の延ばし方は main と src/shared/gitSync.ts が決める）。
 * 失敗はトーストにせず、吹き出しに最後に確認した時刻と一緒に静かに出す。
 *
 * 押すと吹き出し：リモートの変更を確認・最新を取得（fast-forward だけ）・同期（取得してから、確認のうえ push）と、ページを開くリンク。
 * 分かれている・未コミットの変更とぶつかるときは取り込まず、Agent かターミナルで直すよう案内する。
 * git でないフォルダでは何も出さない（後ろの区切り線も含めて。線だけが残らないよう、区切り線はこの部品が出す）。
 */


/** GitHub のマーク（単色）。Octicons の mark-github（MIT） */
function GitHubMark({ size = 12 }: { size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
    <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
  </svg>
}

/** GitLab のマーク（単色）。Simple Icons の gitlab（CC0） */
function GitLabMark({ size = 12 }: { size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <path d="M23.955 13.587l-1.342-4.135-2.664-8.189a.455.455 0 0 0-.867 0L16.418 9.45H7.582L4.919 1.263a.455.455 0 0 0-.867 0L1.386 9.45.044 13.587a.924.924 0 0 0 .331 1.023L12 23.054l11.625-8.443a.92.92 0 0 0 .33-1.024" />
  </svg>
}

const ERROR_KEYS: Record<GitSyncErrorKind, TranslationKey> = {
  gitMissing: 'git.sync.error.gitMissing',
  timeout: 'git.sync.error.timeout',
  auth: 'git.sync.error.auth',
  network: 'git.sync.error.network',
  noUpstream: 'git.sync.error.noUpstream',
  upstreamGone: 'git.sync.error.upstreamGone',
  detached: 'git.sync.error.detached',
  diverged: 'git.sync.error.diverged',
  localChanges: 'git.sync.error.localChanges',
  rejected: 'git.sync.error.rejected',
  locked: 'git.sync.error.locked',
  headMoved: 'git.sync.error.headMoved',
  notGit: 'git.sync.error.notGit',
  failed: 'git.sync.error.failed'
}

function errorText(t: TFunction, kind: GitSyncErrorKind, detail: string | null): string {
  return kind === 'failed' && detail ? t('git.sync.error.failedWith', { detail }) : t(ERROR_KEYS[kind])
}

/** 「3 分前に確認」など */
function fetchedText(t: TFunction, now: number, at: number | null): string {
  if (at === null) return t('git.sync.neverFetched')
  const { unit, count } = elapsedLabel(now, at)
  if (unit === 'just') return t('git.sync.fetchedJustNow')
  return t(unit === 'minutes' ? 'git.sync.fetchedMinutes' : unit === 'hours' ? 'git.sync.fetchedHours' : 'git.sync.fetchedDays', { count })
}

/** upstream との差の1行 */
function compareText(t: TFunction, status: GitRepoStatus): string | null {
  const upstream = status.upstream ?? ''
  if (!status.branch || !status.hasUpstream || status.upstreamGone) return null
  if (status.ahead > 0 && status.behind > 0) return t('git.sync.diverged', { upstream, ahead: status.ahead, behind: status.behind })
  if (status.behind > 0) return t('git.sync.behind', { upstream, count: status.behind })
  if (status.ahead > 0) return t('git.sync.ahead', { upstream, count: status.ahead })
  return t('git.sync.upToDate', { upstream })
}

type UiAction = 'fetch' | 'pull' | 'sync' | 'push'

export function GitHubStatusItem() {
  const t = useT()
  const [status, setStatus] = useState<GitRepoStatus | null>(null)
  const [open, setOpen] = useState(false)
  const [working, setWorking] = useState<UiAction | null>(null)
  const [message, setMessage] = useState<{ text: string; tone: 'ok' | 'warn' } | null>(null)
  const [confirmPush, setConfirmPush] = useState<{ count: number; upstream: string; head: string } | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const anchor = useRef<HTMLButtonElement>(null)
  const loading = useRef(false)
  const lastLoadAt = useRef<number | null>(null)

  const load = useCallback(async () => {
    // 前の読み取りが終わっていなければ重ねない
    if (loading.current) return
    loading.current = true
    lastLoadAt.current = Date.now()
    try {
      setStatus(await window.ade.invoke('github:repoStatus'))
    } catch { // 失敗は main の IPC が Sentry へ送る（ここは既定のまま続ける）
      setStatus(null)
    } finally {
      loading.current = false
    }
  }, [])

  /** 裏の fetch を頼む。走らせるかは main が決める（走らせなければ null） */
  const autoFetch = useCallback(async (trigger: 'open' | 'interval' | 'focus') => {
    try {
      const next = await window.ade.invoke('github:autoFetch', trigger, document.visibilityState === 'visible')
      if (next) setStatus(next)
    } catch { // 失敗は main の IPC が Sentry へ送る（fetch の失敗そのものは状態に入って返る）
    }
  }, [])

  useEffect(() => {
    void load()
    // プロジェクトを開いた（起動時に開いていたものを含む）ら、すぐ fetch する
    void autoFetch('open')
    const timer = window.setInterval(() => {
      if (document.visibilityState !== 'visible') return
      void load()
      void autoFetch('interval')
    }, POLL_MS)
    const onFocus = () => {
      const last = lastLoadAt.current
      if (last === null || Date.now() - last >= FOCUS_RELOAD_MIN_GAP_MS) void load()
      // 裏の fetch は main が間隔を見て決める（5 分おき）
      void autoFetch('focus')
    }
    window.addEventListener('focus', onFocus)
    // ファイルの変更（保存・Agent の書き換え）で未コミットの数が変わる。続けて届いたものは1回にまとめる
    let fsTimer: number | undefined
    const offFs = subscribeIpc('fs:changed', () => {
      if (fsTimer !== undefined) return
      fsTimer = window.setTimeout(() => { fsTimer = undefined; void load() },
        reloadDelay(Date.now(), lastLoadAt.current, FS_RELOAD_DEBOUNCE_MS, FS_RELOAD_MIN_GAP_MS))
    }, 'github')
    const offWorkspace = subscribeIpc('workspace:changed', () => {
      setMessage(null)
      setConfirmPush(null)
      void load()
      void autoFetch('open')
    }, 'github')
    const offHead = subscribeIpc('github:headChanged', () => void load(), 'github')
    return () => {
      window.clearInterval(timer)
      window.removeEventListener('focus', onFocus)
      window.clearTimeout(fsTimer)
      offFs()
      offWorkspace()
      offHead()
    }
  }, [load, autoFetch])

  // 吹き出しを開いている間は「何分前」を進める。取得中（回る印が出ている）なら、吹き出しを閉じていても 2 秒ごとに読み直し、
  // 終わったらすぐ印を消す（30 秒ごとの読み直しまで回り続けない）
  // main で別の操作（取り込み・push）が走っている（status.busy）ときも同じ
  const inFlight = status?.fetch.fetching === true || (status?.busy ?? null) !== null
  useEffect(() => {
    if (!open && !inFlight) return
    setNow(Date.now())
    const timer = window.setInterval(() => {
      setNow(Date.now())
      if (inFlight) void load()
    }, inFlight ? 2_000 : 30_000)
    return () => window.clearInterval(timer)
  }, [open, inFlight, load])

  const run = useCallback(async (action: UiAction) => {
    if (working) return
    setWorking(action)
    setMessage(null)
    if (action !== 'push') setConfirmPush(null)
    try {
      const result: GitActionResult = action === 'push'
        ? await window.ade.invoke('github:gitAction', 'push', confirmPush?.head ?? null)
        : await window.ade.invoke('github:gitAction', action === 'fetch' ? 'fetch' : 'pull', null)
      setStatus(result.status)
      setNow(Date.now())
      if (!result.ok) {
        setConfirmPush(null)
        setMessage({ text: errorText(t, result.error ?? 'failed', result.detail), tone: 'warn' })
        return
      }
      if (action === 'push') {
        setConfirmPush(null)
        setMessage({ text: result.commits > 0 ? t('git.sync.donePush', { count: result.commits, upstream: result.status.upstream ?? '' }) : t('git.sync.nothingToPush'), tone: 'ok' })
        return
      }
      const pulled = action === 'fetch' ? null
        : result.commits > 0 ? t('git.sync.donePull', { count: result.commits }) : t('git.sync.alreadyUpToDate')
      // 同期：取り込めて、push していないコミットがあれば、外へ出す前に確かめる
      if (action === 'sync' && result.status.ahead > 0 && result.status.headOid && result.status.upstream) {
        setConfirmPush({ count: result.status.ahead, upstream: result.status.upstream, head: result.status.headOid })
        setMessage(pulled && result.commits > 0 ? { text: pulled, tone: 'ok' } : null)
        return
      }
      setMessage({ text: pulled ?? t('git.sync.doneFetch'), tone: 'ok' })
    } catch (err) {
      setConfirmPush(null)
      setMessage({ text: errorMessage(err), tone: 'warn' })
    } finally {
      setWorking(null)
    }
  }, [working, confirmPush, t])

  /** 裏の fetch を、今のリモートに認める・認めない（押した直後に main が受ける。security-7 [9]） */
  const decideAutoFetch = async (allowed: boolean) => {
    try {
      const next = await window.ade.invoke('github:autoFetchConsent', allowed)
      setStatus(next)
      if (allowed) void autoFetch('open')
    } catch (err) {
      setMessage({ text: errorMessage(err), tone: 'warn' })
    }
  }

  if (!status?.isGit) return null

  const { repo, branch, shortOid, changes, ahead, behind, hasUpstream } = status
  const isGitLab = repo?.forge === 'gitlab'
  const Mark = isGitLab ? GitLabMark : GitHubMark
  const branchLabel = branch ?? t('github.footer.detachedHead', { oid: shortOid ?? '?' })
  const details = [
    repo ? `${repo.owner}/${repo.repo}` : t('github.footer.notGitHubTitle'),
    status.upstream ? `${branchLabel} → ${status.upstream}` : branchLabel,
    changes > 0 ? t('github.footer.changes', { count: changes }) : '',
    ahead > 0 || behind > 0 ? t('github.footer.aheadBehind', { ahead, behind }) : '',
    status.hasRemote ? (status.fetch.fetching ? t('git.sync.fetching') : fetchedText(t, Date.now(), status.fetch.lastFetchAt)) : ''
  ].filter(Boolean).join('\n')
  const openUrl = (url: string) => {
    setOpen(false)
    void window.ade.invoke('github:open', url).catch(() => {}) // 失敗は main の IPC が Sentry へ送る（ここは既定のまま続ける）
  }
  const available = gitActionAvailability(status)
  const busy = working !== null || status.busy !== null
  const compare = compareText(t, status)
  const blockedReason = available.pull.reason
  const fetchLine = status.fetch.fetching || working === 'fetch' ? t('git.sync.fetching') : fetchedText(t, now, status.fetch.lastFetchAt)

  return <>
    <button
      ref={anchor}
      type="button"
      className="statusbar__btn gh-status"
      aria-label={t('github.footer.label')}
      aria-haspopup="dialog"
      aria-expanded={open}
      title={details}
      onClick={() => setOpen((v) => !v)}
      data-testid="statusbar-github"
    >
      {repo ? <Mark /> : <GitBranch size={12} strokeWidth={2} aria-hidden="true" />}
      {repo ? <span className="statusbar__value gh-status__repo">{repo.owner}/{repo.repo}</span>
        : <span className="statusbar__value gh-status__muted">{t('github.footer.notGitHub')}</span>}
      <span className="gh-status__sep" aria-hidden="true">·</span>
      <span className="statusbar__value gh-status__branch">{branchLabel}</span>
      {changes > 0 && <span className="gh-status__badge" aria-hidden="true">•{changes}</span>}
      {ahead > 0 && <span className="gh-status__badge" aria-hidden="true"><ArrowUp size={10} strokeWidth={2} />{ahead}</span>}
      {behind > 0 && <span className="gh-status__badge gh-status__badge--behind" aria-hidden="true"><ArrowDown size={10} strokeWidth={2} />{behind}</span>}
      {(status.fetch.fetching || busy) && <RefreshCw size={10} strokeWidth={2} className="gh-status__spin" aria-hidden="true" />}
    </button>
    {open && <StatusPopover anchor={anchor.current} label={t('github.footer.label')} onClose={() => setOpen(false)} className="sb-pop--git">
      <div className="gh-menu" data-testid="git-sync-popover">
        <div className="gh-sync">
          <p className="gh-sync__branch">
            <GitBranch size={12} aria-hidden="true" />
            <span className="gh-sync__mono">{branchLabel}</span>
            {status.upstream && <><span className="gh-status__sep" aria-hidden="true">→</span><span className="gh-sync__mono gh-sync__muted">{status.upstream}</span></>}
          </p>
          {compare && <p className="gh-sync__line" data-testid="git-sync-compare">{compare}</p>}
          {changes > 0 && <p className="gh-sync__line gh-sync__muted">{t('github.footer.changes', { count: changes })}</p>}
          {status.hasRemote && <p className="gh-sync__line gh-sync__muted" data-testid="git-sync-fetched">
            {fetchLine}
            {status.fetch.lastError && !status.fetch.fetching && working !== 'fetch' && <> · <span className="gh-sync__warn">{t(ERROR_KEYS[status.fetch.lastError])}</span></>}
          </p>}
          {!status.hasRemote && <p className="gh-sync__line gh-sync__muted">{t('git.sync.noRemote')}</p>}
        </div>
        {status.fetch.remote && status.fetch.autoFetch === 'unknown' && <div className="gh-sync__confirm" role="group" aria-label={t('git.sync.autoFetchAsk', { remote: status.fetch.remote })} data-testid="git-auto-fetch-ask">
          <p className="gh-sync__line">{t('git.sync.autoFetchAsk', { remote: status.fetch.remote })}</p>
          <div className="gh-sync__buttons">
            <button type="button" className="btn btn--ghost" onClick={() => void decideAutoFetch(false)} data-testid="git-auto-fetch-deny">{t('git.sync.autoFetchDeny')}</button>
            <button type="button" className="btn btn--primary" onClick={() => void decideAutoFetch(true)} data-testid="git-auto-fetch-allow">{t('git.sync.autoFetchAllow')}</button>
          </div>
        </div>}
        {status.fetch.remote && status.fetch.autoFetch === 'declined' && <p className="gh-menu__note" data-testid="git-auto-fetch-off">
          {t('git.sync.autoFetchOff', { remote: status.fetch.remote })}{' '}
          <button type="button" className="gh-sync__link" onClick={() => void decideAutoFetch(true)}>{t('git.sync.autoFetchTurnOn')}</button>
        </p>}
        {status.hasRemote && <>
          <button type="button" className="gh-menu__item" disabled={busy} onClick={() => void run('fetch')} data-testid="git-sync-fetch">
            <RefreshCw size={12} aria-hidden="true" className={working === 'fetch' ? 'gh-status__spin' : undefined} /><span>{t('git.sync.fetch')}</span>
          </button>
          <button type="button" className="gh-menu__item" disabled={busy || !available.pull.enabled} onClick={() => void run('pull')} data-testid="git-sync-pull"
            title={blockedReason ? t(ERROR_KEYS[blockedReason]) : t('git.sync.pullHint')}>
            <Download size={12} aria-hidden="true" className={working === 'pull' ? 'gh-status__spin' : undefined} /><span>{t('git.sync.pull')}</span>
            {behind > 0 && <span className="gh-status__badge"><ArrowDown size={10} strokeWidth={2} />{behind}</span>}
          </button>
          <button type="button" className="gh-menu__item" disabled={busy || !available.sync.enabled} onClick={() => void run('sync')} data-testid="git-sync-sync"
            title={blockedReason ? t(ERROR_KEYS[blockedReason]) : t('git.sync.syncHint')}>
            <ArrowUp size={12} aria-hidden="true" className={working === 'sync' || working === 'push' ? 'gh-status__spin' : undefined} /><span>{t('git.sync.sync')}</span>
            {ahead > 0 && <span className="gh-status__badge"><ArrowUp size={10} strokeWidth={2} />{ahead}</span>}
          </button>
          {blockedReason && <p className="gh-menu__note">{t(ERROR_KEYS[blockedReason])}</p>}
        </>}
        {confirmPush && <div className="gh-sync__confirm" role="group" aria-label={t('git.sync.confirmPush', { count: confirmPush.count, upstream: confirmPush.upstream })} data-testid="git-sync-confirm">
          <p className="gh-sync__line">{t('git.sync.confirmPush', { count: confirmPush.count, upstream: confirmPush.upstream })}</p>
          <div className="gh-sync__buttons">
            <button type="button" className="btn btn--ghost" disabled={working !== null} onClick={() => setConfirmPush(null)}>{t('common.cancel')}</button>
            <button type="button" className="btn btn--primary" disabled={working !== null} onClick={() => void run('push')} data-testid="git-sync-push">{t('git.sync.push')}</button>
          </div>
        </div>}
        {message && <p className={`gh-sync__message${message.tone === 'warn' ? ' gh-sync__warn' : ''}`} role="status" data-testid="git-sync-message">{message.text}</p>}
        {repo && <>
          <div className="gh-menu__sep" aria-hidden="true" />
          <button type="button" className="gh-menu__item" onClick={() => openUrl(repo.webUrl)}>
            <Mark /><span>{t(isGitLab ? 'gitlab.footer.openRepo' : 'github.footer.openRepo')}</span><ExternalLink size={12} aria-hidden="true" />
          </button>
          <button type="button" className="gh-menu__item" disabled={!branch || !hasUpstream}
            title={branch && !hasUpstream ? t(isGitLab ? 'gitlab.footer.branchNotPushed' : 'github.footer.branchNotPushed') : undefined}
            onClick={() => branch && openUrl(branchWebUrl(repo, branch))}>
            <GitBranch size={12} aria-hidden="true" /><span>{t(isGitLab ? 'gitlab.footer.openBranch' : 'github.footer.openBranch')}</span><ExternalLink size={12} aria-hidden="true" />
          </button>
        </>}
      </div>
    </StatusPopover>}
    <span className="statusbar__divider" aria-hidden="true" />
  </>
}
