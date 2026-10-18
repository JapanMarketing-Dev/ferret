import {
  CANDIDATE_STAGES,
  FUNNEL_STAGES,
  RESEARCH_SECTIONS,
  SCENE_KEYS,
  type Candidate,
  type CandidateStage,
  type FunnelStage,
  type GateId,
  type ResearchData,
  type ResearchEvidence,
  type ResearchSection,
  type ScoreKey
} from '@shared/research/model'
import type { ResearchPromptId } from '@shared/research/ipc'

/**
 * ビジネスリサーチの画面の表示用の純粋な関数（React・window に依存しない。test/unit/research-ui.test.ts が対象）。
 * 計算・判定（点数・ゲート・経済性）は src/shared/research/* にあり、ここは「どう並べ、どう見せ、入力をどう読むか」だけ。
 */

// ================================================================ 流れ（Discovery → … → プロジェクトにする）

/** 画面の上の「いまどこか」の流れ。knowledge.md の最後の流れに「プロジェクトにする」を足したもの */
export const FLOW_STEPS = ['discovery', 'evidence', 'ranking', 'experiment', 'learning', 'promote'] as const
export type FlowStep = (typeof FLOW_STEPS)[number]

/** 流れの各段で主に触る区分（6機能） */
export const FLOW_SECTIONS: Record<FlowStep, readonly ResearchSection[]> = {
  discovery: ['who', 'what', 'where'],
  evidence: ['what', 'why'],
  ranking: ['ranking'],
  experiment: ['experiment'],
  learning: ['experiment', 'ranking'],
  promote: ['experiment']
}

/**
 * 候補がいま流れのどこにいるか。dropped は null（流れの外）。
 * - discovered … discovery
 * - evidenced … evidence
 * - qualified … ranking（比べて実験に進めるものを選ぶ）
 * - testing … 終わった実験（done・stopped）があれば learning、無ければ experiment
 * - selected … promote（プロジェクトにした後も promote のまま）
 */
export function flowStepOf(candidate: Pick<Candidate, 'id' | 'stage'>, experiments: ReadonlyArray<{ candidate: string; status: string }> = []): FlowStep | null {
  switch (candidate.stage) {
    case 'discovered': return 'discovery'
    case 'evidenced': return 'evidence'
    case 'qualified': return 'ranking'
    case 'testing': return experiments.some((x) => x.candidate === candidate.id && (x.status === 'done' || x.status === 'stopped')) ? 'learning' : 'experiment'
    case 'selected': return 'promote'
    default: return null
  }
}

/** 流れの各段にいる候補の数（dropped は数えない） */
export function flowCounts(data: Pick<ResearchData, 'candidates' | 'experiments'>): Record<FlowStep, number> {
  const out = Object.fromEntries(FLOW_STEPS.map((s) => [s, 0])) as Record<FlowStep, number>
  for (const c of data.candidates) {
    const step = flowStepOf(c, data.experiments)
    if (step) out[step]++
  }
  return out
}

// ================================================================ ファンネル（1000 → 100 → 20 → 5 → 1〜2）

export interface FunnelRow {
  stage: FunnelStage
  /** その段階まで来た候補の数（その段階以降にいるもの。dropped は入れない） */
  reached: number
  /** その段階にちょうどいる数 */
  here: number
  /** 目安（research.yaml の funnelTargets）。不正な値は null */
  target: number | null
  /** 前の段階から残った割合（前が 0 なら null） */
  rate: number | null
}

/**
 * ファンネルの行。段階の数は「そこまで来た数」（次の段階にいるものも前の段階を通ったとみなす）。
 * 知らない stage の候補は数えない
 */
