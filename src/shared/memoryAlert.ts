import type { ResourceSnapshot } from './resources'
import type { TuiAgent } from './types'

/**
 * メモリが足りなくなったときの知らせ（勝手には何も止めない。どれを止めるかは利用者が選ぶ）。
 *
 * main（src/main/memoryWatch.ts）が 60 秒ごとに PC の空きメモリと Ferret 全体の使用量を見て、
 * ここの決まりで「出す・消す・出し直す」を決める。renderer（components/MemoryAlert.tsx）は
 * ここの memoryConsumers で「止められるもの」を大きい順に並べて出す。
 * Electron・DOM に依存しない（単体テストで境界・ヒステリシス・間隔を確かめる）。
 */

const GB = 1024 ** 3

/** 出す: 空きが全体のこれ未満 */
export const LOW_AVAILABLE_RATIO = 0.10
/** 出す: 空きがこれ未満（小さい PC で割合だけだと遅すぎる） */
export const LOW_AVAILABLE_BYTES = 1.5 * GB
/** 出す: Ferret（アプリ・内蔵ブラウザ・全ターミナルのプロセスツリー）が全体のこれより多い */
export const HIGH_FERRET_RATIO = 0.60
/** 強く出す（あとで、の間でも出し直す）: 空きが全体のこれ未満 */
export const CRITICAL_AVAILABLE_RATIO = 0.05
export const CRITICAL_AVAILABLE_BYTES = 0.75 * GB
export const CRITICAL_FERRET_RATIO = 0.75
/** 消す（ヒステリシス）: 空きが全体のこれ以上、かつこれ以上のバイト、かつ Ferret がこれ以下で、OS の逼迫も無いとき */
export const RECOVER_AVAILABLE_RATIO = 0.15
export const RECOVER_AVAILABLE_BYTES = 2.5 * GB
export const RECOVER_FERRET_RATIO = 0.50
/** 「あとで」を押してから出し直さない間 */
export const DISMISS_COOLDOWN_MS = 30 * 60_000
/** 「あとで」の間でも出し直す: 空きが押したときのこの割合を下回った（大きく悪くなった） */
export const WORSE_AVAILABLE_FACTOR = 0.5
/** 見る間隔（main のタイマー） */
export const MEMORY_CHECK_MS = 60_000

/** OS の言う逼迫（macOS の kern.memorystatus_vm_pressure_level）。分からなければ null */
export type MemoryPressure = 'normal' | 'warn' | 'critical'

export interface MemorySample {
  /** 物理メモリの合計（バイト） */
  total: number
  /** 使える空き（バイト）。macOS は OS の言う空きの割合（kern.memorystatus_level）、Linux は MemAvailable。分からなければ null */
  available: number | null
  pressure: MemoryPressure | null
  /** Ferret 全体の RSS の合計（ResourceSnapshot.totalMemory）。分からなければ null */
  ferret: number | null
}

export type MemoryLevel = 'ok' | 'warn' | 'critical'

const finite = (n: number | null): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0

/** いまの重さ。入る側の閾値で見る（出ている間に消すかは stillLow） */
export function assessMemory(sample: MemorySample): MemoryLevel {
  if (!finite(sample.total) || sample.total <= 0) return 'ok'
  const avail = finite(sample.available) ? sample.available : null
  const ferretRatio = finite(sample.ferret) ? sample.ferret / sample.total : null
  if (
    sample.pressure === 'critical' ||
    (avail !== null && (avail < sample.total * CRITICAL_AVAILABLE_RATIO || avail < CRITICAL_AVAILABLE_BYTES)) ||
    (ferretRatio !== null && ferretRatio > CRITICAL_FERRET_RATIO)
  ) return 'critical'
  if (
    sample.pressure === 'warn' ||
    (avail !== null && (avail < sample.total * LOW_AVAILABLE_RATIO || avail < LOW_AVAILABLE_BYTES)) ||
    (ferretRatio !== null && ferretRatio > HIGH_FERRET_RATIO)
  ) return 'warn'
  return 'ok'
}

/** 出している知らせをまだ消さないか（戻る側の閾値。境目で出たり消えたりしないよう、入る側より広く取る） */
export function stillLow(sample: MemorySample): boolean {
  if (assessMemory(sample) !== 'ok') return true
  if (!finite(sample.total) || sample.total <= 0) return false
  if (sample.pressure === 'warn' || sample.pressure === 'critical') return true
  if (finite(sample.available) && (sample.available < sample.total * RECOVER_AVAILABLE_RATIO || sample.available < RECOVER_AVAILABLE_BYTES)) return true
  if (finite(sample.ferret) && sample.ferret / sample.total > RECOVER_FERRET_RATIO) return true
  return false
}

export interface MemoryAlertState {
  /** いま知らせを出している */
  shown: boolean
  level: MemoryLevel
  /** 「あとで」を押した時刻・そのときの重さと空き（出し直すかを決める） */
  dismissedAt: number | null
  dismissedLevel: MemoryLevel | null
  dismissedAvailable: number | null
}

export const INITIAL_MEMORY_ALERT: MemoryAlertState = { shown: false, level: 'ok', dismissedAt: null, dismissedLevel: null, dismissedAvailable: null }

