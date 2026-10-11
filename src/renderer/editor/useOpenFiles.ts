import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { isSameOrUnder, movedPath, type FsChangedEvent } from '@shared/files'
import { MAX_VIEWER_BYTES, formatByteSize, mediaKindOf, type FileViewerKind, type FsFileInfo } from '@shared/fileViewer'
import { previewUrl } from '@shared/preview'
import { isHtmlPath, projectPageUrl, projectPathFromPageUrl } from '@shared/htmlPreview'
import { canOpenTab } from '@shared/browserTabs'
import { MAX_OFFICE_BYTES, isLegacyOffice, officeKindOf } from '@shared/office/kinds'
import { googleFileUrl, isGoogleFile } from '@shared/googleFiles'
import { errorMessage } from '../lib/errors'
import { t } from '@shared/i18n'
import { CLOSE_REQUEST_EVENT } from '../components/TerminalPane'
import { detectLanguage } from './language'
import { canCloseAfterSave } from './closeAfterSave'
import { nextActiveAfterClose } from './closeTabs'

/**
 * 開いているファイル（中央のタブ）の状態。
 *
 * Orca由来: ~/bench/orca/src/renderer/src/components/editor/editor-content-dirty-state.ts と
 * use-terminal-editor-close-*.ts（MIT）の考え方
 *   - 変更ありは「ディスクで最後に見た内容」と「編集中の内容」の差で決める
 *   - 変更ありのまま閉じるときは「保存 / 保存しない / キャンセル」を聞く
 *   - 外部の変更は、未保存の変更が無ければ取り込み、あれば上書きせずに知らせる
 * store・自動保存・ウィンドウを閉じるときの確認は持ち込まない。
 *
 * 編集中の内容は Monaco のモデルが正本で、ここでは drafts（ref）に写しだけを持つ。
 * 打鍵のたびに React の再描画を起こさないため、state に置くのは dirty の真偽だけにする。
 */
export interface OpenFile {
  /** タブの識別子。プロジェクトの根＋相対パス（別のプロジェクトの同名ファイルと区別する） */
  id: string
  root: string
  /** プロジェクトからの相対パス */
  path: string
  name: string
  language: string
  status: 'loading' | 'ready' | 'unavailable'
  /** ディスクで最後に見た内容 */
  saved: string
  dirty: boolean
  /** 開けない理由（バイナリ・大きすぎる・読めない） */
  message?: string
  /** 未保存の変更があるうちに、ディスク側が変わった／消えた */
  external?: 'changed' | 'deleted'
  /** markdown / Mermaid のプレビューを横に並べている */
  preview: boolean
  /** ディスクの内容でバッファを差し替えた回数。エディタはこれを見てモデルを入れ替える */
  revision: number
  /**
   * 文字として開けないファイルの見せ方（画像・動画・音声・PDF・その他のバイナリ）。
   * あれば Monaco を出さず、保存もしない（文字化けした内容でファイルを壊さない）
   */
  viewer?: FileViewerKind
  /** viewer のときの大きさと先頭のバイト */
  info?: FsFileInfo
  /** SVG を（画像ではなく）コードとして開いている */
  asText?: boolean
}

export type FileTabId = `file:${string}`

export function fileTabId(id: string): FileTabId {
  return `file:${id}`
}

function fileId(root: string, path: string): string {
  return `${root.replace(/[\\/]+$/, '')}/${path}`
}

/*
 * 閉じたファイルの Monaco のモデルを捨てる口。monaco-editor は遅れて読むので、ここでは import せず、
 * FileEditor が読み込まれたときに登録する（まだ読まれていなければモデルも無い）。
 * 捨てないと、閉じてすぐ開き直したときに古い内容と undo が残る。
 */
let modelDisposer: ((id: string) => void) | null = null
export function registerModelDisposer(dispose: (id: string) => void): void {
  modelDisposer = dispose
}

/*
 * プレビューで編集しているときの、まだ写していない編集を drafts へ写す口（RichMarkdownEditor が登録する）。
 * 保存はこれを先に呼んでから drafts を読む（打ってすぐ ⌘S でも最後の打鍵まで書く）。
 */
