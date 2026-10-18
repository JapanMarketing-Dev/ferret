/**
 * ビジネス（venture）の型と、フォルダの中の置き場所。画面・main・Agent への依頼文が共有する約束（docs/venture.md）。
 *
 * ビジネスは「オーケストラの一種」。オーケストラ（editorWorkspace のプロジェクト）のフォルダに venture.json があれば、それがビジネス。
 * メンバー（ビジネス記録・開発・動画チャンネル・発信）はオーケストラに属するプロジェクトで、役割は venture.json に書く。
 * 記録はすべてビジネスのフォルダの JSON と Markdown（git で管理できる）。人の判断（承認・却下・予算の上限）の正本だけは
 * フォルダの外（userData/venture-approvals/。署名つき）に置き、フォルダの status は信じない。
 *
 * ビジネス担当の型（src/shared/business・src/shared/research）には依存しない。段階の id は research/stage.ts の
 * BUSINESS_STAGES と同じ文字列にしてあるので、マージ後はそのまま付け替えられる。
 */

// ---------------------------------------------------------------- フォルダの中の置き場所

/** ビジネスのフォルダの中の置き場所（すべてフォルダからの相対パス。区切りは /） */
export const VENTURE_PATHS = {
  /** 名前・通貨・メンバーの役割・採算の仮定 */
  config: 'venture.json',
  /** 予算の上限（案。効くのは人が承認した値）・チェック項目 */
  guardrails: 'guardrails.json',
  /** 人の承認が要る操作の依頼（Agent・人が書く。status は書いても無視する） */
  approvals: 'approvals/requests.json',
  /** 外部へ送った操作の履歴（送った人・Agent が書く） */
  externalLog: 'log/external.json',
  /** 置いた・選んだ元データ（data/imports/<source>/<ファイル>。CSV・JSON） */
  imports: 'data/imports',
  /** Agent が取得して規定の形（CanonicalFile）で書くデータ（data/agent/<名前>.json） */
  agentData: 'data/agent',
  /** 業務ごとの記録 */
  ads: 'streams/ads/campaigns.json',
  adsDrafts: 'streams/ads/drafts',
  content: 'streams/content/calendar.json',
  contentDrafts: 'streams/content/drafts',
  images: 'streams/images/requests.json',
  imageOutput: 'streams/images/out',
  support: 'streams/support/tickets.json',
  supportDrafts: 'streams/support/drafts',
  satisfaction: 'streams/satisfaction/responses.json',
  checks: 'streams/checks/results.json',
  /** 週ごとの振り返り（Markdown） */
  reports: 'reports'
} as const

// ---------------------------------------------------------------- 設定（venture.json）

/** メンバーの役割。business … business.yaml のビジネス記録 / dev … 開発 / video … 動画チャンネル（src/video）/ publish … 発信用のフォルダ */
export const MEMBER_ROLES = ['business', 'dev', 'video', 'publish'] as const
export type MemberRole = (typeof MEMBER_ROLES)[number]

export interface VentureMember {
  role: MemberRole
  /** そのフォルダの絶対パス（正本。projectId はプロジェクトを消して足し直すと変わる） */
  folder: string
  /** Ferret に登録したプロジェクトの id（分かれば） */
  projectId?: string
}

export interface VentureEconomics {
  /** 限界利益率（0〜1。売上のうち、提供の原価を引いて残る割合）。未入力なら採算と LTV は判定しない */
  marginRate: number | null
  /** LTV を出す継続月数の仮定（複数。既定 [6, 12, 24, 36]） */
  ltvMonths: number[]
  /** 顧客1件あたりの月の売上（上書き）。null ならデータから出す */
  monthlyRevenuePerCustomer: number | null
}

export interface VentureConfig {
  version: 1
  name: string
  createdAt: string
  /** 金額の通貨（ISO 4217。既定 JPY）。違う通貨の行は金額の集計に入れず、取り込みの問題として出す */
  currency: string
  members: VentureMember[]
  economics: VentureEconomics
  /** ファネルの段階ごとの目安の率（前の段階からの率。0〜1）。無ければ FUNNEL_DEFAULT_TARGETS */
  funnelTargets?: Partial<Record<FunnelStage, number>>
}

