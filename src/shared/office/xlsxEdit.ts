/**
 * Excel（.xlsx）のセルの値を読み書きする（純粋な関数）。
 *
 * 書くときはブックを作り直さず、シートの XML のうち直したセル（<c>）だけを差し替える。
 * 書式（s）・ほかのセル・行の高さ・列の幅・結合・条件付き書式・グラフ・共有文字列はそのまま残す。
 * 新しい文字はセルの中に直接入れる（t="inlineStr"。共有文字列の表は触らない）。
 * 数式（= で始まる）は式だけを書き、Excel が開いたときに計算し直すようにする（calcPr fullCalcOnLoad）。
 * 共有数式・配列数式の元のセルは、ほかのセルの式が頼っているので直させない（locked）。
 */
import { attr, child, children, documentElement, parseXml, type XmlNode } from './xml'
import type { ZipArchive } from './zip'
import { escapeXmlText } from './textEdit'
import { MAX_SHEET_COLUMNS, MAX_SHEET_ROWS, columnName, formatNumber, parseCellRef, readWorkbook, stringItem, type WorkbookInfo } from './xlsx'

export type GridCellKind = 'string' | 'number' | 'bool' | 'error' | 'formula'

export interface GridCell {
  /** 編集の欄に出す文字（数式は = から。数値は書式を付けない値） */
  input: string
  /** 表に出す文字（書式を付けた値・数式の結果） */
  display: string
  kind: GridCellKind
  /** 直させない（共有数式・配列数式の元） */
  locked: boolean
  /** 書式が文字列（@）。数字を打っても文字として入れる */
  textFormat: boolean
}

export interface SheetGrid {
  /** `${row}:${col}`（0 始まり）→ セル */
  cells: Map<string, GridCell>
  /** 値のある一番下の行・一番右の列（0 始まり。空なら -1） */
  maxRow: number
  maxCol: number
  /** 上限（MAX_SHEET_ROWS × MAX_SHEET_COLUMNS）の外にも値がある */
  truncated: boolean
}

export function cellKey(row: number, col: number): string {
  return `${row}:${col}`
}

export function cellRef(row: number, col: number): string {
  return `${columnName(col)}${row + 1}`
}

/** 1つのシートのセルを読む（上限の内だけ） */
export function readSheetGrid(source: string | null, book: Pick<WorkbookInfo, 'shared' | 'styles' | 'date1904'>): SheetGrid {
  const cells = new Map<string, GridCell>()
  let maxRow = -1
  let maxCol = -1
  let truncated = false
  const ws = source ? documentElement(parseXml(source)) : undefined
  let implicitRow = -1
  for (const row of children(child(ws, 'sheetData'), 'row')) {
    const r = attr(row, 'r') ? Number(attr(row, 'r')) - 1 : implicitRow + 1
    implicitRow = r
    let col = -1
    for (const c of children(row, 'c')) {
      const at = parseCellRef(attr(c, 'r') ?? '') ?? { row: r, col: col + 1 }
      col = at.col
      if (at.row >= MAX_SHEET_ROWS || at.col >= MAX_SHEET_COLUMNS) {
        truncated = true
        continue
      }
      const cell = gridCell(c, book)
      if (!cell) continue
      cells.set(cellKey(at.row, at.col), cell)
      if (at.row > maxRow) maxRow = at.row
      if (at.col > maxCol) maxCol = at.col
    }
  }
  return { cells, maxRow, maxCol, truncated }
}

