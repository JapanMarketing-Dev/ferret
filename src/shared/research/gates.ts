/**
 * ゲート（G1〜G7）の機械の判定と、人が確定するときの決まり（model.ts の GATE_IDS・PRINCIPLE_GATES）。
 * 機械の判定（autoGates）は保存せず毎回記録から計算する。pass を確定するのは人だけ。
 * G1〜G3 はネットリサーチでかなり判断でき、G4 以降は市場実験で確かめる。高得点でも G4（購入検証）は省略できない。
 */
import { researchExit, sceneComplete } from './decision'
import { principleStatus, type Check, type PrincipleStatus } from './principles'
import {
  CANDIDATE_STAGES,
  DESK_GATES,
  FUNNEL_STAGES,
  GATE_IDS,
  PRINCIPLE_GATES,
  PRINCIPLE_KEYS,
  type Candidate,
  type CandidateStage,
  type FunnelStage,
  type GateId,
  type GateStatus,
  type ResearchData
} from './model'

/** 配列でなければ空（壊れた記録への備え。readonly 配列の型を保つ） */
function arr<T>(v: readonly T[] | null | undefined): readonly T[] {
  return Array.isArray(v) ? v : []
}

export interface GateSuggestion {
  suggestion: 'pass' | 'fail' | 'unknown'
  /** 判定の材料にした確認（原則が混ざる。Check.principle で i18n キーを組み立てる） */
  reasons: Check[]
}

/** G7 の目安: 同じ獲得方法（method か channel）で契約の出た実験の数 */
export const MIN_REPEATED_EXPERIMENTS = 2

/** 同じ方法か経路で契約が出た実験の数の最大（planned を除く。ID の重複は1件） */
export function repeatedAcquisition(candidate: Candidate, data: ResearchData): number {
  const byMethod = new Map<string, Set<string>>()
  const byChannel = new Map<string, Set<string>>()
  const add = (map: Map<string, Set<string>>, key: string, id: string) => map.set(key, (map.get(key) ?? new Set()).add(id))
  for (const x of Array.isArray(data?.experiments) ? data.experiments : []) {
    if (!x || x.candidate !== candidate.id || x.status === 'planned') continue
    const c = x.metrics?.contracts
    if (!(typeof c === 'number' && Number.isFinite(c) && c > 0)) continue
    if (x.method) add(byMethod, `m:${x.method}`, x.id)
    if (x.channel) add(byChannel, `c:${x.channel}`, x.id)
  }
  let max = 0
  for (const set of [...byMethod.values(), ...byChannel.values()]) max = Math.max(max, set.size)
  return max
}

/**
 * 確認の並びから目安を出す。
 * - required（必須の確認）がすべて true → pass
 * - required か supporting のどれかが false → fail
 * - それ以外 → unknown
 * supporting は null でも pass を妨げない（リサーチで判断するゲートに付く実験の確認。実験の前でも G1〜G3 を判断できるように）
 */
function suggest(required: Check[], supporting: Check[] = []): GateSuggestion {
  const reasons = [...required, ...supporting]
  if (reasons.some((c) => c.ok === false)) return { suggestion: 'fail', reasons }
  if (required.length > 0 && required.every((c) => c.ok === true)) return { suggestion: 'pass', reasons }
  return { suggestion: 'unknown', reasons }
}

/**
 * ゲートごとの機械の目安（PRINCIPLE_GATES に沿って principleStatus から集める）:
 *   G1 = Who のリサーチ / G2 = What のリサーチ / G3 = Where のリサーチ（＋ Who の実験 contactable を補助に）
 *   G4 = What・Why の実験 / G5 = How のリサーチ＋ Where・How の実験 / G6 = 常に unknown（人だけが判断。How の automation を材料に出す）
 *   G7 = How の実験＋同じ method か channel で契約の出た実験が2件以上（repeatable）
 * G1〜G3（DESK_GATES）では実験の確認は補助、G4 以降は必須
 */
