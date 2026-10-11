/**
 * Agent 起動直後の「入力欄の準備完了」待ち（04_benchmark.md 3.3）。
 * `claude` を起動した直後に送ると落ちるため、静止 1500ms・上限 8000ms で待つ。
 *
 * 準備完了のしるし（実際の出力から確認済み）:
 *   - `\x1b[?2004h`（ブラケットペースト有効化）… claude・codex の両方が出す
 *   - `\x1b[?25h`（カーソル表示）… 両方
 *   - codex の `›`
 * 時刻は注入できるようにして、実時間に依存しないテストにする。
 */
import { delay } from '@shared/delay'

type ComposerStatus =
  /** 送れる */
  | 'ready'
  /** しるしは出たが、まだ出力が動いている */
  | 'settling'
  /** しるしがまだ出ていない */
  | 'starting'
  /** 上限まで待ったが準備できなかった */
  | 'timeout'

interface ComposerOptions {
  /** 出力が止まってから準備完了とみなすまで(ms) */
  quietMs: number
  /** これを超えたら諦める(ms) */
  timeoutMs: number
  now: () => number
}

const defaultComposerOptions: ComposerOptions = {
  quietMs: 1500,
  timeoutMs: 8000,
  now: () => Date.now()
}

const PASTE_ENABLED = '\x1b[?2004h'
const CURSOR_SHOWN = '\x1b[?25h'
/** codex の入力欄 */
const CODEX_PROMPT = '›'

/**
 * PTY の出力を食べて、入力欄が準備できたかを判定する。
 * `push()` は出力が来るたびに呼び、`status()` で現在の判定を取る。
 */
export class ComposerReadiness {
  private readonly opt: ComposerOptions
  private readonly startedAt: number
  private lastDataAt: number
  private sawSignal = false

  constructor(options: Partial<ComposerOptions> = {}) {
    this.opt = { ...defaultComposerOptions, ...options }
    this.startedAt = this.opt.now()
    this.lastDataAt = this.startedAt
  }

  push(chunk: string): void {
    this.lastDataAt = this.opt.now()
    if (chunk.includes(PASTE_ENABLED) || chunk.includes(CURSOR_SHOWN) || chunk.includes(CODEX_PROMPT)) {
      this.sawSignal = true
    }
  }

  status(): ComposerStatus {
    const now = this.opt.now()
    if (!this.sawSignal) {
      return now - this.startedAt >= this.opt.timeoutMs ? 'timeout' : 'starting'
    }
    if (now - this.lastDataAt >= this.opt.quietMs) return 'ready'
    return now - this.startedAt >= this.opt.timeoutMs ? 'timeout' : 'settling'
  }

  /** しるしを見たか（UIの「準備中」表示に使う） */
  get signalled(): boolean {
    return this.sawSignal
  }
}

/**
 * 準備できるまで待つ。
 * 上限に達したら `'timeout'` を返す（呼び出し側は送らずに理由を出す）。
 */
export async function waitForComposer(
  readiness: ComposerReadiness,
  options: { sleep?: (ms: number) => Promise<void>; pollMs?: number } = {}
): Promise<ComposerStatus> {
  const sleep = options.sleep ?? delay
  const pollMs = options.pollMs ?? 100
  for (;;) {
    const status = readiness.status()
    if (status === 'ready' || status === 'timeout') return status
    await sleep(pollMs)
  }
}
