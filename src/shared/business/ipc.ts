/**
 * ビジネスの IPC（renderer → main）。src/shared/ipc.ts の IpcRequests がこれを継承し、チャネルの一覧に足す。
 * ビジネスのフォルダは「開いているプロジェクトのフォルダ」だけ。renderer からパスは受け取らない。
 */
import type { BusinessData, BusinessFile, ChangeAxis, ExecutionItem, ExecutionKey, RecordKind, RecordTypes, SearchLog, SentPrompt, Stage, StepId } from './model'
import type { Issue } from './rules'
import type { StepSummary } from './steps'

export interface BusinessStatus {
  /** 開いているプロジェクトのフォルダ。無ければ null */
  root: string | null
  /** business.yaml があるか */
  isBusiness: boolean
  name: string | null
}

export interface BusinessSnapshot {
  data: BusinessData
  /** 記録の本文（ID → Markdown の本文） */
  bodies: Record<string, string>
  issues: Issue[]
  summary: StepSummary
  /** ビジネスごとに上書きしたプロンプトの ID */
  overriddenPrompts: string[]
}

export interface BusinessListItem {
  projectId: string
  name: string
  step: StepId
  loop: number
  stage: Stage | null
  pendingApprovals: number
}

export type SaveResult = { ok: true; snapshot: BusinessSnapshot; issues: Issue[] } | { ok: false; issues: Issue[] }

/** 送り先。active は開いているプロジェクトの Agent（Ferret の「Agent へ送信」と同じ選び方） */
export type BusinessSendTarget = { kind: 'active' } | { kind: 'terminal'; id: string } | { kind: 'new'; agent: 'claude' | 'codex' }

export interface BusinessSendRequest {
  promptId: string
  /** 送る前の全文（人が直したもの）。空は断る */
  text: string
  target: BusinessSendTarget
  /** business:armSend で受け取った札（送るボタンを押した直後に、プロンプト・本文の sha256・送り先に結び付けて作る） */
  ticket?: string
}

/** 実験ページ（Cloudflare Worker）の接続の設定。トークンは画面へ返さない */
export interface PageConfig {
  endpoint: string
  hasToken: boolean
}

/** 実験ページの中身（Worker の構造化された中身と同じ形。HTML は送らない） */
export interface PageContent {
  headline: string
  subhead: string
  bullets: string[]
  priceText: string
  ctaLabel: string
  formIntro: string
  consentText: string
  footerNote: string
}

export interface PageStats {
  slug: string
  experimentId: string
  from: string
  to: string
  views: number
  uniqueVisitors: number
  ctaClicks: number
  interests: number
}

/** プロンプト。text は穴を埋めた送る全文、body は穴の残ったひな型の本文（上書きがあればそれ） */
export interface PromptView {
  text: string
  body: string
  missing: string[]
  overridden: boolean
}

/** 実験ページに最後に送った中身（.business/pages/<実験ID>.json） */
export interface SavedPage {
  slug: string
  title: string
  content: PageContent
  pushedAt: string
}

