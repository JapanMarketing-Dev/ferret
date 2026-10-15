import { execFile } from 'node:child_process'
import { cpus } from 'node:os'
import { performance } from 'node:perf_hooks'
import { promisify } from 'node:util'
import type { ProcRow } from './resources'
import { reportHandled } from '@shared/report'

/**
 * Windows のプロセス一覧（pid・ppid・CPU・RSS）。Windows には ps が無いので、
 * PowerShell の Get-CimInstance Win32_Process で取り、失敗したら typeperf に切り替える。
 *
 * Orca由来: ~/bench/orca/src/main/memory/windows-process-resource-collector.ts,
 *           ~/bench/orca/src/main/memory/windows-process-sample-parsing.ts（MIT）。
 * CIM の行・typeperf の CSV の読み取りと、累積CPU時間の差分からCPU%を出す処理を移植した。
 * Orca が併せて取っている commit（PageFileUsage / Private Bytes）は使わないので外した。
 * 読み取りは純粋関数、取得は実行関数と時計を外から渡せる形にして、単体テストから使う。
 */

const QUERY_TIMEOUT_MS = 5000
/*
 * PowerShell の起動は、x64 版を Windows の ARM64 でエミュレーション（Prism）して動かすと、
 * 冷えた状態から数秒〜十数秒かかる（FERRET-Y: ferret@0.2.0、ARM64 の VM の x64 版で CIM の取得が失敗した）。
 * CIM だけ時間切れを長めにする
 */
const CIM_TIMEOUT_MS = 15_000
/** CIM が続けて失敗したら、再試行の間を倍にしていき、この回数でやめる（以後は typeperf だけ） */
const CIM_MAX_FAILURES = 4
/** typeperf も続けて失敗したら、この回数で取得をやめる（Resource Manager はアプリの行だけになる） */
const TYPEPERF_MAX_FAILURES = 3
/*
 * typeperf の時間切れ。CPU が絞られている（powerMonitor の speed-limit-change が続く）・重い処理の最中は、
 * 1秒の計測でも5秒を超えることがある（FERRET-1Z: ferret@0.6.28、Windows で3回続けて時間切れ）。
 * CIM と同じく長めにし、時間切れは混んでいるだけとみなして、やめずに間を空けて試し直す（送らない）
 */
const TYPEPERF_TIMEOUT_MS = 15_000
const TYPEPERF_RETRY_AFTER_MS = 30_000
const TYPEPERF_RETRY_MAX_MS = 10 * 60_000
const QUERY_MAX_BUFFER = 10 * 1024 * 1024
const CPU_MIN_SAMPLE_MS = 250
/** 取得は ResourceCollector が 15 秒に1回までに絞るので、それより長い間（スリープ・閉じていた）だけを古いとみなす */
const CPU_STALE_AFTER_MS = 60_000
const HUNDRED_NS_TICKS_PER_MS = 10_000
const CIM_RETRY_AFTER_MS = 30_000
const CIM_RETRY_MAX_MS = 10 * 60_000
const MAX_LINE_CHARS = 1024 * 1024

const TYPEPERF_COUNTERS = [
  '\\Process(*)\\ID Process',
  '\\Process(*)\\Creating Process ID',
  '\\Process(*)\\Working Set'
] as const

const CIM_COMMAND =
  "$ErrorActionPreference = 'Stop'; $ProgressPreference = 'SilentlyContinue'; " +
  'Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,WorkingSetSize,KernelModeTime,UserModeTime,CreationDate | ' +
  'ForEach-Object { try { [string]::Join([char]9, @($_.ProcessId, $_.ParentProcessId, $_.WorkingSetSize, [string]$_.KernelModeTime, [string]$_.UserModeTime, $_.CreationDate.ToUniversalTime().Ticks)) } catch {} }'

interface WindowsCpuTimes {
  /** カーネル＋ユーザーの累積CPU時間（100ns 単位） */
  cpuTicks: bigint
  /** 起動時刻。PIDの使い回しで別プロセスの累積時間を引き継がないための印 */
  startTimeId: string
}

interface WindowsProcessSample {
  rows: ProcRow[]
  cpuByPid: Map<number, WindowsCpuTimes>
}

