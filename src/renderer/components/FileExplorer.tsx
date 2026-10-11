import { expandedStorageKey } from '@shared/fileTreeState'
import { TREE_DRAG_TYPE } from '../lib/treeDrag'
import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent, type MouseEvent } from 'react'
import { ChevronRight, ClipboardPaste, Copy, CopyPlus, ExternalLink, Eye, EyeOff, FileCode, FilePlus, FileSearch, FileText, Folder, FolderOpen, FolderPlus, Link, ListCollapse, Pencil, RefreshCw, Scissors, Search, SquareTerminal, Trash2, Undo2 } from 'lucide-react'
import { ENTRY_NAME_PROBLEM_KEYS, isSameOrUnder, nestedNameParts, nestedNameProblem, type FsEntry, type FsTransfer } from '@shared/files'
import { GIT_STATE_LETTER, gitStateFor, isHiddenByDefault, withoutHidden, type GitDecorations, type GitFileState } from '@shared/gitDecorations'
import type { TranslationKey } from '@shared/i18n'
import { errorMessage } from '../lib/errors'
import { readLocal, writeLocal } from '../lib/localPref'
import { useGitDecorations } from '../lib/useGitDecorations'
import { FileIcon } from './FileIcon'
import { isHtmlPath } from '@shared/htmlPreview'
import { readDrop } from '../lib/externalDrop'
import { requestTerminalAt } from '../lib/terminalCommand'
import { SHORTCUTS, formatShortcut } from '../lib/shortcut'
import { Button, IconButton, Modal, Spinner } from '../ui'
import { useFileTree, type FileTreeRow } from './fileTree'
import { useT } from '../lib/i18n'

/**
 * 右のファイルツリー（エクスプローラ）。
 *
 * Orca由来: ~/bench/orca/src/renderer/src/components/right-sidebar/（MIT）
 *   - FileExplorer.tsx: フォルダは開いたときに読む。外部の変更で、読み込み済みのフォルダだけを読み直す
 *   - FileExplorerNameFilter.tsx: 名前で絞り込む欄
 *   - FileExplorerToolbar.tsx: Find files（⌘P）・再読込・すべて畳む
 * 内容検索・仮想スクロールは持ち込まない（動画フィードバックに絞る）。
 * 変更ありの「M」（黄）は、エディタで未保存の変更があるファイルに付ける。
 *
 * 見た目（VS Code のエクスプローラーと同じ感覚）:
 *   - 決まったフォルダ名・ファイル名・拡張子でアイコンと色を変える（lib/fileIcons.ts・FileIcon.tsx）
 *   - git の状態で名前に色を付け、右端に M・U・A・D・R を出す。変更を含むフォルダも色と点で示す（@shared/gitDecorations・lib/useGitDecorations.ts）
 *   - .gitignore の対象（.env など）は薄く出す。.DS_Store・.git は既定で隠し、右クリックの「隠しファイルを表示」で出す
 *
 * ファイルの操作（VS Code のエクスプローラーと同じ感覚）:
 *   - 新しいファイル / フォルダ: ツリーの上のボタンか右クリック（一覧の下の空いた所でも）。名前はその場の欄に打つ。
 *     「a/b/c.ts」のように / を含めれば途中のフォルダも作る。空のフォルダでは一覧の場所にボタンを出す
 *   - 名前の変更: F2（macOS は ↩ も）か右クリック
 *   - 削除: Delete（macOS は ⌘⌫ も）か右クリック。アプリ内の確認を出してゴミ箱へ送る。⌘ / Ctrl・Shift で複数を選べる
 *   - 切り取り / コピー / 貼り付け（⌘X / ⌘C / ⌘V、Windows・Linux は Ctrl）・複製。同じ名前は「名前 copy」にする
 *   - ドラッグでフォルダの中へ移動（⌥ / Ctrl を押しながらでコピー）。Finder などから落としたものはコピーして取り込む
 *   - パスをコピー・相対パスをコピー・Finder で表示・ターミナルで開く
 *   - 元に戻す（⌘Z / Ctrl+Z）: 直前の作成・名前の変更・移動・貼り付け・複製。削除はゴミ箱から戻せることを知らせる
 * パスと名前の検査は main（src/main/fileOps.ts）が最終的に行う。ここでの検査は打っている間の案内だけ。
 */

const SEARCH_DEBOUNCE_MS = 250
/** 知らせ（パスをコピーした・元に戻した）を出しておく時間 */
const NOTICE_MS = 4000
/** 元に戻せる操作の数 */
const MAX_HISTORY = 50
/** キーで処理したあと、同じ操作のクリップボードのイベント（メニューの役割から届く）を無視する時間 */
const CLIPBOARD_EVENT_DEDUPE_MS = 400

function parentDir(path: string): string {
  const slash = path.lastIndexOf('/')
  return slash === -1 ? '' : path.slice(0, slash)
}

function baseName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1)
}

function isMac(): boolean {
  return window.ade?.platform === 'darwin'
}

/** ドラッグでコピーにする修飾キー（macOS は ⌥、ほかは Ctrl。Finder・エクスプローラーと同じ） */
function isCopyModifier(event: { altKey: boolean; ctrlKey: boolean }): boolean {
  return isMac() ? event.altKey : event.ctrlKey
}

/** ツリーの中のその場の名前の欄。create は parent の中に新しく、rename は path の名前を変える */
type Editing =
  | { mode: 'create'; parent: string; kind: FsEntry['kind'] }
  | { mode: 'rename'; path: string; kind: FsEntry['kind'] }

/** 元に戻せる操作 */
type HistoryEntry =
  | { kind: 'create'; top: string }
  | { kind: 'rename'; from: string; to: string }
  | { kind: 'move'; moves: FsTransfer[] }
  | { kind: 'copy'; created: string[] }
  | { kind: 'trash' }

/** 既定で隠すもの（.DS_Store・.git）も出すか（この端末に覚える） */
const SHOW_HIDDEN_KEY = 'ferret.fileExplorer.showHidden'

/** git の状態の説明（右端の文字に重ねて出す） */
const GIT_STATE_LABEL: Record<GitFileState, TranslationKey> = {
  conflicted: 'fileExplorer.gitConflicted',
  deleted: 'fileExplorer.gitDeleted',
  modified: 'fileExplorer.gitModified',
  renamed: 'fileExplorer.gitRenamed',
  added: 'fileExplorer.gitAdded',
  untracked: 'fileExplorer.gitUntracked',
  ignored: 'fileExplorer.gitIgnored'
}

/** 行の右端の git の印。ファイルは文字（M・U・A…）、変更を含むフォルダは点（VS Code と同じ） */
function GitMark({ state, kind }: { state: GitFileState | null; kind: FsEntry['kind'] }) {
  const t = useT()
  if (!state || state === 'ignored') return null
  const folder = kind === 'directory' && state !== 'untracked'
  return (
    <span className={`explorer__git explorer__git--${state}`} title={folder ? t('fileExplorer.gitFolder') : t(GIT_STATE_LABEL[state])} data-testid="explorer-git">
      {folder ? '•' : GIT_STATE_LETTER[state]}
    </span>
  )
}

/** 行に付ける git の色のクラス */
function gitClass(state: GitFileState | null): string {
  return state ? ` git-${state}` : ''
}

