import { BrowserExtensionsButton } from './BrowserExtensionsButton'
import { useCallback, useEffect, useRef, useState, type FocusEvent, type PointerEvent, type ReactNode } from 'react'
import { AppWindow, ArrowLeft, ArrowRight, CodeXml, Eraser, Globe, Hourglass, MessageSquarePlus, MicOff, Monitor, MousePointer2, PanelRight, Pause, Play, PenTool, Plus, Redo2, Square, TriangleAlert, Undo2 } from 'lucide-react'
import { MicPopover, type FooterCapture } from './StatusBar'
import { StatusPopover } from './StatusPopover'
import { micDeviceName } from '../lib/micDevice'
import type { BrowserState, CaptureTarget, SttAvailability } from '@shared/types'
import { captureTargetLabel } from '@shared/captureTarget'
import { MAX_CAPTURE_TRACKS, shortTrackLabel, type CaptureTracksState } from '@shared/captureTracks'
import { browserNavKeys, canBrowserNav, showsBrowserNav } from '@shared/browserNav'
import { ANNOTATION_COLORS, ANNOTATION_COLOR_IDS, DEFAULT_ANNOTATION_COLOR, annotationKeyAction, nextAnnotationColor, type AnnotationColor, type AnnotationKeyAction } from '@shared/annotation'
import type { TranslationKey } from '@shared/i18n'
import { formatShortcut } from '../lib/shortcut'
import { IconButton, RecordButton, RecordDot } from '../ui'
import { useT } from '../lib/i18n'
import { useRecordingLevel } from '../lib/recordingLevel'

/**
 * フィードバックモードのツールバー（設計 3章 / MODE-2）。
 *
 * MTGで相手に画面共有される画面なので、幅いっぱいの帯ではなく
 * **浮いたピル**にして、レビュー対象の画面を最大限見せる。
 *
 * ⚠ 内蔵ブラウザ（WebContentsView）はネイティブのビューで、DOMの上に必ず重なる。
 * つまりピルをページの上に本当に浮かせることはできない。そこで上に細い帯
 * （--size-fb-bar）を確保し、その中でピルを浮かせる。
 *
 * 録画中・一時停止中はひと目で分かるようにする（REC-5 / NF-11）:
 *   録画中   … 縁が赤く光り、点が呼吸し、経過時間が赤くなる
 *   一時停止 … 縁と時間が琥珀色になり、時間が点滅し、「一時停止中」の札が出る
 *
 * ツールチップはビューに隠れるので出さない。代わりにピルの中の
 * 「案内の枠」（ふだんはページ名）を、指しているボタンの名前とキーに差し替える。
 *
 * 録画中の警告（上限が近い・保存の失敗など）もトーストはビューに隠れるので、
 * 同じ枠に数秒だけ出す（notice）。ボタンの案内より優先する。
 */
/**
 * 録画中に使える書き込みの道具（PEN-1）。手書きの線と、ドラッグで囲む四角の枠。
 * none は「ブラウザを操作」（矢印の道具）で、録画を始めたときはこれが選ばれている。
 * 依頼は声と書き込みで行うので、画面に文字を置く道具は無い
 */
export type AnnotationTool = 'none' | 'pen' | 'rect'

type Keys = ReadonlyArray<string>

/** menu.ts の accelerator と対応させる（録画 CmdOrCtrl+Shift+R / モード CmdOrCtrl+Shift+M）*/
const KEYS = {
  record: ['Mod', 'Shift', 'R'],
  mode: ['Mod', 'Shift', 'M'],
  targets: ['Mod', 'Shift', 'K'],
  holdPen: ['Alt'],
  browse: ['V'],
  // 録画中の書き込み（@shared/annotation の annotationKeyAction と対応させる）
  pen: ['P'],
  rect: ['B'],
  color: ['C'],
  undo: ['Mod', 'Z'],
  redo: ['Mod', 'Shift', 'Z']
} as const satisfies Record<string, Keys>

