import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode, type UIEvent } from 'react'
import { movedPath, type FsEntry } from '@shared/files'
import { parseExpanded, serializeExpanded } from '@shared/fileTreeState'
import { mergeListings } from '@shared/remoteFiles'
import { errorMessage } from '../lib/errors'
import { readLocal, writeLocal } from '../lib/localPref'

/**
 * プロジェクトのフォルダツリーの状態（右の Files パネルと、フィードバックの右パネルで共用する）。
 *
 * Orca由来: ~/bench/orca/src/renderer/src/components/right-sidebar/FileExplorer.tsx（MIT）
 *   - フォルダは開いたときに読む（fs:list。大きなリポジトリでも、開いた分しか読まない）
 *   - 外部の変更で、読み込み済みのフォルダだけを読み直す
 * 一覧に出すもの（.gitignore・重いフォルダの扱い）は main の fs:list が決めるので、どちらの画面でも同じになる。
 *
 * expandedKey を渡すと、開いているフォルダをこの端末に覚え、次に開いたときに戻す（プロジェクトごと）。
 */

export type FileTreeRow = { entry: FsEntry; depth: number }

/** 変更通知のまとめ待ち。Agent が続けて書くときに読み直しを1回にする */
const REFRESH_DEBOUNCE_MS = 200
/**
 * SSH のプロジェクトで、読み込み済みのフォルダを見に行く間隔。リモートには変更の知らせ（fs:changed）が無いので、
 * ターミナルや Agent がリモートで作った・消したファイルを、これで拾う（1回の ssh でまとめて読む。接続は使い回すので軽い）。
 * 2026-11-23 本人「sshのfile treeだが更新が遅い。ファイル作ったら即反映してほしい」
 */
export const REMOTE_POLL_MS = 1500

function parentDir(path: string): string {
  const slash = path.lastIndexOf('/')
  return slash === -1 ? '' : path.slice(0, slash)
}

interface FileTreeState {
  rows: FileTreeRow[]
  expanded: ReadonlySet<string>
  loading: ReadonlySet<string>
  /** 根が読めないときの理由 */
  error: string | null
  /** 根を読み終えた（空のフォルダの案内を、読み込み中にちらつかせない） */
  loaded: boolean
  toggleDir: (entry: FsEntry) => void
  /** 読み込み済みのフォルダをすべて読み直す */
  refresh: () => void
  collapseAll: () => void
  /** フォルダを開く（まだ読んでいなければ読む）。作成の入力欄をその中に出すとき */
  expandDir: (path: string) => void
  /** 1つのフォルダを読み直す（作成・名前の変更・削除のすぐ後。変更通知を待たない） */
  reloadDir: (path: string) => void
  /** フォルダの名前が変わった。開いていた状態を新しいパスへ移す */
  moveDir: (from: string, to: string) => void
}