export function funnelRows(candidates: ReadonlyArray<Pick<Candidate, 'stage'>>, targets: Partial<Record<FunnelStage, unknown>> | null | undefined): FunnelRow[] {
  const here = Object.fromEntries(FUNNEL_STAGES.map((s) => [s, 0])) as Record<FunnelStage, number>
  for (const c of candidates) {
    if ((FUNNEL_STAGES as readonly string[]).includes(c.stage)) here[c.stage as FunnelStage]++
  }
  const rows: FunnelRow[] = []
  let after = 0
  const reachedOf: number[] = []
  for (let i = FUNNEL_STAGES.length - 1; i >= 0; i--) {
    after += here[FUNNEL_STAGES[i]!]
    reachedOf[i] = after
  }
  FUNNEL_STAGES.forEach((stage, i) => {
    const raw = targets?.[stage]
    const target = typeof raw === 'number' && Number.isFinite(raw) && raw >= 0 ? Math.round(raw) : null
    const prev = i === 0 ? null : reachedOf[i - 1]!
    rows.push({ stage, reached: reachedOf[i]!, here: here[stage], target, rate: prev ? reachedOf[i]! / prev : null })
  })
  return rows
}

/** 除外した候補の数 */
export function droppedCount(candidates: ReadonlyArray<Pick<Candidate, 'stage'>>): number {
  return candidates.filter((c) => c.stage === 'dropped').length
}

/** 目安に対する実数のバーの幅（0〜100 の %）。目安が 0・null なら実数があれば 100 */
export function progressPercent(actual: number, target: number | null): number {
  if (!Number.isFinite(actual) || actual <= 0) return 0
  if (target === null || !Number.isFinite(target) || target <= 0) return 100
  return Math.min(100, Math.round((actual / target) * 100))
}

/** 数の並び（ファネルの段階）のバーの幅（先頭を 100 とする %）。null・負は 0。先頭が 0・null なら最大値を基準にする */
export function barWidths(counts: ReadonlyArray<number | null>): number[] {
  const clean = counts.map((n) => (typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : 0))
  const base = clean[0]! > 0 ? clean[0]! : Math.max(0, ...clean)
  if (base <= 0) return clean.map(() => 0)
  return clean.map((n) => Math.min(100, Math.round((n / base) * 1000) / 10))
}

// ================================================================ 6機能（区分）と依頼

/** 区分の画面の並び（概要・6機能・証拠台帳） */
export const WORKSPACE_TABS = ['overview', ...RESEARCH_SECTIONS, 'evidence'] as const
export type WorkspaceTab = (typeof WORKSPACE_TABS)[number]

/** 区分ごとの Agent への依頼。概要は discover（候補を出す入口）、6 は実験の設計と学び */
export function promptsForTab(tab: WorkspaceTab): ResearchPromptId[] {
  switch (tab) {
    case 'overview': return ['decide', 'discover', 'evaluate']
    case 'experiment': return ['experiment', 'learning']
    case 'evidence': return ['evaluate', 'what', 'why']
    default: return [tab]
  }
}

/** 依頼が候補を要るか（decide・discover は要らない。learning・evaluate は全体でもよい） */
export function promptNeedsCandidate(id: ResearchPromptId): boolean {
  return id !== 'decide' && id !== 'discover' && id !== 'learning' && id !== 'evaluate'
}

/** 区分の番号（1〜6。概要・証拠台帳は null） */
export function sectionNumber(tab: WorkspaceTab): number | null {
  const i = (RESEARCH_SECTIONS as readonly string[]).indexOf(tab)
  return i < 0 ? null : i + 1
}

// ================================================================ 候補の一覧

export interface CandidateRowInput {
  id: string
  title: string
  stage: CandidateStage
  value: number | null
  attractiveness: number | null
  held: boolean
  cutoffs: readonly ScoreKey[]
  evidenceLevel: 'strong' | 'moderate' | 'weak' | 'none'
  evidenceCount: number
  nextGate: GateId | null
  updatedAt: string
}

export const CANDIDATE_SORT_KEYS = ['score', 'attractiveness', 'evidence', 'stage', 'id', 'updated'] as const
export type CandidateSortKey = (typeof CANDIDATE_SORT_KEYS)[number]

const EVIDENCE_LEVEL_ORDER = { strong: 3, moderate: 2, weak: 1, none: 0 } as const

/**
 * 候補の並べ替え。null（未採点など）は向きにかかわらず最後、同じ値は ID の昇順。
 * score の降順では保留（held）を後ろに回す（rankCandidates と同じ見せ方）
 */
