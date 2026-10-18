/**
 * ビジネス1件の記録の型（Ferret 構想 3章・手法.md 15章）。
 * ビジネス1件 = 1フォルダ。記録はプレーンテキスト（YAML と、YAML の前置きつき Markdown）で、Agent も直接読み書きする。
 * ここは main と renderer の両方が使う、副作用の無い型と定数だけを置く。
 */

import type { ExecutionItem, ExecutionKey } from '../research/model'

/** 未確認。0 として数えない（手法.md 6章） */
export const UNKNOWN = 'U' as const
export type Unknown = typeof UNKNOWN

/** 需要・獲得の点（0 弱いと確認／1 一部確認／2 具体的に確認／U 未確認） */
export type Score = 0 | 1 | 2 | Unknown
/** 提供条件（はい／いいえ／U） */
export type YesNo = 'はい' | 'いいえ' | Unknown

export const DEMAND_KEYS = ['D1', 'D2', 'D3', 'D4', 'D5'] as const
export const ACQUISITION_KEYS = ['A1', 'A2', 'A3', 'A4'] as const
export const PROVISION_KEYS = ['P1', 'P2', 'P3', 'P4'] as const
export type DemandKey = (typeof DEMAND_KEYS)[number]
export type AcquisitionKey = (typeof ACQUISITION_KEYS)[number]
export type ProvisionKey = (typeof PROVISION_KEYS)[number]
export type ScoreKey = DemandKey | AcquisitionKey

export const SCORE_LABELS: Record<DemandKey | AcquisitionKey | ProvisionKey, string> = {
  D1: '急ぐ理由',
  D2: '放置の損失',
  D3: '解決行動',
  D4: '既存手段の不足',
  D5: '支払主体と経路',
  A1: '対象者の識別',
  A2: '接点',
  A3: '購入タイミング',
  A4: '獲得の実績',
  P1: '結果を出せる',
  P2: '導入できる',
  P3: '採算が合う',
  P4: '責任を担える'
}

/** 点数1つ。根拠の証拠 ID を必ず添える（無ければ保存時に警告） */
export interface ScoreEntry {
  score: Score
  evidence: string[]
  reason: string
}
export interface ProvisionEntry {
  value: YesNo
  evidence: string[]
  reason: string
}

/** 仮説ごとの段階（証拠の強さ）。人が証拠を見て手動で進める（手法.md 7章） */
export const STAGES = ['探索メモ', 'ネット上の有望仮説', '当事者確認済み', '有料検証済み', '継続提供の見込みあり'] as const
export type Stage = (typeof STAGES)[number]

/** 次に進める条件（画面のチェックリストに出す。点数だけで自動では進めない） */
export const STAGE_EXIT: Record<Stage, string> = {
  探索メモ: '同型の具体的課題が独立した複数当事者で反復し、現行でも残る根拠がある',
  ネット上の有望仮説: '直近の実例、対策、支出・決裁、切替条件を本人に確認した',
  当事者確認済み: '範囲・価格・納期を明示し、対象顧客が実際に支払った',
  有料検証済み: '成果、再利用・再購入、獲得費・提供費を観測した',
  継続提供の見込みあり: '（最終段階）'
}

export const VERDICTS = ['進める', '追加調査', '保留', '棄却'] as const
export type Verdict = (typeof VERDICTS)[number]

/** ループのステップ（構想 2章） */
export const STEP_IDS = ['S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7', 'S8', 'S9', 'S10'] as const
export type StepId = (typeof STEP_IDS)[number]

export interface StepDefinition {
  id: StepId
  name: string
  /** 発見／アクション／チェック */
  phase: '発見' | 'アクション' | 'チェック'
  /** このステップで人と Agent が実際にすること（画面の説明に出す） */
  does: string
  data: string
  exit: string
  method: string
  /** 記録する画面（ビジネスの上のタブ）。null はダッシュボードで足りる */
  view: Exclude<RecordKind, 'approval'> | null
}

