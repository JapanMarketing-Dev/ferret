/**
 * Excel（.xlsx）のシートを表の HTML にする（値・結合・列の幅・太字・文字と塗りの色・日付と数値の書式の主なもの）。
 * 数式は計算せず、ファイルに保存されている結果を出す。大きいシートは先頭だけ出す。
 */
import { attr, child, children, descendants, documentElement, escapeHtml, parseRels, parseXml, type XmlNode } from './xml'
import { relsPathOf, resolvePartPath, type ZipArchive } from './zip'
import { officeHtml } from './common'

const WORKBOOK = 'xl/workbook.xml'
export const MAX_SHEET_ROWS = 2000
export const MAX_SHEET_COLUMNS = 200

const CSS = `
body{background:#fff}
table.xlsx{border-collapse:collapse;table-layout:fixed;font:12.5px/1.35 "Calibri","Aptos","Helvetica Neue","Hiragino Sans","Yu Gothic",Meiryo,sans-serif}
.xlsx td,.xlsx th{border:1px solid #d9d9d9;padding:2px 5px;height:21px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;vertical-align:bottom}
.xlsx th{position:sticky;background:#f3f3f3;color:#555;font-weight:400;text-align:center;z-index:1}
.xlsx thead th{top:0}
.xlsx tbody th{left:0;min-width:40px}
.xlsx thead th:first-child{left:0;z-index:2}
.xlsx td.n{text-align:right}
.xlsx td.b{text-align:center}
.xlsx td.wrap{white-space:pre-wrap}
`

export interface XlsxSheet {
  name: string
  hidden: boolean
  /** そのシートを開いたときに HTML にする（大きいブックで全部のシートを先に作らない） */
  render: () => Promise<string>
}

export interface CellStyle {
  numFmt: string
  css: string
  wrap: boolean
}

const BUILTIN_FORMATS: Record<number, string> = {
  0: 'General', 1: '0', 2: '0.00', 3: '#,##0', 4: '#,##0.00', 9: '0%', 10: '0.00%', 11: '0.00E+00',
  14: 'yyyy-mm-dd', 15: 'd-mmm-yy', 16: 'd-mmm', 17: 'mmm-yy', 18: 'h:mm AM/PM', 19: 'h:mm:ss AM/PM', 20: 'h:mm', 21: 'h:mm:ss',
  22: 'yyyy-mm-dd h:mm', 37: '#,##0 ;(#,##0)', 38: '#,##0 ;[Red](#,##0)', 39: '#,##0.00;(#,##0.00)', 40: '#,##0.00;[Red](#,##0.00)',
  45: 'mm:ss', 46: '[h]:mm:ss', 47: 'mm:ss.0', 49: '@',
  // 日本語の Excel の組み込みの日付
  55: 'yyyy-mm-dd', 56: 'yyyy-mm-dd', 57: 'yyyy-mm-dd', 58: 'yyyy-mm-dd'
}

/** ARGB（FF112233）か RGB の色。テーマ色・インデックス色は扱わない */
function argb(value: string | undefined): string | null {
  if (!value) return null
  const hex = value.length === 8 ? value.slice(2) : value
  return /^[0-9a-fA-F]{6}$/.test(hex) ? `#${hex.toLowerCase()}` : null
}

export function readStyles(source: string | null): CellStyle[] {
  if (!source) return []
  const root = documentElement(parseXml(source))
  const custom = new Map<number, string>()
  for (const f of children(child(root, 'numFmts'), 'numFmt')) custom.set(Number(attr(f, 'numFmtId')), attr(f, 'formatCode') ?? 'General')
  const fonts = children(child(root, 'fonts'), 'font')
  const fills = children(child(root, 'fills'), 'fill')
  return children(child(root, 'cellXfs'), 'xf').map((xf) => {
    const id = Number(attr(xf, 'numFmtId') ?? 0)
    const css: string[] = []
    const font = fonts[Number(attr(xf, 'fontId') ?? 0)]
    if (font) {
      if (child(font, 'b') && attr(child(font, 'b'), 'val') !== '0') css.push('font-weight:700')
      if (child(font, 'i') && attr(child(font, 'i'), 'val') !== '0') css.push('font-style:italic')
      if (child(font, 'strike')) css.push('text-decoration:line-through')
      else if (child(font, 'u')) css.push('text-decoration:underline')
      const color = argb(attr(child(font, 'color'), 'rgb'))
      if (color && color !== '#000000') css.push(`color:${color}`)
      const size = Number(attr(child(font, 'sz'), 'val'))
      if (Number.isFinite(size) && size > 0 && size !== 11) css.push(`font-size:${Math.min(72, size)}pt`)
    }
    const pattern = child(fills[Number(attr(xf, 'fillId') ?? 0)], 'patternFill')
    if (pattern && attr(pattern, 'patternType') && attr(pattern, 'patternType') !== 'none') {
      const fill = argb(attr(child(pattern, 'fgColor'), 'rgb'))
      if (fill) css.push(`background:${fill}`)
    }
    const align = child(xf, 'alignment')
    const horizontal = attr(align, 'horizontal')
    if (horizontal === 'center' || horizontal === 'centerContinuous') css.push('text-align:center')
    else if (horizontal === 'right') css.push('text-align:right')
    else if (horizontal === 'left') css.push('text-align:left')
    const vertical = attr(align, 'vertical')
    if (vertical === 'top') css.push('vertical-align:top')
    else if (vertical === 'center') css.push('vertical-align:middle')
    return { numFmt: custom.get(id) ?? BUILTIN_FORMATS[id] ?? 'General', css: css.join(';'), wrap: attr(align, 'wrapText') === '1' }
  })
}

