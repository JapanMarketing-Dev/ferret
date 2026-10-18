import { useEffect, useState } from 'react'
import { useVentureApi } from './api'

const EMPTY: ReadonlySet<string> = new Set()

/**
 * ビジネスのオーケストラの projectId（サイドバーの印をブリーフケースにする）。
 * venture:list を読み、projects:changed・venture:changed で読み直す。読めなければ空（印がオーケストラのままになるだけ）
 */
export function useVentureIds(): ReadonlySet<string> {
  const api = useVentureApi()
  const [ids, setIds] = useState<ReadonlySet<string>>(EMPTY)
  useEffect(() => {
    let alive = true
    let seq = 0
    const load = () => {
      const id = ++seq
      api.invoke('venture:list').then((list) => {
        if (alive && id === seq) setIds(new Set(list.map((x) => x.projectId)))
      }).catch(() => {
        // 一覧が読めなくてもサイドバーは止めない（印がオーケストラのままになる）
      })
    }
    load()
    const offProjects = api.onProjectsChanged(load)
    const offChanged = api.onChanged(load)
    return () => {
      alive = false
      offProjects()
      offChanged()
    }
  }, [api])
  return ids
}
