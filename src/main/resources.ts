import { app } from 'electron'
import { execFile } from 'node:child_process'
import { cpus } from 'node:os'
import { promisify } from 'node:util'
import type { Project } from '@shared/types'
import type { ResourceProject, ResourceSnapshot, ResourceTerminal } from '@shared/resources'
import { WindowsProcessCollector } from './resourcesWindows'
import { t } from '@shared/i18n'
import { reportHandled, errorKind } from '@shared/report'

/**
 * Resource Manager の集計。アプリ本体・内蔵ブラウザのページ・各ターミナルのプロセスツリーの
 * CPU と RSS を、ホスト全体の ps 1回からまとめて出す。
 *
 * Orca由来: ~/bench/orca/src/main/memory/collector.ts（MIT）。
 *   - ps -eo pid=,ppid=,pcpu=,rss= を C ロケールで1回だけ実行して索引を作る（parsePsOutput / collectSubtree）
 *   - Electron のプロセスは getAppMetrics、RSS は ps の値を優先（macOS の workingSetSize は共有領域を含むため）
 *   - 複数の呼び出しは実行中の1回に相乗りさせる（ps を重ねて起動しない）
 *   - 節ごとの履歴はリングで持つ（memory-snapshot-buckets.ts）。Orca はメモリだが、ここでは CPU を持つ
 * macOS・Linux は ps、Windows は PowerShell（CIM）→ typeperf で取る（resourcesWindows.ts）。
 * 取れなければアプリ本体（getAppMetrics）だけを数える。
 */

export interface ProcRow {
  pid: number
  ppid: number
  /** 1コアに対する割合（複数コアなら100を超える） */
  cpu: number
  /** RSS（バイト） */
  memory: number
  /** 実行ファイルの名前（ps の comm の最後の部分）。取れない OS（Windows）では無い */
  name?: string
}

interface ProcIndex {
  byPid: Map<number, ProcRow>
  childrenOf: Map<number, number[]>
}

/** `ps -eo pid=,ppid=,pcpu=,rss=,comm=` の出力を読む（comm は無くてもよい。単体テストから使うため export） */
export function parsePsOutput(stdout: string): ProcRow[] {
  const rows: ProcRow[] = []
  for (const line of stdout.split(/\r?\n/)) {
    const fields = line.trim().split(/\s+/)
    if (fields.length < 4) continue
    const pid = Number.parseInt(fields[0], 10)
    const ppid = Number.parseInt(fields[1], 10)
    const cpu = Number.parseFloat(fields[2])
    const rssKb = Number.parseInt(fields[3], 10)
    if (Number.isNaN(pid) || Number.isNaN(ppid)) continue
    // comm は空白を含むことがある（「Ferret Helper (Renderer)」）ので、5列目以降をまとめてから最後の / の後ろを取る
    const name = fields.slice(4).join(' ').split('/').pop()?.slice(0, 64)
    rows.push({
      pid,
      ppid,
      cpu: Number.isFinite(cpu) && cpu > 0 ? cpu : 0,
      memory: Number.isFinite(rssKb) && rssKb > 0 ? rssKb * 1024 : 0,
      ...(name ? { name } : {})
    })
  }
  return rows
}

export function indexProcesses(rows: ProcRow[]): ProcIndex {
  const byPid = new Map<number, ProcRow>()
  const childrenOf = new Map<number, number[]>()
  for (const row of rows) {
    byPid.set(row.pid, row)
    const siblings = childrenOf.get(row.ppid)
    if (siblings) siblings.push(row.pid)
    else childrenOf.set(row.ppid, [row.pid])
  }
  return { byPid, childrenOf }
}

