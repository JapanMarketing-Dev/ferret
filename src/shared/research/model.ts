/**
 * ビジネスリサーチの記録の型と定数（main と renderer の両方が使う。副作用なし）。
 *
 * 考え方: 事業は「何を作れるか」ではなく「どうすれば顧客を継続的に獲得できるか」から逆算する。
 * 既存支出の発見 → 顧客の特定 → 集客経路の検証 → 購入意思の確認 → AI で開発 → 自動化・拡大。
 * リサーチの役割は成功の保証ではなく、失敗確率の高い仮説を安く除外すること。
 * 集客の5原則（Who・What・Where・Why・How。docs/business-research/knowledge.md）ごとに
 * 「理論 → ネット調査 → 判定方法 → 実験方法」と完了条件を持ち、7段階のゲート（G1〜G7）に当てはめる（PRINCIPLE_GATES）。
 *
 * リサーチ1件 = 1フォルダ（利用者が選び、Ferret のプロジェクトとして research: true で登録する）。記録はプレーンテキストで git で管理できる:
 *   research.yaml              … 名前・対象範囲・重み・足切り・ファンネルの目安
 *   candidates/C001.md         … 候補（市場・課題・既存サービスと5原則の調査）。YAML の前置き + 自由なメモ
 *   evidence/E001.md           … 証拠（URL・原文・確認日・観測した事実・推論・証拠の種類＝強さ）
 *   experiments/X001.md        … 市場実験（方法・比較の仕方・期間・ファネルの実測の数・学び）
 *   principles/knowledge.md    … 集客の5原則のナレッジ（Ferret が写す。Agent が調べ方の基準として読む）
 *   .research/context.md       … いまの状況（Ferret が書く。Agent が最初に読む）
 *   .research/README.md        … 記録の形式（Ferret が書く）
 *   .research/sent/            … Agent へ送った依頼の履歴（Ferret が書く）
 *
 * 値（段階・種類など）は言語に依存しない英語の識別子で持ち、画面の表記は i18n（research.*）で引く。
 * 数の未確認は null（0 と書かない）。
 */

export type Maybe<T> = T | null

// ================================================================ ファンネル（候補の段階）

/**
 * 候補の段階。数字は例: 1,000 候補 → 100 → 20 → 5 → 1〜2。
 * - discovered: 発見した候補
 * - evidenced: 支出と具体的な課題が確認できる
 * - qualified: 集客経路と AI 代替（提供）可能性が明確
 * - testing: LP・広告・営業で検証している
 * - selected: 購入意思が確認でき、本格開発へ
 * dropped（除外）はファンネルの外。理由を残す
 */
export const FUNNEL_STAGES = ['discovered', 'evidenced', 'qualified', 'testing', 'selected'] as const
export type FunnelStage = (typeof FUNNEL_STAGES)[number]
export const CANDIDATE_STAGES = [...FUNNEL_STAGES, 'dropped'] as const
export type CandidateStage = (typeof CANDIDATE_STAGES)[number]

export const DEFAULT_FUNNEL_TARGETS: Record<FunnelStage, number> = {
  discovered: 1000,
  evidenced: 100,
  qualified: 20,
  testing: 5,
  selected: 2
}

// ================================================================ 5原則

/** 集客の5原則 */
export const PRINCIPLE_KEYS = ['who', 'what', 'where', 'why', 'how'] as const
export type PrincipleKey = (typeof PRINCIPLE_KEYS)[number]

// ---------------------------------------------------------------- Who（コトラーの STP）

/** 顧客を分ける5つの軸 */
export const SEGMENT_AXES = ['attribute', 'situation', 'behavior', 'problem', 'purchase'] as const
export type SegmentAxis = (typeof SEGMENT_AXES)[number]

/** 企業ごとの構造化項目。situation（観測した事実）と inferredProblem（推測）を分けて持つ */
export interface TargetCompany {
  company: string
  industry: string
  employees: Maybe<number>
  /** 状況（観測した事実。例: 法人営業を3名募集中） */
  situation: string
  /** 推定課題（推測） */
  inferredProblem: string
  /** 課題の証拠の URL（求人など） */
  evidenceUrl: string
  /** 購買担当候補（例: 営業部長） */
  buyerRole: string
  /** 到達経路（例: 公式問い合わせ窓口） */
  reachPath: string
}

/** Who の判定5条件（市場全体の大きさより重視） */
export const WHO_CONDITIONS = ['identifiable', 'sharedProblem', 'buyerKnown', 'canPay', 'repeatableContact'] as const
export type WhoCondition = (typeof WHO_CONDITIONS)[number]

