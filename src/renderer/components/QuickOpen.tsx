import { useEffect, useMemo, useRef, useState } from 'react'
import { FileSearch } from 'lucide-react'
import { prepareQuickOpenFiles, rankPreparedQuickOpenFiles, QUICK_OPEN_RESULT_LIMIT } from '@shared/quickOpen'
import { errorMessage } from '../lib/errors'
import { Modal, Spinner } from '../ui'
import { useT } from '../lib/i18n'

/**
 * ⌘P のクイックオープン。ファイル名のあいまい一致で開く。
 *
 * Orca由来: ~/bench/orca/src/renderer/src/components/quick-open-file-list.ts（MIT）
 *   - 開いた時点で一覧を1回取り（main は rg --files、.gitignore に従う）、絞り込みは手元で行う
 *   - 打ち切ったときはそれを示す
 * 一覧は main が覚えている（files.ts の FileIndexCache。変更の監視で古くなったら読み直す）ので、開くたびに歩き直さない。
 * 一覧が上限で打ち切られているときは、手元の絞り込みをすぐ出しつつ、main の索引（全部）からも探して差し替える
 * （送られた分の外にあるファイルが、いつまでも出ないことをなくす）。
 * SSH・worktree の入れ子の除外・rg の案内は持ち込まない。
 *
 * 内蔵ブラウザのビューは DOM の上に重なるので、開いている間は呼び出し側でビューを隠すこと。
 */
/** 打ち切られた一覧のとき、main の索引から探すまでの待ち（打っている途中では探さない） */
const REMOTE_SEARCH_DELAY_MS = 120

export function QuickOpen({ onOpen, onClose }: { onOpen: (path: string) => void; onClose: () => void }) {
  const t = useT()
  const [files, setFiles] = useState<string[] | null>(null)
  const [truncated, setTruncated] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState(0)
  const listRef = useRef<HTMLUListElement>(null)

  useEffect(() => {
    let cancelled = false
    window.ade.invoke('fs:files').then(
      (result) => { if (!cancelled) { setFiles(result.files); setTruncated(result.truncated) } },
      (err) => { if (!cancelled) setError(errorMessage(err)) }
    )
    return () => { cancelled = true }
  }, [])

  // 下ごしらえは一覧ごとに1回（打鍵のたびに2万件の小文字を作り直さない）
  const prepared = useMemo(() => (files ? prepareQuickOpenFiles(files) : null), [files])
  const local = useMemo(() => (prepared ? rankPreparedQuickOpenFiles(query, prepared) : []), [prepared, query])

  // 打ち切られた一覧のときは main の索引全部からも探す。古い問い合わせの答えは捨てる（打ち終わるのを少し待つ）
  const [remote, setRemote] = useState<{ query: string; paths: string[] } | null>(null)
  useEffect(() => {
    const trimmed = query.trim()
    if (!truncated || !trimmed) return
    let cancelled = false
    const timer = window.setTimeout(() => {
      window.ade.invoke('fs:search', trimmed, 'names').then(
        (result) => { if (!cancelled) setRemote({ query: trimmed, paths: result.files.slice(0, QUICK_OPEN_RESULT_LIMIT) }) },
        // 全部からの検索に失敗しても、手元の絞り込みは出たまま（想定内。main が報告する）
        () => undefined
      )
    }, REMOTE_SEARCH_DELAY_MS)
    return () => { cancelled = true; window.clearTimeout(timer) }
  }, [truncated, query])
  const results = useMemo(
    () => (remote && remote.query === query.trim() ? remote.paths.map((path) => ({ path })) : local),
    [remote, local, query]
  )
  useEffect(() => setSelected(0), [query])
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [selected])

  const choose = (path: string | undefined) => {
    if (!path) return
    onClose()
    onOpen(path)
  }

  return (
    <Modal className="rv-modal quick-open-modal" label={t('quickOpen.title')} onClose={onClose}>
      {/* 外側を押したら閉じる */}
      <div className="quick-open-shade" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="quick-open" data-testid="quick-open">
        <div className="quick-open__input">
          <FileSearch size={14} aria-hidden="true" />
          <input
            autoFocus
            value={query}
            placeholder={t('quickOpen.placeholder')}
            aria-label={t('quickOpen.placeholder')}
            aria-controls="quick-open-list"
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.nativeEvent.isComposing) return
              if (e.key === 'ArrowDown') { e.preventDefault(); setSelected((i) => Math.min(i + 1, results.length - 1)) }
              else if (e.key === 'ArrowUp') { e.preventDefault(); setSelected((i) => Math.max(i - 1, 0)) }
              else if (e.key === 'Enter') { e.preventDefault(); choose(results[selected]?.path) }
            }}
            data-testid="quick-open-input"
          />
        </div>
        {error ? (
          <p className="quick-open__note">{error}</p>
        ) : files === null ? (
          <div className="quick-open__note"><Spinner size={14} /> {t('quickOpen.loading')}</div>
        ) : results.length === 0 ? (
          <p className="quick-open__note">{t('fileExplorer.noMatches')}</p>
        ) : (
          <ul className="quick-open__list" id="quick-open-list" role="listbox" ref={listRef}>
            {results.map((result, index) => {
              const slash = result.path.lastIndexOf('/')
              return (
                <li
                  key={result.path}
                  role="option"
                  aria-selected={index === selected}
                  className="quick-open__item"
                  onMouseMove={() => setSelected(index)}
                  onClick={() => choose(result.path)}
                  data-testid="quick-open-item"
                >
                  <span className="quick-open__name">{result.path.slice(slash + 1)}</span>
                  <span className="quick-open__dir">{slash > 0 ? result.path.slice(0, slash) : ''}</span>
                </li>
              )
            })}
          </ul>
        )}
        {truncated && <p className="quick-open__note quick-open__note--foot">{t('quickOpen.truncated')}</p>}
      </div>
      </div>
    </Modal>
  )
}