export function sortCandidateRows<T extends CandidateRowInput>(rows: readonly T[], key: CandidateSortKey, dir: 'asc' | 'desc' = 'desc'): T[] {
  const sign = dir === 'asc' ? 1 : -1
  const valueOf = (r: T): number | string | null => {
    switch (key) {
      case 'score': return finiteOrNull(r.value)
      case 'attractiveness': return finiteOrNull(r.attractiveness)
      case 'evidence': return EVIDENCE_LEVEL_ORDER[r.evidenceLevel] * 10_000 + Math.min(9_999, Math.max(0, r.evidenceCount))
      case 'stage': {
        const i = (CANDIDATE_STAGES as readonly string[]).indexOf(r.stage)
        return i < 0 ? null : i
      }
      case 'id': return r.id
      case 'updated': return r.updatedAt || null
    }
  }
  return [...rows].sort((a, b) => {
    if (key === 'score' && dir === 'desc' && a.held !== b.held) return a.held ? 1 : -1
    const va = valueOf(a)
    const vb = valueOf(b)
    if (va === null && vb === null) return a.id.localeCompare(b.id)
    if (va === null) return 1
    if (vb === null) return -1
    const cmp = typeof va === 'number' && typeof vb === 'number' ? va - vb : String(va).localeCompare(String(vb))
    return cmp !== 0 ? cmp * sign : a.id.localeCompare(b.id)
  })
}

/** 一覧の絞り込み。query は ID・題名・市場・課題・顧客のどれかに含まれる（大小文字を区別しない）。stage は 'all'・'active'（dropped 以外）・段階 */
export function filterCandidates<T extends Pick<Candidate, 'id' | 'title' | 'stage'> & Partial<Pick<Candidate, 'market' | 'problem' | 'customer'>>>(
  list: readonly T[],
  query: string,
  stage: 'all' | 'active' | CandidateStage
): T[] {
  const q = query.trim().toLowerCase()
  return list.filter((c) => {
    if (stage === 'active' ? c.stage === 'dropped' : stage !== 'all' && c.stage !== stage) return false
    if (!q) return true
    return [c.id, c.title, c.market ?? '', c.problem ?? '', c.customer ?? ''].some((s) => s.toLowerCase().includes(q))
  })
}

// ================================================================ 数の見せ方

const DASH = '—'

function finiteOrNull(n: number | null | undefined): number | null {
  return typeof n === 'number' && Number.isFinite(n) ? n : null
}

/** スコア /100（整数に丸める）。null・非数は — */
export function formatScore(value: number | null | undefined): string {
  const n = finiteOrNull(value)
  return n === null ? DASH : String(Math.round(Math.min(100, Math.max(0, n))))
}

/** 魅力度（比べるための概念値。小数1桁、100 以上は整数） */
export function formatAttractiveness(value: number | null | undefined): string {
  const n = finiteOrNull(value)
  if (n === null) return DASH
  return Math.abs(n) >= 100 ? String(Math.round(n)) : (Math.round(n * 10) / 10).toFixed(1)
}

/** 率（0〜1）を %。1% 未満は小数1桁 */
export function formatPercent(rate: number | null | undefined): string {
  const n = finiteOrNull(rate)
  if (n === null) return DASH
  const pct = n * 100
  const abs = Math.abs(pct)
  return `${abs > 0 && abs < 1 ? pct.toFixed(1) : String(Math.round(pct))}%`
}

/** 金額（円）。3桁区切り。locale は Intl のタグ */
export function formatYen(value: number | null | undefined, locale = 'ja-JP'): string {
  const n = finiteOrNull(value)
  if (n === null) return DASH
  const r = Math.round(n)
  // 負の数は記号を ¥ の前に（-¥4,500）。丸めて -0 になったものは 0
  return r < 0 ? `-¥${Math.abs(r).toLocaleString(locale)}` : `¥${(r === 0 ? 0 : r).toLocaleString(locale)}`
}

/** 件数（3桁区切り） */
export function formatCount(value: number | null | undefined, locale = 'ja-JP'): string {
  const n = finiteOrNull(value)
  return n === null ? DASH : Math.round(n).toLocaleString(locale)
}

