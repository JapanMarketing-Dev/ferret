import { delay } from '@shared/delay'
import { randomUUID } from 'node:crypto'
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, normalize, resolve } from 'node:path'
import { errorKind, reportHandled } from '@shared/report'
import { isRecord } from '@shared/guards'

/**
 * 登録したプロジェクトのフォルダを、起動するエージェントに「信頼済み」として先に書いておく。
 * 自動起動した Claude Code / Codex に「このフォルダを信頼しますか」の確認を出さないため。
 *
 * Orca由来: ~/bench/orca/src/main/claude/claude-folder-trust-file.ts（applyClaudeFolderTrust,
 *           resolveClaudeGlobalConfigFile, toClaudeTrustKey, claudeTrustKeysForHostPath, grantClaudeFolderTrust）,
 *           ~/bench/orca/src/main/agent-trust-presets.ts（markCodexProjectTrusted）,
 *           ~/bench/orca/src/main/codex/config-toml-project-trust.ts（upsertProjectTrustContent）,
 *           ~/bench/orca/src/main/agent-workspace-trust.ts, agent-trust-write-deadline.ts（MIT, Copyright 2026 Lovecast Inc.）
 *
 * Orca と同じ約束を守る:
 * - エージェント自身が「信頼する」を選んだときに書くのと同じ項目だけを足す（Claude は ~/.claude.json の
 *   projects[<path>].hasTrustDialogAccepted、Codex は config.toml の [projects."<path>"] trust_level = "trusted"）
 * - 設定ファイルを読んで、その項目だけを足す。読めない・壊れているファイルは書き換えない（エージェントが聞けばよい）
 * - Claude の設定ファイルは作らない（まだ一度も起動していない Claude には書く先が無いので、聞かせる）
 * - Claude のロック（<file>.lock）を尊重し、取れなければ書かない。ロックを壊さない
 * - 一時ファイルに書いて名前を変える（原子的に置き換える）。元の権限を保つ
 * - 待つのは短い時間だけ。間に合わなければそのまま起動する（そのときはエージェントが確認を出す）
 *
 * 書くのは、設定の「権限確認を省いて起動する」（agents.skipPermissions）が入のときの、登録したプロジェクトのフォルダそのものだけ。
 * 切なら書かず、エージェント自身が「信頼しますか」を聞く。ホームやサブフォルダには書かない。
 */

type TrustOutcome = 'granted' | 'unchanged' | 'missing-config' | 'locked' | 'unreadable' | 'skipped'

/** 書き込みを待つ上限。Orca の SHORT_AGENT_TRUST_WRITE_DEADLINE_MS と同じ */
const TRUST_WRITE_DEADLINE_MS = 1500


// ───────────────────────── Claude Code ─────────────────────────

/** Claude は NFC にそろえて normalize したパスで探す */
function toClaudeTrustKey(folderPath: string): string {
  return normalize(folderPath.normalize('NFC'))
}

/** フォルダの、そのままの形と realpath の形の両方をキーにする（/tmp と /private/tmp のような違い） */
function claudeTrustKeys(folderPath: string): string[] {
  const forms = [resolve(folderPath)]
  try {
    forms.push(realpathSync.native(folderPath))
  } catch {
    /* realpath が取れなくても、そのままの形で合う */
  }
  return [...new Set(forms.map(toClaudeTrustKey))]
}

/**
 * Claude Code が読む設定ファイル。古い <configDir>/.config.json があればそれ、
 * 無ければ CLAUDE_CONFIG_DIR（アカウント切り替え）かホームの .claude.json
 */
