import { errorMessage } from '../lib/errors'
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import {
  AudioLines,
  ChevronUp,
  CircleAlert,
  CircleCheck,
  Download,
  Globe,
  Lock,
  MemoryStick,
  Mic,
  MicOff,
  MoreHorizontal,
  PanelBottom,
  PanelRight,
  RefreshCw,
  Settings,
  type LucideIcon
} from 'lucide-react'
import type { BrowserState, SttAvailability } from '@shared/types'
import { STT_PROVIDER_PRESETS, STT_REMOTE_PROVIDERS, providerLabel } from '@shared/aiProviders'
import { DEFAULT_LAYOUT, FOOTER_ITEMS, FOOTER_PRIORITY, pickFooterOverflow, type Dock, type FooterItemId } from '@shared/layout'
import { GitHubStatusItem } from './GitHubStatusItem'
import type { UpdateCheckResult } from '@shared/appVersion'
import { checkOnUpdatePopoverOpen, type AutoUpdateStatus } from '@shared/appUpdate'
import { Button, IconButton, Progress, RecordDot, Spinner, SttLanguageSelect, ThemeToggle } from '../ui'
import type { SpeechLanguage, Transcription } from './SettingsPage'
import { StatusPopover as Popover } from './StatusPopover'
import { ResourceManager } from './ResourceManager'
import { UsageMeter } from './UsageMeter'
import { FailoverStatus } from './FailoverStatus'
import { ApiUsageMeter } from './ApiUsageMeter'
import { useT, type TFunction } from '../lib/i18n'
import { useRecordingLevel } from '../lib/recordingLevel'

/**
 * 下部ステータスバー（24px）。
 * 常時見えるが主張しない帯。いま何で録って・何で文字起こしして・
 * 何で整理するのかを、見れば分かる場所に置く（EXT-1 / EXT-9 / REC-3）。
 *
 * 項目はクリックでその場の設定を開く（マイク・更新・ターミナルの置き場所・設定）。
 * Orca の下部ステータスバーと同じく「小さな項目＋上に開くポップオーバー」の形にする
 * （~/bench/orca/src/renderer/src/components/status-bar/StatusBarSurface.tsx）。
 */
function Item({
  icon: Icon,
  label,
  value,
  tone = 'ok'
}: {
  icon: LucideIcon
  label: string
  value: string
  /** ok … 使える / warn … 設定が足りない / off … 使わない設定 */
  tone?: 'ok' | 'warn' | 'off'
}) {
  return (
    <span className={`statusbar__item statusbar__item--${tone}`} title={`${label}: ${value}`}>
      <Icon size={12} strokeWidth={2} aria-hidden="true" />
      <span className="statusbar__value">{value}</span>
    </span>
  )
}

/** 値の文言から状態の色を決める。未設定は気づけるよう注意色にする */
function toneOf(value: string | undefined, t: TFunction): 'ok' | 'warn' | 'off' {
  if (!value || value === t('capture.summary.notSet') || value === t('capture.summary.localMissing')) return 'warn'
  if (value === t('capture.summary.noRecording')) return 'off'
  return 'ok'
}

/** ステータスバーに出すページ名。題名が無ければホストだけ */
function pageLabel(state: BrowserState): string {
  if (state.title) return state.title
  try {
    return new URL(state.url).host || state.url
  } catch {
    // about:blank など（想定内）
    return state.url
  }
}

/**
 * 録る・書き起こす・整理するの構成（REC-3 / EXT-1 / EXT-9）。
 * 未設定の項目は「未設定」と出す。
 */
export interface CaptureStatus {
  /** 使用するマイク（REC-3） */
  microphone?: string
  /** 文字起こしの方式（EXT-1） */
  transcription?: string
}

/** フッターから変えられる録音の設定。App の state（＝設定ダイアログと同じ値）をそのまま受ける */
export interface FooterCapture {
  captureMic: boolean
  micDeviceId: string
  captureSystemAudio: boolean
  transcription: Transcription
  language: SpeechLanguage
}

type PopoverKind = 'mic' | 'update' | 'resources' | 'more'

function PopSwitch({ label, hint, checked, disabled, onChange }: { label: string; hint?: ReactNode; checked: boolean; disabled?: boolean; onChange: (next: boolean) => void }) {
  return <label className="st-row st-row--switch" data-disabled={disabled || undefined}>
    <span className="st-row__label">{label}{hint}</span>
    <input type="checkbox" role="switch" className="st-switch" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
  </label>
}

function PopSelect({ label, children }: { label: string; children: ReactNode }) {
  return <label className="st-row"><span className="st-row__label">{label}</span><span className="rv-select">{children}</span></label>
}

/**
 * 録画していない間のマイクの入力レベル。ポップオーバーを開いている間だけマイクを掴む。
 * 録画中は main から届く recording:level を使う（同じマイクを二重に開かない）。
 */
