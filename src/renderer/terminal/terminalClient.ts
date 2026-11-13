import { agentNewlineData, freshForegroundAgent, terminalKeyAction, windowsAgentPasteData } from './terminalKeys'
import { InputHold } from './inputHold'
import { parseOsc52 } from './terminalOsc52'
import { minimumContrastFor } from './terminalContrast'
import { windowsPtyOption } from './windowsPty'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import type { TerminalSize, TuiAgent } from '@shared/types'
import { THEME_CHANGE_EVENT } from '../lib/theme'
import { t } from '@shared/i18n'
import { reportAnomaly, reportHandled } from '@shared/report'
import { ImeInputGuard } from './imeInputGuard'
import { isWebglUnavailable } from './rendererFallback'
import { RESTORE_LINE_LIMIT, capScrollback, joinWrappedRows } from '@shared/terminalRestore'
import { selectionTextForCopy } from './wrappedCopy'
import { isScrolledUp } from './jumpToBottom'
import { shellPathsText, shellQuotingFor } from '@shared/externalDrop'
import { hasClipboardFiles } from './clipboardPaste'

/**
 * renderer 側のターミナル実体（xterm.js）を管理する。
 *
 * React の外に置く: xterm はDOMを自分で持ち、再レンダリングで作り直されると
 * 画面と履歴が消えるため、インスタンスの寿命はReactのツリーと切り離す。
 *
 * 描画は WebGL を第一候補にし、使えなければ Canvas → DOM へ落とす（設計 1.3）。
 */

type RendererKind = 'webgl' | 'canvas' | 'dom'

/** 1つのペインが覚えておく行数。多くの Agent のタブを並べると、ペインの数だけ renderer のメモリを使う（5000 → 3000。戻す分は RESTORE_LINE_LIMIT の 2000 行） */
export const TERMINAL_SCROLLBACK = 3000
/**
 * 画面の文字（terminal:screen。main の Agent の状態の判定に使う）を送る間隔。
 * 画面に出ていないペインは間を空ける（出力のたびに画面の全行を文字に直すのが重い）
 */
export const SCREEN_REPORT_MS = 200
export const HIDDEN_SCREEN_REPORT_MS = 1000
/**
 * 隠れたペインの WebGL の描画を手放すまでの待ち。WebGL の文脈はペインごとに GPU のメモリを使い、
 * 数に上限もある（多いと古いものから失われる）。タブを行き来するたびに作り直さないよう、しばらく隠れたままのものだけ手放す
 */
export const WEBGL_RELEASE_DELAY_MS = 10_000

/** 画面の文字を送るまでの待ち */
export function screenReportDelay(visible: boolean): number {
  return visible ? SCREEN_REPORT_MS : HIDDEN_SCREEN_REPORT_MS
}

function cssVar(name: string, fallback: string): string {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  return value.length > 0 ? value : fallback
}

function theme() {
  return {
    foreground: cssVar('--term-fg', '#d7dce3'),
    background: cssVar('--term-bg', '#0b0d11'),
    cursor: cssVar('--term-cursor', '#4c8dff'),
    selectionBackground: cssVar('--term-selection', '#2b3a52'),
    black: cssVar('--term-black', '#2b303b'),
    red: cssVar('--term-red', '#ff6b63'),
    green: cssVar('--term-green', '#4ec98b'),
    yellow: cssVar('--term-yellow', '#e3b341'),
    blue: cssVar('--term-blue', '#5a9cff'),
    magenta: cssVar('--term-magenta', '#c58cff'),
    cyan: cssVar('--term-cyan', '#4fd0d6'),
    white: cssVar('--term-white', '#c6ccd6'),
    brightBlack: cssVar('--term-bright-black', '#5b6472'),
    brightRed: cssVar('--term-bright-red', '#ff8d86'),
    brightGreen: cssVar('--term-bright-green', '#74dda6'),
    brightYellow: cssVar('--term-bright-yellow', '#f0cc6b'),
    brightBlue: cssVar('--term-bright-blue', '#85b7ff'),
    brightMagenta: cssVar('--term-bright-magenta', '#d6abff'),
    brightCyan: cssVar('--term-bright-cyan', '#7fe0e4'),
    brightWhite: cssVar('--term-bright-white', '#f0f3f7')
  }
}

