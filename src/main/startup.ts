/**
 * 起動時間の計測（NF-5: 起動から操作可能まで2秒以内）。
 *
 * 基準はプロセス生成時刻。Electron の `process.getCreationTime()` は
 * 3つのOSで利用できるが、取得できない場合はモジュール読み込み時刻へ退避する。
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { uptime as osUptime } from 'node:os'
import { dirname } from 'node:path'
import { reportPerf } from '@shared/report'
import { SLOW_STARTUP_MS } from '@shared/telemetry'
import { slowStartupReport, startupBreakdown } from '@shared/startupBreakdown'

const moduleLoadedAt = Date.now()

/** OS を起動してからの ms。取れなければ null */
function systemUptime(): number | null {
  try {
    const seconds = osUptime()
    return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : null
  } catch {
    return null
  }
}

function processCreationTime(): number | null {
  try {
    const creation = (process as NodeJS.Process & { getCreationTime?: () => number | null })
      .getCreationTime?.()
    return typeof creation === 'number' && creation > 0 ? creation : null
  } catch {
    return null
  }
}

const creationTime = processCreationTime()
const origin = creationTime ?? moduleLoadedAt
const marks: Record<string, number> = {}

/** 節目を記録する。値はプロセス生成からの経過ミリ秒 */
export function mark(name: string): number {
  const elapsed = Math.round(Date.now() - origin)
  marks[name] = elapsed
  return elapsed
}

/** まだ無い節目だけ記録する（何度も通る場所の「最初の1回」） */
export function markOnce(name: string): void {
  if (!(name in marks)) mark(name)
}

/**
 * 別のプロセス（画面）で起きた時刻（epoch ms）を節目にする。画面が描いた時刻と、main がそれを受けた時刻（interactive）の差が
 * main の順番待ちになる（FERRET-K: 画面の最初のデータから操作可能までの 3〜4 秒がどちらかを分ける）。
 * 基準より前・今より後・数でない値は捨てる
 */
export function markAt(name: string, epochMs: unknown, now: number = Date.now()): void {
  if (typeof epochMs !== 'number' || !Number.isFinite(epochMs) || epochMs < origin || epochMs > now) return
  marks[name] = Math.round(epochMs - origin)
}

function marksSnapshot(): Record<string, number> {
  return { ...marks }
}

export function elapsedMs(): number {
  return Math.round(Date.now() - origin)
}

let reported = false

/** 性能の報告に付けるタグ（エミュレーションで動いているかなど）。main が起動の早いうちに渡す */
let startupTags: Record<string, string> = {}

export function setStartupTags(tags: Record<string, string>): void {
  startupTags = { ...tags }
}

/** この起動がその版の初めての起動か（入れた・更新した直後）。noteLaunchedVersion が決める */
let firstLaunchOfVersion = false

/**
 * 前回起動した版をファイル（userData/last-launch-version）と比べて覚え直す。違えば（初めて・更新した直後）true。
 * 読み書きできなければ false（遅い起動を今までどおり数える）
 */
export function noteLaunchedVersion(file: string, version: string): boolean {
  let previous = ''
  try {
    previous = readFileSync(file, 'utf8').trim()
  } catch {
    // 初めての起動（想定内）
  }
  firstLaunchOfVersion = previous !== version
  if (firstLaunchOfVersion) {
    try {
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, version)
    } catch {
      // 書けなければ次の起動もまた初回として扱われるだけ（想定内）
    }
  }
  return firstLaunchOfVersion
}

/**
 * renderer から「操作可能になった」通知を受けた時点で1度だけログへ出す。
 * 目標未達のときは警告にして、原因の切り分けに内訳を併記する。
 */
export function reportInteractive(): { totalMs: number; marks: Record<string, number> } {
  const totalMs = mark('interactive')
  if (!reported) {
    reported = true
    const breakdown = Object.entries(marksSnapshot())
      .sort((a, b) => a[1] - b[1])
      .map(([name, ms]) => `${name}=${ms}ms`)
      .join(' ')
    const line = `[startup] 操作可能まで ${totalMs}ms (目標 2000ms) | ${breakdown}`
    if (totalMs > 2000) console.warn(`${line} ← 目標未達`)
    else console.log(line)
    // 目標を大きく超えたら Sentry へ warning を1件（1回の起動で1度だけ。内訳の名前と時間だけを付ける）。
    // JS より後の遅れだけを slow-startup として数え、JS より前（Gatekeeper の検査・dyld など）で超えたものは slow-pre-js に分ける
    const timing = startupBreakdown({ totalMs, origin, moduleLoadedAt, originSource: creationTime === null ? 'module' : 'process', marks: marksSnapshot() })
    // OS を起動した直後（ログイン項目と取り合う）は Ferret の外の遅れ（FERRET-K）。分からなければ数える
    const systemUptimeMs = systemUptime()
    const slow = slowStartupReport(timing, SLOW_STARTUP_MS, { firstLaunchOfVersion, systemUptimeMs })
    if (slow) reportPerf(slow.perf, slow.ms, { tags: { ...startupTags, ...timing.tags }, context: { ...timing.context, app: timing.appMs === null ? 'unknown' : `${timing.appMs}ms`, first_launch_of_version: String(firstLaunchOfVersion), system_uptime: systemUptimeMs === null ? 'unknown' : `${Math.round(systemUptimeMs / 60_000)}min` } })
  }
  return { totalMs, marks: marksSnapshot() }
}