/** 段階ごとの狙い（ダッシュボードのステップの説明に出す） */
export const PHASE_GOALS: Record<StepDefinition['phase'], string> = {
  発見: 'お金を払ってでも解きたい困りごとが本当にあるかを、公開されている原典で確かめる段階',
  アクション: '提供案を1つに絞り、当事者に聞き、小さく有料で試す段階',
  チェック: '事前に決めた条件で結果を判定し、次の周で何を1つ変えるかを決める段階'
}

export const STEPS: readonly StepDefinition[] = [
  { id: 'S1', name: '対象決め', phase: '発見', does: '誰の、どんな場面の困りごとを探すかを1文で決める。下の欄でビジネス名と対象の1文を直せる。', data: '対象の1文（誰が・どの場面で・何を完了したいか）', exit: '1文で対象を説明できる', method: '3章', view: null },
  { id: 'S2', name: '証拠収集', phase: '発見', does: '対象の人が困りごとを書いている原典（掲示板・レビュー・求人・公的資料など）を探し、URL 付きで証拠に残す。読んだものは「読了」にし、検索語と期間も残す。右のパネルのプロンプトで Agent に頼める。', data: '証拠台帳（E01…）、検索履歴', exit: '原典の URL 付きで証拠が記録され、検索語・期間・採否が残っている', method: '3〜5章', view: 'evidence' },
  { id: 'S3', name: '束ねる', phase: '発見', does: '集めた証拠を「同じ場面で起きている困りごと」ごとにまとめ、課題仮説（H01…）を作る。証拠を仮説に結び付け、別々の当事者が何人いるかを数える。', data: '課題仮説（H01…）、課題の1文', exit: '発生場面ごとに束ね、独立した当事者の数を数えた', method: '5章', view: 'hypothesis' },
  { id: 'S4', name: '反証・代替比較', phase: '発見', does: '今その人たちが使っている手段（他社の製品・手作業・外注など）を代替として並べ、それでも解けない理由を探す。仮説を否定する一番強い材料も書く。', data: '代替比較（ALT01…）、反証メモ', exit: '現行の手段でも残る不足、または棄却する理由がある', method: '8章・12章', view: 'alternative' },
  { id: 'S5', name: '判定', phase: '発見', does: '仮説を需要 D・獲得 A・提供 P の項目で 0/1/2/U（不明）と採点し、進める／追加調査／保留／棄却を決める。U が残るなら次に何で確かめるかを書く。', data: 'D1〜D5・A1〜A4・P1〜P4（0/1/2/U）', exit: 'U と次の確認方法が分かる。進める／追加調査／保留／棄却を決めた', method: '6〜7章', view: 'hypothesis' },
  { id: 'S6', name: '提供案', phase: 'アクション', does: '何を・いくらで・どの期間提供するかを1文にし、実験（X01…）として価格・合格条件・中止条件を先に決める。', data: '提供の1文、範囲、価格の仮説、合格条件と中止条件', exit: '対象業務1つ・期間1回・測れる結果1つに絞れた', method: '8章・10章', view: 'experiment' },
  { id: 'S7', name: '聞き取り', phase: 'アクション', does: '当事者に同意をもらって話を聞き、直近の実例・今の対策・お金を出す人・乗り換える条件を確かめる。聞いた内容から証拠を起こす。', data: '面談の記録（同意つき）、質問票', exit: '直近の実例、対策、支出・決裁、切り替え条件を本人に確認した', method: '10章', view: 'interview' },
  { id: 'S8', name: '有料試行・集客', phase: 'アクション', does: '実験ページなどで実際に募集し、経路ごとに接触・申込・支払いの数を記録する。外へ出す操作は承認を通す。', data: '実験記録（X01…）、経路別の数', exit: '計画した期間・費用・接触数を消化した', method: '10〜11章', view: 'experiment' },
  { id: 'S9', name: 'チェック', phase: 'チェック', does: '実測の数を、S6 で決めた合格条件・中止条件と突き合わせて合格か中止かを判定する。獲得費（CAC）と提供後に残る額も見る。', data: '実測値、CAC、提供後に残る額、受入・再購入', exit: '合格か中止かを事前の条件で判定した', method: '11章', view: 'experiment' },
  { id: 'S10', name: '次の改善', phase: 'チェック', does: '結論（C01…）と学びを書き、次の周で対象・成果・価格・経路のどれを1つ変えるか、どのステップに戻るかを決めて「周を閉じる」。', data: '結論、学び', exit: '対象・成果・価格・経路のうち変えるものを1つ決め、戻るステップを決めた', method: '12章', view: 'decision' }
]