export class TerminalHandle {
  readonly term: Terminal
  private readonly fitAddon = new FitAddon()
  private disposers: Array<() => void> = []
  private pending: string[] = []
  private opened = false
  /**
   * xterm を開く器。React の描画先とは別に持ち、分割で木の形が変わってペインのDOMが
   * 作り直されても、この器を新しい場所へ移すだけで画面と履歴を保つ
   */
  private readonly host: HTMLDivElement
  /** 上へスクロールしている間だけ右下に出す「一番下へ」のボタン */
  private readonly jumpButton: HTMLButtonElement
  private screenTimer: ReturnType<typeof setTimeout> | null = null
  private fitFrame = 0
  /** 器が 0px（非表示のタブ・閉じたターミナル）から見える大きさに戻った。次の fit で全面を描き直す */
  private revealPending = false
  /** 読み込み直しのあと、保存した出力を流し直している間（中の問い合わせへの xterm の返事を PTY へ送らない） */
  private replaying = false
  /** 器に大きさがある（画面に出ている）。変わったら main へ知らせる（terminal:visible。裏のペインは出力をゆっくりまとめる） */
  visible = false
  /** 使っている WebGL の描画（隠れている間は手放す） */
  private webgl: { dispose: () => void } | null = null
  /** 隠れている間に WebGL を手放した。見えるようになったら作り直す */
  private webglReleased = false
  private webglReleaseTimer: ReturnType<typeof setTimeout> | null = null

  ptyId: string | null = null
  /** 画面に書いた回数。終了・閉じたあとに戻すための画面の文字を、変わったときだけ取り出し直す（TerminalPane） */
  outputSeq = 0
  /** 前面で動いている Agent（TerminalPane が1秒ごとの状態の問い合わせで更新する。Shift+Enter の扱いに使う） */
  foregroundAgent: TuiAgent | null = null
  get agentForeground(): boolean {
    return this.foregroundAgent !== null
  }
  /** PTY へ送る入力（Shift+Enter のキー列をその場で決めている間の打鍵を、順番どおりに後から送る。inputHold.ts） */
  private readonly input = new InputHold((data) => {
    if (this.ptyId) void window.ade.invoke('terminal:write', this.ptyId, data)
    else this.pending.push(data)
  })
  renderer: RendererKind = 'dom'