/** 倍率（LTV/CAC など）。小数1桁 + × */
export function formatRatio(value: number | null | undefined): string {
  const n = finiteOrNull(value)
  return n === null ? DASH : `${(Math.round(n * 10) / 10).toFixed(1)}×`
}

/** 月数（小数1桁。整数なら整数） */
export function formatMonths(value: number | null | undefined): string {
  const n = finiteOrNull(value)
  if (n === null) return DASH
  const r = Math.round(n * 10) / 10
  return Number.isInteger(r) ? String(r) : r.toFixed(1)
}

// ================================================================ 入力の読み取り

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: 'notNumber' | 'negative' | 'outOfRange' | 'notInteger' | 'tooLarge' }

/** 入力できる数の上限（これより大きいものは打ち間違いとみなす） */
export const MAX_INPUT_NUMBER = 1e12

/** 全角の数字・記号を半角へ、桁区切り・通貨の記号・空白を取る */
export function normalizeNumberText(text: string): string {
  return text
    .replace(/[０-９．－＋％]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/[−ー]/g, '-')
    .replace(/[,，、\s¥￥円]/g, '')
}

/**
 * 数の欄。空なら null（未確認）。桁区切り・円・全角を許す。
 * options: integer（整数だけ）・min（既定 0。負を許すなら -Infinity）・max
 */
export function parseNumberField(text: string, options: { integer?: boolean; min?: number; max?: number } = {}): Parsed<number | null> {
  const s = normalizeNumberText(text)
  if (s === '') return { ok: true, value: null }
  if (!/^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(s)) return { ok: false, error: 'notNumber' }
  const n = Number(s)
  if (!Number.isFinite(n)) return { ok: false, error: 'tooLarge' }
  const min = options.min ?? 0
  if (n < min) return { ok: false, error: min === 0 ? 'negative' : 'outOfRange' }
  if (Math.abs(n) > MAX_INPUT_NUMBER) return { ok: false, error: 'tooLarge' }
  if (options.max !== undefined && n > options.max) return { ok: false, error: 'outOfRange' }
  if (options.integer && !Number.isInteger(n)) return { ok: false, error: 'notInteger' }
  return { ok: true, value: n }
}

/**
 * 率の欄（0〜1 で持つ）。欄の横に % を出すので、入れる数はいつも %（「35」「35%」「３５％」は 0.35、「0.5」は 0.005）。
 * 0〜100 だけ。空なら null
 */
export function parseRateField(text: string): Parsed<number | null> {
  const s = normalizeNumberText(text)
  if (s === '') return { ok: true, value: null }
  const num = parseNumberField(s.endsWith('%') ? s.slice(0, -1) : s, { min: 0 })
  if (!num.ok) return num
  if (num.value === null) return { ok: false, error: 'notNumber' }
  if (num.value > 100) return { ok: false, error: 'outOfRange' }
  return { ok: true, value: Math.round((num.value / 100) * 1e6) / 1e6 }
}

/** 率を入力欄の文字へ（0.35 → "35"。% は欄の外に書く） */
export function rateToInput(rate: number | null | undefined): string {
  const n = finiteOrNull(rate)
  if (n === null) return ''
  return String(Math.round(n * 1e4) / 100)
}

/** 数を入力欄の文字へ（null は空） */
export function numberToInput(value: number | null | undefined): string {
  const n = finiteOrNull(value)
  return n === null ? '' : String(n)
}

/** 継続月数の仮定の上限（50年） */
export const MAX_RETENTION_MONTHS = 600

/**
 * 継続月数の仮定（例: "6, 12, 24, 36"）。区切りは , 、 空白 /。1〜600 の整数だけ。重複は1つにして昇順。
 * 読めない語があれば invalid に入れる（値は読めたものだけ）
 */
