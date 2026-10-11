import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, ChevronRight, Copy, ExternalLink, Film, Lock, Monitor, MousePointerClick, Play, Upload, X } from 'lucide-react'
import { FeedbackToolbar, type AnnotationTool } from '../../../src/renderer/components/FeedbackToolbar'
import { Button, IconButton } from '../../../src/renderer/ui'
import { setRecordingLevel } from '../../../src/renderer/lib/recordingLevel'
import { DEFAULT_ANNOTATION_COLOR, type AnnotationColor } from '../../../src/shared/annotation'
import { SHARE_LIMITS, type ShareMemo, type ShareNote, type SharePublicRecording, type SharePublicView, type ShareRecordingMode, type ShareUrl } from '../../../src/shared/feedbackShare'
import { openMemo, passwordProof } from '../../../src/shared/shareCrypto'
import type { BrowserState } from '../../../src/shared/types'
import { ApiError, loadShare, mediaUrl, sendRecording, shareId, thumbUrl, unlockShare } from './api'
import { MicMeter, ShareRecorder, canCropTab, canRecord, canShareScreen, frameToJpeg, openCroppedTab, openMic, openScreen, type RecordingResult } from './recorder'
import { formatDate, formatDuration, s, type StringKey } from './strings'
import { AnnotationSurface, ScreenComposer, type SurfaceTool } from './surface'

/**
 * 共有リンクの相手の画面（ログイン無し）。録画の帯はアプリのフィードバックモードの FeedbackToolbar そのもの、
 * 書き込みはアプリと同じ部品（surface.ts）。届いた指摘は、同じリンクを開いた人が誰でも見られる。
 */

type Loaded = Extract<SharePublicView, { locked: false }>
type Screen =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'locked'; salt: string; iterations: number }
  | { kind: 'home' }
  | { kind: 'record'; mode: 'live' | 'screen'; url: ShareUrl }
  | { kind: 'upload' }

const NAME_KEY = 'ferret-share-name'
const storage = {
  get: (key: string) => { try { return localStorage.getItem(key) ?? '' } catch { return '' } },
  set: (key: string, value: string) => { try { localStorage.setItem(key, value) } catch { /* 使えない環境（想定内） */ } }
}

function errorText(err: unknown): string {
  const code = err instanceof ApiError ? err.code : 'internal'
  const key: StringKey = code === 'not_found' ? 'notFound' : code === 'gone' ? 'gone' : code === 'rate_limited' ? 'rateLimited' : code === 'too_large' ? 'tooLarge'
    : code === 'bad_media' ? 'badMedia' : code === 'wrong_password' ? 'wrongPassword' : 'failed'
  return s(key)
}

export function App() {
  const [screen, setScreen] = useState<Screen>({ kind: 'loading' })
  const [share, setShare] = useState<Loaded | null>(null)
  /** パスワード（メモの復号に使う。この画面の中だけに持ち、保存しない） */
  const [password, setPassword] = useState('')
  const [name, setName] = useState(() => storage.get(NAME_KEY))

  const reload = useCallback(async () => {
    if (!shareId) {
      setScreen({ kind: 'error', message: s('notFound') })
      return
    }
    try {
      const view = await loadShare()
      if (view.locked) {
        setScreen({ kind: 'locked', salt: view.salt, iterations: view.iterations })
        return
      }
      setShare(view)
      document.title = `${view.title || 'Ferret'} – Ferret feedback`
      setScreen((prev) => (prev.kind === 'loading' || prev.kind === 'locked' || prev.kind === 'error' ? { kind: 'home' } : prev))
    } catch (err) {
      setScreen({ kind: 'error', message: errorText(err) })
    }
  }, [])
  useEffect(() => { void reload() }, [reload])

  const saveName = (value: string) => {
    setName(value)
    storage.set(NAME_KEY, value.trim())
  }

  if (screen.kind === 'loading') return <p className="share-message">{s('loading')}</p>
  if (screen.kind === 'error') return <p className="share-message">{screen.message}</p>
  if (screen.kind === 'locked') return <Gate salt={screen.salt} iterations={screen.iterations} onOpen={(pw) => { setPassword(pw); void reload() }} />
  if (!share) return null
  if (screen.kind === 'record') {
    return <RecordSession share={share} mode={screen.mode} url={screen.url} name={name} password={password}
      onDone={() => { setScreen({ kind: 'home' }); void reload() }} />
  }
  if (screen.kind === 'upload') return <UploadSession share={share} name={name} onDone={() => { setScreen({ kind: 'home' }); void reload() }} />
  return <Home share={share} name={name} onName={saveName} password={password} onPassword={setPassword}
    onStart={(mode, url) => setScreen(mode === 'upload' ? { kind: 'upload' } : { kind: 'record', mode, url: url! })} />
}