function useMicLevel(active: boolean, deviceId: string): { level: number; error: boolean } {
  const [level, setLevel] = useState(0)
  const [error, setError] = useState(false)
  useEffect(() => {
    if (!active) { setLevel(0); setError(false); return }
    let stopped = false
    let frame = 0
    let stream: MediaStream | null = null
    let ctx: AudioContext | null = null
    void navigator.mediaDevices.getUserMedia({ audio: deviceId ? { deviceId: { exact: deviceId } } : true }).then((s) => {
      if (stopped) { s.getTracks().forEach((t) => t.stop()); return }
      stream = s
      ctx = new AudioContext()
      const analyser = ctx.createAnalyser()
      analyser.fftSize = 1024
      ctx.createMediaStreamSource(s).connect(analyser)
      const buf = new Float32Array(analyser.fftSize)
      const tick = () => {
        analyser.getFloatTimeDomainData(buf)
        let sum = 0
        for (const v of buf) sum += v * v
        setLevel(Math.sqrt(sum / buf.length))
        frame = requestAnimationFrame(tick)
      }
      tick()
    // マイクの許可が無い・機器が無い（想定内。画面に出す）
    }).catch(() => { if (!stopped) setError(true) })
    return () => {
      stopped = true
      cancelAnimationFrame(frame)
      stream?.getTracks().forEach((t) => t.stop())
      void ctx?.close()
    }
  }, [active, deviceId])
  return { level, error }
}

function LevelMeter({ level, live }: { level: number; live: boolean }) {
  // 録画ツールバーの MicLevel と同じ倍率（話し声で半分ほど振れる）
  const t = useT()
  const value = live ? Math.min(1, level * 5) : 0
  return <div className="sb-meter" role="meter" aria-label={t('statusBar.inputLevel')} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(value * 100)}>
    <span className="sb-meter__bar" style={{ transform: `scaleX(${value})` }} />
  </div>
}

/** マイクの一覧を読み直すよう App に頼む（App が capture:devices を呼び直す） */
export const MIC_DEVICES_REFRESH_EVENT = 'ade:refresh-mics'
export function requestMicDevicesRefresh(): void {
  window.dispatchEvent(new CustomEvent(MIC_DEVICES_REFRESH_EVENT))
}

export function MicPopover({ value, onChange, recording, micDevices, available, onOpenSettings }: {
  value: FooterCapture
  onChange: (patch: Partial<FooterCapture>) => void
  recording: boolean
  micDevices: Array<{ id: string; label: string }>
  available: SttAvailability
  onOpenSettings: () => void
}) {
  const t = useT()
  const level = useRecordingLevel()
  const probe = useMicLevel(!recording && value.captureMic, value.micDeviceId)
  // 開くたびにマイクの一覧を読み直す（あとからつないだ機器を出す）
  useEffect(() => requestMicDevicesRefresh(), [])
  const live = value.captureMic && (recording || !probe.error)
  return <div className="sb-pop__body">
    <h3 className="sb-pop__title"><Mic size={13} aria-hidden="true" />{t('statusBar.micAndTranscription')}</h3>
    {recording && <p className="st-lock"><Lock size={12} aria-hidden="true" />{t('statusBar.lockedWhileRecording')}</p>}
    <PopSwitch label={t('statusBar.recordMyVoice')} checked={value.captureMic} disabled={recording} onChange={(captureMic) => onChange({ captureMic })} />
    <PopSelect label={t('statusBar.microphone')}>
      <span className="st-mic-select">
        <select className="st-select" aria-label={t('statusBar.micToUse')} value={value.micDeviceId} disabled={recording || !value.captureMic} onChange={(e) => onChange({ micDeviceId: e.target.value })}>
          <option value="">{t('statusBar.systemDefault')}</option>
          {micDevices.map((device) => <option key={device.id} value={device.id}>{device.label}</option>)}
        </select>
        {/* あとからつないだマイク（AirPods など）を読み直す。抜き差しは App が自動でも読み直す */}
        <IconButton size="sm" label={t('statusBar.reloadMics')} icon={<RefreshCw size={13} />} onClick={requestMicDevicesRefresh} data-testid="mic-reload" />
      </span>
    </PopSelect>
    <div className="st-row">
      <span className="st-row__label">{t('statusBar.level')}</span>
      <LevelMeter level={recording ? level : probe.level} live={live} />
    </div>
    {value.captureMic && probe.error && !recording && <p className="st-note st-note--warn"><CircleAlert size={12} aria-hidden="true" />{t('statusBar.micOpenFailed')}</p>}
    <PopSwitch label={t('statusBar.recordOtherVoice')} checked={value.captureSystemAudio} disabled={recording} onChange={(captureSystemAudio) => onChange({ captureSystemAudio })} />
    <PopSelect label={t('statusBar.transcription')}>
      <select className="st-select" aria-label={t('statusBar.transcriptionMethod')} value={value.transcription} disabled={recording} onChange={(e) => onChange({ transcription: e.target.value as Transcription })}>
        <option value="local">{available.localReady ? t('statusBar.sttLocal') : t('statusBar.sttLocalMissing')}</option>
        {/* 使える提供元だけを出す（選んでいるものは未設定でも残す）。設定は「詳しい設定…」から */}
        {STT_REMOTE_PROVIDERS.filter((p) => available.stt[p] || p === value.transcription).map((p) =>
          <option key={p} value={p} disabled={!available.stt[p]}>{available.stt[p] ? providerLabel(STT_PROVIDER_PRESETS[p], t) : t('ai.stt.optionNotReady', { label: providerLabel(STT_PROVIDER_PRESETS[p], t) })}</option>)}
      </select>
    </PopSelect>
    <PopSelect label={t('statusBar.language')}>
      <SttLanguageSelect ariaLabel={t('statusBar.spokenLanguage')} value={value.language} disabled={recording} onChange={(language) => onChange({ language })}
        testId="statusbar-stt-language"
        provider={value.transcription === 'local' ? undefined : { id: value.transcription, label: providerLabel(STT_PROVIDER_PRESETS[value.transcription as keyof typeof STT_PROVIDER_PRESETS], t) }} />
    </PopSelect>
    <div className="sb-pop__foot">
      <Button variant="ghost" onClick={onOpenSettings}>{t('statusBar.moreSettings')}</Button>
    </div>
  </div>
}