export interface WhoResearch {
  /** 5つの軸での顧客の定義（例: 属性=従業員20〜100人の IT 企業） */
  segment: Record<SegmentAxis, string>
  /** 抽出した企業（100社程度。G1 の材料） */
  companies: TargetCompany[]
  /** 特定できた対象企業の総数（companies に全部書かないとき。未確認は null） */
  targetCount: Maybe<number>
  /** 名簿の出典（URL・ファイルの場所など） */
  targetListSource: string
  /** 判定5条件の人の判断（null は未判断。機械の目安は principles.ts が出す） */
  conditions: Record<WhoCondition, Maybe<boolean>>
}

// ---------------------------------------------------------------- What（レビット・Jobs to Be Done）

/** JTBD の3層 */
export interface Jtbd {
  /** 表面のニーズ（例: 営業リストを作りたい） */
  surface: string
  /** 実際の仕事（例: 今週アプローチする企業を見つけたい） */
  job: string
  /** 深い目的（例: 限られた営業人員で商談数を増やしたい） */
  purpose: string
}

/** 需要の5要素（1〜5点。単純な合計にはしない。課題の種類と合わせて読む） */
export const DEMAND_FACTORS = ['severity', 'frequency', 'loss', 'urgency', 'existingSpend'] as const
export type DemandFactor = (typeof DEMAND_FACTORS)[number]

/**
 * 課題の種類。頻度が低くても一度の損失が大きければ魅力的（毎日のデータ入力 vs 年1回の重要な法令対応）。
 * recurring: 繰り返し起きる / highStakes: まれだが一度の損失が大きい / both / unknown
 */
export const PROBLEM_TYPES = ['recurring', 'highStakes', 'both', 'unknown'] as const
export type ProblemType = (typeof PROBLEM_TYPES)[number]

/** 需要の4段階（①緊急 ②顕在 を狙う） */
export const DEMAND_LEVELS = ['urgent', 'explicit', 'latent', 'unaware', 'unknown'] as const
export type DemandLevel = (typeof DEMAND_LEVELS)[number]

/**
 * 課題の定量化。時間 × 単価 → 月額、削減率をかけた理論上の削減額。
 * 削減時間の金銭換算であり、現金支出が減るとは限らない（cashSpendMonthly は別に持つ）
 */
export interface Quantification {
  hoursPerMonth: Maybe<number>
  hourlyCost: Maybe<number>
  /** 削減率（0〜1） */
  reductionRate: Maybe<number>
  /** いま実際に払っている現金（外注・既存サービスの月額。円） */
  cashSpendMonthly: Maybe<number>
  /** 売上機会の損失（月。円。推計） */
  opportunityMonthly: Maybe<number>
}

export interface WhatResearch {
  jtbd: Jtbd
  factors: Record<DemandFactor, Maybe<Score>>
  problemType: ProblemType
  demandLevel: DemandLevel
  quantification: Quantification
  /** 解決すると何が改善するか */
  improvement: string
}

// ---------------------------------------------------------------- Where（4P・シャープ）

/** 集客経路 */
export const CHANNELS = ['seo', 'searchAds', 'comparison', 'outreach', 'referral', 'freeTool', 'notification', 'snsVideo'] as const
export type Channel = (typeof CHANNELS)[number]

/** 顧客の状態 */
export const CUSTOMER_STATES = ['searching', 'comparing', 'notLooking', 'peerInfo', 'inWorkflow', 'periodicCheck'] as const
export type CustomerState = (typeof CUSTOMER_STATES)[number]

/** 顧客の状態ごとに適した経路（集客経路を選ぶ原則の表） */
export const STATE_CHANNELS: Record<CustomerState, readonly Channel[]> = {
  searching: ['seo', 'searchAds'],
  comparing: ['comparison'],
  notLooking: ['outreach'],
  peerInfo: ['referral'],
  inWorkflow: ['freeTool'],
  periodicCheck: ['notification']
}

/** 経路の評価5軸（1〜5点） */
export const CHANNEL_AXES = ['reachability', 'intent', 'cost', 'repeatability', 'scalability'] as const
export type ChannelAxis = (typeof CHANNEL_AXES)[number]

export interface ChannelPlan {
  channel: Channel
  /** 経路が狙う顧客の状態 */
  state: Maybe<CustomerState>
  /** 5軸の点（cost は「獲得コストの低さ」で高いほど良い） */
  axes: Record<ChannelAxis, Maybe<Score>>
  note: string
}

/** 購入のきっかけになる出来事（直接営業の対象を絞る仮説。購入を保証しない） */
/**
 * 今動く理由（購入のきっかけ）。前半は「今動く理由」（調査の方法と評価のナレッジ）、後半は直接営業で見つける出来事（6機能の3）
 */
export const TRIGGER_KINDS = [
  'contractRenewal', // 契約更新が近い
  'newWin', // 新しい顧客・案件を獲得
  'staffShortage', // 担当者が不足（退職など）
  'expansion', // 事業・拠点の拡大
  'incident', // 漏れや遅れが起きた
  'termsChanged', // 現行サービスの条件が変わった
  'deadline', // 締切の接近
  'salesHiring', // 営業担当者の大量採用
  'newDivision', // 新事業部の設立
  'newSite', // 新拠点の開設
  'outsourcing', // 特定業務の外部委託の募集
  'systemRenewal', // 既存システムの更新予定
  'other'
] as const
export type TriggerKind = (typeof TRIGGER_KINDS)[number]