  constructor(readonly key: string) {
    this.term = new Terminal({
      allowProposedApi: true,
      cursorBlink: true,
      fontFamily: cssVar('--font-mono', 'monospace'),
      fontSize: Number.parseInt(cssVar('--term-font-size', '12px'), 10) || 12,
      lineHeight: Number.parseFloat(cssVar('--term-line-height', '1.2')) || 1.2,
      scrollback: TERMINAL_SCROLLBACK,
      // 大量出力時のちらつきを抑える（PTY側でまとめているので描画も1回で足りる）
      smoothScrollDuration: 0,
      // Windows の ConPTY の折り返しの扱いを合わせる（幅を変えたときの崩れを防ぐ）
      windowsPty: windowsPtyOption(window.ade.platform, window.ade.systemVersion),
      // macOS で、マウスを使う TUI（vim・tmux・Agent）の上でも ⌥ を押しながらドラッグすれば文字を選べる（Orca #15103 #9727）
      macOptionClickForcesSelection: true,
      theme: theme()
    })
    this.term.options.minimumContrastRatio = minimumContrastFor(this.term.options.theme?.background ?? '')
    this.term.loadAddon(this.fitAddon)
    this.host = document.createElement('div')
    this.host.className = 'terminal-host'
    // Agent が出力し続けている間に上を読んでいても、1回押せば最新の行まで移れる（ホイールで下まで送り続けなくてよい）
    this.jumpButton = document.createElement('button')
    this.jumpButton.type = 'button'
    this.jumpButton.className = 'terminal-jump'
    this.jumpButton.textContent = '↓'
    this.jumpButton.title = t('terminal.jumpToBottom')
    this.jumpButton.setAttribute('aria-label', t('terminal.jumpToBottom'))
    this.jumpButton.dataset.testid = 'terminal-jump-to-bottom'
    this.jumpButton.hidden = true
    // 押してもターミナルの入力の焦点を奪わない
    this.jumpButton.addEventListener('mousedown', (event) => event.preventDefault())
    this.jumpButton.addEventListener('click', () => {
      this.term.scrollToBottom()
      this.updateJumpButton()
      this.term.focus()
    })
    this.host.appendChild(this.jumpButton)
    const onViewportScroll = () => this.updateJumpButton()
    // ホイール・スクロールバーでの移動（xterm の .xterm-viewport の scroll は泡立たないので capture で受ける）
    this.host.addEventListener('scroll', onViewportScroll, true)
    const scrolled = this.term.onScroll(onViewportScroll)
    const written = this.term.onWriteParsed(onViewportScroll)
    this.disposers.push(() => {
      this.host.removeEventListener('scroll', onViewportScroll, true)
      scrolled.dispose()
      written.dispose()
    })
    // ライト／ダークの切り替えに追従する（tokens.css の --term-* を読み直す）
    const onTheme = () => {
      const next = theme()
      this.term.options.theme = next
      this.term.options.minimumContrastRatio = minimumContrastFor(next.background)
    }
    window.addEventListener(THEME_CHANGE_EVENT, onTheme)
    this.disposers.push(() => window.removeEventListener(THEME_CHANGE_EVENT, onTheme))
    // IME の確定文字が xterm の2つの経路から重ねて送られるのを、送る直前で1回にする（imeInputGuard.ts）。
    // 器の capture で受けるので、xterm の textarea の処理より先に変換の始まり・終わりが分かる
    const imeGuard = new ImeInputGuard()
    const onCompositionStart = () => imeGuard.compositionStart()
    const onCompositionEnd = (event: CompositionEvent) => imeGuard.compositionEnd(performance.now(), event.data)
    const onKeyDown = (event: KeyboardEvent) => imeGuard.keyDown(event)
    this.host.addEventListener('compositionstart', onCompositionStart, true)
    this.host.addEventListener('compositionend', onCompositionEnd, true)
    this.host.addEventListener('keydown', onKeyDown, true)
    this.disposers.push(() => {
      this.host.removeEventListener('compositionstart', onCompositionStart, true)
      this.host.removeEventListener('compositionend', onCompositionEnd, true)
      this.host.removeEventListener('keydown', onKeyDown, true)
    })
    // Shift+Enter の改行、Windows / Linux のコピー・貼り付け、macOS の ⌘← などを xterm より先に受ける（terminalKeys.ts）。
    // keydown のときだけ実行し、同じキーの keypress / keyup も xterm に渡さない（渡すと Enter の CR などが重ねて送られる）
    this.term.attachCustomKeyEventHandler((event) => {
      const action = terminalKeyAction(event, window.ade.platform, { hasSelection: this.term.hasSelection() })
      if (!action) return true
      if (event.type !== 'keydown') return false
      event.preventDefault()
      if (action.kind === 'send') this.sendInput(action.data)
      else if (action.kind === 'newline') this.sendNewline()
      else if (action.kind === 'copy') this.copySelection()
      else void this.pasteClipboard()
      return false
    })
    // 端末の中のプログラムのコピー（OSC 52）。確認なしで main が写す（大きさとアプリの窓のフォーカスは main が見る。src/main/terminalClipboard.ts）。
    // 読み出しの問い合わせには答えない（terminalOsc52.ts）
    const osc52 = this.term.parser.registerOscHandler(52, (data) => {
      const request = parseOsc52(data)
      // 流し直しの間の古いコピーで、そのあと利用者が写したものを上書きしない
      const ptyId = this.ptyId
      if (request.kind === 'write' && !this.replaying && ptyId) {
        window.ade.invoke('terminal:programCopy', ptyId, request.text)
          .catch((err) => reportHandled(err, { area: 'terminal', op: 'osc52 clipboard write' }))
      }
      return true
    })
    this.disposers.push(() => osc52.dispose())
    // ターミナルにフォーカスがある間は、Windows / Linux のメニューに Ctrl+R・Ctrl+W などを取らせない（main の before-input-event）
    const onFocusIn = () => this.reportFocus(true)
    const onFocusOut = () => this.reportFocus(false)
    // 右クリックや編集メニューの貼り付けも、Ctrl+V と同じ経路で送る（Windows の Agent への複数行の貼り付け）
    const onPaste = (event: ClipboardEvent) => {
      const text = event.clipboardData?.getData('text/plain')
      // クリップボードにファイル（Finder・エクスプローラーでコピーした動画・画像）や画像（スクリーンショット）があれば、
      // main がプロジェクトの .ferret/pasted/ に写し、そのパスを入れる（デスクトップから落としたときと同じ）
      if (hasClipboardFiles(event.clipboardData)) {
        event.preventDefault()
        event.stopPropagation()
        void this.pasteClipboardFiles(text ?? '')
        return
      }
      if (!text || !this.agentPasteData(text)) return
      event.preventDefault()
      event.stopPropagation()
      this.pasteText(text)
    }
    // ⌘C（macOS の編集メニューのコピー）は xterm の入力欄の copy として届く。xterm より先に受けて、
    // TUI が自分で折り返した行を1行に戻して写す（wrappedCopy.ts）
    const onCopy = (event: ClipboardEvent) => {
      if (!this.term.hasSelection() || !event.clipboardData) return
      event.clipboardData.setData('text/plain', this.selectionForCopy())
      event.preventDefault()
      event.stopPropagation()
    }
    this.host.addEventListener('focusin', onFocusIn)
    this.host.addEventListener('focusout', onFocusOut)
    this.host.addEventListener('paste', onPaste, true)
    this.host.addEventListener('copy', onCopy, true)
    this.disposers.push(() => {
      this.host.removeEventListener('focusin', onFocusIn)
      this.host.removeEventListener('focusout', onFocusOut)
      this.host.removeEventListener('paste', onPaste, true)
      this.host.removeEventListener('copy', onCopy, true)
      if (this.focused) this.reportFocus(false)
    })
    // 入力は開く前から受けられるようにしておく（PTYができる前の打鍵は pending にためる）
    const onData = this.term.onData((raw) => {
      if (this.replaying) return
      const data = imeGuard.filter(raw, performance.now())
      if (data.length === 0) return
      this.sendInput(data)
    })
    this.disposers.push(() => onData.dispose())
    // 器の大きさが変わるたびに（分割・ドラッグ・ウィンドウ・ターミナルの配置の変更・表示の切り替え）、
    // まだ開いていなければ開き、開いていれば寸法を合わせ直す
    const observer = new ResizeObserver(() => {
      const visible = this.host.isConnected && this.host.clientWidth > 0 && this.host.clientHeight > 0
      if (!visible) this.revealPending = this.opened
      if (visible !== this.visible) {
        this.visible = visible
        reportVisibility()
        if (visible) this.restoreWebgl()
        else this.scheduleWebglRelease()
      }
      this.tryOpen()
      this.scheduleFit()
    })
    observer.observe(this.host)
    this.disposers.push(() => observer.disconnect())
  }

