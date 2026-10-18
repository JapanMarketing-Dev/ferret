/**
 * 事業を進める段階と実行条件（docs/business-research/knowledge.md 第2部 10章「これで事業を完全に進められるか」）。
 * 段階ごとの「進んだ」の判定: 需要 → 初回取引 → 再現性 → 採算 → 運営。前の段階を満たした所までを reached とする。
 * 最初の1件は取引が成立する証拠、安定収益の証拠は繰り返しから。
 *
 * Check.ok は principles.ts と同じ（true 満たす / false 満たさないことが分かった / null まだ分からない）。
 * Check.id は i18n の research.check.<principle>.<id>（stageDemand は what、ほかは how）。
 */
import { isUsableAsProof } from './evidence'
import { candidateExperiments, type Check } from './principles'
import {
  BUSINESS_STAGES,
  EXECUTION_KEYS,
  type BusinessStage,
  type Candidate,
  type ExecutionKey,
  type ResearchData,
  type ResearchExperiment
} from './model'

/** 「課題を持ち解決のために行動している」と言える行動の具体性（感想・募集は数えない） */
export const DEMAND_BEHAVIORS = ['usage', 'contract', 'payment'] as const

function count(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null
}

function started(list: readonly ResearchExperiment[]): ResearchExperiment[] {
  return list.filter((x) => x.status !== 'planned')
}

function finished(list: readonly ResearchExperiment[]): ResearchExperiment[] {
  return list.filter((x) => x.status === 'done' || x.status === 'stopped')
}

/** 契約が1件以上ある実験（planned を除く） */
function withContracts(list: readonly ResearchExperiment[]): ResearchExperiment[] {
  return started(list).filter((x) => (count(x.metrics?.contracts) ?? 0) >= 1)
}

/**
 * 需要の検証: その候補の裏付けに使える証拠に、利用・契約・支払いの行動（behaviorLevel）がある、
 * または成立条件「課題が十分に強い」を人が supported とした → true。人が refuted とした → false
 */
function demandCheck(c: Candidate, data: ResearchData): Check {
  const evidence = (Array.isArray(data?.evidence) ? data.evidence : []).filter(
    (e) => e && e.candidate === c.id && isUsableAsProof(e) && (DEMAND_BEHAVIORS as readonly string[]).includes(e.behaviorLevel)
  )
  const status = c.conditions?.problemStrong?.status
  let ok: boolean | null = null
  if (evidence.length > 0 || status === 'supported') ok = true
  else if (status === 'refuted') ok = false
  return { id: 'stageDemand', principle: 'what', ok, params: { behaviors: evidence.length } }
}

/**
 * 初回取引の検証: 契約1件以上かつ売上 > 0 の実験がある（具体的な条件で契約し、対価を受け取った）。
 * 終わった実験があり、どれも契約 0 なら false
 */
function firstDealCheck(exps: readonly ResearchExperiment[]): Check {
  const paid = started(exps).filter((x) => (count(x.metrics?.contracts) ?? 0) >= 1 && (count(x.metrics?.revenue) ?? 0) > 0)
  const done = finished(exps)
  let ok: boolean | null = null
  if (paid.length > 0) ok = true
  else if (done.length > 0 && started(exps).every((x) => count(x.metrics?.contracts) === 0)) ok = false
  return { id: 'stageFirstDeal', principle: 'how', ok, params: { deals: paid.length } }
}

/** 再現性の検証: 契約の出た実験が2件以上（別の実験・別の同種顧客でも成立） */
function repeatabilityCheck(exps: readonly ResearchExperiment[]): Check {
  const n = withContracts(exps).length
  return { id: 'stageRepeatability', principle: 'how', ok: n >= 2 ? true : null, params: { experiments: n, min: 2 } }
}

/**
 * 採算の検証（成約しなかった顧客への費用も含めて利益が残るか）:
 *   利益 = Σ売上 × 限界利益率（How の marginRate）− Σ費用（planned を除くすべての実験。契約の出なかった実験の費用も入れる）
 * 利益 > 0 → true、≤ 0 → false。始めた実験のどれかの費用が未計測・売上がどれも未計測・限界利益率が未確認なら null
 * （費用の抜けた実験を黙って 0 にしない）
 */
function unitEconomicsCheck(c: Candidate, exps: readonly ResearchExperiment[]): Check {
  const list = started(exps)
  const margin = c.how?.marginRate
  const rate = typeof margin === 'number' && Number.isFinite(margin) && margin >= 0 && margin <= 1 ? margin : null
  const spends = list.map((x) => count(x.metrics?.spend))
  const revenues = list.map((x) => count(x.metrics?.revenue)).filter((v): v is number => v !== null)
  if (list.length === 0 || rate === null || spends.some((v) => v === null) || revenues.length === 0) {
    return { id: 'stageUnitEconomics', principle: 'how', ok: null }
  }
  const spend = (spends as number[]).reduce((a, b) => a + b, 0)
  const revenue = revenues.reduce((a, b) => a + b, 0)
  const profit = revenue * rate - spend
  return { id: 'stageUnitEconomics', principle: 'how', ok: profit > 0, params: { profit: Math.round(profit), spend: Math.round(spend), revenue: Math.round(revenue) } }
}

/** 運営の検証: G6（自動化できるか＝代表以外でも必要な品質で繰り返せる）を人が pass にした。fail なら false */
function operationsCheck(c: Candidate): Check {
  const s = c.gates?.G6?.status
  return { id: 'stageOperations', principle: 'how', ok: s === 'pass' ? true : s === 'fail' ? false : null }
}

/**
 * 事業を進める段階。checks は5段階それぞれの確認、reached は先頭から続けて true だった最後の段階（需要も未確認なら null）
 */
export function businessStage(candidate: Candidate, data: ResearchData): { reached: BusinessStage | null; checks: Record<BusinessStage, Check> } {
  const exps = candidateExperiments(candidate, data)
  const checks: Record<BusinessStage, Check> = {
    demand: demandCheck(candidate, data),
    firstDeal: firstDealCheck(exps),
    repeatability: repeatabilityCheck(exps),
    unitEconomics: unitEconomicsCheck(candidate, exps),
    operations: operationsCheck(candidate)
  }
  let reached: BusinessStage | null = null
  for (const s of BUSINESS_STAGES) {
    if (checks[s].ok !== true) break
    reached = s
  }
  return { reached, checks }
}

/**
 * 実行条件4点（最初の有料取引・提供する能力と供給・最初の実験・利益と運用）のうち、人が「確認できた」とした数と、まだのもの。
 * 特に供給（supply）が抜けやすいので supplyMissing を別に返す
 */
export function executionStatus(candidate: Candidate): { confirmed: number; missing: ExecutionKey[]; supplyMissing: boolean } {
  const missing = EXECUTION_KEYS.filter((k) => candidate?.execution?.[k]?.confirmed !== true)
  return { confirmed: EXECUTION_KEYS.length - missing.length, missing, supplyMissing: missing.includes('supply') }
}