/* ── パスワード ─────────────────────────────── */

function Gate({ salt, iterations, onOpen }: { salt: string; iterations: number; onOpen: (password: string) => void }) {
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const submit = async () => {
    if (!value || busy) return
    setBusy(true)
    setError('')
    try {
      await unlockShare(await passwordProof(value, salt, iterations))
      onOpen(value)
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }
  return <main className="share-gate">
    <form className="share-card share-gate__card" onSubmit={(e) => { e.preventDefault(); void submit() }}>
      <h1><Lock size={18} aria-hidden="true" /> {s('locked')}</h1>
      <p className="share-muted">{s('lockedHint')}</p>
      <label className="share-field">
        <span>{s('password')}</span>
        <input type="password" autoComplete="off" value={value} onChange={(e) => setValue(e.target.value)} autoFocus data-testid="share-password" />
      </label>
      {error && <p className="share-error" role="alert">{error}</p>}
      <Button variant="primary" busy={busy} disabled={!value} onClick={() => void submit()} data-testid="share-unlock">{s('unlock')}</Button>
    </form>
  </main>
}

/* ── 一覧（届いた指摘・始める） ─────────────────────── */

function Home({ share, name, onName, password, onPassword, onStart }: {
  share: Loaded
  name: string
  onName: (value: string) => void
  password: string
  onPassword: (value: string) => void
  onStart: (mode: 'live' | 'screen' | 'upload', url?: ShareUrl) => void
}) {
  const [playing, setPlaying] = useState<SharePublicRecording | null>(null)
  const [url, setUrl] = useState<ShareUrl>(share.urls[0]!)
  const mobile = typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches
  return <main className="share-home">
    <header className="share-head">
      <div className="share-head__title">
        <span className="share-logo" aria-hidden="true" />
        <h1>{share.title || 'Ferret'}</h1>
      </div>
      <p className="share-muted">{s('everyone')} {s('expires', { date: formatDate(share.expiresAt) })}</p>
    </header>

    {share.memo && <MemoPanel memo={share.memo} password={password} onPassword={onPassword} defaultOpen />}

    <section className="share-card share-start">
      <label className="share-field">
        <span>{s('name')}</span>
        <input value={name} maxLength={SHARE_LIMITS.nameChars} placeholder={s('namePlaceholder')} onChange={(e) => onName(e.target.value)} autoComplete="nickname" data-testid="share-name" />
      </label>
      {share.urls.length > 1 && <div className="share-urls" role="radiogroup">
        {share.urls.map((u) => <label key={u.url} className="share-url">
          <input type="radio" name="share-url" checked={u.url === url.url} onChange={() => setUrl(u)} />
          <span>{u.title || u.url}</span>
        </label>)}
      </div>}
      <div className="share-options">
        <button type="button" className="share-option" onClick={() => onStart('live', url)} data-testid="share-start-live">
          <MousePointerClick size={20} aria-hidden="true" />
          <span className="share-option__title">{s('live')}</span>
          <span className="share-option__desc">{canCropTab() ? s('liveDesc') : `${s('liveDesc')} ${s('liveAudioOnly')}`}</span>
        </button>
        {canShareScreen() && !mobile && <button type="button" className="share-option" onClick={() => onStart('screen', url)} data-testid="share-start-screen">
          <Monitor size={20} aria-hidden="true" />
          <span className="share-option__title">{s('screen')}</span>
          <span className="share-option__desc">{s('screenDesc')}</span>
        </button>}
        <button type="button" className="share-option" onClick={() => onStart('upload')} data-testid="share-start-upload">
          <Upload size={20} aria-hidden="true" />
          <span className="share-option__title">{s('upload')}</span>
          <span className="share-option__desc">{s('uploadDesc')}</span>
        </button>
      </div>
    </section>

    <section className="share-card">
      <h2>{s('received')}</h2>
      {share.recordings.length === 0 ? <p className="share-muted">{s('none')}</p> : <ul className="share-list" data-testid="share-received">
        {[...share.recordings].reverse().map((r) => <li key={r.id} className="share-item">
          <button type="button" className="share-item__thumb" onClick={() => r.mime && setPlaying(r)} disabled={!r.mime} aria-label={s('play')}>
            {r.hasThumbnail ? <img src={thumbUrl(r.id)} alt="" loading="lazy" /> : <Film size={22} aria-hidden="true" />}
            {r.mime && <span className="share-item__play"><Play size={14} aria-hidden="true" /></span>}
          </button>
          <div className="share-item__body">
            <div className="share-item__who">
              <strong>{r.name || s('anonymous')}</strong>
              <span className="share-muted">{formatDate(r.createdAt)} · {modeLabel(r.mode, r.hasVideo)}{r.durationMs ? ` · ${formatDuration(r.durationMs)}` : ''}</span>
            </div>
            {r.notes.length > 0 && <ol className="share-item__notes">
              {r.notes.map((n, i) => <li key={i}><span className="share-muted">{formatDuration(n.t)}</span> {n.text}</li>)}
            </ol>}
          </div>
        </li>)}
      </ul>}
    </section>
    {playing && <Player recording={playing} onClose={() => setPlaying(null)} />}
  </main>
}

function modeLabel(mode: ShareRecordingMode, hasVideo: boolean): string {
  if (mode === 'notes') return s('modeNotes')
  if (!hasVideo) return s('noVideo')
  return s(mode === 'screen' ? 'modeScreen' : mode === 'upload' ? 'modeUpload' : 'modeLive')
}

function Player({ recording, onClose }: { recording: SharePublicRecording; onClose: () => void }) {
  return <div className="share-modal" role="dialog" aria-modal="true" aria-label={s('play')} onClick={onClose}>
    <div className="share-modal__body" onClick={(e) => e.stopPropagation()}>
      <div className="share-modal__head">
        <strong>{recording.name || s('anonymous')}</strong>
        <IconButton label={s('close')} icon={<X size={16} />} onClick={onClose} />
      </div>
      {recording.hasVideo
        ? <video src={mediaUrl(recording.id)} controls autoPlay playsInline className="share-modal__media" />
        : <audio src={mediaUrl(recording.id)} controls autoPlay className="share-modal__media" />}
    </div>
  </div>
}

/* ── メモ（折りたためる。ID・パスワードの値をコピーできる） ─────────────── */

function MemoPanel({ memo, password, onPassword, defaultOpen = false, compact = false }: {
  memo: ShareMemo
  password: string
  onPassword: (value: string) => void
  defaultOpen?: boolean
  compact?: boolean
}) {
  const [open, setOpen] = useState(defaultOpen)
  const [text, setText] = useState<string | null>(memo.kind === 'plain' ? memo.text : null)
  /** 復号に使うパスワード（入れた画面から受け取る。メモの欄で入れ直すこともできる） */
  const [key, setKey] = useState(password)
  useEffect(() => { if (password) setKey(password) }, [password])
  const [typed, setTyped] = useState('')
  const [copied, setCopied] = useState<string | null>(null)
  useEffect(() => {
    if (memo.kind === 'plain') return setText(memo.text)
    if (!key) return
    void openMemo(key, memo.sealed).then(setText)
  }, [memo, key])
  const copy = (value: string, id: string) => {
    void navigator.clipboard.writeText(value).then(() => {
      setCopied(id)
      window.setTimeout(() => setCopied((c) => (c === id ? null : c)), 1500)
    }, () => undefined)
  }
  const lines = (text ?? '').split('\n')
  return <section className={`share-card share-memo${compact ? ' share-memo--compact' : ''}`} data-testid="share-memo">
    <button type="button" className="share-memo__toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
      {open ? <ChevronDown size={14} aria-hidden="true" /> : <ChevronRight size={14} aria-hidden="true" />}
      {s('memoNotice')}
    </button>
    {open && (text === null ? <form className="share-memo__locked" onSubmit={(e) => { e.preventDefault(); setKey(typed); onPassword(typed) }}>
      <p className="share-muted">{s('memoLocked')}</p>
      <input type="password" autoComplete="off" value={typed} onChange={(e) => setTyped(e.target.value)} aria-label={s('password')} />
      <Button disabled={!typed} onClick={() => { setKey(typed); onPassword(typed) }}>{s('show')}</Button>
    </form> : <div className="share-memo__body">
      {lines.map((line, i) => {
        // 「名前: 値」の行は、値だけをコピーできるようにする（確認用の ID・パスワードなど）
        const m = /^\s*([^:：]{1,40})[:：]\s*(\S.*)$/.exec(line)
        return <div key={i} className="share-memo__line">
          <span className="share-memo__text">{line || ' '}</span>
          {m && <button type="button" className="share-memo__copy" onClick={() => copy(m[2]!.trim(), `l${i}`)} aria-label={`${s('copy')}: ${m[1]}`}>
            <Copy size={12} aria-hidden="true" />{copied === `l${i}` ? s('copied') : s('copy')}
          </button>}
        </div>
      })}
      <button type="button" className="share-memo__copy share-memo__copy--all" onClick={() => copy(text, 'all')}>
        <Copy size={12} aria-hidden="true" />{copied === 'all' ? s('copied') : s('copyAll')}
      </button>
    </div>)}
  </section>
}

/* ── 録画して指摘（ライブ・画面共有） ─────────────────────── */

type Phase = { kind: 'idle' } | { kind: 'consent' } | { kind: 'recording'; paused: boolean } | { kind: 'review'; result: RecordingResult; thumbnail?: string } | { kind: 'sending'; percent: number } | { kind: 'sent' } | { kind: 'error'; message: string }

function RecordSession({ share, mode, url, name, password, onDone }: { share: Loaded; mode: 'live' | 'screen'; url: ShareUrl; name: string; password: string; onDone: () => void }) {
  const stageRef = useRef<HTMLDivElement | null>(null)
  const frameRef = useRef<HTMLIFrameElement | null>(null)
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const surfaceRef = useRef<AnnotationSurface | null>(null)
  const composerRef = useRef<ScreenComposer | null>(null)
  const recorderRef = useRef<ShareRecorder | null>(null)
  const streamsRef = useRef<MediaStream[]>([])
  const meterRef = useRef<MicMeter | null>(null)
  const [phase, setPhase] = useState<Phase>(mode === 'screen' ? { kind: 'consent' } : { kind: 'idle' })
  const [tool, setTool] = useState<AnnotationTool>('none')
  const [noteMode, setNoteMode] = useState(false)
  const [color, setColor] = useState<AnnotationColor>(DEFAULT_ANNOTATION_COLOR)
  const [history, setHistory] = useState({ canUndo: false, canRedo: false })
  const [elapsed, setElapsed] = useState(0)
  const [notice, setNotice] = useState<string | null>(null)
  const [noteCount, setNoteCount] = useState(0)
  const [nav, setNav] = useState({ loads: 0, back: 0, forward: 0 })
  const recording = phase.kind === 'recording'
  const paused = phase.kind === 'recording' && phase.paused

  // 書き込む面（アプリと同じ部品）
  useEffect(() => {
    const host = stageRef.current
    if (!host) return
    const surface = new AnnotationSurface(host, {
      clock: () => (recorderRef.current ? recorderRef.current.clock.now() : null),
      labels: { placeholder: s('noteLabelPlaceholder'), hint: s('noteLabelHint'), add: s('noteLabelAdd') },
      mapBox: mode === 'screen' ? (box) => composerRef.current?.mapBox(box) ?? null : undefined,
      onHistory: (canUndo, canRedo) => setHistory({ canUndo, canRedo }),
      onNote: () => setNoteCount((n) => n + 1)
    })
    surfaceRef.current = surface
    return () => surface.destroy()
  }, [mode])
  useEffect(() => { surfaceRef.current?.setTool(recording && !paused ? tool as SurfaceTool : 'none') }, [tool, recording, paused])
  useEffect(() => { surfaceRef.current?.setNoteMode(recording && !paused && noteMode) }, [noteMode, recording, paused])
  useEffect(() => { surfaceRef.current?.setColor(color) }, [color])

  // 経過時間とマイクの入力レベル
  useEffect(() => {
    if (!recording) return
    const timer = window.setInterval(() => {
      setElapsed(recorderRef.current?.clock.now() ?? 0)
      setRecordingLevel(meterRef.current?.level() ?? 0)
    }, 100)
    return () => window.clearInterval(timer)
  }, [recording])

  const stopStreams = () => {
    for (const stream of streamsRef.current) stream.getTracks().forEach((t) => t.stop())
    streamsRef.current = []
    meterRef.current?.close()
    meterRef.current = null
    composerRef.current?.stop()
  }
  useEffect(() => () => stopStreams(), [])

  /** 同意のボタンから（画面を録る許可はこの押した操作の中で求める） */
  const begin = async () => {
    setNotice(null)
    const warnings: string[] = []
    let video: MediaStream | null = null
    if (mode === 'screen') {
      const display = await openScreen()
      if (!display) return setPhase({ kind: 'idle' })
      streamsRef.current.push(display)
      const el = videoRef.current!
      el.srcObject = display
      await el.play().catch(() => undefined)
      await new Promise((done) => (el.videoWidth ? done(null) : el.addEventListener('loadedmetadata', () => done(null), { once: true })))
      const composer = new ScreenComposer(el, surfaceRef.current!.canvas, stageRef.current!)
      composerRef.current = composer
      video = composer.start()
      display.getVideoTracks()[0]?.addEventListener('ended', () => void stop())
    } else {
      video = await openCroppedTab(stageRef.current!)
      if (video) streamsRef.current.push(video)
      else if (canCropTab()) warnings.push(s('captureDenied'))
    }
    const mic = await openMic()
    if (mic) streamsRef.current.push(mic)
    else warnings.push(s('micDenied'))
    meterRef.current = new MicMeter(mic)
    surfaceRef.current?.reset()
    setNoteCount(0)
    const recorder = new ShareRecorder(video, mic)
    recorder.onLimit = () => {
      setNotice(s('limitReached'))
      void stop()
    }
    recorderRef.current = recorder
    recorder.start()
    setNotice(warnings.length ? warnings.join(' ') : null)
    setPhase({ kind: 'recording', paused: false })
  }

  const stop = async () => {
    const recorder = recorderRef.current
    if (!recorder) return
    // サムネイル（映像があれば、止める直前の1コマ）
    let thumbnail: string | undefined
    if (mode === 'screen' && composerRef.current) thumbnail = frameToJpeg(composerRef.current.canvas)
    else if (videoRef.current && streamsRef.current[0]?.getVideoTracks().length) thumbnail = frameToJpeg(videoRef.current)
    const result = await recorder.stop()
    recorderRef.current = null
    stopStreams()
    setTool('none')
    setNoteMode(false)
    setPhase({ kind: 'review', result, ...(thumbnail ? { thumbnail } : {}) })
  }

  // ライブで録る映像の1コマを撮るため、切り抜いた映像を見えない video で流す
  useEffect(() => {
    if (mode !== 'live' || !recording) return
    const stream = streamsRef.current.find((st) => st.getVideoTracks().length > 0)
    if (stream && videoRef.current) {
      videoRef.current.srcObject = stream
      void videoRef.current.play().catch(() => undefined)
    }
  }, [mode, recording])

  const send = async () => {
    if (phase.kind !== 'review') return
    const { result, thumbnail } = phase
    const surface = surfaceRef.current!
    const notes: ShareNote[] = surface.notes.map((n) => ({ ...n }))
    setPhase({ kind: 'sending', percent: 0 })
    try {
      const view = mode === 'screen' && composerRef.current ? { width: composerRef.current.canvas.width || 1, height: composerRef.current.canvas.height || 1 } : surface.viewSize()
      await sendRecording({
        start: {
          ...(name.trim() ? { name: name.trim() } : {}),
          mode: result.blob ? mode : 'notes', bytes: result.blob?.size ?? 0, durationMs: result.durationMs, hasVideo: result.hasVideo,
          ...(result.blob && result.mime ? { mime: result.mime } : {}), ...(mode === 'live' ? { startUrl: url.url } : {})
        },
        blob: result.blob, notes,
        events: { v: 1, view, events: surface.events.slice(0, SHARE_LIMITS.events) },
        ...(thumbnail ? { thumbnail } : {}),
        onProgress: (fraction) => setPhase({ kind: 'sending', percent: Math.round(fraction * 100) })
      })
      setPhase({ kind: 'sent' })
    } catch (err) {
      setPhase({ kind: 'error', message: errorText(err) })
    }
  }

  const toggleRecording = () => {
    if (recording) void stop()
    else if (phase.kind === 'idle') setPhase({ kind: 'consent' })
  }
  const pause = () => {
    const recorder = recorderRef.current
    if (!recorder || phase.kind !== 'recording') return
    if (phase.paused) recorder.resume()
    else recorder.pause()
    setPhase({ kind: 'recording', paused: !phase.paused })
  }

  // ライブのページの戻る・進む（別オリジンのページの履歴は読めないので、読み込みの回数から決める）
  const browserState: BrowserState = useMemo(() => ({
    url: url.url, title: url.title || url.url, canGoBack: mode === 'live' && nav.loads - 1 - nav.back > 0, canGoForward: mode === 'live' && nav.forward > 0,
    loading: false, viewport: 'desktop'
  }), [url, mode, nav])
  useEffect(() => {
    const ade = (window as unknown as { ade: { navigate?: (direction: 'back' | 'forward') => void } }).ade
    ade.navigate = (direction) => {
      setNav((n) => (direction === 'back' ? { ...n, back: n.back + 1, forward: n.forward + 1 } : { ...n, back: Math.max(0, n.back - 1), forward: Math.max(0, n.forward - 1) }))
      if (direction === 'back') window.history.back()
      else window.history.forward()
    }
  }, [])

  return <div className="share-session" data-testid="share-session">
    <FeedbackToolbar
      state={browserState}
      recording={recording}
      elapsed={formatDuration(elapsed)}
      captureMic
      tool={tool}
      onToolChange={(next) => { setTool(next); if (next !== 'none') setNoteMode(false) }}
      color={color}
      onColorChange={setColor}
      onToggleRecording={toggleRecording}
      noteMode={noteMode}
      noteDisabled={!recording || paused}
      // アプリと同じく、文字で指摘を始めたら書き込みの道具を外す（枠・ペンがクリックを取ってしまう）
      onToggleNote={() => { if (!noteMode) setTool('none'); setNoteMode(!noteMode) }}
      paused={paused}
      busy={phase.kind === 'sending'}
      onPause={pause}
      onClear={() => surfaceRef.current?.clear()}
      canUndo={history.canUndo}
      canRedo={history.canRedo}
      onUndo={() => surfaceRef.current?.undo()}
      onRedo={() => surfaceRef.current?.redo()}
      notice={notice}
      target={mode === 'live' ? { kind: 'browser' } : { kind: 'screen', sourceId: 'share', name: s('modeScreen') }}
      extensions={false}
    />
    <div className="share-session__main">
      <div className="share-stage" ref={stageRef} data-testid="share-stage">
        {mode === 'live'
          ? <iframe ref={frameRef} className="share-stage__frame" src={url.url} title={url.title || url.url} referrerPolicy="no-referrer"
            sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-downloads"
            allow="clipboard-write" onLoad={() => setNav((n) => ({ ...n, loads: n.loads + 1 }))} />
          : null}
        <video ref={videoRef} className={mode === 'screen' ? 'share-stage__video' : 'share-stage__hidden'} muted playsInline />
      </div>
      <aside className="share-session__side">
        {share.memo && <MemoPanel memo={share.memo} password={password} onPassword={() => undefined} compact />}
        <div className="share-card share-session__info">
          {mode === 'live' && <p className="share-muted">{s('frameBlocked')} <a href={url.url} target="_blank" rel="noopener noreferrer">{s('openTab')} <ExternalLink size={11} aria-hidden="true" /></a></p>}
          {recording && <p className="share-muted">{s('notes', { count: noteCount })}</p>}
          {!recording && phase.kind === 'idle' && <Button onClick={onDone}>{s('back')}</Button>}
        </div>
      </aside>
    </div>

    {phase.kind === 'consent' && <Consent mode={mode} expiresAt={share.expiresAt} onStart={() => { setPhase({ kind: 'idle' }); void begin() }} onCancel={() => (mode === 'screen' ? onDone() : setPhase({ kind: 'idle' }))} />}
    {phase.kind === 'review' && <div className="share-modal" role="dialog" aria-modal="true" aria-label={s('reviewTitle')}>
      <div className="share-modal__body share-review">
        <h2>{s('reviewTitle')}</h2>
        <p className="share-muted">{s('duration', { time: formatDuration(phase.result.durationMs) })} · {s('notes', { count: surfaceRef.current?.notes.length ?? 0 })}</p>
        {phase.thumbnail && <img className="share-review__thumb" src={`data:image/jpeg;base64,${phase.thumbnail}`} alt="" />}
        <div className="share-row">
          <Button onClick={onDone}>{s('discard')}</Button>
          <Button onClick={() => setPhase(mode === 'screen' ? { kind: 'consent' } : { kind: 'idle' })}>{s('retake')}</Button>
          <Button variant="primary" onClick={() => void send()} disabled={!phase.result.blob && (surfaceRef.current?.notes.length ?? 0) === 0} data-testid="share-send">{s('send')}</Button>
        </div>
      </div>
    </div>}
    {(phase.kind === 'sending' || phase.kind === 'sent' || phase.kind === 'error') && <div className="share-modal" role="dialog" aria-modal="true">
      <div className="share-modal__body share-review" role="status">
        {phase.kind === 'sending' && <p>{s('sending', { percent: phase.percent })}</p>}
        {phase.kind === 'sent' && <><p data-testid="share-sent">{s('sent')}</p><Button variant="primary" onClick={onDone}>{s('back')}</Button></>}
        {phase.kind === 'error' && <><p className="share-error">{phase.message}</p><div className="share-row"><Button onClick={onDone}>{s('back')}</Button></div></>}
      </div>
    </div>}
  </div>
}

function Consent({ mode, expiresAt, onStart, onCancel }: { mode: 'live' | 'screen' | 'upload'; expiresAt: string; onStart: () => void; onCancel: () => void }) {
  return <div className="share-modal" role="dialog" aria-modal="true" aria-label={s('consentTitle')}>
    <div className="share-modal__body share-consent" data-testid="share-consent">
      <h2>{s('consentTitle')}</h2>
      <ul>
        <li>{s('consentRecorded')}</li>
        <li>{s('consentVisible')}</li>
        <li>{s('consentDeleted', { date: formatDate(expiresAt) })}</li>
        {mode === 'screen' && <li className="share-warn">{s('consentScreen')}</li>}
        {mode === 'live' && canCropTab() && <li>{s('consentLiveTab')}</li>}
        {mode === 'live' && !canCropTab() && <li>{s('liveAudioOnly')}</li>}
      </ul>
      <div className="share-row">
        <Button onClick={onCancel}>{s('cancel')}</Button>
        <Button variant="primary" onClick={onStart} disabled={!canRecord() && mode !== 'upload'} data-testid="share-consent-start">{s('consentStart')}</Button>
      </div>
    </div>
  </div>
}

/* ── 端末の画面収録の動画を送る ─────────────────────── */

function UploadSession({ share, name, onDone }: { share: Loaded; name: string; onDone: () => void }) {
  const [file, setFile] = useState<File | null>(null)
  const [comment, setComment] = useState('')
  const [phase, setPhase] = useState<{ kind: 'pick' } | { kind: 'consent' } | { kind: 'sending'; percent: number } | { kind: 'sent' } | { kind: 'error'; message: string }>({ kind: 'pick' })
  const [error, setError] = useState('')
  const pick = (next: File | null) => {
    setError('')
    if (!next) return setFile(null)
    const mime = next.type === 'video/quicktime' || /\.mov$/i.test(next.name) ? 'video/quicktime' : next.type
    if (!['video/mp4', 'video/webm', 'video/quicktime'].includes(mime)) return setError(s('badMedia'))
    if (next.size > SHARE_LIMITS.recordingBytes) return setError(s('tooLarge'))
    setFile(next)
  }
  const send = async () => {
    if (!file) return
    setPhase({ kind: 'sending', percent: 0 })
    try {
      // 長さと最初の1コマ（サムネイル）を手元で読む
      const probe = document.createElement('video')
      probe.muted = true
      probe.playsInline = true
      probe.preload = 'auto'
      // 手元のファイルの中身だけを読む（型はこちらで決めた形式。blob: の URL だけを入れる）
      const local = URL.createObjectURL(new Blob([file], { type: file.type === 'video/webm' ? 'video/webm' : 'video/mp4' }))
      if (!local.startsWith('blob:')) throw new ApiError('bad_media')
      probe.src = new URL(local).href
      await new Promise((done, fail) => { probe.onloadeddata = done; probe.onerror = fail })
      const durationMs = Number.isFinite(probe.duration) ? Math.round(probe.duration * 1000) : 0
      if (durationMs > SHARE_LIMITS.recordingMs) throw new ApiError('too_large')
      probe.currentTime = Math.min(1, probe.duration / 2 || 0)
      await new Promise((done) => { probe.onseeked = done; window.setTimeout(done, 1500) })
      const thumbnail = frameToJpeg(probe)
      URL.revokeObjectURL(local)
      const mime = file.type === 'video/webm' ? 'video/webm' : file.type === 'video/quicktime' || /\.mov$/i.test(file.name) ? 'video/quicktime' : 'video/mp4'
      const text = comment.trim()
      await sendRecording({
        start: { ...(name.trim() ? { name: name.trim() } : {}), mode: 'upload', mime, bytes: file.size, durationMs, hasVideo: true },
        blob: file, notes: text ? [{ t: 0, text: text.slice(0, SHARE_LIMITS.noteChars) }] : [],
        ...(thumbnail ? { thumbnail } : {}),
        onProgress: (fraction) => setPhase({ kind: 'sending', percent: Math.round(fraction * 100) })
      })
      setPhase({ kind: 'sent' })
    } catch (err) {
      setPhase({ kind: 'error', message: errorText(err) })
    }
  }
  return <main className="share-home">
    <section className="share-card share-upload">
      <h2>{s('upload')}</h2>
      <p className="share-muted">{s('uploadDesc')}</p>
      <label className="share-file">
        <Upload size={16} aria-hidden="true" /> {file ? file.name : s('pickFile')}
        <input type="file" accept="video/mp4,video/quicktime,video/webm,video/*" onChange={(e) => pick(e.target.files?.[0] ?? null)} data-testid="share-file" />
      </label>
      {error && <p className="share-error">{error}</p>}
      <label className="share-field">
        <span>{s('comment')}</span>
        <textarea rows={3} maxLength={SHARE_LIMITS.noteChars} value={comment} onChange={(e) => setComment(e.target.value)} />
      </label>
      <div className="share-row">
        <Button onClick={onDone}>{s('cancel')}</Button>
        <Button variant="primary" disabled={!file || phase.kind === 'sending'} onClick={() => setPhase({ kind: 'consent' })}>{s('send')}</Button>
      </div>
      {phase.kind === 'sending' && <p role="status">{s('sending', { percent: phase.percent })}</p>}
      {phase.kind === 'sent' && <p role="status">{s('sent')} <Button onClick={onDone}>{s('back')}</Button></p>}
      {phase.kind === 'error' && <p className="share-error">{phase.message}</p>}
    </section>
    {phase.kind === 'consent' && <Consent mode="upload" expiresAt={share.expiresAt} onStart={() => void send()} onCancel={() => setPhase({ kind: 'pick' })} />}
  </main>
}