  /**
   * node の中に表示する。別の node へ移されたら器ごと移す（xterm は作り直さない）。
   *
   * xterm を実際に開く（term.open）のは、器に大きさが付いてから。非表示のタブや、閉じた（0px の）ターミナルの
   * 中で開くと、xterm が文字の寸法を 0 と測ったままになり、表示しても真っ黒のまま描かれない。
   * 開く前に届いた出力は xterm のバッファに入っているので、開いた時点でそのまま描かれる
   */
  open(node: HTMLElement): void {
    if (this.host.parentElement !== node) node.appendChild(this.host)
    this.tryOpen()
  }

  private tryOpen(): void {
    if (this.opened || this.host.clientWidth === 0 || this.host.clientHeight === 0) return
    this.term.open(this.host)
    this.opened = true
    // 描画の切り替えやフォントの読み込みで文字の寸法が変わったときも合わせ直す
    void this.loadRenderer().then(() => this.scheduleFit())
    void document.fonts?.ready.then(() => this.scheduleFit())
    this.scheduleFit()
  }

  /** WebGL → Canvas → DOM の順に試す。読み込みは遅延させて起動を軽くする */
  private async loadRenderer(): Promise<void> {
    try {
      await this.loadWebgl()
      return
    } catch (err) {
      console.warn('[terminal] WebGL描画を使えません。Canvasへ切り替えます', err)
      // GPU が無い環境で WebGL2 を取れないのは想定内（rendererFallback.ts）。それ以外の失敗だけ送る
      if (!isWebglUnavailable(err)) reportHandled(err, { area: 'terminal', op: 'load webgl renderer' })
    }
    await this.loadCanvas()
  }

  private async loadWebgl(): Promise<void> {
    const { WebglAddon } = await import('@xterm/addon-webgl')
    const addon = new WebglAddon()
    addon.onContextLoss(() => {
      // GPU のリセットなどで WebGL の描画が失われた。Canvas へ切り替えて続ける
      reportAnomaly('xterm webgl context lost', { kind: 'render', area: 'terminal' })
      if (this.webgl === addon) this.webgl = null
      addon.dispose()
      void this.loadCanvas()
    })
    this.term.loadAddon(addon)
    this.webgl = addon
    this.renderer = 'webgl'
    // 読み込みを待つ間に隠れた：しばらくしたら手放す
    if (!this.visible) this.scheduleWebglRelease()
  }