function gitStateOf(git: GitDecorations | null, path: string, kind: FsEntry['kind']): GitFileState | null {
  return git ? gitStateFor(git, path, kind) : null
}

/** 削除の確認に出す名前の数（多いときは先頭だけ） */
const MAX_LISTED_DELETE_NAMES = 5

/** ショートカットの表記（メニューに出す。キーの処理は onTreeKeyDown） */
const KEYS = {
  cut: () => formatShortcut('Mod', 'X'),
  copy: () => formatShortcut('Mod', 'C'),
  paste: () => formatShortcut('Mod', 'V'),
  undo: () => formatShortcut('Mod', 'Z'),
  copyPath: () => (isMac() ? formatShortcut('Alt', 'Mod', 'C') : formatShortcut('Shift', 'Alt', 'C')),
  copyRelativePath: () => (isMac() ? formatShortcut('Alt', 'Shift', 'Mod', 'C') : formatShortcut('Ctrl', 'Shift', 'Alt', 'C')),
  reveal: () => (isMac() ? formatShortcut('Alt', 'Mod', 'R') : formatShortcut('Shift', 'Alt', 'R')),
  rename: () => (isMac() ? '↩' : 'F2'),
  delete: () => (isMac() ? formatShortcut('Mod', 'Backspace') : 'Delete')
}

