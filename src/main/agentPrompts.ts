import { createHash } from 'node:crypto'
import { lstat, open, readdir, readFile, realpath } from 'node:fs/promises'
import { join, sep } from 'node:path'
import type { Project } from '@shared/types'
import { AGENT_REQUEST_CLOSING } from '@shared/agentRequests'
import { CLOUD_LIMITS } from '@shared/feedbackCloud'
import { isNoiseFeedback, type FeedbackEntry } from '@shared/feedbackSkill'
import { en } from '@shared/i18n/en'
import { ja } from '@shared/i18n/ja'
import { SECRET_PATTERNS } from '@shared/telemetry'

/**
 * Agent（Claude Code・Codex・Gemini CLI・Antigravity・Qwen Code）に人が打った指示を、各 Agent の履歴から集める。
 * 何度も言わせていること（繰り返し出る指示）を skill「ferret-feedback」の feedback.md に載せ、次から言われる前に守らせる。
 * Electron に依存させない（単体テストで一時フォルダのホームを渡す）。
 *
 * - 読むのは履歴のファイルだけ（読むだけ）。大きいファイルは末尾の MAX_TAIL_BYTES だけ。変わっていなければ前に読んだ結果を使う（mtime と大きさ）
 * - 残すのは、作業したフォルダが Ferret に登録したプロジェクトの中の指示だけ（→ プロジェクトの名前）。直近 MAX_AGE_DAYS 日・1つのプロジェクトで新しい順に MAX_PROMPTS_PER_PROJECT 件まで
 * - スラッシュコマンド・Agent や Ferret が自動で入れた文・相づちだけの文・パスや URL だけの文は捨てる
 * - 秘密に見える文字列は、記録する前・送る前に伏せる。長い文は CLOUD_LIMITS.textChars で切る
 *
 * 履歴の形（このマシンで確かめたもの）:
 * - Claude Code: <CLAUDE_CONFIG_DIR|~/.claude>/history.jsonl … {display, timestamp(ミリ秒), project(作業フォルダ), pastedContents}
 * - Codex: <CODEX_HOME|~/.codex>/history.jsonl … {session_id, ts(秒), text}。作業フォルダは sessions/YYYY/MM/DD/rollout-*-<session_id>.jsonl の1行目（session_meta の payload.cwd）
 * - Antigravity（CLI）: ~/.gemini/antigravity-cli/history.jsonl … {display, timestamp(ミリ秒), workspace}
 * - Gemini CLI: ~/.gemini/tmp/<フォルダ>/logs.json … [{type:'user', message, timestamp(ISO)}]。<フォルダ> は作業フォルダの SHA-256、
 *   または名前（中の .project_root に作業フォルダ）
 * - Qwen Code: ~/.qwen/tmp/<作業フォルダの SHA-256>/logs.json … Gemini CLI と同じ形
 * Antigravity の IDE（~/.gemini/antigravity/conversations/*.pb）は中身が読めない形なので集めない
 */

export type PromptAgent = 'claude' | 'codex' | 'gemini' | 'antigravity' | 'qwen'

export const PROMPT_AGENT_NAMES: Record<PromptAgent, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  gemini: 'Gemini CLI',
  antigravity: 'Antigravity',
  qwen: 'Qwen Code'
}

/** 1つのファイルで読む末尾の大きさ */
export const MAX_TAIL_BYTES = 16 * 1024 * 1024
/** これより古い指示は集めない */
export const MAX_AGE_DAYS = 180
/** 1つのプロジェクトで残す指示の数（新しい順） */
export const MAX_PROMPTS_PER_PROJECT = 1500
/** Codex のセッションのファイルで、作業フォルダを探すために頭から読む量 */
const SESSION_HEAD_BYTES = 64 * 1024

/** 履歴から読んだ指示の1件（まだプロジェクトに結び付けていない） */
export interface RawPrompt {
  agent: PromptAgent
  text: string
  /** ミリ秒 */
  at: number
  /** 作業フォルダ（Codex は読んだあとに sessionId から埋める） */
  cwd: string
  file: string
  sessionId?: string
}

// ---- 履歴の読み方（純粋。テストで文字列を渡す） ----

function jsonLines(text: string): unknown[] {
  const out: unknown[] = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try { out.push(JSON.parse(line)) } catch { /* 途中で切れた行・壊れた行は飛ばす（想定内） */ }
  }
  return out
}

