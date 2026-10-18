import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { Camera, Check, Circle, Crop, Flag, Maximize, Monitor, MonitorOff, Mic, RefreshCw, ShieldAlert, Square, Star, Timer, User, Volume2, X } from 'lucide-react'
import type { CaptureSourceInfo } from '@shared/types'
import { Badge, Button, IconButton, RecordDot, Segmented, Spinner, useToast } from '@/ui'
import { useT } from '@/lib/i18n'
import { errorMessage } from '@/lib/errors'
import { sendVideoPrompt } from '../agentSend'
import { mainCamera, recordingOrder, toggleCamera } from '../../shared/record/cameras'
import { runAutoFinish, sentTakes } from '../../shared/record/autoFinish'
import { COUNTDOWNS, displayOfSource } from '../../shared/record/plan'
import { displayPixels, regionForDisplay, regionPercent } from '../../shared/record/region'
import { FRAME_RATES, type FrameRate, type RecordDevices, type RecordLevel, type RecordPrefs, type RecordSetup, type RecordStatus, type ScreenAccess } from '../../shared/record/types'
import {
  RESOLUTIONS, formatElapsed, formatMegabytes, hasAnythingToRecord, initialSelection, litSegments, resolutionOf, selectionAfterDevices, videoFolderName,
  type ResolutionId, type Selection
} from '../../shared/record/view'
import './record.css'

export interface RecordViewProps {
  /** 動画1本のフォルダ（絶対パス。チャンネルの直下） */
  videoDir: string
  videoTitle: string
  onClose: () => void
  /** 撮って取り込めた（autopilot.autoStart なら「動画を完成させて」も送ったあと） */
  onRecorded: (takeId: string) => void
}

const IDLE: RecordStatus = { state: 'idle', markers: { ng: 0, important: 0 }, bytes: 0, tracks: 0 }

/**
 * 撮る（動画のタブの中央に出る）。ディスプレイ（ウインドウ）と範囲・カメラ（複数。メインを1台）・マイク（複数）・PC の音声を選び、
 * カウントダウンのあと録る。録画中は赤い枠・経過時間・メーター・目印（NG・重要）。止めると取り込み（ferret-video ingest）、
 * 設定 autopilot.autoStart なら「動画を完成させて」を Agent へ送る（同じテイクは1回だけ）。
 * 映像は main の非表示の録画ウインドウで開き、ここには縮小フレームだけが届く（アプリの窓に映像の権限を広げない）。
 */