/**
 * 次の状態と、することを決める。
 * - show: 新しく出す（OS の通知もこのときだけ）／ update: 出したまま中身を新しくする／ hide: 消す／ null: 何もしない
 */
export function stepMemoryAlert(state: MemoryAlertState, sample: MemorySample, now: number): { state: MemoryAlertState; action: 'show' | 'update' | 'hide' | null } {
  const level = assessMemory(sample)
  if (state.shown) {
    if (stillLow(sample)) return { state: { ...state, level: level === 'ok' ? state.level : level }, action: 'update' }
    return { state: { ...state, shown: false, level: 'ok' }, action: 'hide' }
  }
  if (level === 'ok') return { state: { ...state, level }, action: null }
  if (state.dismissedAt !== null && now - state.dismissedAt < DISMISS_COOLDOWN_MS && !muchWorse(state, sample, level)) {
    return { state: { ...state, level }, action: null }
  }
  return { state: { ...state, shown: true, level, dismissedAt: null, dismissedLevel: null, dismissedAvailable: null }, action: 'show' }
}

/** 「あとで」を押したときより大きく悪くなったか（重さが上がった・空きが半分を切った） */
function muchWorse(state: MemoryAlertState, sample: MemorySample, level: MemoryLevel): boolean {
  if (level === 'critical' && state.dismissedLevel !== 'critical') return true
  return finite(state.dismissedAvailable) && finite(sample.available) && sample.available < state.dismissedAvailable * WORSE_AVAILABLE_FACTOR
}

/** 「あとで」。DISMISS_COOLDOWN_MS の間は、大きく悪くならない限り出し直さない */
export function dismissMemoryAlert(state: MemoryAlertState, sample: MemorySample | null, now: number): MemoryAlertState {
  return {
    ...state,
    shown: false,
    dismissedAt: now,
    dismissedLevel: state.level === 'ok' ? 'warn' : state.level,
    dismissedAvailable: sample && finite(sample.available) ? sample.available : null
  }
}

// ───────────────────────── 知らせの中身（main → renderer） ─────────────────────────

export interface MemoryAlertNotice {
  level: Exclude<MemoryLevel, 'ok'>
  total: number
  available: number | null
  ferret: number | null
  snapshot: ResourceSnapshot | null
  at: number
}

// ───────────────────────── 止められるものの並び（renderer） ─────────────────────────

/** renderer の TerminalPane が知らせる、ペインの中身（terminal/paneDirectory.ts） */
export interface PaneInfo {
  /** main のターミナルID */
  ptyId: string
  launch: TuiAgent | null
  /** 画面の印（working・blocked・done・idle・unknown） */
  state: string
  /** 会話を残したまま止めて、あとで続きから起動し直せる（Claude Code・Codex で、同じフォルダとアカウントのペインがほかに無い） */
  resumable: boolean
}

export type ConsumerKind = 'agent' | 'shell' | 'page'

export interface MemoryConsumer {
  kind: ConsumerKind
  /** terminal: main のターミナルID / page: 'page' */
  id: string
  projectId: string | null
  projectName: string
  label: string
  launch: TuiAgent | null
  memory: number
  /** 動いている（作業中・確認待ちの Agent、コマンドが走っているシェル）。止める前に確かめる */
  busy: boolean
  /** 「止める」で会話を残したまま休ませる（あとで続きから） */
  resumable: boolean
}

/** 並べる下限（これより小さいものは止めても足しにならない） */
export const CONSUMER_MIN_BYTES = 50 * 1024 * 1024
export const CONSUMER_LIMIT = 8

/** 止められるものを大きい順に。アプリ本体は止められないので入れない */
export function memoryConsumers(
  snapshot: ResourceSnapshot | null,
  panes: ReadonlyMap<string, PaneInfo>,
  limit = CONSUMER_LIMIT,
  minBytes = CONSUMER_MIN_BYTES
): MemoryConsumer[] {
  if (!snapshot) return []
  const rows: MemoryConsumer[] = []
  for (const project of snapshot.projects) {
    for (const term of project.terminals) {
      const pane = panes.get(term.id)
      const launch = pane?.launch ?? null
      const agentBusy = pane ? pane.state === 'working' || pane.state === 'blocked' : false
      rows.push({
        kind: launch ? 'agent' : 'shell',
        id: term.id,
        projectId: project.id,
        projectName: project.name,
        label: term.title,
        launch,
        memory: term.memory,
        // Agent は画面の印で見る（入力待ちでも Agent 自身が子プロセスなので running は常に真）。シェルは何か走っているか
        busy: launch ? agentBusy : term.running,
        resumable: Boolean(launch && pane?.resumable)
      })
    }
    if (project.page) {
      rows.push({
        kind: 'page',
        id: 'page',
        projectId: project.id,
        projectName: project.name,
        label: project.page.title || project.page.url,
        launch: null,
        memory: project.page.memory,
        busy: false,
        resumable: false
      })
    }
  }
  return rows
    .filter((row) => Number.isFinite(row.memory) && row.memory >= minBytes)
    .sort((a, b) => b.memory - a.memory)
    .slice(0, Math.max(0, limit))
}