export interface BusinessIpcRequests {
  'business:status': () => BusinessStatus
  /** 登録したプロジェクトのうち、ビジネスのもの（サイドバーとダッシュボードの一覧） */
  'business:list': () => BusinessListItem[]
  /** 開いているプロジェクトのフォルダをビジネスにする（ひな型を書く。既にあれば何もしない） */
  'business:init': (input: { name: string; target: string }) => BusinessSnapshot
  'business:load': () => BusinessSnapshot
  /** 記録を1件保存する。error の検査が1つでもあれば保存しない。段階（stage）は保存では変えない */
  'business:saveRecord': <K extends RecordKind>(kind: K, record: RecordTypes[K], body: string) => SaveResult
  /** 記録を消す（.business/trash/ へ移す。戻せる） */
  'business:deleteRecord': (kind: RecordKind, id: string) => BusinessSnapshot
  'business:updateBusiness': (patch: Partial<Pick<BusinessFile, 'name' | 'target' | 'limits' | 'currentHypothesis' | 'step'>> & { execution?: Partial<Record<ExecutionKey, Partial<ExecutionItem>>> }) => BusinessSnapshot
  /** 段階を進める（戻す）。人が押したときだけ。隣の段階へだけ動かせる */
  'business:advanceStage': (hypothesisId: string, to: Stage, note: string) => BusinessSnapshot
  /** 周を閉じる。変えるもの1つと戻るステップを決めて、次の周へ */
  'business:closeLoop': (input: { changed: ChangeAxis; backTo: StepId; note: string }) => BusinessSnapshot
  /** プロンプトの全文（穴を埋めたもの） */
  'business:prompt': (promptId: string) => PromptView
  /** ビジネスごとの上書き。null で既定へ戻す */
  'business:savePromptOverride': (promptId: string, body: string | null) => PromptView
  /** context.md を書き直して、Agent へ送る。送った履歴を .business/sent/ に残す */
  'business:send': (request: BusinessSendRequest) => { ok: boolean; message: string }
  /** 送るボタンを押した直後（約1秒以内）に呼び、そのプロンプト・本文（sha256）・送り先にだけ使える1回きりの札（60秒）をもらう */
  'business:armSend': (input: { promptId: string; textHash: string; target: BusinessSendTarget }) => { ticket: string }
  'business:sentHistory': () => SentPrompt[]
  /** 人の判断（承認・却下）。承認は main がネイティブの確認を出し、人が押したときだけ。Agent からは呼べない（画面だけ） */
  'business:decideApproval': (id: string, status: '承認' | '却下', answer: string) => BusinessSnapshot
  'business:addSearch': (search: Omit<SearchLog, 'at'>) => BusinessSnapshot
  /** 内蔵ブラウザで見ているページを証拠の下書きにする（URL・タイトル・選んだ文・画面の写し） */
  'business:captureEvidence': (input: { hypothesisId: string | null }) => { snapshot: BusinessSnapshot; id: string }
  'business:pageConfig': () => PageConfig
  /** 接続先とトークンを保存する（トークンは OS の鍵の保管庫で暗号化。空文字のトークンは変えない。接続先の origin が変われば消す） */
  'business:setPageConfig': (input: { endpoint: string; token: string }) => PageConfig
  /** 実験ページの下書きを Worker に送る。公開は、その実験の「実験ページの公開」が承認済みのときだけ */
  'business:pushPage': (input: { experimentId: string; slug: string; title: string; content: PageContent; publish: boolean }) => BusinessSnapshot
  'business:unpublishPage': (experimentId: string) => BusinessSnapshot
  'business:pageStats': (experimentId: string) => PageStats
  /** 最後に送った実験ページの中身（無ければ null） */
  'business:pageContent': (experimentId: string) => SavedPage | null
  /** 数を実験の実測へ入れる（関心表明・接触）。実施中・完了の実験だけ */
  'business:applyPageStats': (experimentId: string) => BusinessSnapshot
}

export const BUSINESS_IPC_CHANNELS = [
  'business:status',
  'business:list',
  'business:init',
  'business:load',
  'business:saveRecord',
  'business:deleteRecord',
  'business:updateBusiness',
  'business:advanceStage',
  'business:closeLoop',
  'business:prompt',
  'business:savePromptOverride',
  'business:send',
  'business:armSend',
  'business:sentHistory',
  'business:decideApproval',
  'business:addSearch',
  'business:captureEvidence',
  'business:pageConfig',
  'business:setPageConfig',
  'business:pushPage',
  'business:unpublishPage',
  'business:pageStats',
  'business:pageContent',
  'business:applyPageStats'
] as const satisfies ReadonlyArray<keyof BusinessIpcRequests>

export interface BusinessIpcEvents {
  /** ビジネスのフォルダの中身が変わった（Agent が書いた・人が保存した） */
  'business:changed': () => void
}

export const BUSINESS_IPC_EVENTS = ['business:changed'] as const satisfies ReadonlyArray<keyof BusinessIpcEvents>