function gridCell(c: XmlNode, book: Pick<WorkbookInfo, 'shared' | 'styles' | 'date1904'>): GridCell | null {
  const type = attr(c, 't') ?? 'n'
  const style = book.styles[Number(attr(c, 's') ?? 0)]
  const textFormat = style?.numFmt === '@'
  const f = child(c, 'f')
  const raw = child(c, 'v')?.text ?? ''
  let display = ''
  let kind: GridCellKind = 'string'
  if (type === 's') display = book.shared[Number(raw)] ?? ''
  else if (type === 'inlineStr') display = stringItem(child(c, 'is') ?? c)
  else if (type === 'str') display = raw
  else if (type === 'b') {
    display = raw === '1' ? 'TRUE' : raw === '' ? '' : 'FALSE'
    kind = 'bool'
  } else if (type === 'e') {
    display = raw
    kind = 'error'
  } else if (raw !== '') {
    const n = Number(raw)
    display = Number.isFinite(n) ? formatNumber(n, style?.numFmt ?? 'General', book.date1904) : raw
    kind = 'number'
  }
  if (f) {
    const fType = attr(f, 't')
    const locked = (fType === 'shared' && attr(f, 'ref') !== undefined) || fType === 'array' || fType === 'dataTable'
    // 共有数式の続き（式を持たない）は、元の式が分からないので結果だけを見せる
    const formula = f.text
    if (formula !== '' || locked) return { input: formula !== '' ? `=${formula}` : display, display, kind: 'formula', locked, textFormat }
    return { input: display, display, kind: 'formula', locked: false, textFormat }
  }
  if (display === '' && kind !== 'bool') return null
  const input = kind === 'number' ? raw : display
  return { input, display, kind, locked: false, textFormat }
}

const NUMBER = /^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/

/** 打った文字を、セルの中身（t の値と子要素）にする */
export function encodeCellInput(input: string, textFormat = false): { type: string | null; inner: string; formula: boolean } | null {
  if (input === '') return null
  if (!textFormat && input.length > 1 && input.startsWith('=')) return { type: null, inner: `<f>${escapeXmlText(input.slice(1))}</f>`, formula: true }
  const trimmed = input.trim()
  if (!textFormat && NUMBER.test(trimmed) && Number.isFinite(Number(trimmed))) return { type: null, inner: `<v>${Number(trimmed)}</v>`, formula: false }
  if (!textFormat && /^(true|false)$/i.test(trimmed)) return { type: 'b', inner: `<v>${/^true$/i.test(trimmed) ? 1 : 0}</v>`, formula: false }
  return { type: 'inlineStr', inner: `<is><t xml:space="preserve">${escapeXmlText(input)}</t></is>`, formula: false }
}

interface CellSpan {
  col: number
  start: number
  end: number
  raw: string
}

interface RowSpan {
  row: number
  start: number
  end: number
  openTag: string
  selfClosing: boolean
  cells: CellSpan[]
}