/** root を含む子孫のPIDをすべて辿る。excluded に入っているPID（別のターミナルが数えた分）は辿らない */
export function collectSubtree(index: ProcIndex, root: number, excluded?: ReadonlySet<number>): number[] {
  const result: number[] = []
  const seen = new Set<number>()
  const queue = [root]
  while (queue.length > 0) {
    const pid = queue.pop()!
    if (seen.has(pid) || excluded?.has(pid)) continue
    seen.add(pid)
    if (index.byPid.has(pid)) result.push(pid)
    for (const kid of index.childrenOf.get(pid) ?? []) queue.push(kid)
  }
  return result
}

/** ターミナルの cwd が入っているプロジェクト。入れ子なら一番深いフォルダのものを選ぶ */
export function projectForCwd(cwd: string, projects: readonly Project[]): Project | null {
  const norm = (p: string) => p.replace(/[\\/]+$/, '')
  const target = norm(cwd)
  let best: Project | null = null
  for (const project of projects) {
    const root = norm(project.folderPath)
    if ((target === root || target.startsWith(`${root}/`) || target.startsWith(`${root}\\`)) &&
      (!best || root.length > norm(best.folderPath).length)) best = project
  }
  return best
}

const execFileAsync = promisify(execFile)
const PS_TIMEOUT_MS = 5000
const HISTORY_CAPACITY = 30
const HISTORY_STALE_MS = 10 * 60 * 1000
const OTHER_KEY = '__other__'
/** ターミナルの中で一番重いプロセスの名前を添えるのは、これ以上 CPU を使っているときだけ（Agent が走らせたビルド・テストなどを見分けるため） */
export const TOP_PROCESS_MIN_CPU = 10

/**
 * ターミナルのプロセスツリーで一番 CPU を使っているプロセス（シェル自身を除く）。
 * 行の CPU はツリーの合計なので、Agent が起動したビルド・テスト・スクリプトの分も含む。どれが重いかを見せるため
 */
export function topProcess(index: ProcIndex, pids: readonly number[], root: number): { name: string; cpu: number } | null {
  let best: ProcRow | null = null
  for (const pid of pids) {
    if (pid === root) continue
    const row = index.byPid.get(pid)
    if (row?.name && row.cpu >= TOP_PROCESS_MIN_CPU && (!best || row.cpu > best.cpu)) best = row
  }
  return best?.name ? { name: best.name, cpu: best.cpu } : null
}
/**
 * Windows のプロセス一覧（PowerShell の CIM）は1回で1秒以上かかり、PowerShell を起動するたびに CPU とメモリを使う
 * （FERRET-M: 0.4.15 の Windows で resources:snapshot が毎回 1.2〜1.4 秒）。続けて呼ばれても、この間は前回の一覧を使う。
 * アプリ本体（getAppMetrics）は毎回取り直す
 */
export const WINDOWS_ENUMERATE_MIN_MS = 15_000

/** ps が続けて失敗した回数。一時的な失敗（スリープ明け・ディスプレイの抜き差し・時間切れ）は送らず、続いたときだけ送る（FERRET-1M） */
let psFailures = 0
const PS_REPORT_AFTER = 3

/** 送るか。時間切れで止めたもの（killed）は送らない。続けて PS_REPORT_AFTER 回目のときだけ送る（同じ失敗を何度も送らない） */
export function shouldReportPsFailure(err: unknown, consecutive: number): boolean {
  if ((err as { killed?: unknown } | null)?.killed === true) return false
  return consecutive === PS_REPORT_AFTER
}

async function enumerateWithPs(): Promise<ProcRow[]> {
  try {
    // pcpu はロケールによって小数点が「,」になるので C ロケールに固定する（Orca と同じ）
    const { stdout } = await execFileAsync('ps', ['-eo', 'pid=,ppid=,pcpu=,rss=,comm='], {
      maxBuffer: 10 * 1024 * 1024,
      timeout: PS_TIMEOUT_MS,
      env: { ...process.env, LC_ALL: 'C', LANG: 'C' }
    })
    psFailures = 0
    return parsePsOutput(stdout)
  } catch (err) {
    psFailures++
    console.warn('[resources] ps の実行に失敗しました', err)
    // 失敗の文は ps の stderr を含むので、種類だけを送る
    if (shouldReportPsFailure(err, psFailures)) reportHandled(errorKind(err), { area: 'resources', op: 'sample processes with ps' })
    return []
  }
}

