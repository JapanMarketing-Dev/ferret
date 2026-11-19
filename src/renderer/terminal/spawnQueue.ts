/**
 * ペインの PTY を作る順番（終了したあとに戻したタブなど、たくさんのペインを一度に作るとき）。
 *
 * 表示中のプロジェクトのペインはすぐ作り、裏のプロジェクトのペインは同時に SPAWN_CONCURRENCY 個まで、
 * 作り始めの間を SPAWN_GAP_MS 空けて順に作る。全部を一度に起動すると、シェルの rc と Agent の起動が重なって
 * CPU とメモリが跳ね、見ているプロジェクトのターミナルまで遅くなる。
 * 待っている間にそのプロジェクトへ切り替えたら、待たずにすぐ作る（promote）。
 * 裏のプロジェクトの、戻した素のシェル（dormant）は作らずに置いておき、そのプロジェクトを開いたときに作る。
 * Agent のペインは裏のプロジェクトでも必ず起動し直す（2026-11-19 本人「人間が閉じない限り動く形にしておいて」。
 * 前は入力待ちの Agent も開くまで止めていたため、更新・再起動のたびに裏のプロジェクトの AI が勝手に閉じたように見えた）。
 * メモリが足りなければ MemoryAlert で利用者が止める（勝手には止めない）
 */

/**
 * 戻したペインを、そのプロジェクトを開くまで作らずに置くか。置くのは素のシェルだけ。
 * Agent（launch あり）と、作業の途中だったものは置かない（人が閉じない限り動かし続ける）
 */
export function isDormantRestore(pane: { restoreText?: string | null; continueWork?: boolean; launch?: string | null }): boolean {
  return Boolean(pane.restoreText) && !pane.continueWork && !pane.launch
}

export const SPAWN_CONCURRENCY = 2
export const SPAWN_GAP_MS = 400

export interface SpawnCandidate {
  key: string
  projectId: string | null
  /** 戻した素のシェル（isDormantRestore）。裏のプロジェクトにあれば作らずに置く */
  dormant?: boolean
}

/** すぐ作るペイン、順に作るペイン、作らずに置くペインに分ける（並びは元の順のまま） */
export function partitionSpawns(candidates: readonly SpawnCandidate[], activeProject: string | null): { now: string[]; queued: string[]; deferred: string[] } {
  const active = activeProject ?? ''
  const now: string[] = []
  const queued: string[] = []
  const deferred: string[] = []
  for (const candidate of candidates) {
    if ((candidate.projectId ?? '') === active) now.push(candidate.key)
    else (candidate.dormant ? deferred : queued).push(candidate.key)
  }
  return { now, queued, deferred }
}

export interface SpawnQueueClock {
  now: () => number
  setTimeout: (fn: () => void, ms: number) => unknown
  clearTimeout: (handle: unknown) => void
}

const defaultClock: SpawnQueueClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>)
}

/** 順に作るペインの待ち行列。start は PTY を作り終える（失敗も含む）と解決する */
export class SpawnQueue {
  private readonly waiting: Array<{ key: string; start: () => Promise<void> }> = []
  private running = 0
  private lastStart = Number.NEGATIVE_INFINITY
  private timer: unknown = null

  constructor(
    private readonly concurrency = SPAWN_CONCURRENCY,
    private readonly gapMs = SPAWN_GAP_MS,
    private readonly clock: SpawnQueueClock = defaultClock
  ) {}

  has(key: string): boolean {
    return this.waiting.some((entry) => entry.key === key)
  }

  get size(): number {
    return this.waiting.length
  }

  enqueue(key: string, start: () => Promise<void>): void {
    if (this.has(key)) return
    this.waiting.push({ key, start })
    this.pump()
  }

  /** 待っているペインを、上限と間隔を待たずにすぐ作る（そのプロジェクトを表示した）。待っていなければ false */
  promote(key: string): boolean {
    const index = this.waiting.findIndex((entry) => entry.key === key)
    if (index < 0) return false
    const [entry] = this.waiting.splice(index, 1)
    void entry!.start().catch(() => undefined)
    return true
  }

  /** 作る前に閉じたペインを外す */
  remove(key: string): void {
    const index = this.waiting.findIndex((entry) => entry.key === key)
    if (index >= 0) this.waiting.splice(index, 1)
  }

  dispose(): void {
    this.waiting.length = 0
    if (this.timer !== null) this.clock.clearTimeout(this.timer)
    this.timer = null
  }

  private pump(): void {
    if (this.timer !== null) return
    while (this.waiting.length > 0 && this.running < this.concurrency) {
      const wait = this.lastStart + this.gapMs - this.clock.now()
      if (wait > 0) {
        this.timer = this.clock.setTimeout(() => {
          this.timer = null
          this.pump()
        }, wait)
        return
      }
      const entry = this.waiting.shift()!
      this.running++
      this.lastStart = this.clock.now()
      void entry.start().catch(() => undefined).finally(() => {
        this.running--
        this.pump()
      })
    }
  }
}