export function FileExplorer({
  root,
  projectId = null,
  activePath,
  dirtyPaths,
  onOpen,
  onOpenSource,
  onQuickOpen,
  onRenamed,
  onDeleted
}: {
  /** 開いているプロジェクトのフォルダ。null なら案内だけ */
  root: string | null
  /** 開いているプロジェクト。開いたフォルダをプロジェクトごとに覚える（更新・再起動のあとも閉じない） */
  projectId?: string | null
  activePath: string | null
  dirtyPaths: ReadonlySet<string>
  onOpen: (path: string) => void
  /** 種類を問わずソース（コード）で開く。HTML は onOpen だと内蔵ブラウザのプレビューになる */
  onOpenSource?: (path: string) => void
  onQuickOpen: () => void
  /** 名前を変えた・動かした（開いているタブを追従させる） */
  onRenamed?: (from: string, to: string) => void
  /** ゴミ箱へ送った（開いているタブを閉じる） */
  onDeleted?: (paths: string[]) => void
}) {
  const t = useT()
  // ツリーの状態（開いたときに読む・外部の変更で読み直す）はフィードバックの右パネルと共用（fileTree.tsx）
  const tree = useFileTree(root, { expandedKey: root ? expandedStorageKey('files', projectId ?? root) : null })
  const { expanded, loading, toggleDir } = tree
  // git の色分け（変更・追跡外・.gitignore の対象）。git のリポジトリでなければ何も付けない
  const git = useGitDecorations(root)
  const [showHidden, setShowHidden] = useState(() => readLocal(SHOW_HIDDEN_KEY) === '1')
  const toggleHidden = () => {
    writeLocal(SHOW_HIDDEN_KEY, showHidden ? '0' : '1')
    setShowHidden(!showHidden)
  }
  // .DS_Store・.git は既定で出さない。隠したフォルダを開いていても中身ごと外す
  const rows = useMemo(() => (showHidden ? tree.rows : withoutHidden(tree.rows, isHiddenByDefault)), [tree.rows, showHidden])
  const [searchError, setSearchError] = useState<string | null>(null)
  const error = tree.error ?? searchError
  const [query, setQuery] = useState('')
  const [nameResults, setNameResults] = useState<string[]>([])
  const [searching, setSearching] = useState(false)
  const [truncated, setTruncated] = useState(false)

  const ops = useTreeOperations({ root, tree, rows, dirtyPaths, onOpen, onOpenSource, onRenamed, onDeleted })

  // プロジェクトが変わったら絞り込みも最初から
  useEffect(() => {
    setQuery('')
    setSearchError(null)
  }, [root])

  // ファイル名で絞り込む。打ち終わるのを少し待つ
  useEffect(() => {
    const trimmed = query.trim()
    if (!root || !trimmed) { setNameResults([]); setTruncated(false); return }
    let cancelled = false
    setSearching(true)
    const timer = window.setTimeout(() => {
      window.ade.invoke('fs:search', trimmed, 'names').then(
        (result) => {
          if (cancelled) return
          setNameResults(result.files)
          setTruncated(result.truncated)
          setSearching(false)
        },
        (err) => { if (!cancelled) { setSearchError(errorMessage(err)); setSearching(false) } }
      )
    }, SEARCH_DEBOUNCE_MS)
    return () => { cancelled = true; window.clearTimeout(timer) }
  }, [root, query])

  const searchingMode = query.trim().length > 0
  // 空のフォルダ（.git だけのものも）: 根を読み終えてから出す（読み込み中にちらつかせない）。根に作る欄を出している間は出さない
  const empty = !!root && !error && !searchingMode && tree.loaded && rows.every((r) => r.entry.path === '.git') && !(ops.editing?.mode === 'create' && ops.editing.parent === '')
  const treeMode = !!root && !error && !searchingMode

  return (
    <aside className="explorer" aria-label={t('fileExplorer.title')} data-testid="file-explorer">
      <header className="explorer__head">
        <span className="explorer__title">{t('fileExplorer.title')}</span>
        <span className="editor-head__spacer" />
        <IconButton size="sm" label={t('fileExplorer.newFile')} icon={<FilePlus size={14} />} disabled={!root} onClick={() => ops.startCreate('file', ops.targetDir(null))} data-testid="explorer-new-file" />
        <IconButton size="sm" label={t('fileExplorer.newFolder')} icon={<FolderPlus size={14} />} disabled={!root} onClick={() => ops.startCreate('directory', ops.targetDir(null))} data-testid="explorer-new-folder" />
        <IconButton size="sm" label={t('fileExplorer.quickOpen', { shortcut: SHORTCUTS.quickOpen() })} icon={<FileSearch size={14} />} onClick={onQuickOpen} disabled={!root} />
        <IconButton size="sm" label={t('fileExplorer.refresh')} icon={<RefreshCw size={13} />} disabled={!root} onClick={tree.refresh} />
        <IconButton size="sm" label={t('fileExplorer.collapseAll')} icon={<ListCollapse size={14} />} disabled={!root} onClick={tree.collapseAll} />
      </header>

      {root && (
        <div className="explorer__query">
          <label className="explorer__search">
            <Search size={13} aria-hidden="true" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Escape') setQuery('') }}
              placeholder={t('fileExplorer.filter')}
              aria-label={t('fileExplorer.filter')}
              data-testid="explorer-query"
            />
            {searching && <Spinner size={12} />}
          </label>
        </div>
      )}

      <div
        className={`explorer__body${ops.dropTarget === '' ? ' is-drop' : ''}`}
        data-testid="explorer-body"
        // 一覧の下の空いた所も含めて、右クリック・貼り付け・ドロップを受ける（プロジェクト直下が対象）
        {...(treeMode ? {
          tabIndex: -1,
          onContextMenu: (e: MouseEvent) => ops.openMenu(e, null),
          onKeyDown: ops.onTreeKeyDown,
          onCopy: ops.onClipboardEvent,
          onCut: ops.onClipboardEvent,
          onPaste: ops.onClipboardEvent,
          onMouseDown: ops.onBodyMouseDown,
          onDragOver: (e: DragEvent) => ops.onDragOver(e, null),
          onDragLeave: ops.onDragLeave,
          onDrop: (e: DragEvent) => ops.onDrop(e, null)
        } : {})}
      >
        {!root ? (
          <p className="explorer__note">{t('fileExplorer.empty')}</p>
        ) : error ? (
          <p className="explorer__note">{error}</p>
        ) : searchingMode ? (
          <ul className="explorer__list">
            {nameResults.map((path) => {
              const gitState = gitStateOf(git, path, 'file')
              return (
                <li key={path}>
                  <button type="button" className={`explorer__row${path === activePath ? ' is-active' : ''}${gitClass(gitState)}`} onClick={() => onOpen(path)} title={path}>
                    <FileIcon name={baseName(path)} kind="file" />
                    <span className="explorer__name">{baseName(path)}</span>
                    <span className="explorer__dir">{parentDir(path)}</span>
                    {dirtyPaths.has(path) && <span className="explorer__badge" title={t('fileExplorer.unsaved')}>M</span>}
                    <GitMark state={gitState} kind="file" />
                  </button>
                </li>
              )
            })}
            {!searching && nameResults.length === 0 && <p className="explorer__note">{t('fileExplorer.noMatches')}</p>}
          </ul>
        ) : (
          <>
          {(rows.length > 0 || ops.editing) && (
          <ul
            className={`explorer__list${empty ? '' : ' explorer__list--tree'}`}
            role="tree"
            aria-multiselectable="true"
            data-testid="explorer-tree"
          >
            {ops.editing?.mode === 'create' && ops.editing.parent === '' && <NameInput ops={ops} depth={0} />}
            {rows.map(({ entry, depth }) => {
              const isDir = entry.kind === 'directory'
              const open = isDir && expanded.has(entry.path)
              const selected = ops.selected.has(entry.path)
              const renaming = ops.editing?.mode === 'rename' && ops.editing.path === entry.path
              const cut = ops.clipboard?.mode === 'cut' && ops.clipboard.paths.some((p) => isSameOrUnder(entry.path, p))
              const dropping = ops.dropTarget !== null && ops.dropTarget !== '' && isSameOrUnder(entry.path, ops.dropTarget)
              const gitState = gitStateOf(git, entry.path, entry.kind)
              return (
                <Fragment key={entry.path}>
                <li role="treeitem" aria-expanded={isDir ? open : undefined} aria-selected={selected}>
                  {renaming ? <NameInput ops={ops} depth={depth} entry={entry} /> : (
                  <button
                    type="button"
                    className={`explorer__row${entry.path === activePath ? ' is-active' : ''}${selected ? ' is-selected' : ''}${entry.collapsed ? ' is-heavy' : ''}${cut ? ' is-cut' : ''}${dropping ? ' is-drop' : ''}${gitClass(gitState)}`}
                    style={{ '--depth': depth } as React.CSSProperties}
                    onClick={(e) => ops.onRowClick(e, entry, () => (isDir ? toggleDir(entry) : onOpen(entry.path)))}
                    onContextMenu={(e) => ops.openMenu(e, entry)}
                    draggable
                    onDragStart={(e) => ops.onDragStart(e, entry)}
                    onDragEnd={ops.onDragEnd}
                    onDragOver={(e) => ops.onDragOver(e, entry)}
                    onDrop={(e) => ops.onDrop(e, entry)}
                    title={gitState === 'ignored' ? `${entry.path}\n${t('fileExplorer.gitIgnored')}` : entry.path}
                    data-testid="explorer-row"
                    data-path={entry.path}
                    data-git={gitState ?? undefined}
                  >
                    {isDir
                      ? <ChevronRight size={12} className={`explorer__chevron${open ? ' is-open' : ''}`} aria-hidden="true" />
                      : <span className="explorer__chevron-space" />}
                    <FileIcon name={entry.name} kind={entry.kind} open={open} />
                    <span className="explorer__name">{entry.name}</span>
                    {loading.has(entry.path) && <Spinner size={10} />}
                    {dirtyPaths.has(entry.path) && <span className="explorer__badge" title={t('fileExplorer.unsaved')}>M</span>}
                    <GitMark state={gitState} kind={entry.kind} />
                  </button>
                  )}
                </li>
                {ops.editing?.mode === 'create' && isDir && ops.editing.parent === entry.path && open && <NameInput ops={ops} depth={depth + 1} />}
                </Fragment>
              )
            })}
          </ul>
          )}
          {empty && (
            <div className="explorer__empty" data-testid="explorer-empty">
              <p className="explorer__empty-title">{t('fileExplorer.emptyFolder')}</p>
              <p className="explorer__empty-hint">{t('fileExplorer.emptyHint')}</p>
              <div className="explorer__empty-actions">
                <Button icon={<FilePlus size={13} />} onClick={() => ops.startCreate('file', '')} data-testid="explorer-empty-new-file">{t('fileExplorer.newFile')}</Button>
                <Button icon={<FolderPlus size={13} />} onClick={() => ops.startCreate('directory', '')} data-testid="explorer-empty-new-folder">{t('fileExplorer.newFolder')}</Button>
              </div>
            </div>
          )}
          </>
        )}
        {searchingMode && truncated && <p className="explorer__note">{t('fileExplorer.truncated')}</p>}
        {!searchingMode && ops.actionError && <p className="explorer__note explorer__note--error explorer__note--sticky" role="alert" data-testid="explorer-error">{ops.actionError}</p>}
        {!searchingMode && ops.notice && <p className="explorer__note explorer__note--sticky" role="status" data-testid="explorer-notice">{ops.notice}</p>}
      </div>

      {ops.menu && <TreeMenu ops={ops} showHidden={showHidden} onToggleHidden={toggleHidden} />}
      {ops.confirmDelete && <DeleteDialog paths={ops.confirmDelete.paths} dirty={[...dirtyPaths].filter((p) => ops.confirmDelete!.paths.some((d) => isSameOrUnder(p, d)))} onCancel={() => ops.setConfirmDelete(null)} onConfirm={() => ops.trash(ops.confirmDelete!.paths, ops.confirmDelete!.record)} />}
    </aside>
  )
}

type TreeOps = ReturnType<typeof useTreeOperations>

