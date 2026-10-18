import { createContext, useContext } from 'react'
import type { ResearchIpcRequests } from '@shared/research/ipc'
import type { ProjectsState } from '@shared/types'
import { createWindowBusinessApi } from '../business/api'

/**
 * ビジネスリサーチの画面が使う main への入口（research:* の IPC と、オーケストラの一覧・Agent の起動）。
 * 画面は window.ade を直接呼ばず、これを通す（高速 E2E のハーネスは fixtures の実装を差し込める）。
 */
export type ResearchChannel = keyof ResearchIpcRequests
export type ResearchArgs<C extends ResearchChannel> = Parameters<ResearchIpcRequests[C]>
export type ResearchResult<C extends ResearchChannel> = Awaited<ReturnType<ResearchIpcRequests[C]>>

export interface ResearchApi {
  invoke<C extends ResearchChannel>(channel: C, ...args: ResearchArgs<C>): Promise<ResearchResult<C>>
  /** リサーチのフォルダの中身が変わった。外す関数を返す */
  onChanged(listener: () => void): () => void
  /** 登録したプロジェクト（「プロジェクトにする」のオーケストラを選ぶ） */
  projects(): Promise<ProjectsState>
  /** 新しいターミナルで Agent を起動し、入力を受け付けるまで待つ（business と同じ） */
  launchAgent(agent: 'claude' | 'codex'): Promise<string | null>
  /** 証拠の URL を既定のブラウザで開く */
  openExternal(url: string): Promise<void>
}

/** アプリの本物（preload の window.ade） */
export function createWindowResearchApi(): ResearchApi {
  const business = createWindowBusinessApi()
  return {
    invoke: (channel, ...args) => (window.ade.invoke as (c: string, ...a: unknown[]) => Promise<never>)(channel, ...args),
    onChanged: (listener) => window.ade.on('research:changed', listener),
    projects: () => window.ade.invoke('project:list'),
    launchAgent: (agent) => business.launchAgent(agent),
    openExternal: (url) => window.ade.invoke('app:openExternal', url)
  }
}

const ResearchApiContext = createContext<ResearchApi | null>(null)
export const ResearchApiProvider = ResearchApiContext.Provider

export function useResearchApi(): ResearchApi {
  const api = useContext(ResearchApiContext)
  if (!api) throw new Error('ResearchApiProvider is missing')
  return api
}