export function stepById(id: StepId): StepDefinition {
  return STEPS.find((s) => s.id === id) ?? STEPS[0]!
}

export function isStepId(value: unknown): value is StepId {
  return typeof value === 'string' && (STEP_IDS as readonly string[]).includes(value)
}

/** 次の改善で変えるもの（1つだけ選ぶ） */
export const CHANGE_AXES = ['対象', '成果', '価格', '経路'] as const
export type ChangeAxis = (typeof CHANGE_AXES)[number]

/** 周回の記録（何周目に何を変えて、どこへ戻ったか） */
export interface LoopRecord {
  loop: number
  changed: ChangeAxis | null
  backTo: StepId | null
  note: string
  at: string
}

/**
 * 実行条件の4点（最初の有料取引・提供する能力と供給・最初の実験・利益と運用）。
 * ビジネスリサーチの候補から引き継ぐ（型の正本は src/shared/research/model.ts）。特に supply（供給）が抜けやすい
 */
export type { ExecutionKey, ExecutionItem }
export { EXECUTION_KEYS } from '../research/model'

/** business.yaml */
export interface BusinessFile {
  name: string
  /** 対象の1文（誰が・どの場面で・何を完了したいか） */
  target: string
  step: StepId
  loop: number
  currentHypothesis: string | null
  limits: { hours: number | null; yen: number | null }
  loops: LoopRecord[]
  createdAt: string
  /** 実行条件の4点（「プロジェクトにする」で書く。無ければ欄ごと無い＝古い business.yaml・リサーチから来ていないビジネス） */
  execution?: Record<ExecutionKey, ExecutionItem>
}

/** 証拠の根拠の性質（手法.md 5章） */
export const SOURCE_KINDS = ['本人の経験', '発注', '伝聞', '販売者の説明', '分析者の推測'] as const
export type SourceKind = (typeof SOURCE_KINDS)[number]

/** 原典を読めたか。読めていなければ「発見のみ」で、数えない */
export const READ_STATUSES = ['読了', '発見のみ'] as const
export type ReadStatus = (typeof READ_STATUSES)[number]

/** 15.1 証拠記録（1当事者の1つの状況で1件） */
export interface Evidence {
  id: string
  hypotheses: string[]
  /** 当事者・属性 */
  party: string
  /** 当事者の確認根拠 */
  partyBasis: string
  /** 同一人物・企業の重複グループ。U は独立性を確かめられていない（数えない） */
  dupGroup: string
  sourceKind: SourceKind | Unknown
  /** 媒体・出典種（例: 発注サイト、レビューサイト、X） */
  medium: string
  url: string
  publishedAt: string
  checkedAt: string
  readStatus: ReadStatus
  /** 確認した事実（原文から） */
  facts: string
  /** 原文のまま抜いた文 */
  quote: string
  /** 解釈と採点できる範囲 */
  interpretation: string
  supports: ScoreKey[]
  counter: string
  details: {
    scene: string
    loss: string
    deadline: string
    action: string
    spend: string
    conditions: string
    gap: string
    workaround: string
    payer: string
    nextQuestion: string
  }
}

/** 15.2 代替比較 */
export interface Alternative {
  id: string
  hypothesis: string
  method: string
  offering: string
  cost: string
  gap: string
  nextCheck: string
  url: string
  checkedAt: string
}