export interface TriggerEvent {
  kind: TriggerKind
  company: string
  url: string
  /** 観測した日（YYYY-MM-DD） */
  observedAt: string
  note: string
}

/** 検索経路の調査（検索ボリュームだけで判断しない。購入意図の明確な高単価キーワードは少なくても価値がある） */
export interface SearchKeyword {
  keyword: string
  /** 月の検索ボリューム（未確認は null） */
  volume: Maybe<number>
  intent: 'info' | 'purchase' | 'unknown'
  /** 上位の競合ページ */
  competitors: string
  /** 広告が出ているか */
  ads: Maybe<boolean>
  /** 新規サイトが参入できそうか */
  enterable: Maybe<boolean>
}

export interface WhereResearch {
  channels: ChannelPlan[]
  triggers: TriggerEvent[]
  keywords: SearchKeyword[]
  /** 購入を考える場面で思い出されるか（メンタル・アベイラビリティ） */
  mentalAvailability: string
  /** 見つけて購入しやすいか（フィジカル・アベイラビリティ） */
  physicalAvailability: string
  /** 顧客がどこにいて、どのタイミングで、どの経路から接触するか（1文） */
  summary: string
}

// ---------------------------------------------------------------- Why（ポーターの競争戦略）

/**
 * 乗り換えの概念式（年額の円）: 期待価値 − 導入負担 − 乗り換えリスク ＞ 現状維持の価値
 */
export interface SwitchingCase {
  expectedValue: Maybe<number>
  adoptionCost: Maybe<number>
  switchingRisk: Maybe<number>
  statusQuoValue: Maybe<number>
  /** 既存サービスと併用でき、導入作業がほぼ要らないか */
  coexists: Maybe<boolean>
}

/** 差別化の7種（「価格」「データ」「流通」の組み合わせに注目） */
export const DIFFERENTIATORS = ['price', 'performance', 'convenience', 'expertise', 'data', 'distribution', 'trust'] as const
export type Differentiator = (typeof DIFFERENTIATORS)[number]

/** 機能一覧ではなく、購入を決める条件を調べる6項目 */
export const WHY_RESEARCH_ITEMS = ['positiveReviews', 'negativeReviews', 'churnPosts', 'comparisonArticles', 'pricing', 'caseStudies'] as const
export type WhyResearchItem = (typeof WHY_RESEARCH_ITEMS)[number]

export interface WhyResearch {
  switching: SwitchingCase
  differentiators: Array<{ kind: Differentiator; note: string }>
  /** 6項目の調べた内容（証拠の ID を本文に書く） */
  findings: Record<WhyResearchItem, string>
  /** 自社を選ぶ理由（1文） */
  reason: string
  /** その理由の裏付け（証拠の ID。顧客の実際の評価や行動） */
  reasonEvidence: string[]
}

// ---------------------------------------------------------------- How（LTV・ユニットエコノミクス）

export interface HowResearch {
  /** 月額の売上（円/社） */
  monthlyPrice: Maybe<number>
  /** 限界利益率（0〜1） */
  marginRate: Maybe<number>
  /** 継続月数の仮定（感度分析。例: 6, 12, 24, 36） */
  retentionScenarios: number[]
  /** 獲得費用の見積り（実験の実測が無いときの仮の CAC。円/社） */
  estimatedCac: Maybe<number>
  /** CAC に含める費用（人件費・制作費などの含め方。統一して書く） */
  cacBasis: string
  /** 代表の稼働を増やさず提供できるか（G6） */
  automation: string
}

// ================================================================ 証拠

/** 証拠が何の話か（収集対象の種類） */
export const EVIDENCE_KINDS = ['search', 'spend', 'complaint', 'hiring', 'competitor', 'reach', 'purchase', 'other'] as const
export type EvidenceKind = (typeof EVIDENCE_KINDS)[number]

/**
 * 証拠の種類＝強さの区分（ナレッジの「証拠の強弱」8段階の表。上ほど強い）。
 * companyFact は表の外の補い: 公式サイト・求人・プレスリリースなどで観測した企業の状況（Who・Where の事実。課題そのものは示さない）
 */
export const EVIDENCE_GRADES = [
  'contract', // 実際の契約・発注（お金が使われている）… 高い
  'paidUsage', // 既存製品の有料利用（市場に支払意思がある）… 高い
  'budgetedTender', // 予算付きの募集・入札（購入する具体的な意思）… 高い
  'competitorCase', // 競合の導入事例（課題解決への支出実績）… 比較的高い
  'reviewComplaint', // 製品レビューの不満（改善余地）… 中程度
  'searchDemand', // 検索需要（情報探索の存在）… 中程度
  'snsComplaint', // SNS での不満（課題の存在可能性）… 低〜中程度
  'aiInference', // AI による課題推測（調査すべき仮説）… 低い
  'companyFact' // 企業の状況の事実（求人・プレスリリースなど）… 中程度（課題の証拠としては数えない）
] as const
export type EvidenceGrade = (typeof EVIDENCE_GRADES)[number]