function obj(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

/** Claude Code の history.jsonl */
export function parseClaudeHistory(text: string, file: string): RawPrompt[] {
  return jsonLines(text).flatMap((raw) => {
    const r = obj(raw)
    const at = num(r?.timestamp)
    if (!r || typeof r.display !== 'string' || typeof r.project !== 'string' || at === null) return []
    return [{ agent: 'claude' as const, text: r.display, at, cwd: r.project, file }]
  })
}

/** Codex の history.jsonl（作業フォルダは無い。sessionId で後から埋める） */
export function parseCodexHistory(text: string, file: string): RawPrompt[] {
  return jsonLines(text).flatMap((raw) => {
    const r = obj(raw)
    const ts = num(r?.ts)
    if (!r || typeof r.text !== 'string' || typeof r.session_id !== 'string' || ts === null) return []
    return [{ agent: 'codex' as const, text: r.text, at: ts * 1000, cwd: '', file, sessionId: r.session_id }]
  })
}

/** Codex のセッションのファイルの頭（1行目の session_meta）から作業フォルダ。無ければ null */
export function codexSessionCwd(head: string): string | null {
  const first = head.split('\n', 1)[0] ?? ''
  try {
    const r = obj(JSON.parse(first))
    const cwd = obj(r?.payload)?.cwd
    if (typeof cwd === 'string' && cwd) return cwd
  } catch {
    // 1行目が長くて頭に収まらない。cwd は base_instructions より前に書かれるので、そこだけ拾う（想定内）
  }
  const m = /"cwd"\s*:\s*("(?:[^"\\]|\\.)*")/.exec(first)
  if (!m) return null
  try { return JSON.parse(m[1]!) as string } catch { return null }
}

/** Antigravity（CLI）の history.jsonl */
export function parseAntigravityHistory(text: string, file: string): RawPrompt[] {
  return jsonLines(text).flatMap((raw) => {
    const r = obj(raw)
    const at = num(r?.timestamp)
    if (!r || typeof r.display !== 'string' || typeof r.workspace !== 'string' || at === null) return []
    return [{ agent: 'antigravity' as const, text: r.display, at, cwd: r.workspace, file }]
  })
}

/** Gemini CLI・Qwen Code の logs.json（作業フォルダはフォルダから分かる） */
export function parseGeminiLogs(text: string, agent: 'gemini' | 'qwen', cwd: string, file: string): RawPrompt[] {
  let raw: unknown
  try { raw = JSON.parse(text) } catch { return [] }
  if (!Array.isArray(raw)) return []
  return raw.flatMap((item) => {
    const r = obj(item)
    if (!r || r.type !== 'user' || typeof r.message !== 'string' || typeof r.timestamp !== 'string') return []
    const at = Date.parse(r.timestamp)
    return Number.isFinite(at) ? [{ agent, text: r.message, at, cwd, file }] : []
  })
}

// ---- 捨てる文・伏せる文字列（純粋） ----

/** Ferret が Agent へ入れる文の、変わらない部分（日英）。これを含む指示は Ferret が作った文なので数えない */
const FERRET_FINGERPRINTS: string[] = (() => {
  const keys = Object.keys(en).filter((k) => k.startsWith('agentPrompt.') || k.startsWith('failover.handoff.') || k === 'review.remote.intro' || k === 'terminal.continueWork')
  const out = new Set<string>([AGENT_REQUEST_CLOSING.ja, AGENT_REQUEST_CLOSING.en].map((s) => s.slice(0, 40)))
  for (const dict of [en, ja] as Array<Record<string, string>>) {
    for (const key of keys) {
      const longest = (dict[key] ?? '').split(/\{\{\w+\}\}/).map((s) => s.trim()).sort((a, b) => b.length - a.length)[0] ?? ''
      if (longest.length >= 20) out.add(longest.slice(0, 40))
    }
  }
  return [...out]
})()

/** 相づち・続けての合図だけ（指示として数えない） */
const ACK = /^(?:はい|うん|ええ|ok(?:ay)?|おけ|yes|y|no|n|go|continue|cont|stop|next|done|retry|lgtm|thanks?|thank you|ty|sure|続けて|続けてください|進めて|進めてください|続行|続行して|再開|お願いします|おねがいします|お願い|よろしく(?:お願いします)?|了解|りょうかい|いいよ|いいね|いいです|大丈夫|それで|それでいい|それでお願いします|そのまま|そのままで|どう|今どう|どうですか|どうなった|どうなりました|終わった|終わりました|ありがとう|ありがとうございます|やって|やってください|[0-9]{1,2})$/i

