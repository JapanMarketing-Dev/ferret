import type { AccountAgent } from './types'
import { TUI_AGENT_LABEL } from './agentCatalog'
import { t } from './i18n'

/**
 * Claude Code / Codex のアカウント切り替え（main / renderer が共有する型）。
 *
 * Orca由来: ~/bench/orca/src/shared/managed-account-types.ts（MIT, Copyright 2026 Lovecast Inc.）
 * Orca の CodexManagedAccount / ClaudeManagedAccount を1つの形にまとめた。
 * WSL・リモート実行・組織情報は扱わないので持ち込んでいない。
 *
 * アカウントごとに専用の設定フォルダ（Codex は CODEX_HOME、Claude は CLAUDE_CONFIG_DIR）を持ち、
 * 置き場所は app.getPath('userData')/accounts/<agent>/<id>/ に固定する。
 * パスは保存せず id から毎回決める（設定ファイルを書き換えて任意のフォルダを指させないため）。
 */

/** 保存する1アカウント分 */
export interface AgentAccount {
  id: string
  /** 利用者が付けた名前。空ならメールアドレスを表示に使う */
  label: string
  /** ログイン後に設定フォルダから読み取ったメールアドレス。未ログインなら null */
  email: string | null
  /** プラン・ワークスペース名（Codex の Personal (Plus) や Claude の組織名など） */
  workspaceLabel: string | null
  createdAt: number
  updatedAt: number
  /** ログインが済んだことを最後に確かめた時刻。追加直後（ログイン待ち）は null */
  lastAuthenticatedAt: number | null
}

/**
 * Agent ごとの一覧と選択。activeAccountId が null なら「いつものログイン」（~/.claude・~/.codex のアカウント）。
 * 画面では「システムの既定」という別枠にせず、ログインしているアカウント（メール）の1行として並べて選ばせる（2026-11-13）。
 * 保存値の null はそのまま「いつものログイン」の行を指すので、前の版で「システムの既定」を選んでいた人もそのまま同じアカウントを使う
 */
export interface AgentAccountList {
  accounts: AgentAccount[]
  activeAccountId: string | null
}

export type AgentAccountsSettings = Record<AccountAgent, AgentAccountList>

export const EMPTY_AGENT_ACCOUNTS: AgentAccountsSettings = {
  claude: { accounts: [], activeAccountId: null },
  codex: { accounts: [], activeAccountId: null }
}

/** 画面に出す1アカウント分。ログイン状態は設定フォルダを見て毎回決める */
export interface AgentAccountSummary extends AgentAccount {
  /** 認証情報が設定フォルダにある */
  signedIn: boolean
  /** 設定フォルダが見つからない・本システムの物でないなど、使えない理由 */
  problem: string | null
}

/**
 * システムの既定アカウント（~/.claude・~/.codex）の読み取り結果。
 * Orca の CodexSystemDefaultIdentity と同じく、表示のために読むだけで書き換えない。
 */
interface SystemDefaultAccount {
  signedIn: boolean
  email: string | null
  /** プラン・ワークスペース名。読めなければ null（古い main からは来ないので省略可） */
  workspaceLabel?: string | null
}

export interface AgentAccountsView {
  accounts: AgentAccountSummary[]
  activeAccountId: string | null
  systemDefault: SystemDefaultAccount
  /** この読み込みで、すでにあるログインと同じだったので外したアカウント（表示名）。画面で知らせる */
  removedDuplicates?: string[]
}

export type AgentAccountsState = Record<AccountAgent, AgentAccountsView>

/** 追加の結果。続けて内蔵ターミナルでログインを始めるための情報を添える */
export interface AgentAccountAddResult {
  state: AgentAccountsState
  login: AccountLoginRequest
}

/** 内蔵ターミナルでアカウントのログインを始める指定 */
export interface AccountLoginRequest {
  agent: AccountAgent
  accountId: string
}

function loginKey(email: string | null | undefined, workspaceLabel: string | null | undefined): string | null {
  return email ? `${email.trim().toLowerCase()}|${(workspaceLabel ?? '').trim().toLowerCase()}` : null
}

