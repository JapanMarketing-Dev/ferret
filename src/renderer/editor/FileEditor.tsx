import { Suspense, useEffect, useRef, useState } from 'react'
import { AlertTriangle, Columns2, ExternalLink, FileCode, FolderOpen, Globe, Save, Send } from 'lucide-react'
import { previewKind, previewUrl } from '@shared/preview'
import { isRiskyToOpenExternally, isSvgPath } from '@shared/fileViewer'
import { isHtmlPath } from '@shared/htmlPreview'
import FileViewer from './FileViewer'
import { openPublishPanel } from '../lib/publishPanel'
import { errorMessage } from '../lib/errors'
import { isMarkdownLanguage } from './language'
import type { OpenFilesApi, OpenFile } from './useOpenFiles'
import type { CodeEditorInstance } from './CodeEditor'
import { registerMarkdownDropTarget } from './markdownDrop'
import { markdownMediaSnippet, sourceInsertion } from '@shared/markdownMedia'
import { Button, EmptyState, Spinner, useToast } from '../ui'
import { useT } from '../lib/i18n'
import { preloadable } from '../lib/preloadable'
import { reportHandled } from '@shared/report'
import { X_MAX_WEIGHT, markdownToPostText, xWeightedLength } from '@shared/xPost'

/** 打鍵が止まってから横のプレビューを描き直すまでの待ち（数百ミリ秒で追従させる） */
const LIVE_PREVIEW_DELAY_MS = 150

/** Markdown のプレビュー（そのまま編集できる。tiptap を含むので、開いたときだけ読む） */
const { Component: RichMarkdownEditor, preload: loadRichMarkdownEditor } = preloadable(() => import('./richMarkdown/RichMarkdownEditor'))
/** ソースの編集（Monaco。数MBあるので、ソースを開いたときだけ読む） */
const { Component: CodeEditor, preload: loadCodeEditor } = preloadable(() => import('./CodeEditor'))

/**
 * 起動して手が空いたら、Markdown のプレビューの編集と Monaco を先に読んでおく
 * （初めてファイルを開いたときに、読み込みを待たずにすぐ書けるように）。App から呼ぶ
 */
export function preloadEditors(): void {
  void loadRichMarkdownEditor().then(() => loadCodeEditor()).catch(() => undefined)
}
/** Markdown をソースで開いているファイル（既定はプレビュー。タブを切り替えても残す） */
const sourceFiles = new Set<string>()

/**
 * 開いたファイルを Monaco で編集する（中央のファイルタブの中身）。
 *
 * Orca由来: ~/bench/orca/src/renderer/src/components/editor/EditorPanel.tsx・EditorPanelHeader.tsx（MIT）
 *   - エディタは1つだけ置き、タブを切り替えるとモデルを差し替える（undo とスクロール位置がタブごとに残る）
 *   - 見出しにパスと、Markdown なら「ソース」「プレビュー」の切り替え（プレビューはそのまま編集できる）、
 *     Mermaid・MDX なら読み取り専用のプレビュー（横に並べる・内蔵ブラウザで開く）
 *   - 外部の変更で未保存の内容と食い違ったら、上書きせずに帯で知らせる
 * プレビューは renderer の DOM ではなく ade-preview://（main が描くページ）で、
 * 「横に並べる」は iframe、「内蔵ブラウザで開く」は録画でレビューできる内蔵ブラウザに出す。
 * App からは React.lazy で遅れて読む（起動時間 NF-5 を守る）。Monaco と tiptap は、それぞれ使うときに読む。
 */