  /** 隠れたまま WEBGL_RELEASE_DELAY_MS たったら WebGL の描画を手放す（その間は xterm の DOM の描画のまま。隠れているので描かない） */
  private scheduleWebglRelease(): void {
    if (!this.webgl || this.webglReleaseTimer) return
    this.webglReleaseTimer = setTimeout(() => {
      this.webglReleaseTimer = null
      const addon = this.webgl
      if (this.visible || !addon) return
      this.webgl = null
      this.webglReleased = true
      try {
        addon.dispose()
      } catch (err) {
        reportHandled(err, { area: 'terminal', op: 'release webgl renderer' })
      }
    }, WEBGL_RELEASE_DELAY_MS)
  }

  /** 見えるようになった。手放していた WebGL の描画を作り直す（作り直せなければ Canvas へ） */
  private restoreWebgl(): void {
    if (this.webglReleaseTimer) {
      clearTimeout(this.webglReleaseTimer)
      this.webglReleaseTimer = null
    }
    if (!this.webglReleased || !this.opened) return
    this.webglReleased = false
    void this.loadWebgl()
      .catch(async (err: unknown) => {
        if (!isWebglUnavailable(err)) reportHandled(err, { area: 'terminal', op: 'reload webgl renderer' })
        await this.loadCanvas()
      })
      .then(() => {
        this.revealPending = true
        this.scheduleFit()
      })
  }

  private async loadCanvas(): Promise<void> {
    try {
      const { CanvasAddon } = await import('@xterm/addon-canvas')
      this.term.loadAddon(new CanvasAddon())
      this.renderer = 'canvas'
    } catch (err) {
      console.warn('[terminal] Canvas描画も使えません。DOM描画で続けます', err)
      reportHandled(err, { area: 'terminal', op: 'load canvas renderer' })
      this.renderer = 'dom'
    }
  }

  private updateJumpButton(): void {
    const show = isScrolledUp(this.term.buffer.active)
    if (this.jumpButton.hidden === show) this.jumpButton.hidden = !show
  }

  /** 次のフレームで寸法を合わせ、変わっていればPTYにも伝える（非表示のあいだは何もしない） */
  scheduleFit(): void {
    cancelAnimationFrame(this.fitFrame)
    this.fitFrame = requestAnimationFrame(() => {
      if (!this.opened || this.host.clientWidth === 0 || this.host.clientHeight === 0) return
      // 最下部を見ていたら、寸法を変えたあとも最下部に留める（折り返しが変わって上へ飛ぶのを防ぐ。Orca #377 #7118）
      const buffer = this.term.buffer.active
      const atBottom = buffer.viewportY >= buffer.baseY
      const size = this.fit()
      if (size && atBottom && this.term.buffer.active.viewportY < this.term.buffer.active.baseY) this.term.scrollToBottom()
      if (size && this.revealPending) {
        // 隠れている間に GPU の文字のキャッシュが古くなり、表示し直すと文字が化けたまま残ることがある。
        // 見えるようになったときに1回だけ消して全面を描き直す（出力のたびには行わない。Orca #1847 #6901 #15813）
        this.revealPending = false
        this.term.clearTextureAtlas()
        this.term.refresh(0, this.term.rows - 1)
      }
      // 区切り線をドラッグしている間は表示だけ合わせ、PTY へは離したときに1回だけ伝える。
      // 毎フレーム伝えるとシェルや TUI が描き直し続け、プロンプトが崩れる（Orca #2910）
      if (!size || !this.ptyId || ptyResizeHeld) return
      const sent = this.ptySent
      if (!sent || size.cols !== sent.cols || size.rows !== sent.rows || !this.ptySized || this.redrawPending) {
        this.ptySized = true
        this.ptySent = size
        if (this.redrawPending && size.rows > 1) {
          // 大きさを一度だけ揺らして、全画面の TUI（Claude Code / Codex など）に描き直してもらう
          void window.ade.invoke('terminal:resize', this.ptyId, { cols: size.cols, rows: size.rows - 1 })
        }
        this.redrawPending = false
        void window.ade.invoke('terminal:resize', this.ptyId, size)
      }
    })
  }