export function resolveClaudeGlobalConfigFile(args: {
  env: { CLAUDE_CONFIG_DIR?: string; CLAUDE_CODE_CUSTOM_OAUTH_URL?: string }
  homeDir: string
  exists: (filePath: string) => boolean
}): string {
  const legacyDir = (args.env.CLAUDE_CONFIG_DIR || join(args.homeDir, '.claude')).normalize('NFC')
  const legacyFile = join(legacyDir, '.config.json')
  if (args.exists(legacyFile)) return legacyFile
  const suffix = args.env.CLAUDE_CODE_CUSTOM_OAUTH_URL ? '-custom-oauth' : ''
  return join(args.env.CLAUDE_CONFIG_DIR || args.homeDir, `.claude${suffix}.json`)
}

type ClaudeFolderTrustChange =
  | { kind: 'unchanged' }
  | { kind: 'refuse' }
  | { kind: 'changed'; config: Record<string, unknown> }

/** projects[<key>].hasTrustDialogAccepted = true を足した設定（ほかの項目はそのまま） */
export function applyClaudeFolderTrust(config: Record<string, unknown>, folderKeys: readonly string[]): ClaudeFolderTrustChange {
  if (config.projects !== undefined && !isRecord(config.projects)) return { kind: 'refuse' }
  const projects: Record<string, unknown> = { ...(config.projects as Record<string, unknown> | undefined) }
  const alreadyTrusted = folderKeys.some((key) => {
    const entry = projects[key]
    return isRecord(entry) && entry.hasTrustDialogAccepted === true
  })
  if (alreadyTrusted) return { kind: 'unchanged' }
  for (const key of folderKeys) {
    const entry = projects[key]
    projects[key] = isRecord(entry) ? { ...entry, hasTrustDialogAccepted: true } : { hasTrustDialogAccepted: true }
  }
  return { kind: 'changed', config: { ...config, projects } }
}

/**
 * ~/.claude.json は会話の履歴を持ち、何十 MB にもなる。main で同期に読んで JSON にして書き直すので、
 * 大きすぎるものは書き換えない（エージェントが自分で信頼の確認を出す）。main が長く止まる・メモリが跳ねるのを防ぐ
 */
const MAX_TRUST_CONFIG_BYTES = 32 * 1024 * 1024

async function readJsonObject(path: string): Promise<Record<string, unknown> | null> {
  try {
    if ((await stat(path)).size > MAX_TRUST_CONFIG_BYTES) return null
    const parsed: unknown = JSON.parse(await readFile(path, 'utf8'))
    return isRecord(parsed) ? parsed : null
  } catch {
    // 無い・壊れている設定は書き換えない（想定内。エージェントが自分で確認を出す）
    return null
  }
}

/**
 * 最後に読んだ Claude の設定の、信頼済みのフォルダの一覧（大きさと更新時刻が同じあいだだけ使う）。
 * 起動の直後にいくつものプロジェクトの Agent を続けて開くと、そのたびに何十 MB の ~/.claude.json を JSON にしていた
 * （FERRET-M 0.7.6：起動から数秒で Agent を十数個）。書き換えたら更新時刻が変わるので、次は読み直す
 */
let claudeTrustProbe: { path: string; size: number; mtimeMs: number; trusted: ReadonlySet<string> } | null = null

function trustedKeysOf(config: Record<string, unknown>): Set<string> {
  const trusted = new Set<string>()
  if (!isRecord(config.projects)) return trusted
  for (const [key, entry] of Object.entries(config.projects)) {
    if (isRecord(entry) && entry.hasTrustDialogAccepted === true) trusted.add(key)
  }
  return trusted
}

async function fileStamp(path: string): Promise<{ size: number; mtimeMs: number } | null> {
  try {
    const st = await stat(path)
    return { size: st.size, mtimeMs: st.mtimeMs }
  } catch {
    return null
  }
}

/** シンボリックリンクの設定はリンク先を書き換える（リンクを保つ） */
function resolveFileTarget(path: string): string | 'missing' | 'unreadable' {
  try {
    const entry = lstatSync(path)
    const target = entry.isSymbolicLink() ? realpathSync(path) : path
    return statSync(target).isFile() ? target : 'unreadable'
  } catch (error) {
    const code = error instanceof Error && 'code' in error ? (error as NodeJS.ErrnoException).code : undefined
    return code === 'ENOENT' || code === 'ENOTDIR' ? 'missing' : 'unreadable'
  }
}