export function parseScenarios(text: string): { value: number[]; invalid: string[] } {
  const tokens = text.split(/[\s,，、/]+/).map((x) => x.trim()).filter(Boolean)
  const value = new Set<number>()
  const invalid: string[] = []
  for (const token of tokens) {
    const s = normalizeNumberText(token).replace(/(か月|ヶ月|ヵ月|カ月|months?|mo|m)$/i, '')
    const n = Number(s)
    if (!/^\d+$/.test(s) || !Number.isInteger(n) || n < 1 || n > MAX_RETENTION_MONTHS) invalid.push(token)
    else value.add(n)
  }
  return { value: [...value].sort((a, b) => a - b), invalid }
}

/** 証拠 ID の欄（"E001, E003"）。形の合うものだけ大文字にして重複を除く。形が違う語は invalid */
export function parseIdList(text: string, prefix: 'C' | 'E' | 'X'): { value: string[]; invalid: string[] } {
  const tokens = text.split(/[\s,，、/]+/).map((x) => x.trim()).filter(Boolean)
  const value: string[] = []
  const invalid: string[] = []
  const re = new RegExp(`^${prefix}\\d{2,4}$`)
  for (const token of tokens) {
    const id = token.toUpperCase()
    if (!re.test(id)) invalid.push(token)
    else if (!value.includes(id)) value.push(id)
  }
  return { value, invalid }
}

/** http(s) の URL か（空は false） */
export function isHttpUrl(text: string): boolean {
  const s = text.trim()
  if (!/^https?:\/\//i.test(s)) return false
  try {
    const url = new URL(s)
    return (url.protocol === 'http:' || url.protocol === 'https:') && url.hostname.length > 0
  } catch {
    return false
  }
}

/** YYYY-MM-DD の実在する日か */
export function isIsoDate(text: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text)
  if (!m) return false
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])]
  const date = new Date(Date.UTC(y, mo - 1, d))
  return date.getUTCFullYear() === y && date.getUTCMonth() === mo - 1 && date.getUTCDate() === d
}