export function autoGates(candidate: Candidate, data: ResearchData): Record<GateId, GateSuggestion> {
  const st = principleStatus(candidate, data)
  const required = new Map<GateId, Check[]>(GATE_IDS.map((g) => [g, []]))
  const supporting = new Map<GateId, Check[]>(GATE_IDS.map((g) => [g, []]))
  for (const p of PRINCIPLE_KEYS) {
    const s: PrincipleStatus = st[p]
    const map = PRINCIPLE_GATES[p]
    if (map.research !== 'promote') required.get(map.research)?.push(...s.research)
    for (const g of map.experiment) (DESK_GATES.includes(g) ? supporting : required).get(g)?.push(...s.experiment)
  }
  const out = {} as Record<GateId, GateSuggestion>
  for (const g of GATE_IDS) {
    if (g === 'G6') {
      const automation = candidate.how?.automation
      out.G6 = { suggestion: 'unknown', reasons: [{ id: 'automationNoted', principle: 'how', ok: typeof automation === 'string' && automation.trim() !== '' ? true : null }] }
      continue
    }
    const req = required.get(g) as Check[]
    if (g === 'G7') {
      const n = repeatedAcquisition(candidate, data)
      req.push({ id: 'repeatable', principle: 'how', ok: n >= MIN_REPEATED_EXPERIMENTS ? true : null, params: { count: n, min: MIN_REPEATED_EXPERIMENTS } })
    }
    out[g] = suggest(req, supporting.get(g))
  }
  return out
}

/** 人が確定したゲートの状態（記録が壊れていれば pending とみなす） */
function decided(candidate: Candidate, gate: GateId): GateStatus {
  const s = candidate?.gates?.[gate]?.status
  return s === 'pass' || s === 'fail' ? s : 'pending'
}

/**
 * 人がゲートを確定できるか。pass にするには前のゲートがすべて人の pass であること（検証の順番を飛ばさない）。
 * fail・pending（取り消し）はいつでもできる。知らないゲートは拒む
 */
export function canDecideGate(candidate: Candidate, gate: GateId, status: GateStatus): { ok: true } | { ok: false; reason: 'previousNotPassed' } {
  const i = GATE_IDS.indexOf(gate)
  if (i < 0) return { ok: false, reason: 'previousNotPassed' }
  if (status !== 'pass') return { ok: true }
  for (const g of GATE_IDS.slice(0, i)) if (decided(candidate, g) !== 'pass') return { ok: false, reason: 'previousNotPassed' }
  return { ok: true }
}

/** 「プロジェクトにする」に足りないもの（canPromote の missing。i18n で画面に出す） */
export type PromoteMissing = 'G1' | 'G2' | 'G3' | 'whyReason' | 'scene' | 'exit' | 'alreadyPromoted' | 'dropped'

/**
 * 「プロジェクトにする」に進めるか。条件: G1〜G3 が人の pass、Why の「選ばれる理由」が裏付けられている（reasonBacked）、
 * 購買が起きる場面の5欄が埋まっている（scene）、調査の終了条件の6項目を満たした（exit）、
 * まだプロジェクトにしていない、除外していない。missing は満たしていない条件（この順）
 */
export function canPromote(candidate: Candidate, data: ResearchData): { ok: boolean; missing: PromoteMissing[] } {
  const missing: PromoteMissing[] = []
  for (const g of ['G1', 'G2', 'G3'] as const) if (decided(candidate, g) !== 'pass') missing.push(g)
  const reason = principleStatus(candidate, data).why.research.find((c) => c.id === 'reasonBacked')
  if (reason?.ok !== true) missing.push('whyReason')
  if (!sceneComplete(candidate?.scene)) missing.push('scene')
  if (!researchExit(candidate, data).done) missing.push('exit')
  if (candidate?.promotedTo) missing.push('alreadyPromoted')
  if (candidate?.stage === 'dropped') missing.push('dropped')
  return { ok: missing.length === 0, missing }
}

/** 次に人が確定するゲート（人の pass でない最初のゲート。すべて pass なら null） */
export function nextGate(candidate: Candidate): GateId | null {
  return GATE_IDS.find((g) => decided(candidate, g) !== 'pass') ?? null
}

/** 段階ごとの候補の数（いまその段階にいる数。知らない段階は数えない） */
export function funnelCounts(candidates: readonly Candidate[]): Record<CandidateStage, number> {
  const out = Object.fromEntries(CANDIDATE_STAGES.map((s) => [s, 0])) as Record<CandidateStage, number>
  for (const c of arr(candidates)) {
    if (c && (CANDIDATE_STAGES as readonly string[]).includes(c.stage)) out[c.stage]++
  }
  return out
}

/**
 * 段階に「到達した」候補の数（その段階以降にいる数。1,000 → 100 → 20 → 5 → 1〜2 の目安と比べる用）。dropped は数えない
 */
export function funnelReached(candidates: readonly Candidate[]): Record<FunnelStage, number> {
  const now = funnelCounts(candidates)
  const out = {} as Record<FunnelStage, number>
  let acc = 0
  for (let i = FUNNEL_STAGES.length - 1; i >= 0; i--) {
    acc += now[FUNNEL_STAGES[i]]
    out[FUNNEL_STAGES[i]] = acc
  }
  return out
}