/** 同じ権限の一時ファイルに書いて、元のファイルへ名前を変える */
function replaceFileAtomically(target: string, content: string): void {
  const temp = `${target}.ade-trust-${randomUUID()}.tmp`
  const mode = statSync(target).mode & 0o777
  try {
    writeFileSync(temp, content, { encoding: 'utf8', flag: 'wx', mode })
    if (process.platform !== 'win32') chmodSync(temp, mode)
    renameSync(temp, target)
  } finally {
    rmSync(temp, { force: true })
  }
}

/**
 * Claude Code と同じロック（proper-lockfile が作る <file>.lock ディレクトリ）を取る。
 * 取れなければ null（壊さず、書かずにエージェントに聞かせる）
 */
async function acquireClaudeLock(configFile: string, retries = 4): Promise<(() => void) | null> {
  const lockDir = `${configFile}.lock`
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      mkdirSync(lockDir)
      return () => {
        try {
          rmdirSync(lockDir)
        } catch {
          /* すでに無い */
        }
      }
    } catch {
      // ほかのプロセスがロック中（想定内）。少し待って取り直す
      if (attempt < retries) await delay(Math.min(250, 50 * 2 ** attempt))
    }
  }
  return null
}

/** Claude Code の設定に、フォルダを信頼済みとして足す。ファイルは作らない */
export async function grantClaudeFolderTrust(configFile: string, folderKeys: readonly string[]): Promise<TrustOutcome> {
  const probeTarget = resolveFileTarget(configFile)
  if (probeTarget === 'missing') return 'missing-config'
  if (probeTarget === 'unreadable') return 'unreadable'
  const stamp = await fileStamp(probeTarget)
  const cached = stamp && claudeTrustProbe?.path === probeTarget && claudeTrustProbe.size === stamp.size && claudeTrustProbe.mtimeMs === stamp.mtimeMs
    ? claudeTrustProbe
    : null
  if (cached && folderKeys.some((key) => cached.trusted.has(key))) return 'unchanged'
  if (!cached) {
    const probe = await readJsonObject(probeTarget)
    if (!probe) return 'unreadable'
    if (stamp) claudeTrustProbe = { path: probeTarget, ...stamp, trusted: trustedKeysOf(probe) }
    // ほとんどの起動では書くことが無いので、そのときはロックも取らない
    const planned = applyClaudeFolderTrust(probe, folderKeys)
    if (planned.kind !== 'changed') return planned.kind === 'refuse' ? 'unreadable' : 'unchanged'
  }

  const release = await acquireClaudeLock(configFile)
  if (!release) return 'locked'
  try {
    // ロックを取ったあとに読み直す（そのあいだに Claude が書いたかもしれない）
    const target = resolveFileTarget(configFile)
    if (target === 'missing') return 'missing-config'
    if (target === 'unreadable' || target !== probeTarget) return 'unreadable'
    const current = await readJsonObject(target)
    if (!current) return 'unreadable'
    const change = applyClaudeFolderTrust(current, folderKeys)
    if (change.kind === 'refuse') return 'unreadable'
    if (change.kind === 'unchanged') return 'unchanged'
    replaceFileAtomically(target, `${JSON.stringify(change.config, null, 2)}\n`)
    return 'granted'
  } finally {
    release()
  }
}

// ───────────────────────── Codex ─────────────────────────

function escapeTomlBasicString(value: string): string {
  return value
    .replaceAll('\\', '\\\\')
    .replaceAll('"', '\\"')
    .replaceAll('\b', '\\b')
    .replaceAll('\f', '\\f')
    .replaceAll('\n', '\\n')
    .replaceAll('\r', '\\r')
    .replaceAll('\t', '\\t')
}