/** 信頼性の5区分 */
export const RELIABILITY_LEVELS = ['high', 'fairlyHigh', 'medium', 'lowMedium', 'low'] as const
export type Reliability = (typeof RELIABILITY_LEVELS)[number]

export const GRADE_RELIABILITY: Record<EvidenceGrade, Reliability> = {
  contract: 'high',
  paidUsage: 'high',
  budgetedTender: 'high',
  competitorCase: 'fairlyHigh',
  reviewComplaint: 'medium',
  searchDemand: 'medium',
  snsComplaint: 'lowMedium',
  aiInference: 'low',
  companyFact: 'medium'
}

/** 支出（お金が使われている・使う意思）を示す種類。「既存支出と不満が同時に確認できる市場」の判定に使う */
export const SPEND_GRADES: readonly EvidenceGrade[] = ['contract', 'paidUsage', 'budgetedTender', 'competitorCase']
/** 不満を示す種類 */
export const COMPLAINT_GRADES: readonly EvidenceGrade[] = ['reviewComplaint', 'snsComplaint']

/** 証拠1件。観測した事実と、そこから導いた推論を分けて持つ */
/**
 * 証拠を読む5つの観点（評価の工程で付ける。収集の工程では付けない）
 * match 対象との一致 / specificity 行動の具体性 / timing 時点の適切さ（出来事の日と掲載日）/
 * independence 独立性（転載を別の証拠として数えない）/ selectionBias 選ばれ方の偏り（成功事例だけ・不満投稿だけ・特定の販売者の顧客だけ）
 */
export const READING_KEYS = ['match', 'specificity', 'timing', 'independence', 'selectionBias'] as const
export type ReadingKey = (typeof READING_KEYS)[number]
/** ok 問題なし / weak 弱い・一部 / ng 当てはまらない（null は未評価） */
export const READING_LEVELS = ['ok', 'weak', 'ng'] as const
export type ReadingLevel = (typeof READING_LEVELS)[number]

/** 観測された行動の具体性（感想 → 募集 → 利用 → 契約 → 支払い の順に強い） */
export const BEHAVIOR_LEVELS = ['opinion', 'recruiting', 'usage', 'contract', 'payment', 'unknown'] as const
export type BehaviorLevel = (typeof BEHAVIOR_LEVELS)[number]

/** 証拠の工程。収集（collected）と評価（evaluated）は別の工程・別の依頼にする（AI が見つけた情報をそのまま自説の根拠にしない） */
export const EVIDENCE_STATES = ['collected', 'evaluated'] as const
export type EvidenceState = (typeof EVIDENCE_STATES)[number]

/**
 * 証拠1件。記録項目は「調査の方法と評価」のナレッジの11項目にそろえる:
 *   企業・対象者（subject）／課題（problem）／発生した出来事（event）／観測された行動（behavior）／金額・時間・頻度（amount）／
 *   出典URL（url）／出来事の日付（eventDate）と掲載日（publishedAt）は別々／発信者（publisher）／推測（inference）／反証（counter）／未確認事項（unknowns）
 * あわせて原文（quote）・確認した日（checkedAt）・媒体（source）・観測した事実の要約（fact）・証拠の種類（grade）を持つ。
 * 同じ発表の転載は dupGroup を同じにし、別々の証拠として数えない
 */
export interface ResearchEvidence {
  id: string
  /** 結び付く候補（C001…）。どれにも結び付かない発見は空 */
  candidate: string
  /** どの原則の材料か */
  principle: PrincipleKey
  kind: EvidenceKind
  grade: EvidenceGrade
  /** 企業・対象者 */
  subject: string
  /** 課題 */
  problem: string
  /** 発生した出来事 */
  event: string
  /** 観測された行動 */
  behavior: string
  behaviorLevel: BehaviorLevel
  /** 金額・時間・頻度（原文の数のまま） */
  amount: string
  url: string
  /** 出来事の日付（YYYY-MM-DD。分からなければ空） */
  eventDate: string
  /** 掲載日・更新日（YYYY-MM-DD。分からなければ空） */
  publishedAt: string
  /** 情報の発信者（販売者・顧客本人・報道・公的機関など） */
  publisher: string
  /** 原文のまま抜いた文 */
  quote: string
  /** 確認した日（YYYY-MM-DD） */
  checkedAt: string
  /** 媒体（例: 発注サイト、レビューサイト、求人サイト、X） */
  source: string
  /** 観測した事実（原文から言えること） */
  fact: string
  /** そこから導いた推論 */
  inference: string
  /** 仮説に合わない事実・別の説明 */
  counter: string
  /** 未確認事項（「未確認」は需要がないことを意味しない） */
  unknowns: string
  /** 同じ発表・転載のまとまり（同じ値どうしは1件として数える。空なら独立） */
  dupGroup: string
  state: EvidenceState
  /** 読む5観点（評価の工程で付ける） */
  reading: Record<ReadingKey, Maybe<ReadingLevel>>
}