function parseUnsignedBigInt(value: string | undefined): bigint | null {
  if (!value || !/^\d+$/.test(value)) return null
  try {
    return BigInt(value)
  } catch {
    // 数として読めない値は捨てる（想定内）
    return null
  }
}

/** CIM の行（pid ⇥ ppid ⇥ WorkingSet ⇥ KernelTime ⇥ UserTime ⇥ 起動時刻）を読む。CPU はまだ 0 */
export function parseWindowsProcessSample(stdout: string): WindowsProcessSample {
  const rows: ProcRow[] = []
  const cpuByPid = new Map<number, WindowsCpuTimes>()
  for (const line of stdout.split(/\r?\n/)) {
    // null の項目は空のタブになる。空白で詰めると列がずれるので、タブでだけ区切る
    if (line.length > MAX_LINE_CHARS) continue
    const fields = line.split('\t', 6).map((f) => f.trim())
    if (fields.length < 3) continue
    const pid = Number.parseInt(fields[0], 10)
    const ppid = Number.parseInt(fields[1], 10)
    const memory = Number.parseInt(fields[2], 10)
    if (!Number.isSafeInteger(pid) || pid <= 0 || !Number.isSafeInteger(ppid) || ppid < 0) continue
    rows.push({ pid, ppid, cpu: 0, memory: Number.isFinite(memory) && memory > 0 ? memory : 0 })
    const kernel = parseUnsignedBigInt(fields[3])
    const user = parseUnsignedBigInt(fields[4])
    const startTimeId = fields[5] ?? ''
    if (kernel !== null && user !== null && /^\d+$/.test(startTimeId) && !/^0+$/.test(startTimeId)) {
      cpuByPid.set(pid, { cpuTicks: kernel + user, startTimeId })
    }
  }
  return { rows, cpuByPid }
}

function parseCsvLine(line: string): string[] {
  const fields: string[] = []
  let value = ''
  let quoted = false
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i]
    if (ch === '"') {
      if (quoted && line[i + 1] === '"') {
        value += '"'
        i += 1
      } else {
        quoted = !quoted
      }
    } else if (ch === ',' && !quoted) {
      fields.push(value)
      value = ''
    } else {
      value += ch
    }
  }
  fields.push(value)
  return fields
}

function parseCounterPath(path: string): { instance: string; counter: string } | null {
  const start = path.lastIndexOf('\\Process(')
  const end = path.lastIndexOf(')\\')
  if (start === -1 || end <= start + 9) return null
  return { instance: path.slice(start + 9, end), counter: path.slice(end + 2) }
}

/** typeperf の CSV（見出し行＋1回分の値）を読む。typeperf は CPU を出さないので 0 */
export function parseTypeperfProcessOutput(stdout: string): ProcRow[] {
  let headers: string[] | null = null
  let values: string[] | null = null
  for (const line of stdout.split(/\r?\n/)) {
    if (!line || line.length > MAX_LINE_CHARS) continue
    const fields = parseCsvLine(line)
    if (!headers && fields[0]?.startsWith('(PDH-CSV')) {
      headers = fields
      continue
    }
    if (headers && fields.length === headers.length) {
      values = fields
      break
    }
  }
  if (!headers || !values) return []

  const byInstance = new Map<string, { pid?: number; ppid?: number; memory?: number }>()
  for (let i = 1; i < headers.length; i += 1) {
    const path = parseCounterPath(headers[i])
    if (!path || path.instance === '_Total') continue
    const value = Number.parseFloat(values[i])
    if (!Number.isFinite(value)) continue
    const row = byInstance.get(path.instance) ?? {}
    if (path.counter === 'ID Process') row.pid = Math.trunc(value)
    else if (path.counter === 'Creating Process ID') row.ppid = Math.trunc(value)
    else if (path.counter === 'Working Set') row.memory = value
    byInstance.set(path.instance, row)
  }
  const rows: ProcRow[] = []
  for (const row of byInstance.values()) {
    if (row.pid === undefined || row.pid <= 0 || row.ppid === undefined || row.ppid < 0) continue
    rows.push({ pid: row.pid, ppid: row.ppid, cpu: 0, memory: row.memory && row.memory > 0 ? row.memory : 0 })
  }
  return rows
}

/** 実行関数（コマンドと引数を受けて標準出力を返す）。単体テストでは差し替える */
type ExecText = (file: string, args: string[], options?: { timeoutMs?: number }) => Promise<string>

