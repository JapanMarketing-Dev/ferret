import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Maximize2, ZoomIn, ZoomOut } from 'lucide-react'
import { BINARY_HEAD_BYTES, formatByteSize, formatHexDump, projectMediaUrl, type FileViewerKind, type FsFileInfo } from '@shared/fileViewer'
import { Button, EmptyState, IconButton } from '../ui'
import { useT } from '../lib/i18n'
import { fitZoom, stepZoom, wheelZoom } from './imageZoom'
import OfficeViewer from './OfficeViewer'

/**
 * 文字として開けないファイルの中身（中央のファイルタブの本体）。
 *   画像 … 拡大・縮小（ボタン・⌘/Ctrl + ホイール）。透明な部分は市松模様
 *   動画・音声 … そのまま再生（ade-media://project/ が Range に答えるので seek できる）
 *   PDF … 内蔵の PDF ビューア
 *   Word・Excel・PowerPoint … HTML にしたプレビューと、セル・文字の編集（OfficeViewer.tsx。古い形式は LibreOffice で変えて開く）
 *   その他 … 大きさと先頭の16進数だけ（文字化けした内容を Monaco に出さない・保存で壊さない）
 * 中身は main が ade-media://project/ で返す（プロジェクトの外・リンク・パイプは src/main/projectMedia.ts が断る）。
 * 表示に失敗したら（対応していない形式など）、大きさと16進数の表示に切り替える。
 */
interface FileViewerProps {
  path: string
  name: string
  viewer: FileViewerKind
  info?: FsFileInfo
  /** binary の表示に出す理由（大きすぎる など） */
  message?: string
  /** ディスクの内容が変わるたびに増える。URL に付けて取り直させる */
  revision: number
  /** 開いているタブの識別子（Office の文書の保存の口を結び付ける） */
  fileId?: string
  /** Office の文書を編集して、保存していない直しができた・無くなった */
  onDirty?: (dirty: boolean) => void
}

export default function FileViewer(props: FileViewerProps) {
  const [failed, setFailed] = useState(false)
  /** 表示できなかった理由（Office の文書）。無ければ既定の「対応していない形式」 */
  const [failure, setFailure] = useState<string | undefined>(undefined)
  useEffect(() => { setFailed(false); setFailure(undefined) }, [props.path, props.revision])
  const url = projectMediaUrl(props.path, props.revision)

  if (props.viewer === 'binary' || failed) return <BinaryInfo info={props.info} message={failure ?? props.message} failed={failed && !failure} />
  if (props.viewer === 'office') {
    return (
      <OfficeViewer
        fileId={props.fileId ?? props.path} path={props.path} name={props.name} info={props.info} revision={props.revision}
        onError={(message) => { setFailure(message); setFailed(true); props.onDirty?.(false) }}
        onDirty={(dirty) => props.onDirty?.(dirty)}
      />
    )
  }
  if (props.viewer === 'image') return <ImageView url={url} name={props.name} info={props.info} onError={() => setFailed(true)} />
  if (props.viewer === 'pdf') return <PdfView url={url} name={props.name} />
  return (
    <div className="file-viewer file-viewer--media" data-testid="file-viewer-media">
      {props.viewer === 'video'
        ? <video key={url} className="file-viewer__video" src={url} controls preload="metadata" onError={() => setFailed(true)} data-testid="file-viewer-video" />
        : <audio key={url} className="file-viewer__audio" src={url} controls preload="metadata" onError={() => setFailed(true)} data-testid="file-viewer-audio" />}
      {props.info && <div className="file-viewer__meta">{formatByteSize(props.info.size)}</div>}
    </div>
  )
}

function PdfView({ url, name }: { url: string; name: string }) {
  const t = useT()
  return <iframe key={url} className="file-viewer__pdf" src={url} title={t('viewer.pdfTitle', { name })} data-testid="file-viewer-pdf" />
}

