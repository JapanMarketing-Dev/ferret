import { createContext, useContext } from 'react'
import type { FsChangedEvent } from '@shared/files'
import type { VentureIpcRequests } from '@shared/venture/ipc'
import { delay } from '@shared/delay'
import { requestAgentLaunch } from '../lib/agentLaunchRequest'
import { subscribeIpc } from '../lib/ipcEvents'

/**
 * ビジネスの画面が使う main への入口（venture:* の IPC と、読み直しの合図）。
 * 画面は window.ade を直接呼ばず、これを通す。高速 E2E のハーネスは fixtures の実装を Provider で差し込める
 */
export type VentureChannel = keyof VentureIpcRequests
export type VentureArgs<C extends VentureChannel> = Parameters<VentureIpcRequests[C]>
export type VentureResult<C extends VentureChannel> = Awaited<ReturnType<VentureIpcRequests[C]>>

export interface VentureApi {
  invoke<C extends VentureChannel>(channel: C, ...args: VentureArgs<C>): Promise<VentureResult<C>>
  /** ビジネスの記録・台帳が変わった（venture:changed）。外す関数を返す */
  onChanged(listener: () => void): () => void
  /** 開いているプロジェクトのファイルが外から変わった（fs:changed。パスはフォルダからの相対） */
  onFsChanged(listener: (paths: string[]) => void): () => void
  /** 登録したプロジェクトの一覧が変わった（projects:changed） */
  onProjectsChanged(listener: () => void): () => void
  /**
   * 新しいターミナルで Agent を起動し、入力を受け付けるまで待つ。ターミナルの id を返す（起動できなければ null）。
   * venture:send は {kind:'new'} では起動しないので、起動してから {kind:'terminal', id} で送る
   */
  launchAgent(agent: 'claude' | 'codex'): Promise<string | null>
}

/** 起動した Agent が入力を受け付けるまで待つ上限 */
const AGENT_START_TIMEOUT_MS = 45_000
const GENERIC_SETTLE_MS = 3000

async function launchAgentAndWait(agent: 'claude' | 'codex'): Promise<string | null> {
  const before = new Set((await window.ade.invoke('terminal:list')).map((x) => x.id))
  requestAgentLaunch(agent)
  const deadline = Date.now() + AGENT_START_TIMEOUT_MS
  let seenAt: number | null = null
  while (Date.now() < deadline) {
    await delay(500)
    const created = (await window.ade.invoke('terminal:list')).find((x) => !before.has(x.id) && x.agent === agent)
    if (!created) continue
    const state = await window.ade.invoke('terminal:agentState', created.id)
    if (state.kind === 'unknown') continue
    if (state.state === 'idle' || state.state === 'blocked') return created.id
    seenAt ??= Date.now()
    if (state.kind === 'generic' && state.state !== 'working' && Date.now() - seenAt >= GENERIC_SETTLE_MS) return created.id
  }
  return null
}

/** アプリの本物（preload の window.ade） */
export function createWindowVentureApi(): VentureApi {
  return {
    invoke: (channel, ...args) => (window.ade.invoke as (c: string, ...a: unknown[]) => Promise<never>)(channel, ...args),
    onChanged: (listener) => subscribeIpc('venture:changed', listener, 'ui'),
    onFsChanged: (listener) => subscribeIpc('fs:changed', (event: FsChangedEvent) => listener(event?.paths ?? []), 'ui'),
    onProjectsChanged: (listener) => subscribeIpc('projects:changed', () => listener(), 'ui'),
    launchAgent: launchAgentAndWait
  }
}

const VentureApiContext = createContext<VentureApi | null>(null)
export const VentureApiProvider = VentureApiContext.Provider

let windowApi: VentureApi | null = null

/** Provider が無ければアプリの本物を使う（App.tsx・Sidebar に Provider を足さずに済むように） */
export function useVentureApi(): VentureApi {
  const api = useContext(VentureApiContext)
  if (api) return api
  windowApi ??= createWindowVentureApi()
  return windowApi
}