const defaultExec: ExecText = async (file, args, options) => {
  const { stdout } = await promisify(execFile)(file, args, {
    timeout: options?.timeoutMs ?? QUERY_TIMEOUT_MS,
    maxBuffer: QUERY_MAX_BUFFER,
    windowsHide: true
  })
  return stdout
}

/**
 * 子プロセスの失敗を、コマンドの全文や出力を含まない種類にまとめる（Sentry の題名・まとめ方に使う）。
 * execFile の失敗の message には「Command failed: <コマンドの全文>」と stderr が入るので、そのまま送らない。
 */
export function execFailureKind(err: unknown): 'timeout' | 'not-found' | 'output-too-large' | 'killed' | 'exit' | 'empty' | 'other' {
  const e = (err ?? {}) as { code?: unknown; killed?: unknown; signal?: unknown }
  if (e.code === 'ENOENT') return 'not-found'
  if (e.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return 'output-too-large'
  // execFile の timeout で止めたときは killed が true になり、signal は SIGTERM
  if (e.killed === true) return e.signal === 'SIGTERM' ? 'timeout' : 'killed'
  if (typeof e.code === 'number') return 'exit'
  if (e.code === 'EMPTY') return 'empty'
  return 'other'
}

/** 取得の失敗を Sentry へ送る形。題名は種類だけ（コマンドも出力も入れない） */
class ResourceProbeError extends Error {
  constructor(readonly backend: 'powershell' | 'typeperf', readonly kind: ReturnType<typeof execFailureKind>) {
    super(`${backend} process sampling failed: ${kind}`)
    this.name = 'ResourceProbeError'
  }
}

/** 1回の起動で、同じ取得方法・同じ種類の失敗は1度だけ送る（環境による失敗が、監視のたびに積み上がらないように） */
const reportedFailures = new Set<string>()

function reportProbeFailure(error: ResourceProbeError): void {
  const key = `${error.backend}:${error.kind}`
  if (reportedFailures.has(key)) return
  reportedFailures.add(key)
  reportHandled(error, { area: 'resources', op: `sample processes with ${error.backend}` })
}

/** 単体テスト用：送った記録を消す */
export function resetReportedProbeFailuresForTest(): void {
  reportedFailures.clear()
}

/**
 * Windows のプロセス一覧を取る係。CPU% は前回との累積CPU時間の差から出すので、前回の値を持つ。
 * CIM が失敗したら typeperf（メモリだけ）に切り替え、30秒後にまた CIM を試す。続けて失敗するたびに間を倍にし
 * （最長10分）、CIM_MAX_FAILURES 回でやめる。typeperf も TYPEPERF_MAX_FAILURES 回続けて失敗したら取得をやめる（時間切れは数えず、間を空けて試し直す）。
 * 失敗は種類だけを、その取得方法をやめるとき（続けて失敗したとき）に、1回の起動で1度だけ送る（reportProbeFailure）。
 */
export class WindowsProcessCollector {
  private backend: 'cim' | 'typeperf' = 'cim'
  private previous: (WindowsProcessSample & { sampledAtMs: number }) | null = null
  private retryCimAtMs = 0
  private cimFailures = 0
  private typeperfFailures = 0
  /** typeperf が続けて時間切れになった回数と、次に試す時刻（時間切れは止めずに間を空ける） */
  private typeperfTimeouts = 0
  private retryTypeperfAtMs = 0
  /** 直前の CIM の失敗の種類（やめるときに送る） */
  private lastCimFailure: ReturnType<typeof execFailureKind> = 'other'

  constructor(
    private readonly exec: ExecText = defaultExec,
    private readonly now: () => number = () => performance.now(),
    private readonly cpuCount: number = Math.max(1, cpus().length)
  ) {}

  async enumerate(): Promise<ProcRow[]> {
    if (this.backend === 'typeperf') {
      // CIM をやめた後、または再試行の時刻の前は typeperf だけ
      if (this.cimFailures >= CIM_MAX_FAILURES || this.now() < this.retryCimAtMs) return this.viaTypeperf()
      this.backend = 'cim'
    }
    const sample = await this.viaCim()
    if (sample) {
      this.cimFailures = 0
      return this.applyCpu(sample)
    }
    // CIM が詰まっているときに、毎回の取得でタイムアウトを待たない。続けて失敗するほど間を空ける
    this.cimFailures += 1
    // 1回きりの失敗（スリープに入る・明けた直後、重い起動の最中。FERRET-1P は休止に入る瞬間だった）は送らず、やめるときに1度だけ送る
    if (this.cimFailures === CIM_MAX_FAILURES) reportProbeFailure(new ResourceProbeError('powershell', this.lastCimFailure))
    this.backend = 'typeperf'
    this.retryCimAtMs = this.now() + Math.min(CIM_RETRY_MAX_MS, CIM_RETRY_AFTER_MS * 2 ** (this.cimFailures - 1))
    this.previous = null
    return this.viaTypeperf()
  }

  /** 取得をすべてやめたか（CIM も typeperf も続けて失敗した） */
  get stopped(): boolean {
    return this.cimFailures >= CIM_MAX_FAILURES && this.typeperfFailures >= TYPEPERF_MAX_FAILURES
  }

  private async viaCim(): Promise<(WindowsProcessSample & { sampledAtMs: number }) | null> {
    try {
      const stdout = await this.exec('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', CIM_COMMAND], { timeoutMs: CIM_TIMEOUT_MS })
      const parsed = parseWindowsProcessSample(stdout)
      if (parsed.rows.length > 0) return { ...parsed, sampledAtMs: this.now() }
      this.lastCimFailure = 'empty'
      return null
    } catch (err) {
      const kind = execFailureKind(err)
      // コマンドの全文と出力はログにも出さない（種類だけ）
      console.warn(`[resources] PowerShell でプロセスを取れませんでした（${kind}）。typeperf に切り替えます`)
      this.lastCimFailure = kind
      return null
    }
  }

  private async viaTypeperf(): Promise<ProcRow[]> {
    if (this.typeperfFailures >= TYPEPERF_MAX_FAILURES) return []
    if (this.now() < this.retryTypeperfAtMs) return []
    try {
      const rows = parseTypeperfProcessOutput(await this.exec('typeperf.exe', [...TYPEPERF_COUNTERS, '-sc', '1', '-si', '0'], { timeoutMs: TYPEPERF_TIMEOUT_MS }))
      this.typeperfFailures = 0
      this.typeperfTimeouts = 0
      return rows
    } catch (err) {
      const kind = execFailureKind(err)
      console.warn(`[resources] typeperf でプロセスを取れませんでした（${kind}）`)
      if (kind === 'timeout') {
        // 混んでいるだけ（FERRET-1Z）。やめず・送らず、続くほど間を空けて試し直す
        this.typeperfTimeouts += 1
        this.retryTypeperfAtMs = this.now() + Math.min(TYPEPERF_RETRY_MAX_MS, TYPEPERF_RETRY_AFTER_MS * 2 ** (this.typeperfTimeouts - 1))
        return []
      }
      this.typeperfFailures += 1
      if (this.typeperfFailures === TYPEPERF_MAX_FAILURES) reportProbeFailure(new ResourceProbeError('typeperf', kind))
      return []
    }
  }

  private applyCpu(sample: WindowsProcessSample & { sampledAtMs: number }): ProcRow[] {
    const previous = this.previous
    if (!previous) {
      this.previous = sample
      return sample.rows
    }
    const elapsedMs = sample.sampledAtMs - previous.sampledAtMs
    // 間隔が短すぎると率がぶれるので、前回の基準を残して次の取得で測る
    if (elapsedMs < CPU_MIN_SAMPLE_MS) return sample.rows
    this.previous = sample
    // 閉じていた・スリープしていたなど間が空いた基準は、今のCPUを表さない
    if (elapsedMs > CPU_STALE_AFTER_MS) return sample.rows
    const maxCpu = this.cpuCount * 100
    for (const row of sample.rows) {
      const cur = sample.cpuByPid.get(row.pid)
      const prev = previous.cpuByPid.get(row.pid)
      if (!cur || !prev || cur.startTimeId !== prev.startTimeId || cur.cpuTicks < prev.cpuTicks) continue
      const cpuMs = Number(cur.cpuTicks - prev.cpuTicks) / HUNDRED_NS_TICKS_PER_MS
      row.cpu = Math.min(maxCpu, Math.max(0, (cpuMs / elapsedMs) * 100))
    }
    return sample.rows
  }
}
