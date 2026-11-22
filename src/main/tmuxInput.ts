/**
 * SSH のタブ（リモートの tmux の中。セッションだけマウスを有効にしている。src/shared/sshCommand.ts）への入力の扱い。
 * xterm.js は tmux の求めに応じて、ホイール・クリック・ドラッグをマウスの報告にして送る。
 * tmux は SGR（ESC [ < b ; x ; y M か m）を求めるが、念のため X10（ESC [ M のあと b・x・y に 32 を足した 3 文字）も見る。
 */

const ESC = '\x1b'
/** マウスの報告（SGR と X10）。b は SGR なら 1 番目、X10 なら 2 番目の組 */
const MOUSE_REPORT = /\x1b\[<\d+;\d+;\d+[Mm]|\x1b\[M[\s\S]{3}/
const MOUSE_REPORTS = /\x1b\[<(\d+);\d+;\d+[Mm]|\x1b\[M([\s\S])[\s\S]{2}/g
/**
 * 入力を分ける区切り: マウスの報告と、xterm.js が自分から送るもの（フォーカスの出入り・OSC / DCS の答え・
 * 端末の種類の答え・カーソルの位置の答え）。どちらも利用者が打ったものではない
 */
const SEGMENTS = /\x1b\[<\d+;\d+;\d+[Mm]|\x1b\[M[\s\S]{3}|\x1b\[[IO]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1bP[^\x1b]*\x1b\\|\x1b\[[?>][\d;]*c|\x1b\[\d+;\d+R/g

/** マウスの報告の b（下 2 ビットがボタン 0 左・1 中・2 右、4・8・16 が修飾キー、32 が押したままの移動、64 がホイール、128 が 8 番以降のボタン） */
function buttonOf(sgr: string | undefined, x10: string | undefined): number {
  return sgr !== undefined ? Number(sgr) : (x10?.charCodeAt(0) ?? 32) - 32
}

/** マウスの報告を含むか（ホイール・クリック・ドラッグ） */
export function hasMouseReport(data: string): boolean {
  return data.includes(ESC) && MOUSE_REPORT.test(data)
}

/**
 * 右ボタンの報告（押す・離す・押したままの移動。修飾キー付きも）を落とす。ホイール（64〜）と 8 番以降のボタン（128〜）は残す。
 * tmux は右クリックで自分のメニューを開き、押したまま動かして離した位置の項目（Kill・Respawn・Split など）を実行する。
 * Ferret の右クリックのメニューの下に隠れた tmux のメニューで、Agent のペインが終わりかねないので渡さない
 * （右クリックはこれまで通り Ferret のメニューだけ）
 */
export function dropRightButtonReports(data: string): string {
  if (!data.includes(ESC)) return data
  return data.replace(MOUSE_REPORTS, (report, sgr: string | undefined, x10: string | undefined) => ((buttonOf(sgr, x10) & 0xc3) === 2 ? '' : report))
}

/**
 * 入力の1かたまり。
 *   wheel-up: 上向きのホイール（tmux はこれでコピーモードに入る）、mouse: ほかのマウスの報告、
 *   report: xterm.js が自分から送るもの、input: 利用者が打ったもの（キー・貼り付け）
 */
export type TmuxInputKind = 'wheel-up' | 'mouse' | 'report' | 'input'
export interface TmuxInputSegment { kind: TmuxInputKind; data: string }

/** 修飾キー（4・8・16）を除いて 64 なら上向きのホイール */
function isWheelUp(button: number): boolean {
  return (button & ~0x1c) === 64
}

function kindOf(segment: string): TmuxInputKind {
  const sgr = /^\x1b\[<(\d+);\d+;\d+([Mm])$/.exec(segment)
  if (sgr) return sgr[2] === 'M' && isWheelUp(Number(sgr[1])) ? 'wheel-up' : 'mouse'
  if (segment.startsWith('\x1b[M') && segment.length === 6) return isWheelUp(segment.charCodeAt(3) - 32) ? 'wheel-up' : 'mouse'
  return 'report'
}

/** 届いた入力を、順番どおりにかたまりに分ける（renderer は打鍵とマウスの報告をまとめて1回で送ることがある） */
export function splitTmuxInput(data: string): TmuxInputSegment[] {
  if (!data.includes(ESC)) return data ? [{ kind: 'input', data }] : []
  const out: TmuxInputSegment[] = []
  let last = 0
  for (const match of data.matchAll(SEGMENTS)) {
    const at = match.index ?? 0
    if (at > last) out.push({ kind: 'input', data: data.slice(last, at) })
    out.push({ kind: kindOf(match[0]), data: match[0] })
    last = at + match[0].length
  }
  if (last < data.length) out.push({ kind: 'input', data: data.slice(last) })
  return out
}

export interface TmuxInputGateOptions {
  /** tmux へ書く（mouse: マウスの報告か） */
  write: (data: string, mouse: boolean) => void
  /** tmux のコピーモードを抜ける。true / false は確かめられた（抜けた・入っていなかった）、null は分からない（失敗・遅い） */
  leave: () => Promise<boolean | null>
  /** 抜けるのを待つ上限。過ぎたら貯めた入力をそのまま流す */
  holdMs: number
  /** 続けてこの回数だけ抜けられなかったら（ssh が使えないホストなど）、pauseMs の間は貯めない（打鍵を遅らせ続けない） */
  failLimit?: number
  pauseMs?: number
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (timer: unknown) => void
  now?: () => number
}

/**
 * SSH のタブ（tmux の中）への利用者の入力の関所。ホイールで上へ戻すと tmux はコピーモードに入り、そのまま打った文字・貼り付け・
 * Enter はコピーモードが受け取る（Agent に届かない。vi 系のキーでは y や Enter でクリップボードも書き換わる）。手元のタブと同じく
 * 「上を読んでからそのまま打てば Agent に届く」ように、ホイールのあとの最初の入力の前に一度だけコピーモードを抜ける。
 *   - きっかけは上向きのホイールの報告を書いたことだけ（キーボードで入ったコピーモード＝prefix [ はそのまま使える）
 *   - 抜けるまでの入力は順番どおりに貯め、抜け終わるか上限（holdMs）で必ず流す。抜けられなくても捨てない・二重に送らない
 *   - 貯めている間に来たマウスの報告も、順番どおりに後ろに積む（流すときに、そのホイールのあとの入力はまた抜けてから）
 *   - 抜けるのは1回のホイールにつき1回（打ち続けても ssh を重ねない）。抜けたら（成功でも失敗でも）元に戻す
 *   - 続けて抜けられない（ssh が使えないホストなど）ときは、しばらくホイールのあとも待たせない（failLimit・pauseMs）
 */
export class TmuxInputGate {
  private waitingForInput = false
  private held: TmuxInputSegment[] | null = null
  private round = 0
  private timer: unknown = null
  private failures = 0
  private pausedUntil = 0
  private idleWaiters: Array<() => void> = []

  constructor(private readonly options: TmuxInputGateOptions) {}

  /** 利用者の入力（xterm.js から届いた順） */
  push(data: string): void {
    for (const segment of splitTmuxInput(data)) this.accept(segment)
  }

  /** 抜けるのを待って入力を貯めているか */
  get holding(): boolean {
    return this.held !== null
  }

  /** ホイールのあとで、次の入力の前に抜けるつもりか */
  get armed(): boolean {
    return this.waitingForInput
  }

  /** 貯めた入力を流し終えるまで待つ（貯めていなければすぐ） */
  idle(): Promise<void> {
    if (!this.held) return Promise.resolve()
    return new Promise((resolve) => this.idleWaiters.push(resolve))
  }

  private now(): number {
    return (this.options.now ?? Date.now)()
  }

  private accept(segment: TmuxInputSegment): void {
    if (this.held) {
      this.held.push(segment)
      return
    }
    if (segment.kind === 'wheel-up' || segment.kind === 'mouse') {
      const data = dropRightButtonReports(segment.data)
      if (!data) return
      this.options.write(data, true)
      if (segment.kind === 'wheel-up' && this.now() >= this.pausedUntil) this.waitingForInput = true
      return
    }
    if (segment.kind === 'input' && this.waitingForInput) {
      this.hold(segment)
      return
    }
    this.options.write(segment.data, false)
  }

  private hold(first: TmuxInputSegment): void {
    this.waitingForInput = false
    const round = ++this.round
    this.held = [first]
    this.timer = (this.options.setTimer ?? setTimeout)(() => this.release(round), this.options.holdMs)
    void Promise.resolve()
      .then(() => this.options.leave())
      .then((result) => this.note(result), () => this.note(null))
      .finally(() => this.release(round))
  }

  private note(result: boolean | null): void {
    if (result !== null) {
      this.failures = 0
      return
    }
    this.failures += 1
    if (this.failures >= (this.options.failLimit ?? 3)) {
      this.failures = 0
      this.pausedUntil = this.now() + (this.options.pauseMs ?? 60_000)
    }
  }

  /** 貯めた入力を順番どおりに流す（抜け終わったときと上限のときの、先に来た方の1回だけ） */
  private release(round: number): void {
    if (round !== this.round || !this.held) return
    ;(this.options.clearTimer ?? ((timer: unknown) => clearTimeout(timer as ReturnType<typeof setTimeout>)))(this.timer)
    const items = this.held
    this.held = null
    for (const item of items) {
      try {
        this.accept(item)
      } catch {
        /* タブが終わった（書けない）。残りも書けない */
      }
    }
    // 流している途中のホイールでまた貯め始めたら、それを流し終えるまで待たせる
    if (!this.held) for (const resolve of this.idleWaiters.splice(0)) resolve()
  }
}
