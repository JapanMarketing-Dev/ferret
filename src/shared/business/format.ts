/**
 * 記録ファイルの読み書き（YAML の前置きつき Markdown と、business.yaml）。
 * YAML は安全な読み方（任意の型を作らない core スキーマ）で、大きさ・入れ子・別名の展開に上限を付ける。
 */
import { Document, isScalar, parseDocument, visit } from 'yaml'

/** 1ファイルの上限（バイト）。これより大きい記録は読まない */
export const MAX_RECORD_BYTES = 512 * 1024

// resolveKnownTags: false で !!binary・!!timestamp なども文字のまま読む（任意の型を作らない）
const PARSE_OPTIONS = { schema: 'core', maxAliasCount: 50, uniqueKeys: false, prettyErrors: false, resolveKnownTags: false } as const

export class RecordParseError extends Error {}

/** UTF-8 のバイト数が上限を超えるか（日本語は1文字3バイト。文字数だけで見ると上限の3倍まで通ってしまう） */
function tooLarge(text: string): boolean {
  if (text.length > MAX_RECORD_BYTES) return true
  if (text.length * 3 <= MAX_RECORD_BYTES) return false
  return new TextEncoder().encode(text).length > MAX_RECORD_BYTES
}

function sizeError(): RecordParseError {
  return new RecordParseError(`大きすぎるので読みません（${MAX_RECORD_BYTES / 1024}KB まで）`)
}

export function parseYaml(text: string): unknown {
  if (tooLarge(text)) throw sizeError()
  try {
    const doc = parseDocument(text, PARSE_OPTIONS)
    if (doc.errors.length > 0) throw new RecordParseError(`YAML を読めません: ${doc.errors[0]!.message.split('\n')[0]}`)
    return doc.toJS({ maxAliasCount: 50 })
  } catch (e) {
    if (e instanceof RecordParseError) throw e
    // 深すぎる入れ子・別名の爆発など、ライブラリが投げたものも同じ種類の失敗にそろえる
    throw new RecordParseError(`YAML を読めません: ${e instanceof Error ? e.message.split('\n')[0] : String(e)}`)
  }
}

/**
 * 引用符なしで書くと、文字以外に読まれうる文字列（YAML 1.1 の読み手も含む）。
 * core スキーマで読む限り yes・2026-10-17 は文字のままだが、Agent が使う別の YAML 読み手（YAML 1.1）は真偽値・日付・60進数に変える。
 * 人や Agent が手で直しても型が変わらないよう、こうした値は必ず引用符で囲む。
 */
const TYPED_LOOKING = [
  /^(?:y|Y|yes|Yes|YES|n|N|no|No|NO|true|True|TRUE|false|False|FALSE|on|On|ON|off|Off|OFF)$/,
  /^(?:~|null|Null|NULL|=|<<)$/,
  /^[-+]?(?:0b[01_]+|0o?[0-7_]+|0x[0-9a-fA-F_]+|[0-9][0-9_]*(?::[0-5]?[0-9])*)$/,
  /^[-+]?(?:[0-9][0-9_]*)?\.[0-9_]*(?:[eE][-+]?[0-9]+)?$/,
  /^[-+]?[0-9][0-9_]*(?:\.[0-9_]*)?[eE][-+]?[0-9]+$/,
  /^[-+]?\.(?:inf|Inf|INF)$|^\.(?:nan|NaN|NAN)$/,
  /^\d{4}-\d{1,2}-\d{1,2}(?:(?:[Tt]|[ \t]+)\d{1,2}:\d{2}:\d{2}(?:\.\d*)?(?:[ \t]*(?:Z|[-+]\d{1,2}(?::?\d{2})?))?)?$/
]

function looksTyped(s: string): boolean {
  return TYPED_LOOKING.some((re) => re.test(s))
}

export function dumpYaml(value: unknown): string {
  const doc = new Document(value, { aliasDuplicateObjects: false })
  visit(doc, {
    Scalar(_key, node) {
      if (isScalar(node) && typeof node.value === 'string' && looksTyped(node.value)) node.type = 'QUOTE_DOUBLE'
    }
  })
  return doc.toString({ lineWidth: 0, defaultStringType: 'PLAIN', defaultKeyType: 'PLAIN' })
}

/** --- で囲んだ前置きと本文に分ける。前置きが無ければ全体が本文 */
export function splitFrontMatter(text: string): { front: string | null; body: string } {
  const normalized = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n')
  if (!normalized.startsWith('---\n')) return { front: null, body: normalized }
  // 閉じの --- は行全体（後ろの空白は許す）。「---x」や「----」は閉じとみなさない。前置きが空（---\n---）も読む
  const close = /\n---[ \t]*(?:\n|$)/g
  close.lastIndex = 3
  const m = close.exec(normalized)
  if (!m) return { front: null, body: normalized }
  const end = m.index
  const after = normalized.slice(end + m[0].length)
  return { front: normalized.slice(4, end + 1), body: after.replace(/^\n/, '') }
}

export function parseRecordFile(text: string): { data: unknown; body: string } {
  if (tooLarge(text)) throw sizeError()
  const { front, body } = splitFrontMatter(text)
  if (front === null) throw new RecordParseError('先頭の --- で囲んだ YAML がありません')
  return { data: front.trim() ? parseYaml(front) : {}, body }
}

export function formatRecordFile(data: unknown, body: string): string {
  const yaml = dumpYaml(data).trimEnd()
  const text = body.replace(/\r\n?/g, '\n').trim()
  return `---\n${yaml}\n---\n${text ? `\n${text}\n` : ''}`
}

/** searches.jsonl（1行1件。壊れた行は飛ばして数を返す） */
export function parseJsonl(text: string, maxLines = 5000): { rows: unknown[]; broken: number } {
  const rows: unknown[] = []
  let broken = 0
  const limit = Math.floor(maxLines)
  if (!(limit > 0)) return { rows, broken }
  // 空行（末尾の改行など）は数に入れずに、最後の maxLines 行を読む
  const lines = text.split(/\r?\n/).filter((line) => line.trim())
  for (const line of lines.slice(-limit)) {
    try {
      rows.push(JSON.parse(line))
    } catch {
      broken++
    }
  }
  return { rows, broken }
}
