/**
 * 取り込みの列名の対応と見出しの行さがし（純粋）。
 *
 * 列名は正規化して比べる: NFKC（全角の英数・空白・括弧を半角に）、BOM を外す、末尾の通貨の括弧（"Amount spent (JPY)"・"費用（JPY）"・"費用 (円)"）を外す、
 * 小文字にする、空白をすべて外す（"Impr." と "impr."、"セッションのデフォルト チャネル グループ" と "セッションのデフォルトチャネルグループ" が同じ）。
 * 括弧の中が UTC・GMT・JST のときは通貨ではないので外さない（"Created date (UTC)"）。
 */
import type { CsvRow } from './csv'

const NOT_CURRENCY = new Set(['UTC', 'GMT', 'JST'])
const CURRENCY_PAREN = /\s*\(\s*([A-Za-z]{3}|円)\s*\)\s*$/

function baseHeader(name: string): string {
  return name.normalize('NFKC').replace(/﻿/g, '').trim()
}

/** 列名の比べる形 */
export function normalizeHeader(name: string): string {
  let s = baseHeader(name)
  const m = CURRENCY_PAREN.exec(s)
  if (m && !NOT_CURRENCY.has(m[1].toUpperCase())) s = s.slice(0, m.index)
  return s.toLowerCase().replace(/\s+/g, '')
}

/** 列名の括弧の通貨（"Amount spent (JPY)" → JPY、"(円)" → JPY）。無ければ null */
export function headerCurrency(name: string): string | null {
  const m = CURRENCY_PAREN.exec(baseHeader(name))
  if (!m) return null
  if (m[1] === '円') return 'JPY'
  const code = m[1].toUpperCase()
  return NOT_CURRENCY.has(code) ? null : code
}

/** 列の鍵 → 列名の候補（先にあるものを優先） */
export type ColumnAliases = Readonly<Record<string, readonly string[]>>

export interface HeaderSpec {
  columns: ColumnAliases
  /** 日付の列の鍵（必須） */
  date: string
  /** このうち少なくとも1つが要る（数の列）。空なら日付だけでよい */
  needAny: readonly string[]
  /** すべて要る列 */
  required?: readonly string[]
}

export type HeaderMatch =
  | {
      ok: true
      /** rows の中の位置 */
      index: number
      line: number
      /** 列の鍵 → 列の位置 */
      columns: Record<string, number>
      /** 列の鍵 → 元の列名 */
      names: Record<string, string>
      /** 列の鍵 → 列名の括弧の通貨 */
      currencies: Record<string, string>
    }
  | { ok: false; code: 'noHeader' | 'missingColumn'; line: number | null; detail?: string }

/** 見出しを探す行の数（Google 広告の表題と期間、GA4 の # の注記のあとに見出しがある） */
export const HEADER_SCAN_ROWS = 50

const aliasCache = new Map<string, string>()
function normAlias(alias: string): string {
  let n = aliasCache.get(alias)
  if (n === undefined) {
    n = normalizeHeader(alias)
    aliasCache.set(alias, n)
  }
  return n
}

/** 1行の値を列の鍵に当てる（列名の候補の順に、最初に見つかった列） */
export function matchColumns(cells: readonly string[], columns: ColumnAliases): Record<string, number> {
  const norm = cells.map(normalizeHeader)
  const out: Record<string, number> = {}
  const used = new Set<number>()
  for (const [key, aliases] of Object.entries(columns)) {
    for (const alias of aliases) {
      const idx = norm.findIndex((c, i) => c === normAlias(alias) && !used.has(i))
      if (idx >= 0) {
        out[key] = idx
        used.add(idx)
        break
      }
    }
  }
  return out
}

/**
 * 先頭から見出しの行を探す。# で始まる行（GA4 の注記）と空行は飛ばす。
 * 日付の列・required の列・needAny のどれか1つがそろう最初の行が見出し。
 * 見つからなければ、一番多く列名が合った行で足りない列を missingColumn に、1つも合わなければ noHeader。
 */
export function findHeader(rows: readonly CsvRow[], spec: HeaderSpec): HeaderMatch {
  let best: { row: CsvRow; matched: Record<string, number>; n: number } | null = null
  for (let i = 0; i < rows.length && i < HEADER_SCAN_ROWS; i++) {
    const row = rows[i]
    const first = row.cells[0]?.trim() ?? ''
    if (first.startsWith('#')) continue
    if (row.cells.every((c) => c.trim() === '')) continue
    const matched = matchColumns(row.cells, spec.columns)
    const missing = missingKeys(matched, spec)
    if (missing.length === 0) {
      const names: Record<string, string> = {}
      const currencies: Record<string, string> = {}
      for (const [key, idx] of Object.entries(matched)) {
        names[key] = baseHeader(row.cells[idx])
        const cur = headerCurrency(row.cells[idx])
        if (cur) currencies[key] = cur
      }
      return { ok: true, index: i, line: row.line, columns: matched, names, currencies }
    }
    const n = Object.keys(matched).length
    if (n > 0 && (!best || n > best.n)) best = { row, matched, n }
  }
  if (!best) return { ok: false, code: 'noHeader', line: null }
  return { ok: false, code: 'missingColumn', line: best.row.line, detail: missingKeys(best.matched, spec).join(', ') }
}

function missingKeys(matched: Record<string, number>, spec: HeaderSpec): string[] {
  const missing: string[] = []
  if (matched[spec.date] === undefined) missing.push(spec.date)
  for (const key of spec.required ?? []) if (matched[key] === undefined) missing.push(key)
  if (spec.needAny.length > 0 && !spec.needAny.some((k) => matched[k] !== undefined)) missing.push(spec.needAny.join('|'))
  return missing
}

/** 合計の行の印（"Total"・"Total: Account"・"合計"・"総計"・"Grand total"） */
export function isTotalLabel(cell: string): boolean {
  const s = cell.normalize('NFKC').trim().toLowerCase()
  return /^(?:total|totals|grand ?total|合計|総計|総合計)(?:\s*:.*)?$/.test(s)
}