interface ResourceSources {
  terminals: () => Array<{ id: string; pid: number; cwd: string; title: string }>
  projects: () => readonly Project[]
  activeProjectId: () => string | null
  /** 内蔵ブラウザのページ。破棄済みなら null */
  page: () => { pid: number; title: string; url: string } | null
}

export class ResourceCollector {
  /** Windows だけ、CPU% を前回との差で出すために状態を持つ係を使う */
  private readonly windows: WindowsProcessCollector | null
  private inflight: Promise<ResourceSnapshot> | null = null
  private history = new Map<string, { samples: number[]; touchedAt: number }>()
  /** 画面（renderer）を読み込み直した回数。ターミナルがどの読み込みで開かれたかと比べて、置き去りを見つける */
  private rendererEpoch = 0
  private createdEpoch = new Map<string, number>()
  /** 前回のプロセス一覧（Windows で取り直しの間を空けるため） */
  private lastRows: { rows: ProcRow[]; at: number } | null = null
  private lastSnapshot: ResourceSnapshot | null = null

  constructor(
    private readonly sources: ResourceSources,
    /** OS。単体テストから差し替えられるよう外から渡す */
    platform: NodeJS.Platform = process.platform,
    windows?: WindowsProcessCollector,
    private readonly now: () => number = Date.now
  ) {
    this.windows = platform === 'win32' ? windows ?? new WindowsProcessCollector() : null
  }

  /** ホスト全体のプロセス一覧。Windows は PowerShell/typeperf（WINDOWS_ENUMERATE_MIN_MS に1回まで）、それ以外は ps */
  private async enumerateProcesses(): Promise<ProcRow[]> {
    if (!this.windows) return enumerateWithPs()
    const at = this.now()
    if (this.lastRows && at - this.lastRows.at < WINDOWS_ENUMERATE_MIN_MS) return this.lastRows.rows
    const rows = await this.windows.enumerate()
    this.lastRows = { rows, at: this.now() }
    return rows
  }

  /** 画面を読み込み直した（初回の読み込みも含む）。それより前のターミナルはどのタブにも付いていない */
  markRendererLoad(): void {
    this.rendererEpoch += 1
  }

  noteTerminalCreated(id: string): void {
    this.createdEpoch.set(id, this.rendererEpoch)
  }

  /** 置き去りのターミナルID（片付けの対象） */
  orphanIds(): string[] {
    return this.sources.terminals().filter((t) => this.isOrphan(t.id)).map((t) => t.id)
  }

  private isOrphan(id: string): boolean {
    const epoch = this.createdEpoch.get(id)
    return epoch !== undefined && epoch < this.rendererEpoch
  }

  collect(): Promise<ResourceSnapshot> {
    if (this.inflight) return this.inflight
    this.inflight = this.run().then((snapshot) => { this.lastSnapshot = snapshot; return snapshot }).finally(() => { this.inflight = null })
    return this.inflight
  }

  /** 直近の集計。maxAgeMs より古い・まだ無いなら null（メモリの見張りが ps を重ねて起動しないため。memoryWatch.ts） */
  latest(maxAgeMs: number): ResourceSnapshot | null {
    const last = this.lastSnapshot
    return last && this.now() - last.collectedAt <= maxAgeMs ? last : null
  }

  private pushHistory(key: string, cpu: number, now: number): number[] {
    let ring = this.history.get(key)
    if (!ring) {
      ring = { samples: [], touchedAt: now }
      this.history.set(key, ring)
    }
    ring.samples.push(cpu)
    if (ring.samples.length > HISTORY_CAPACITY) ring.samples.shift()
    ring.touchedAt = now
    return [...ring.samples]
  }