/** 15.3 仮説判定 */
export interface Hypothesis {
  id: string
  name: string
  stage: Stage
  target: string
  trigger: string
  outcome: string
  problem: string
  offer: string
  whyUnsolved: string
  biggestCounter: string
  next: string
  checker: string
  checkedAt: string
  demand: Record<DemandKey, ScoreEntry>
  acquisition: Record<AcquisitionKey, ScoreEntry>
  provision: Record<ProvisionKey, ProvisionEntry>
  verdict: Verdict | null
  /** 段階を変えた履歴（人が押したときだけ増える） */
  stageHistory: Array<{ from: Stage; to: Stage; at: string; note: string }>
}

/** 聞き取りの記録（同意を確認してからしか録音・記録しない） */
export interface Interview {
  id: string
  hypothesis: string
  /** 相手の役割（氏名は書かない） */
  role: string
  date: string
  consent: boolean
  summary: string
  /** 原文（同意があるときだけ） */
  transcript: string
  evidence: string[]
}

/** 実験の状態 */
export const EXPERIMENT_STATUSES = ['計画のみ', '実施中', '完了', '中止'] as const
export type ExperimentStatus = (typeof EXPERIMENT_STATUSES)[number]

/** 経路ごとの数（接触 → 返信 → 適格商談 → 価格提示 → 有料 → 入金 → 受入 → 再購入）。関心表明・見積依頼は別の欄 */
export const FUNNEL_KEYS = ['contacts', 'replies', 'qualified', 'priced', 'paid', 'payments', 'accepted', 'repurchased'] as const
export type FunnelKey = (typeof FUNNEL_KEYS)[number]
export const FUNNEL_LABELS: Record<FunnelKey, string> = {
  contacts: '接触',
  replies: '返信',
  qualified: '適格商談',
  priced: '価格提示',
  paid: '有料顧客',
  payments: '入金',
  accepted: '成果受入',
  repurchased: '再購入'
}

/** 数（実施前は計画、実施後は実測）。未計測は null（0 と書かない） */
export interface ExperimentNumbers {
  contacts: number | null
  replies: number | null
  qualified: number | null
  priced: number | null
  paid: number | null
  payments: number | null
  accepted: number | null
  repurchased: number | null
  /** 関心表明（入金と混ぜない） */
  interest: number | null
  /** 見積依頼 */
  quoteRequests: number | null
  /** 税抜の入金額（円） */
  revenue: number | null
  /** 広告費（円） */
  adCost: number | null
  /** 外注費・紹介料（円） */
  outsourceCost: number | null
  /** 営業時間（時間） */
  salesHours: number | null
  /** 営業1時間あたりの原価（円） */
  hourlyCost: number | null
  /** 提供の変動費（AI・人手確認・決済手数料など。円） */
  deliveryCost: number | null
  /** 初期導入費（円。継続月の費用と分ける） */
  setupCost: number | null
  /** 月額（継続のとき。円） */
  monthlyPrice: number | null
  /** 月次の変動費（円） */
  monthlyVariableCost: number | null
}

export const CONDITION_METRICS = [...FUNNEL_KEYS, 'interest', 'quoteRequests', 'revenue', 'cac'] as const
export type ConditionMetric = (typeof CONDITION_METRICS)[number]
export interface Condition {
  metric: ConditionMetric
  op: '>=' | '<='
  value: number
}

/** 15.4 実験記録 */
export interface Experiment {
  id: string
  hypothesis: string
  status: ExperimentStatus
  question: string
  targetCondition: string
  channel: string
  offer: string
  price: string
  pass: Condition[]
  stop: Condition[]
  period: { start: string; end: string }
  limits: { yen: number | null; hours: number | null }
  plan: ExperimentNumbers
  actual: ExperimentNumbers
  /** 入金・成果受入を確かめられる記録（どこにあるか） */
  proof: string
  quality: string
  reasons: string
  conclusion: string
  /** 実験ページ（Cloudflare の Worker）。公開は人の承認の後だけ */
  page: { slug: string; status: 'なし' | '下書き' | '公開中' | '停止' } | null
}

/** 15.5 候補ごとの結論 */
export interface Decision {
  id: string
  hypothesis: string
  verdict: Verdict
  stage: Stage
  who: string
  loss: string
  spent: string
  gap: string
  offer: string
  payer: string
  channel: string
  evidence: string[]
  counter: string
  unknowns: string
  next: string
  passStop: string
  /** 学び（次の周のプロンプトへ入れる） */
  learnings: string[]
  /** 効いた打ち手か、効かなかった打ち手か */
  worked: '効いた' | '効かなかった' | '不明'
  at: string
}