// ================================================================ 採点（比較用）

/**
 * 6項目（1〜5点）。高いほど良い向きにそろえる（competition は「競争の余地」、delivery は「提供のしやすさ」）。
 * 事業魅力度（比較用の概念式）= 需要の強さ × 到達可能性 × 利益可能性 ÷ (競争負荷 × 提供難易度)
 *   競争負荷 = 6 − competition、提供難易度 = 6 − delivery
 * 証拠の信頼度は別に持つ（evidence の grade から計算）。高得点でも購入検証（G4）は省略できない
 */
export const SCORE_KEYS = ['demand', 'spend', 'reach', 'profit', 'competition', 'delivery'] as const
export type ScoreKey = (typeof SCORE_KEYS)[number]
export type Score = 1 | 2 | 3 | 4 | 5

/** 重みの初期値（合計 100）。画面から変えられ、初期値に戻せる */
export const DEFAULT_WEIGHTS: Record<ScoreKey, number> = {
  demand: 25,
  spend: 20,
  reach: 20,
  profit: 15,
  competition: 10,
  delivery: 10
}

/** 足切りの初期値（この点より下なら、ほかが高くても保留）。null は足切りなし。例: 顧客到達性が1点なら保留 */
export const DEFAULT_CUTOFFS: Record<ScoreKey, Maybe<number>> = {
  demand: 2,
  spend: null,
  reach: 2,
  profit: null,
  competition: null,
  delivery: null
}

export interface ScoreEntry {
  score: Maybe<Score>
  /** 根拠の証拠 ID（E001…） */
  evidence: string[]
  reason: string
}

// ================================================================ ゲート（検証の順番）

/**
 * 7段階のゲート。この順に進める（前が pass でないものは pass にできない）。
 * G1 顧客が存在するか（対象企業を100社特定できる）
 * G2 強い課題があるか（支出・求人・不満などの証拠）
 * G3 接触できるか（営業先や検索経路が明確）
 * G4 購入するか（有料契約・予約・具体的な購入意思）
 * G5 利益が残るか（CAC・LTV・回収期間）
 * G6 自動化できるか（代表の稼働を増やさず提供）
 * G7 拡大できるか（同じ獲得方法を繰り返せる）
 * G1〜G3 はネットリサーチでかなり判断でき、G4 以降は市場実験で確かめる
 */
export const GATE_IDS = ['G1', 'G2', 'G3', 'G4', 'G5', 'G6', 'G7'] as const
export type GateId = (typeof GATE_IDS)[number]
/** ネットリサーチで判断するゲート */
export const DESK_GATES: readonly GateId[] = ['G1', 'G2', 'G3']

/**
 * 5原則を統合した事業探索プロセスの表を、ゲートに当てはめたもの。
 * research … リサーチで確かめること（そのゲートの材料）／ experiment … 実験で確かめること
 *   1 Who:   対象顧客・企業数・購買担当 → G1 ／ 実際に接触できるか → G3
 *   2 What:  課題・既存支出・不満 → G2 ／ 本当に解決を求めているか → G4
 *   3 Where: 検索需要・営業経路・競合の流通 → G3 ／ 低コストで顧客を獲得できるか → G5
 *   4 Why:   競合の弱点・価格・乗り換え障壁 → 「プロジェクトにする」の条件 ／ 自社を選ぶか → G4
 *   5 How:   市場規模・価格・コスト構造 → G5（見積り）／ 利益と継続率が成立するか → G5・G7
 * G6（自動化）は How の automation と実験の提供の記録で人が判断する
 */
export const PRINCIPLE_GATES: Record<PrincipleKey, { research: GateId | 'promote'; experiment: readonly GateId[] }> = {
  who: { research: 'G1', experiment: ['G3'] },
  what: { research: 'G2', experiment: ['G4'] },
  where: { research: 'G3', experiment: ['G5'] },
  why: { research: 'promote', experiment: ['G4'] },
  how: { research: 'G5', experiment: ['G5', 'G7'] }
}

export const GATE_STATUSES = ['pass', 'fail', 'pending'] as const
export type GateStatus = (typeof GATE_STATUSES)[number]

/** 人が確定したゲートの判定。機械の判定（gates.ts）は保存せず、毎回記録から計算する */
export interface GateDecision {
  status: GateStatus
  note: string
  /** 確定した日時（ISO8601）。pending なら空 */
  at: string
}

// ================================================================ 成立条件（評価の主軸）