export function RecordView({ videoDir, videoTitle, onClose, onRecorded }: RecordViewProps) {
  const t = useT()
  const toast = useToast()
  const [setup, setSetup] = useState<RecordSetup | null>(null)
  const [setupError, setSetupError] = useState<string | null>(null)
  const [status, setStatus] = useState<RecordStatus>(IDLE)
  const [devices, setDevices] = useState<RecordDevices>({ cameras: [], mics: [] })
  const [prefs, setPrefs] = useState<RecordPrefs | null>(null)
  const [sources, setSources] = useState<CaptureSourceInfo[] | null>(null)
  const [screenAccess, setScreenAccess] = useState<ScreenAccess>('granted')
  const [sourcesError, setSourcesError] = useState(false)
  const [sel, setSel] = useState<Selection | null>(null)
  const [frames, setFrames] = useState<Record<string, string>>({})
  const [levels, setLevels] = useState<Record<string, RecordLevel>>({})
  const [countdownSec, setCountdownSec] = useState(3)
  const [picking, setPicking] = useState(false)
  const [now, setNow] = useState(Date.now())
  const finishing = useRef(false)

  const recording = status.state !== 'idle'
  const busy = recording || picking

  // 録画ウインドウを用意して、機器・設定・今の状態を読む。閉じたら録画ウインドウを閉じる（録画中は閉じない）
  useEffect(() => {
    let alive = true
    window.ade.invoke('video:record:setup').then((s) => {
      if (!alive) return
      setSetup(s)
      setDevices(s.devices)
      setPrefs(s.prefs)
      setStatus(s.status)
    }).catch((err: unknown) => { if (alive) setSetupError(errorMessage(err)) })
    const offs = [
      window.ade.on('video:record:status', setStatus),
      window.ade.on('video:record:devices', setDevices),
      window.ade.on('video:record:frame', (f) => setFrames((cur) => (cur[f.id] === f.dataUrl ? cur : { ...cur, [f.id]: f.dataUrl }))),
      window.ade.on('video:record:levels', (list) => setLevels(Object.fromEntries(list.map((l) => [l.id, l]))))
    ]
    return () => {
      alive = false
      offs.forEach((off) => off())
      void window.ade.invoke('video:record:close').catch(() => undefined)
    }
  }, [])

  const loadSources = useCallback(async () => {
    try {
      const list = await window.ade.invoke('video:record:sources')
      setSources(list.sources)
      setScreenAccess(list.screenAccess)
      setSourcesError(false)
      return list.sources
    } catch {
      // 利用者の操作の直後でないと一覧は読めない。「画面を読み込む」を押してもらう
      setSourcesError(true)
      return null
    }
  }, [])

  // 最初の選択（画面を開いた操作の直後なので、画面の一覧も読める）
  useEffect(() => {
    if (!setup || sel) return
    void loadSources().then((list) => setSel(initialSelection(setup.prefs, setup.devices, list ?? [], setup.systemAudioSupported)))
  }, [setup, sel, loadSources])

  // 機器を抜き差しした
  useEffect(() => {
    setSel((cur) => (cur ? selectionAfterDevices(cur, devices) : cur))
  }, [devices])

  const format = prefs?.camera ?? { width: 1920, height: 1080, fps: 30 as FrameRate, deviceId: '' }
  const cameraOrder = useMemo(() => (sel ? recordingOrder(sel.cameraIds, sel.mainCameraId) : []), [sel])
  const mainId = sel ? mainCamera(sel.cameraIds, sel.mainCameraId) : null

  // プレビュー（録画中は main が変えない）
  const previewKey = JSON.stringify([sel?.screenSourceId, cameraOrder, sel?.micIds, format.width, format.height, format.fps])
  useEffect(() => {
    if (!sel || !setup || recording) return
    void window.ade.invoke('video:record:preview', {
      screenSourceId: sel.screenSourceId, cameraIds: cameraOrder, micIds: sel.micIds,
      camera: { width: format.width, height: format.height, fps: format.fps }
    }).catch(() => undefined)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [previewKey, setup, recording])

  useEffect(() => {
    if (status.state !== 'recording') return
    const id = window.setInterval(() => setNow(Date.now()), 250)
    return () => window.clearInterval(id)
  }, [status.state])

  const savePrefs = (next: Partial<Pick<RecordPrefs, 'screenFps' | 'camera' | 'micId' | 'systemAudio'>>) => {
    void window.ade.invoke('video:record:savePrefs', next).then(setPrefs).catch((err: unknown) => toast({ tone: 'danger', message: t('video.record.prefsFailed'), detail: errorMessage(err) }))
  }

  // 選んだ画面のディスプレイと、それに当てはまる範囲（別のディスプレイの範囲なら画面全体）
  const source = sources?.find((s) => s.id === sel?.screenSourceId) ?? null
  const display = source && setup ? displayOfSource(source, setup.displays) : null
  const region = display ? regionForDisplay(prefs?.region, display) : null
  const canPickRegion = !!display && setup?.platform !== 'linux'

  const pickRegion = async () => {
    if (!display) return
    setPicking(true)
    try {
      const r = await window.ade.invoke('video:record:pickRegion', display.id)
      if (r) setPrefs((p) => (p ? { ...p, region: r } : p))
    } catch (err) {
      toast({ tone: 'danger', message: t('video.record.regionFailed'), detail: errorMessage(err) })
    } finally {
      setPicking(false)
    }
  }
  const clearRegion = async () => {
    try {
      await window.ade.invoke('video:record:clearRegion')
      setPrefs((p) => (p ? { ...p, region: null } : p))
    } catch (err) {
      toast({ tone: 'danger', message: t('video.record.regionFailed'), detail: errorMessage(err) })
    }
  }

  const start = async () => {
    if (!sel || !prefs) return
    try {
      await window.ade.invoke('video:record:start', {
        videoDir,
        screen: sel.screenSourceId ? { sourceId: sel.screenSourceId } : null,
        cameraIds: cameraOrder,
        micIds: sel.micIds,
        systemAudio: sel.systemAudio,
        screenFps: prefs.screenFps,
        camera: { width: format.width, height: format.height, fps: format.fps },
        countdownSec
      })
    } catch (err) {
      toast({ tone: 'danger', message: t('video.record.startFailed'), detail: errorMessage(err) })
    }
  }

  // 止める → 取り込み → （autoStart なら）「動画を完成させて」を Agent へ → onRecorded
  const stop = async () => {
    if (finishing.current) return
    finishing.current = true
    try {
      const result = await window.ade.invoke('video:record:stop')
      if (!result || result.cancelled) return
      if (!result.ingest?.ok) {
        toast({ tone: 'danger', message: t('video.record.ingestFailed'), detail: result.ingest?.message, duration: 0 })
        return
      }
      toast({ tone: 'success', message: t('video.record.saved') })
      await runAutoFinish(videoDir, result.takeId, {
        autoStart: () => result.autoStart,
        render: () => window.ade.invoke('video:finishPrompt', videoFolderName(videoDir)),
        send: (text) => sendVideoPrompt(text, (agent) => toast({ tone: 'info', message: t('video.record.agentStarting', { agent }) })),
        toast: (message, tone) => toast({ tone, message }),
        sent: sentTakes,
        messages: { started: () => t('video.record.autoStarted'), failed: (detail) => t('video.record.autoFailed', { detail }) }
      })
      onRecorded(result.takeId)
    } catch (err) {
      toast({ tone: 'danger', message: t('video.record.stopFailed'), detail: errorMessage(err) })
    } finally {
      finishing.current = false
    }
  }

  const mark = (kind: 'ng' | 'important') => void window.ade.invoke('video:record:mark', kind).catch(() => undefined)
  const mod = window.ade.platform === 'darwin' ? '⌘⇧' : 'Ctrl+Shift+'
  const hotkey = (accel: string | undefined) => (accel ?? '').replace(/CmdOrCtrl\+|CommandOrControl\+/i, '').replace(/Shift\+/i, '')

  if (setupError) {
    return (
      <div className="vrec" data-testid="video-record">
        <Header title={videoTitle} onClose={onClose} closeLabel={t('video.record.close')} recording={false} heading={t('video.record.title')} />
        <div className="vrec__empty"><p>{setupError}</p></div>
      </div>
    )
  }
  if (!setup || !sel || !prefs) {
    return (
      <div className="vrec" data-testid="video-record">
        <Header title={videoTitle} onClose={onClose} closeLabel={t('video.record.close')} recording={false} heading={t('video.record.title')} />
        <div className="vrec__empty"><Spinner label={t('video.record.loading')} /></div>
      </div>
    )
  }

  const camLabel = (id: string) => devices.cameras.find((d) => d.id === id)?.label || id.slice(0, 8)
  const micLabel = (id: string) => devices.mics.find((d) => d.id === id)?.label || id.slice(0, 8)
  const firstMic = sel.micIds[0]
  const mainLevel = firstMic ? levels[`mic:${firstMic}`] : undefined
  const anyClip = Object.values(levels).some((l) => l.clip)
  const blocked = setup.blocked === 'reviewRecording'
  const canStart = !busy && !blocked && hasAnythingToRecord(sel)
  const elapsed = status.startedAt ? now - status.startedAt : 0
  const screens = (sources ?? []).filter((s) => s.kind === 'screen')
  const windows = (sources ?? []).filter((s) => s.kind === 'window')
  const px = display ? displayPixels(display) : null
  const pct = region && display ? regionPercent(region, display) : null

  return (
    <div className={`vrec${status.state === 'recording' ? ' is-recording' : ''}`} data-testid="video-record">
      <Header title={videoTitle} onClose={onClose} closeLabel={t('video.record.close')} recording={recording} heading={t('video.record.title')} />

      <div className="vrec__bar" role="toolbar" aria-label={t('video.record.title')}>
        <span className="vrec__timer" data-testid="video-record-elapsed">
          <RecordDot active={status.state === 'recording'} size={8} />
          <span>{formatElapsed(status.state === 'recording' ? elapsed : 0)}</span>
        </span>
        <LevelBars level={mainLevel?.level ?? 0} clip={mainLevel?.clip ?? false} off={!mainLevel} />
        <span className="vrec__sep" aria-hidden="true" />
        <Button variant="ghost" icon={<Flag size={14} />} disabled={status.state !== 'recording'} onClick={() => mark('ng')} title={t('video.record.markNg', { key: `${mod}${hotkey(prefs.hotkeys.ng)}` })} data-testid="video-record-mark-ng">
          {t('video.record.ng')} <span className="vrec__n">{status.markers.ng}</span>
        </Button>
        <Button variant="ghost" icon={<Star size={14} />} disabled={status.state !== 'recording'} onClick={() => mark('important')} title={t('video.record.markImportant', { key: `${mod}${hotkey(prefs.hotkeys.important)}` })} data-testid="video-record-mark-important">
          {t('video.record.important')} <span className="vrec__n">{status.markers.important}</span>
        </Button>
        <span className="vrec__sep" aria-hidden="true" />
        <label className="vrec__countdown-select">
          <Timer size={14} aria-hidden="true" />
          <select value={countdownSec} disabled={recording} aria-label={t('video.record.countdown')} onChange={(e) => setCountdownSec(Number(e.target.value))}>
            {COUNTDOWNS.map((x) => <option key={x} value={x}>{t('video.record.seconds', { n: x })}</option>)}
          </select>
        </label>
        {status.state === 'recording' && <span className="vrec__size">{formatMegabytes(status.bytes)}</span>}
        {anyClip && <Badge tone="danger">{t('video.record.clip')}</Badge>}
        <span className="vrec__grow" />
        <Button
          variant="record"
          icon={status.state === 'recording' ? <Square size={12} fill="currentColor" aria-hidden="true" /> : <Circle size={12} fill="currentColor" aria-hidden="true" />}
          selected={status.state === 'recording'}
          disabled={status.state === 'recording' || status.state === 'countdown' ? false : !canStart}
          onClick={() => void (status.state === 'idle' ? start() : stop())}
          data-testid="video-record-toggle"
        >
          {status.state === 'recording' ? t('video.record.stop') : status.state === 'countdown' ? t('video.record.cancelCountdown') : t('video.record.start')}
        </Button>
      </div>

      {blocked && <Banner tone="warn" icon={<ShieldAlert size={14} />}>{t('video.record.blockedByReview')}</Banner>}
      {screenAccess !== 'granted' && screenAccess !== 'not-determined' && (
        <Banner tone="warn" icon={<ShieldAlert size={14} />} action={<Button onClick={() => void window.ade.invoke('capture:openScreenSettings')}>{t('video.record.openScreenSettings')}</Button>}>
          {t('video.record.screenAccess')}
        </Banner>
      )}
      {status.warning && <Banner tone="warn" icon={<ShieldAlert size={14} />}>{status.warning}</Banner>}
      {(status.state === 'stopping' || status.state === 'ingesting') && (
        <Banner tone="info" icon={<Spinner size={14} />}>{status.state === 'stopping' ? t('video.record.saving') : t('video.record.ingesting')}</Banner>
      )}

      <div className="vrec__body">
        <div className="vrec__stage">
          <div className="vrec__screen-wrap">
            <div className="vrec__screen" style={px ? ({ '--ratio': `${px.width} / ${px.height}` } as CSSProperties) : undefined} data-testid="video-record-screen-preview">
              {sel.screenSourceId && frames.screen ? <img src={frames.screen} alt="" /> : <span className="vrec__placeholder">{sel.screenSourceId ? t('video.record.previewWaiting') : t('video.record.noScreen')}</span>}
              {sel.screenSourceId && pct && <span className="vrec__region" aria-hidden="true" style={{ left: `${pct.left}%`, top: `${pct.top}%`, width: `${pct.width}%`, height: `${pct.height}%` }} />}
              <span className="vrec__tag">{region ? `${t('video.record.screen')} · ${region.width} × ${region.height}` : t('video.record.screen')}</span>
            </div>
          </div>
          {cameraOrder.length > 0 && (
            <div className="vrec__cams">
              {cameraOrder.map((id) => (
                <div key={id} className="vrec__cam-preview">
                  {frames[`camera:${id}`] ? <img src={frames[`camera:${id}`]} alt="" /> : <Camera size={16} aria-hidden="true" />}
                  <span className="vrec__tag">{id === mainId ? `${t('video.record.mainCamera')} · ${camLabel(id)}` : camLabel(id)}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        <aside className="vrec__side">
          <section className="vrec__step">
            <div className="vrec__step-head">
              <span className="vrec__step-n">1</span>
              <h3>{t('video.record.stepScreen')}</h3>
              <IconButton label={t('video.record.refresh')} size="sm" icon={<RefreshCw size={14} />} disabled={busy} onClick={() => void loadSources()} />
            </div>
            {sourcesError && !sources && <Button icon={<Monitor size={14} />} onClick={() => void loadSources()}>{t('video.record.loadScreens')}</Button>}
            <div className="vrec__sources">
              {[...screens, ...windows].map((s) => (
                <button key={s.id} type="button" className={`vrec__source${sel.screenSourceId === s.id ? ' is-selected' : ''}`} aria-pressed={sel.screenSourceId === s.id} disabled={busy} onClick={() => setSel({ ...sel, screenSourceId: s.id })}>
                  <span className="vrec__source-img">{s.thumbnail ? <img src={s.thumbnail} alt="" /> : <Monitor size={16} aria-hidden="true" />}</span>
                  <span className="vrec__source-name" title={s.name}>{s.name}</span>
                </button>
              ))}
              <button type="button" className={`vrec__source${sel.screenSourceId === null ? ' is-selected' : ''}`} aria-pressed={sel.screenSourceId === null} disabled={busy} onClick={() => setSel({ ...sel, screenSourceId: null })}>
                <span className="vrec__source-img is-none"><MonitorOff size={16} aria-hidden="true" /></span>
                <span className="vrec__source-name">{t('video.record.noScreen')}</span>
              </button>
            </div>
            {canPickRegion && (
              <div className="vrec__region-row">
                <Button icon={<Crop size={14} />} busy={picking} disabled={recording} onClick={() => void pickRegion()} data-testid="video-record-pick-region">
                  {region ? t('video.record.repickRegion') : t('video.record.pickRegion')}
                </Button>
                <Button variant="ghost" icon={<Maximize size={14} />} selected={!region} disabled={busy || !region} onClick={() => void clearRegion()}>
                  {t('video.record.wholeScreen')}
                </Button>
              </div>
            )}
          </section>

          <section className="vrec__step">
            <div className="vrec__step-head">
              <span className="vrec__step-n">2</span>
              <h3>{t('video.record.stepCamera')}</h3>
            </div>
            {devices.cameras.length === 0 && <p className="vrec__note">{t('video.record.noCameras')}</p>}
            <div className="vrec__camgrid">
              {devices.cameras.map((d) => {
                const on = sel.cameraIds.includes(d.id)
                const isMain = on && d.id === mainId
                const frame = frames[`camera:${d.id}`]
                return (
                  <div key={d.id} className={`vrec__cam${on ? ' is-on' : ''}${isMain ? ' is-main' : ''}`}>
                    <button type="button" className="vrec__cam-toggle" aria-pressed={on} disabled={busy} onClick={() => setSel({ ...sel, cameraIds: toggleCamera(sel.cameraIds, d.id) })}>
                      <span className="vrec__cam-img">
                        {on && frame ? <img src={frame} alt="" /> : <Camera size={16} aria-hidden="true" />}
                        {on && <span className="vrec__cam-check"><Check size={12} aria-hidden="true" /></span>}
                      </span>
                      <span className="vrec__cam-name" title={camLabel(d.id)}>{camLabel(d.id)}</span>
                    </button>
                    {isMain ? (
                      <Badge tone="brand" icon={<User size={12} />}>{t('video.record.mainCamera')}</Badge>
                    ) : on ? (
                      <Button variant="ghost" disabled={busy} onClick={() => {
                        setSel({ ...sel, mainCameraId: d.id })
                        savePrefs({ camera: { ...format, deviceId: d.id } })
                      }}>{t('video.record.setMainCamera')}</Button>
                    ) : null}
                  </div>
                )
              })}
            </div>
          </section>

          <section className="vrec__step">
            <div className="vrec__step-head">
              <span className="vrec__step-n">3</span>
              <h3>{t('video.record.stepMic')}</h3>
            </div>
            {devices.mics.length === 0 && <p className="vrec__note">{t('video.record.noMics')}</p>}
            <ul className="vrec__mics">
              {devices.mics.map((d) => {
                const on = sel.micIds.includes(d.id)
                const level = levels[`mic:${d.id}`]
                return (
                  <li key={d.id} className={`vrec__mic${on ? ' is-on' : ''}`}>
                    <label>
                      <input type="checkbox" checked={on} disabled={busy} onChange={() => {
                        const micIds = on ? sel.micIds.filter((x) => x !== d.id) : [...sel.micIds, d.id]
                        setSel({ ...sel, micIds })
                        if (micIds[0]) savePrefs({ micId: micIds[0] })
                      }} />
                      <Mic size={14} aria-hidden="true" />
                      <span className="vrec__mic-name" title={micLabel(d.id)}>{micLabel(d.id)}</span>
                    </label>
                    {on && <LevelBars level={level?.level ?? 0} clip={level?.clip ?? false} off={!level} wide />}
                    {on && level?.clip && <Badge tone="danger">{t('video.record.clip')}</Badge>}
                  </li>
                )
              })}
            </ul>
            {setup.systemAudioSupported ? (
              <label className="vrec__switch">
                <Volume2 size={14} aria-hidden="true" />
                <span>{t('video.record.systemAudio')}</span>
                <input type="checkbox" role="switch" className="st-switch" checked={sel.systemAudio} disabled={busy} onChange={(e) => {
                  setSel({ ...sel, systemAudio: e.target.checked })
                  savePrefs({ systemAudio: e.target.checked })
                }} />
              </label>
            ) : (
              <p className="vrec__note">{t('video.record.systemAudioUnsupported')}</p>
            )}
            {sel.systemAudio && levels.system && <LevelBars level={levels.system.level} clip={levels.system.clip} off={false} wide />}
          </section>

          <section className="vrec__step">
            <div className="vrec__step-head">
              <span className="vrec__step-n">4</span>
              <h3>{t('video.record.stepQuality')}</h3>
            </div>
            <div className="vrec__row">
              <span>{t('video.record.resolution')}</span>
              <Segmented<ResolutionId>
                ariaLabel={t('video.record.resolution')}
                value={resolutionOf(format.width, format.height)}
                options={RESOLUTIONS.map((r) => ({ value: r.id, label: r.id }))}
                onChange={(id) => {
                  if (busy) return
                  const r = RESOLUTIONS.find((x) => x.id === id)!
                  savePrefs({ camera: { ...format, width: r.width, height: r.height } })
                }}
              />
            </div>
            <div className="vrec__row">
              <span>{t('video.record.fps')}</span>
              <select value={prefs.screenFps} disabled={busy} aria-label={t('video.record.fps')} onChange={(e) => {
                const fps = Number(e.target.value) as FrameRate
                savePrefs({ screenFps: fps, camera: { ...format, fps } })
              }}>
                {FRAME_RATES.map((f) => <option key={f} value={f}>{`${f} fps`}</option>)}
              </select>
            </div>
          </section>
          <p className="vrec__note">{t('video.record.hotkeys', { ng: `${mod}${hotkey(prefs.hotkeys.ng)}`, important: `${mod}${hotkey(prefs.hotkeys.important)}` })}</p>
        </aside>
      </div>

      {status.state === 'countdown' && status.countdown !== undefined && (
        <div className="vrec__countdown" aria-live="assertive" data-testid="video-record-countdown">
          <span>{status.countdown}</span>
        </div>
      )}
    </div>
  )
}

function Header({ heading, title, recording, onClose, closeLabel }: { heading: string; title: string; recording: boolean; onClose: () => void; closeLabel: string }) {
  return (
    <div className="vrec__head">
      <h2 className="vrec__title">{heading}<span className="vrec__subtitle">{title}</span></h2>
      <IconButton label={closeLabel} icon={<X size={16} />} disabled={recording} onClick={onClose} data-testid="video-record-close" />
    </div>
  )
}

function Banner({ tone, icon, action, children }: { tone: 'warn' | 'info'; icon: ReactNode; action?: ReactNode; children: ReactNode }) {
  return (
    <div className={`vrec__banner is-${tone}`} role={tone === 'warn' ? 'alert' : 'status'}>
      {icon}
      <span>{children}</span>
      {action}
    </div>
  )
}

/** 区切りのメーター（緑 → 黄 → 赤）。level は -60〜0 dB を 0〜1 にしたもの */
function LevelBars({ level, clip, off, wide = false }: { level: number; clip: boolean; off: boolean; wide?: boolean }) {
  const n = wide ? 24 : 12
  const lit = litSegments(level, n, off)
  return (
    <span className={`vrec-level${wide ? ' vrec-level--wide' : ''}${clip ? ' is-clip' : ''}`} aria-hidden="true">
      {Array.from({ length: n }, (_, i) => (
        <span key={i} className={`vrec-level__seg${i < lit ? ' is-on' : ''}${i >= n * 0.85 ? ' is-hot' : i >= n * 0.65 ? ' is-warm' : ''}`} />
      ))}
    </span>
  )
}