const draftFlushers = new Map<string, () => void>()
export function registerDraftFlush(id: string, flush: () => void): () => void {
  draftFlushers.set(id, flush)
  return () => { if (draftFlushers.get(id) === flush) draftFlushers.delete(id) }
}

function baseName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1)
}

export interface OpenFilesApi {
  /** 今のプロジェクトのファイルだけ（別のプロジェクトのタブは戻ってきたときに出す） */
  files: OpenFile[]
  activeFile: OpenFile | null
  /** 利用者が開いた（ファイルツリー・クイックオープンなど）。HTML は内蔵ブラウザでプレビューし、ほかはタブで開く */
  open: (path: string) => void
  /** 種類を問わずファイルのタブで開く（HTML のソース・開いていたタブの復元） */
  openSource: (path: string) => void
  /** HTML を内蔵ブラウザのタブで開く（同じファイルを開いたタブがあれば、それを前に出して読み直す） */
  previewHtml: (path: string) => void
  /** 変更ありなら確認を出す */
  requestClose: (id: string) => void
  /** まとめて閉じる（タブの右クリック）。変更の無いものはすぐ閉じ、変更ありは1つずつ確認を出す（キャンセルで残りもやめる） */
  requestCloseMany: (ids: readonly string[]) => void
  save: (id: string) => Promise<boolean>
  /** Monaco の内容が変わった */
  setDraft: (id: string, value: string) => void
  getDraft: (id: string) => string | undefined
  togglePreview: (id: string) => void
  /** プレビューを内蔵ブラウザで開く（そのまま録画でレビューできる） */
  openPreviewInBrowser: (id: string) => void
  /** 今の内容（プレビューで編集中のまだ写していない分も含める）。開いていなければ undefined */
  currentText: (id: string) => string | undefined
  /** 外部の変更を取り込む（自分の変更は捨てる） */
  reloadFromDisk: (id: string) => void
  /** 外部の変更の知らせを閉じ、自分の変更を残す */
  keepMine: (id: string) => void
  /** 画像として見ている SVG を、コードとして開き直す */
  openAsText: (id: string) => void
  /** フォルダ（Finder など）でファイルを選んで見せる */
  reveal: (id: string) => void
  /** OS の既定のアプリで開く（実行されうる種類は main が断る） */
  openExternally: (id: string) => void
  /** 閉じる確認の対象。null なら出していない */
  pendingClose: OpenFile | null
  resolveClose: (choice: 'save' | 'discard' | 'cancel') => void
  /** 変更ありのファイルの相対パス（エクスプローラの M の印） */
  dirtyPaths: ReadonlySet<string>
  /** ファイルツリーで名前を変えた。from（ファイルかフォルダ）とその下のタブを新しいパスへ移す（未保存の変更は残す） */
  followRename: (from: string, to: string) => void
  /** ファイルツリーで消した。そのパスとその下のタブを確認なしで閉じる（確認は削除の前に済んでいる） */
  closeDeleted: (paths: readonly string[]) => void
}

