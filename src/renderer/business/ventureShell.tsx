import { useEffect, useMemo, useRef } from 'react'
import type { ProjectsState, WorkspaceState } from '@shared/types'
import type { CenterTab } from '../components/CenterTabs'
import { ErrorBoundary } from '../ui'
import { BusinessWorkspace } from './BusinessWorkspace'
import { createWindowBusinessApi } from './api'
import { useBusinessList } from './useBusiness'
import { ventureTabFor, type VentureTab } from '../lib/businessShell'
import '../styles/business.css'

/**
 * ビジネスの画面を App.tsx につなぐ口（App.tsx の変更を小さく保つ）。
 * ビジネスのプロジェクト（business.yaml がある）… 中央のタブの先頭に「ビジネス」。
 * ビジネスリサーチは上のモード切替で開く（src/renderer/research/researchMode.tsx）
 * プロジェクトを開いたら、そのタブを前に出す（ブラウザ・指摘を見ていたときだけ。ファイル・設定は替えない）
 */
export function useVentureTab(projects: ProjectsState, workspace: WorkspaceState, setCenterTab: (update: (tab: CenterTab) => CenterTab) => void): VentureTab | null {
  const api = useMemo(createWindowBusinessApi, [])
  const businesses = useBusinessList(api, projects)
  const tab = ventureTabFor(projects.projects, workspace.projectId, businesses)
  const shownFor = useRef<string | null>(null)
  useEffect(() => {
    const projectId = workspace.projectId
    if (!tab) {
      shownFor.current = null
      setCenterTab((current) => (current === 'business' ? 'browser' : current))
      return
    }
    // 同じプロジェクトで一度出したら、利用者がブラウザへ移っても引き戻さない
    if (!projectId || shownFor.current === projectId) return
    shownFor.current = projectId
    // 前に開いていたタブ（useProjectSession が戻す）を優先し、覚えた選択が無い初めてのときだけ「ビジネス」を前に出す。
    // 戻し終えた後に効くよう、同じ一覧を読んでから次の順番で動かす
    let cancelled = false
    void window.ade.invoke('project:list').then((state) => {
      const saved = state.projects.find((p) => p.id === projectId)?.session?.centerTab
      if (saved) return
      window.setTimeout(() => {
        if (!cancelled) setCenterTab((current) => (current === 'browser' || current === 'findings' ? 'business' : current))
      }, 0)
    }).catch(() => undefined)
    return () => { cancelled = true }
  }, [tab, workspace.projectId, setCenterTab])
  return tab
}

/** 中央の画面（タブが business のとき） */
export function VentureCenter({ projectId }: { projectId: string | null }) {
  const api = useMemo(createWindowBusinessApi, [])
  return <ErrorBoundary name="business"><BusinessWorkspace api={api} projectKey={projectId} /></ErrorBoundary>
}
