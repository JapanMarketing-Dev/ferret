import { useCallback, useEffect, useRef, useState } from 'react'
import type { BusinessListItem, BusinessSnapshot, BusinessStatus } from '@shared/business/ipc'
import type { BusinessApi } from './api'
import { errorText } from './view'

/** 変更の知らせをまとめる間隔（Agent が続けて書いても1回だけ読み直す） */
export const CHANGE_DEBOUNCE_MS = 250

export interface BusinessState {
  status: BusinessStatus | null
  snapshot: BusinessSnapshot | null
  /** 読めなかった理由（日本語）。前の内容は残す */
  error: string | null
  reload: () => Promise<void>
  /** 保存などで返ってきた最新の中身を入れる */
  setSnapshot: (snapshot: BusinessSnapshot) => void
}

/**
 * 開いているプロジェクトのビジネス。'business:changed' で読み直す。
 * 読み直しの間も前の中身を出し続ける（読み込みの輪を出さない）。
 */
export function useBusiness(api: BusinessApi, projectKey: string | null = null): BusinessState {
  const [status, setStatus] = useState<BusinessStatus | null>(null)
  const [snapshot, setSnapshot] = useState<BusinessSnapshot | null>(null)
  const [error, setError] = useState<string | null>(null)
  const seq = useRef(0)

  const reload = useCallback(async () => {
    const mine = ++seq.current
    try {
      const next = await api.invoke('business:status')
      if (mine !== seq.current) return
      setStatus(next)
      if (!next.isBusiness) {
        setSnapshot(null)
        setError(null)
        return
      }
      const snap = await api.invoke('business:load')
      if (mine !== seq.current) return
      setSnapshot(snap)
      setError(null)
    } catch (err) {
      if (mine !== seq.current) return
      setError(errorText(err, 'ビジネスを読み込めませんでした'))
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

  const set = useCallback((next: BusinessSnapshot) => {
    seq.current++
    setSnapshot(next)
    setStatus((s) => (s ? { ...s, isBusiness: true, name: next.data.business.name } : s))
  }, [])

  return { status, snapshot, error, reload, setSnapshot: set }
}

/** 登録したプロジェクトのうちビジネスのもの（サイドバーの札・タイトルの表示） */
export function useBusinessList(api: BusinessApi, refreshKey: unknown = null): BusinessListItem[] {
  const [items, setItems] = useState<BusinessListItem[]>([])
  // biome-ignore lint/correctness/useExhaustiveDependencies: refreshKey は呼び出し側からの読み直しの合図
  useEffect(() => {
    let alive = true
    let timer: number | null = null
    const load = () => {
      api.invoke('business:list').then((next) => { if (alive) setItems(next) }).catch(() => {
        // 一覧が取れなくても札を出さないだけ（作業は続けられる）
      })
    }
    load()
    const off = api.onChanged(() => {
      if (timer !== null) window.clearTimeout(timer)
      timer = window.setTimeout(load, CHANGE_DEBOUNCE_MS)
    })
    return () => {
      alive = false
      off()
      if (timer !== null) window.clearTimeout(timer)
    }
  }, [api, refreshKey])
  return items
}