  /** PTYへ今の寸法を一度でも伝えたか。80x24 の仮の大きさで作ったPTYを、表示時に必ず合わせ直す */
  private ptySized = false
  /** 最後に PTY へ伝えた寸法 */
  private ptySent: TerminalSize | null = null
  /** 次に寸法を伝えるとき、大きさを一度揺らして描き直してもらう（読み込み直しのあと、つなぎ直したとき） */
  private redrawPending = false

  /**
   * 画面を読み込み直したあと、生きている PTY につなぎ直す。直近の出力を流し直し、
   * 表示したときに TUI へ描き直しを頼む（流し直した出力は途中から始まることがあるため）
   */
  reattach(ptyId: string, history: string, size?: TerminalSize, redraw = true): void {
    // 出力は PTY の今の幅で折り返されているので、同じ大きさにしてから流し直す（違う幅だと崩れる）
    if (size && size.cols >= 2 && size.rows >= 1) this.term.resize(size.cols, size.rows)
    // 先に起動しておいたシェル（TerminalPane）は rc を読み終えたプロンプトだけなので、描き直しは頼まない
    this.redrawPending = redraw
    this.outputSeq++
    if (!history) {
      this.bindPty(ptyId)
      return
    }
    // 流し直す出力に含まれる問い合わせ（カーソル位置・端末の種類など）に xterm が今答えると、その返事が
    // 生きているシェルや Agent に文字として入る。書き終わるまで返事を捨て、そのあとでつなぐ（Orca #8128 #24092）
    // ptyId は先に付ける（流し直しの間に届いた新しい出力も、履歴のあとに順に書かれる）
    this.replaying = true
    this.ptyId = ptyId
    reportVisibility()
    this.term.write(history, () => {
      this.replaying = false
      if (this.ptyId === ptyId) this.bindPty(ptyId)
    })
  }

  /** キーの代わりに送る文字列。PTY ができる前なら打鍵と同じく pending にためる */
  private sendInput(data: string): void {
    this.input.send(data)
  }

  /**
   * Shift+Enter。前面の Agent の改行のキー列を送る（terminalKeys.ts の agentNewlineData）。1秒ごとの問い合わせの間に
   * Agent を起動した・終えた直後でも取り違えないよう、その場で問い合わせ直してから決める（その間の打鍵は後に順に送る）。
   * 返事が来なければ最後に分かった状態で送る
   */
  private sendNewline(): void {
    const known = this.foregroundAgent
    const ptyId = this.ptyId
    if (!ptyId) {
      this.sendInput(agentNewlineData(known))
      return
    }
    this.input.send(freshForegroundAgent(() => window.ade.invoke('terminal:agentState', ptyId), known, 1500).then((agent) => {
      if (this.ptyId === ptyId) this.foregroundAgent = agent
      return agentNewlineData(agent)
    }))
  }

  /** 写す文字列。狭い窓で TUI が折り返したコマンドも、貼ればそのまま1つのコマンドとして動くようにつなぐ */
  private selectionForCopy(): string {
    return selectionTextForCopy(this.term, window.ade.platform === 'win32' ? '\r\n' : '\n')
  }

  private copySelection(): void {
    const text = this.selectionForCopy()
    if (!text) return
    // Windows Terminal と同じく、写したら選択を外す（次の Ctrl+C は中断として届く）
    this.term.clearSelection()
    window.ade.invoke('terminal:writeClipboard', text).catch((err) => reportHandled(err, { area: 'terminal', op: 'copy selection' }))
  }

  private focused = false
  private reportFocus(focused: boolean): void {
    this.focused = focused
    window.ade.invoke('terminal:focused', focused).catch((err) => reportHandled(err, { area: 'terminal', op: 'report focus' }))
  }

  /** Windows で Agent へ複数行を貼るときに PTY へ直接書く文字列（terminalKeys.ts）。null なら xterm に任せる */
  private agentPasteData(text: string): string | null {
    return windowsAgentPasteData(text, window.ade.platform, { agentForeground: this.agentForeground, bracketedPasteMode: this.term.modes.bracketedPasteMode })
  }

  /** 外から落としたファイルのパスなどを入力として貼る（実行はしない）。貼ったペインにフォーカスを移す */
  insertText(text: string): void {
    if (!text) return
    this.pasteText(text)
    this.term.focus()
  }

