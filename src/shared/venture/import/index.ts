/**
 * 取り込みの入口（純粋。node・Electron に依存しない）。
 *
 * parseImportFile … 1ファイル（バイト列）→ 行と問題。CSV は元（SourceKind）ごとの列で、JSON（拡張子 .json か { で始まる）は CanonicalFile として読む。
 * detectSource … 置き場所から元を決める（data/imports/<source>/… の <source>、data/agent/… は canonical）。
 * mergeImports … ファイルをまたいだ重複を除く。
 */
import type { ImportIssue, ImportResult, MetricRow, SourceKind } from '../model'
import { decodeBytes, parseCsv } from './csv'
import { addIssue, clip, isSourceKind, readCanonicalJson, readCsvSource } from './sources'
import type { ImportContext } from './sources'

/** 1ファイルの上限（超えれば読まない: tooLarge / tooManyRows） */
export const IMPORT_LIMITS = {
  maxBytes: 20 * 1024 * 1024,
  maxRows: 200_000,
  /** 問題の detail に入れる元の値の長さ */
  detailValueMax: 80
} as const

export interface ImportFileInput {
  /** ビジネスのフォルダからの相対パス（data/imports/google-ads/2026-10.csv など。区切りは / か \） */
  path: string
  source: SourceKind
  bytes: Uint8Array
  /** ビジネスの通貨（ISO 4217） */
  currency: string
}

/**
 * 1ファイルを読む。行と問題の file は data/ からの相対パス（imports/google-ads/2026-10.csv）。data/ を含まないパスはそのまま。
 * 1ファイルの中の同じ日・キャンペーンの行は重複としない（Google 広告の端末別のように分けて書き出した行は足し合わせる）。支払い id の重複は mergeImports が除く。
 */
export function parseImportFile(input: ImportFileInput): ImportResult {
  const file = fileLabel(input.path)
  const ctx: ImportContext = { file, source: input.source, currency: input.currency.trim().toUpperCase(), rows: [], issues: [], skipped: 0 }
  const done = (): ImportResult => ({ rows: ctx.rows, issues: ctx.issues, skipped: ctx.skipped })
  if (!isSourceKind(input.source)) {
    addIssue(ctx, null, 'unknownSource', clip(String(input.source)))
    return done()
  }
  if (input.bytes.length > IMPORT_LIMITS.maxBytes) {
    addIssue(ctx, null, 'tooLarge', String(input.bytes.length))
    return done()
  }
  if (input.bytes.length === 0) {
    addIssue(ctx, null, 'emptyFile')
    return done()
  }
  const decoded = decodeBytes(input.bytes)
  if (!decoded) {
    addIssue(ctx, null, 'encoding')
    return done()
  }
  const text = decoded.text.replace(/^﻿/, '')
  if (text.trim() === '') {
    addIssue(ctx, null, 'emptyFile')
    return done()
  }
  if (/\.json$/i.test(input.path) || text.trimStart().startsWith('{')) {
    readCanonicalJson(text, ctx, IMPORT_LIMITS.maxRows)
    return done()
  }
  const table = parseCsv(text)
  if (table.rows.length > IMPORT_LIMITS.maxRows) {
    addIssue(ctx, null, 'tooManyRows', String(table.rows.length))
    return done()
  }
  readCsvSource(table, ctx)
  return done()
}

function pathParts(path: string): string[] {
  return path.replace(/\\/g, '/').split('/').filter((p) => p !== '' && p !== '.')
}

/** data/imports/<source>/… の <source>、data/agent/… は canonical。どちらでもなければ null（後ろの data/ を優先） */
export function detectSource(path: string): SourceKind | null {
  const parts = pathParts(path)
  for (let i = parts.length - 2; i >= 0; i--) {
    if (parts[i] !== 'data') continue
    if (parts[i + 1] === 'agent' && parts.length > i + 2) return 'canonical'
    if (parts[i + 1] === 'imports' && parts.length > i + 3) {
      const s = parts[i + 2]
      return isSourceKind(s) ? s : null
    }
  }
  return null
}

/** 行と問題に付ける file（data/ からの相対パス） */
export function fileLabel(path: string): string {
  const parts = pathParts(path)
  for (let i = parts.length - 2; i >= 0; i--) {
    if (parts[i] === 'data' && (parts[i + 1] === 'imports' || parts[i + 1] === 'agent')) return parts.slice(i + 1).join('/')
  }
  return parts.join('/')
}

/** 重複の鍵: 支払いは paymentId、ほかは元・日・経路・キャンペーン */
export function rowKey(row: MetricRow): string {
  return row.paymentId ? `p\u0000${row.paymentId}` : `r\u0000${row.source}\u0000${row.date}\u0000${row.channel}\u0000${row.campaign ?? ''}`
}

/**
 * ファイルをまたいだ重複を除く。後のファイルを優先し、捨てた行ごとに duplicate（detail は残した側のファイル）。
 * 元・日・経路・キャンペーンの鍵は、その鍵を持つ一番後のファイルの行を全部残す（同じファイルの中の分割した行は足し合わせるため）。
 * 支払い id は同じファイルの中でも一番後の1行だけ残す。並びは与えた順（ファイルの順、その中の行の順）。問題は各ファイルの問題のあとに duplicate。
 */
export function mergeImports(results: readonly ImportResult[]): ImportResult {
  const lastFile = new Map<string, number>()
  const lastFileName = new Map<string, string>()
  const lastPayment = new Map<string, MetricRow>()
  results.forEach((r, fi) => {
    for (const row of r.rows) {
      const key = rowKey(row)
      lastFile.set(key, fi)
      lastFileName.set(key, row.file)
      if (row.paymentId) lastPayment.set(key, row)
    }
  })
  const rows: MetricRow[] = []
  const duplicates: ImportIssue[] = []
  const issues: ImportIssue[] = []
  let skipped = 0
  results.forEach((r, fi) => {
    issues.push(...r.issues)
    skipped += r.skipped
    for (const row of r.rows) {
      const key = rowKey(row)
      const keep = row.paymentId ? lastPayment.get(key) === row : lastFile.get(key) === fi
      if (keep) {
        rows.push(row)
        continue
      }
      const kept = row.paymentId ? lastPayment.get(key)! : null
      const keptFile = kept ? `${kept.file}:${kept.line}` : (lastFileName.get(key) ?? '')
      duplicates.push({ file: row.file, line: row.line, code: 'duplicate', detail: clip(keptFile, IMPORT_LIMITS.detailValueMax) })
    }
  })
  return { rows, issues: [...issues, ...duplicates], skipped }
}
