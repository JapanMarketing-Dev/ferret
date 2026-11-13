/**
 * 保存していない直し（部品 → 位置 → 新しい値）の持ち方（純粋な関数。OfficeViewer が使う）。
 * 元の値に戻した直しは消す（元に戻したら「変更なし」に戻る）。毎回新しい Map を返す（React の state のため）
 */
import { parseCellRef } from './xlsx'
import { cellKey, type SheetGrid } from './xlsxEdit'

export type PartEdits<K> = ReadonlyMap<string, ReadonlyMap<K, string>>

export function updateEdit<K>(edits: PartEdits<K>, part: string, key: K, value: string, original: string): Map<string, ReadonlyMap<K, string>> {
  const next = new Map(edits)
  const forPart = new Map(edits.get(part) ?? [])
  if (value === original) forPart.delete(key)
  else forPart.set(key, value)
  if (forPart.size === 0) next.delete(part)
  else next.set(part, forPart)
  return next
}

export function hasEdits<K>(edits: PartEdits<K>): boolean {
  for (const forPart of edits.values()) if (forPart.size > 0) return true
  return false
}

/** 直したセルのうち、書式が文字列（@）のもの（数字を打っても文字として入れる） */
export function textFormatRefs(grid: SheetGrid | undefined, cells: ReadonlyMap<string, string>): Set<string> {
  const out = new Set<string>()
  if (!grid) return out
  for (const ref of cells.keys()) {
    const at = parseCellRef(ref)
    if (at && grid.cells.get(cellKey(at.row, at.col))?.textFormat) out.add(ref)
  }
  return out
}