/**
 * フッターの「アップデート」。新しい版は裏でダウンロードし（src/main/autoUpdate.ts）、署名した SHA256SUMS で確かめてから
 * 「再起動して更新」を出す。流れは Orca の更新カード（~/bench/orca/src/renderer/src/components/UpdateCard.tsx）と同じく
 * 新しい版がある → ダウンロード中 nn% → 再起動して更新。
 * 裏で入れ替えられない起動（開発版・この OS 向けの入れ替えのファイルが無い版）は、確かめたインストーラーを保存する［ダウンロード］だけ。
 */
function UpdatePopover({ version, packaged, status }: { version: string; packaged: boolean; status: AutoUpdateStatus | null }) {
  const t = useT()
  const [checking, setChecking] = useState(false)
  const [result, setResult] = useState<UpdateCheckResult | null>(null)
  // 入れ替えられないときは、アプリが署名を確かめたファイルを落として sha256 を確かめてから、置いた場所を開く（security-4 [7]）
  const [downloading, setDownloading] = useState(false)
  const [downloadError, setDownloadError] = useState<string | null>(null)
  const [installing, setInstalling] = useState(false)
  const saveInstaller = () => {
    setDownloading(true)
    setDownloadError(null)
    void window.ade.invoke('app:openUpdate')
      .catch((err: unknown) => setDownloadError(errorMessage(err) || t('update.errors.download')))
      .finally(() => setDownloading(false))
  }
  // 裏でダウンロードを始める（自動のダウンロードがオフのとき・失敗したあと）。進み具合は update:status で届く
  const startDownload = () => {
    setDownloadError(null)
    void window.ade.invoke('update:download').catch((err: unknown) => setDownloadError(errorMessage(err) || t('update.errors.download')))
  }
  const install = () => {
    setInstalling(true)
    void window.ade.invoke('update:install')
      .catch((err: unknown) => setDownloadError(errorMessage(err) || t('update.errors.download')))
      .finally(() => setInstalling(false))
  }
  const check = () => {
    setChecking(true)
    void window.ade.invoke('app:checkUpdate')
      .then(setResult)
      .catch(() => setResult({ state: 'error', current: version, message: t('statusBar.checkFailed') }))
      .finally(() => setChecking(false))
  }
  // 開いたら［更新を確認］と同じことをする（押さなくても最新の版が分かり、自動の更新がオンなら裏で落とし始める。ユーザーの指示）
  // 開発版でも裏の更新が動く起動（E2E の偽の配信元）なら確かめる。状態が後から届いても、開いている間に1回だけ
  const checkedOnOpen = useRef(false)
  const shouldCheckOnOpen = checkOnUpdatePopoverOpen(packaged, status)
  useEffect(() => {
    if (checkedOnOpen.current || !shouldCheckOnOpen) return
    checkedOnOpen.current = true
    check()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shouldCheckOnOpen])
  // 最後の確認の結果は main が持つ（起動時・一定間隔の確認も含む）。届く前は、このポップオーバーで押した結果
  const shown = status?.check ?? result
  const progress = status?.progress
  const auto = !!status?.supported && shown?.state === 'available'
  const forThis = (p: AutoUpdateStatus['progress'] | undefined) => p && p.phase !== 'idle' && shown?.state === 'available' && p.version === shown.latest ? p : null
  const step = auto ? forThis(progress) : null
  return <div className="sb-pop__body" data-testid="statusbar-update">
    <h3 className="sb-pop__title"><RefreshCw size={13} aria-hidden="true" />{t('statusBar.update')}</h3>
    <div className="st-row"><span className="st-row__label">{t('statusBar.currentVersion')}</span><span className="sb-pop__mono">v{version}</span></div>
    {shown?.state === 'latest' && <p className="st-note st-note--ok"><CircleCheck size={12} aria-hidden="true" />{t('statusBar.upToDate', { version: shown.latest })}</p>}
    {shown?.state === 'available' && step?.phase === 'downloading' && <div className="st-note st-note--progress" data-testid="statusbar-update-progress">
      <span><Download size={12} aria-hidden="true" />{t('statusBar.updateDownloading', { version: shown.latest, percent: step.percent })}</span>
      <Progress value={step.percent / 100} label={t('statusBar.updateDownloading', { version: shown.latest, percent: step.percent })} />
    </div>}
    {shown?.state === 'available' && step?.phase === 'ready' && <div className="st-note st-note--action st-note--ok" data-testid="statusbar-update-ready">
      <span><CircleCheck size={12} aria-hidden="true" />{t(step.action !== 'restart' ? 'statusBar.updateReadyInstaller' : status?.installOnQuit ? 'statusBar.updateReadyOnQuit' : 'statusBar.updateReady', { version: shown.latest })}</span>
      <Button variant="primary" busy={installing} onClick={install} data-testid="statusbar-update-restart">{t(step.action === 'restart' ? 'statusBar.restartToUpdate' : 'statusBar.openInstaller')}</Button>
    </div>}
    {shown?.state === 'available' && step?.phase === 'failed' && <div className="st-note st-note--progress" data-testid="statusbar-update-failed">
      <span><CircleAlert size={12} aria-hidden="true" />{step.message}</span>
      <span className="st-note__buttons">
        <Button onClick={startDownload} data-testid="statusbar-update-retry-download">{t('statusBar.retryDownload')}</Button>
        <Button variant="ghost" busy={downloading} onClick={saveInstaller} data-testid="statusbar-update-download">{t('statusBar.download')}</Button>
      </span>
    </div>}
    {shown?.state === 'available' && !step && <div className="st-note st-note--action">
      <span><Download size={12} aria-hidden="true" />{t('statusBar.updateAvailable', { version: shown.latest })}</span>
      <Button busy={downloading} onClick={auto ? startDownload : saveInstaller} data-testid="statusbar-update-download">{t('statusBar.download')}</Button>
    </div>}
    {downloadError && <p className="st-note" data-testid="statusbar-update-download-error">{downloadError}</p>}
    {shown?.state === 'no-release' && <p className="st-note">{t('statusBar.noRelease')}</p>}
    {/* 署名が無い・合わない版は案内しない（security-3 [2]）。待っても直らないので「もう一度」は言わない */}
    {shown?.state === 'unverified' && <p className="st-note st-note--warn" data-testid="statusbar-update-unverified"><CircleAlert size={12} aria-hidden="true" />{t('statusBar.updateUnverified', { version: shown.latest })}</p>}
    {shown?.state === 'no-source' && <p className="st-note st-note--warn"><CircleAlert size={12} aria-hidden="true" />{t('statusBar.noSource')}</p>}
    {/* 確認できなかったのは一時的なことが多い。警告の色にせず、下のボタンでもう一度試せることを伝える */}
    {shown?.state === 'error' && <p className="st-note" data-testid="statusbar-update-retry">{t('statusBar.checkRetry', { message: shown.message })}</p>}
    {status && (packaged || status.supported) && <>
      <label className="st-row st-row--switch" data-testid="statusbar-update-auto">
        <span className="st-row__label">{t('statusBar.autoDownload')}</span>
        <input type="checkbox" role="switch" className="st-switch" checked={status.autoDownload}
          onChange={(e) => void window.ade.invoke('update:setAutoDownload', e.target.checked).catch(() => undefined)} />
      </label>
      <p className="st-note">{t('statusBar.autoDownloadHint')}</p>
    </>}
    {!packaged && !status?.supported && <p className="st-note">{t('statusBar.devBuild')}</p>}
    {status?.supported && <VersionPicker current={version} />}
    <div className="sb-pop__foot">
      <Button busy={checking || !!status?.checking} icon={<RefreshCw size={14} />} onClick={check} data-testid="statusbar-check-update">{t('statusBar.checkForUpdates')}</Button>
    </div>
  </div>
}

