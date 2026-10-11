import { open, readdir, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import type { AgentResourceItem, AgentResourceWarning } from '@shared/agentResources'

/**
 * スキル・コマンド・MCP の一覧を読むための、上限つきの非同期の読み取り。
 * 大きなファイルやたくさんのフォルダでも main を止めないよう、件数と大きさに上限を付ける。
 * 読むだけで、どのファイルも書き換えない。
 */

/** 1つの CLI で集める項目の上限（種類ごと） */
export const MAX_ITEMS_PER_KIND = 500
/** 1つのフォルダから見る項目の上限 */
const MAX_DIR_ENTRIES = 1000
/** 設定ファイル（.claude.json・config.toml など）の上限 */
const MAX_CONFIG_BYTES = 8 * 1024 * 1024
/** SKILL.md・コマンドのファイルは先頭だけを読む（frontmatter と1行目が分かれば足りる） */
const MAX_HEAD_BYTES = 16 * 1024

/** 集めた結果と、読めなかったものの記録 */
export class Collector {
  readonly items: AgentResourceItem[] = []
  readonly warnings: AgentResourceWarning[] = []
  private readonly counts = new Map<string, number>()
  private readonly warned = new Set<string>()

  /** 上限を超えたら false（以後その種類は足さない） */
  add(item: AgentResourceItem): boolean {
    const count = this.counts.get(item.kind) ?? 0
    if (count >= MAX_ITEMS_PER_KIND) {
      this.warn('truncated', item.kind)
      return false
    }
    this.counts.set(item.kind, count + 1)
    this.items.push(item)
    return true
  }

  /** ファイル名だけを記録する（パスにはユーザー名などが入るため） */
  warn(code: AgentResourceWarning['code'], path: string): void {
    const file = basename(path)
    const key = `${code}:${file}`
    if (this.warned.has(key)) return
    this.warned.add(key)
    this.warnings.push({ code, file })
  }
}

/** フォルダの中身（名前と種類）。無ければ空。上限を超えた分は見ない */
export async function listDir(dir: string): Promise<Array<{ name: string; isDir: boolean; isFile: boolean }>> {
  try {
    const entries = await readdir(dir, { withFileTypes: true })
    const picked = entries.slice(0, MAX_DIR_ENTRIES)
    // シンボリックリンク（共有したスキルなど）は、たどった先の種類で判断する
    return await Promise.all(
      picked.map(async (entry) => {
        if (!entry.isSymbolicLink()) return { name: entry.name, isDir: entry.isDirectory(), isFile: entry.isFile() }
        try {
          const target = await stat(join(dir, entry.name))
          return { name: entry.name, isDir: target.isDirectory(), isFile: target.isFile() }
        } catch {
          return { name: entry.name, isDir: false, isFile: false }
        }
      })
    )
  } catch {
    return []
  }
}

/** ファイルの先頭だけを読む。無ければ null */
export async function readHead(path: string, maxBytes = MAX_HEAD_BYTES): Promise<string | null> {
  let handle: Awaited<ReturnType<typeof open>> | null = null
  try {
    handle = await open(path, 'r')
    const buffer = Buffer.alloc(maxBytes)
    const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0)
    return buffer.subarray(0, bytesRead).toString('utf8')
  } catch {
    return null
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

type ConfigRead = { kind: 'missing' } | { kind: 'tooLarge' } | { kind: 'ok'; text: string }

/** 設定ファイルを丸ごと読む。大きすぎれば読まない */
export async function readConfig(path: string): Promise<ConfigRead> {
  try {
    const info = await stat(path)
    if (!info.isFile()) return { kind: 'missing' }
    if (info.size > MAX_CONFIG_BYTES) return { kind: 'tooLarge' }
  } catch {
    return { kind: 'missing' }
  }
  const text = await readHead(path, MAX_CONFIG_BYTES)
  return text === null ? { kind: 'missing' } : { kind: 'ok', text }
}

/** JSON の設定ファイル。壊れていれば記録して null */
export async function readJsonConfig(path: string, collector: Collector): Promise<Record<string, unknown> | null> {
  const read = await readConfig(path)
  if (read.kind === 'missing') return null
  if (read.kind === 'tooLarge') {
    collector.warn('tooLarge', path)
    return null
  }
  try {
    const value = JSON.parse(read.text) as unknown
    if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>
  } catch {
    // 下で記録する
  }
  collector.warn('broken', path)
  return null
}

export { asRecord } from '@shared/guards'

const DESCRIPTION_MAX = 300

function clip(text: string): string {
  const single = text.replace(/\s+/g, ' ').trim()
  return single.length > DESCRIPTION_MAX ? `${single.slice(0, DESCRIPTION_MAX - 1)}…` : single
}

/**
 * Markdown の frontmatter（--- で囲んだ先頭）から、name と description を読む。
 * YAML を全部は解釈せず、`key: value` の1行と、`key: >` / `|` の続く行だけを扱う。
 */
export function parseFrontmatter(text: string): { name: string | null; description: string | null; body: string } {
  const normalized = text.replace(/^﻿/, '').replace(/\r\n/g, '\n')
  const match = /^---\n([\s\S]*?)\n---\n?/.exec(normalized)
  if (!match) return { name: null, description: null, body: normalized }
  const fields = new Map<string, string>()
  const lines = match[1]!.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(lines[i]!)
    if (!line) continue
    const key = line[1]!.toLowerCase()
    let value = line[2]!.trim()
    if (value === '>' || value === '|' || value === '>-' || value === '|-' || value === '') {
      const continued: string[] = []
      while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1]!)) continued.push(lines[++i]!.trim())
      value = continued.join(' ')
    }
    fields.set(key, value.replace(/^(['"])([\s\S]*)\1$/, '$2'))
  }
  const name = fields.get('name')
  const description = fields.get('description')
  return { name: name ? clip(name) : null, description: description ? clip(description) : null, body: normalized.slice(match[0].length) }
}

/** frontmatter の description、無ければ本文の最初の意味のある行 */
export function describeMarkdown(text: string): { name: string | null; description: string | null } {
  const { name, description, body } = parseFrontmatter(text)
  if (description) return { name, description }
  const first = body
    .split('\n')
    .map((line) => line.replace(/^#+\s*/, '').trim())
    .find((line) => line.length > 0)
  return { name, description: first ? clip(first) : null }
}