export function readSharedStrings(source: string | null): string[] {
  if (!source) return []
  return children(documentElement(parseXml(source)), 'si').map(stringItem)
}

/** <si>・<is> の文字（ふりがな rPh は外す） */
export function stringItem(node: XmlNode): string {
  const t = child(node, 't')
  if (t) return t.text
  return children(node, 'r').map((r) => child(r, 't')?.text ?? '').join('')
}

/** 「AB12」→ 列 27（0始まり）・行 11（0始まり） */
export function parseCellRef(ref: string): { col: number; row: number } | null {
  const m = /^\$?([A-Za-z]{1,3})\$?([0-9]+)$/.exec(ref)
  if (!m) return null
  let col = 0
  for (const ch of m[1]!.toUpperCase()) col = col * 26 + (ch.charCodeAt(0) - 64)
  return { col: col - 1, row: Number(m[2]) - 1 }
}

export function columnName(index: number): string {
  let n = index + 1
  let out = ''
  while (n > 0) {
    const rem = (n - 1) % 26
    out = String.fromCharCode(65 + rem) + out
    n = Math.floor((n - 1) / 26)
  }
  return out
}

/** 書式の文字列から、引用符・[色] などを外す（日付かどうかの判定用） */
function stripFormat(code: string): string {
  return code.replace(/"[^"]*"/g, '').replace(/\[[^\]]*\]/g, '').replace(/\\./g, '').replace(/_./g, '')
}

