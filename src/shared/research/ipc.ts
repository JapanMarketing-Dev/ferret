/**
 * ビジネスリサーチの IPC（research:*）。src/shared/ipc.ts の IpcRequests / IpcEvents に足す。
 * フォルダは main が決める（開いているリサーチのプロジェクトだけ）。renderer からパスは受け取らない
 */
import type { BusinessSendTarget } from '../business/ipc'
import type { ResearchData, ResearchFile, ResearchRecordKind, ResearchRecordTypes } from './model'

/** 保存の検査の結果の1件。error は保存しない、warning は保存して画面に出す */
export interface ResearchIssue {
  level: 'error' | 'warning'
  /** 欄の名前（例: url、scores.reach.evidence） */
  field: string
  /** i18n のキー（research.issue.*）と差し込む値 */
  code: string
  params?: Record<string, string | number>
}

export interface ResearchStatus {
  /** 開いているプロジェクトのフォルダ（SSH・未選択なら null） */
  root: string | null
  /** research.yaml があるか */
  isResearch: boolean
  name: string | null
}

export interface ResearchSnapshot {
  data: ResearchData
}

export type ResearchSaveResult = { ok: true; snapshot: ResearchSnapshot; issues: ResearchIssue[] } | { ok: false; issues: ResearchIssue[] }

/**
 * Agent に頼む依頼（段階ごと）。discover は候補そのものを既存の支出から出す入口、
 * そのあとは市場探索の6機能（model.ts の RESEARCH_SECTIONS）に対応する。6 は実験の設計（experiment）と学び（learning）の2つ。
 * evaluate は証拠の評価（読む5観点・成立条件の表）。収集（who〜why）と評価は別の工程・別の依頼にする
 */
export const RESEARCH_PROMPT_IDS = ['discover', 'who', 'what', 'where', 'why', 'evaluate', 'ranking', 'experiment', 'learning'] as const
export type ResearchPromptId = (typeof RESEARCH_PROMPT_IDS)[number]

export interface ResearchPromptView {
  id: ResearchPromptId
  /** 対象の候補（discover・learning は null のこともある） */
  candidateId: string | null
  /** 穴を埋めた全文（画面の言語で） */
  text: string
}

export interface ResearchSendRequest {
  promptId: ResearchPromptId
  candidateId: string | null
  /** 画面で直したあとの本文 */
  text: string
  target: BusinessSendTarget
  /** research:armSend でもらった札 */
  ticket: string
}

/** 「プロジェクトにする」の入力 */
export interface PromoteRequest {
  candidateId: string
  /** 入れるオーケストラ（editorWorkspace のプロジェクトの id）。null は先頭のオーケストラ */
  orchestraId: string | null
  /** 新しいフォルダの名前（親は main がダイアログで選ばせる）。空なら候補の題名から作る */
  folderName: string
}

export interface PromoteResult {
  snapshot: ResearchSnapshot
  /** 登録したプロジェクトの id とフォルダ */
  projectId: string
  folder: string
}

export interface ResearchIpcRequests {
  'research:status': () => ResearchStatus
  /** リサーチ用のフォルダを選んで登録する（research.yaml が無ければひな型を書く）。選ばなければ null */
  'research:addProject': () => { projectId: string } | null
  /** 開いているフォルダをリサーチにする（ひな型を書く。既にあれば何もしない） */
  'research:init': (input: { name: string; scope: string }) => ResearchSnapshot
  'research:load': () => ResearchSnapshot
  /** 記録を1件保存する。error の検査が1つでもあれば保存しない。body（*.md の本文）が null なら既存の本文を保つ（新しい記録は空） */
  'research:saveRecord': <K extends ResearchRecordKind>(kind: K, record: ResearchRecordTypes[K], body: string | null) => ResearchSaveResult
  /** 記録を消す（.research/trash/ へ移す。戻せる） */
  'research:deleteRecord': (kind: ResearchRecordKind, id: string) => ResearchSnapshot
  /** research.yaml の名前・対象範囲・重み・足切り・ファンネルの目安を変える */
  'research:updateResearch': (patch: Partial<Pick<ResearchFile, 'name' | 'scope' | 'weights' | 'cutoffs' | 'funnelTargets' | 'minTargetCount'>>) => ResearchSnapshot
  /** ゲートを人が確定する（前のゲートが pass でなければ pass にできない） */
  'research:decideGate': (input: { candidateId: string; gate: string; status: 'pass' | 'fail' | 'pending'; note: string }) => ResearchSnapshot
  /** 候補の段階を変える（人が押したときだけ。dropped は理由が要る） */
  'research:setStage': (input: { candidateId: string; stage: string; reason: string }) => ResearchSnapshot
  /** 依頼の全文 */
  'research:prompt': (input: { promptId: ResearchPromptId; candidateId: string | null }) => ResearchPromptView
  /** 送るボタンを押した直後に呼び、その依頼・本文（sha256）・送り先にだけ使える1回きりの札（60秒）をもらう */
  'research:armSend': (input: { promptId: ResearchPromptId; textHash: string; target: BusinessSendTarget }) => { ticket: string }
  /** context.md を書き直して、Agent へ送る。送れたときだけ .research/sent/ に残す */
  'research:send': (request: ResearchSendRequest) => { ok: boolean; message: string }
  /** 候補から、ビジネスのフォルダを作ってプロジェクトとして登録し、オーケストラに入れる。G1〜G3 が pass のときだけ */
  'research:promote': (request: PromoteRequest) => PromoteResult | null
}

export const RESEARCH_IPC_CHANNELS = [
  'research:status',
  'research:addProject',
  'research:init',
  'research:load',
  'research:saveRecord',
  'research:deleteRecord',
  'research:updateResearch',
  'research:decideGate',
  'research:setStage',
  'research:prompt',
  'research:armSend',
  'research:send',
  'research:promote'
] as const satisfies ReadonlyArray<keyof ResearchIpcRequests>

export interface ResearchIpcEvents {
  /** リサーチのフォルダの中身が変わった（Agent が書いた・人が保存した） */
  'research:changed': () => void
}

export const RESEARCH_IPC_EVENTS = ['research:changed'] as const satisfies ReadonlyArray<keyof ResearchIpcEvents>