/** 手元の日付（YYYY-MM-DD）。now は引数で受け取る */
export function localDate(now: Date): string {
  if (Number.isNaN(now.getTime())) return ''
  const p = (n: number) => String(n).padStart(2, '0')
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`
}

// ================================================================ 証拠の下書きの検査（保存前にすぐ出す。正式な検査は main の validateResearchRecord）

/** 画面の検査の id（i18n: research.ws.draft.<id>） */
export type DraftIssueId = 'urlRequired' | 'urlForm' | 'quoteOrFact' | 'factEqualsInference' | 'dateForm' | 'dateFuture' | 'aiInferenceAsProof'

export interface DraftIssue {
  field: 'url' | 'quote' | 'fact' | 'inference' | 'checkedAt' | 'grade'
  id: DraftIssueId
  level: 'error' | 'warning'
}

/** 強い種類（行動の証拠）。URL が無いと使えない */
const URL_REQUIRED_GRADES = new Set(['contract', 'paidUsage', 'budgetedTender', 'competitorCase', 'reviewComplaint'])

export function evidenceDraftIssues(e: Pick<ResearchEvidence, 'url' | 'quote' | 'fact' | 'inference' | 'checkedAt' | 'grade'>, today: string): DraftIssue[] {
  const out: DraftIssue[] = []
  const url = e.url.trim()
  if (!url) {
    if (URL_REQUIRED_GRADES.has(e.grade)) out.push({ field: 'url', id: 'urlRequired', level: 'error' })
  } else if (!isHttpUrl(url)) out.push({ field: 'url', id: 'urlForm', level: 'error' })
  if (!e.quote.trim() && !e.fact.trim()) out.push({ field: 'fact', id: 'quoteOrFact', level: 'error' })
  if (e.fact.trim() && e.fact.trim() === e.inference.trim()) out.push({ field: 'inference', id: 'factEqualsInference', level: 'warning' })
  const d = e.checkedAt.trim()
  if (d) {
    if (!isIsoDate(d)) out.push({ field: 'checkedAt', id: 'dateForm', level: 'error' })
    else if (isIsoDate(today) && d > today) out.push({ field: 'checkedAt', id: 'dateFuture', level: 'error' })
  }
  if (e.grade === 'aiInference') out.push({ field: 'grade', id: 'aiInferenceAsProof', level: 'warning' })
  return out
}

/** 証拠をその候補のものに絞り、確認日の新しい順（同じ日は ID の昇順）。candidateId が null なら全部 */
export function evidenceForCandidate(list: readonly ResearchEvidence[], candidateId: string | null): ResearchEvidence[] {
  return list
    .filter((e) => candidateId === null || e.candidate === candidateId)
    .sort((a, b) => (a.checkedAt === b.checkedAt ? a.id.localeCompare(b.id) : (b.checkedAt || '').localeCompare(a.checkedAt || '')))
}

/** URL のホスト名（www. を除く）。読めなければ空 */
export function hostOf(url: string): string {
  if (!isHttpUrl(url)) return ''
  try {
    return new URL(url.trim()).hostname.replace(/^www\./i, '').toLowerCase()
  } catch {
    return ''
  }
}

// ================================================================ 採点の見せ方

/**
 * 1項目の点の見せ方。根拠の証拠が無い点は数として出さない（「根拠なし」）。
 * - none … 点が無い
 * - unbacked … 点はあるが根拠の証拠（使えるもの）が無い
 * - backed … 根拠あり
 */
export function scoreState(score: number | null | undefined, backed: boolean): 'none' | 'unbacked' | 'backed' {
  if (typeof score !== 'number' || !Number.isFinite(score)) return 'none'
  return backed ? 'backed' : 'unbacked'
}

/** 重みの合計（非数・負は 0 とみなす） */
export function weightsTotal(weights: Partial<Record<ScoreKey, unknown>>): number {
  let sum = 0
  for (const v of Object.values(weights)) if (typeof v === 'number' && Number.isFinite(v) && v > 0) sum += v
  return Math.round(sum * 100) / 100
}

/** 重みの欄。0〜100 の数（小数は丸める）。空・不正は error */
export function parseWeight(text: string): Parsed<number> {
  const r = parseNumberField(text, { min: 0, max: 100 })
  if (!r.ok) return r
  if (r.value === null) return { ok: false, error: 'notNumber' }
  return { ok: true, value: Math.round(r.value) }
}

/** 足切りの欄。空は足切りなし（null）。1〜5 の整数 */
export function parseCutoff(text: string): Parsed<number | null> {
  const r = parseNumberField(text, { integer: true, min: 1, max: 5 })
  return r
}

// ================================================================ プロジェクトにする

/** フォルダの名前の上限（文字数） */
export const MAX_FOLDER_NAME = 60

/**
 * 新しいフォルダの名前の案。ファイル名に使えない文字（/ \ : * ? " < > | と制御文字）を - に、
 * 空白を - にまとめ、先頭・末尾の . と - を除き、60 文字で切る。空なら fallback（候補の ID）
 */
export function folderNameFrom(title: string, fallback: string): string {
  const cleaned = [...title.normalize('NFC')]
    .map((ch) => (/[\\/:*?"<>|]/.test(ch) || ch.charCodeAt(0) < 0x20 || ch.charCodeAt(0) === 0x7f ? '-' : ch))
    .join('')
    .replace(/\s+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[.\-]+|[.\-]+$/g, '')
  const cut = [...cleaned].slice(0, MAX_FOLDER_NAME).join('').replace(/[.\-]+$/g, '')
  if (cut && cut !== '..' && cut !== '.') return cut
  return fallback
}

/** フォルダの名前の欄の検査（空は OK＝候補の題名から作る） */
export function folderNameIssue(name: string): 'invalidChars' | 'tooLong' | 'dotName' | null {
  const s = name.trim()
  if (!s) return null
  if (/[\\/:*?"<>|]/.test(s) || [...s].some((ch) => ch.charCodeAt(0) < 0x20)) return 'invalidChars'
  if ([...s].length > MAX_FOLDER_NAME) return 'tooLong'
  if (/^\.+$/.test(s) || s.startsWith('.')) return 'dotName'
  return null
}

// ================================================================ 依頼文・文言

/**
 * 差し込まれなかった {{変数}} を含む括弧書き（（…）・(…)）を消す。括弧の外に残った穴は「—」にする。
 * Check の params は状況によって無いことがある（例: 企業が0社なら割合を出さない）ため、文に {{x}} を出さない
 */
export function stripUnfilled(text: string): string {
  return text
    .replace(/\s*[（(][^（）()]*\{\{[^{}]*\}\}[^（）()]*[）)]/g, '')
    .replace(/\{\{\s*[^{}\s]{1,40}\s*\}\}/g, '—')
    .trim()
}

/** 依頼文に残った {{…}} の穴（重複なし・出た順） */
export function placeholdersIn(text: string): string[] {
  return [...new Set([...text.matchAll(/\{\{\s*([^{}\s]{1,40})\s*\}\}/g)].map((m) => m[1]!))]
}

// ================================================================ 配列の編集（企業・経路・きっかけ・キーワードなどの行）

export function updateAt<T>(list: readonly T[], index: number, patch: Partial<T>): T[] {
  if (!Number.isInteger(index) || index < 0 || index >= list.length) return [...list]
  return list.map((item, i) => (i === index ? { ...item, ...patch } : item))
}

export function removeAt<T>(list: readonly T[], index: number): T[] {
  if (!Number.isInteger(index) || index < 0 || index >= list.length) return [...list]
  return list.filter((_, i) => i !== index)
}

/** 行を1つ動かす（範囲の外へは動かさない） */
export function moveAt<T>(list: readonly T[], index: number, delta: number): T[] {
  const to = index + delta
  if (!Number.isInteger(index) || !Number.isInteger(to) || index < 0 || index >= list.length || to < 0 || to >= list.length) return [...list]
  const next = [...list]
  const [item] = next.splice(index, 1)
  next.splice(to, 0, item as T)
  return next
}

// ================================================================ 候補の下書き

/**
 * 画面の下書きで直さない欄（main の専用の IPC が変える: ゲート・段階・除外の理由・プロジェクトにした記録・日時）。
 * 下書きを保存するときは、これらを最新の保存済みの値にそろえる（下書きの古い値でゲートを戻さない）
 */
export const SERVER_OWNED_CANDIDATE_FIELDS = ['gates', 'stage', 'dropReason', 'promotedTo', 'createdAt', 'updatedAt'] as const

/** 下書きに、保存済みの最新の server 側の欄を重ねる */
export function mergeCandidateDraft(base: Candidate, draft: Candidate): Candidate {
  const out: Candidate = { ...draft }
  for (const key of SERVER_OWNED_CANDIDATE_FIELDS) (out as unknown as Record<string, unknown>)[key] = base[key]
  return out
}

/** 下書きに保存していない変更があるか（server 側の欄の違いは数えない） */
export function candidateDirty(base: Candidate | null | undefined, draft: Candidate | null | undefined): boolean {
  if (!draft) return false
  if (!base) return true
  return !sameJson(mergeCandidateDraft(base, draft), base)
}

/** 記録の深い比較（保存していない変更があるか）。JSON で表せる値だけ */
export function sameJson(a: unknown, b: unknown): boolean {
  return stableStringify(a) === stableStringify(b)
}

function stableStringify(v: unknown): string {
  if (v === undefined) return 'undefined'
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'undefined'
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`
  const keys = Object.keys(v as Record<string, unknown>).filter((k) => (v as Record<string, unknown>)[k] !== undefined).sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify((v as Record<string, unknown>)[k])}`).join(',')}}`
}