function attrOf(tag: string, name: string): string | undefined {
  const m = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`).exec(tag)
  return m ? (m[1] ?? m[2]) : undefined
}

/** 開始タグ（<c ...>・<row ...>）の属性の部分だけ */
function openTagOf(raw: string): string {
  const end = raw.indexOf('>')
  return raw.slice(0, end + 1)
}

export interface CellEditResult {
  xml: string
  /** 数式を足した・数式のセルを書き換えた（計算の順の表 calcChain を捨て、開いたときに計算し直させる） */
  formulas: boolean
}

/**
 * シートの XML に、セルの書き換え（edits: "B3" → 打った文字。空はセルの値を消す）を当てる。
 * textFormatRefs のセルは数字でも文字として入れる。locked のセルは呼ぶ側で除いておく
 */
export function applyCellEdits(xml: string, edits: ReadonlyMap<string, string>, textFormatRefs: ReadonlySet<string> = new Set()): CellEditResult {
  if (edits.size === 0) return { xml, formulas: false }
  const sheetData = /<((?:[\w.-]+:)?)sheetData\b[^>]*?(\/?)>/.exec(xml)
  if (!sheetData) throw new Error('sheetData is missing')
  const pre = sheetData[1]!
  // 空のシート（<sheetData/>）は開いてから行を入れる
  if (sheetData[2] === '/') {
    const opened = xml.slice(0, sheetData.index) + sheetData[0].replace(/\s*\/>$/, '>') + `</${pre}sheetData>` + xml.slice(sheetData.index + sheetData[0].length)
    return applyCellEdits(opened, edits, textFormatRefs)
  }
  const dataOpenEnd = sheetData.index + sheetData[0].length
  const dataClose = xml.indexOf(`</${pre}sheetData>`, dataOpenEnd)
  if (dataClose === -1) throw new Error('sheetData is not closed')

  // 行とセルの位置
  const rows: RowSpan[] = []
  const rowRe = new RegExp(`<${pre}row\\b[^>]*?(?:/>|>[\\s\\S]*?</${pre}row>)`, 'g')
  rowRe.lastIndex = dataOpenEnd
  let lastRow = -1
  for (let m = rowRe.exec(xml); m && m.index < dataClose; m = rowRe.exec(xml)) {
    const raw = m[0]
    const openTag = openTagOf(raw)
    const selfClosing = openTag.endsWith('/>')
    const rAttr = attrOf(openTag, 'r')
    const row = rAttr ? Number(rAttr) - 1 : lastRow + 1
    lastRow = row
    const cells: CellSpan[] = []
    if (!selfClosing) {
      const cellRe = new RegExp(`<${pre}c\\b[^>]*?(?:/>|>[\\s\\S]*?</${pre}c>)`, 'g')
      const inner = raw.slice(openTag.length)
      let lastCol = -1
      for (let c = cellRe.exec(inner); c; c = cellRe.exec(inner)) {
        const ref = parseCellRef(attrOf(openTagOf(c[0]), 'r') ?? '')
        const col = ref ? ref.col : lastCol + 1
        lastCol = col
        cells.push({ col, start: openTag.length + c.index, end: openTag.length + c.index + c[0].length, raw: c[0] })
      }
    }
    rows.push({ row, start: m.index, end: m.index + raw.length, openTag, selfClosing, cells })
  }

  // 行ごとにまとめる
  const byRow = new Map<number, { col: number; ref: string; input: string }[]>()
  for (const [ref, input] of edits) {
    const at = parseCellRef(ref)
    if (!at) continue
    const list = byRow.get(at.row) ?? []
    list.push({ col: at.col, ref: cellRef(at.row, at.col), input })
    byRow.set(at.row, list)
  }

  let formulas = false
  const newCell = (ref: string, input: string, old: string | null): string | null => {
    const oldTag = old ? openTagOf(old) : ''
    if (old && /<(?:[\w.-]+:)?f\b/.test(old)) formulas = true
    const s = old ? attrOf(oldTag, 's') : undefined
    const encoded = encodeCellInput(input, textFormatRefs.has(ref))
    if (encoded?.formula) formulas = true
    const sAttr = s !== undefined ? ` s="${s}"` : ''
    // 値を消しても書式（s）は残す。書式も無ければセルごと消す
    if (!encoded) return s !== undefined ? `<${pre}c r="${ref}"${sAttr}/>` : null
    const inner = pre ? encoded.inner.replace(/<(\/?)(f|v|is|t)\b/g, `<$1${pre}$2`) : encoded.inner
    return `<${pre}c r="${ref}"${sAttr}${encoded.type ? ` t="${encoded.type}"` : ''}>${inner}</${pre}c>`
  }

  const replacements: { start: number; end: number; text: string }[] = []
  const inserts = new Map<number, string[]>()
  const sortedRows = [...byRow.keys()].sort((a, b) => a - b)
  for (const rowIndex of sortedRows) {
    const list = byRow.get(rowIndex)!.sort((a, b) => a.col - b.col)
    const existing = rows.find((r) => r.row === rowIndex)
    if (existing) {
      const rowRaw = xml.slice(existing.start, existing.end)
      let body = existing.selfClosing ? '' : rowRaw.slice(existing.openTag.length)
      // セルの位置は body の中の位置に直す（後ろから当てる）
      const cellEdits: { start: number; end: number; text: string }[] = []
      for (const edit of list) {
        const cell = existing.cells.find((c) => c.col === edit.col)
        if (cell) {
          cellEdits.push({ start: cell.start - existing.openTag.length, end: cell.end - existing.openTag.length, text: newCell(edit.ref, edit.input, cell.raw) ?? '' })
        } else {
          const text = newCell(edit.ref, edit.input, null)
          if (!text) continue
          const after = existing.cells.find((c) => c.col > edit.col)
          const before = [...existing.cells].reverse().find((c) => c.col < edit.col)
          const at = after ? after.start - existing.openTag.length : before ? before.end - existing.openTag.length : 0
          // 同じ位置へ足すものは列の順につなぐ
          const same = cellEdits.find((e) => e.start === at && e.end === at)
          if (same) same.text += text
          else cellEdits.push({ start: at, end: at, text })
        }
      }
      for (const e of orderReplacements(cellEdits)) body = body.slice(0, e.start) + e.text + body.slice(e.end)
      // 列の範囲の目安（spans）は変わりうるので外す
      let openTag = existing.openTag.replace(/\s+spans\s*=\s*("[^"]*"|'[^']*')/, '')
      if (existing.selfClosing) {
        openTag = openTag.replace(/\s*\/>$/, '>')
        body += `</${pre}row>`
      }
      replacements.push({ start: existing.start, end: existing.end, text: openTag + body })
    } else {
      const cellsXml = list.map((e) => newCell(e.ref, e.input, null)).filter((x): x is string => x !== null).join('')
      if (!cellsXml) continue
      const next = rows.find((r) => r.row > rowIndex)
      const at = next ? next.start : dataClose
      const rowXml = `<${pre}row r="${rowIndex + 1}">${cellsXml}</${pre}row>`
      inserts.set(at, [...(inserts.get(at) ?? []), rowXml])
    }
  }
  for (const [at, list] of inserts) replacements.push({ start: at, end: at, text: list.join('') })
  let out = xml
  for (const r of orderReplacements(replacements)) out = out.slice(0, r.start) + r.text + out.slice(r.end)
  return { xml: expandDimension(out, edits), formulas }
}

/** 後ろから当てる順。同じ位置なら、置き換え（end が大きい）を先に、足すだけのものを後に（足したものが置き換えに消されない） */
function orderReplacements<T extends { start: number; end: number }>(list: T[]): T[] {
  return [...list].sort((a, b) => b.start - a.start || b.end - a.end)
}

/** <dimension ref="A1:C3"/> を、書いたセルが入るように広げる */
function expandDimension(xml: string, edits: ReadonlyMap<string, string>): string {
  const m = /<((?:[\w.-]+:)?)dimension\b([^>]*?)\bref\s*=\s*"([^"]*)"/.exec(xml)
  if (!m) return xml
  const [a, b] = m[3]!.split(':')
  const from = parseCellRef(a ?? '')
  const to = parseCellRef(b ?? a ?? '')
  if (!from || !to) return xml
  let { row: r1, col: c1 } = from
  let { row: r2, col: c2 } = to
  for (const [ref, input] of edits) {
    if (input === '') continue
    const at = parseCellRef(ref)
    if (!at) continue
    r1 = Math.min(r1, at.row); c1 = Math.min(c1, at.col)
    r2 = Math.max(r2, at.row); c2 = Math.max(c2, at.col)
  }
  const ref = r1 === r2 && c1 === c2 ? cellRef(r1, c1) : `${cellRef(r1, c1)}:${cellRef(r2, c2)}`
  if (ref === m[3]) return xml
  const start = m.index + m[0].length - m[3]!.length - 1
  return xml.slice(0, start) + ref + xml.slice(start + m[3]!.length)
}

/**
 * 数式を書いたあとのブックの手直し。計算の順の表（calcChain）を捨て（古い表が残ると Excel が「修復」を出す）、
 * 開いたときに計算し直す印（calcPr fullCalcOnLoad="1"）を付ける。消す部品の名前と、書き換えた部品を返す
 */
export function workbookAfterFormulaEdit(files: { workbook: string; workbookRels: string | null; contentTypes: string | null }): { workbook: string; workbookRels: string | null; contentTypes: string | null } {
  let workbook = files.workbook
  const calcPr = /<((?:[\w.-]+:)?)calcPr\b([^>]*?)(\/?)>/.exec(workbook)
  if (calcPr) {
    let tag = calcPr[0]
    tag = /\bfullCalcOnLoad\s*=/.test(tag) ? tag.replace(/\bfullCalcOnLoad\s*=\s*("[^"]*"|'[^']*')/, 'fullCalcOnLoad="1"') : tag.replace(/\s*(\/?)>$/, ' fullCalcOnLoad="1"$1>')
    workbook = workbook.slice(0, calcPr.index) + tag + workbook.slice(calcPr.index + calcPr[0].length)
  } else {
    // CT_Workbook の並び: … sheets, functionGroups, externalReferences, definedNames, calcPr …
    const pre = /<((?:[\w.-]+:)?)workbook\b/.exec(workbook)?.[1] ?? ''
    const anchors = ['definedNames', 'externalReferences', 'functionGroups', 'sheets']
    for (const name of anchors) {
      const close = new RegExp(`</${pre}${name}>|<${pre}${name}\\b[^>]*/>`).exec(workbook)
      if (!close) continue
      const at = close.index + close[0].length
      workbook = `${workbook.slice(0, at)}<${pre}calcPr fullCalcOnLoad="1"/>${workbook.slice(at)}`
      break
    }
  }
  const workbookRels = files.workbookRels?.replace(/<Relationship\b[^>]*\/calcChain"[^>]*\/>/g, '') ?? null
  const contentTypes = files.contentTypes?.replace(/<Override\b[^>]*PartName="\/xl\/calcChain\.xml"[^>]*\/>/g, '') ?? null
  return { workbook, workbookRels, contentTypes }
}

export interface XlsxSheetEdits {
  part: string
  /** "B3" → 打った文字 */
  cells: ReadonlyMap<string, string>
  /** 書式が文字列（@）のセル */
  textFormatRefs?: ReadonlySet<string>
}

/** シートごとの書き換えを、ZIP の部品の差し替え（名前 → 新しい中身。null は消す）にする */
export async function xlsxChanges(zip: ZipArchive, sheets: readonly XlsxSheetEdits[]): Promise<Map<string, string | null>> {
  const changes = new Map<string, string | null>()
  let formulas = false
  for (const sheet of sheets) {
    if (sheet.cells.size === 0) continue
    const source = await zip.text(sheet.part)
    if (source === null) throw new Error(`${sheet.part} is missing`)
    const result = applyCellEdits(source, sheet.cells, sheet.textFormatRefs)
    changes.set(sheet.part, result.xml)
    if (result.formulas) formulas = true
  }
  if (formulas) {
    const workbook = await zip.text('xl/workbook.xml')
    if (workbook !== null) {
      const fixed = workbookAfterFormulaEdit({ workbook, workbookRels: await zip.text('xl/_rels/workbook.xml.rels'), contentTypes: await zip.text('[Content_Types].xml') })
      changes.set('xl/workbook.xml', fixed.workbook)
      if (fixed.workbookRels !== null) changes.set('xl/_rels/workbook.xml.rels', fixed.workbookRels)
      if (fixed.contentTypes !== null) changes.set('[Content_Types].xml', fixed.contentTypes)
      if (zip.has('xl/calcChain.xml')) changes.set('xl/calcChain.xml', null)
    }
  }
  return changes
}

export { readWorkbook }