export function useOpenFiles({
  root,
  activeTab,
  setActiveTab,
  onError
}: {
  root: string | null
  /** 中央のタブの選択（CenterTab）。file: で始まればファイル */
  activeTab: string
  setActiveTab: (tab: 'browser' | FileTabId) => void
  onError: (message: string) => void
}): OpenFilesApi {
  const [allFiles, setAllFiles] = useState<OpenFile[]>([])
  /** 閉じる確認を待っているファイル（先頭から1つずつ聞く） */
  const [closeQueue, setCloseQueue] = useState<readonly string[]>([])
  const drafts = useRef(new Map<string, string>())
  const filesRef = useRef(allFiles)
  filesRef.current = allFiles
  // 保存してから閉じるときは、書き終わった時点の選択を見る（閉じる操作の時点の値は古い）
  const activeTabRef = useRef(activeTab)
  activeTabRef.current = activeTab

  const patch = useCallback((id: string, update: Partial<OpenFile> | ((file: OpenFile) => Partial<OpenFile>)) => {
    setAllFiles((files) => files.map((f) => (f.id === id ? { ...f, ...(typeof update === 'function' ? update(f) : update) } : f)))
  }, [])

  const files = useMemo(() => allFiles.filter((f) => f.root === root), [allFiles, root])
  const activeFile = activeTab.startsWith('file:') ? (files.find((f) => fileTabId(f.id) === activeTab) ?? null) : null

  const load = useCallback(async (id: string, path: string, asText = false) => {
    try {
      // 画像・動画・音声・PDF は中身を読まず、大きさだけ見てビューアで開く（中身は ade-media://project/ から）
      const media = asText ? null : mediaKindOf(path)
      if (media) {
        const info = await window.ade.invoke('fs:inspect', path)
        const limit = MAX_VIEWER_BYTES[media]
        const tooLarge = info.size > limit
        drafts.current.delete(id)
        patch(id, (f) => ({
          status: 'ready', viewer: tooLarge ? 'binary' : media, info, saved: '', dirty: false, external: undefined, revision: f.revision + 1,
          message: tooLarge ? t('viewer.tooLargeToShow', { size: formatByteSize(info.size), limit: formatByteSize(limit) }) : undefined
        }))
        return
      }
      // Word・Excel・PowerPoint はプレビュー（中身は OfficeViewer が fs:readOffice で読む）。古い形式は案内だけ
      if (!asText && (officeKindOf(path) || isLegacyOffice(path))) {
        const info = await window.ade.invoke('fs:inspect', path)
        const tooLarge = info.size > MAX_OFFICE_BYTES
        drafts.current.delete(id)
        patch(id, (f) => ({
          status: 'ready', viewer: officeKindOf(path) && !tooLarge ? 'office' : 'binary', info, saved: '', dirty: false, external: undefined, revision: f.revision + 1,
          message: isLegacyOffice(path) ? t('viewer.legacyOffice') : tooLarge ? t('viewer.tooLargeToShow', { size: formatByteSize(info.size), limit: formatByteSize(MAX_OFFICE_BYTES) }) : undefined
        }))
        return
      }
      const result = await window.ade.invoke('fs:read', path)
      if (result.kind === 'text') {
        drafts.current.set(id, result.content)
        patch(id, (f) => ({ status: 'ready', saved: result.content, dirty: false, message: undefined, external: undefined, viewer: undefined, info: undefined, revision: f.revision + 1 }))
      } else {
        // バイナリ・大きすぎるファイルは、大きさと先頭の16進数だけ見せる（Monaco には出さない）
        const info = await window.ade.invoke('fs:inspect', path)
        drafts.current.delete(id)
        patch(id, (f) => ({
          status: 'ready', viewer: 'binary', info, saved: '', dirty: false, external: undefined, revision: f.revision + 1,
          message: result.kind === 'tooLarge' ? result.reason : undefined
        }))
      }
    } catch (err) {
      patch(id, { status: 'unavailable', message: errorMessage(err) })
    }
  }, [patch])

  const openSource = useCallback((path: string) => {
    if (!root) return
    const id = fileId(root, path)
    if (!filesRef.current.some((f) => f.id === id)) {
      const file: OpenFile = {
        id, root, path, name: baseName(path), language: detectLanguage(path),
        status: 'loading', saved: '', dirty: false, preview: false, revision: 0
      }
      setAllFiles((list) => [...list, file])
      void load(id, path)
    }
    setActiveTab(fileTabId(id))
  }, [root, load, setActiveTab])

  /*
   * HTML は内蔵ブラウザのタブに ade-page://project/ で開く（@shared/htmlPreview。録画・指摘の仕組みがそのまま使える）。
   * 同じファイルを開いたタブがあれば前に出して読み直し（Agent が書き換えた後の内容を見せる）、空のタブならそこへ開く
   */
  /** 内蔵ブラウザで url を開く。same に当たるタブがあれば前に出し、reload なら読み直す。空のタブならそこへ開く */
  const showInBrowser = useCallback(async (url: string, same: (tabUrl: string) => boolean, reload: boolean) => {
    const state = await window.ade.invoke('browser:state')
    const tabs = state.tabs ?? []
    const existing = tabs.find((tab) => same(tab.url))
    if (existing) {
      if (existing.id !== state.activeTabId) await window.ade.invoke('browser:activateTab', existing.id)
      if (reload) await window.ade.invoke('browser:reload')
      return
    }
    const blank = !state.url || state.url === 'about:blank'
    if (blank || !canOpenTab(tabs.length)) await window.ade.invoke('browser:navigate', url)
    else await window.ade.invoke('browser:newTab', url)
  }, [])

  const previewHtml = useCallback((path: string) => {
    if (!root) return
    // プロジェクトの中のファイルだけを main が返す ade-page://project/ で開く（手元の絶対パスの URL は渡さない。security-7 [2][6]）
    const url = projectPageUrl(path)
    setActiveTab('browser')
    void showInBrowser(url, (tabUrl) => projectPathFromPageUrl(tabUrl) === path, true).catch((err) => onError(errorMessage(err)))
  }, [root, setActiveTab, onError, showInBrowser])

  /*
   * Google ドライブのショートカット（.gdoc・.gsheet・.gslides など）は、内蔵ブラウザで Google ドキュメント・スプレッドシート・
   * スライドを開く（そのまま見て編集できる）。同じ文書を開いたタブがあれば前に出す（読み直すと編集中の位置が飛ぶので読み直さない）
   */
  const openGoogle = useCallback((path: string) => {
    void (async () => {
      const result = await window.ade.invoke('fs:read', path)
      const url = result.kind === 'text' ? googleFileUrl(path, result.content) : null
      if (!url) {
        onError(t('viewer.googleOpenFailed'))
        return
      }
      const docPath = new URL(url).pathname.split('/').slice(0, 4).join('/')
      setActiveTab('browser')
      await showInBrowser(url, (tabUrl) => {
        try {
          const tab = new URL(tabUrl)
          return tab.hostname === 'docs.google.com' && tab.pathname.startsWith(docPath)
        } catch {
          return false
        }
      }, false)
    })().catch((err) => onError(errorMessage(err)))
  }, [setActiveTab, onError, showInBrowser])

  const open = useCallback((path: string) => {
    if (isHtmlPath(path)) previewHtml(path)
    else if (isGoogleFile(path)) openGoogle(path)
    else openSource(path)
  }, [previewHtml, openGoogle, openSource])

  /** 確認なしでまとめて閉じる。選択中が閉じたら、残ったファイルの隣（無ければブラウザ）へ移る */
  const removeMany = useCallback((ids: readonly string[]) => {
    const list = filesRef.current
    const doomed = new Set(ids.filter((id) => list.some((f) => f.id === id)))
    if (doomed.size === 0) return
    for (const id of doomed) { drafts.current.delete(id); modelDisposer?.(id) }
    setAllFiles((files) => files.filter((f) => !doomed.has(f.id)))
    const current = activeTabRef.current
    const activeId = list.find((f) => fileTabId(f.id) === current)?.id
    if (activeId && doomed.has(activeId)) {
      const siblings = list.filter((f) => f.root === list.find((x) => x.id === activeId)!.root).map((f) => f.id)
      const next = nextActiveAfterClose(siblings, activeId, doomed)
      const tab = next ? fileTabId(next) : 'browser'
      activeTabRef.current = tab
      setActiveTab(tab)
    }
  }, [setActiveTab])
  const remove = useCallback((id: string) => removeMany([id]), [removeMany])

  const save = useCallback(async (id: string): Promise<boolean> => {
    const file = filesRef.current.find((f) => f.id === id)
    // ビューアで開いたファイルは書かない（空の内容で上書きして壊さない）
    if (!file || file.status !== 'ready' || file.root !== root || file.viewer) return false
    draftFlushers.get(id)?.()
    const content = drafts.current.get(id) ?? file.saved
    try {
      await window.ade.invoke('fs:write', file.path, content)
      // 保存中に打った分は変更ありのまま残す
      patch(id, { saved: content, dirty: (drafts.current.get(id) ?? content) !== content, external: undefined })
      return true
    } catch (err) {
      onError(t('editor.saveFailed', { error: errorMessage(err) }))
      return false
    }
  }, [root, patch, onError])

  const setDraft = useCallback((id: string, value: string) => {
    drafts.current.set(id, value)
    const file = filesRef.current.find((f) => f.id === id)
    if (!file) return
    const dirty = value !== file.saved
    if (dirty !== file.dirty) patch(id, { dirty })
  }, [patch])

  const getDraft = useCallback((id: string) => drafts.current.get(id), [])

  const requestCloseMany = useCallback((ids: readonly string[]) => {
    const targets = filesRef.current.filter((f) => ids.includes(f.id))
    const dirty = targets.filter((f) => f.dirty).map((f) => f.id)
    removeMany(targets.filter((f) => !f.dirty).map((f) => f.id))
    if (dirty.length > 0) setCloseQueue((queue) => [...queue, ...dirty.filter((id) => !queue.includes(id))])
  }, [removeMany])
  const requestClose = useCallback((id: string) => requestCloseMany([id]), [requestCloseMany])

  // 確認しているファイルを前に出す（どのファイルを聞いているか見えるように）。閉じられたもの・別のプロジェクトへ切り替えて見えなくなったものは並びから落とす
  const pendingCloseId = closeQueue.find((id) => files.some((f) => f.id === id)) ?? null
  useEffect(() => {
    if (closeQueue.length > 0 && closeQueue[0] !== pendingCloseId) setCloseQueue((queue) => queue.filter((id) => files.some((f) => f.id === id)))
    if (pendingCloseId && activeTabRef.current !== fileTabId(pendingCloseId)) setActiveTab(fileTabId(pendingCloseId))
  }, [closeQueue, pendingCloseId, files, setActiveTab])

  const resolveClose = useCallback((choice: 'save' | 'discard' | 'cancel') => {
    const id = pendingCloseId
    // キャンセルは残りの確認もやめる（VS Code の「すべて閉じる」と同じ）
    setCloseQueue((queue) => (choice === 'cancel' ? [] : queue.filter((x) => x !== id)))
    if (!id || choice === 'cancel') return
    if (choice === 'discard') { remove(id); return }
    // 保存に失敗したら閉じない（内容を失わない）。書き込み中に打った分があれば閉じない（closeAfterSave.ts）
    const written = drafts.current.get(id)
    void save(id).then((ok) => { if (ok && canCloseAfterSave(written, drafts.current.get(id))) remove(id) })
  }, [pendingCloseId, remove, save])

  const togglePreview = useCallback((id: string) => patch(id, (f) => ({ preview: !f.preview })), [patch])
  const reloadFromDisk = useCallback((id: string) => {
    const file = filesRef.current.find((f) => f.id === id)
    if (file) void load(id, file.path, file.asText)
  }, [load])
  const keepMine = useCallback((id: string) => patch(id, { external: undefined }), [patch])
  const openAsText = useCallback((id: string) => {
    const file = filesRef.current.find((f) => f.id === id)
    if (!file) return
    patch(id, { asText: true, status: 'loading', viewer: undefined, info: undefined, message: undefined })
    void load(id, file.path, true)
  }, [patch, load])
  const reveal = useCallback((id: string) => {
    const file = filesRef.current.find((f) => f.id === id)
    if (file) void window.ade.invoke('fs:reveal', file.path).catch((err) => onError(errorMessage(err)))
  }, [onError])
  const openExternally = useCallback((id: string) => {
    const file = filesRef.current.find((f) => f.id === id)
    if (file) void window.ade.invoke('fs:openExternal', file.path).catch((err) => onError(errorMessage(err)))
  }, [onError])
  const openPreviewInBrowser = useCallback((id: string) => {
    const file = filesRef.current.find((f) => f.id === id)
    if (!file) return
    setActiveTab('browser')
    void window.ade.invoke('browser:navigate', previewUrl(file.path)).catch((err) => onError(errorMessage(err)))
  }, [setActiveTab, onError])
  const currentText = useCallback((id: string) => {
    draftFlushers.get(id)?.()
    const file = filesRef.current.find((f) => f.id === id)
    return file ? drafts.current.get(id) ?? file.saved : undefined
  }, [])

  /*
   * 外部の変更（Agent の書き換えなど）。
   * 未保存の変更が無ければ黙って取り込み、あれば上書きせずに知らせる。
   * 自分の保存でも通知は来るが、中身が saved と同じなので何もしない。
   */
  useEffect(() => {
    return window.ade.on('fs:changed', (event: FsChangedEvent) => {
      const changed = new Set(event.paths)
      for (const file of filesRef.current) {
        if (file.root !== root || file.status === 'loading' || !changed.has(file.path)) continue
        // ビューアで開いたファイルは編集中の内容が無いので、そのまま開き直す（画像・動画は URL を変えて取り直す）
        if (file.viewer) {
          void load(file.id, file.path, file.asText)
          continue
        }
        void window.ade.invoke('fs:read', file.path).then(
          (result) => {
            const current = filesRef.current.find((f) => f.id === file.id)
            if (!current || result.kind !== 'text' || result.content === current.saved) {
              if (current?.external === 'deleted' && result.kind === 'text') patch(file.id, { external: undefined })
              return
            }
            if (current.dirty) {
              patch(file.id, { external: 'changed' })
            } else {
              drafts.current.set(file.id, result.content)
              patch(file.id, (f) => ({ status: 'ready', saved: result.content, message: undefined, external: undefined, revision: f.revision + 1 }))
            }
          },
          // 読めなくなった＝消えた・名前が変わった。内容は残し、保存すれば作り直せる
          () => patch(file.id, { external: 'deleted' })
        )
      }
    })
  }, [root, patch, load])

  /*
   * ⌘W。メニューはターミナルを閉じる指示を出すが、TerminalPane はターミナルにフォーカスが無いとき
   * 先に 'ade:close-request' を投げる（terminal-agent との取り決め）。エディタかファイルのタブに
   * フォーカスがあれば、それを止めてファイルのタブを閉じる（変更ありなら確認を出す）。
   */
  const activeId = activeFile?.id ?? null
  useEffect(() => {
    if (!activeId) return
    const onCloseRequest = (event: Event) => {
      if (!document.activeElement?.closest('.editor-area, .ctab--file')) return
      event.preventDefault()
      requestClose(activeId)
    }
    window.addEventListener(CLOSE_REQUEST_EVENT, onCloseRequest)
    return () => window.removeEventListener(CLOSE_REQUEST_EVENT, onCloseRequest)
  }, [activeId, requestClose])

  // ウィンドウを閉じるときの確認のため、未保存のファイルを main へ知らせる（別のプロジェクトのタブも含める）。
  // main はプロジェクトの名前と相対パスで示すので、開いたときのプロジェクトのフォルダと相対パスを分けて送る
  const unsavedRefs = useMemo(() => allFiles.filter((f) => f.dirty).map((f) => ({ root: f.root, path: f.path })), [allFiles])
  const unsavedKey = unsavedRefs.map((f) => `${f.root}\n${f.path}`).join('\n\n')
  const unsavedRefsRef = useRef(unsavedRefs)
  unsavedRefsRef.current = unsavedRefs
  useEffect(() => {
    // 失敗は main の IPC が Sentry へ送る（ここは既定のまま続ける）
    void window.ade.invoke('editor:unsaved', unsavedRefsRef.current).catch(() => undefined)
  }, [unsavedKey])

  /*
   * 終了の確認で「保存して終了」を選んだ。未保存のファイルを（別のプロジェクトのものも）全部、中身ごと main へ返す。
   * main は確認で示したファイルだけを、そのプロジェクトの中へ書く。書けたものは保存済みにする（書けなければ終了しない）
   */
  useEffect(() => window.ade.on('editor:saveForQuit', (requestId) => {
    const dirty = filesRef.current.filter((f) => f.dirty && f.status === 'ready' && !f.viewer)
    const entries = dirty.map((file) => {
      draftFlushers.get(file.id)?.()
      return { id: file.id, root: file.root, path: file.path, content: drafts.current.get(file.id) ?? file.saved }
    })
    void window.ade.invoke('editor:quitSave', requestId, entries.map(({ root: r, path, content }) => ({ root: r, path, content }))).then((outcomes) => {
      for (const outcome of outcomes) {
        if (!outcome.ok) continue
        const entry = entries.find((e) => e.root === outcome.root && e.path === outcome.path)
        if (!entry) continue
        // 書いている間に打った分は変更ありのまま残す
        patch(entry.id, { saved: entry.content, dirty: (drafts.current.get(entry.id) ?? entry.content) !== entry.content, external: undefined })
      }
    }).catch((err) => onError(t('editor.saveFailed', { error: errorMessage(err) })))
  }), [patch, onError])

  /*
   * 終了の確認で「プロジェクトを開く」を選んだ。main がプロジェクトとエディタへ切り替えたあとに届くので、
   * そのファイルが今のプロジェクトのタブに出たところで選ぶ（root が変わるのは次の描画）
   */
  const [revealId, setRevealId] = useState<string | null>(null)
  useEffect(() => window.ade.on('editor:revealUnsaved', (target) => {
    if (target.error) { onError(target.error); return }
    setRevealId(fileId(target.root, target.path))
  }), [onError])

  // プロジェクトを切り替えて選択中のファイルが見えなくなったら、ブラウザへ戻す
  useEffect(() => {
    if (activeTab.startsWith('file:') && !files.some((f) => fileTabId(f.id) === activeTab)) setActiveTab('browser')
  }, [activeTab, files, setActiveTab])

  // 上の「ブラウザへ戻す」より後に置く（切り替えた直後でも、開きたいファイルを選んだままにする）
  useEffect(() => {
    if (!revealId || !files.some((f) => f.id === revealId)) return
    setActiveTab(fileTabId(revealId))
    setRevealId(null)
  }, [revealId, files, setActiveTab])

  const followRename = useCallback((from: string, to: string) => {
    if (!root) return
    const moves = filesRef.current
      .filter((f) => f.root === root)
      .flatMap((f) => { const path = movedPath(f.path, from, to); return path ? [{ file: f, path, id: fileId(root, path) }] : [] })
    if (moves.length === 0) return
    for (const { file, id } of moves) {
      // 編集中の内容は新しい id へ移す。Monaco のモデルは id ごとなので、古いものは捨てて新しい id で作り直させる
      const draft = drafts.current.get(file.id)
      drafts.current.delete(file.id)
      if (draft !== undefined) drafts.current.set(id, draft)
      modelDisposer?.(file.id)
    }
    const byId = new Map(moves.map((m) => [m.file.id, m]))
    setAllFiles((list) => list.map((f) => {
      const move = byId.get(f.id)
      return move ? { ...f, id: move.id, path: move.path, name: baseName(move.path), language: detectLanguage(move.path), external: undefined, revision: f.revision + 1 } : f
    }))
    const active = moves.find((m) => fileTabId(m.file.id) === activeTab)
    if (active) setActiveTab(fileTabId(active.id))
  }, [root, activeTab, setActiveTab])

  const closeDeleted = useCallback((paths: readonly string[]) => {
    removeMany(filesRef.current.filter((f) => f.root === root && paths.some((p) => isSameOrUnder(f.path, p))).map((f) => f.id))
  }, [root, removeMany])

  const dirtyPaths = useMemo(() => new Set(files.filter((f) => f.dirty).map((f) => f.path)), [files])
  const pendingClose = allFiles.find((f) => f.id === pendingCloseId) ?? null

  return {
    files, activeFile, open, openSource, previewHtml, requestClose, requestCloseMany, save, setDraft, getDraft, togglePreview, openPreviewInBrowser, currentText,
    reloadFromDisk, keepMine, openAsText, reveal, openExternally, pendingClose, resolveClose, dirtyPaths, followRename, closeDeleted
  }
}