const PASTE_MARK = /\[(?:Pasted text #\d+(?: \+\d+ lines)?|Image #\d+)\]/g
const URL_OR_PATH = /(?:https?|file):\/\/\S+|git@\S+|(["'`])(?:\/|~\/|[A-Za-z]:\\)[^"'`]*\1|(?:^|\s)(?:\/|~\/|[A-Za-z]:\\)\S+/g

/** 秘密に見える文字列を伏せる（API キーの形・Bearer・JWT・長い16進・秘密鍵・password=… など） */
export function redactPromptSecrets(text: string): string {
  let s = text.replace(/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g, '<secret>')
  s = s.replace(/\/\/[^\s/:@]+:[^\s/@]+@/g, '//<secret>@')
  s = s.replace(/\b((?:password|passwd|pwd|secret|token|api[_-]?key|apikey|access[_-]?key|client[_-]?secret|private[_-]?key)["']?\s*[:=]\s*)(["']?)[^\s"']{4,}\2/gi, '$1<secret>')
  s = s.replace(/((?:パスワード|暗証番号|シークレット)\s*(?:は|:|：|=)\s*)\S+/g, '$1<secret>')
  for (const re of SECRET_PATTERNS) s = s.replace(re, '<secret>')
  return s
}

/** ホームのフォルダ（ユーザー名を含む）を ~ にする。送る文にユーザー名を入れない */
export function redactHomePaths(text: string): string {
  return text
    .replace(/\/(?:Users|home)\/[^/\s'"`]+/g, '~')
    .replace(/\b[A-Za-z]:\\Users\\[^\\\s'"`]+/g, '~')
}

/**
 * 1件の指示を、数えて載せる形にする。指示として数えないもの（スラッシュコマンド・自動で入った文・相づち・パスや URL だけ）は null。
 * 秘密を伏せ、CLOUD_LIMITS.textChars で切る
 */
export function cleanPrompt(raw: string): string | null {
  const text = raw.replace(PASTE_MARK, ' ').replace(/\r\n?/g, '\n').trim()
  if (!text) return null
  // スラッシュコマンド（/model・/clear）と、Claude Code のシェルのモード（!ls）
  if (/^\/[A-Za-z][\w:.-]*(?:\s|$)/.test(text) || /^!\s*\S/.test(text)) return null
  // タグで包んだ文（Agent が入れたコマンドの出力・<environment_context> など）
  if (/^<([A-Za-z][\w-]*)(?:\s[^>]*)?>[\s\S]*<\/\1>/.test(text)) return null
  // Ferret が入れた文（[Ferret visual review] など・依頼の結び・引き継ぎの文）と、計画モードが入れる文
  if (/^(?:\[Ferret\b|【Ferret)/.test(text) || /^Implement the following plan:/i.test(text)) return null
  if (FERRET_FINGERPRINTS.some((f) => text.includes(f))) return null
  // パスや URL を除くと何も残らない（ファイルを落としただけ・リンクを貼っただけ）
  const rest = text.replace(URL_OR_PATH, ' ').trim()
  if (!rest || isNoiseFeedback(rest)) return null
  const core = text.toLowerCase().replace(/[\s、。，．,.!?！？…〜~ー]+/g, '').replace(/(?:です|ね|よ|な)$/u, '')
  if (ACK.test(core)) return null
  if (isNoiseFeedback(text)) return null
  const clean = redactHomePaths(redactPromptSecrets(text)).trim().slice(0, CLOUD_LIMITS.textChars)
  return clean || null
}

// ---- ファイルを読む（末尾だけ・変わっていなければ前の結果） ----

const cache = new Map<string, { mtimeMs: number; size: number; value: unknown }>()
/** Codex のセッション id → 作業フォルダ（セッションの作業フォルダは変わらない） */
const codexCwd = new Map<string, string>()

/** テスト用: 読んだ結果の控えを捨てる */
export function resetAgentPromptCache(): void {
  cache.clear()
  codexCwd.clear()
}

/** 普通のファイルの末尾（MAX_TAIL_BYTES まで。途中から始まる最初の行は捨てる）を読んで parse する。変わっていなければ前の結果。読めなければ null */
async function readCached<T>(path: string, parse: (text: string) => T, whole = false): Promise<T | null> {
  let st
  try { st = await lstat(path) } catch { return null } // 無い（想定内）
  if (st.isSymbolicLink() || !st.isFile()) return null
  const hit = cache.get(path)
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.value as T
  if (whole && st.size > MAX_TAIL_BYTES) return null
  let text: string
  try {
    if (st.size <= MAX_TAIL_BYTES) text = await readFile(path, 'utf8')
    else {
      const handle = await open(path, 'r')
      try {
        const buffer = Buffer.alloc(MAX_TAIL_BYTES)
        await handle.read(buffer, 0, MAX_TAIL_BYTES, st.size - MAX_TAIL_BYTES)
        const tail = buffer.toString('utf8')
        text = tail.slice(tail.indexOf('\n') + 1)
      } finally {
        await handle.close()
      }
    }
  } catch {
    return null // 読めない（想定内）
  }
  const value = parse(text)
  cache.set(path, { mtimeMs: st.mtimeMs, size: st.size, value })
  return value
}

async function readHead(path: string, bytes: number): Promise<string | null> {
  try {
    const st = await lstat(path)
    if (st.isSymbolicLink() || !st.isFile()) return null
    const handle = await open(path, 'r')
    try {
      const buffer = Buffer.alloc(Math.min(bytes, st.size))
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
      return buffer.subarray(0, bytesRead).toString('utf8')
    } finally {
      await handle.close()
    }
  } catch {
    return null
  }
}

async function dirNames(dir: string): Promise<string[]> {
  try {
    if ((await lstat(dir)).isSymbolicLink()) return []
    return await readdir(dir)
  } catch {
    return []
  }
}

/** Codex の sessions/YYYY/MM/DD/ から、欲しいセッションの作業フォルダを埋める（since より前の日のフォルダは見ない） */
async function fillCodexCwd(codexHome: string, wanted: Set<string>, since: number): Promise<void> {
  const missing = new Set([...wanted].filter((id) => !codexCwd.has(id)))
  if (!missing.size) return
  const sinceDay = new Date(since).toISOString().slice(0, 10)
  const root = join(codexHome, 'sessions')
  for (const year of await dirNames(root)) {
    if (!/^\d{4}$/.test(year) || year < sinceDay.slice(0, 4)) continue
    for (const month of await dirNames(join(root, year))) {
      if (!/^\d{2}$/.test(month) || `${year}-${month}` < sinceDay.slice(0, 7)) continue
      for (const day of await dirNames(join(root, year, month))) {
        if (!/^\d{2}$/.test(day) || `${year}-${month}-${day}` < sinceDay) continue
        for (const name of await dirNames(join(root, year, month, day))) {
          const m = /^rollout-.*-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i.exec(name)
          if (!m || !missing.has(m[1]!)) continue
          const head = await readHead(join(root, year, month, day, name), SESSION_HEAD_BYTES)
          const cwd = head ? codexSessionCwd(head) : null
          if (cwd) codexCwd.set(m[1]!, cwd)
          missing.delete(m[1]!)
          if (!missing.size) return
        }
      }
    }
  }
}

/** Gemini CLI・Qwen Code の tmp/ の下のフォルダのうち、登録したプロジェクトのもの（フォルダ → 作業フォルダ） */
async function geminiDirs(tmp: string, folders: ReadonlyArray<{ path: string; hash: string }>): Promise<Array<{ dir: string; cwd: string }>> {
  const out: Array<{ dir: string; cwd: string }> = []
  for (const name of await dirNames(tmp)) {
    const dir = join(tmp, name)
    const byHash = folders.find((f) => f.hash === name)
    if (byHash) { out.push({ dir, cwd: byHash.path }); continue }
    const root = await readHead(join(dir, '.project_root'), 4096)
    if (root?.trim()) out.push({ dir, cwd: root.trim() })
  }
  return out
}

// ---- まとめ ----

interface Folder {
  name: string
  /** 比べる形（フォルダのパスと、リンクをたどったパス） */
  paths: string[]
}

function strip(path: string): string {
  return path.length > 1 ? path.replace(/[\\/]+$/, '') : path
}

/** 作業フォルダが入っているプロジェクト（いちばん深いもの）。無ければ null */
export function projectFor(cwd: string, folders: readonly Folder[]): string | null {
  const c = strip(cwd)
  let best: { name: string; len: number } | null = null
  for (const f of folders) {
    for (const p of f.paths) {
      if ((c === p || c.startsWith(p + sep) || c.startsWith(p + '/')) && (!best || p.length > best.len)) best = { name: f.name, len: p.length }
    }
  }
  return best?.name ?? null
}

/** 履歴の置き場（環境変数が指していればそこ） */
export function agentHistoryFiles(home: string, env: NodeJS.ProcessEnv): { claude: string; codexHome: string; antigravity: string; geminiTmp: string; qwenTmp: string } {
  const claudeDir = env.CLAUDE_CONFIG_DIR?.trim() || join(home, '.claude')
  const codexHome = env.CODEX_HOME?.trim() || join(home, '.codex')
  return {
    claude: join(claudeDir, 'history.jsonl'),
    codexHome,
    antigravity: join(home, '.gemini', 'antigravity-cli', 'history.jsonl'),
    geminiTmp: join(home, '.gemini', 'tmp'),
    qwenTmp: join(home, '.qwen', 'tmp')
  }
}

/**
 * 登録したプロジェクトの中で、人が Agent に打った指示を集める（新しい順・プロジェクトごとに上限まで）。
 * 投げない（読めない履歴は飛ばす）
 */
export async function collectAgentPrompts(projects: ReadonlyArray<Pick<Project, 'name' | 'folderPath'>>, home: string, env: NodeJS.ProcessEnv, now: number = Date.now()): Promise<FeedbackEntry[]> {
  if (!projects.length) return []
  const folders: Folder[] = await Promise.all(projects.map(async (p) => {
    const paths = new Set([strip(p.folderPath)])
    try { paths.add(strip(await realpath(p.folderPath))) } catch { /* 無いフォルダ（想定内） */ }
    return { name: p.name, paths: [...paths] }
  }))
  const hashes = folders.flatMap((f) => f.paths.map((path) => ({ path, hash: createHash('sha256').update(path).digest('hex') })))
  const since = now - MAX_AGE_DAYS * 24 * 60 * 60 * 1000
  const files = agentHistoryFiles(home, env)
  const codexFile = join(files.codexHome, 'history.jsonl')

  const lists = await Promise.all([
    readCached(files.claude, (t) => parseClaudeHistory(t, files.claude)),
    readCached(codexFile, (t) => parseCodexHistory(t, codexFile)),
    readCached(files.antigravity, (t) => parseAntigravityHistory(t, files.antigravity)),
    ...(['gemini', 'qwen'] as const).map(async (agent) => {
      const dirs = await geminiDirs(agent === 'gemini' ? files.geminiTmp : files.qwenTmp, hashes)
      const all = await Promise.all(dirs.map(({ dir, cwd }) => {
        const file = join(dir, 'logs.json')
        return readCached(file, (t) => parseGeminiLogs(t, agent, cwd, file), true)
      }))
      return all.flatMap((l) => l ?? [])
    })
  ])
  const raw = lists.flatMap((l) => l ?? []).filter((p) => p.at >= since && p.at <= now + 24 * 60 * 60 * 1000)

  // Codex は作業フォルダをセッションのファイルから
  const codexIds = new Set(raw.filter((p) => p.agent === 'codex' && p.sessionId).map((p) => p.sessionId!))
  if (codexIds.size) await fillCodexCwd(files.codexHome, codexIds, since).catch(() => undefined)

  const byProject = new Map<string, FeedbackEntry[]>()
  for (const p of raw.sort((a, b) => b.at - a.at)) {
    const cwd = p.agent === 'codex' ? codexCwd.get(p.sessionId ?? '') ?? '' : p.cwd
    if (!cwd) continue
    const project = projectFor(cwd, folders)
    if (!project) continue
    const list = byProject.get(project) ?? []
    if (list.length >= MAX_PROMPTS_PER_PROJECT) continue
    const text = cleanPrompt(p.text)
    if (!text) continue
    list.push({ project, source: 'agent-prompt', title: PROMPT_AGENT_NAMES[p.agent], at: new Date(p.at).toISOString(), text, file: p.file })
    byProject.set(project, list)
  }
  return [...byProject.values()].flat()
}