export const DEFAULT_LTV_MONTHS = [6, 12, 24, 36] as const

// ---------------------------------------------------------------- 取り込んだ数

/** 取り込みの元。canonical は規定の形（Agent が書く・人が整えた CSV/JSON） */
export const SOURCE_KINDS = ['google-ads', 'meta-ads', 'ga4', 'search-console', 'x', 'youtube', 'tiktok', 'support', 'stripe', 'canonical'] as const
export type SourceKind = (typeof SOURCE_KINDS)[number]

/**
 * 数の種類。
 * impressions 表示 / clicks クリック（YouTube は視聴、TikTok はプロフィールの表示）/ sessions サイトの訪問（GA4）/
 * leads 問い合わせ・リード / meetings 商談 / contracts 契約（新しく払った顧客）/ retained 継続した顧客 / referrals 紹介・拡大 /
 * spend 獲得の費用 / revenue 売上 / tickets サポートの件数 / followers 増えたフォロワー・登録者 / conversions 計測の成果（GA4 のキーイベント・広告のコンバージョン）
 */
export const METRIC_KEYS = ['impressions', 'clicks', 'sessions', 'leads', 'meetings', 'contracts', 'retained', 'referrals', 'spend', 'revenue', 'tickets', 'followers', 'conversions'] as const
export type MetricKey = (typeof METRIC_KEYS)[number]

/** 金額の数（通貨を持つ） */
export const MONEY_METRICS: ReadonlySet<MetricKey> = new Set(['spend', 'revenue'])

/**
 * 経路（獲得のチャネル）。取り込みは元ごとに既定の経路を付け、canonical はこの中の値か other を使う
 */
export const CHANNELS = ['google-ads', 'meta-ads', 'organic-search', 'x', 'youtube', 'tiktok', 'blog', 'email', 'referral', 'direct', 'support', 'stripe', 'other'] as const
export type Channel = (typeof CHANNELS)[number]

/** 取り込んだ1行（1日 × 経路 × キャンペーン、または支払い1件） */
export interface MetricRow {
  /** YYYY-MM-DD */
  date: string
  source: SourceKind
  channel: Channel
  campaign?: string
  /** 金額の通貨（ISO 4217。分からなければ無し＝ビジネスの通貨とみなす） */
  currency?: string
  /** 支払い・問い合わせの顧客の手がかり（Stripe の Customer ID など。メールはそのまま持たず、取り込みでハッシュにする） */
  customer?: string
  /** 支払い1件の id（Stripe の charge id など。重複の判定に使う） */
  paymentId?: string
  values: Partial<Record<MetricKey, number>>
  /** どのファイルの何行目か（data/ からの相対パス、1始まり） */
  file: string
  line: number
}

export const IMPORT_ISSUE_CODES = [
  'emptyFile', 'tooLarge', 'tooManyRows', 'encoding', 'noHeader', 'missingColumn', 'badJson', 'badShape', 'unknownSource',
  'badDate', 'badNumber', 'negative', 'duplicate', 'currencyMismatch', 'badChannel'
] as const
export type ImportIssueCode = (typeof IMPORT_ISSUE_CODES)[number]

export interface ImportIssue {
  file: string
  /** 1始まり。ファイル全体の問題なら null */
  line: number | null
  code: ImportIssueCode
  /** 列の名前・元の値など（短く） */
  detail?: string
}

export interface ImportResult {
  rows: MetricRow[]
  issues: ImportIssue[]
  /** 数えずに飛ばした行（空行・合計の行・注記） */
  skipped: number
}

/**
 * 規定の形（Agent が書く data/agent/*.json。人が置く canonical の JSON も同じ）。
 * rows の各行は date・channel が必須、数は METRIC_KEYS の名前で直接書く（例: { "date": "2026-10-01", "channel": "x", "impressions": 1200, "clicks": 30 }）
 */
export interface CanonicalFile {
  version: 1
  /** どこから取ったか（google-ads など。分からなければ canonical） */
  source: SourceKind
  /** 取った日時と方法（事実として。推測は書かない） */
  fetchedAt?: string
  method?: string
  rows: Array<{ date: string; channel: string; campaign?: string; currency?: string; customer?: string; paymentId?: string } & Partial<Record<MetricKey, number>>>
}