/**
 * 外すアカウント（同じログインを2つ以上登録しない）。ログインが済んでメールが分かるものだけを比べる。
 *
 * 外してよいのは、今回の読み込みで初めてログインが済んだ（追加したばかりの）アカウントだけ（fresh）。
 * 前から使っているアカウントは、あとから同じログインのものが増えても、選択中でなくても、決して外さない
 * （外すと設定フォルダごと会話の履歴・ログインが消える。2026-10-10、10/7 から使っていたアカウントが、
 * 同じログインを追加して選択中にした直後に消えた）。
 * 追加したばかりのものは、同じログインが前からある・システムの既定と同じ（切り替えても使える量は増えない）なら外す。
 * 追加したばかりのものどうしが重なったときは、選択中のもの → 無ければ先に追加したものを残す
 */
export function duplicateAccountIds(
  accounts: ReadonlyArray<Pick<AgentAccount, 'id' | 'email' | 'workspaceLabel' | 'createdAt'> & { signedIn: boolean; fresh: boolean }>,
  activeAccountId: string | null,
  systemDefault: { signedIn: boolean; email: string | null; workspaceLabel: string | null } | null
): string[] {
  const systemKey = systemDefault?.signedIn ? loginKey(systemDefault.email, systemDefault.workspaceLabel) : null
  const groups = new Map<string, typeof accounts[number][]>()
  for (const account of accounts) {
    const key = account.signedIn ? loginKey(account.email, account.workspaceLabel) : null
    if (!key) continue
    groups.set(key, [...(groups.get(key) ?? []), account])
  }
  const drop: string[] = []
  for (const [key, members] of groups) {
    const fresh = members.filter((m) => m.fresh)
    if (fresh.length === 0) continue
    const alreadyKnown = members.some((m) => !m.fresh) || key === systemKey
    const keeper = alreadyKnown ? null : (fresh.find((m) => m.id === activeAccountId) ?? [...fresh].sort((a, b) => a.createdAt - b.createdAt)[0])
    for (const m of fresh) if (m !== keeper) drop.push(m.id)
  }
  return drop
}

/**
 * 一覧に出す行。同じログイン（メールと組織が同じ）が重なれば1行にする。
 * 同じアカウントを2回追加した・システムの既定も同じログイン、のときに同じ行が並ばないように（足元のアカウントの内訳）。
 * 残すのは選択中の行。選択中が無ければ先の行（システムの既定 → 先に追加したもの）。メールが分からない行はまとめない
 */
export function dedupeAccountRows<T extends { accountId: string | null; email: string | null; workspaceLabel: string | null }>(rows: readonly T[], activeAccountId: string | null): T[] {
  const keyOf = (row: T) => loginKey(row.email, row.workspaceLabel)
  const keep = new Map<string, T>()
  for (const row of rows) {
    const key = keyOf(row)
    if (!key) continue
    const kept = keep.get(key)
    if (!kept || (row.accountId === activeAccountId && kept.accountId !== activeAccountId)) keep.set(key, row)
  }
  return rows.filter((row) => {
    const key = keyOf(row)
    return !key || keep.get(key) === row
  })
}

/** 表示名。名前 → メール → 「ログイン待ち」の順 */
export function accountDisplayName(account: Pick<AgentAccount, 'label' | 'email'>): string {
  return account.label.trim() || account.email || t('accounts.pendingLabel')
}

/**
 * いつものログイン（~/.claude・~/.codex。保存値の null）の表示名。ログインしているアカウントのメール →
 * 分からなければ「いつもの Claude Code のログイン」。「システムの既定」という名前は出さない
 */
export function defaultLoginLabel(agent: AccountAgent, identity: { signedIn: boolean; email: string | null } | null | undefined): string {
  const email = identity?.signedIn ? identity.email?.trim() : null
  return email || t('accounts.defaultLogin', { agent: TUI_AGENT_LABEL[agent] })
}