// ================================================================ v3: 購買が起きる場面・成立条件・証拠の11項目・有料化率・実行条件

export type SceneKey = (typeof SCENE_KEYS)[number]

/** 購買が起きる場面のうち、埋まっていない欄（前後の空白だけは空とみなす） */
export function sceneMissing(scene: Partial<Record<SceneKey, unknown>> | null | undefined): SceneKey[] {
  return SCENE_KEYS.filter((k) => {
    const v = scene?.[k]
    return typeof v !== 'string' || v.trim() === ''
  })
}

/**
 * 有料化率の仮定（例: "0.5, 2, 5"）。数はいつも %（欄の横に % を出す）。0 より大きく 100 以下。重複を除いて昇順（0〜1 で持つ）。
 * 読めない語は invalid
 */
export function parseConversionScenarios(text: string): { value: number[]; invalid: string[] } {
  const tokens = text.split(/[\s,，、/]+/).map((x) => x.trim()).filter(Boolean)
  const value = new Set<number>()
  const invalid: string[] = []
  for (const token of tokens) {
    const r = parseRateField(token)
    if (!r.ok || r.value === null || r.value <= 0) invalid.push(token)
    else value.add(r.value)
  }
  return { value: [...value].sort((a, b) => a - b), invalid }
}

/** 有料化率の並びを入力欄の文字へ（0.005 → "0.5"） */
export function scenariosToInput(rates: readonly number[]): string {
  return rates.filter((r) => Number.isFinite(r)).map((r) => rateToInput(r)).join(', ')
}