// ---------------------------------------------------------------- 判定の結果

/** 期間。from・to は YYYY-MM-DD（両端を含む） */
export interface Period {
  from: string
  to: string
}
export type PeriodPreset = '30d' | '90d' | 'month' | 'all'

/** 事業を進める段階（research/stage.ts の BUSINESS_STAGES と同じ id・同じ順） */
export const VENTURE_STAGES = ['demand', 'firstDeal', 'repeatability', 'unitEconomics', 'operations'] as const
export type VentureStage = (typeof VENTURE_STAGES)[number]

export interface StageCheck {
  stage: VentureStage
  /** true 満たした / false 満たさないことが分かった / null まだ分からない（stage.ts の Check.ok と同じ） */
  ok: boolean | null
  /** 画面の文の差し込み（件数・金額など） */
  params?: Record<string, number | string>
  /** null の理由など（i18n の venture.phase.reason.<reason>） */
  reason?: string
}

export interface PhaseResult {
  /** 先頭から続けて満たした最後の段階（需要も未確認なら null） */
  reached: VentureStage | null
  /** 今取り組む段階（reached の次。全部満たしたら operations） */
  current: VentureStage
  checks: Record<VentureStage, StageCheck>
}

/** ファネルの段階（広告・検索・発信の表示とクリック → 問い合わせ・リード → 商談 → 契約 → 継続 → 紹介・拡大） */
export const FUNNEL_STAGES = ['impressions', 'clicks', 'leads', 'meetings', 'contracts', 'retained', 'referrals'] as const
export type FunnelStage = (typeof FUNNEL_STAGES)[number]

export interface FunnelStep {
  stage: FunnelStage
  /** その段階の数。データが1行も無ければ null（0 と分けて出す） */
  count: number | null
  /** 前の段階からの率（0〜1。先頭・前が null か 0 なら null） */
  rate: number | null
  /** 目安の率 */
  target: number | null
  /** ok 目安以上 / low 目安未満 / stuck 前に数があるのに 0 / noData データなし / first 先頭 */
  status: 'ok' | 'low' | 'stuck' | 'noData' | 'first'
  /** その段階のデータが無く、代わりの数を使ったとき、その数の種類（clicks の代わりの sessions、leads の代わりの conversions） */
  substitute?: MetricKey
}

export interface FunnelResult {
  steps: FunnelStep[]
  /** 止まっている段階（最初の stuck、無ければ目安との比が一番低い low）。無ければ null */
  bottleneck: FunnelStage | null
  /** 経路ごと（数の多い順） */
  byChannel: Array<{ channel: Channel; steps: FunnelStep[] }>
}

export interface ChannelAcquisition {
  channel: Channel
  spend: number
  leads: number
  contracts: number
  revenue: number
  /** spend / contracts（契約 0 なら null） */
  cac: number | null
}

export interface Kpis {
  currency: string
  spend: number | null
  revenue: number | null
  newCustomers: number | null
  /** 獲得単価（費用の合計 / 新しい顧客。成約しなかった経路の費用も入れる） */
  cac: number | null
  /** 顧客1件あたりの月の売上 */
  arpa: number | null
  arpaSource: 'override' | 'data' | null
  marginRate: number | null
  /** 継続月数の仮定ごとの LTV（arpa × marginRate × 月数） */
  ltv: Array<{ months: number; value: number | null; ltvToCac: number | null }>
  /** 回収期間（月）= CAC / (arpa × marginRate) */
  paybackMonths: number | null
  channels: ChannelAcquisition[]
}

// ---------------------------------------------------------------- ガードレール（guardrails.json・承認）

/** 人の承認が要る操作（コードで固定。ファイルで外せない） */
export const APPROVAL_KINDS = ['post', 'adLaunch', 'budgetChange', 'customerReply', 'externalSend', 'billing'] as const
export type ApprovalKind = (typeof APPROVAL_KINDS)[number]

export interface BudgetCap {
  /** 経路（CHANNELS）か '*'（全体） */
  channel: Channel | '*'
  daily: number | null
  monthly: number | null
}

