/**
 * Agent の状態検知（04_benchmark.md 3.5）と、入力欄の準備完了待ち（3.3）。
 *
 * 採ったもの: 状態の4値、`done` は表示層の派生値、`seen` の更新規則、
 * `working → idle` の確定遅延、起動直後は publish しない。
 * **採らなかったもの**: マニフェスト駆動のルールエンジン（並列管理をしないため不要）。
 *
 * 実際の `claude` / `codex` を pty で起動して採取した結果（2026-10-02、各1回）:
 * - 起動直後の確認ダイアログの段階では **OSC 0/2 のタイトルが出ない**。
 *   そのため OSC だけに頼れず、画面末尾のテキストも見る必要がある。
 * - 両方とも `\x1b[?2004h`（ブラケットペースト有効化）と `\x1b[?25h`（カーソル表示）を出す。
 * - codex は `›` を、claude は確認ダイアログで「Enter to confirm」を出す。
 */
import type { AgentKind, AgentState, DisplayState } from './protocol'

// ───────────────────────── タイトルの整形 ─────────────────────────

/** スピナー文字（Braille と、Agent が使う記号） */
const SPINNER = /^[⠀-⣿·✢✳✶✻✽◐◓◑◒]\s/u

/** 先頭のスピナーを剥がす。タイトルが毎秒書き換わるのを吸収する */
export function stripSpinner(title: string): string {
  return title.replace(SPINNER, '').trim()
}

/** 先頭がスピナーか（working の手がかり） */
function hasSpinner(title: string): boolean {
  return SPINNER.test(title)
}

// ───────────────────────── 状態の判定 ─────────────────────────

/** 権限の確認待ちを表す文字列（実際の出力から。保守的に絞る） */
const PERMISSION_PATTERNS: RegExp[] = [
  // claude: フォルダの信頼、コマンド実行やファイル編集の許可
  /Do you want to (?:proceed|allow|make this edit)/i,
  /Yes,\s*I trust this folder/i,
  /Enter to confirm\s*·\s*Esc to cancel/i,
  // claude: 選択式の質問（AskUserQuestion）やメニュー。本文を送ると選択肢の欄に入って失われる（Orca #19743。
  // Claude Code 2.1 の実際の表示「↑/↓ to navigate · Enter to select · Esc to …」）
  /Enter to select\b/i,
  /\bAllow\b.*\?\s*$/im,
  // codex
  /Action Required/i,
  /Approve (?:this )?command/i,
  /Allow Codex to/i,
  // 起動直後の更新確認など、Enter を取られるメニュー（実際の出力から）
  /Press enter to continue/i
]

/** 待機中であることが画面に見えている手がかり（即確定してよい） */
const VISIBLE_IDLE_PATTERNS: RegExp[] = [
  // claude の入力欄
  /^\s*[>❯]\s*$/m,
  // codex の入力欄
  /^\s*›(?:\s*$|\s+(?:Ask Codex to do anything|Find and fix|Implement|Explain|Write tests|Improve))/m
]

interface DetectInput {
  /** OSC 0/2 で設定されたタイトル（あれば） */
  title?: string
  /** 画面末尾のテキスト（ANSI を落としたもの） */
  tail?: string
}

/**
 * 状態を判定する。OSC のタイトルを優先し、無ければ画面末尾のテキストを見る。
 * プロセス名は「どの Agent か」の同定にだけ使い、ここには入れない。
 */
