import { useCallback, useEffect, useRef, useState } from 'react'
import type { ResearchSnapshot, ResearchStatus } from '@shared/research/ipc'
import { errorMessage } from '../lib/errors'
import type { ResearchApi } from './api'

/** 変更の知らせをまとめる間隔（Agent が続けて書いても1回だけ読み直す） */
export const CHANGE_DEBOUNCE_MS = 250

export interface ResearchState {
  status: ResearchStatus | null
  snapshot: ResearchSnapshot | null
  /** 読めなかった理由。前の内容は残す */
  error: string | null
  reload: () => Promise<void>
  setSnapshot: (snapshot: ResearchSnapshot) => void
}

/**
 * 開いているプロジェクトのリサーチ。'research:changed' で読み直す（business の useBusiness と同じ形）。
 * 読み直しの間も前の中身を出し続ける。
 */
export function useResearch(api: ResearchApi, projectKey: string | null): ResearchState {
  const [status, setStatus] = useState<ResearchStatus | null>(null)
  const [snapshot, setSnapshot] = useState<ResearchSnapshot | null>(null)
  const [error, setError] = useState<string | null>(null)
  const seq = useRef(0)

  const reload = useCallback(async () => {
    const mine = ++seq.current
    try {
      const next = await api.invoke('research:status')
      if (mine !== seq.current) return
      setStatus(next)
      if (!next.isResearch) {
        setSnapshot(null)
        setError(null)
        return
      }
      const snap = await api.invoke('research:load')
      if (mine !== seq.current) return
      setSnapshot(snap)
      setError(null)
    } catch (err) {
      if (mine !== seq.current) return
      setError(errorMessage(err))
      setStatus((s) => s ?? { root: null, isResearch: false, name: null })
    }
  }, [api])

  // biome-ignore lint/correctness/useExhaustiveDependencies: projectKey はプロジェクトが替わった合図（読み直す）
  useEffect(() => {
    setStatus(null)
    setSnapshot(null)
    void reload()
  }, [reload, projectKey])

  useEffect(() => {
    let timer: number | null = null
    const off = api.onChanged(() => {
      if (timer !== null) window.clearTimeout(timer)
      timer = window.setTimeout(() => {
        timer = null
        void reload()
      }, CHANGE_DEBOUNCE_MS)
    })
    return () => {
      off()
      if (timer !== null) window.clearTimeout(timer)
    }
  }, [api, reload])

  const set = useCallback((next: ResearchSnapshot) => {
    seq.current++
    setSnapshot(next)
    setStatus((s) => (s ? { ...s, isResearch: true, name: next.data.research.name } : s))
  }, [])

  return { status, snapshot, error, reload, setSnapshot: set }
}