function ImageView({ url, name, info, onError }: { url: string; name: string; info?: FsFileInfo; onError: () => void }) {
  const t = useT()
  const stageRef = useRef<HTMLDivElement>(null)
  /** null は「画面に合わせる」 */
  const [zoom, setZoom] = useState<number | null>(null)
  const [natural, setNatural] = useState<{ width: number; height: number } | null>(null)
  const [box, setBox] = useState({ width: 0, height: 0 })

  useLayoutEffect(() => {
    const stage = stageRef.current
    if (!stage) return
    const measure = () => setBox({ width: stage.clientWidth - 32, height: stage.clientHeight - 32 })
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(stage)
    return () => observer.disconnect()
  }, [])

  const effective = zoom ?? (natural ? fitZoom(natural, box) : 1)

  // ⌘/Ctrl + ホイール（トラックパッドのピンチも同じ）で拡大・縮小。passive にしないと preventDefault できない
  useEffect(() => {
    const stage = stageRef.current
    if (!stage) return
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return
      event.preventDefault()
      setZoom((current) => wheelZoom(current ?? (natural ? fitZoom(natural, box) : 1), event.deltaY))
    }
    stage.addEventListener('wheel', onWheel, { passive: false })
    return () => stage.removeEventListener('wheel', onWheel)
  }, [natural, box])

  const size = natural ? { width: Math.max(1, Math.round(natural.width * effective)), height: Math.max(1, Math.round(natural.height * effective)) } : undefined

  return (
    <div className="file-viewer file-viewer--image" data-testid="file-viewer-image">
      <div className="file-viewer__toolbar">
        <IconButton size="sm" label={t('viewer.zoomOut')} title={t('viewer.zoomOut')} icon={<ZoomOut size={13} />} onClick={() => setZoom(stepZoom(effective, -1))} />
        <span className="file-viewer__zoom" data-testid="file-viewer-zoom">{Math.round(effective * 100)}%</span>
        <IconButton size="sm" label={t('viewer.zoomIn')} title={t('viewer.zoomIn')} icon={<ZoomIn size={13} />} onClick={() => setZoom(stepZoom(effective, 1))} />
        <IconButton size="sm" label={t('viewer.zoomFit')} title={t('viewer.zoomFit')} icon={<Maximize2 size={13} />} selected={zoom === null} onClick={() => setZoom(null)} />
        <Button variant="ghost" selected={zoom === 1} onClick={() => setZoom(1)}>{t('viewer.zoomActual')}</Button>
        <span className="editor-head__spacer" />
        <span className="file-viewer__meta">
          {natural && <span title={t('viewer.dimensions')}>{natural.width} × {natural.height}</span>}
          {info && <span title={t('viewer.size')}>{formatByteSize(info.size)}</span>}
        </span>
      </div>
      <div ref={stageRef} className="file-viewer__stage" onDoubleClick={() => setZoom((z) => (z === null ? 1 : null))}>
        <img
          key={url}
          className="file-viewer__image"
          src={url}
          alt={name}
          draggable={false}
          style={size ? { width: size.width, height: size.height } : { visibility: 'hidden' }}
          onLoad={(event) => {
            const img = event.currentTarget
            // 大きさを持たない SVG は、表示の大きさで扱う
            setNatural({ width: img.naturalWidth || 300, height: img.naturalHeight || 150 })
          }}
          onError={onError}
        />
      </div>
    </div>
  )
}

function BinaryInfo({ info, message, failed }: { info?: FsFileInfo; message?: string; failed: boolean }) {
  const t = useT()
  const lines = info ? formatHexDump(info.head) : []
  return (
    <div className="file-viewer file-viewer--binary" data-testid="file-viewer-binary">
      <EmptyState
        size="sm"
        title={t('viewer.binaryTitle')}
        description={
          <>
            {info && <span className="file-viewer__meta">{t('viewer.size')}: {formatByteSize(info.size)} ({info.size.toLocaleString()} B)</span>}
            {failed && <span className="file-viewer__note">{t('viewer.loadFailed')}</span>}
            {message && <span className="file-viewer__note">{message}</span>}
          </>
        }
      />
      {info && (info.size === 0
        ? <p className="file-viewer__note">{t('viewer.empty')}</p>
        : (
          <section className="file-viewer__hex" aria-label={t('viewer.head', { count: Math.min(BINARY_HEAD_BYTES, info.size) })}>
            <h3>{t('viewer.head', { count: Math.min(BINARY_HEAD_BYTES, info.size) })}</h3>
            <pre data-testid="file-viewer-hex">{lines.join('\n')}</pre>
          </section>
        ))}
    </div>
  )
}