export const CHECK_CATEGORIES = ['quality', 'terms', 'brand', 'privacy'] as const
export type CheckCategory = (typeof CHECK_CATEGORIES)[number]

export interface CheckItem {
  /** C01 など */
  id: string
  category: CheckCategory
  text: string
}

export interface GuardrailsFile {
  version: 1
  /** 上限の案。効くのは人が承認した値（approvedBudgets）。違えば「承認されていない上限の変更」 */
  budgets: BudgetCap[]
  checks: CheckItem[]
}

/** approvals/requests.json の1件 */
export interface ApprovalRequest {
  /** A001 など */
  id: string
  kind: ApprovalKind
  title: string
  /** 送る中身・出稿の条件・返信の本文など（承認はこの中身に結び付く。変われば承認し直し） */
  detail: string
  /** 関係する記録の id（T001・AD01・P001 など） */
  refs: string[]
  createdAt: string
  by?: 'agent' | 'human'
}

/**
 * 承認の状態（正本はフォルダの外の台帳）。changed … 承認したあとに中身（kind・title・detail・refs）が変わった
 */
export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'changed'

export interface ApprovalView extends ApprovalRequest {
  status: ApprovalStatus
  decidedAt?: string
  answer?: string
}

/** log/external.json の1件（外部へ送った操作） */
export interface ExternalAction {
  at: string
  kind: ApprovalKind
  /** 通した承認の id。無ければ「承認なし」として目立たせる */
  approvalId?: string
  summary: string
  result?: string
  url?: string
  /** 'ferret' … Ferret の発信（X・ブログ）の投稿の記録から（人が押したもの） */
  via?: 'agent' | 'human' | 'ferret'
}

/** ok / noApproval 承認の id が無い / notApproved 承認されていない・却下・中身が変わった / kindMismatch 承認の種類が違う */
export type ExternalActionFlag = 'ok' | 'noApproval' | 'notApproved' | 'kindMismatch'

export interface ExternalActionView extends ExternalAction {
  flag: ExternalActionFlag
}

export interface BudgetUsage {
  channel: Channel | '*'
  /** 効いている上限（人が承認した値）。無ければ null */
  cap: { daily: number | null; monthly: number | null } | null
  /** guardrails.json の値が承認と違うとき、その値（未承認の案） */
  proposed: { daily: number | null; monthly: number | null } | null
  /** 期間の最終日の月の消化 */
  monthSpend: number
  /** 期間の中で一番使った日 */
  maxDay: { date: string; spend: number } | null
  /** 日の上限を超えた日 */
  overDays: string[]
  status: 'ok' | 'near' | 'over' | 'noCap'
}

export const ALERT_CODES = [
  'budgetOver', 'budgetNear', 'budgetUnapproved', 'spendWithoutCap', 'approvalPending', 'approvalChanged',
  'actionWithoutApproval', 'checkFailed', 'importIssues', 'replyWaiting'
] as const
export type AlertCode = (typeof ALERT_CODES)[number]

export interface GuardrailAlert {
  level: 'danger' | 'warning'
  code: AlertCode
  /** 画面の文の差し込み（i18n の venture.alert.<code>） */
  params?: Record<string, number | string>
  /** 関係する記録の id */
  refs?: string[]
}

// ---------------------------------------------------------------- 業務ごとの作業場所（ワークストリーム）

export const STREAMS = ['ads', 'content', 'image', 'video', 'support', 'satisfaction', 'checks'] as const
export type Stream = (typeof STREAMS)[number]

export interface AdCampaign {
  /** AD01 など */
  id: string
  channel: Channel
  name: string
  status: 'planned' | 'draft' | 'awaitingApproval' | 'running' | 'paused' | 'ended'
  dailyBudget?: number
  landingUrl?: string
  approvalId?: string
  note?: string
}

export interface ContentItem {
  /** P001 など */
  id: string
  channel: 'x' | 'blog' | 'youtube' | 'tiktok' | 'note' | 'instagram' | 'other'
  title: string
  status: 'idea' | 'draft' | 'review' | 'approved' | 'posted'
  due?: string
  /** 下書きのファイル（フォルダからの相対パス） */
  file?: string
  url?: string
  approvalId?: string
}

