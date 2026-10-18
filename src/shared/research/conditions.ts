/**
 * 成立条件の表（docs/business-research/knowledge.md 第2部 8章「成立条件ごとに支持・反証・未確認を記録」）。評価の主軸。
 * 5条件（課題が十分に強い・対象と購入場面が明確・変更する理由がある・顧客へ到達できる・収益が成立する）ごとに
 * 支持・反証・未確認・次の確認・人の判定を持つ。6項目の加重スコアは補助で、重要な条件への反証が高得点に埋もれないようにする。
 */
import { evidenceSourceKey, isUsableAsProof } from './evidence'
import {
  CONDITION_KEYS,
  CONDITION_STATUSES,
  type Candidate,
  type ConditionKey,
  type ConditionRow,
  type ConditionStatus,
  type PrincipleKey,
  type ResearchData,
  type ResearchEvidence
} from './model'

/** 成立条件 → いちばん近い原則（理由の Check の i18n キー research.check.<principle>.* を組み立てるため） */
export const CONDITION_PRINCIPLES: Record<ConditionKey, PrincipleKey> = {
  problemStrong: 'what',
  targetAndScene: 'who',
  reasonToSwitch: 'why',
  reachable: 'where',
  revenue: 'how'
}

export interface ConditionSignal {
  /** 支持する証拠のうち、データ内にあり裏付けに使えるものの数（ID の重複は1件） */
  support: number
  /** 反証の証拠のうち、データ内にあり裏付けに使えるものの数 */
  counter: number
  /** 支持の独立した出どころの数（同じ dupGroup・同じホストは1つ） */
  supportIndependent: number
  counterIndependent: number
  /** 人の判定（壊れた値は unverified。未確認は需要がないことを意味しない） */
  status: ConditionStatus
  /** 警告: 反証の証拠がある、または人が refuted とした */
  alarm: boolean
}

/** 空の行（記録が欠けた条件に使う） */
export function emptyConditionRow(): ConditionRow {
  return { support: [], counter: [], supportNote: '', counterNote: '', unknown: '', next: '', status: 'unverified' }
}

function usable(ids: unknown, data: ResearchData): ResearchEvidence[] {
  const list = Array.isArray(data?.evidence) ? (data.evidence as readonly ResearchEvidence[]) : []
  const wanted = Array.isArray(ids) ? [...new Set(ids.filter((id): id is string => typeof id === 'string'))] : []
  const out: ResearchEvidence[] = []
  for (const id of wanted) {
    const e = list.find((x) => x && x.id === id)
    if (e && isUsableAsProof(e)) out.push(e)
  }
  return out
}

function independent(list: readonly ResearchEvidence[]): number {
  return new Set(list.map(evidenceSourceKey).filter((k) => k !== null)).size
}

/**
 * 成立条件1行の信号。支持・反証として数えるのは、データ内にあり裏付けに使える証拠（isUsableAsProof）だけ
 * （AI の推測・URL 無し・対象違いや古い事例は支持にも反証にも数えない）。
 * 同じ証拠を支持と反証の両方に置いた場合は両方に数える（警告を消さない側に倒す。記録の検査が warning を出す）
 */
export function conditionSignal(row: ConditionRow, data: ResearchData): ConditionSignal {
  const support = usable(row?.support, data)
  const counter = usable(row?.counter, data)
  const status: ConditionStatus = (CONDITION_STATUSES as readonly string[]).includes(row?.status as string) ? row.status : 'unverified'
  return {
    support: support.length,
    counter: counter.length,
    supportIndependent: independent(support),
    counterIndependent: independent(counter),
    status,
    alarm: counter.length > 0 || status === 'refuted'
  }
}

/** 成立条件の表（CONDITION_KEYS の順。欠けた行は空の行で埋める） */
export function conditionTable(candidate: Candidate, data: ResearchData): Array<{ key: ConditionKey; row: ConditionRow; signal: ConditionSignal }> {
  return CONDITION_KEYS.map((key) => {
    const raw = candidate?.conditions?.[key]
    const row = raw && typeof raw === 'object' ? raw : emptyConditionRow()
    return { key, row, signal: conditionSignal(row, data) }
  })
}

/**
 * 重要な条件への反証（警告の出ている条件）。5条件はどれも成立に必須なので、すべてを重要な条件として扱う。
 * 空でなければ、ほかの点が高くても一覧で印を出し、ランキングでは保留（後ろ）にする
 */
export function hasCriticalCounter(candidate: Candidate, data: ResearchData): ConditionKey[] {
  return conditionTable(candidate, data)
    .filter((r) => r.signal.alarm)
    .map((r) => r.key)
}