/**
 * 成立に必要な5つの条件。評価は「条件ごとに 支持・反証・未確認・次の確認」の表を主軸にする（最初は合計点より推奨）。
 * 6項目の加重スコアは比べるための補助。重要な条件への反証が、ほかの高得点に埋もれないようにする
 */
export const CONDITION_KEYS = ['problemStrong', 'targetAndScene', 'reasonToSwitch', 'reachable', 'revenue'] as const
export type ConditionKey = (typeof CONDITION_KEYS)[number]
/** 人の判定。unverified は未確認（需要がないことを意味しない） */
export const CONDITION_STATUSES = ['supported', 'mixed', 'refuted', 'unverified'] as const
export type ConditionStatus = (typeof CONDITION_STATUSES)[number]

export interface ConditionRow {
  /** 支持する証拠（E…） */
  support: string[]
  /** 反証・別の説明の証拠（E…） */
  counter: string[]
  /** 支持の要約 */
  supportNote: string
  /** 反証・別の説明の要約 */
  counterNote: string
  /** 未確認のこと */
  unknown: string
  /** 次の確認（例: 直近の業務を確認、同条件のサンプル比較） */
  next: string
  status: ConditionStatus
}

// ================================================================ 購買が起きる場面・役割・収益のつながり・実行条件

/** 調査の単位「購買が起きる場面」の一文（候補ごとの必須項目） */
export interface PurchaseScene {
  /** どんな企業の */
  company: string
  /** 誰が */
  who: string
  /** 何が起きたときに */
  event: string
  /** どんな成果を必要とし */
  outcome: string
  /** 今はどう対処しているか */
  currentHandling: string
}
export const SCENE_KEYS = ['company', 'who', 'event', 'outcome', 'currentHandling'] as const satisfies ReadonlyArray<keyof PurchaseScene>

/** 担当者の役割（推定した役職と、確認できた決裁権限は別々に持つ） */
export const ROLE_KEYS = ['user', 'champion', 'budgetOwner', 'gatekeeper'] as const
export type RoleKey = (typeof ROLE_KEYS)[number]
export interface RoleEntry {
  /** 推定した役職（例: 営業部長） */
  title: string
  /** 確認できた決裁権限（未確認なら空） */
  confirmedAuthority: string
  evidence: string[]
}

/** 無料から有料へのつながり（集める相手と払う相手をつなげる） */
export const MONETIZATION_SIDES = ['buyer', 'seller', 'both', 'unknown'] as const
export type MonetizationSide = (typeof MONETIZATION_SIDES)[number]
/** 発注の場面（例: 入札準備時＝提案・実行体制のため外部を探す／受注後＝確定案件の実行のため人員・外注先を探す） */
export const ORDER_SCENES = ['beforeOrder', 'afterOrder', 'both', 'unknown'] as const
export type OrderScene = (typeof ORDER_SCENES)[number]
export interface Monetization {
  /** 無料で集める相手は買い手か売り手か両方か */
  side: MonetizationSide
  orderScene: OrderScene
  /** 無料利用 → 業務上の必要 → 発注できる担当者 → 条件の相談 → 有料取引、のつながり（文） */
  freeToPaidPath: string
  /** 評価期間（月） */
  months: Maybe<number>
  /** 有料取引1社の限界利益（円。評価期間の合計） */
  marginPerDeal: Maybe<number>
  /** 無料利用企業1社の獲得・提供・成約前の対応費（円） */
  costPerFreeUser: Maybe<number>
  /** 試算する有料化率（0〜1。例: 0.005, 0.02, 0.05） */
  conversionScenarios: number[]
}

/** 事業を進める段階（「進んだ」の判定） */
export const BUSINESS_STAGES = ['demand', 'firstDeal', 'repeatability', 'unitEconomics', 'operations'] as const
export type BusinessStage = (typeof BUSINESS_STAGES)[number]

/** 実行条件の4点（プロジェクトにした後のビジネスにも引き継ぐ。特に supply＝供給側が抜けやすい） */
export const EXECUTION_KEYS = ['firstDeal', 'supply', 'firstExperiment', 'profitOps'] as const
export type ExecutionKey = (typeof EXECUTION_KEYS)[number]
export interface ExecutionItem {
  /** 決める内容（例: 誰が何をどの条件で発注し、自社は何の対価をいつ受け取るか） */
  plan: string
  /** 確認できたと言える状態になったか（人が付ける） */
  confirmed: boolean
}

/** 次の行動の判断 */
export const NEXT_DECISIONS = ['continue', 'experiment', 'holdOrDrop', 'invest'] as const
export type NextDecision = (typeof NEXT_DECISIONS)[number]

/** 調査の終了条件の6項目（埋まり、残る問いが「使うか・払うか」だけになったら実験へ） */
export const EXIT_KEYS = ['targetCustomer', 'situation', 'currentHandling', 'contactPoint', 'deliverable', 'revenueLink'] as const
export type ExitKey = (typeof EXIT_KEYS)[number]

