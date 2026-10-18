/**
 * ビジネス（venture:*）の IPC。src/shared/ipc.ts の IpcRequests / IpcEvents に足す（docs/venture.md）。
 * フォルダは main が決める（開いているプロジェクトがビジネスのときだけ。SSH は除く）。renderer からパスは受け取らない。
 * 人の判断（承認・却下・予算の上限・運営の段階）は main がファイルを読み直し、ネイティブのダイアログで確かめてから台帳に書く
 */
import type { ProjectsState } from '../types'
import type {
  ApprovalKind,
  ApprovalView,
  Channel,
  GuardrailsFile,
  ImportIssue,
  MemberRole,
  OperationsDecision,
  PeriodPreset,
  SourceKind,
  Stream,
  StreamRecords,
  VentureConfig,
  VentureSummary
} from './model'

/** Agent の送り先（ビジネス担当の BusinessSendTarget と同じ形） */
export type VentureSendTarget = { kind: 'active' } | { kind: 'terminal'; id: string } | { kind: 'new'; agent: 'claude' | 'codex' }

export interface VentureListItem {
  /** オーケストラのプロジェクトの id */
  projectId: string
  name: string
  folder: string
}

export interface VentureStatus {
  /** 開いているプロジェクトのフォルダ（SSH・未選択なら null） */
  root: string | null
  projectId: string | null
  /** venture.json があるか */
  isVenture: boolean
  /** 開いているのがオーケストラか（ビジネスにできるか） */
  isOrchestra: boolean
}

export interface MemberView {
  role: MemberRole
  folder: string
  projectId: string | null
  /** 登録したプロジェクトの名前（無ければフォルダの名前） */
  name: string
  /** フォルダがある */
  exists: boolean
  /** Ferret に登録済みで、このビジネス（オーケストラ）に属している */
  inOrchestra: boolean
}

export interface ImportFileView {
  /** フォルダからの相対パス（data/imports/... か data/agent/...） */
  path: string
  source: SourceKind
  rows: number
  issues: number
}

export interface VentureSnapshot {
  root: string
  projectId: string
  config: VentureConfig
  members: MemberView[]
  guardrails: GuardrailsFile
  approvals: ApprovalView[]
  streams: StreamRecords
  /** 動画チャンネルのメンバーの中の動画の数（分からなければ null） */
  videoCount: number | null
  data: {
    files: ImportFileView[]
    /** 取り込みの問題（多いときは先頭から MAX_SNAPSHOT_ISSUES 件） */
    issues: ImportIssue[]
    issueCount: number
    rowCount: number
    /** データのある日の範囲 */
    range: { from: string; to: string } | null
  }
  summary: VentureSummary
  /** 読めなかった記録（壊れた JSON・形の違うもの）。ファイルは書き換えない */
  recordIssues: Array<{ file: string; message: string }>
}

export const MAX_SNAPSHOT_ISSUES = 200

/** 依頼の id（`<業務>.<段階>`、全体は `venture.<段階>`）。一覧の正本は prompts.ts の VENTURE_PROMPTS */
export type VenturePromptId = string

export interface VenturePromptView {
  id: VenturePromptId
  /** 穴を埋めた全文（画面の言語で。守ること（ガードレール）は main が必ず付ける） */
  text: string
}

export interface VentureSendRequest {
  promptId: VenturePromptId
  text: string
  target: VentureSendTarget
  /** venture:armSend でもらった札 */
  ticket: string
}

export interface ImportOutcome {
  snapshot: VentureSnapshot
  /** 置いたファイル（フォルダからの相対パス） */
  path: string
  rows: number
  issues: ImportIssue[]
}

export interface VentureIpcRequests {
  'venture:list': () => VentureListItem[]
  'venture:status': () => VentureStatus
  /** 新しいビジネスを作る（親のフォルダをダイアログで選び、<親>/<名前> に作ってオーケストラとして開く）。やめたら null */
  'venture:create': (input: { name: string }) => ProjectsState | null
  /** 開いているオーケストラをビジネスにする（venture.json などの雛形を書く） */
  'venture:convert': () => VentureSnapshot
  'venture:load': (input: { period: PeriodPreset }) => VentureSnapshot
  /** メンバーを足す。projectId を渡せば登録済みのプロジェクト、無ければフォルダをダイアログで選ぶ。やめたら null */
  'venture:addMember': (input: { role: MemberRole; projectId?: string }) => VentureSnapshot | null
  'venture:removeMember': (input: { role: MemberRole; folder: string }) => VentureSnapshot
  /** 元データのファイルを選んで data/imports/<source>/ に写す。やめたら null */
  'venture:importFile': (input: { source: SourceKind }) => ImportOutcome | null
  /** 人が承認の依頼を作る（予算の変更・返信など）。中身は approvals/requests.json に足す */
  'venture:requestApproval': (input: { kind: ApprovalKind; title: string; detail: string; refs: string[] }) => VentureSnapshot
  /** 承認・却下。main がファイルを読み直し、ネイティブのダイアログで確かめてから台帳に書く。やめたら null */
  'venture:decide': (input: { approvalId: string; decision: 'approve' | 'reject'; answer: string }) => VentureSnapshot | null
  /** 予算の上限を決める（ダイアログで確かめてから台帳と guardrails.json に書く）。やめたら null */
  'venture:setBudget': (input: { channel: Channel | '*'; daily: number | null; monthly: number | null }) => VentureSnapshot | null
  /** guardrails.json の案（Agent が書いた値）をそのまま承認する。やめたら null */
  'venture:approveBudgets': () => VentureSnapshot | null
  /** 運営の段階の人の判断（ダイアログで確かめる）。やめたら null */
  'venture:decideOperations': (input: { decision: OperationsDecision }) => VentureSnapshot | null
  'venture:prompt': (input: { promptId: VenturePromptId }) => VenturePromptView
  'venture:armSend': (input: { promptId: VenturePromptId; textHash: string; target: VentureSendTarget }) => { ticket: string }
  'venture:send': (request: VentureSendRequest) => { ok: boolean; message: string }
}

export interface VentureIpcEvents {
  /** ビジネスのフォルダの記録・台帳が変わった */
  'venture:changed': () => void
}

export const VENTURE_IPC_CHANNELS = [
  'venture:list', 'venture:status', 'venture:create', 'venture:convert', 'venture:load', 'venture:addMember', 'venture:removeMember',
  'venture:importFile', 'venture:requestApproval', 'venture:decide', 'venture:setBudget', 'venture:approveBudgets', 'venture:decideOperations',
  'venture:prompt', 'venture:armSend', 'venture:send'
] as const satisfies ReadonlyArray<keyof VentureIpcRequests>

export const VENTURE_IPC_EVENTS = ['venture:changed'] as const satisfies ReadonlyArray<keyof VentureIpcEvents>

/** 業務の画面で扱う業務（video はメンバーへのリンク） */
export type { Stream }
