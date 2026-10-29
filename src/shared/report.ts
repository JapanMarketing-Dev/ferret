import { isUserFacingError } from './errors'
import { perfAnomalyEvent, type PerfAnomaly } from './telemetry'

/**
 * 黙って失敗している箇所（catch して既定値で続ける・console.warn だけ）を Sentry へ知らせる入口。
 *
 * main と renderer の両方から呼ぶ。ここは Sentry に依存させず、各プロセスの telemetry
 * （src/main/telemetry.ts、src/renderer/lib/telemetry.ts）が初期化したときに送り先を差し込む。
 * 差し込まれていない起動（設定 OFF・E2E・単体テスト）では何もしない。
 *
 * 送る中身は例外と、どこで（area）・何をしていて（op）だけ。パスや URL は beforeSend の scrub が落とす。
 * 利用者に見せるための想定内のエラー（UserFacingError）は送らない。
 */

/** どの機能の失敗か。Sentry のタグ area になる */
export type ReportArea =
  | 'terminal' | 'pty' | 'agent-launch' | 'agent-mail' | 'recording' | 'stt' | 'organize' | 'review' | 'files' | 'editor'
  | 'browser' | 'github' | 'usage' | 'accounts' | 'update' | 'settings' | 'layout' | 'resources' | 'sessions'
  | 'preview' | 'startup' | 'ui' | 'onboarding' | 'mobile-remote' | 'video'

interface ReportWhere {
  area: ReportArea
  /** 何をしていたか（短い英語の動詞句。例: 'read settings'）。可変の値（パス・URL）は入れない */
  op: string
}

export interface Reporter {
  handled(err: unknown, tags: Record<string, string>, level: 'warning' | 'error'): void
  message(message: string, tags: Record<string, string>, level: 'warning' | 'error', fingerprint?: string[], contexts?: Record<string, Record<string, string>>): void
  breadcrumb(message: string, data?: Record<string, string | number>): void
}

let reporter: Reporter | null = null
/** 同じ例外を2度送らない（catch で送ったあと、上で投げ直されて IPC でも拾われるなど） */
let seen = new WeakSet<object>()

/**
 * renderer に届いた IPC の失敗（`Error invoking remote method '…'`）。main の wrapIpcHandler が送り済みなので、
 * renderer の catch からは送らない（二重に数えない）
 */
export function isIpcRelay(err: unknown): boolean {
  return err instanceof Error && err.message.startsWith('Error invoking remote method ')
}

/** telemetry が初期化したときだけ呼ぶ。null で外す（テスト用） */
export function setReporter(next: Reporter | null): void {
  reporter = next
  seen = new WeakSet()
}

/**
 * 中断・時間切れ（AbortController・AbortSignal.timeout）。自分で止めた・相手が遅かっただけで、Ferret の不具合ではない。
 * errorKind を通したもの（name だけを持つ Error）も同じ名前で見分ける
 */
export function isAbortError(err: unknown): boolean {
  const name = (err as { name?: unknown } | null)?.name
  return name === 'AbortError' || name === 'TimeoutError'
}

/**
 * catch して続ける箇所の失敗を送る。想定外の失敗だけに使う（想定内なら理由のコメントを付けて送らない）。
 * 中断・時間切れは送らない（Sentry FERRET-23: 本文の読み込み中の時間切れを「応答の形の変化」として送っていた）
 */
export function reportHandled(err: unknown, where: ReportWhere, level: 'warning' | 'error' = 'warning'): void {
  if (!reporter || isUserFacingError(err) || isIpcRelay(err) || isAbortError(err)) return
  if (err && typeof err === 'object') {
    if (seen.has(err)) return
    seen.add(err)
  }
  reporter.handled(err, { kind: 'handled', area: where.area, op: where.op }, level)
}

/** 例外ではない異常（性能・異常終了など）を送る */
export function reportAnomaly(message: string, tags: Record<string, string>, level: 'warning' | 'error' = 'warning'): void {
  // 種類（文）ごとにまとめる。スタックは付けない
  reporter?.message(message, tags, level, ['anomaly', message])
}

/** 性能の異常（起動が遅い・main の停止）。題名は「Slow startup (7.4s)」、まとめ方は種類ごと（src/shared/telemetry.ts） */
export function reportPerf(perf: PerfAnomaly, ms: number, extra?: { tags: Record<string, string>; context: Record<string, string> }): void {
  const e = perfAnomalyEvent(perf, ms)
  // 内訳は contexts.block（main の停止）か contexts.startup（起動の遅さ）に入れる
  const key = perf === 'event-loop-block' ? 'block' : 'startup'
  reporter?.message(e.message, { ...e.tags, ...extra?.tags }, e.level, e.fingerprint, extra ? { [key]: extra.context } : undefined)
}

/**
 * 主要な流れの区切り（パンくず）。失敗した直前の操作が分かるように置く。
 * 入れるのは操作名と種類（agent 名・exit code など）だけ。パス・URL・文は入れない。
 */
export function flow(op: string, data?: Record<string, string | number>): void {
  reporter?.breadcrumb(op, data)
}

/**
 * 例外の種類（name と code）だけを持つ例外にする。
 * メッセージに設定ファイルの中身（MCP の鍵など）が入りうる箇所で、reportHandled に渡す前に使う。
 */
export function errorKind(err: unknown): Error {
  const name = err instanceof Error ? err.name : typeof err
  const code = (err as { code?: unknown } | null)?.code
  const out = new Error(typeof code === 'string' ? `${name} ${code}` : name)
  out.name = name
  return out
}

/** これより長い同期の処理・IPC を「重い処理」として控える（main の停止の手がかり） */
export const SLOW_OP_MS = 100
const SLOW_OP_KEEP = 8
const slowOps: Array<{ op: string; ms: number; at: number }> = []

/** 重かった処理を控え、パンくずにも残す（操作名と時間だけ） */
export function noteSlowOp(op: string, ms: number, now: number = Date.now()): void {
  if (ms < SLOW_OP_MS) return
  slowOps.push({ op, ms: Math.round(ms), at: now })
  if (slowOps.length > SLOW_OP_KEEP) slowOps.shift()
  reporter?.breadcrumb('slow op', { op, ms: Math.round(ms) })
}

/** 同期の処理を時間を測って動かす（重ければ noteSlowOp） */
export function timedSync<T>(op: string, fn: () => T): T {
  const start = Date.now()
  try {
    return fn()
  } finally {
    noteSlowOp(op, Date.now() - start)
  }
}

/** 直近（既定10秒）に終わった重い処理。長い順 */
export function recentSlowOps(now: number = Date.now(), windowMs = 10_000): Array<{ op: string; ms: number }> {
  return slowOps.filter((x) => now - x.at <= windowMs).map(({ op, ms }) => ({ op, ms })).sort((a, b) => b.ms - a.ms)
}

/** テスト用 */
export function clearSlowOps(): void {
  slowOps.length = 0
}