export function detectState(kind: AgentKind, input: DetectInput): AgentState {
  const tail = normalizeTail(input.tail ?? '')

  // 権限の確認待ちが最優先。ここで送ると事故になる
  if (PERMISSION_PATTERNS.some((re) => re.test(tail))) return 'blocked'

  // 出力本文の「working tree」などを処理中と誤認しない。CLIの状態行だけを見る。
  if (/\besc to interrupt\b/i.test(tail) || /^\s*(?:[•◦·⠁-⣿]\s*)?(?:Working|Thinking)(?:\s*\(|\s*…|\s*\.\.\.|\s*$)/im.test(tail)) return 'working'

  if (kind === 'codex' && /^\s*›\s+(?:Ask Codex to do anything|Find and fix|Implement|Explain|Write tests|Improve)/m.test(tail)) return 'idle'

  // ほかのエージェントは待機中の見え方がそれぞれ違う。タイトルが付いているだけで待機と決めると誤るので、
  // Orca がタイトルから状態を読む手がかり（下の detectGenericTitleState）に当たるときだけ決め、
  // それ以外は「不明」にする（送信側は出力が落ち着いたかで判断する。Orca の quiet-render と同じ）
  if (kind === 'generic') return detectGenericTitleState(input.title)

  const title = input.title
  if (title !== undefined && title.trim().length > 0) {
    if (hasSpinner(title) && !(kind === 'claude-code' && title.startsWith('✳ '))) return 'working'
    const bare = stripSpinner(title)
    if (kind === 'codex' && /Action Required/i.test(bare)) return 'blocked'
    // claude は待機中に `✳ ` 始まりのタイトルを出す（スピナーを剥がすと残りが本文）
    if (bare.length > 0) return 'idle'
  }

  if (VISIBLE_IDLE_PATTERNS.some((re) => re.test(tail))) return 'idle'
  return 'unknown'
}

/**
 * Claude Code / Codex 以外のエージェントの、OSC タイトルからの状態。
 *
 * Orca由来: ~/bench/orca/src/shared/agent-title-core.ts（GEMINI_* の記号、STRONG_IDLE/WORKING_KEYWORDS_RE、
 *           BRAILLE_SPINNER_RE、QUARTER_CIRCLE_SPINNER_RE）（MIT, Copyright 2026 Lovecast Inc.）
 * Gemini 系の記号（✋ 確認待ち・✦ ⏲ 処理中・◇ 待機）、点字・四分円のスピナー、
 * 単独の語（working / thinking / running、ready / idle / done）だけを見る。パスの中の語（~/codex/ready など）は数えない
 */
const TITLE_PERMISSION = '\u270b'
const TITLE_WORKING_GLYPHS = /[\u2726\u23f2\u2800-\u28ff\u25d0-\u25d3]/
const TITLE_IDLE_GLYPH = '\u25c7'
const TITLE_WORKING_WORD = /(?<![\w./\\-])(working|thinking|running)(?![\w-])/i
const TITLE_IDLE_WORD = /(?<![\w./\\-])(ready|idle|done)(?![\w-])/i

export function detectGenericTitleState(title: string | undefined): AgentState {
  if (!title || !title.trim()) return 'unknown'
  if (title.includes(TITLE_PERMISSION)) return 'blocked'
  if (TITLE_WORKING_GLYPHS.test(title) || hasSpinner(title) || TITLE_WORKING_WORD.test(title)) return 'working'
  if (title.includes(TITLE_IDLE_GLYPH) || TITLE_IDLE_WORD.test(title)) return 'idle'
  return 'unknown'
}

/** 画面に待機中のしるしが見えているか（確定遅延を飛ばしてよい条件） */
export function hasVisibleIdle(tail: string): boolean {
  return VISIBLE_IDLE_PATTERNS.some((re) => re.test(normalizeTail(tail)))
}

/**
 * ANSI エスケープを落として画面末尾のテキストにする。
 *
 * **カーソル移動を空白・改行に戻すのが要点。** claude も codex も、単語の区切りに
 * 空白を出さずカーソルを動かす（`Enter\x1b[8Gto\x1b[11Gconfirm`）。
 * そのまま全部消すと `Entertoconfirm` のように繋がってしまい、文字列で判定できない
 * （実際の出力を採って確認した）。
 */
export function stripAnsi(data: string): string {
  // どのターミナルの出力も main で毎回ここを通る。エスケープが無ければ 8 回の置き換えを飛ばす
  if (!data.includes('\x1b')) return data
  return (
    data
      // OSC（タイトル・ハイパーリンク）
      .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
      // 行・桁の移動は改行／空白に戻す
      .replace(/\x1b\[[0-9]*;?[0-9]*[Hf]/g, '\n')
      .replace(/\x1b\[[0-9]*[GC]/g, ' ')
      .replace(/\x1b\[[0-9]*[AB]/g, '\n')
      // そのほかの CSI
      .replace(/\x1b\[[0-9;?<=>]*[ -/]*[@-~]/g, '')
      .replace(/\x1b[>=P^_].*?(?:\x1b\\|\x07)/g, '')
      .replace(/\x1b[()][B0]/g, '')
      .replace(/\x1b[>=cq78]/g, '')
  )
}

/** 判定の前に空白のゆらぎを均す（TUIの描画で空白の数が変わるため） */
export function normalizeTail(tail: string): string {
  return tail.replace(/[ \t]+/g, ' ').replace(/\s*\n\s*/g, '\n')
}

/** OSC 0 / 2（タイトル）を取り出す。最後のものを使う */
export function parseTitle(data: string): string | undefined {
  // ほとんどの出力にはタイトルが無い（出力のたびに呼ばれるので、正規表現の前に OSC の始まりだけ見る）
  if (!data.includes('\x1b]')) return undefined
  const matches = [...data.matchAll(/\x1b\](?:0|2);([^\x07\x1b]*)(?:\x07|\x1b\\)/g)]
  const last = matches[matches.length - 1]
  return last?.[1]
}

/** プロセス名やコマンド行から Agent を同定する */
export function identifyAgent(command: string): AgentKind {
  if (/(^|[/\s])claude(\s|$)/.test(command)) return 'claude-code'
  if (/(^|[/\s])codex(\s|$)/.test(command)) return 'codex'
  return 'unknown'
}

// ───────────────────────── 状態の保持と `done` ─────────────────────────

interface TrackerOptions {
  /** 起動直後、状態を publish しない時間(ms) */
  startupQuietMs: number
  /** `working → idle` の確定を待つ時間(ms) */
  settleMs: number
  /** 確定に必要な連続回数 */
  settleChecks: number
  now: () => number
}

const defaultTrackerOptions: TrackerOptions = {
  startupQuietMs: 3000,
  settleMs: 700,
  settleChecks: 3,
  now: () => Date.now()
}

/**
 * 状態を保持し、`done`（終わったがまだ見ていない）を導く。
 *
 * - `idle` 以外になれば `seen = false` の対象になる（＝あとで done を出せる）
 * - `working|blocked → idle` のとき、見ているタブなら即 seen（idle 表示）、
 *   見ていないタブなら unseen（done 表示）
 * - `working → idle` は点滅を防ぐため確定を遅らせる。画面に待機中のしるしが見えていれば即確定
 */
export class AgentStateTracker {
  private readonly opt: TrackerOptions
  private readonly startedAt: number
  private state: AgentState = 'unknown'
  private seen = true
  /** 確定待ちの候補 */
  private pending?: { state: AgentState; since: number; checks: number }
  private exited = false

  constructor(options: Partial<TrackerOptions> = {}) {
    this.opt = { ...defaultTrackerOptions, ...options }
    this.startedAt = this.opt.now()
  }

  /**
   * 観測した状態を入れる。確定したら true を返す（UIへ通知してよい合図）。
   * @param visible いまそのターミナルを見ているか
   */
  observe(next: AgentState, options: { visible: boolean; visibleIdle?: boolean } = { visible: true }): boolean {
    if (this.exited) return false
    // 起動直後の過渡状態は拾わない
    if (this.opt.now() - this.startedAt < this.opt.startupQuietMs) return false

    if (next === this.state) {
      this.pending = undefined
      return false
    }

    // working → idle だけ確定を遅らせる（点滅防止）
    const needsSettle = this.state === 'working' && next === 'idle' && !options.visibleIdle &&
      this.opt.settleChecks > 1 && this.opt.settleMs > 0
    if (needsSettle) {
      const now = this.opt.now()
      if (!this.pending || this.pending.state !== next) {
        this.pending = { state: next, since: now, checks: 1 }
        return false
      }
      this.pending.checks += 1
      const enough = this.pending.checks >= this.opt.settleChecks
      const expired = now - this.pending.since >= this.opt.settleMs
      if (!enough && !expired) return false
    }

    this.commit(next, options.visible)
    return true
  }

  /** プロセスが終了した。保留を飛ばして必ず idle で確定する */
  markExited(options: { visible: boolean } = { visible: true }): void {
    this.exited = true
    this.commit('idle', options.visible)
  }

  /** そのターミナルを見た。done を idle へ戻す唯一の条件 */
  markSeen(): void {
    this.seen = true
  }

  private commit(next: AgentState, visible: boolean): void {
    const wasBusy = this.state === 'working' || this.state === 'blocked'
    this.state = next
    this.pending = undefined

    if (next !== 'idle') {
      // idle 以外になったら「まだ見ていない」の対象になる
      this.seen = true
      return
    }
    // 完了の遷移。見ていれば seen、見ていなければ unseen（= done 表示）
    this.seen = wasBusy ? visible : true
  }

  /** 検知層の状態 */
  current(): AgentState {
    return this.state
  }

  /** 表示層の状態。`(idle, seen=false) → done` */
  display(): DisplayState {
    if (this.state === 'idle' && !this.seen) return 'done'
    return this.state
  }

  /** 送信してよいか（working は通す、blocked は拒否。04_benchmark.md 3.3） */
  canSend(): boolean {
    return this.state !== 'blocked'
  }
}