/** 作成・名前の変更・削除・切り取り / コピー / 貼り付け・ドラッグ・元に戻すと、選択・右クリックのメニュー */
function useTreeOperations({
  root,
  tree,
  rows,
  dirtyPaths,
  onOpen,
  onOpenSource,
  onRenamed,
  onDeleted
}: {
  root: string | null
  tree: ReturnType<typeof useFileTree>
  rows: FileTreeRow[]
  dirtyPaths: ReadonlySet<string>
  onOpen: (path: string) => void
  onOpenSource?: (path: string) => void
  onRenamed?: (from: string, to: string) => void
  onDeleted?: (paths: string[]) => void
}) {
  const t = useT()
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set())
  const anchor = useRef<string | null>(null)
  const [editing, setEditing] = useState<Editing | null>(null)
  const [value, setValue] = useState('')
  const [inputError, setInputError] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [notice, setNoticeState] = useState<string | null>(null)
  const [menu, setMenu] = useState<{ x: number; y: number; entry: FsEntry | null } | null>(null)
  /** 削除の確認。record が false なら元に戻すの履歴に積まない（元に戻すで消すとき） */
  const [confirmDelete, setConfirmDelete] = useState<{ paths: string[]; record: boolean } | null>(null)
  const [busy, setBusy] = useState(false)
  /** アプリの中のクリップボード（切り取り・コピーしたパス） */
  const [clipboard, setClipboard] = useState<{ mode: 'copy' | 'cut'; paths: string[] } | null>(null)
  /**
   * ツリーでコピーしたあとに、ほかのアプリ（Finder など）へ移ったか。移ったなら、そこでコピーしたファイル・画像を先に貼る
   * （OS のクリップボードの方が新しいことが多い。無ければツリーでコピーしたものを貼る）
   */
  const clipboardStale = useRef(false)
  useEffect(() => {
    const onBlur = () => { clipboardStale.current = true }
    window.addEventListener('blur', onBlur)
    return () => window.removeEventListener('blur', onBlur)
  }, [])
  const [history, setHistory] = useState<HistoryEntry[]>([])
  /** ドラッグを落とす先のフォルダ（'' は根）。null なら落とす先なし */
  const [dropTarget, setDropTarget] = useState<string | null>(null)
  /** ツリーの中から運んでいるパス（外からのドロップと区別する） */
  const dragging = useRef<string[] | null>(null)
  /** 操作のあとで、このパスの行にフォーカスを戻す（ツリーが読み直されてから） */
  const focusAfter = useRef<string | null>(null)
  const noticeTimer = useRef<number | undefined>(undefined)
  const lastKeyAction = useRef(0)

  const setNotice = (message: string | null) => {
    window.clearTimeout(noticeTimer.current)
    setNoticeState(message)
    if (message) noticeTimer.current = window.setTimeout(() => setNoticeState(null), NOTICE_MS)
  }
  useEffect(() => () => window.clearTimeout(noticeTimer.current), [])

  // プロジェクトが変わったら選択・入力・クリップボード・履歴を捨てる
  useEffect(() => {
    setSelected(new Set())
    anchor.current = null
    setEditing(null)
    setActionError(null)
    setNoticeState(null)
    setMenu(null)
    setConfirmDelete(null)
    setClipboard(null)
    setHistory([])
    setDropTarget(null)
  }, [root])

  // 消えた行は選択から外す（まだ読み込まれていない行＝いま作った・動かした先は残す）
  const shownBefore = useRef<ReadonlySet<string>>(new Set())
  useEffect(() => {
    const visible = new Set(rows.map((r) => r.entry.path))
    const before = shownBefore.current
    const gone = (p: string) => before.has(p) && !visible.has(p)
    shownBefore.current = visible
    setSelected((set) => ([...set].some(gone) ? new Set([...set].filter((p) => !gone(p))) : set))
    const path = focusAfter.current
    if (path && visible.has(path)) {
      focusAfter.current = null
      document.querySelector<HTMLElement>(`[data-testid="explorer-row"][data-path="${CSS.escape(path)}"]`)?.focus()
    }
  }, [rows])

  // メニューは外側のクリックと Esc で閉じる
  useEffect(() => {
    if (!menu) return
    const close = (event: globalThis.MouseEvent) => { if (!(event.target as HTMLElement).closest('.explorer-menu')) setMenu(null) }
    const onKey = (event: globalThis.KeyboardEvent) => { if (event.key === 'Escape') setMenu(null) }
    const onBlur = () => setMenu(null)
    window.addEventListener('mousedown', close)
    window.addEventListener('keydown', onKey)
    window.addEventListener('blur', onBlur, { once: true })
    // blur も外す（メニューを開くたびに、外されない blur の見張りが増えていた）
    return () => { window.removeEventListener('mousedown', close); window.removeEventListener('keydown', onKey); window.removeEventListener('blur', onBlur) }
  }, [menu])

  const entryOf = (path: string): FsEntry | undefined => rows.find((r) => r.entry.path === path)?.entry

  /** 新しく作る・貼り付ける場所。フォルダならその中、ファイルならその親、何も無ければ根 */
  const targetDir = (entry: FsEntry | null): string => {
    const base = entry ?? (selected.size === 1 ? entryOf([...selected][0]!) : undefined) ?? null
    if (!base) return ''
    return base.kind === 'directory' ? base.path : parentDir(base.path)
  }

  const siblingsOf = (dir: string): FsEntry[] => rows.map((r) => r.entry).filter((e) => parentDir(e.path) === dir)

  const pushHistory = (entry: HistoryEntry) => setHistory((list) => [...list.slice(-(MAX_HISTORY - 1)), entry])

  const selectPaths = (paths: string[]) => {
    setSelected(new Set(paths))
    anchor.current = paths[0] ?? null
    if (paths[0]) focusAfter.current = paths[0]
  }

  const startCreate = (kind: FsEntry['kind'], parent: string) => {
    setMenu(null)
    setActionError(null)
    if (parent) tree.expandDir(parent)
    setEditing({ mode: 'create', parent, kind })
    setValue('')
    setInputError(null)
  }

  const startRename = (entry: FsEntry) => {
    setMenu(null)
    setActionError(null)
    setEditing({ mode: 'rename', path: entry.path, kind: entry.kind })
    setValue(entry.name)
    setInputError(null)
  }

  const askDelete = (paths: string[], record = true) => {
    setMenu(null)
    setActionError(null)
    if (paths.length > 0) setConfirmDelete({ paths, record })
  }

  /** 打っている間の案内（使えない名前・同じフォルダに同じ名前）。最終的な検査は main */
  const hintFor = (name: string): string | null => {
    if (!editing || name === '') return null
    // 作成では「a/b/c.ts」のように / で途中のフォルダも作れる。名前の変更は1階層だけ
    const parts = editing.mode === 'create' ? nestedNameParts(name) : [name]
    const problem = editing.mode === 'create' ? nestedNameProblem(name) : nestedNameProblem(name.replace(/\//g, '\\'))
    if (problem) return t(ENTRY_NAME_PROBLEM_KEYS[problem])
    if (parts.length > 1) return null
    const dir = editing.mode === 'create' ? editing.parent : parentDir(editing.path)
    const self = editing.mode === 'rename' ? editing.path : null
    const clash = siblingsOf(dir).find((e) => e.path !== self && e.name.toLowerCase() === name.toLowerCase())
    return clash ? t('files.errors.exists', { name: clash.name }) : null
  }

  const cancelEdit = () => {
    const back = editing?.mode === 'rename' ? editing.path : null
    setEditing(null)
    setInputError(null)
    if (back) focusAfter.current = back
  }

  /** 動いたもの（名前の変更・移動）をツリーと開いているタブに反映する */
  const applyMoves = (moves: FsTransfer[]) => {
    const real = moves.filter((m) => m.from !== m.to)
    for (const { from, to } of real) {
      tree.moveDir(from, to)
      onRenamed?.(from, to)
    }
    for (const dir of new Set(real.flatMap((m) => [parentDir(m.from), parentDir(m.to)]))) tree.reloadDir(dir)
  }

  /** 入力を確定する。keepOpen なら失敗しても欄を残して直してもらう（Enter）。欄から離れたときは閉じて知らせる */
  const commit = async (keepOpen: boolean) => {
    if (!editing || busy) return
    const name = value
    const unchanged = editing.mode === 'rename' && name === baseName(editing.path)
    if (name.trim() === '' || unchanged) { cancelEdit(); return }
    setBusy(true)
    try {
      if (editing.mode === 'create') {
        const created = await window.ade.invoke('fs:create', editing.parent, name, editing.kind)
        // 途中のフォルダを作ったなら、開いて見えるようにする
        const parts = nestedNameParts(name)
        let dir = editing.parent
        tree.reloadDir(dir)
        for (const part of parts.slice(0, -1)) {
          dir = dir ? `${dir}/${part}` : part
          tree.expandDir(dir)
          tree.reloadDir(dir)
        }
        setEditing(null)
        selectPaths([created.path])
        pushHistory({ kind: 'create', top: created.top })
        // 作ったばかりのファイルは中身が無いので、HTML でもプレビューではなくソースで開く
        if (editing.kind === 'file') (onOpenSource ?? onOpen)(created.path)
      } else {
        const from = editing.path
        const to = await window.ade.invoke('fs:rename', from, name)
        applyMoves([{ from, to }])
        setEditing(null)
        selectPaths([to])
        pushHistory({ kind: 'rename', from, to })
      }
      setInputError(null)
    } catch (err) {
      if (keepOpen) setInputError(errorMessage(err))
      else { setEditing(null); setInputError(null); setActionError(errorMessage(err)) }
    } finally {
      setBusy(false)
    }
  }

  /** ゴミ箱へ送る。record が false なら履歴に積まない（元に戻すで、作ったもの・コピーしたものを消すとき） */
  const trash = async (paths: string[], record = true) => {
    setConfirmDelete(null)
    setBusy(true)
    try {
      const trashed = await window.ade.invoke('fs:trash', paths)
      onDeleted?.(trashed)
      setSelected(new Set())
      setClipboard((clip) => (clip && clip.paths.some((p) => trashed.some((d) => isSameOrUnder(p, d))) ? null : clip))
      if (record) pushHistory({ kind: 'trash' })
      // 消したものの隣の行へフォーカスを移す
      const firstIndex = rows.findIndex((r) => trashed.includes(r.entry.path))
      const next = rows.slice(firstIndex + 1).find((r) => !trashed.some((p) => isSameOrUnder(r.entry.path, p)))
        ?? rows.slice(0, Math.max(0, firstIndex)).reverse().find((r) => !trashed.some((p) => isSameOrUnder(r.entry.path, p)))
      if (next) focusAfter.current = next.entry.path
    } catch (err) {
      setActionError(errorMessage(err))
    } finally {
      setBusy(false)
      for (const dir of new Set(paths.map(parentDir))) tree.reloadDir(dir)
    }
  }

  /** ファイルの操作を1つ走らせる（重ねて走らせない・失敗はツリーの下に出す） */
  const run = async (action: () => Promise<void>) => {
    if (busy) return
    setMenu(null)
    setActionError(null)
    setNotice(null)
    setBusy(true)
    try {
      await action()
    } catch (err) {
      setActionError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  /** コピーを作った（貼り付け・複製・ドラッグでコピー・取り込み）。作った先を読み直して選ぶ */
  const afterCopied = (dest: string, done: FsTransfer[]) => {
    if (dest) tree.expandDir(dest)
    tree.reloadDir(dest)
    if (done.length === 0) return
    selectPaths(done.map((d) => d.to))
    pushHistory({ kind: 'copy', created: done.map((d) => d.to) })
  }

  const copyTo = (paths: string[], dest: string) => run(async () => {
    afterCopied(dest, await window.ade.invoke('fs:copy', paths, dest))
  })

  const moveTo = (paths: string[], dest: string) => run(async () => {
    const moves = await window.ade.invoke('fs:move', paths, dest)
    applyMoves(moves)
    if (dest) tree.expandDir(dest)
    tree.reloadDir(dest)
    selectPaths(moves.map((m) => m.to))
    if (moves.some((m) => m.from !== m.to)) pushHistory({ kind: 'move', moves: moves.filter((m) => m.from !== m.to) })
  })

  const cut = (paths: string[]) => { setMenu(null); if (paths.length > 0) { clipboardStale.current = false; setClipboard({ mode: 'cut', paths }) } }
  const copy = (paths: string[]) => { setMenu(null); if (paths.length > 0) { clipboardStale.current = false; setClipboard({ mode: 'copy', paths }) } }

  /**
   * 貼り付け。ツリーでコピー・切り取りしたものがあれば、それを貼る（ほかのアプリへ移ったあとなら、OS のクリップボードを先に見る）。
   * 無ければ OS のクリップボードのファイル（Finder などでコピーした画像・動画・フォルダ）か画像を、このフォルダへ取り込む
   * （main が読んで写し、作ったものの名前だけが返る。fs:pasteClipboard）
   */
  const paste = (dest: string) => {
    const clip = clipboard
    setMenu(null)
    if (!clip || clipboardStale.current) {
      void run(async () => {
        const pasted = await window.ade.invoke('fs:pasteClipboard', dest)
        if (pasted.kind === 'none') {
          if (clip) pasteTree(clip, dest)
          else setNotice(t('fileExplorer.pasteNothing'))
          return
        }
        afterCopied(dest, pasted.created.map((to) => ({ from: '', to })))
      })
      return
    }
    pasteTree(clip, dest)
  }

  /** ツリーでコピー・切り取りしたものを貼る。コピーしたフォルダそのものの上なら、その隣（親）へ貼る */
  const pasteTree = (clip: { mode: 'copy' | 'cut'; paths: string[] }, dest: string) => {
    if (clip.mode === 'copy') {
      const target = clip.paths.includes(dest) ? parentDir(dest) : dest
      void copyTo(clip.paths, target)
      return
    }
    setClipboard(null)
    void moveTo(clip.paths, dest)
  }

  /** 複製: それぞれ同じフォルダに「名前 copy」を作る */
  const duplicate = (paths: string[]) => run(async () => {
    const byParent = new Map<string, string[]>()
    for (const path of paths) byParent.set(parentDir(path), [...(byParent.get(parentDir(path)) ?? []), path])
    const created: FsTransfer[] = []
    for (const [dir, group] of byParent) {
      const done = await window.ade.invoke('fs:copy', group, dir)
      tree.reloadDir(dir)
      created.push(...done)
    }
    afterCopied(parentDir(paths[0] ?? ''), created)
  })

  const copyPath = (paths: string[], kind: 'absolute' | 'relative') => run(async () => {
    await window.ade.invoke('fs:copyPath', paths.length > 0 ? paths : [''], kind)
    setNotice(t('fileExplorer.pathCopied'))
  })

  const reveal = (path: string) => run(async () => { await window.ade.invoke('fs:reveal', path) })

  const openExternally = (path: string) => run(async () => { await window.ade.invoke('fs:openExternal', path) })

  const openInTerminal = (path: string) => run(async () => {
    requestTerminalAt(await window.ade.invoke('fs:terminalDir', path))
  })

  /** 外から落としたもの（Finder・エクスプローラー）をコピーして取り込む */
  const importDropped = (dataTransfer: DataTransfer, dest: string) => {
    // files はイベントの間しか読めないので、ここで先に読み出す（readDrop は同期の部分で File を取り出す）
    const pending = readDrop(dataTransfer)
    void run(async () => {
      const entries = await pending
      if (entries.length === 0) return
      afterCopied(dest, await window.ade.invoke('fs:import', entries.map((e) => e.path), dest))
    })
  }

  /** 元に戻す（直前の作成・名前の変更・移動・貼り付け・複製）。削除はゴミ箱から戻せることを知らせる */
  const undo = () => {
    setMenu(null)
    const last = history.at(-1)
    if (!last || busy) return
    setHistory((list) => list.slice(0, -1))
    if (last.kind === 'trash') {
      setActionError(null)
      setNotice(window.ade?.platform === 'win32' ? t('fileExplorer.undoTrashWin') : t('fileExplorer.undoTrash'))
      return
    }
    if (last.kind === 'create' || last.kind === 'copy') {
      const paths = last.kind === 'create' ? [last.top] : last.created
      // 未保存の変更があるタブが閉じるときは、削除と同じ確認を出す
      if ([...dirtyPaths].some((p) => paths.some((d) => isSameOrUnder(p, d)))) { askDelete(paths, false); return }
      void trash(paths, false).then(() => setNotice(t('fileExplorer.undone')))
      return
    }
    void run(async () => {
      if (last.kind === 'rename') {
        const back = await window.ade.invoke('fs:rename', last.to, baseName(last.from))
        applyMoves([{ from: last.to, to: back }])
        selectPaths([back])
      } else {
        const byParent = new Map<string, string[]>()
        for (const move of last.moves) byParent.set(parentDir(move.from), [...(byParent.get(parentDir(move.from)) ?? []), move.to])
        const back: FsTransfer[] = []
        for (const [dir, paths] of byParent) {
          const moves = await window.ade.invoke('fs:move', paths, dir)
          applyMoves(moves)
          back.push(...moves)
        }
        selectPaths(back.map((m) => m.to))
      }
      setNotice(t('fileExplorer.undone'))
    })
  }

  const onRowClick = (event: MouseEvent, entry: FsEntry, activate: () => void) => {
    setActionError(null)
    const toggle = isMac() ? event.metaKey : event.ctrlKey
    if (toggle) {
      setSelected((set) => { const next = new Set(set); if (next.has(entry.path)) next.delete(entry.path); else next.add(entry.path); return next })
      anchor.current = entry.path
      return
    }
    if (event.shiftKey && anchor.current) {
      const paths = rows.map((r) => r.entry.path)
      const a = paths.indexOf(anchor.current)
      const b = paths.indexOf(entry.path)
      if (a !== -1 && b !== -1) {
        setSelected(new Set(paths.slice(Math.min(a, b), Math.max(a, b) + 1)))
        return
      }
    }
    setSelected(new Set([entry.path]))
    anchor.current = entry.path
    activate()
  }

  /** 一覧の下の空いた所を押したら選択を外す（貼り付け・作成の先が根になる）。キーを受けられるよう一覧にフォーカスを置く */
  const onBodyMouseDown = (event: MouseEvent) => {
    const target = event.target as HTMLElement
    if (target.closest('[data-testid="explorer-row"], input, button, .explorer-menu')) return
    if (event.button === 0) setSelected(new Set())
    ;(event.currentTarget as HTMLElement).focus({ preventScroll: true })
  }

  const openMenu = (event: MouseEvent, entry: FsEntry | null) => {
    event.preventDefault()
    event.stopPropagation()
    if (!root) return
    if (entry && !selected.has(entry.path)) {
      setSelected(new Set([entry.path]))
      anchor.current = entry.path
    }
    if (!entry) setSelected(new Set())
    // 位置は窓の内側に収まるよう、描いたあとで TreeMenu が寄せる
    setMenu({ x: event.clientX, y: event.clientY, entry })
  }

  /** 操作の対象。フォーカスのある行が選択の中なら選択全部、外ならその行だけ */
  const targetsFor = (focused: string | null): string[] => {
    if (focused && !selected.has(focused)) return [focused]
    return [...selected]
  }

  const onTreeKeyDown = (event: KeyboardEvent) => {
    if (editing || (event.target as HTMLElement).tagName === 'INPUT') return
    const focused = (event.target as HTMLElement).closest<HTMLElement>('[data-testid="explorer-row"]')?.dataset.path ?? null
    const mac = isMac()
    const mod = mac ? event.metaKey : event.ctrlKey
    const handled = () => { event.preventDefault(); lastKeyAction.current = performance.now() }
    const renameKey = event.key === 'F2' || (mac && event.key === 'Enter' && !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey)
    if (renameKey) {
      const entry = focused ? entryOf(focused) : selected.size === 1 ? entryOf([...selected][0]!) : undefined
      if (!entry) return
      event.preventDefault()
      setSelected(new Set([entry.path]))
      startRename(entry)
      return
    }
    const deleteKey = (event.key === 'Delete' && !event.altKey) || (mac && event.key === 'Backspace' && event.metaKey)
    if (deleteKey) {
      const targets = targetsFor(focused)
      if (targets.length === 0) return
      event.preventDefault()
      askDelete(targets)
      return
    }
    // ⌥ を押すと event.key が別の文字になる（macOS の ⌥C は ç）ので、文字のキーは code で見る
    const code = event.code
    // パスをコピー（macOS ⌥⌘C / ⌥⇧⌘C、ほか Shift+Alt+C / Ctrl+Shift+Alt+C）・Finder で表示（⌥⌘R / Shift+Alt+R）
    const pathKey = code === 'KeyC' && event.altKey && (mac ? event.metaKey : event.shiftKey)
    if (pathKey) {
      handled()
      const relative = mac ? event.shiftKey : event.ctrlKey
      void copyPath(targetsFor(focused), relative ? 'relative' : 'absolute')
      return
    }
    if (code === 'KeyR' && event.altKey && (mac ? event.metaKey : event.shiftKey && !event.ctrlKey)) {
      handled()
      void reveal(focused ?? [...selected][0] ?? '')
      return
    }
    if (mod && !event.altKey && !event.shiftKey) {
      if (code === 'KeyC' || code === 'KeyX') {
        const targets = targetsFor(focused)
        if (targets.length === 0) return
        handled()
        if (code === 'KeyC') copy(targets)
        else cut(targets)
        return
      }
      if (code === 'KeyV') {
        handled()
        paste(targetDir(focused ? entryOf(focused) ?? null : null))
        return
      }
      if (code === 'KeyZ') {
        handled()
        undo()
        return
      }
    }
    if (event.key === 'Escape') {
      if (clipboard?.mode === 'cut') setClipboard(null)
      if (selected.size > 0) setSelected(new Set())
    }
  }

  /**
   * メニューの「編集」（切り取り・コピー・貼り付けの役割）から届くクリップボードのイベント。
   * キーで処理した直後に同じ操作が届いたら無視する（重ねて貼り付けない）
   */
  const onClipboardEvent = (event: ClipboardEvent) => {
    if (editing || (event.target as HTMLElement).tagName === 'INPUT') return
    event.preventDefault()
    if (performance.now() - lastKeyAction.current < CLIPBOARD_EVENT_DEDUPE_MS) return
    const focused = (event.target as HTMLElement).closest<HTMLElement>('[data-testid="explorer-row"]')?.dataset.path ?? null
    if (event.type === 'copy') copy(targetsFor(focused))
    else if (event.type === 'cut') cut(targetsFor(focused))
    else paste(targetDir(focused ? entryOf(focused) ?? null : null))
  }

  // ── ドラッグ＆ドロップ ──
  const dropDirFor = (entry: FsEntry | null): string => (!entry ? '' : entry.kind === 'directory' ? entry.path : parentDir(entry.path))

  const onDragStart = (event: DragEvent, entry: FsEntry) => {
    const paths = selected.has(entry.path) ? [...selected] : [entry.path]
    if (!selected.has(entry.path)) { setSelected(new Set([entry.path])); anchor.current = entry.path }
    dragging.current = paths
    event.dataTransfer.setData(TREE_DRAG_TYPE, JSON.stringify(paths))
    event.dataTransfer.effectAllowed = 'copyMove'
  }

  const onDragEnd = () => { dragging.current = null; setDropTarget(null) }

  const onDragOver = (event: DragEvent, entry: FsEntry | null) => {
    const types = Array.from(event.dataTransfer.types)
    const internal = types.includes(TREE_DRAG_TYPE) && dragging.current !== null
    const external = !internal && types.includes('Files')
    if (!internal && !external) return
    event.preventDefault()
    event.stopPropagation()
    const dest = dropDirFor(entry)
    // 自分自身・自分の下へは落とせない（移動のときは、もともとある場所もそのまま）
    const blocked = internal && dragging.current!.some((p) => isSameOrUnder(dest, p))
    event.dataTransfer.dropEffect = blocked ? 'none' : external || isCopyModifier(event) ? 'copy' : 'move'
    setDropTarget(blocked ? null : dest)
  }

  const onDragLeave = (event: DragEvent) => {
    if (!(event.currentTarget as HTMLElement).contains(event.relatedTarget as Node | null)) setDropTarget(null)
  }

  const onDrop = (event: DragEvent, entry: FsEntry | null) => {
    const types = Array.from(event.dataTransfer.types)
    const dest = dropDirFor(entry)
    if (types.includes(TREE_DRAG_TYPE) && dragging.current) {
      event.preventDefault()
      event.stopPropagation()
      const paths = dragging.current
      dragging.current = null
      setDropTarget(null)
      if (paths.some((p) => isSameOrUnder(dest, p))) return
      if (isCopyModifier(event)) void copyTo(paths, dest)
      else void moveTo(paths, dest)
      return
    }
    if (types.includes('Files')) {
      event.preventDefault()
      event.stopPropagation()
      setDropTarget(null)
      importDropped(event.dataTransfer, dest)
    }
  }

  return {
    root, selected, editing, value, setValue, inputError, setInputError, actionError, notice, menu, confirmDelete, setConfirmDelete, busy,
    clipboard, history, dropTarget,
    targetDir, startCreate, startRename, askDelete, hintFor, cancelEdit, commit, trash, onRowClick, openMenu, onTreeKeyDown, onClipboardEvent, onBodyMouseDown,
    onDragStart, onDragEnd, onDragOver, onDragLeave, onDrop,
    cut, copy, paste, duplicate, copyPath, reveal, openExternally, openInTerminal, undo, onOpen, onOpenSource, entryOf, dirtyPaths,
    closeMenu: () => setMenu(null)
  }
}

/** ツリーの中のその場の名前の欄 */
function NameInput({ ops, depth, entry }: { ops: TreeOps; depth: number; entry?: FsEntry }) {
  const t = useT()
  const ref = useRef<HTMLInputElement>(null)
  const kind = ops.editing?.kind ?? 'file'
  const hint = ops.inputError ?? ops.hintFor(ops.value)

  // 名前の変更では拡張子の手前までを選ぶ（VS Code と同じ）
  useEffect(() => {
    const input = ref.current
    if (!input) return
    input.focus()
    if (entry) {
      const dot = entry.kind === 'file' ? entry.name.lastIndexOf('.') : -1
      input.setSelectionRange(0, dot > 0 ? dot : entry.name.length)
    }
  }, [entry])

  const field = (
    <div className="explorer__row explorer__row--input" style={{ '--depth': depth } as React.CSSProperties}>
      <span className="explorer__chevron-space" />
      {kind === 'directory' ? <Folder size={13} aria-hidden="true" /> : <FileText size={13} aria-hidden="true" />}
      <span className="explorer__input-wrap">
        <input
          ref={ref}
          className={`explorer__input${hint ? ' is-invalid' : ''}`}
          value={ops.value}
          spellCheck={false}
          autoComplete="off"
          placeholder={entry ? undefined : t('fileExplorer.namePlaceholder')}
          aria-label={entry ? `${t('fileExplorer.rename')}: ${entry.name}` : `${kind === 'directory' ? t('fileExplorer.newFolder') : t('fileExplorer.newFile')}: ${t('fileExplorer.nameLabel')}`}
          aria-invalid={hint ? true : undefined}
          readOnly={ops.busy}
          onChange={(e) => { ops.setValue(e.target.value); ops.setInputError(null) }}
          onKeyDown={(e) => {
            e.stopPropagation()
            if (e.key === 'Enter' && !e.nativeEvent.isComposing) { e.preventDefault(); void ops.commit(true) }
            if (e.key === 'Escape') { e.preventDefault(); ops.cancelEdit() }
          }}
          onBlur={() => { if (!ops.busy) void ops.commit(false) }}
          data-testid="explorer-name-input"
        />
        {hint && <span className="explorer__input-hint" role="alert" data-testid="explorer-name-hint">{hint}</span>}
      </span>
    </div>
  )
  // 名前の変更は行（li）の中に、作成は新しい行として出す
  return entry ? field : <li role="treeitem" aria-selected="true">{field}</li>
}

function MenuItem({ icon, label, shortcut, onClick, disabled, danger, testId }: {
  icon: React.ReactNode
  label: string
  shortcut?: string
  onClick: () => void
  disabled?: boolean
  danger?: boolean
  testId: string
}) {
  return (
    <button type="button" role="menuitem" className={danger ? 'is-danger' : undefined} disabled={disabled} onClick={onClick} data-testid={testId}>
      {icon}{label}
      {shortcut && <span className="explorer-menu__key">{shortcut}</span>}
    </button>
  )
}

/** 右クリックのメニュー。行の上ならその項目（選択中なら選択全部）、空いた所ならプロジェクト直下が対象 */
function TreeMenu({ ops, showHidden, onToggleHidden }: { ops: TreeOps; showHidden: boolean; onToggleHidden: () => void }) {
  const t = useT()
  const menu = ops.menu!
  const entry = menu.entry
  const targets = entry ? (ops.selected.has(entry.path) ? [...ops.selected] : [entry.path]) : []
  const single = targets.length === 1
  const here = entry?.path ?? ''
  const ref = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState({ left: menu.x, top: menu.y })
  const platform = window.ade?.platform
  const revealLabel = platform === 'darwin' ? t('fileExplorer.revealMac') : platform === 'win32' ? t('fileExplorer.revealWin') : t('fileExplorer.revealLinux')

  // 窓の端では内側へ寄せる（描いた大きさで決める）
  useLayoutEffect(() => {
    const node = ref.current
    if (!node) return
    const { width, height } = node.getBoundingClientRect()
    setPosition({
      left: Math.max(4, Math.min(menu.x, window.innerWidth - width - 4)),
      top: Math.max(4, Math.min(menu.y, window.innerHeight - height - 4))
    })
  }, [menu.x, menu.y])
  useEffect(() => { ref.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus() }, [])

  const sep = <div className="sb-menu__sep" role="separator" />
  return (
    <div
      ref={ref}
      className="sb-menu explorer-menu"
      role="menu"
      style={position}
      data-testid="explorer-menu"
      onKeyDown={(e) => {
        if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
        e.preventDefault()
        const items = [...(ref.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])]
        const at = items.indexOf(document.activeElement as HTMLButtonElement)
        items[(at + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length]?.focus()
      }}
    >
      {entry?.kind === 'file' && single && (
        <>
          <MenuItem icon={<FileText size={13} strokeWidth={1.75} />} label={t('fileExplorer.open')} onClick={() => { ops.closeMenu(); ops.onOpen(entry.path) }} testId="explorer-menu-open" />
          {ops.onOpenSource && isHtmlPath(entry.path) && (
            <MenuItem icon={<FileCode size={13} strokeWidth={1.75} />} label={t('editor.openHtmlSource')} onClick={() => { ops.closeMenu(); ops.onOpenSource?.(entry.path) }} testId="explorer-menu-open-source" />
          )}
          <MenuItem icon={<ExternalLink size={13} strokeWidth={1.75} />} label={t('viewer.openExternal')} onClick={() => void ops.openExternally(entry.path)} testId="explorer-menu-open-external" />
          {sep}
        </>
      )}
      <MenuItem icon={<FilePlus size={13} strokeWidth={1.75} />} label={t('fileExplorer.newFile')} onClick={() => ops.startCreate('file', ops.targetDir(entry))} testId="explorer-menu-new-file" />
      <MenuItem icon={<FolderPlus size={13} strokeWidth={1.75} />} label={t('fileExplorer.newFolder')} onClick={() => ops.startCreate('directory', ops.targetDir(entry))} testId="explorer-menu-new-folder" />
      {sep}
      {entry && (
        <>
          <MenuItem icon={<Scissors size={13} strokeWidth={1.75} />} label={t('fileExplorer.cut')} shortcut={KEYS.cut()} onClick={() => ops.cut(targets)} testId="explorer-menu-cut" />
          <MenuItem icon={<Copy size={13} strokeWidth={1.75} />} label={t('fileExplorer.copy')} shortcut={KEYS.copy()} onClick={() => ops.copy(targets)} testId="explorer-menu-copy" />
        </>
      )}
      <MenuItem icon={<ClipboardPaste size={13} strokeWidth={1.75} />} label={t('fileExplorer.paste')} shortcut={KEYS.paste()} onClick={() => ops.paste(ops.targetDir(entry))} testId="explorer-menu-paste" />
      {entry && <MenuItem icon={<CopyPlus size={13} strokeWidth={1.75} />} label={t('fileExplorer.duplicate')} onClick={() => void ops.duplicate(targets)} testId="explorer-menu-duplicate" />}
      {sep}
      <MenuItem icon={<Link size={13} strokeWidth={1.75} />} label={t('fileExplorer.copyPath')} shortcut={KEYS.copyPath()} onClick={() => void ops.copyPath(entry ? targets : [''], 'absolute')} testId="explorer-menu-copy-path" />
      {entry && <MenuItem icon={<Link size={13} strokeWidth={1.75} />} label={t('fileExplorer.copyRelativePath')} shortcut={KEYS.copyRelativePath()} onClick={() => void ops.copyPath(targets, 'relative')} testId="explorer-menu-copy-relative-path" />}
      {sep}
      <MenuItem icon={<FolderOpen size={13} strokeWidth={1.75} />} label={revealLabel} shortcut={KEYS.reveal()} disabled={!single && !!entry} onClick={() => void ops.reveal(here)} testId="explorer-menu-reveal" />
      <MenuItem icon={<SquareTerminal size={13} strokeWidth={1.75} />} label={t('fileExplorer.openInTerminal')} disabled={!single && !!entry} onClick={() => void ops.openInTerminal(here)} testId="explorer-menu-terminal" />
      {entry && (
        <>
          {sep}
          <MenuItem icon={<Pencil size={13} strokeWidth={1.75} />} label={t('fileExplorer.rename')} shortcut={KEYS.rename()} disabled={!single} onClick={() => ops.startRename(entry)} testId="explorer-menu-rename" />
          <MenuItem icon={<Trash2 size={13} strokeWidth={1.75} />} label={t('common.delete')} shortcut={KEYS.delete()} danger onClick={() => ops.askDelete(targets)} testId="explorer-menu-delete" />
        </>
      )}
      {sep}
      <MenuItem icon={<Undo2 size={13} strokeWidth={1.75} />} label={t('fileExplorer.undo')} shortcut={KEYS.undo()} disabled={ops.history.length === 0} onClick={ops.undo} testId="explorer-menu-undo" />
      {sep}
      <MenuItem
        icon={showHidden ? <EyeOff size={13} strokeWidth={1.75} /> : <Eye size={13} strokeWidth={1.75} />}
        label={showHidden ? t('fileExplorer.hideHidden') : t('fileExplorer.showHidden')}
        onClick={() => { ops.closeMenu(); onToggleHidden() }}
        testId="explorer-menu-toggle-hidden"
      />
    </div>
  )
}

/** 削除の確認（アプリ内のモーダル。ネイティブの確認は出さない） */
function DeleteDialog({ paths, dirty, onCancel, onConfirm }: { paths: string[]; dirty: string[]; onCancel: () => void; onConfirm: () => void }) {
  const t = useT()
  const heading = paths.length === 1 ? t('fileExplorer.deleteHeading', { name: baseName(paths[0]!) }) : t('fileExplorer.deleteHeadingMany', { count: paths.length })
  const listed = paths.slice(0, MAX_LISTED_DELETE_NAMES)
  return (
    <Modal className="rv-modal" label={heading} onClose={onCancel}>
      <div className="rv-modal__panel unsaved-dialog" data-testid="explorer-delete-dialog">
        <header className="rv-modal__head">
          <h2><Trash2 size={15} aria-hidden="true" />{heading}</h2>
        </header>
        {paths.length > 1 && (
          <ul className="explorer-delete__list">
            {listed.map((p) => <li key={p}>{p}</li>)}
            {paths.length > listed.length && <li>…</li>}
          </ul>
        )}
        <p className="unsaved-dialog__body">{window.ade?.platform === 'win32' ? t('fileExplorer.deleteBodyWin') : t('fileExplorer.deleteBody')}</p>
        {dirty.length > 0 && (
          <p className="unsaved-dialog__body explorer-delete__warn" data-testid="explorer-delete-unsaved">
            {t('fileExplorer.deleteUnsaved', { names: dirty.map(baseName).join(', ') })}
          </p>
        )}
        <div className="unsaved-dialog__actions">
          <span className="editor-head__spacer" />
          <Button variant="ghost" onClick={onCancel} data-testid="explorer-delete-cancel">{t('common.cancel')}</Button>
          <Button variant="danger" onClick={onConfirm} data-testid="explorer-delete-confirm">{t('common.delete')}</Button>
        </div>
      </div>
    </Modal>
  )
}
