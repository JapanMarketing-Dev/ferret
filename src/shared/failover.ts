import type { TuiAgent } from './types'
import { isBuiltinAgent } from './agentCatalog'

/**
 * 上限での自動切り替え（Agent の利用上限に達したら、別のアカウント・次の Agent で作業を続ける）。
 * main / renderer が共有する設定の型と既定値。判定と選び方は src/main/failover/*。
 */

export interface LimitFailoverPrefs {
  /** 自動で切り替える（既定は入） */
  enabled: boolean
  /** 使用量（5時間・週・モデル別のいちばん高いもの）がこの割合（%）以上なら、そのアカウントは上限とみなす */
  thresholdPercent: number
  /** 同じ Agent の別のアカウントへ先に切り替える（Claude Code / Codex のアカウント） */
  switchAccounts: boolean
  /** 引き継ぐ Agent の優先順位（先頭ほど優先）。ここに無い Agent へは引き継がない */
  agentOrder: TuiAgent[]
  /** 優先順位の高い Agent の枠が戻ったら、手が空いたときにそちらへ戻す（既定は切。今の Agent で続ける） */
  returnToPreferred: boolean
  /**
   * 動いているタブのアカウントの使用量がこの割合（%）以上になったら、上限の知らせを待たずに、
   * 今の Agent に進み具合を引き継ぎのファイルへまとめさせて終わらせ、次の優先順位のアカウント・Agent で新しいタブを開いて続ける
   * （人がいない夜間も止まらないように）。100 なら手前では引き継がない
   */
  handoffPercent: number
}

export const MIN_FAILOVER_THRESHOLD = 50
export const MAX_FAILOVER_THRESHOLD = 100

export const DEFAULT_LIMIT_FAILOVER: LimitFailoverPrefs = {
  enabled: true,
  thresholdPercent: 95,
  switchAccounts: true,
  agentOrder: ['claude', 'codex', 'antigravity'],
  returnToPreferred: false,
  handoffPercent: 98
}

/** 優先順位に並べられる数の上限 */
const MAX_ORDER = 12

function isAgentId(value: unknown): value is TuiAgent {
  return isBuiltinAgent(value) || (typeof value === 'string' && /^custom:[a-z0-9][a-z0-9-]{0,47}$/.test(value))
}

/** settings.json から読んだ値を整える。知らない値は既定に戻す */
export function sanitizeLimitFailover(raw: unknown): LimitFailoverPrefs {
  const r = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {}
  const threshold = typeof r.thresholdPercent === 'number' && Number.isFinite(r.thresholdPercent)
    ? Math.min(MAX_FAILOVER_THRESHOLD, Math.max(MIN_FAILOVER_THRESHOLD, Math.round(r.thresholdPercent)))
    : DEFAULT_LIMIT_FAILOVER.thresholdPercent
  const order = Array.isArray(r.agentOrder)
    ? [...new Set(r.agentOrder.filter(isAgentId))].slice(0, MAX_ORDER)
    : DEFAULT_LIMIT_FAILOVER.agentOrder
  return {
    enabled: r.enabled !== false,
    thresholdPercent: threshold,
    switchAccounts: r.switchAccounts !== false,
    agentOrder: order,
    returnToPreferred: r.returnToPreferred === true,
    handoffPercent: typeof r.handoffPercent === 'number' && Number.isFinite(r.handoffPercent)
      ? Math.min(MAX_FAILOVER_THRESHOLD, Math.max(MIN_FAILOVER_THRESHOLD, Math.round(r.handoffPercent)))
      : DEFAULT_LIMIT_FAILOVER.handoffPercent
  }
}

/** main → renderer: この Agent のタブを開いて（開いたあとの引き継ぎは main が行う） */
export interface FailoverLaunchRequest {
  /** terminal:create の failoverToken に渡す */
  token: string
  agent: TuiAgent
  cwd: string
  /** 上限になったターミナル。そのタブと同じプロジェクトに開く */
  fromTerminalId: string
}

/** main → renderer: 切り替えが済んだ・できなかった（フッターとトーストに出す） */
export interface FailoverNotice {
  /** 利用者向けの1文 */
  message: string
  /** 切り替えた先の Agent の表示名（フッターに出す）。切り替えていなければ null */
  toLabel: string | null
  /** 切り替えた先のターミナル（済んだとき）。そのタブを見せる */
  toTerminalId: string | null
  /** 上限になったターミナル。切り替えが済んだら閉じる（枠が戻ったとき古い Agent が同じ作業を続けないように） */
  fromTerminalId: string | null
  at: number
}