/** キーを1つずつキーキャップにする（⌘ ⇧ R） */
function KeyCaps({ keys }: { keys: Keys }) {
  return (
    <span className="fb-keycaps" aria-hidden="true">
      {keys.map((key) => (
        <kbd key={key} className="fb-keycap">
          {formatShortcut(key)}
        </kbd>
      ))}
    </span>
  )
}

/** マイクの入力レベル。5本のバーで、声の大きさに合わせて伸びる */
function MicLevel({ live }: { live: boolean }) {
  // rms は話し声でも 0.05〜0.2 程度なので5倍して 0〜1 に寄せる
  const t = useT()
  const level = useRecordingLevel()
  const value = live ? Math.min(1, level * 5) : 0
  return (
    <span
      className={`fb-mic${live ? ' is-live' : ''}`}
      role="meter"
      aria-label={t('feedback.micLevel')}
      aria-valuemin={0}
      aria-valuemax={1}
      aria-valuenow={Number(value.toFixed(2))}
    >
      {[0.35, 0.7, 1, 0.7, 0.35].map((weight, index) => (
        <span
          // 並びは固定。キーは位置で足りる
          // eslint-disable-next-line react/no-array-index-key
          key={index}
          className="fb-mic__bar"
          style={{ transform: `scaleY(${Math.max(0.18, Math.min(1, value * weight * 1.6))})` }}
        />
      ))}
    </span>
  )
}