/** 人の判断と承認が要る操作（エージェントには実行させない） */
export const APPROVAL_KINDS = ['段階を進める', '棄却', '外部へ送る', '応募', '広告出稿', '課金', 'ログインが必要な操作', '実験ページの公開'] as const
export type ApprovalKind = (typeof APPROVAL_KINDS)[number]
export const APPROVAL_STATUSES = ['待ち', '承認', '却下'] as const
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number]

export interface Approval {
  id: string
  kind: ApprovalKind
  title: string
  /** 何をするか・なぜ要るか */
  detail: string
  /** 関係する ID（H01・X01 など） */
  refs: string[]
  /** 選択肢（推奨を先頭） */
  options: string[]
  status: ApprovalStatus
  answer: string
  requestedBy: string
  requestedAt: string
  decidedAt: string
}

/** 検索履歴の1行（searches.jsonl） */
export interface SearchLog {
  at: string
  query: string
  medium: string
  period: string
  readable: boolean
  adopted: boolean
  note: string
}

/** 送ったプロンプトの履歴（.business/sent/） */
export interface SentPrompt {
  id: string
  at: string
  step: StepId
  promptId: string
  target: string
  body: string
}

/** 記録の種類。ID の頭文字と置き場所 */
export const RECORD_KINDS = {
  hypothesis: { prefix: 'H', dir: 'hypotheses', label: '仮説' },
  evidence: { prefix: 'E', dir: 'evidence', label: '証拠' },
  alternative: { prefix: 'ALT', dir: 'alternatives', label: '代替' },
  interview: { prefix: 'I', dir: 'interviews', label: '聞き取り' },
  experiment: { prefix: 'X', dir: 'experiments', label: '実験' },
  decision: { prefix: 'C', dir: 'decisions', label: '結論' },
  approval: { prefix: 'R', dir: 'approvals', label: '承認' }
} as const
export type RecordKind = keyof typeof RECORD_KINDS
export const RECORD_KIND_LIST = Object.keys(RECORD_KINDS) as RecordKind[]

export interface RecordTypes {
  hypothesis: Hypothesis
  evidence: Evidence
  alternative: Alternative
  interview: Interview
  experiment: Experiment
  decision: Decision
  approval: Approval
}

/** ビジネス1件の全体（読み込んだもの） */
export interface BusinessData {
  root: string
  business: BusinessFile
  hypotheses: Hypothesis[]
  evidence: Evidence[]
  alternatives: Alternative[]
  interviews: Interview[]
  experiments: Experiment[]
  decisions: Decision[]
  approvals: Approval[]
  searches: SearchLog[]
  /** 読めなかったファイル（壊れた YAML など）。画面に出し、黙って捨てない */
  problems: Array<{ path: string; message: string }>
}

/** ID の形（H01、E012、ALT03、X01 など。数字は 2〜4 桁） */
export function idPattern(kind: RecordKind): RegExp {
  return new RegExp(`^${RECORD_KINDS[kind].prefix}\\d{2,4}$`)
}

export function isRecordId(kind: RecordKind, id: unknown): id is string {
  return typeof id === 'string' && idPattern(kind).test(id)
}

/** 次の ID（既存の最大 + 1。2 桁で揃え、100 以上は桁を増やす） */
export function nextId(kind: RecordKind, existing: readonly string[]): string {
  const prefix = RECORD_KINDS[kind].prefix
  let max = 0
  for (const id of existing) {
    const m = new RegExp(`^${prefix}(\\d{2,4})$`).exec(id)
    if (m) max = Math.max(max, Number(m[1]))
  }
  const n = max + 1
  if (n > 9999) throw new Error(`${RECORD_KINDS[kind].label}の ID が上限（${prefix}9999）に達しました`)
  return `${prefix}${String(n).padStart(2, '0')}`
}
