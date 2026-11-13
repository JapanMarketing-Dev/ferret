import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react'
import { MAX_SHEET_COLUMNS, MAX_SHEET_ROWS, columnName, parseCellRef } from '@shared/office/xlsx'
import { cellKey, cellRef, type SheetGrid } from '@shared/office/xlsxEdit'
import { useT } from '../lib/i18n'

/** 1行の高さ（px）。見える行だけを描くのに使う */
const ROW_HEIGHT = 24
/** 見える範囲の上下に余分に描く行 */
const OVERSCAN = 8

/**
 * Excel のシートのセルを直す表（OfficeViewer の編集）。
 * セルを選んで打つ・ダブルクリック・Enter / F2 で直し、Enter で下・Tab で右へ進む。Delete で値を消す。
 * 上の欄（数式バー）でも直せる。直したセルは色を付けて見せる（保存するまでファイルは変わらない）。
 * 大きいシートでも固まらないよう、見えている行だけを描く。
 */
export default function XlsxGridEditor({ grid, edits, onEdit }: {
  grid: SheetGrid
  /** "B3" → 打った文字（保存していない直し） */
  edits: ReadonlyMap<string, string>
  onEdit: (ref: string, value: string) => void
}) {
  const t = useT()
  const scrollRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const [viewport, setViewport] = useState({ top: 0, height: 600 })
  const [selected, setSelected] = useState({ row: 0, col: 0 })
  /** 直している途中の文字（null は直していない）。where はセルの中か数式バーか */
  const [draft, setDraft] = useState<{ value: string; where: 'cell' | 'bar' } | null>(null)

  let editMaxRow = -1
  let editMaxCol = -1
  for (const [ref, value] of edits) {
    if (value === '') continue
    const at = parseCellRef(ref)
    if (!at) continue
    editMaxRow = Math.max(editMaxRow, at.row)
    editMaxCol = Math.max(editMaxCol, at.col)
  }
  const rows = Math.min(MAX_SHEET_ROWS, Math.max(100, Math.max(grid.maxRow, editMaxRow, selected.row) + 50))
  const cols = Math.min(MAX_SHEET_COLUMNS, Math.max(12, Math.max(grid.maxCol, editMaxCol, selected.col) + 6))

  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const measure = () => setViewport({ top: el.scrollTop, height: el.clientHeight })
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  const refOf = (row: number, col: number) => cellRef(row, col)
  const cellAt = (row: number, col: number) => grid.cells.get(cellKey(row, col))
  const inputAt = (row: number, col: number) => edits.get(refOf(row, col)) ?? cellAt(row, col)?.input ?? ''
  const lockedAt = (row: number, col: number) => cellAt(row, col)?.locked === true

  const select = (row: number, col: number) => {
    const next = { row: Math.max(0, Math.min(MAX_SHEET_ROWS - 1, row)), col: Math.max(0, Math.min(MAX_SHEET_COLUMNS - 1, col)) }
    setSelected(next)
    // 選んだセルが見えるようにする（見出しの行の分を引く）
    const el = scrollRef.current
    if (!el) return
    const top = next.row * ROW_HEIGHT
    if (top < el.scrollTop) el.scrollTop = top
    else if (top + ROW_HEIGHT * 2 > el.scrollTop + el.clientHeight) el.scrollTop = top + ROW_HEIGHT * 2 - el.clientHeight
  }

  const startEdit = (value: string, where: 'cell' | 'bar' = 'cell') => {
    if (lockedAt(selected.row, selected.col)) return
    setDraft({ value, where })
  }

  const commit = (move: 'down' | 'up' | 'right' | 'left' | 'none') => {
    if (draft && !lockedAt(selected.row, selected.col)) onEdit(refOf(selected.row, selected.col), draft.value)
    setDraft(null)
    const { row, col } = selected
    if (move === 'down') select(row + 1, col)
    else if (move === 'up') select(row - 1, col)
    else if (move === 'right') select(row, col + 1)
    else if (move === 'left') select(row, col - 1)
    scrollRef.current?.focus()
  }

  const cancel = () => {
    setDraft(null)
    scrollRef.current?.focus()
  }

  // セルの欄を開いたら、打った文字の後ろにカーソルを置く
  useEffect(() => {
    const input = inputRef.current
    if (draft?.where !== 'cell' || !input) return
    input.focus()
    input.setSelectionRange(input.value.length, input.value.length)
  }, [draft?.where])

  const onGridKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (draft) return
    if (event.metaKey || event.ctrlKey || event.altKey) return
    const { row, col } = selected
    const moves: Record<string, [number, number]> = { ArrowDown: [1, 0], ArrowUp: [-1, 0], ArrowRight: [0, 1], ArrowLeft: [0, -1] }
    const move = moves[event.key]
    if (move) {
      event.preventDefault()
      select(row + move[0], col + move[1])
      return
    }
    if (event.key === 'Tab') {
      event.preventDefault()
      select(row, col + (event.shiftKey ? -1 : 1))
      return
    }
    if (event.key === 'Enter' || event.key === 'F2') {
      event.preventDefault()
      startEdit(inputAt(row, col))
      return
    }
    if (event.key === 'Delete' || event.key === 'Backspace') {
      event.preventDefault()
      if (!lockedAt(row, col) && inputAt(row, col) !== '') onEdit(refOf(row, col), '')
      return
    }
    // 日本語入力の始まり（Process）は、空の欄を開いてそこで続けて打てるようにする
    if (event.key === 'Process') {
      startEdit('')
      return
    }
    // 打った文字から直し始める（Excel と同じ）
    if (event.key.length === 1) {
      event.preventDefault()
      startEdit(event.key)
    }
  }

  const onEditorKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return
    if (event.key === 'Enter') {
      event.preventDefault()
      commit(event.shiftKey ? 'up' : 'down')
    } else if (event.key === 'Tab') {
      event.preventDefault()
      commit(event.shiftKey ? 'left' : 'right')
    } else if (event.key === 'Escape') {
      event.preventDefault()
      cancel()
    }
  }

  const first = Math.max(0, Math.floor(viewport.top / ROW_HEIGHT) - OVERSCAN)
  const last = Math.min(rows - 1, Math.ceil((viewport.top + viewport.height) / ROW_HEIGHT) + OVERSCAN)
  const selectedRef = refOf(selected.row, selected.col)
  const selectedLocked = lockedAt(selected.row, selected.col)
  const columns = Array.from({ length: cols }, (_, i) => i)

  return (
    <div className="office-grid" data-testid="office-grid">
      <div className="office-grid__bar">
        <span className="office-grid__ref" aria-label={t('viewer.officeCellLabel', { ref: selectedRef })}>{selectedRef}</span>
        <input
          className="office-grid__formula"
          value={draft ? draft.value : inputAt(selected.row, selected.col)}
          readOnly={selectedLocked}
          title={selectedLocked ? t('viewer.officeCellLocked') : undefined}
          aria-label={t('viewer.officeCellLabel', { ref: selectedRef })}
          onFocus={() => { if (!draft && !selectedLocked) setDraft({ value: inputAt(selected.row, selected.col), where: 'bar' }) }}
          onChange={(event) => setDraft({ value: event.target.value, where: 'bar' })}
          onKeyDown={onEditorKey}
          onBlur={() => { if (draft?.where === 'bar') commit('none') }}
          data-testid="office-grid-formula"
        />
      </div>
      <div
        ref={scrollRef}
        className="office-grid__scroll"
        tabIndex={0}
        onKeyDown={onGridKey}
        onScroll={(event) => setViewport({ top: event.currentTarget.scrollTop, height: event.currentTarget.clientHeight })}
      >
        <table className="office-grid__table" style={{ width: 48 + cols * 96 }}>
          <colgroup>
            <col style={{ width: 48 }} />
            {columns.map((c) => <col key={c} style={{ width: 96 }} />)}
          </colgroup>
          <thead>
            <tr>
              <th className="office-grid__corner" />
              {columns.map((c) => <th key={c} className={c === selected.col ? 'is-active' : undefined}>{columnName(c)}</th>)}
            </tr>
          </thead>
          <tbody>
            {first > 0 && <tr style={{ height: first * ROW_HEIGHT }} aria-hidden="true"><td colSpan={cols + 1} /></tr>}
            {Array.from({ length: last - first + 1 }, (_, i) => first + i).map((row) => (
              <tr key={row} style={{ height: ROW_HEIGHT }}>
                <th className={row === selected.row ? 'is-active' : undefined}>{row + 1}</th>
                {columns.map((col) => {
                  const ref = refOf(row, col)
                  const cell = cellAt(row, col)
                  const edited = edits.has(ref)
                  const isSelected = row === selected.row && col === selected.col
                  const className = [
                    isSelected ? 'is-selected' : '',
                    edited ? 'is-edited' : '',
                    cell?.locked ? 'is-locked' : '',
                    !edited && (cell?.kind === 'number' || cell?.kind === 'formula') ? 'is-number' : ''
                  ].filter(Boolean).join(' ')
                  return (
                    <td
                      key={col}
                      className={className || undefined}
                      title={cell?.locked ? t('viewer.officeCellLocked') : undefined}
                      onMouseDown={() => { if (draft) commit('none'); setSelected({ row, col }) }}
                      onDoubleClick={() => { setSelected({ row, col }); if (!cell?.locked) setDraft({ value: inputAt(row, col), where: 'cell' }) }}
                    >
                      {isSelected && draft?.where === 'cell'
                        ? (
                          <input
                            ref={inputRef}
                            className="office-grid__input"
                            value={draft.value}
                            onChange={(event) => setDraft({ value: event.target.value, where: 'cell' })}
                            onKeyDown={onEditorKey}
                            onBlur={() => commit('none')}
                            aria-label={t('viewer.officeCellLabel', { ref })}
                            data-testid="office-grid-input"
                          />
                        )
                        : (edited ? edits.get(ref) : cell?.display) ?? ''}
                    </td>
                  )
                })}
              </tr>
            ))}
            {last < rows - 1 && <tr style={{ height: (rows - 1 - last) * ROW_HEIGHT }} aria-hidden="true"><td colSpan={cols + 1} /></tr>}
          </tbody>
        </table>
      </div>
    </div>
  )
}