/**
 * 版を選んで入れる（配信元の直近の版から。古い版へ戻すことも含む）。選んだ版も署名した SHA256SUMS で確かめてから落とし、
 * 上の［再起動して更新］で入れ替える。古い版を選ぶと自動の更新はオフになる（最新へ戻されないように）。オンに戻すと最新へ
 */
function VersionPicker({ current }: { current: string }) {
  const t = useT()
  const [data, setData] = useState<{ current: string; pinned: string | null; versions: Array<{ version: string; date: string; prerelease: boolean }> } | null>(null)
  const [picked, setPicked] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let alive = true
    void window.ade.invoke('update:versions').then((d) => { if (alive) { setData(d); setPicked(d.pinned ?? d.versions.find((v) => v.version !== current)?.version ?? '') } }).catch(() => undefined)
    return () => { alive = false }
  }, [current])
  if (!data || data.versions.length === 0) return null
  const latest = data.versions[0]?.version
  const choose = () => {
    if (!picked || picked === current) return
    setBusy(true)
    setError(null)
    void window.ade.invoke('update:chooseVersion', picked)
      .then((s) => { if (s.check?.state === 'error') setError(s.check.message); else if (s.check?.state === 'unverified') setError(t('statusBar.updateUnverified', { version: picked })) })
      .then(() => window.ade.invoke('update:versions').then(setData))
      .catch((err: unknown) => setError(errorMessage(err)))
      .finally(() => setBusy(false))
  }
  return <div className="sb-pop__versions" data-testid="statusbar-update-versions">
    <span className="st-row__label">{t('statusBar.chooseVersion')}</span>
    <div className="st-row">
      <select className="st-select" value={picked} aria-label={t('statusBar.chooseVersion')} onChange={(e) => setPicked(e.target.value)} data-testid="statusbar-update-version-select">
        {data.versions.map((v) => <option key={v.version} value={v.version} disabled={v.version === current}>
          {`v${v.version}${v.version === latest ? ` (${t('statusBar.versionLatest')})` : ''}${v.version === current ? ` (${t('statusBar.versionCurrent')})` : ''}${v.date ? ` — ${v.date.slice(0, 10)}` : ''}`}
        </option>)}
      </select>
      <Button busy={busy} disabled={!picked || picked === current} onClick={choose} data-testid="statusbar-update-version-choose">{t('statusBar.chooseVersionDownload')}</Button>
    </div>
    {data.pinned && <p className="st-note" data-testid="statusbar-update-version-pinned">{t('statusBar.versionPinned', { version: data.pinned })}</p>}
    {error && <p className="st-note st-note--warn">{error}</p>}
  </div>
}