export function useFileTree(root: string | null, options: { expandedKey?: string | null; poll?: boolean } = {}): FileTreeState {
  const { expandedKey = null, poll = false } = options
  const [children, setChildren] = useState<Map<string, FsEntry[]>>(new Map())
  const [expanded, setExpandedState] = useState<Set<string>>(new Set())
  const [loading, setLoading] = useState<Set<string>>(new Set())
  const [error, setError] = useState<string | null>(null)
  const childrenRef = useRef(children)
  childrenRef.current = children
  const expandedRef = useRef(expanded)
  expandedRef.current = expanded

  const setExpanded = useCallback((update: (prev: Set<string>) => Set<string>) => {
    setExpandedState((prev) => {
      const next = update(prev)
      if (expandedKey) writeLocal(expandedKey, serializeExpanded(next))
      return next
    })
  }, [expandedKey])

  const loadDir = useCallback(async (dir: string) => {
    setLoading((set) => new Set(set).add(dir))
    try {
      const entries = await window.ade.invoke('fs:list', dir)
      setChildren((map) => new Map(map).set(dir, entries))
      if (dir === '') setError(null)
    } catch (err) {
      // 消えたフォルダは一覧から外す。根が読めないときだけ理由を出す
      setChildren((map) => { const next = new Map(map); next.delete(dir); return next })
      if (dir === '') setError(errorMessage(err))
    } finally {
      setLoading((set) => { const next = new Set(set); next.delete(dir); return next })
    }
  }, [])

  // プロジェクトが変わったら最初から。覚えていた開閉の状態があれば、その分だけ読む
  useEffect(() => {
    setChildren(new Map())
    setError(null)
    const restored = expandedKey ? parseExpanded(readLocal(expandedKey)) : new Set<string>()
    setExpandedState(restored)
    if (!root) return
    void loadDir('')
    for (const dir of restored) void loadDir(dir)
  }, [root, expandedKey, loadDir])

  // 外部の変更。読み込み済みのフォルダだけを読み直す
  useEffect(() => {
    if (!root) return
    const pending = new Set<string>()
    let timer: number | undefined
    const off = window.ade.on('fs:changed', (event) => {
      for (const path of event.paths) {
        pending.add(parentDir(path))
        pending.add(path)
      }
      window.clearTimeout(timer)
      timer = window.setTimeout(() => {
        for (const dir of pending) if (childrenRef.current.has(dir)) void loadDir(dir)
        pending.clear()
      }, REFRESH_DEBOUNCE_MS)
    })
    return () => { off(); window.clearTimeout(timer) }
  }, [root, loadDir])

  // SSH のプロジェクト: 読み込み済みのフォルダを少しずつ見に行く（画面が見えている間だけ。前の問い合わせが終わるまで次を出さない）。
  // 窓に戻ってきたときはすぐ見る
  useEffect(() => {
    if (!root || !poll) return
    let busy = false
    let stopped = false
    const check = async () => {
      if (busy || stopped || document.visibilityState === 'hidden') return
      const dirs = [...childrenRef.current.keys()]
      if (dirs.length === 0) return
      busy = true
      try {
        const fresh = await window.ade.invoke('fs:listMany', dirs)
        if (stopped) return
        setChildren((map) => mergeListings(map, fresh) ?? map)
      } catch {
        // つながらない・遅いときは次の回にまた見る（ツリーの読み込みの失敗は fs:list が出す）
      } finally {
        busy = false
      }
    }
    const timer = window.setInterval(() => void check(), REMOTE_POLL_MS)
    const onFocus = () => void check()
    window.addEventListener('focus', onFocus)
    document.addEventListener('visibilitychange', onFocus)
    return () => {
      stopped = true
      window.clearInterval(timer)
      window.removeEventListener('focus', onFocus)
      document.removeEventListener('visibilitychange', onFocus)
    }
  }, [root, poll])

  const toggleDir = useCallback((entry: FsEntry) => {
    const opening = !expandedRef.current.has(entry.path)
    setExpanded((set) => {
      const next = new Set(set)
      if (opening) next.add(entry.path)
      else next.delete(entry.path)
      return next
    })
    if (opening && !childrenRef.current.has(entry.path)) void loadDir(entry.path)
  }, [setExpanded, loadDir])

  const rows = useMemo(() => {
    const out: FileTreeRow[] = []
    const walk = (dir: string, depth: number) => {
      for (const entry of children.get(dir) ?? []) {
        out.push({ entry, depth })
        if (entry.kind === 'directory' && expanded.has(entry.path)) walk(entry.path, depth + 1)
      }
    }
    walk('', 0)
    return out
  }, [children, expanded])

  return {
    rows,
    expanded,
    loading,
    error,
    loaded: children.has(''),
    toggleDir,
    refresh: () => { for (const dir of childrenRef.current.keys()) void loadDir(dir) },
    collapseAll: () => setExpanded(() => new Set()),
    expandDir: (path: string) => {
      if (path === '') return
      setExpanded((set) => (set.has(path) ? set : new Set(set).add(path)))
      if (!childrenRef.current.has(path)) void loadDir(path)
    },
    reloadDir: (path: string) => { void loadDir(path) },
    moveDir: (from: string, to: string) => {
      const moved = [...expandedRef.current].flatMap((path) => { const next = movedPath(path, from, to); return next ? [next] : [] })
      setChildren((map) => new Map([...map].filter(([dir]) => movedPath(dir, from, to) === null)))
      setExpanded((set) => {
        const next = new Set([...set].filter((path) => movedPath(path, from, to) === null))
        for (const path of moved) next.add(path)
        return next
      })
      for (const path of moved) void loadDir(path)
    }
  }
}

/**
 * 同じ高さの行を、見えている範囲（と前後の少し）だけ描く一覧。
 * 大きなフォルダを開いたり、履歴が多かったりしても、DOM の数を抑えて固まらないようにする。
 */
export function VirtualRows<T>({
  items,
  rowHeight,
  render,
  className,
  overscan = 10,
  scrollTo,
  role,
  ariaLabel
}: {
  items: readonly T[]
  rowHeight: number
  render: (item: T, index: number) => ReactNode
  className?: string
  overscan?: number
  /** この番号の行が見えるようにスクロールする（↑↓ で選んだとき） */
  scrollTo?: number
  role?: string
  ariaLabel?: string
}) {
  const ref = useRef<HTMLDivElement | null>(null)
  const [scrollTop, setScrollTop] = useState(0)
  const [height, setHeight] = useState(600)

  useEffect(() => {
    const node = ref.current
    if (!node) return
    const observer = new ResizeObserver(() => setHeight(node.clientHeight))
    observer.observe(node)
    setHeight(node.clientHeight)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    const node = ref.current
    if (!node || scrollTo === undefined || scrollTo < 0) return
    const top = scrollTo * rowHeight
    if (top < node.scrollTop) node.scrollTop = top
    else if (top + rowHeight > node.scrollTop + node.clientHeight) node.scrollTop = top + rowHeight - node.clientHeight
  }, [scrollTo, rowHeight])

  const start = Math.max(0, Math.floor(scrollTop / rowHeight) - overscan)
  const end = Math.min(items.length, Math.ceil((scrollTop + height) / rowHeight) + overscan)
  return (
    <div ref={ref} className={className} role={role} aria-label={ariaLabel} onScroll={(e: UIEvent<HTMLDivElement>) => setScrollTop(e.currentTarget.scrollTop)} style={{ overflowY: 'auto', minHeight: 0 }}>
      <div style={{ position: 'relative', height: items.length * rowHeight }}>
        {items.slice(start, end).map((item, i) => (
          <div key={start + i} style={{ position: 'absolute', top: (start + i) * rowHeight, left: 0, right: 0, height: rowHeight }}>
            {render(item, start + i)}
          </div>
        ))}
      </div>
    </div>
  )
}