  private async run(): Promise<ResourceSnapshot> {
    const index = indexProcesses(await this.enumerateProcesses())
    const page = this.sources.page()
    const now = Date.now()

    // アプリ本体と内蔵ブラウザのページ（Electron のプロセス）
    let appCpu = 0
    let appMemory = 0
    let pageCpu = 0
    let pageMemory = 0
    for (const proc of app.getAppMetrics()) {
      const cpu = Math.max(0, proc.cpu?.percentCPUUsage ?? 0)
      const hostRss = index.byPid.get(proc.pid)?.memory
      const memory = hostRss && hostRss > 0 ? hostRss : Math.max(0, proc.memory?.workingSetSize ?? 0) * 1024
      if (page && proc.pid === page.pid) {
        pageCpu += cpu
        pageMemory += memory
      } else {
        appCpu += cpu
        appMemory += memory
      }
    }

    // ターミナルごとにプロセスツリーを辿る。共有する祖先を二重に数えない
    const claimed = new Set<number>()
    const projects = this.sources.projects()
    const buckets = new Map<string, ResourceProject>()
    const bucketFor = (project: Project | null): ResourceProject => {
      const key = project?.id ?? OTHER_KEY
      let bucket = buckets.get(key)
      if (!bucket) {
        bucket = { id: project?.id ?? null, name: project?.name ?? t('resources.otherGroup'), cpu: 0, memory: 0, cpuHistory: [], terminals: [], page: null }
        buckets.set(key, bucket)
      }
      return bucket
    }
    // 開いているプロジェクトは、ターミナルが無くてもページの置き場所として出す
    const active = projects.find((p) => p.id === this.sources.activeProjectId()) ?? null
    if (active || page) bucketFor(active)

    const live = new Set<string>()
    for (const term of this.sources.terminals()) {
      live.add(term.id)
      let cpu = 0
      let memory = 0
      const pids = collectSubtree(index, term.pid, claimed)
      for (const pid of pids) {
        const row = index.byPid.get(pid)
        if (!row) continue
        claimed.add(pid)
        cpu += row.cpu
        memory += row.memory
      }
      const top = topProcess(index, pids, term.pid)
      const terminal: ResourceTerminal = {
        id: term.id,
        pid: term.pid,
        title: term.title,
        running: pids.some((pid) => pid !== term.pid),
        orphan: this.isOrphan(term.id),
        cpu,
        memory,
        ...(top ? { top } : {})
      }
      const bucket = bucketFor(projectForCwd(term.cwd, projects))
      bucket.terminals.push(terminal)
      bucket.cpu += cpu
      bucket.memory += memory
    }
    for (const id of this.createdEpoch.keys()) if (!live.has(id)) this.createdEpoch.delete(id)

    if (page) {
      const bucket = bucketFor(active)
      bucket.page = { title: page.title, url: page.url, cpu: pageCpu, memory: pageMemory }
      bucket.cpu += pageCpu
      bucket.memory += pageMemory
    }

    const list = [...buckets.entries()]
      // 登録順。「その他」は最後
      .sort(([a], [b]) => (a === OTHER_KEY ? 1 : b === OTHER_KEY ? -1 :
        projects.findIndex((p) => p.id === a) - projects.findIndex((p) => p.id === b)))
      .map(([key, bucket]) => ({ ...bucket, cpuHistory: this.pushHistory(key, bucket.cpu, now) }))
    for (const [key, ring] of this.history) if (now - ring.touchedAt > HISTORY_STALE_MS) this.history.delete(key)

    const terminals = list.flatMap((p) => p.terminals)
    return {
      app: { cpu: appCpu, memory: appMemory },
      projects: list,
      totalCpu: appCpu + list.reduce((sum, p) => sum + p.cpu, 0),
      totalMemory: appMemory + list.reduce((sum, p) => sum + p.memory, 0),
      terminalCount: terminals.length,
      orphanCount: terminals.filter((t) => t.orphan).length,
      cores: Math.max(1, cpus().length),
      collectedAt: now
    }
  }
}