export function StatusBar({
  items = DEFAULT_LAYOUT.footer.items,
  state,
  capture,
  recording,
  elapsed,
  settings,
  onCaptureChange,
  micDevices,
  available,
  terminalDock,
  onTerminalDockChange,
  onOpenSettings,
  onPopoverChange,
  onOpenTerminal,
  onOpenPage,
  onManageAccounts
}: {
  /** 出す項目（設定の「レイアウト」で選ぶ）。省略時はすべて */
  items?: Record<FooterItemId, boolean>
  state: BrowserState
  capture: CaptureStatus
  recording: boolean
  elapsed: string
  settings: FooterCapture
  onCaptureChange: (patch: Partial<FooterCapture>) => void
  micDevices: Array<{ id: string; label: string }>
  available: SttAvailability
  terminalDock: Dock
  onTerminalDockChange: (dock: Dock) => void
  onOpenSettings: () => void
  /** ポップオーバーの開閉。開いている間は内蔵ブラウザのビューを隠してもらう */
  onPopoverChange: (open: boolean) => void
  /** Resource Manager の行から、そのターミナルへ移る */
  onOpenTerminal: (projectId: string | null, terminalId: string) => void
  /** Resource Manager の行から、内蔵ブラウザのページへ移る */
  onOpenPage: (projectId: string | null) => void
  /** 使用量表示のポップオーバーの「アカウントを管理…」 */
  onManageAccounts?: () => void
}) {
  const t = useT()
  const mic = settings.captureMic ? capture.microphone ?? t('capture.summary.notSet') : t('capture.summary.noRecording')
  const page = pageLabel(state)
  const [open, setOpen] = useState<PopoverKind | null>(null)
  const [version, setVersion] = useState({ version: '', packaged: true })
  const micRef = useRef<HTMLButtonElement | null>(null)
  const updateRef = useRef<HTMLButtonElement | null>(null)

  useEffect(() => {
    // 失敗は main の IPC が Sentry へ送る（ここは既定のまま続ける）
    void window.ade.invoke('app:version').then(setVersion).catch(() => undefined)
  }, [])
  // 裏での更新の状態（src/main/autoUpdate.ts）。準備ができたら、フッターにも「再起動して更新」を出す
  const [updateStatus, setUpdateStatus] = useState<AutoUpdateStatus | null>(null)
  useEffect(() => {
    void window.ade.invoke('update:status').then(setUpdateStatus).catch(() => undefined)
    return window.ade.on('update:status', setUpdateStatus)
  }, [])
  const updateReady = updateStatus?.progress.phase === 'ready' ? updateStatus.progress : null
  const installUpdate = () => { void window.ade.invoke('update:install').catch(() => undefined) }

  /** 使用量表示のポップオーバー（UsageMeter が自分で開閉する）。これもビューを隠す対象に入れる */
  const [usageOpen, setUsageOpen] = useState(false)
  /** API の使用量のポップオーバー（ApiUsageMeter が自分で開閉する） */
  const [apiUsageOpen, setApiUsageOpen] = useState(false)
  useEffect(() => { onPopoverChange(open !== null || usageOpen || apiUsageOpen) }, [open, usageOpen, apiUsageOpen, onPopoverChange])

  const close = useCallback(() => setOpen(null), [])
  const toggle = (kind: PopoverKind) => setOpen((cur) => (cur === kind ? null : kind))
  const openSettings = () => { setOpen(null); onOpenSettings() }

  // ── 幅が足りないときに「…」へ移す（優先順位の低いものから1つずつ。src/shared/layout.ts の pickFooterOverflow）──
  const footerRef = useRef<HTMLElement | null>(null)
  const moreRef = useRef<HTMLButtonElement | null>(null)
  /** 「…」へ移した項目（並びは FOOTER_ITEMS の順） */
  const [hiddenIds, setHiddenIds] = useState<readonly FooterItemId[]>([])
  /** 項目ごとの「全部出したときの幅」。隠したあとも覚えておき、広がったときに戻せるか判断する */
  const widths = useRef<Partial<Record<FooterItemId, number>>>({})
  const fits = (id: FooterItemId) => !hiddenIds.includes(id)
  const overflowed = FOOTER_ITEMS.filter((id) => items[id] && !fits(id))
  /** 常に出す項目のほかがまだフッターに出ているあいだは、使用量を縮めない（先にそちらを「…」へ移す） */
  const usageMayShrink = !FOOTER_ITEMS.some((id) => items[id] && FOOTER_PRIORITY[id] > 0 && fits(id) && (widths.current[id] ?? 0) > 0)

  const evaluate = useCallback(() => {
    const footer = footerRef.current
    if (!footer) return
    for (const el of footer.querySelectorAll<HTMLElement>(':scope > [data-fitem]')) {
      if (el.hidden) continue
      const id = el.dataset.fitem as FooterItemId
      // 使用量は自分で段階的に縮むので、縮む前（全部出したとき）の幅で数える。縮むのはほかを隠したあと
      const full = Number(el.querySelector<HTMLElement>('[data-full-width]')?.dataset.fullWidth)
      widths.current[id] = Number.isFinite(full) && full > 0 ? full : el.scrollWidth
    }
    const style = getComputedStyle(footer)
    const gap = Number.parseFloat(style.columnGap) || 0
    // 項目以外（つまみ・伸びる余白の最小幅・「…」ボタン）の幅
    let fixed = 0
    let fixedCount = 0
    for (const el of footer.querySelectorAll<HTMLElement>(':scope > :not([data-fitem])')) {
      if (el === moreRef.current) continue
      fixed += el.classList.contains('statusbar__spacer') ? Number.parseFloat(getComputedStyle(el).minWidth) || 0 : el.getBoundingClientRect().width
      fixedCount += 1
    }
    const moreWidth = 22
    const available = footer.clientWidth - (Number.parseFloat(style.paddingLeft) || 0) - (Number.parseFloat(style.paddingRight) || 0) - fixed - gap * fixedCount
    // 幅 0（git でないフォルダの GitHub など、何も出していない項目）は隙間も数えない
    const slots = FOOTER_ITEMS.filter((id) => items[id] && (widths.current[id] ?? 0) > 0).map((id) => ({ id, priority: FOOTER_PRIORITY[id], width: widths.current[id] ?? 0 }))
    // 全部出せるなら「…」は要らない。移すときは「…」の分も空ける
    const next = pickFooterOverflow(slots, available, gap, moreWidth)
    setHiddenIds((cur) => (cur.length === next.length && cur.every((id, i) => id === next[i]) ? cur : next))
  }, [items])

  // 測るのは項目が変わったときと、大きさが変わったときだけ（毎回の描画で測るとレイアウトの計算が走る。録画中は1秒に十数回）
  useLayoutEffect(() => { evaluate() }, [evaluate])
  useEffect(() => {
    const footer = footerRef.current
    if (!footer) return
    let frame = 0
    const schedule = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(evaluate)
    }
    const observer = new ResizeObserver(schedule)
    observer.observe(footer)
    // 項目の中身が変わって幅が変わったとき（使用量の読み込み・ページ名の変化など）も測り直す
    for (const el of footer.querySelectorAll(':scope > [data-fitem]')) observer.observe(el)
    // 隠した項目は大きさが 0 のままなので、中身の入れ替わりと「全部出したときの幅」の変化は別に見る
    const mutations = new MutationObserver(schedule)
    mutations.observe(footer, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['data-full-width', 'hidden'] })
    return () => { observer.disconnect(); mutations.disconnect(); cancelAnimationFrame(frame) }
  }, [evaluate, items])

  /** 項目の入れ物。隠すときも外さない（ポップオーバーや中の状態を保つ） */
  const slot = (id: FooterItemId, children: ReactNode, extra = '') => items[id] && (
    <span className={`statusbar__slot${extra}`} data-fitem={id} hidden={!fits(id)}>{children}</span>
  )
  const divider = <span className="statusbar__divider" aria-hidden="true" />
  const itemName = (id: FooterItemId) => t(`settings.layout.item.${id}`)
  const openFromMore = (kind: PopoverKind) => setOpen(kind)

  return (
    <footer ref={footerRef} className="statusbar" data-testid="statusbar" data-overflow={overflowed.join(' ') || undefined}>
      {/* Agent の使用量とアカウント切り替え（Orca の左下と同じ位置） */}
      {slot('usage', <>
        <UsageMeter onManageAccounts={onManageAccounts} onOpenChange={setUsageOpen} shrink={usageMayShrink} />
        <FailoverStatus />
        {divider}
      </>, ' statusbar__slot--shrink')}
      {/* 従量課金の API（判定モデル・文字起こし・整理）の今日の使用量。判定モデルが無効で記録も無ければ出さない */}
      {slot('apiUsage', <ApiUsageMeter onOpenChange={setApiUsageOpen} />)}
      {slot('recording', <>
        <span className={`statusbar__rec${recording ? ' is-recording' : ''}`}>
          <RecordDot active={recording} size={6} />
          <span className="statusbar__elapsed">{elapsed}</span>
        </span>
        {divider}
      </>)}

      {slot('mic', <span className="statusbar__group">
        <button
          type="button"
          className={`statusbar__btn statusbar__item--${settings.captureMic ? 'ok' : 'off'}`}
          aria-pressed={settings.captureMic}
          aria-label={settings.captureMic ? t('statusBar.micOff') : t('statusBar.micOn')}
          title={recording ? t('statusBar.lockedWhileRecording') : settings.captureMic ? t('statusBar.micStateOn') : t('statusBar.micStateOff')}
          disabled={recording}
          onClick={() => onCaptureChange({ captureMic: !settings.captureMic })}
          data-testid="statusbar-mic-toggle"
        >
          {settings.captureMic ? <Mic size={12} strokeWidth={2} aria-hidden="true" /> : <MicOff size={12} strokeWidth={2} aria-hidden="true" />}
        </button>
        <button
          ref={micRef}
          type="button"
          className={`statusbar__btn statusbar__item--${toneOf(mic, t)}`}
          aria-haspopup="dialog"
          aria-expanded={open === 'mic'}
          title={t('statusBar.micTitle', { value: mic })}
          onClick={() => toggle('mic')}
          data-testid="statusbar-mic"
        >
          <span className="statusbar__value">{mic}</span>
          <ChevronUp size={11} strokeWidth={2} aria-hidden="true" />
        </button>
      </span>)}
      {slot('transcription', <Item
        icon={AudioLines}
        label={t('statusBar.transcription')}
        value={capture.transcription ?? t('capture.summary.notSet')}
        tone={toneOf(capture.transcription, t)}
      />)}

      <span className="statusbar__spacer" />

      {slot('resources', <><ResourceManager
        open={open === 'resources'}
        onToggle={() => toggle('resources')}
        onClose={close}
        onOpenTerminal={onOpenTerminal}
        onOpenPage={onOpenPage}
        fallbackAnchor={moreRef.current}
      />
      {divider}</>)}

      {/* GitHub のリポジトリとブランチ。区切り線も部品の中で出す（git でないフォルダでは何も出さない。中身は GitHub 連携担当） */}
      {slot('github', <GitHubStatusItem />)}

      {slot('page', <><span
        className={`statusbar__item statusbar__item--url${page ? '' : ' is-empty'}`}
        title={state.url || undefined}
      >
        <Globe size={12} strokeWidth={2} aria-hidden="true" />
        <span className="statusbar__value">{page || t('statusBar.notConnected')}</span>
      </span>
      {divider}</>)}
      {/* ターミナルを右↔下へ素早く切り替える。左・上を含む細かい配置は設定の「レイアウト」で選ぶ */}
      {slot('layout', <button
        type="button"
        className="statusbar__btn statusbar__btn--icon"
        aria-label={terminalDock === 'right' ? t('statusBar.dockBottom') : t('statusBar.dockRight')}
        title={terminalDock === 'right' ? t('statusBar.dockRightTitle') : t('statusBar.dockBottomTitle')}
        onClick={() => onTerminalDockChange(terminalDock === 'right' ? 'bottom' : 'right')}
        data-testid="statusbar-dock"
        data-dock={terminalDock}
      >
        {terminalDock === 'right' ? <PanelRight size={13} strokeWidth={2} aria-hidden="true" /> : <PanelBottom size={13} strokeWidth={2} aria-hidden="true" />}
      </button>)}
      {slot('version', <>{updateReady && <button
        type="button"
        className="statusbar__btn statusbar__update-ready"
        title={updateReady.action === 'restart' ? t('statusBar.restartToUpdateTitle', { version: updateReady.version }) : t('statusBar.updateReadyInstaller', { version: updateReady.version })}
        onClick={installUpdate}
        data-testid="statusbar-restart-update"
      >
        <RefreshCw size={12} strokeWidth={2} aria-hidden="true" />
        <span>{t(updateReady.action === 'restart' ? 'statusBar.restartToUpdate' : 'statusBar.openInstaller')}</span>
      </button>}<button
        ref={updateRef}
        type="button"
        className="statusbar__btn statusbar__version"
        aria-haspopup="dialog"
        aria-expanded={open === 'update'}
        title={t('statusBar.versionAndUpdates')}
        onClick={() => toggle('update')}
        data-testid="statusbar-version"
      >
        {checkingLabel(version.version)}
      </button></>)}
      {slot('theme', <ThemeToggle />)}
      {slot('settings', <button
        type="button"
        className="statusbar__btn statusbar__btn--icon"
        aria-label={t('statusBar.openSettings')}
        title={t('common.settings')}
        onClick={openSettings}
        data-testid="statusbar-settings"
      >
        <Settings size={13} strokeWidth={2} aria-hidden="true" />
      </button>)}
      {/* 幅が足りず隠れた項目をまとめて開く（VS Code / Orca と同じく右端） */}
      <button
        ref={moreRef}
        type="button"
        className="statusbar__btn statusbar__btn--icon"
        hidden={overflowed.length === 0}
        aria-haspopup="dialog"
        aria-expanded={open === 'more'}
        aria-label={t('statusBar.more')}
        title={t('statusBar.more')}
        onClick={() => toggle('more')}
        data-testid="statusbar-more"
      >
        <MoreHorizontal size={13} strokeWidth={2} aria-hidden="true" />
      </button>

      {open === 'more' && <Popover anchor={moreRef.current} label={t('statusBar.more')} onClose={close}>
        <div className="sb-pop__body sb-more" data-testid="statusbar-more-menu">
          {overflowed.map((id) => {
            const name = itemName(id)
            switch (id) {
              case 'mic':
                return <button key={id} type="button" className="sb-more__row" title={`${name}: ${mic}`} onClick={() => openFromMore('mic')}><Mic size={13} aria-hidden="true" /><span className="sb-more__name">{name}</span><span className="sb-more__value">{mic}</span></button>
              case 'transcription': {
                const value = capture.transcription ?? t('capture.summary.notSet')
                return <button key={id} type="button" className="sb-more__row" title={`${name}: ${value}`} onClick={() => openFromMore('mic')}><AudioLines size={13} aria-hidden="true" /><span className="sb-more__name">{name}</span><span className="sb-more__value">{value}</span></button>
              }
              case 'resources':
                return <button key={id} type="button" className="sb-more__row" onClick={() => openFromMore('resources')}><MemoryStick size={13} aria-hidden="true" /><span className="sb-more__name">{name}</span></button>
              case 'version':
                return <button key={id} type="button" className="sb-more__row" onClick={() => openFromMore('update')}><RefreshCw size={13} aria-hidden="true" /><span className="sb-more__name">{name}</span><span className="sb-more__value" title={version.version ? `v${version.version}` : undefined}>{version.version ? `v${version.version}` : ''}</span></button>
              case 'page':
                return <div key={id} className="sb-more__row" title={state.url || page || undefined}><Globe size={13} aria-hidden="true" /><span className="sb-more__name">{name}</span><span className="sb-more__value">{page || t('statusBar.notConnected')}</span></div>
              case 'layout':
                return <button key={id} type="button" className="sb-more__row" onClick={() => onTerminalDockChange(terminalDock === 'right' ? 'bottom' : 'right')}>{terminalDock === 'right' ? <PanelRight size={13} aria-hidden="true" /> : <PanelBottom size={13} aria-hidden="true" />}<span className="sb-more__name">{terminalDock === 'right' ? t('statusBar.dockBottom') : t('statusBar.dockRight')}</span></button>
              case 'theme':
                return <div key={id} className="sb-more__row"><span className="sb-more__name">{name}</span><span className="sb-more__control"><ThemeToggle /></span></div>
              case 'github':
                return <div key={id} className="sb-more__row"><span className="sb-more__name">{name}</span><span className="sb-more__control"><GitHubStatusItem /></span></div>
              case 'apiUsage':
                return <div key={id} className="sb-more__row"><span className="sb-more__name">{name}</span><span className="sb-more__control"><ApiUsageMeter onOpenChange={setApiUsageOpen} /></span></div>
              default:
                return null
            }
          })}
        </div>
      </Popover>}
      {open === 'mic' && <Popover anchor={micRef.current} fallback={moreRef.current} label={t('statusBar.micAndTranscription')} onClose={close}>
        <MicPopover value={settings} onChange={onCaptureChange} recording={recording} micDevices={micDevices}
          available={available} onOpenSettings={openSettings} />
      </Popover>}
      {open === 'update' && <Popover anchor={updateRef.current} fallback={moreRef.current} label={t('statusBar.update')} onClose={close}>
        <UpdatePopover version={version.version} packaged={version.packaged} status={updateStatus} />
      </Popover>}
    </footer>
  )
}

/** バージョンを取れるまでは小さなスピナーを出す */
function checkingLabel(version: string): ReactNode {
  return version ? `v${version}` : <Spinner size={10} />
}