function unescapeTomlBasicString(value: string): string {
  return value.replace(/\\(["\\bfnrt])/g, (_, ch: string) =>
    ({ '"': '"', '\\': '\\', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' })[ch] ?? ch
  )
}

/** `[projects."<path>"]` / `[projects.'<path>']` / `["projects"."<path>"]` の <path>。表の見出しでなければ null */
export function parseProjectHeaderPath(line: string): string | null {
  const m = /^\s*\[\s*(?:projects|"projects"|'projects')\s*\.\s*(?:"((?:[^"\\]|\\.)*)"|'([^']*)')\s*\]\s*(?:#.*)?$/.exec(line)
  if (!m) return null
  return m[1] !== undefined ? unescapeTomlBasicString(m[1]) : (m[2] ?? null)
}

/**
 * config.toml の内容に、そのプロジェクトの trust_level = "trusted" を足した内容を返す。
 * 利用者の書いた行（コメント・並び・改行コード）は変えず、該当の表だけを足すか書き換える。
 * 複数行の文字列（""" / '''）の中は見出しと見なさない
 */
export function upsertCodexProjectTrust(content: string, projectPath: string): string {
  const existing = content.charCodeAt(0) === 0xfeff ? content.slice(1) : content
  const eol = existing.includes('\r\n') ? '\r\n' : '\n'
  const trustLine = 'trust_level = "trusted"'
  const lines = existing.split('\n')
  let inMultiline: '"""' | "'''" | null = null
  let header = -1
  let trustIndex = -1
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.replace(/\r$/, '')
    if (inMultiline) {
      if (line.split(inMultiline).length % 2 === 0) inMultiline = null
      continue
    }
    const structural = /^\s*\[/.test(line)
    if (header === -1) {
      if (structural && parseProjectHeaderPath(line) === projectPath) header = i
    } else if (structural) {
      // 次の表に入ったら、その表の中に trust_level は無かった
      break
    } else if (trustIndex === -1 && /^\s*(?:trust_level|"trust_level"|'trust_level')\s*=/.test(line)) {
      trustIndex = i
    }
    for (const quote of ['"""', "'''"] as const) {
      if (line.split(quote).length % 2 === 0) inMultiline = quote
    }
  }
  if (header === -1) {
    const block = `[projects."${escapeTomlBasicString(projectPath)}"]${eol}${trustLine}${eol}`
    if (existing.length === 0) return block
    const separator = existing.endsWith(`${eol}${eol}`) ? '' : existing.endsWith(eol) ? eol : eol + eol
    return `${existing}${separator}${block}`
  }
  const cr = eol === '\r\n' ? '\r' : ''
  if (trustIndex !== -1) {
    if (lines[trustIndex]!.replace(/\r$/, '').trim() === trustLine) return existing
    lines[trustIndex] = `${trustLine}${cr}`
    return lines.join('\n')
  }
  lines.splice(header + 1, 0, `${trustLine}${cr}`)
  return lines.join('\n')
}

/** Codex の config.toml に、プロジェクトを信頼済みとして足す。CODEX_HOME のフォルダが無ければ書かない */
export function grantCodexProjectTrust(configFile: string, projectPath: string): TrustOutcome {
  if (!existsSync(dirname(configFile))) return 'missing-config'
  const target = resolveFileTarget(configFile)
  if (target === 'unreadable') return 'unreadable'
  let content = ''
  if (target !== 'missing') {
    try {
      if (statSync(target).size > MAX_TRUST_CONFIG_BYTES) return 'unreadable'
      content = readFileSync(target, 'utf8')
    } catch {
      // 読めない設定は書き換えず、エージェントに確認を出させる（呼び出し側が unreadable として扱う）
      return 'unreadable'
    }
  }
  const updated = upsertCodexProjectTrust(content, projectPath)
  if (updated === content) return 'unchanged'
  if (target === 'missing') {
    writeFileSync(configFile, updated, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
  } else {
    replaceFileAtomically(target, updated)
  }
  return 'granted'
}

// ───────────────────────── 起動のときに呼ぶ ─────────────────────────

function canonical(path: string): string {
  try {
    return realpathSync.native(path)
  } catch {
    // まだ無いフォルダなど。書かれたままの形で比べる（想定内）
    return resolve(path)
  }
}

/** cwd が登録済みのプロジェクトのフォルダそのものか（サブフォルダやホームは含めない） */
export function isRegisteredProjectFolder(cwd: string, projectFolders: readonly string[]): boolean {
  const target = canonical(cwd)
  return projectFolders.some((folder) => canonical(folder) === target)
}

/** cwd がフォルダそのものである登録済みプロジェクトの id。無ければ null（サブフォルダやホームは含めない） */
export function registeredProjectIdFor(cwd: string, projects: ReadonlyArray<{ id: string; folderPath: string }>): string | null {
  const target = canonical(cwd)
  return projects.find((project) => canonical(project.folderPath) === target)?.id ?? null
}

/**
 * 起動する Claude Code / Codex に、登録済みのプロジェクトを信頼済みとして書いておく。
 * 例外は投げず、TRUST_WRITE_DEADLINE_MS より長くは待たない（間に合わなければエージェントが確認を出す）。
 *
 * @param env 起動するエージェントの環境変数（アカウント切り替えの CLAUDE_CONFIG_DIR / CODEX_HOME を含む）
 */
/**
 * この起動の間に信頼を書いた（または既に信頼済みだった）設定ファイルとフォルダ。同じ組み合わせは2回目から読まない。
 * ~/.claude.json は何十 MB にもなり、同期で読んで JSON にするので、オーケストラで何十もの Agent を開き直すたびに main が止まっていた
 */
const trustedThisSession = new Set<string>()

/** テスト用：覚えた組み合わせを忘れる */
export function resetTrustMemo(): void {
  trustedThisSession.clear()
  claudeTrustProbe = null
}

export async function applyAgentWorkspaceTrust(args: {
  agent: string
  cwd: string
  projectFolders: readonly string[]
  env: Record<string, string | undefined>
  homeDir?: string
}): Promise<TrustOutcome> {
  if (args.agent !== 'claude' && args.agent !== 'codex') return 'skipped'
  if (!isRegisteredProjectFolder(args.cwd, args.projectFolders)) return 'skipped'
  const home = args.homeDir ?? args.env.HOME ?? homedir()
  const configFile = args.agent === 'claude'
    ? resolveClaudeGlobalConfigFile({ env: args.env, homeDir: home, exists: existsSync })
    : join(args.env.CODEX_HOME || join(home, '.codex'), 'config.toml')
  const memo = `${args.agent}\0${configFile}\0${canonical(args.cwd)}`
  if (trustedThisSession.has(memo)) return 'unchanged'
  const write = async (): Promise<TrustOutcome> => {
    const outcome = args.agent === 'claude'
      ? await grantClaudeFolderTrust(configFile, claudeTrustKeys(args.cwd))
      // Codex はプロジェクトのパスを realpath で照らし合わせる（Orca の canonicalize と同じ）
      : grantCodexProjectTrust(configFile, canonical(args.cwd))
    if (outcome === 'granted' || outcome === 'unchanged') trustedThisSession.add(memo)
    return outcome
  }
  try {
    return await Promise.race([
      write(),
      new Promise<TrustOutcome>((done) => setTimeout(() => done('locked'), TRUST_WRITE_DEADLINE_MS))
    ])
  } catch (error) {
    console.warn('[terminal] フォルダの信頼を書き込めませんでした。エージェントが確認を出します', error)
    // ~/.claude.json の中身を含みうるので種類だけ
    reportHandled(errorKind(error), { area: 'agent-launch', op: 'grant folder trust' })
    return 'unreadable'
  }
}