// ================================================================ 候補

export interface ExistingService {
  name: string
  url: string
  /** 料金（原文のまま。例: 月額 3万円〜） */
  price: string
}

export interface Candidate {
  id: string
  title: string
  /** 市場（業界・業務） */
  market: string
  /** 課題（今すぐ解決したい問題） */
  problem: string
  /** 顧客（誰が払うか。業種・規模・部署） */
  customer: string
  /** 既存サービス・既存の支出先 */
  existingServices: ExistingService[]
  /** AI で代替・提供できる見込み */
  aiFit: string
  /** 購買が起きる場面（必須） */
  scene: PurchaseScene
  /** 成立条件ごとの 支持・反証・未確認・次の確認（評価の主軸） */
  conditions: Record<ConditionKey, ConditionRow>
  /** 担当者の役割 */
  roles: Record<RoleKey, RoleEntry>
  /** 最初に見せる成果物（相手の業務に当てはめた実物サンプル） */
  deliverable: string
  /** 無料から有料へのつながり */
  monetization: Monetization
  /** 実行条件の4点 */
  execution: Record<ExecutionKey, ExecutionItem>
  /** 人が決めた次の行動（null は未決定。機械の目安は nextDecision が出す） */
  decision: Maybe<NextDecision>
  who: WhoResearch
  what: WhatResearch
  where: WhereResearch
  why: WhyResearch
  how: HowResearch
  stage: CandidateStage
  scores: Record<ScoreKey, ScoreEntry>
  gates: Record<GateId, GateDecision>
  /** 除外・保留の理由 */
  dropReason: string
  /** プロジェクトにしたとき（ビジネスのフォルダ） */
  promotedTo: Maybe<{ folder: string; projectId: string; at: string }>
  createdAt: string
  updatedAt: string
}

// ================================================================ 実験

export const EXPERIMENT_METHODS = ['lpAds', 'outreach', 'freeTool', 'preorder', 'limitedSale', 'other'] as const
export type ExperimentMethod = (typeof EXPERIMENT_METHODS)[number]
export const EXPERIMENT_STATUSES = ['planned', 'running', 'done', 'stopped'] as const
export type ResearchExperimentStatus = (typeof EXPERIMENT_STATUSES)[number]

/**
 * 効果の確かめ方。AI が改善案を出しただけでは効果があったとは言えない（A/B テスト・段階的展開などの比較が要る）。
 * 少数のうちは有意差が出ないので、聞き取り（interviews）と組み合わせる
 */
export const COMPARISON_METHODS = ['abTest', 'staged', 'beforeAfter', 'none'] as const
export type ComparisonMethod = (typeof COMPARISON_METHODS)[number]

/**
 * 実測の数（未計測は null）。2つのファンネルが同じ数を使う:
 *   Who の100社実験: targets → reachedBuyer → meetings → problemMatch → purchaseIntent
 *   B2B 直接営業の8段階: targets → contacted → responded → meetings → proposals → contracts → retained → expanded
 */
export const METRIC_KEYS = ['targets', 'contacted', 'reachedBuyer', 'responded', 'meetings', 'problemMatch', 'proposals', 'purchaseIntent', 'contracts', 'retained', 'expanded', 'spend', 'revenue'] as const
export type MetricKey = (typeof METRIC_KEYS)[number]
export type ExperimentMetrics = Record<MetricKey, Maybe<number>>

export const WHO_FUNNEL: readonly MetricKey[] = ['targets', 'reachedBuyer', 'meetings', 'problemMatch', 'purchaseIntent']
export const B2B_FUNNEL: readonly MetricKey[] = ['targets', 'contacted', 'responded', 'meetings', 'proposals', 'contracts', 'retained', 'expanded']

export interface ResearchExperiment {
  id: string
  candidate: string
  /** どの原則を確かめる実験か */
  principle: PrincipleKey
  method: ExperimentMethod
  channel: Maybe<Channel>
  /** 確かめる問い（例: 経理担当は月3万円で申し込むか） */
  hypothesis: string
  /** 合格の条件（事前に決める。文で） */
  passCondition: string
  /** 中止の条件（事前に決める。文で） */
  stopCondition: string
  status: ResearchExperimentStatus
  period: { start: string; end: string }
  metrics: ExperimentMetrics
  comparison: ComparisonMethod
  /** 組み合わせた聞き取りの数 */
  interviews: Maybe<number>
  /** 学び（次の評価に反映する） */
  learning: string
}

// ================================================================ 市場探索の6機能（画面の主な区分・Agent への依頼の段階）

