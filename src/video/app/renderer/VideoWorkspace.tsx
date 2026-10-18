import { useCallback, useEffect, useState } from 'react'
import { Clapperboard } from 'lucide-react'
import { Button, EmptyState } from '@/ui'
import { useT } from '@/lib/i18n'
import { subscribeIpc } from '@/lib/ipcEvents'
import { listChanged, type VideoList as VideoListData } from '../shared/library'
import { NewVideoDialog, VideoList } from './VideoList'
import { VideoDetail } from './VideoDetail'
import './video.css'

export interface VideoWorkspaceProps {
  /** 動画のチャンネル（Ferret のプロジェクト）のフォルダ */
  folderPath: string
  projectName: string
  /** Ferret のレビューの録画中（動画の撮影とは同時に使わない） */
  reviewRecording: boolean
  /** 動画のチャンネル（種類が「動画のチャンネル」か、中に動画のフォルダがある）か。違えばチャンネルにする案内を出す */
  isChannel?: boolean
  /** 今のプロジェクトの id（チャンネルにするとき種類を video に変える） */
  projectId?: string | null
}

/** 中央の「動画」タブの中身（担当: 動画タブ）。動画の一覧・新しい動画・撮る・確認・OK で投稿 */
export default function VideoWorkspace({ folderPath, projectName, reviewRecording, isChannel = true, projectId = null }: VideoWorkspaceProps) {
  const t = useT()
  const [list, setList] = useState<VideoListData | null>(null)
  const [open, setOpen] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)

  const load = useCallback(() => {
    void window.ade.invoke('video:list').then(setList, (err: unknown) => setList({ root: folderPath, exists: true, videos: [], error: err instanceof Error ? err.message : String(err) }))
  }, [folderPath])

  // プロジェクトを切り替えたら一覧に戻る
  useEffect(() => {
    setOpen(null)
    setList(null)
    load()
  }, [load])

  useEffect(() => {
    let timer: number | undefined
    const later = () => {
      window.clearTimeout(timer)
      timer = window.setTimeout(load, 400)
    }
    const offChanged = subscribeIpc('video:changed', later, 'video')
    const offFs = subscribeIpc('fs:changed', (event) => { if (listChanged(event.paths)) later() }, 'video')
    return () => {
      window.clearTimeout(timer)
      offChanged()
      offFs()
    }
  }, [load])

  if (!isChannel) return (
    <div className="video-ws" data-testid="video-workspace">
      <div className="video-ws__channel">
        <EmptyState
          art={<Clapperboard size={28} strokeWidth={1.5} />}
          title={t('video.channel.title')}
          description={t('video.channel.body')}
          actions={projectId ? <Button variant="primary" onClick={() => void window.ade.invoke('project:update', { id: projectId, kind: 'video' }).catch(() => undefined)} data-testid="video-make-channel">{t('video.channel.make')}</Button> : undefined}
        />
      </div>
    </div>
  )

  return (
    <div className="video-ws" data-testid="video-workspace">
      {open
        ? <VideoDetail key={open} name={open} reviewRecording={reviewRecording} onBack={() => { setOpen(null); load() }} />
        : <VideoList list={list} projectName={projectName} onOpen={setOpen} onNew={() => setCreating(true)} onChanged={load} />}
      {creating && <NewVideoDialog onClose={() => setCreating(false)} onCreated={(name) => { setCreating(false); load(); setOpen(name) }} />}
    </div>
  )
}