  /** term.paste はブラケットペーストのモードに従って包んで送る（複数行が1行ずつ実行されない） */
  private pasteText(text: string): void {
    const data = this.agentPasteData(text)
    if (data === null) {
      this.term.paste(text)
      return
    }
    this.term.clearSelection()
    this.term.scrollToBottom()
    this.sendInput(data)
  }

  /**
   * クリップボードのファイル・画像を貼る。main が写したファイルの絶対パスを、落としたときと同じ形（シェルのクォート）で入れる。
   * 取り込めなかったら（SSH のプロジェクトなど）、文字の部分だけをふつうに貼る
   */
  private async pasteClipboardFiles(fallbackText: string): Promise<void> {
    try {
      const paths = await window.ade.invoke('terminal:pasteFiles')
      const text = paths?.length ? shellPathsText(paths, shellQuotingFor(window.ade.platform)) : ''
      if (text) this.insertText(text)
      else if (fallbackText) this.pasteText(fallbackText)
    } catch {
      // 大きすぎる・多すぎるなど（想定外の失敗は main の IPC が Sentry へ送る）。文字の部分だけ貼る
      if (fallbackText) this.pasteText(fallbackText)
    }
  }

  /**
   * Ctrl+V（Windows / Linux）。クリップボードは読まず、main に OS の貼り付けを頼む（security-7 [1]）。
   * 中身はふつうの貼り付け（paste のイベント）として入力欄に届き、onPaste が Agent 向けの包み方を決める
   */
  private async pasteClipboard(): Promise<void> {
    try {
      await window.ade.invoke('terminal:paste')
    } catch (err) {
      reportHandled(err, { area: 'terminal', op: 'paste clipboard' })
    }
  }

  bindPty(ptyId: string): void {
    this.ptyId = ptyId
    reportVisibility()
    this.ptySized = false
    this.scheduleFit()
    if (this.pending.length > 0) {
      const data = this.pending.join('')
      this.pending = []
      void window.ade.invoke('terminal:write', ptyId, data)
    }
  }

  /**
   * 終了・閉じる前の画面の文字を書く（PTY を作る前。@shared/terminalRestore の restoreReplayText）。
   * 制御文字は落としてあるが、念のため書き終わるまで xterm の返事を PTY へ送らない
   */
  restoreScreen(text: string): void {
    if (!text) return
    this.outputSeq++
    this.replaying = true
    this.term.write(text, () => {
      this.replaying = false
    })
  }

  /**
   * 終了・閉じたあとに戻すための画面の文字（通常の画面の、折り返す前の行で新しい側から RESTORE_LINE_LIMIT 行まで）。
   * 全画面の TUI（vim など）が使う別の画面は含めない。色・制御文字は含めない
   */
  scrollbackText(): string {
    const buffer = this.term.buffer.normal
    // 折り返しで1行が何行にもなるので、行数の上限より多めに見る
    const start = Math.max(0, buffer.length - RESTORE_LINE_LIMIT * 4)
    const rows: Array<{ text: string; wrapped: boolean }> = []
    for (let i = start; i < buffer.length; i++) {
      const line = buffer.getLine(i)
      if (line) rows.push({ text: line.translateToString(false), wrapped: line.isWrapped })
    }
    return capScrollback(joinWrappedRows(rows).join('\n'))
  }

  /** written: xterm が書き終えたとき（main の流量制御への ack に使う） */
  write(data: string, written?: () => void): void {
    this.outputSeq++
    this.term.write(data, () => {
      written?.()
      if (this.screenTimer || !this.ptyId) return
      // 画面に出ていないペインは間を空ける（Agent の状態の判定が少し遅れるだけ）
      this.screenTimer = setTimeout(() => {
        this.screenTimer = null
        if (!this.ptyId) return
        const buffer = this.term.buffer.active
        const lines: string[] = []
        for (let i = buffer.baseY; i < buffer.baseY + this.term.rows; i++) lines.push(buffer.getLine(i)?.translateToString(true) ?? '')
        void window.ade.invoke('terminal:screen', this.ptyId, lines.join('\n'))
      }, screenReportDelay(this.visible))
    })
  }

  size(): TerminalSize {
    return { cols: this.term.cols, rows: this.term.rows }
  }

  /** 表示中のタブだけ呼ぶ（非表示のタブは寸法が0になり、fitが誤った値を返す） */
  fit(): TerminalSize | null {
    try {
      this.fitAddon.fit()
    } catch {
      // 寸法が決まる前（非表示・破棄中）は測れない（想定内。次の fit で測り直す）
      return null
    }
    const size = this.size()
    if (size.cols < 2 || size.rows < 1) return null
    return size
  }

