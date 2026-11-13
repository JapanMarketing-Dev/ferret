import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { freemem, totalmem } from 'node:os'
import { promisify } from 'node:util'
import {
  INITIAL_MEMORY_ALERT,
  MEMORY_CHECK_MS,
  dismissMemoryAlert,
  stepMemoryAlert,
  type MemoryAlertNotice,
  type MemoryAlertState,
  type MemoryPressure,
  type MemorySample
} from '@shared/memoryAlert'
import type { ResourceSnapshot } from '@shared/resources'

/**
 * メモリの見張り（勝手には止めない。足りなくなったら知らせて、どれを止めるかは利用者が選ぶ）。
 *
 * MEMORY_CHECK_MS（60 秒）に1回だけ見る。
 * - PC の空き: macOS は sysctl 1回（kern.memorystatus_level = OS の言う空きの割合、kern.memorystatus_vm_pressure_level = 逼迫）。
 *   os.freemem は macOS では「まったく使われていないページ」だけで、キャッシュに回った分を数えず常に小さく出るので使わない。
 *   Linux は /proc/meminfo の MemAvailable（ファイルを読むだけ）、Windows は os.freemem（使える物理メモリ）
 * - Ferret 全体: Resource Manager の集計（resources.ts）を使う。フッターが 60 秒ごとに取っている値が新しければそれを使い、
 *   ps を重ねて起動しない
 * 出す・消すの決まりは @shared/memoryAlert（単体テストあり）。
 */

const execFileAsync = promisify(execFile)

/** sysctl の出力（kern.memorystatus_level と kern.memorystatus_vm_pressure_level の2行）を読む。単体テストから使う */
export function parseDarwinSysctl(stdout: string): { availableRatio: number | null; pressure: MemoryPressure | null } {
  const [levelLine, pressureLine] = stdout.trim().split(/\r?\n/)
  const level = Number.parseInt(levelLine ?? '', 10)
  const code = Number.parseInt(pressureLine ?? '', 10)
  return {
    availableRatio: Number.isFinite(level) && level >= 0 && level <= 100 ? level / 100 : null,
    // 1 = normal, 2 = warn, 4 = critical（xnu の kVMPressure*）
    pressure: code === 4 ? 'critical' : code === 2 ? 'warn' : code === 1 ? 'normal' : null
  }
}

/** /proc/meminfo の MemAvailable（バイト）。単体テストから使う */
export function parseMemAvailable(text: string): number | null {
  const match = /^MemAvailable:\s+(\d+)\s*kB/m.exec(text)
  return match ? Number.parseInt(match[1], 10) * 1024 : null
}

export async function readSystemMemory(platform: NodeJS.Platform = process.platform): Promise<Pick<MemorySample, 'total' | 'available' | 'pressure'>> {
  const total = totalmem()
  try {
    if (platform === 'darwin') {
      const { stdout } = await execFileAsync('sysctl', ['-n', 'kern.memorystatus_level', 'kern.memorystatus_vm_pressure_level'], { timeout: 3000 })
      const { availableRatio, pressure } = parseDarwinSysctl(stdout)
      return { total, available: availableRatio === null ? null : total * availableRatio, pressure }
    }
    if (platform === 'linux') return { total, available: parseMemAvailable(await readFile('/proc/meminfo', 'utf8')), pressure: null }
    if (platform === 'win32') return { total, available: freemem(), pressure: null }
  } catch {
    // 読めなければ空きは分からないものとし、Ferret 全体の量だけで決める（想定内。毎分送らない）
  }
  return { total, available: null, pressure: null }
}

export interface MemoryWatchDeps {
  /** Resource Manager の集計（実行中の1回に相乗りする） */
  collect: () => Promise<ResourceSnapshot>
  /** 直近の集計（maxAgeMs より古ければ null） */
  latest: (maxAgeMs: number) => ResourceSnapshot | null
  readSystem?: () => Promise<Pick<MemorySample, 'total' | 'available' | 'pressure'>>
  /** 知らせを renderer へ（null は消す） */
  send: (notice: MemoryAlertNotice | null) => void
  /** 新しく出したとき。ウィンドウが前に無ければ OS の通知を出す */
  notify: (notice: MemoryAlertNotice) => void
  now?: () => number
}

export class MemoryWatch {
  private state: MemoryAlertState = INITIAL_MEMORY_ALERT
  private last: MemoryAlertNotice | null = null
  private lastSample: MemorySample | null = null
  private timer: NodeJS.Timeout | null = null
  private running = false

  constructor(private readonly deps: MemoryWatchDeps) {}

  start(firstDelayMs = MEMORY_CHECK_MS): void {
    if (this.timer) return
    const first = setTimeout(() => {
      void this.check()
      this.timer = setInterval(() => void this.check(), MEMORY_CHECK_MS)
      this.timer.unref?.()
    }, firstDelayMs)
    first.unref?.()
    this.timer = first
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  /** いま出している知らせ（画面を読み込み直したとき） */
  current(): MemoryAlertNotice | null {
    return this.state.shown ? this.last : null
  }

  /** 「あとで」 */
  dismiss(): void {
    this.state = dismissMemoryAlert(this.state, this.lastSample, (this.deps.now ?? Date.now)())
    this.last = null
    this.deps.send(null)
  }

  /** 1回見る（単体テストから直接呼ぶ） */
  async check(): Promise<void> {
    if (this.running) return
    this.running = true
    try {
      const now = (this.deps.now ?? Date.now)()
      const system = await (this.deps.readSystem ?? readSystemMemory)()
      // フッターの集計（60 秒ごと）が新しければそれを使う。無ければ1回だけ取る
      const snapshot = this.deps.latest(MEMORY_CHECK_MS * 1.5) ?? await this.deps.collect().catch(() => null)
      const sample: MemorySample = { ...system, ferret: snapshot ? snapshot.totalMemory : null }
      this.lastSample = sample
      const { state, action } = stepMemoryAlert(this.state, sample, now)
      this.state = state
      if (action === null) return
      if (action === 'hide' || state.level === 'ok') {
        this.last = null
        this.deps.send(null)
        return
      }
      const notice: MemoryAlertNotice = { level: state.level, total: sample.total, available: sample.available, ferret: sample.ferret, snapshot, at: now }
      this.last = notice
      this.deps.send(notice)
      if (action === 'show') this.deps.notify(notice)
    } finally {
      this.running = false
    }
  }
}
