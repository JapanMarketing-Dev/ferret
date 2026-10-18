import { createContext, useContext } from 'react'
import type { BusinessIpcRequests } from '@shared/business/ipc'
import { delay } from '@shared/delay'
import { requestAgentLaunch } from '../lib/agentLaunchRequest'

/**
 * ビジネスの画面が使う main への入口（business:* の IPC だけ）。
 * 画面は window.ade を直接呼ばず、これを通す。高速 E2E のハーネスは fixtures の実装を差し込む。
 */
export type BusinessChannel = keyof BusinessIpcRequests
export type BusinessArgs<C extends BusinessChannel> = Parameters<BusinessIpcRequests[C]>
export type BusinessResult<C extends BusinessChannel> = Awaited<ReturnType<BusinessIpcRequests[C]>>

export interface BusinessApi {
  invoke<C extends BusinessChannel>(channel: C, ...args: BusinessArgs<C>): Promise<BusinessResult<C>>
  /** ビジネスのフォルダの中身が変わった（Agent が書いた・人が保存した）。外す関数を返す */
  onChanged(listener: () => void): () => void
  /**
   * 新しいターミナルで Agent を起動し、入力を受け付けるまで待つ。ターミナルの id を返す（起動できなければ null）。
   * business:send は {kind:'new'} では起動しないので、起動してから {kind:'terminal', id} で送る。
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
export function createWindowBusinessApi(): BusinessApi {
  return {
    invoke: (channel, ...args) => (window.ade.invoke as (c: string, ...a: unknown[]) => Promise<never>)(channel, ...args),
    onChanged: (listener) => window.ade.on('business:changed', listener),
    launchAgent: launchAgentAndWait
  }
}

const BusinessApiContext = createContext<BusinessApi | null>(null)
export const BusinessApiProvider = BusinessApiContext.Provider

export function useBusinessApi(): BusinessApi {
  const api = useContext(BusinessApiContext)
  if (!api) throw new Error('BusinessApiProvider がありません')
  return api
}