export function isDateFormat(code: string): boolean {
  const section = stripFormat(code.split(';')[0] ?? '')
  return /[ymdhs]/i.test(section) && !/^[#0.,%E+\-\s]*$/i.test(section)
}

function pad(n: number, width = 2): string {
  return String(n).padStart(width, '0')
}

/** Excel の日付の通し番号 → 「2026-10-06」「2026-10-06 13:45」「13:45:00」 */
export function formatSerialDate(serial: number, code: string, date1904: boolean): string {
  const days = Math.floor(serial)
  const seconds = Math.round((serial - days) * 86400)
  // 1900 年の仕組みは 1900-02-29（存在しない日）を数えるので、それより後は1日ずらす
  const base = date1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, days >= 60 ? 30 : 31)
  const d = new Date(base + days * 86400000 + seconds * 1000)
  const section = stripFormat(code.split(';')[0] ?? '').toLowerCase()
  const hasDate = /[yd]/.test(section) || (/m/.test(section) && !/[hs]/.test(section))
  const hasTime = /[hs]/.test(section)
  const date = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`
  const time = `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}${/s/.test(section) ? `:${pad(d.getUTCSeconds())}` : ''}`
  if (hasDate && hasTime) return `${date} ${time}`
  if (hasTime) return time
  return date
}

/** 数値を書式に合わせて（主なものだけ。分からない書式は General と同じ） */
export function formatNumber(value: number, code: string, date1904 = false): string {
  if (code === 'General' || code === '@' || code === '') return formatGeneral(value)
  if (isDateFormat(code)) return formatSerialDate(value, code, date1904)
  const sections = code.split(';')
  const section = stripFormat(value < 0 && sections[1] ? sections[1] : sections[0]!)
  const negative = value < 0 && !sections[1]
  const abs = value < 0 && sections[1] ? -value : value
  const percent = section.includes('%')
  const scaled = percent ? abs * 100 : abs
  if (/E\+/i.test(section)) {
    const decimals = (/\.(0+)/.exec(section)?.[1] ?? '').length
    return scaled.toExponential(decimals).toUpperCase().replace(/E([+-])(\d)$/, 'E$10$2')
  }
  const decimals = (/\.([0#]+)/.exec(section)?.[1] ?? '').length
  const grouping = /#,##|0,0/.test(section)
  let text = scaled.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals, useGrouping: grouping })
  if (negative && !text.startsWith('-')) text = `-${text}`
  const prefix = /^[^#0?.]*/.exec(section)?.[0].replace(/[()]/g, '').trim() ?? ''
  const wrapped = value < 0 && sections[1] && /^\(.*\)$/.test(section.trim()) ? `(${text})` : text
  return `${prefix && /[$¥€£]/.test(prefix) ? prefix : ''}${wrapped}${percent ? '%' : ''}`
}

function formatGeneral(value: number): string {
  if (Number.isInteger(value) && Math.abs(value) < 1e15) return String(value)
  const precise = Number(value.toPrecision(11))
  return Math.abs(precise) >= 1e11 || (Math.abs(precise) < 1e-9 && precise !== 0) ? precise.toExponential(5).toUpperCase() : String(precise)
}

interface CellOut {
  html: string
  css: string
  className: string
}

function cellValue(c: XmlNode, shared: string[], styles: CellStyle[], date1904: boolean): CellOut {
  const type = attr(c, 't') ?? 'n'
  const style = styles[Number(attr(c, 's') ?? 0)]
  const raw = child(c, 'v')?.text ?? ''
  let text = ''
  let className = ''
  if (type === 's') text = shared[Number(raw)] ?? ''
  else if (type === 'inlineStr') text = stringItem(child(c, 'is') ?? c)
  else if (type === 'str') text = raw
  else if (type === 'b') {
    text = raw === '1' ? 'TRUE' : 'FALSE'
    className = 'b'
  } else if (type === 'e') {
    text = raw
    className = 'b'
  } else if (raw !== '') {
    const n = Number(raw)
    if (Number.isFinite(n)) {
      text = formatNumber(n, style?.numFmt ?? 'General', date1904)
      className = 'n'
    } else text = raw
  }
  if (style?.wrap) className = `${className} wrap`.trim()
  return { html: escapeHtml(text), css: style?.css ?? '', className }
}

async function renderSheet(zip: ZipArchive, part: string, shared: string[], styles: CellStyle[], date1904: boolean, title: string, truncatedNote: string): Promise<string> {
  const source = await zip.text(part)
  const ws = source ? documentElement(parseXml(source)) : undefined
  const cells = new Map<string, CellOut>()
  let maxRow = -1
  let maxCol = -1
  const heights = new Map<number, number>()
  let truncated = false
  for (const row of children(child(ws, 'sheetData'), 'row')) {
    const r = Number(attr(row, 'r') ?? 0) - 1
    const ht = Number(attr(row, 'ht'))
    let col = -1
    for (const c of children(row, 'c')) {
      const ref = parseCellRef(attr(c, 'r') ?? '')
      const at = ref ?? { row: r, col: col + 1 }
      col = at.col
      if (at.row >= MAX_SHEET_ROWS || at.col >= MAX_SHEET_COLUMNS) {
        truncated = true
        continue
      }
      const value = cellValue(c, shared, styles, date1904)
      if (value.html === '' && value.css === '') continue
      cells.set(`${at.row}:${at.col}`, value)
      if (at.row > maxRow) maxRow = at.row
      if (at.col > maxCol) maxCol = at.col
    }
    if (r >= 0 && r < MAX_SHEET_ROWS && Number.isFinite(ht) && ht > 0) heights.set(r, ht)
  }
  const merges = new Map<string, { rows: number; cols: number }>()
  const covered = new Set<string>()
  for (const m of children(child(ws, 'mergeCells'), 'mergeCell')) {
    const [a, b] = (attr(m, 'ref') ?? '').split(':')
    const from = parseCellRef(a ?? '')
    const to = parseCellRef(b ?? a ?? '')
    if (!from || !to) continue
    const rows = Math.min(to.row, MAX_SHEET_ROWS - 1) - from.row + 1
    const cols = Math.min(to.col, MAX_SHEET_COLUMNS - 1) - from.col + 1
    if (rows < 1 || cols < 1) continue
    merges.set(`${from.row}:${from.col}`, { rows, cols })
    for (let y = from.row; y < from.row + rows; y += 1) for (let x = from.col; x < from.col + cols; x += 1) if (y !== from.row || x !== from.col) covered.add(`${y}:${x}`)
    maxRow = Math.max(maxRow, from.row + rows - 1)
    maxCol = Math.max(maxCol, from.col + cols - 1)
  }
  // 空のシートでも、見出しの列と行を少しだけ出す
  const lastRow = Math.max(maxRow, 19)
  const lastCol = Math.max(maxCol, 7)
  const widths: number[] = []
  for (const col of children(child(ws, 'cols'), 'col')) {
    const min = Number(attr(col, 'min')) - 1
    const max = Math.min(Number(attr(col, 'max')) - 1, lastCol)
    const width = Number(attr(col, 'width'))
    if (!Number.isFinite(width) || !Number.isFinite(min)) continue
    for (let i = Math.max(0, min); i <= max; i += 1) widths[i] = attr(col, 'hidden') === '1' ? 0 : Math.round(width * 7 + 5)
  }
  let colgroup = '<colgroup><col style="width:44px">'
  let head = '<thead><tr><th></th>'
  for (let x = 0; x <= lastCol; x += 1) {
    colgroup += `<col style="width:${widths[x] ?? 72}px">`
    head += `<th>${columnName(x)}</th>`
  }
  colgroup += '</colgroup>'
  head += '</tr></thead>'
  let body = '<tbody>'
  for (let y = 0; y <= lastRow; y += 1) {
    const ht = heights.get(y)
    body += `<tr${ht ? ` style="height:${Math.round(ht * 4 / 3)}px"` : ''}><th>${y + 1}</th>`
    for (let x = 0; x <= lastCol; x += 1) {
      const key = `${y}:${x}`
      if (covered.has(key)) continue
      const cell = cells.get(key)
      const merge = merges.get(key)
      const attrs = `${merge && merge.cols > 1 ? ` colspan="${merge.cols}"` : ''}${merge && merge.rows > 1 ? ` rowspan="${merge.rows}"` : ''}${cell?.className ? ` class="${cell.className}"` : ''}${cell?.css ? ` style="${cell.css}"` : ''}`
      body += `<td${attrs}>${cell?.html ?? ''}</td>`
    }
    body += '</tr>'
  }
  body += '</tbody>'
  const note = truncated ? `<div class="ofc-note">${escapeHtml(truncatedNote)}</div>` : ''
  return officeHtml(title, CSS, `${note}<table class="xlsx">${colgroup}${head}${body}</table>`)
}

export interface XlsxLabels {
  /** 大きいシートを先頭だけ出したときの断り */
  truncated: string
}

export interface WorkbookInfo {
  sheets: { name: string; hidden: boolean; part: string }[]
  shared: string[]
  styles: CellStyle[]
  date1904: boolean
}

/** ブックのシートの並び（表のあるシートだけ）・共有文字列・セルの書式 */
export async function readWorkbook(zip: ZipArchive): Promise<WorkbookInfo> {
  const source = await zip.text(WORKBOOK)
  if (source === null) throw new Error('xl/workbook.xml is missing')
  const workbook = documentElement(parseXml(source))
  const rels = parseRels(await zip.text(relsPathOf(WORKBOOK)))
  const date1904 = ['1', 'true'].includes(attr(child(workbook, 'workbookPr'), 'date1904') ?? '')
  const relTarget = (type: string) => [...rels.values()].find((r) => r.type.endsWith(`/${type}`))?.target
  const sharedPart = relTarget('sharedStrings')
  const stylesPart = relTarget('styles')
  const shared = readSharedStrings(sharedPart ? await zip.text(resolvePartPath(WORKBOOK, sharedPart)) : await zip.text('xl/sharedStrings.xml'))
  const styles = readStyles(stylesPart ? await zip.text(resolvePartPath(WORKBOOK, stylesPart)) : await zip.text('xl/styles.xml'))
  const sheets: WorkbookInfo['sheets'] = []
  for (const sheet of descendants(child(workbook, 'sheets'), 'sheet')) {
    const name = attr(sheet, 'name') ?? `Sheet${sheets.length + 1}`
    const rel = rels.get(sheet.attrs['r:id'] ?? attr(sheet, 'id') ?? '')
    // グラフだけのシート（chartsheet）は表が無いので出さない
    if (!rel || rel.external || !rel.type.endsWith('/worksheet')) continue
    sheets.push({ name, hidden: (attr(sheet, 'state') ?? 'visible') !== 'visible', part: resolvePartPath(WORKBOOK, rel.target) })
  }
  return { sheets, shared, styles, date1904 }
}

export async function renderXlsx(zip: ZipArchive, labels: XlsxLabels): Promise<XlsxSheet[]> {
  const { sheets, shared, styles, date1904 } = await readWorkbook(zip)
  return sheets.map(({ name, hidden, part }) => ({ name, hidden, render: () => renderSheet(zip, part, shared, styles, date1904, name, labels.truncated) }))
}