/**
 * 市場探索システムの6機能（docs/business-research/knowledge.md の最後。原文が途中で切れたため前後から補ったもの）。
 * 画面の主な区分と Agent への依頼の段階はこの並び。5原則・ゲートとの対応:
 *   1 who        顧客・企業の発見（Who）            → G1（実験で G3）
 *   2 what       需要・支出・不満の証拠収集（What）  → G2（実験で G4）
 *   3 where      集客経路と購入のきっかけ（Where）   → G3（実験で G5）
 *   4 why        競合・差別化の分析（Why）           → 「プロジェクトにする」の条件（実験で G4）
 *   5 ranking    採点・ランキングと経済性（Ranking＋How） → 比べる順・G5 の見積り
 *   6 experiment 市場実験と学習（Experiment＋Learning） → G4〜G7。合格したものを「プロジェクトにする」
 * 流れ: Discovery（1〜3）→ Evidence（2・4）→ Ranking（5）→ Experiment（6）→ Learning（6 の結果を 5 の採点へ戻す）
 */
export const RESEARCH_SECTIONS = ['who', 'what', 'where', 'why', 'ranking', 'experiment'] as const
export type ResearchSection = (typeof RESEARCH_SECTIONS)[number]
export const SECTION_PRINCIPLES: Record<ResearchSection, readonly PrincipleKey[]> = {
  who: ['who'],
  what: ['what'],
  where: ['where'],
  why: ['why'],
  ranking: ['how'],
  experiment: ['who', 'what', 'where', 'why', 'how']
}
export const SECTION_GATES: Record<ResearchSection, readonly GateId[]> = {
  who: ['G1'],
  what: ['G2'],
  where: ['G3'],
  why: [],
  ranking: ['G5'],
  experiment: ['G4', 'G5', 'G6', 'G7']
}

// ================================================================ research.yaml

export interface ResearchFile {
  name: string
  /** 対象範囲（例: 日本の B2B。既存ソフトウェア・データサービス・デジタル BPO への支出） */
  scope: string
  weights: Record<ScoreKey, number>
  cutoffs: Record<ScoreKey, Maybe<number>>
  funnelTargets: Record<FunnelStage, number>
  /** G1 の目安（特定できた対象企業の数） */
  minTargetCount: number
  createdAt: string
}

/** 記録の種類。ID の頭文字と置き場所 */
export const RESEARCH_RECORD_KINDS = {
  candidate: { prefix: 'C', dir: 'candidates' },
  evidence: { prefix: 'E', dir: 'evidence' },
  experiment: { prefix: 'X', dir: 'experiments' }
} as const
export type ResearchRecordKind = keyof typeof RESEARCH_RECORD_KINDS
export const RESEARCH_RECORD_KIND_LIST = Object.keys(RESEARCH_RECORD_KINDS) as ResearchRecordKind[]

export interface ResearchRecordTypes {
  candidate: Candidate
  evidence: ResearchEvidence
  experiment: ResearchExperiment
}

export const RESEARCH_FILE = 'research.yaml'
export const RESEARCH_META_DIR = '.research'
export const RESEARCH_CONTEXT_FILE = '.research/context.md'
export const RESEARCH_README_FILE = '.research/README.md'
/** 参入先の結論（Agent が書き、決め切るまで更新し続ける。リサーチの最終の成果物） */
export const RESEARCH_CONCLUSION_FILE = 'conclusion.md'
export const RESEARCH_SENT_DIR = '.research/sent'
export const RESEARCH_TRASH_DIR = '.research/trash'
/** 集客の5原則のナレッジの写し（正本は docs/business-research/knowledge.md。Agent が読む） */
export const RESEARCH_KNOWLEDGE_FILE = 'principles/knowledge.md'

/** リサーチ1件の全体（読み込んだもの） */
export interface ResearchData {
  root: string
  research: ResearchFile
  candidates: Candidate[]
  evidence: ResearchEvidence[]
  experiments: ResearchExperiment[]
  /** 読めなかったファイル（壊れた YAML など）。画面に出し、黙って捨てない */
  problems: Array<{ path: string; message: string }>
}

/** ID の形（C001、E012、X03 など。数字は 2〜4 桁） */
export function researchIdPattern(kind: ResearchRecordKind): RegExp {
  return new RegExp(`^${RESEARCH_RECORD_KINDS[kind].prefix}\\d{2,4}$`)
}

export function isResearchId(kind: ResearchRecordKind, id: unknown): id is string {
  return typeof id === 'string' && researchIdPattern(kind).test(id)
}

/** 次の ID（既存の最大 + 1。3 桁で揃え、1000 以上は桁を増やす。9999 が上限） */
export function nextResearchId(kind: ResearchRecordKind, existing: readonly string[]): string {
  const prefix = RESEARCH_RECORD_KINDS[kind].prefix
  let max = 0
  for (const id of existing) {
    const m = new RegExp(`^${prefix}(\\d{2,4})$`).exec(id)
    if (m) max = Math.max(max, Number(m[1]))
  }
  const n = max + 1
  if (n > 9999) throw new Error(`ID reached the limit (${prefix}9999)`)
  return `${prefix}${String(n).padStart(3, '0')}`
}