export interface ImageRequest {
  /** IMG01 など */
  id: string
  purpose: string
  prompt: string
  status: 'requested' | 'generated' | 'approved' | 'rejected'
  /** 作った画像（フォルダからの相対パス） */
  output?: string
  usage?: string
}

export interface SupportTicket {
  /** T001 など */
  id: string
  receivedAt: string
  channel: string
  /** 顧客の仮名（実名・メール・電話をそのまま書かない） */
  customer: string
  subject: string
  summary: string
  kind: 'inquiry' | 'support' | 'complaint' | 'other'
  status: 'open' | 'drafted' | 'awaitingApproval' | 'replied' | 'closed'
  /** 返信の下書き（streams/support/drafts/T001.md） */
  draft?: string
  approvalId?: string
}

export interface SatisfactionResponse {
  /** R001 など */
  id: string
  date: string
  method: 'nps' | 'csat' | 'survey' | 'interview'
  /** nps は 0〜10、csat は 1〜5 */
  score?: number
  comment?: string
  segment?: string
  tags?: string[]
}

export interface SatisfactionSummary {
  responses: number
  /** NPS（-100〜100。nps の回答が無ければ null） */
  nps: number | null
  npsResponses: number
  promoters: number
  passives: number
  detractors: number
  /** CSAT の平均（1〜5） */
  csat: number | null
  interviews: number
  /** 多いタグ（上位） */
  topTags: Array<{ tag: string; count: number }>
}

export interface CheckResult {
  /** CK001 など */
  id: string
  /** 何を確かめたか（ファイル・URL・記録の id） */
  target: string
  /** guardrails.json の checks の id */
  checkId: string
  result: 'pass' | 'fail' | 'na'
  note?: string
  checkedAt: string
}

export interface StreamRecords {
  ads: AdCampaign[]
  content: ContentItem[]
  images: ImageRequest[]
  support: SupportTicket[]
  satisfaction: SatisfactionResponse[]
  checks: CheckResult[]
}

// ---------------------------------------------------------------- Agent への依頼文の材料

/** 依頼文に差し込む材料（main が今の記録から作る。prompts.ts が使う） */
export interface VenturePromptContext {
  name: string
  /** ビジネスのフォルダの絶対パス */
  root: string
  currency: string
  members: Array<{ role: MemberRole; folder: string; name: string }>
  period: Period | null
  phase: { reached: VentureStage | null; current: VentureStage }
  bottleneck: FunnelStage | null
  /** 目立たせている注意（短い文。画面と同じ言語） */
  alerts: string[]
  /** 効いている予算の上限 */
  budgets: BudgetCap[]
  checks: CheckItem[]
  /** 返信待ち・承認待ちなどの件数 */
  counts: { pendingApprovals: number; openTickets: number; draftsAwaitingApproval: number }
  /** 使っている人の状況（Ferret の「あなたの状況」。@shared/founderProfile） */
  founder?: string
}

// ---------------------------------------------------------------- まとめ（summarize.ts の入口と出口）

/** 人の判断で決める「運営」の段階（台帳の値。G6 と同じく人が決める） */
export type OperationsDecision = 'pass' | 'fail' | null

export interface SummaryInput {
  config: VentureConfig
  guardrails: GuardrailsFile
  /** 台帳で人が承認した予算の上限（効いている値） */
  approvedBudgets: BudgetCap[]
  /** 取り込んで重複を除いた行（全期間） */
  rows: MetricRow[]
  importIssues: ImportIssue[]
  /** 台帳と照らした承認の状態 */
  approvals: ApprovalView[]
  actions: ExternalAction[]
  streams: StreamRecords
  operations: OperationsDecision
  /** 今日（YYYY-MM-DD。テストで固定する） */
  today: string
  period: PeriodPreset
}

export interface VentureSummary {
  /** 集計した期間（データが無く all のときは null） */
  period: Period | null
  phase: PhaseResult
  funnel: FunnelResult
  kpis: Kpis
  budgets: BudgetUsage[]
  actions: ExternalActionView[]
  alerts: GuardrailAlert[]
  satisfaction: SatisfactionSummary
}
