/**
 * 起動の遅さの内訳（FERRET-K）。遅れが JS より前（プロセスの生成からモジュールの読み込みまで：
 * ダウンロード直後の初回起動での Gatekeeper の検査・dyld・Electron 本体の読み込み）か、後（アプリの JS）かを分ける。
 * 中身は節目の名前と時間だけ（パス・URL・文は入れない）。
 */

/** JS より前の時間が全体のこの割合を超えたら pre-js とみなす */
const PRE_JS_SHARE = 0.5
/**
 * OS を起動してからこれより短いうちの起動は、ログイン項目などと取り合って全体が遅いので、Ferret の外の遅れとみなす
 * （更新直後の初回と同じ扱い。FERRET-K）
 */
export const BOOT_SETTLE_MS = 5 * 60_000
/** 内訳に載せる節目の数の上限 */
export const MAX_STARTUP_MARKS = 20

const MARK_NAME = /^[A-Za-z0-9_.:-]{1,40}$/

type StartupPhase = 'pre-js' | 'js' | 'unknown'

export interface StartupTiming {
  /** プロセスの生成（取れなければモジュールの読み込み）から操作可能までの ms */
  totalMs: number
  /** 基準の時刻（epoch ms） */
  origin: number
  /** src/main/startup.ts が読み込まれた時刻（epoch ms） */
  moduleLoadedAt: number
  /** 基準がプロセスの生成時刻か（process.getCreationTime() が取れたか） */
  originSource: 'process' | 'module'
  /** 節目の名前と、基準からの ms */
  marks: Record<string, number>
}

interface StartupBreakdown {
  /** プロセスの生成からモジュールの読み込みまで。生成時刻が取れないときは分からない（null） */
  preJsMs: number | null
  /** モジュールの読み込みから操作可能まで */
  jsMs: number
  /** Electron の準備ができて（app:ready）から操作可能まで＝アプリ自身の処理。節目が無ければ分からない（null） */
  appMs: number | null
  /**
   * 画面の JS の読み込み（窓に画面を付けて：browser:attached → 画面の最初の呼び出し：renderer:firstIpc）。
   * 冷えた app.asar から大きな bundle を読む区間で、更新直後は OS の検査が入る。節目が無ければ null
   */
  rendererLoadMs: number | null
  phase: StartupPhase
  tags: Record<string, string>
  context: Record<string, string>
}

export function startupBreakdown(t: StartupTiming): StartupBreakdown {
  const totalMs = Math.max(0, Math.round(t.totalMs))
  const preJsMs = t.originSource === 'process' ? Math.min(totalMs, Math.max(0, Math.round(t.moduleLoadedAt - t.origin))) : null
  const jsMs = totalMs - (preJsMs ?? 0)
  const readyAt = t.marks['app:ready']
  const appMs = typeof readyAt === 'number' && Number.isFinite(readyAt) ? Math.min(totalMs, Math.max(0, totalMs - Math.round(readyAt))) : null
  const attachedAt = t.marks['browser:attached']
  const firstIpcAt = t.marks['renderer:firstIpc']
  const rendererLoadMs = Number.isFinite(attachedAt) && Number.isFinite(firstIpcAt) ? Math.max(0, Math.round(firstIpcAt - attachedAt)) : null
  const phase: StartupPhase = preJsMs === null ? 'unknown' : preJsMs > totalMs * PRE_JS_SHARE ? 'pre-js' : 'js'
  const marks = Object.entries(t.marks)
    .filter(([name, ms]) => MARK_NAME.test(name) && Number.isFinite(ms))
    .sort((a, b) => a[1] - b[1])
    .slice(0, MAX_STARTUP_MARKS)
    .map(([name, ms]) => `${name}=${Math.round(ms)}ms`)
    .join(' ')
  return {
    preJsMs,
    jsMs,
    appMs,
    rendererLoadMs,
    phase,
    tags: { 'startup.phase': phase, 'startup.origin': t.originSource },
    context: {
      total: `${totalMs}ms`,
      pre_js: preJsMs === null ? 'unknown' : `${preJsMs}ms`,
      js: `${jsMs}ms`,
      marks: marks || 'none'
    }
  }
}

/**
 * どの名前で報告するか。JS より後の遅れが閾値を超えたら slow-startup、JS より前の遅れだけで閾値を超えたら slow-pre-js。
 * どちらも、その部分だけで閾値を超えたときに数える（足すと超えるだけの、前も後も目標内の起動は数えない。
 * FERRET-1C: Windows で JS より前 3.6 秒＋後 1.9 秒の 5.5 秒）。
 *
 * その版の初めての起動（入れた・更新した直後。OS が新しい実行ファイルを検査し、app.asar も冷えた状態から読む）と、
 * OS を起動した直後（ログイン項目と取り合う）は、Electron の準備ができる（app:ready）までの遅れを数えず、
 * アプリ自身の処理（app:ready から操作可能まで）だけで判断する。
 * FERRET-K（0.6.22 の macOS）: JS より前 11 秒・モジュールの読み込みから app:ready まで 7 秒、アプリ自身は 1.3 秒だった。
 * 画面の JS の読み込み（rendererLoadMs）も、初回は冷えた app.asar を OS が検査しながら読む Ferret の外の遅れなので数えない
 * （FERRET-K の 0.7.8 の Windows：いつもは 1.4 秒の区間が 8.3 秒、アプリ自身は残りの 4.2 秒だった）
 */
export function slowStartupReport(
  b: StartupBreakdown,
  thresholdMs: number,
  options: { firstLaunchOfVersion?: boolean; systemUptimeMs?: number | null } = {}
): { perf: 'slow-startup' | 'slow-pre-js'; ms: number } | null {
  const uptime = options.systemUptimeMs
  const justBooted = typeof uptime === 'number' && Number.isFinite(uptime) && uptime >= 0 && uptime < BOOT_SETTLE_MS
  if (options.firstLaunchOfVersion || justBooted) {
    // Ferret では直せない遅れ。アプリ自身の処理だけを見る（節目が無ければ JS より後の全体で）
    const own = Math.max(0, (b.appMs ?? b.jsMs) - (b.rendererLoadMs ?? 0))
    return own > thresholdMs ? { perf: 'slow-startup', ms: own } : null
  }
  if (b.jsMs > thresholdMs) return { perf: 'slow-startup', ms: b.jsMs }
  if (b.preJsMs !== null && b.preJsMs > thresholdMs) return { perf: 'slow-pre-js', ms: b.preJsMs }
  return null
}