export function FeedbackToolbar({
  state,
  captureMic = true,
  recording,
  elapsed,
  tool = 'none',
  onToolChange,
  color = DEFAULT_ANNOTATION_COLOR,
  onColorChange,
  onToggleRecording,
  noteMode = false,
  noteDisabled = false,
  onToggleNote,
  onBackToEditor,
  paused = false,
  busy = false,
  onPause,
  onClear,
  canUndo = false,
  canRedo = false,
  onUndo,
  onRedo,
  notice,
  target = { kind: 'browser' },
  onPickTarget,
  targetsOpen,
  targetsAlert,
  onToggleTargets,
  tracks,
  onSwitchTrack,
  onAddTrack,
  mic,
  extensions = true
}: {
  captureMic?: boolean
  state: BrowserState
  recording: boolean
  elapsed: string
  /** 選択中の道具。録画中だけ選べる */
  tool?: AnnotationTool
  onToolChange?: (tool: AnnotationTool) => void
  /** 書き込みの色。録画していないときも選べる（次の録画から使う） */
  color?: AnnotationColor
  onColorChange?: (color: AnnotationColor) => void
  onToggleRecording: () => void
  /** 文字で指摘（録画の右。録画していないときに枠と文字で指摘する。音声の代わり） */
  noteMode?: boolean
  noteDisabled?: boolean
  onToggleNote?: () => void
  /** エディタへ戻る（一番左）。省けばボタンを出さない（共有リンクの相手の画面。workers/feedback-share/client） */
  onBackToEditor?: () => void
  paused?: boolean
  busy?: boolean
  onPause?: () => void
  onClear?: () => void
  /** 書き込みを一つ前に戻す・やり直す（描く・動かす・消去が1手）。できないときはボタンを押せない */
  canUndo?: boolean
  canRedo?: boolean
  onUndo?: () => void
  onRedo?: () => void
  /** 帯に短く出す警告。無ければページ名・ボタンの案内を出す */
  notice?: string | null
  /** 録画の対象（内蔵ブラウザ／画面全体／別のウインドウ） */
  target?: CaptureTarget
  /** 録画の対象の選択画面を開く。録画中は押せない */
  onPickTarget?: () => void
  /** 右パネル（レビュー対象の一覧）が開いているか */
  targetsOpen?: boolean
  /** 右パネルの開閉。録画中も押せる */
  onToggleTargets?: () => void
  /** 文字起こしに問題があるとき、開閉ボタンに印を付けて出す文（右パネルの文字起こしのタブを見ていない間だけ） */
  targetsAlert?: string | null
  /**
   * 録画中に録っている映像（トラック）と待ち受け（@shared/captureTracks）。2本以上・待ち受けがあるときは
   * チップを並べ、押すと画面に映して書き込むものが切り替わる（録画はどれも続ける）
   */
  tracks?: CaptureTracksState
  onSwitchTrack?: (id: string) => void
  /** 録画中にほかのウインドウ・画面も同時に録る（選択画面を開く） */
  onAddTrack?: () => void
  /** 内蔵ブラウザの拡張機能のボタンを出すか（共有リンクの相手の画面では出さない） */
  extensions?: boolean
  /** マイクのメニュー（つながっているマイクの名前・入力レベルのテスト・選択）。フッターのものと同じ */
  mic?: {
    settings: FooterCapture
    onChange: (patch: Partial<FooterCapture>) => void
    devices: Array<{ id: string; label: string }>
    available: SttAvailability
    onOpenSettings: () => void
    /** 開いている間は内蔵ブラウザのビューを隠す（ビューは DOM の上に重なる） */
    onPopoverChange?: (open: boolean) => void
  }
}) {
  /* 録画中は書き込みの道具が使える。止まっている間は押せない */
  const t = useT()
  const pick = (next: AnnotationTool) => onToolChange?.(tool === next ? 'none' : next)
  // 画面・ウインドウを録っているときは、内蔵ブラウザのページ名ではなく録っている対象を出す
  const liveTracks = recording ? tracks?.tracks ?? [] : []
  const waiting = recording ? tracks?.waiting ?? [] : []
  const activeTrack = liveTracks.length > 1 ? liveTracks.find((track) => track.active) : undefined
  // 複数の映像を録っているときは、映しているものの名前を出す
  const page = activeTrack && activeTrack.kind !== 'browser' ? activeTrack.label
    : target.kind === 'browser' || activeTrack?.kind === 'browser' ? state.title || state.url.replace(/^https?:\/\//, '') : captureTargetLabel(target)
  const isPaused = recording && paused
  // つながっているマイクの名前（録る前に確かめられるよう、帯に出す）
  const micRef = useRef<HTMLButtonElement | null>(null)
  const [micOpen, setMicOpen] = useState(false)
  const onMicPopover = mic?.onPopoverChange
  useEffect(() => onMicPopover?.(micOpen), [micOpen, onMicPopover])
  const closeMic = useCallback(() => setMicOpen(false), [])
  const micName = !captureMic ? t('feedback.micOff') : (mic ? micDeviceName(mic.settings.micDeviceId, mic.devices) : null) ?? t('statusBar.systemDefault')
  const toolsOff = !recording || paused || busy

  /*
   * 書き込みのショートカット（録画中だけ）。焦点がツールバー側にあるときはここで、
   * ページ（内蔵ブラウザ）にあるときは注入スクリプトが受けて main 経由で annotation:shortcut が届く。
   * 入力欄・ターミナル・エディタで打っているときは奪わない。
   */
  useEffect(() => {
    if (toolsOff) return
    const run = (action: AnnotationKeyAction): boolean => {
      switch (action) {
        case 'pen':
        case 'rect':
          onToolChange?.(action)
          return true
        case 'off':
          if (tool === 'none') return false
          onToolChange?.('none')
          return true
        case 'color':
          onColorChange?.(nextAnnotationColor(color))
          return true
        case 'undo':
          if (!canUndo) return false
          onUndo?.()
          return true
        case 'redo':
          if (!canRedo) return false
          onRedo?.()
          return true
      }
    }
    const mac = window.ade.platform === 'darwin'
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.repeat || event.isComposing || event.defaultPrevented) return
      const target = event.target instanceof HTMLElement ? event.target : null
      if (target && (target.isContentEditable || target.closest('input, textarea, select, [contenteditable], .xterm, .monaco-editor, dialog'))) return
      const action = annotationKeyAction(event, mac)
      if (action && run(action)) event.preventDefault()
    }
    const off = window.ade.on('annotation:shortcut', (action) => void run(action))
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      off()
    }
  }, [toolsOff, tool, color, canUndo, canRedo, onToolChange, onColorChange, onUndo, onRedo])

  /*
   * 指しているボタンの案内。無ければページ名を出す。
   * 押せないボタンはイベントを受けないので、ボタンを包む枠（data-hint）で拾い、
   * ピル全体への委譲で読む（離れたときに消し損ねない）。
   */
  const hints: Record<string, { label: string; keys?: Keys; note?: string; hold?: Keys }> = {
    back: { label: t('browser.back'), keys: browserNavKeys('back', window.ade.platform) },
    forward: { label: t('browser.forward'), keys: browserNavKeys('forward', window.ade.platform) },
    target: { label: t('feedback.target', { target: captureTargetLabel(target) }) },
    extensions: { label: t('browserExtensions.buttonTitle') },
    record: { label: recording ? t('feedback.stop') : t('feedback.record'), keys: KEYS.record },
    note: { label: noteMode ? t('textNote.button.stopTitle') : t('textNote.button.title') },
    pause: { label: paused ? t('feedback.resume') : t('feedback.pause') },
    browse: { label: t('feedback.browse'), keys: KEYS.browse, hold: ['Escape'] },
    pen: { label: t('feedback.pen'), keys: KEYS.pen, hold: KEYS.holdPen, note: t('feedback.whileHeld') },
    rect: { label: t('feedback.rect'), keys: KEYS.rect },
    color: { label: `${t('feedback.color')}: ${t(`feedback.color.${color}` as TranslationKey)}`, keys: KEYS.color },
    undo: { label: t('menu.undo'), keys: KEYS.undo },
    redo: { label: t('menu.redo'), keys: KEYS.redo },
    clear: { label: t('feedback.clear') },
    editor: { label: t('feedback.toEditor'), keys: KEYS.mode },
    targets: { label: t('feedbackTargets.toggle'), keys: KEYS.targets },
    addTrack: { label: liveTracks.length >= MAX_CAPTURE_TRACKS ? t('recording.tracks.limit', { n: MAX_CAPTURE_TRACKS }) : t('feedback.tracks.add') },
    ...Object.fromEntries(liveTracks.map((track) => [`track:${track.id}`, { label: t('feedback.tracks.switch', { label: track.label }) }])),
    ...Object.fromEntries(waiting.map((w) => [`wait:${w.id}`, { label: t('feedback.tracks.waiting', { label: w.label }) }]))
  }
  const [hintId, setHintId] = useState<string | null>(null)
  /** 色の候補を案内の枠に並べているか（ビューに隠れるので、浮かせたメニューにはしない） */
  const [colorsOpen, setColorsOpen] = useState(false)
  const chooseColor = (next: AnnotationColor) => {
    setColorsOpen(false)
    onColorChange?.(next)
  }
  const hint = hintId ? hints[hintId] : undefined
  const pointHint = (event: PointerEvent | FocusEvent) => {
    const slot = (event.target as Element).closest<HTMLElement>('[data-hint]')
    setHintId(slot?.dataset.hint ?? null)
  }
  // key は録っている映像のチップを並べるとき用（id は帯の中で一意）
  const slot = (id: string, node: ReactNode) => (
    <span key={id} className="fb-slot" data-hint={id}>
      {node}
    </span>
  )

  const pillClass = [
    'fb-pill',
    recording ? 'is-recording' : '',
    isPaused ? 'is-paused' : '',
    tool !== 'none' && recording && !paused ? `has-tool has-tool--${tool}` : ''
  ]
    .filter(Boolean)
    .join(' ')

  const divider = <span className="fb-pill__divider" aria-hidden="true" />

  return (
    <div className="fb-bar" data-testid="feedback-toolbar">
      <div
        className={pillClass}
        onPointerOver={pointHint}
        onPointerLeave={() => setHintId(null)}
        onFocus={pointHint}
        onBlur={() => setHintId(null)}
      >
        {/* エディタへ戻るのは一番左。右端はレビュー対象のパネルの開閉 */}
        {onBackToEditor && slot(
          'editor',
          <IconButton
            label={t('feedback.toEditorMode')}
            size="sm"
            className="fb-btn"
            icon={<CodeXml size={18} strokeWidth={1.75} />}
            onClick={onBackToEditor}
            data-testid="back-to-editor"
          />
        )}

        {onBackToEditor && divider}

        <span className="fb-status">
          {isPaused ? (
            <span className="fb-status__pause" aria-hidden="true">
              <span />
              <span />
            </span>
          ) : (
            <RecordDot active={recording} size={9} />
          )}
          <span className="fb-status__elapsed" data-testid="elapsed">
            {elapsed}
          </span>
          {isPaused && <span className="fb-status__badge">{t('feedback.paused')}</span>}
        </span>

        {mic ? (
          <button ref={micRef} type="button" className="fb-micbtn" aria-expanded={micOpen} data-testid="feedback-mic"
            title={t('feedback.micTitle', { name: micName })} onClick={() => setMicOpen((open) => !open)}>
            {captureMic ? <MicLevel live={recording && !paused} /> : <span className="fb-mic is-off" role="img" aria-label={t('feedback.micOff')}><MicOff size={15} strokeWidth={1.75} /></span>}
            <span className="fb-micbtn__name" data-testid="feedback-mic-name">{micName}</span>
          </button>
        ) : captureMic ? (
          <MicLevel live={recording && !paused} />
        ) : (
          <span className="fb-mic is-off" role="img" aria-label={t('feedback.micOff')}>
            <MicOff size={15} strokeWidth={1.75} />
          </span>
        )}
        {mic && micOpen && <StatusPopover anchor={micRef.current} placement="below" label={t('statusBar.micAndTranscription')} onClose={closeMic}>
          <MicPopover value={mic.settings} onChange={mic.onChange} recording={recording} micDevices={mic.devices} available={mic.available}
            onOpenSettings={() => { closeMic(); mic.onOpenSettings() }} />
        </StatusPopover>}

        {divider}

        {/* 内蔵ブラウザの戻る・進む。録画中も押せる（ページが変わると書き込みを確定して消す流れは controller.ts） */}
        {showsBrowserNav(target) && slot(
          'back',
          <IconButton
            label={t('browser.back')}
            size="sm"
            className="fb-btn"
            disabled={busy || !canBrowserNav('back', state, target)}
            onClick={() => void window.ade.invoke('browser:back')}
            data-testid="feedback-back"
            icon={<ArrowLeft size={18} strokeWidth={1.75} />}
          />
        )}
        {showsBrowserNav(target) && slot(
          'forward',
          <IconButton
            label={t('browser.forward')}
            size="sm"
            className="fb-btn"
            disabled={busy || !canBrowserNav('forward', state, target)}
            onClick={() => void window.ade.invoke('browser:forward')}
            data-testid="feedback-forward"
            icon={<ArrowRight size={18} strokeWidth={1.75} />}
          />
        )}
        {/* 拡張機能のポップアップ。録画中も開ける（ポップアップも動画・静止画に重ねて録る） */}
        {showsBrowserNav(target) && extensions && slot('extensions', <BrowserExtensionsButton className="fb-btn" testId="feedback-extensions" />)}
        {onPickTarget && slot(
          'target',
          <IconButton
            label={t('feedback.pickTarget')}
            size="sm"
            className="fb-btn"
            disabled={recording || busy}
            onClick={onPickTarget}
            data-testid="feedback-target"
            icon={target.kind === 'screen' ? <Monitor size={18} strokeWidth={1.75} /> : target.kind === 'window' ? <AppWindow size={18} strokeWidth={1.75} /> : <Globe size={18} strokeWidth={1.75} />}
          />
        )}
        {slot(
          'record',
          <RecordButton
            compact
            recording={recording}
            disabled={busy}
            onClick={onToggleRecording}
            data-testid="feedback-record"
          />
        )}
        {onToggleNote && slot(
          'note',
          <IconButton
            label={noteMode ? t('textNote.button.stopTitle') : t('textNote.button.label')}
            size="sm"
            className="fb-btn"
            selected={noteMode}
            disabled={noteDisabled && !noteMode}
            onClick={onToggleNote}
            data-testid="feedback-text-note"
            icon={<MessageSquarePlus size={18} strokeWidth={1.75} />}
          />
        )}
        {slot(
          'pause',
          <IconButton
            label={paused ? t('feedback.resume') : t('feedback.pause')}
            size="sm"
            className={`fb-btn${isPaused ? ' fb-btn--resume' : ''}`}
            disabled={!recording || busy}
            onClick={onPause}
            icon={paused ? <Play size={18} strokeWidth={2} /> : <Pause size={18} strokeWidth={1.75} />}
          />
        )}

        {/* 録っている映像（トラック）。押すと映すもの（書き込む先）が切り替わる。待ち受けのウインドウは開くまで薄く出す */}
        {recording && (liveTracks.length > 1 || waiting.length > 0 || onAddTrack) && <>
          {divider}
          <span className="fb-tracks" role="group" aria-label={t('feedback.tracks.label')} data-testid="feedback-tracks">
            {liveTracks.length > 1 && liveTracks.map((track) => slot(
              `track:${track.id}`,
              <button
                type="button"
                className={`fb-track${track.active ? ' is-active' : ''}`}
                aria-pressed={track.active}
                aria-label={t('feedback.tracks.switch', { label: track.label })}
                disabled={busy}
                onClick={() => { if (!track.active) onSwitchTrack?.(track.id) }}
                data-testid={`feedback-track-${track.id}`}
              >
                {track.kind === 'browser' ? <Globe size={13} strokeWidth={1.9} aria-hidden="true" /> : track.kind === 'screen' ? <Monitor size={13} strokeWidth={1.9} aria-hidden="true" /> : <AppWindow size={13} strokeWidth={1.9} aria-hidden="true" />}
                <span className="fb-track__label">{shortTrackLabel(track.label)}</span>
              </button>
            ))}
            {waiting.map((w) => slot(
              `wait:${w.id}`,
              <span className="fb-track is-waiting" role="status" aria-label={t('feedback.tracks.waiting', { label: w.label })} data-testid={`feedback-track-waiting-${w.id}`}>
                <Hourglass size={12} strokeWidth={1.9} aria-hidden="true" />
                <span className="fb-track__label">{shortTrackLabel(w.label)}</span>
              </span>
            ))}
            {onAddTrack && slot(
              'addTrack',
              <IconButton
                label={t('feedback.tracks.add')}
                size="sm"
                className="fb-btn"
                disabled={busy || paused || liveTracks.length >= MAX_CAPTURE_TRACKS}
                onClick={onAddTrack}
                data-testid="feedback-add-track"
                icon={<Plus size={16} strokeWidth={1.9} />}
              />
            )}
          </span>
        </>}

        {divider}

        {slot(
          'browse',
          <IconButton
            label={t('feedback.browse')}
            size="sm"
            className="fb-btn fb-btn--tool"
            disabled={toolsOff}
            selected={recording && tool === 'none'}
            onClick={() => onToolChange?.('none')}
            data-testid="feedback-browse"
            icon={<MousePointer2 size={18} strokeWidth={1.75} />}
          />
        )}
        {slot(
          'pen',
          <IconButton
            label={t('feedback.pen')}
            size="sm"
            className="fb-btn fb-btn--tool"
            disabled={toolsOff}
            selected={tool === 'pen'}
            onClick={() => pick('pen')}
            icon={<PenTool size={18} strokeWidth={1.75} />}
          />
        )}
        {slot(
          'rect',
          <IconButton
            label={t('feedback.rect')}
            size="sm"
            className="fb-btn fb-btn--tool"
            disabled={toolsOff}
            selected={tool === 'rect'}
            onClick={() => pick('rect')}
            data-testid="feedback-rect"
            icon={<Square size={17} strokeWidth={1.9} />}
          />
        )}
        {onColorChange && slot(
          'color',
          <IconButton
            label={t('feedback.color')}
            size="sm"
            className="fb-btn"
            disabled={busy}
            selected={colorsOpen}
            onClick={() => setColorsOpen((open) => !open)}
            data-testid="feedback-color"
            icon={<span className="fb-color-dot" style={{ background: ANNOTATION_COLORS[color] }} />}
          />
        )}
        {slot(
          'clear',
          <IconButton
            label={t('feedback.clear')}
            size="sm"
            className="fb-btn"
            disabled={toolsOff}
            onClick={onClear}
            icon={<Eraser size={18} strokeWidth={1.75} />}
          />
        )}
        {onUndo && slot(
          'undo',
          <IconButton
            label={t('menu.undo')}
            size="sm"
            className="fb-btn"
            disabled={toolsOff || !canUndo}
            onClick={onUndo}
            data-testid="feedback-undo"
            icon={<Undo2 size={18} strokeWidth={1.75} />}
          />
        )}
        {onRedo && slot(
          'redo',
          <IconButton
            label={t('menu.redo')}
            size="sm"
            className="fb-btn"
            disabled={toolsOff || !canRedo}
            onClick={onRedo}
            data-testid="feedback-redo"
            icon={<Redo2 size={18} strokeWidth={1.75} />}
          />
        )}

        {divider}

        {/* ふだんはページ名だけ（パスやフォルダは出さない。MODE-2）。指したボタンの案内に差し替わる */}
        <span className={`fb-hint${notice ? ' has-notice' : ''}`} title={notice ?? (hint || colorsOpen ? undefined : state.url)}>
          {colorsOpen ? (
            <span className="fb-colors" role="radiogroup" aria-label={t('feedback.color')}>
              {ANNOTATION_COLOR_IDS.map((id) => (
                <button
                  key={id}
                  type="button"
                  role="radio"
                  aria-checked={id === color}
                  aria-label={t(`feedback.color.${id}` as TranslationKey)}
                  title={t(`feedback.color.${id}` as TranslationKey)}
                  className="fb-colors__swatch"
                  style={{ background: ANNOTATION_COLORS[id] }}
                  onClick={() => chooseColor(id)}
                  data-testid={`feedback-color-${id}`}
                />
              ))}
            </span>
          ) : notice ? (
            <span className="fb-hint__notice" role="alert" data-testid="feedback-notice" key={notice}>
              <TriangleAlert size={14} strokeWidth={2} aria-hidden="true" />
              <span className="fb-hint__notice-text">{notice}</span>
            </span>
          ) : hint ? (
            <span className="fb-hint__tip" key={hintId}>
              <span>{hint.label}</span>
              {hint.keys && <KeyCaps keys={hint.keys} />}
              {hint.hold && <KeyCaps keys={hint.hold} />}
              {hint.note && <span className="fb-hint__note">{hint.note}</span>}
            </span>
          ) : (
            <span className="fb-hint__page">{page || t('feedback.noPage')}</span>
          )}
        </span>

        {divider}

        {onToggleTargets && slot(
          'targets',
          <IconButton
            label={targetsAlert ? `${t('feedbackTargets.toggle')} · ${targetsAlert}` : t('feedbackTargets.toggle')}
            size="sm"
            className={targetsAlert ? 'fb-btn fb-btn--alert' : 'fb-btn'}
            title={targetsAlert ?? undefined}
            selected={targetsOpen}
            icon={<PanelRight size={18} strokeWidth={1.75} />}
            onClick={onToggleTargets}
            data-testid="feedback-targets-toggle"
          />
        )}
      </div>
    </div>
  )
}