export default function FileEditor({ file, editor: api }: { file: OpenFile; editor: OpenFilesApi }) {
  const t = useT()
  const toast = useToast()
  const frameRef = useRef<HTMLIFrameElement>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  const editorRef = useRef<CodeEditorInstance | null>(null)
  const liveTimer = useRef<number | undefined>(undefined)
  const [, setRichVersion] = useState(0)

  /*
   * 横に並べたプレビューを打鍵に追従させる。編集中の内容を main で HTML にし（ファイルは読まない）、
   * iframe の page.js に中身だけ差し替えさせる（スクロール位置を保つ）。
   */
  const sendLivePreview = (delay: number) => {
    window.clearTimeout(liveTimer.current)
    liveTimer.current = window.setTimeout(() => {
      const source = api.getDraft(file.id) ?? file.saved
      void window.ade.invoke('preview:render', file.path, source).then((html) => {
        frameRef.current?.contentWindow?.postMessage({ type: 'ade-preview:html', html }, '*')
      }).catch(() => undefined) // 失敗は main の IPC が Sentry へ送る（ここは既定のまま続ける）
    }, delay)
  }
  useEffect(() => () => window.clearTimeout(liveTimer.current), [])

  // 外部で書き換えられたら（未保存の編集が無いときだけ）ファイルを取り直させる
  useEffect(() => {
    if (!file.preview || file.dirty) return
    return window.ade.on('fs:changed', (event) => {
      if (event.paths.includes(file.path)) frameRef.current?.contentWindow?.postMessage('ade-preview:refresh', '*')
    })
  }, [file.preview, file.path, file.dirty])

  // プレビューでダブルクリックした塊の元の行へ移る（「この箇所を編集」）
  useEffect(() => {
    if (!file.preview) return
    const onMessage = (event: MessageEvent) => {
      const data = event.data as { type?: unknown; line?: unknown; kind?: unknown; name?: unknown } | null
      // プレビューの図（mermaid）の描画の失敗。書き間違いは page.js が除いてある。中身は含まない
      if (event.source === frameRef.current?.contentWindow && data?.type === 'ade-preview:render-error') {
        const failure = new Error(`${String(data.kind)} render failed: ${String(data.name)}`)
        reportHandled(failure, { area: 'editor', op: 'render mermaid' })
        return
      }
      if (event.source !== frameRef.current?.contentWindow || data?.type !== 'ade-preview:reveal' || typeof data.line !== 'number') return
      const editor = editorRef.current
      if (!editor) return
      editor.revealLineInCenter(data.line)
      editor.setPosition({ lineNumber: data.line, column: 1 })
      editor.focus()
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [file.preview])

  const markdown = isMarkdownLanguage(file.language)
  // Markdown は「ソース」と「プレビュー」を切り替えられる。プレビューはいつでもそのまま編集でき、内容はどちらも同じ drafts を通す。
  // 読み取り専用のプレビュー（横に並べる・内蔵ブラウザで開く）は Markdown には出さない
  // （MDX は JSX を含むので、ソースだけで編集し、読み取り専用のプレビューで見る）
  const richable = file.language === 'markdown' && file.status === 'ready' && !file.viewer
  // 人は Markdown をほぼ手で直さない（声で Agent に頼む）ので、開いたら読みやすいプレビューを既定にする（ソースへ切り替えられる）
  const rich = richable && !sourceFiles.has(file.id)
  const setRich = (on: boolean) => {
    if (on) sourceFiles.delete(file.id)
    else sourceFiles.add(file.id)
    setRichVersion((v) => v + 1)
  }
  // HTML をソースで開いているときは、内蔵ブラウザのプレビューへ戻れるようにする
  const htmlPreviewable = isHtmlPath(file.path) && file.status === 'ready' && !file.viewer
  const previewable = previewKind(file.path) !== null && file.language !== 'markdown' && file.status === 'ready' && !file.viewer
  const sourceDroppable = markdown && file.status === 'ready' && !file.viewer && !rich
  const postable = file.status === 'ready' && !file.viewer
  /** ソースで範囲を選んでいればその部分、無ければ全体。Markdown は記号を外す */
  const openXPost = () => {
    const editor = rich ? null : editorRef.current
    const selection = editor?.getSelection()
    const picked = selection && !selection.isEmpty() ? editor?.getModel()?.getValueInRange(selection) : undefined
    const source = picked ?? api.currentText(file.id) ?? ''
    const text = markdown ? markdownToPostText(source) : source.trim()
    // 3件のスレッドに収まる長さなら、そのまま下書きにして「発信」を開く（AI で書き直すこともできる）。
    // それより長い文書（README など）は下書きにせず、「この文章から AI で作る」を出して開く
    if (xWeightedLength(text) > X_MAX_WEIGHT * 3) {
      openPublishPanel({ sourceText: text, sourceLabel: file.name })
      return
    }
    void window.ade.invoke('publish:create', text).then(
      (draftId) => openPublishPanel({ draftId, sourceText: text, sourceLabel: file.name }),
      (err) => toast({ tone: 'warning', message: errorMessage(err) }))
  }

  // ソースへ落とした画像・動画を、落とした位置に埋め込む（受けるのは App の中央のペイン。markdownDrop.ts）
  useEffect(() => {
    if (!sourceDroppable) return
    return registerMarkdownDropTarget({
      path: file.path,
      element: () => bodyRef.current,
      insert: (media, point) => {
        const editor = editorRef.current
        const model = editor?.getModel()
        if (!editor || !model) return
        const position = editor.getTargetAtClientPoint(point.x, point.y)?.position ?? editor.getPosition() ?? model.getFullModelRange().getEndPosition()
        const line = model.getLineContent(position.lineNumber)
        const text = sourceInsertion(media.map((m) => markdownMediaSnippet(m.kind, m.link)), line.slice(0, position.column - 1), line.slice(position.column - 1))
        const range = { startLineNumber: position.lineNumber, startColumn: position.column, endLineNumber: position.lineNumber, endColumn: position.column }
        editor.pushUndoStop()
        editor.executeEdits('drop-media', [{ range, text, forceMoveMarkers: true }])
        editor.pushUndoStop()
        editor.focus()
      }
    })
  }, [sourceDroppable, file.path])
  const segments = file.path.split('/')

  return (
    <div className="editor-area" data-testid="file-editor">
      <header className="editor-head">
        <span className="editor-head__path" title={file.path}>
          {segments.map((segment, index) => (
            <span key={index} className={index === segments.length - 1 ? 'editor-head__name' : 'editor-head__dir'}>
              {segment}
            </span>
          ))}
        </span>
        {file.dirty && <span className="editor-head__dirty" title={t('editor.dirtyTitle')}>{t('editor.dirty')}</span>}
        <span className="editor-head__spacer" />
        {richable && (
          <span className="editor-head__modes" role="group" aria-label={t('editor.viewMode')}>
            <Button variant="ghost" selected={!rich} onClick={() => setRich(false)} data-testid="editor-mode-source">
              {t('editor.viewSource')}
            </Button>
            <Button variant="ghost" selected={rich} title={t('editor.viewRichTitle')} onClick={() => setRich(true)} data-testid="editor-mode-rich">
              {t('editor.viewRich')}
            </Button>
          </span>
        )}
        {previewable && (
          <>
            {!rich && <Button
              variant="ghost"
              icon={<Columns2 size={13} />}
              aria-pressed={file.preview}
              title={file.preview ? t('editor.closePreview') : t('editor.previewToSide')}
              onClick={() => api.togglePreview(file.id)}
              data-testid="editor-preview-toggle"
            >
              {file.preview ? t('editor.closePreview') : t('editor.previewToSide')}
            </Button>}
            <Button variant="ghost" icon={<Globe size={13} />} title={t('editor.openPreviewTitle')} onClick={() => api.openPreviewInBrowser(file.id)} data-testid="editor-preview-browser">
              {t('editor.openPreview')}
            </Button>
          </>
        )}
        {htmlPreviewable && (
          <Button variant="ghost" icon={<Globe size={13} />} title={t('editor.openPreviewTitle')} onClick={() => api.previewHtml(file.path)} data-testid="editor-html-preview">
            {t('editor.openPreview')}
          </Button>
        )}
        {file.viewer && file.status === 'ready' && (
          <>
            {file.viewer === 'image' && isSvgPath(file.path) && (
              <Button variant="ghost" icon={<FileCode size={13} />} title={t('viewer.openAsText')} onClick={() => api.openAsText(file.id)} data-testid="viewer-open-as-text">
                {t('viewer.openAsText')}
              </Button>
            )}
            <Button variant="ghost" icon={<FolderOpen size={13} />} title={t('viewer.showInFolder')} onClick={() => api.reveal(file.id)} data-testid="viewer-reveal">
              {t('viewer.showInFolder')}
            </Button>
            {!isRiskyToOpenExternally(file.path) && (
              <Button variant="ghost" icon={<ExternalLink size={13} />} title={t('viewer.openExternal')} onClick={() => api.openExternally(file.id)} data-testid="viewer-open-external">
                {t('viewer.openExternal')}
              </Button>
            )}
          </>
        )}
        {postable && (
          <Button variant="ghost" icon={<Send size={13} />} title={t('xPost.buttonTitle')} onClick={openXPost} data-testid="editor-x-post">
            {t('xPost.button')}
          </Button>
        )}
        {file.status === 'ready' && !file.viewer && (
          <Button variant="ghost" className="editor-head__save" icon={<Save size={13} />} title={t('common.save')} disabled={!file.dirty && !file.external} onClick={() => void api.save(file.id)} data-testid="editor-save">
            {t('common.save')}
          </Button>
        )}
      </header>

      {file.external && (
        <div className="editor-banner" role="alert" data-testid="editor-external-change">
          <AlertTriangle size={14} aria-hidden="true" />
          <span>
            {file.external === 'deleted'
              ? t('editor.deletedOnDisk')
              : t('editor.changedOnDisk')}
          </span>
          <span className="editor-head__spacer" />
          {file.external === 'changed' && (
            <Button variant="ghost" onClick={() => api.reloadFromDisk(file.id)}>
              {t('editor.reloadFromDisk')}
            </Button>
          )}
          <Button variant="ghost" onClick={() => api.keepMine(file.id)}>
            {t('editor.keepMine')}
          </Button>
        </div>
      )}

      <div ref={bodyRef} className={`editor-body${previewable && file.preview && !rich ? ' editor-body--split' : ''}`}>
        {file.status === 'loading' ? (
          <div className="editor-body__center"><Spinner size={18} /></div>
        ) : file.status === 'unavailable' ? (
          <EmptyState size="sm" title={t('editor.cannotOpen')} description={file.message ?? ''} testId="editor-unavailable" />
        ) : file.viewer ? (
          <FileViewer path={file.path} name={file.name} viewer={file.viewer} info={file.info} message={file.message} revision={file.revision} />
        ) : rich ? (
          <Suspense fallback={<div className="editor-body__center"><Spinner size={18} /></div>}>
            <RichMarkdownEditor key={file.id} file={file} editor={api} />
          </Suspense>
        ) : (
          <>
            <Suspense fallback={<div className="editor-body__center"><Spinner size={18} /></div>}>
              <CodeEditor
                file={file}
                editor={api}
                wordWrap={markdown}
                onEditor={(editor) => { editorRef.current = editor }}
                onChange={(value) => {
                  api.setDraft(file.id, value)
                  if (file.preview) sendLivePreview(LIVE_PREVIEW_DELAY_MS)
                }}
              />
            </Suspense>
            {previewable && file.preview && (
              // 開いた直後はファイルの内容。未保存の編集があれば、読み込み終わりに編集中の内容へ差し替える
              <iframe
                onLoad={() => { if (file.dirty) sendLivePreview(0) }}
                ref={frameRef} key={file.id} className="editor-preview" title={t('editor.previewFrameTitle', { name: file.name })} src={previewUrl(file.path)} data-testid="editor-preview" />
            )}
          </>
        )}
      </div>
    </div>
  )
}