/** 証拠の11項目（調査の方法と評価のナレッジ）。出来事の日と掲載日は2つで1項目 */
export const EVIDENCE_ITEM_KEYS = ['subject', 'problem', 'event', 'behavior', 'amount', 'url', 'eventDate', 'publishedAt', 'publisher', 'inference', 'counter', 'unknowns'] as const
export type EvidenceItemKey = (typeof EVIDENCE_ITEM_KEYS)[number]

/** 11項目の埋まり具合（filled は 0〜11）。文字でない・空白だけは空 */
export function evidenceCompleteness(e: Partial<Record<EvidenceItemKey, unknown>>): { filled: number; total: number; missing: EvidenceItemKey[] } {
  const has = (k: EvidenceItemKey) => typeof e[k] === 'string' && (e[k] as string).trim() !== ''
  const missing = EVIDENCE_ITEM_KEYS.filter((k) => !has(k))
  const dateFilled = has('eventDate') || has('publishedAt')
  const filled = EVIDENCE_ITEM_KEYS.filter((k) => k !== 'eventDate' && k !== 'publishedAt' && has(k)).length + (dateFilled ? 1 : 0)
  return { filled, total: 11, missing }
}

/**
 * 時点の注意: 掲載日が出来事の日より前・出来事（無ければ掲載日）が今日から2年以上前（過去の事例を現在の証拠にしない）。
 * 形の違う日は見ない
 */
export function timingNotes(e: { eventDate: string; publishedAt: string }, today: string): Array<'publishedBeforeEvent' | 'old'> {
  const out: Array<'publishedBeforeEvent' | 'old'> = []
  const ev = isIsoDate(e.eventDate) ? e.eventDate : ''
  const pub = isIsoDate(e.publishedAt) ? e.publishedAt : ''
  if (ev && pub && pub < ev) out.push('publishedBeforeEvent')
  const base = ev || pub
  if (base && isIsoDate(today) && base < `${Number(today.slice(0, 4)) - 2}${today.slice(4)}`) out.push('old')
  return out
}

/**
 * 読む5観点のまとめ。ng があれば ng、1つも付いていなければ unset、weak があれば weak、全部 ok なら ok、一部だけ ok なら partial
 */
export function readingTone(reading: Partial<Record<string, string | null | undefined>> | null | undefined, keys: readonly string[]): 'ok' | 'weak' | 'ng' | 'unset' | 'partial' {
  const values = keys.map((k) => reading?.[k] ?? null)
  if (values.some((v) => v === 'ng')) return 'ng'
  if (!values.some((v) => v === 'ok' || v === 'weak')) return 'unset'
  if (values.some((v) => v === 'weak')) return 'weak'
  return values.every((v) => v === 'ok') ? 'ok' : 'partial'
}

/** 実行条件の並び（供給を先頭に。抜けやすいので目立たせる） */
export const EXECUTION_ORDER = ['supply', 'firstDeal', 'firstExperiment', 'profitOps'] as const

/** 支持と反証の両方に置いた証拠 ID（同じ証拠を両側で数えない） */
export function bothSides(support: readonly string[], counter: readonly string[]): string[] {
  const c = new Set(counter)
  return [...new Set(support.filter((id) => c.has(id)))]
}
