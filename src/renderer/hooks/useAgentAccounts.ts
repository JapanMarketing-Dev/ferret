import { useCallback, useEffect, useRef, useState } from 'react'
import type { AgentAccountsState } from '@shared/accounts'
import type { AccountAgent } from '@shared/types'
import { errorMessage } from '../lib/errors'
import { t } from '@shared/i18n'
import { onAccountsStateChanged, publishAccountsState, requestAccountLogin } from '../lib/accountLogin'

/**
 * アカウント一覧の読み込みと操作（フッターの切り替えと設定のアカウント欄で共有）。
 *
 * Orca由来: ~/bench/orca/src/renderer/src/components/status-bar/ClaudeSwitcherMenu.tsx（loadAccounts / handleSelectAccount）,
 *           ~/bench/orca/src/renderer/src/components/settings/accounts-pane-account-actions.ts（MIT, Copyright 2026 Lovecast Inc.）
 *
 * ログインは内蔵ターミナルで進むので、ログインを始めて（追加・ログインし直し）から LOGIN_POLL_WINDOW_MS の間だけ、
 * 「ログイン待ち」の行がある間は数秒おきに読み直し、終わったら一覧へ反映する（Orca は裏の子プロセスの終了を待つ）。
 * ログインを始めずに残っている「ログイン待ち」の行のために読み直し続けない（以前はずっと3秒ごとに読んでいた）。
 * それ以外はウインドウを前に出したときに読み直す。
 */

/** ログイン待ちの行があるときの読み直し間隔 */
const PENDING_POLL_MS = 3000
/** ログインを始めてから読み直し続ける長さ */
export const LOGIN_POLL_WINDOW_MS = 5 * 60_000
/** 最後にログインを始めた時刻（フッターと設定で同じフックを使うので、部品の外に持つ） */
let loginStartedAt = 0

/** いまから読み直しを続ける長さ（0 なら読み直さない） */
export function loginPollRemaining(now: number, startedAt: number, hasPending: boolean): number {
  if (!hasPending) return 0
  return Math.max(0, startedAt + LOGIN_POLL_WINDOW_MS - now)
}

export type AccountAction = 'idle' | `add:${AccountAgent}` | `select:${string}` | `remove:${string}` | `rename:${string}` | `relogin:${string}`

export function useAgentAccounts(): {
  state: AgentAccountsState | null
  action: AccountAction
  error: string | null
  /** 直前の切り替えで「動いている Agent には効かない」ことを知らせる Agent */
  switched: AccountAgent | null
  reload: () => Promise<void>
  add: (agent: AccountAgent) => Promise<void>
  select: (agent: AccountAgent, accountId: string | null) => Promise<void>
  rename: (agent: AccountAgent, accountId: string, label: string) => Promise<void>
  remove: (agent: AccountAgent, accountId: string) => Promise<void>
  relogin: (agent: AccountAgent, accountId: string) => Promise<void>
} {
  const [state, setState] = useState<AgentAccountsState | null>(null)
  const [action, setAction] = useState<AccountAction>('idle')
  const [error, setError] = useState<string | null>(null)
  const [switched, setSwitched] = useState<AccountAgent | null>(null)
  /** ログインを始めたら増やす（読み直しの見張りを始め直す） */
  const [loginSeq, setLoginSeq] = useState(0)
  const mountedRef = useRef(true)
  const startLoginPolling = useCallback(() => {
    loginStartedAt = Date.now()
    if (mountedRef.current) setLoginSeq((n) => n + 1)
  }, [])

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  const apply = useCallback((next: AgentAccountsState) => {
    if (mountedRef.current) setState(next)
    publishAccountsState(next)
    // 追加したアカウントが、すでにあるログインと同じだったので main が外した
    const removed = (['claude', 'codex'] as const).flatMap((agent) => next[agent].removedDuplicates ?? [])
    if (removed.length && mountedRef.current) setError(t('accounts.duplicateRemoved', { names: removed.join(', ') }))
  }, [])

  const reload = useCallback(async () => {
    try {
      apply(await window.ade.invoke('accounts:list'))
    } catch (err) {
      if (mountedRef.current) setError(errorMessage(err))
    }
  }, [apply])

  // ほかの部品での変更（フッターで切り替えた等）を受け取る
  useEffect(() => onAccountsStateChanged((next) => mountedRef.current && setState(next)), [])

  useEffect(() => {
    void reload()
  }, [reload])

  // ターミナルから戻ってきたときに読み直す（ログインはアプリの外のブラウザで済ませることが多い）
  useEffect(() => {
    const onFocus = () => void reload()
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [reload])

  const hasPending = !!state && (['claude', 'codex'] as const).some((agent) => state[agent].accounts.some((a) => a.lastAuthenticatedAt === null))
  useEffect(() => {
    const remaining = loginPollRemaining(Date.now(), loginStartedAt, hasPending)
    if (remaining <= 0) return
    const timer = setInterval(() => void reload(), PENDING_POLL_MS)
    const stop = setTimeout(() => clearInterval(timer), remaining)
    return () => { clearInterval(timer); clearTimeout(stop) }
  }, [hasPending, loginSeq, reload])

  const run = useCallback(
    async (key: AccountAction, task: () => Promise<void>) => {
      setAction(key)
      setError(null)
      try {
        await task()
      } catch (err) {
        if (mountedRef.current) setError(errorMessage(err))
      } finally {
        if (mountedRef.current) setAction('idle')
      }
    },
    []
  )

  const add = useCallback(
    (agent: AccountAgent) =>
      run(`add:${agent}`, async () => {
        const result = await window.ade.invoke('accounts:add', agent)
        apply(result.state)
        requestAccountLogin(result.login)
        startLoginPolling()
      }),
    [run, apply, startLoginPolling]
  )

  const select = useCallback(
    (agent: AccountAgent, accountId: string | null) =>
      run(`select:${accountId ?? `system-${agent}`}`, async () => {
        const before = state?.[agent].activeAccountId ?? null
        apply(await window.ade.invoke('accounts:select', agent, accountId))
        if (before !== accountId && mountedRef.current) setSwitched(agent)
      }),
    [run, apply, state]
  )

  const rename = useCallback(
    (agent: AccountAgent, accountId: string, label: string) =>
      run(`rename:${accountId}`, async () => apply(await window.ade.invoke('accounts:rename', agent, accountId, label))),
    [run, apply]
  )

  const remove = useCallback(
    (agent: AccountAgent, accountId: string) =>
      run(`remove:${accountId}`, async () => apply(await window.ade.invoke('accounts:remove', agent, accountId))),
    [run, apply]
  )

  const relogin = useCallback(
    (agent: AccountAgent, accountId: string) =>
      run(`relogin:${accountId}`, async () => {
        requestAccountLogin(await window.ade.invoke('accounts:relogin', agent, accountId))
        startLoginPolling()
      }),
    [run, startLoginPolling]
  )

  return { state, action, error, switched, reload, add, select, rename, remove, relogin }
}