  focus(): void {
    this.term.focus()
  }

  /**
   * 画面に出ている文字列。E2Eが出力を確認するために使う。
   * WebGL / Canvas 描画ではDOMに文字が残らないため、xtermのバッファから取り出す。
   */
  readText(): string {
    const buffer = this.term.buffer.active
    const lines: string[] = []
    for (let i = 0; i < buffer.length; i++) {
      lines.push(buffer.getLine(i)?.translateToString(true) ?? '')
    }
    return lines.join('\n').replace(/\n+$/, '')
  }

  dispose(): void {
    if (this.screenTimer) clearTimeout(this.screenTimer)
    if (this.webglReleaseTimer) clearTimeout(this.webglReleaseTimer)
    cancelAnimationFrame(this.fitFrame)
    for (const dispose of this.disposers) dispose()
    this.disposers = []
    this.host.remove()
    try {
      this.term.dispose()
    } catch (err) {
      // 描画アドオンの破棄でまれに例外が出ても、タブは閉じられるようにする
      console.warn('[terminal] 破棄中にエラーが出ました', err)
      reportHandled(err, { area: 'terminal', op: 'dispose xterm' })
    }
  }
}

const handles = new Map<string, TerminalHandle>()

/** 最後に main へ知らせた、画面に出ているターミナル（同じなら送らない） */
let lastVisible: string | null = null
let visibilityQueued = false

/** 画面に出ているターミナルの PTY の id（並びは決まった順） */
export function visiblePtyIds(entries: Iterable<{ ptyId: string | null; visible: boolean }>): string[] {
  const ids: string[] = []
  for (const entry of entries) if (entry.visible && entry.ptyId) ids.push(entry.ptyId)
  return ids.sort()
}

/**
 * 画面に出ているターミナルを main へ知らせる（terminal:visible）。同じ処理の中の変化はまとめて1回にする。
 * 見えるようになったターミナルは、main がためていた出力をすぐ送る
 */
function reportVisibility(): void {
  if (visibilityQueued) return
  visibilityQueued = true
  queueMicrotask(() => {
    visibilityQueued = false
    const ids = visiblePtyIds(handles.values())
    const key = ids.join('\n')
    if (key === lastVisible) return
    lastVisible = key
    void window.ade.invoke('terminal:visible', ids).catch(() => undefined /* 画面の閉じかけ（想定内） */)
  })
}

let subscribed = false
let ptyResizeHeld = false

/** 区切り線のドラッグの間 true。false に戻したとき、各ターミナルの寸法を PTY へ伝え直す */
export function holdPtyResize(held: boolean): void {
  if (ptyResizeHeld === held) return
  ptyResizeHeld = held
  if (!held) for (const handle of handles.values()) handle.scheduleFit()
}

function subscribe(): void {
  if (subscribed) return
  subscribed = true
  window.ade.on('terminal:data', (ptyId, data) => {
    // 描き終えた量を main へ返す（返さないと main は未処理が溜まったとみなして PTY を止める）。表示先の無い出力もすぐ返す
    const ack = (): void => { void window.ade.invoke('terminal:ack', ptyId, data.length).catch(() => undefined) }
    for (const handle of handles.values()) {
      if (handle.ptyId === ptyId) {
        handle.write(data, ack)
        return
      }
    }
    ack()
  })
  window.ade.on('terminal:exit', (ptyId, exitCode) => {
    for (const handle of handles.values()) {
      if (handle.ptyId === ptyId) {
        handle.write(`\r\n\u001b[2m${t('terminal.processExited', { code: exitCode })}\u001b[0m\r\n`)
        handle.ptyId = null
        reportVisibility()
        return
      }
    }
  })
}

export function acquireTerminal(key: string): TerminalHandle {
  subscribe()
  let handle = handles.get(key)
  if (!handle) {
    handle = new TerminalHandle(key)
    handles.set(key, handle)
  }
  return handle
}

export function releaseTerminal(key: string): void {
  const handle = handles.get(key)
  if (!handle) return
  handles.delete(key)
  if (handle.ptyId) void window.ade.invoke('terminal:close', handle.ptyId)
  handle.dispose()
  reportVisibility()
}

export function getTerminal(key: string): TerminalHandle | undefined {
  return handles.get(key)
}

