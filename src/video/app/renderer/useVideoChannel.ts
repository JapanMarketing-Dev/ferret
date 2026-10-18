import { useEffect, useState } from 'react'
import type { Project } from '@shared/types'
import { subscribeIpc } from '@/lib/ipcEvents'

/** 中を見に行くのは、フォルダの増減（fs:changed）のうち直下の動画のプロジェクトの設定ファイルが変わったときだけ */
const PROJECT_FILE_CHANGE = /^[^/\\]+[/\\](ferret-video|solocut)\.json$/

/**
 * 今のプロジェクトが動画のチャンネル（マスタフォルダ）か。違えば上のモード切替の「動画」でチャンネルにする案内を出す（担当: 動画タブ）。
 * 種類が「動画のチャンネル」のプロジェクト、または中に動画のプロジェクト（ferret-video.json・旧 solocut.json）のフォルダがあるもの。
 * 中身は main に聞く（video:isChannel）。動画を作った・フォルダが増えたら聞き直す
 */
export function useVideoChannel(project: Project | null | undefined): boolean {
  const byKind = project?.kind === 'video'
  const folder = project?.folderPath ?? ''
  const [found, setFound] = useState<{ folder: string; value: boolean }>({ folder: '', value: false })

  useEffect(() => {
    if (byKind || !folder) return
    let alive = true
    const ask = () => {
      void window.ade.invoke('video:isChannel', folder).then(
        (value) => { if (alive) setFound({ folder, value }) },
        () => { if (alive) setFound({ folder, value: false }) }
      )
    }
    ask()
    const offChanged = subscribeIpc('video:changed', ask, 'video')
    const offFs = subscribeIpc('fs:changed', (event) => {
      if (event.paths.some((p) => PROJECT_FILE_CHANGE.test(p))) ask()
    }, 'video')
    return () => {
      alive = false
      offChanged()
      offFs()
    }
  }, [byKind, folder])

  return byKind || (found.folder === folder && found.value)
}
