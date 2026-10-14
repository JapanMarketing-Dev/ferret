import { randomBytes, randomUUID } from 'node:crypto'
import { rmSync, watch, type FSWatcher } from 'node:fs'
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, rename, rm, rmdir, unlink, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  AGENT_MAIL_BIN_ENV,
  AGENT_MAIL_ENV,
  AGENT_MAIL_SKILL_NAME,
  MAIL_FILE_PATTERN,
  MAX_MAIL_BYTES,
  MAX_PASTED_BODY_CHARS,
  MailRateLimit,
  isAgentMailSkill,
  normalizeAgentTarget,
  parseAgentMail,
  renderAgentMailSkill,
  renderFailure,
  renderPosixCli,
  renderPowerShellCli,
  renderReply,
  renderRequest,
  renderSessionPosixCli,
  renderSessionWindowsCmd,
  replyFileName,
  type AgentMail,
  type AgentMailLaunchRequest
} from '@shared/agentMail'
import { AGENT_SKILL_AGENTS, agentConfigDir } from '@shared/agentSkill'
import { agentLabel } from '@shared/agentCatalog'
import { isInsideDir } from '@shared/sendTarget'
import { delay } from '@shared/delay'
import type { TerminalCreateOptions, TuiAgent } from '@shared/types'
import { reportHandled } from '@shared/report'
import { currentSettings } from './settings'
import type { TerminalManager } from './terminal'

/**
 * Agent どうしの依頼の配送（@shared/agentMail）。
 *
 * - 起動ごとに一時フォルダ（mkdtemp。利用者だけが読み書きできる）に受け口（outbox）と CLI を置く。
 *   プロジェクトの中に受け口を置かない（取ってきたリポジトリに置かれた依頼のファイルを読まない）
 * - タブを開くたびに合言葉を作って環境変数で渡し、閉じたら無効にする。合言葉の無い・知らない依頼は届けない
 * - 宛先は送り手と同じプロジェクトの、その Agent のターミナル（前に同じ相手へ送ったならそのタブ）。
 *   無ければ renderer に送り手の隣へ開いてもらい、入力欄の準備を待ってから貼り付ける
 * - 結果は頼まれた側のプロジェクトの .ferret/agent-mail/ に書いてもらう（git の対象外）
 */


interface Thread {
  number: number
  fromId: string
  toId: string | null
  toAgent: TuiAgent
}

/** 受け口の見張りが知らせを落としたときのための読み直し（ふだんは fs.watch の知らせですぐ読む） */
const POLL_MS = 2000
/** 知らせが続けて来たら、まとめて1回読む */
const WATCH_SETTLE_MS = 25
/** 新しく開いたタブが作られるまで（renderer が開く） */
const CREATE_TIMEOUT_MS = 30_000
/** 開いた Agent の入力欄の準備ができるまで */
const READY_TIMEOUT_MS = 120_000
/** CLI が読まなかった結果のファイルを消すまで */
const STATUS_MAX_AGE_MS = 60_000
const MAX_THREADS = 500

let terminals: TerminalManager | null = null
let emitLaunch: ((request: AgentMailLaunchRequest) => void) | null = null
let root: Promise<{ base: string; mailbox: string; core: string } | null> | null = null
/** mkdtemp で作った一時フォルダ（終了時に消す） */
let baseDir: string | null = null
let timer: NodeJS.Timeout | null = null
let watcher: FSWatcher | null = null
let settle: NodeJS.Timeout | null = null
let polling = false
let pollAgain = false
let counter = 0
const secrets = new Map<string, string>() // 合言葉 → ターミナル
const bySession = new Map<string, { secret: string; cli: string; dir: string }>() // ターミナル → 合言葉とそのタブの CLI
const threads = new Map<number, Thread>()
/** 送り手のターミナルと Agent ごとに、前に届けたターミナル（続けて頼むと同じ相手に届く） */
const lastPeer = new Map<string, string>()
const pendingLaunch = new Map<string, (id: string) => void>()
/** 宛先のターミナルごとに、貼り付けを1つずつ（重ねると送信中で断られる） */
const deliveryQueue = new Map<string, Promise<unknown>>()
let limits = new MailRateLimit()

export function agentMailEnabled(): boolean {
  return currentSettings().agents.agentMail !== false
}

/** maxPerHour は単体テストで小さくする */
export function initAgentMail(options: { terminals: TerminalManager; launch: (request: AgentMailLaunchRequest) => void; maxPerHour?: number }): void {
  terminals = options.terminals
  emitLaunch = options.launch
  if (options.maxPerHour !== undefined) limits = new MailRateLimit(options.maxPerHour)
}

/** 受け口と CLI を用意する（最初のタブを開くときに1回）。用意できなければ null（このタブでは使えない） */
function prepare(): Promise<{ base: string; mailbox: string; core: string } | null> {
  if (!root) {
    root = (async () => {
      const base = await mkdtemp(join(tmpdir(), 'ferret-agent-mail-'))
      baseDir = base
      const mailbox = join(base, 'outbox')
      const bin = join(base, 'bin')
      await mkdir(mailbox, { mode: 0o700 })
      await mkdir(bin, { mode: 0o700 })
      await mkdir(join(base, 'terminals'), { mode: 0o700 })
      let core: string
      if (process.platform === 'win32') {
        core = join(bin, 'ferret-agent.ps1')
        await writeFile(core, renderPowerShellCli(), 'utf8')
      } else {
        core = join(bin, 'ferret-agent-core')
        await writeFile(core, renderPosixCli(), { encoding: 'utf8', mode: 0o700 })
        await chmod(core, 0o700)
      }
      startPolling(mailbox)
      return { base, mailbox, core }
    })().catch((err: unknown) => {
      reportHandled(err, { area: 'agent-mail', op: 'prepare mailbox' })
      root = null
      return null
    })
  }
  return root
}

/** タブを開くときに足す環境変数（TerminalManager.launchEnv）。切なら空 */
export async function agentMailEnv(sessionId: string): Promise<Record<string, string>> {
  if (!agentMailEnabled()) return {}
  const ready = await prepare()
  if (!ready) return {}
  const secret = randomBytes(18).toString('base64url')
  // タブごとのフォルダに、受け口と合言葉を書き込んだ CLI を置く（環境変数を消す Agent の中でも PATH から呼べる）
  const dir = join(ready.base, 'terminals', randomBytes(9).toString('base64url'))
  await mkdir(dir, { mode: 0o700 })
  let cli: string
  if (process.platform === 'win32') {
    cli = join(dir, 'ferret-agent.cmd')
    await writeFile(cli, renderSessionWindowsCmd(ready.core, ready.mailbox, secret), 'utf8')
  } else {
    cli = join(dir, 'ferret-agent')
    await writeFile(cli, renderSessionPosixCli(ready.core, ready.mailbox, secret), { encoding: 'utf8', mode: 0o700 })
    await chmod(cli, 0o700)
  }
  secrets.set(secret, sessionId)
  bySession.set(sessionId, { secret, cli, dir })
  return { [AGENT_MAIL_ENV.cli]: cli, [AGENT_MAIL_ENV.mailbox]: ready.mailbox, [AGENT_MAIL_ENV.id]: secret, [AGENT_MAIL_BIN_ENV]: dir }
}

/** タブが閉じた（TerminalManager.onSessionClosed） */
export function revokeAgentMailSession(sessionId: string): void {
  const entry = bySession.get(sessionId)
  if (entry) {
    secrets.delete(entry.secret)
    void rm(entry.dir, { recursive: true, force: true }).catch(() => undefined)
  }
  bySession.delete(sessionId)
}

/** そのタブの CLI の絶対パス（依頼文・返事に書く） */
function cliOf(sessionId: string): string {
  return bySession.get(sessionId)?.cli ?? 'ferret-agent'
}

/** タブが作られた。依頼のために開いたタブなら、待っている配送へ渡す */
export function agentMailTerminalCreated(id: string, options: TerminalCreateOptions): void {
  const token = options.agentMailToken
  if (!token) return
  const resolve = pendingLaunch.get(token)
  pendingLaunch.delete(token)
  resolve?.(id)
}

/**
 * 受け口を見張る。ファイルが置かれたらすぐ読む（400ms ごとの読み直しは、使わない人の main も起こし続けていた）。
 * fs.watch は知らせを落とすことがある（ネットワークの一時フォルダ・OS の制限）ので、ゆっくりの読み直しも残す
 */
function startPolling(mailbox: string): void {
  if (timer) return
  timer = setInterval(() => void poll(mailbox), POLL_MS)
  timer.unref?.()
  try {
    watcher = watch(mailbox, { persistent: false }, () => {
      if (settle) return
      settle = setTimeout(() => { settle = null; void poll(mailbox) }, WATCH_SETTLE_MS)
      settle.unref?.()
    })
    watcher.on('error', () => { watcher?.close(); watcher = null })
  } catch {
    // 見張れない環境では読み直しだけで届ける（想定内）
    watcher = null
  }
}

/** 終了するとき。受け口と CLI の一時フォルダを消す（残ったタブの CLI は「Ferret の外」と出して止まる） */
export function stopAgentMail(): void {
  if (timer) clearInterval(timer)
  timer = null
  if (settle) clearTimeout(settle)
  settle = null
  watcher?.close()
  watcher = null
  const dir = baseDir
  baseDir = null
  if (dir) {
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* 一時フォルダは OS も片付ける */ }
  }
}

async function poll(mailbox: string): Promise<void> {
  // 読んでいる途中に届いた知らせは、読み終えてからもう1度読む（取りこぼすと次の読み直しまで待たせる）
  if (polling) { pollAgain = true; return }
  polling = true
  try {
    const names = await readdir(mailbox).catch(() => [] as string[])
    for (const name of names) {
      if (name.endsWith('.status')) {
        await removeStaleStatus(join(mailbox, name))
        continue
      }
      if (!MAIL_FILE_PATTERN.test(name)) continue
      const path = join(mailbox, name)
      const text = await readMailFile(path)
      await unlink(path).catch(() => undefined)
      const base = name.slice(0, -'.mail'.length)
      const status = (line: string) => writeStatus(join(mailbox, `${base}.status`), line)
      if (text === null) { await status('error: the message could not be read (too large or not a plain file)'); continue }
      if (!agentMailEnabled()) { await status('error: agent mail is turned off in Ferret (Settings > Agents)'); continue }
      const parsed = parseAgentMail(text)
      if (!parsed.ok) { await status(`error: ${parsed.error}`); continue }
      await handle(parsed.mail, status).catch(async (err: unknown) => {
        reportHandled(err, { area: 'agent-mail', op: 'handle mail' })
        await status(`error: ${err instanceof Error ? err.message : 'failed'}`)
      })
    }
  } finally {
    polling = false
    if (pollAgain) {
      pollAgain = false
      void poll(mailbox)
    }
  }
}

async function readMailFile(path: string): Promise<string | null> {
  try {
    const info = await lstat(path)
    if (!info.isFile() || info.size > MAX_MAIL_BYTES) return null
    return await readFile(path, 'utf8')
  } catch {
    return null // 読む前に消えた（想定内）
  }
}

/** CLI が待つ結果。書きかけを読ませないよう、一時の名前に書いてから置き換える */
async function writeStatus(path: string, text: string): Promise<void> {
  const tmp = `${path}.${randomBytes(4).toString('hex')}.tmp`
  try {
    await writeFile(tmp, `${text}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
    await rename(tmp, path)
  } catch (err) {
    await rm(tmp, { force: true })
    reportHandled(err, { area: 'agent-mail', op: 'write status' })
  }
}

async function removeStaleStatus(path: string): Promise<void> {
  try {
    const info = await lstat(path)
    if (Date.now() - info.mtimeMs > STATUS_MAX_AGE_MS) await rm(path, { force: true })
  } catch { /* 読む前に CLI が消した（想定内） */ }
}

interface TerminalView { id: string; cwd: string; title: string; label: string; agent: TuiAgent | null }

async function viewOf(id: string): Promise<TerminalView | null> {
  const info = terminals?.list().find((item) => item.id === id)
  if (!info || !terminals) return null
  const state = await terminals.agentState(id)
  const agent = state.agent ?? info.agent ?? null
  return { id, cwd: info.cwd, title: info.title || id, label: agent ? agentLabel(agent, currentSettings().agents) : 'Terminal', agent }
}

/** 送り手のフォルダを含む登録済みのプロジェクト（深いものを先に）。無ければそのフォルダ */
function projectDirOf(cwd: string): string {
  const folders = currentSettings().projects.map((project) => project.folderPath).filter((folder) => folder && isInsideDir(cwd, folder))
  return folders.sort((a, b) => b.length - a.length)[0] ?? cwd
}

async function handle(mail: AgentMail, status: (line: string) => Promise<void>): Promise<void> {
  const fromId = secrets.get(mail.from)
  if (!fromId || !terminals) return status('error: this terminal is not known to Ferret (it was opened before Ferret restarted, or agent mail was off). Open a new terminal in Ferret.')
  if (!limits.take(fromId)) return status('error: too many agent mails from this terminal in the last hour. Ask the user before continuing.')
  const from = await viewOf(fromId)
  if (!from) return status('error: this terminal is closed')
  if (mail.kind === 'reply') return handleReply(mail, from, status)
  return handleSend(mail, from, status)
}

async function handleSend(mail: AgentMail, from: TerminalView, status: (line: string) => Promise<void>): Promise<void> {
  const prefs = currentSettings().agents
  const agent = normalizeAgentTarget(mail.to, prefs.customAgents)
  if (!agent) return status(`error: unknown agent "${mail.to}". Use an agent name such as codex, claude or antigravity.`)
  if (prefs.disabledAgents.includes(agent)) return status(`error: ${agentLabel(agent, prefs)} is turned off in Ferret (Settings > Agents).`)
  const label = agentLabel(agent, prefs)
  const number = ++counter
  const thread: Thread = { number, fromId: from.id, toId: null, toAgent: agent }
  threads.set(number, thread)
  for (const key of [...threads.keys()].slice(0, Math.max(0, threads.size - MAX_THREADS))) threads.delete(key)
  const projectDir = projectDirOf(mail.cwd && isInsideDir(mail.cwd, projectDirOf(from.cwd)) ? mail.cwd : from.cwd)
  const existing = await findTarget(from.id, agent, projectDir)
  if (existing) {
    const target = await viewOf(existing)
    await status(`ok: request #${number} is being delivered to ${label} (Ferret terminal "${target?.title ?? existing}"). Its reply will be pasted into your terminal as a new message; do not wait or poll for it.`)
    void deliverRequest(thread, mail, from, existing, label)
    return
  }
  await status(`ok: request #${number}: opening ${label} in a new Ferret terminal next to yours; the request is pasted when it is ready. Its reply will be pasted into your terminal as a new message; do not wait or poll for it.`)
  void (async () => {
    const id = await launch(agent, from)
    if (!id) return notifySender(from.id, renderFailure(number, label, `${label} could not be opened. Check that it is installed (Ferret > Settings > Agents).`))
    if (!(await waitReady(id))) return notifySender(from.id, renderFailure(number, label, `${label} did not become ready (it may be asking for a permission or a sign-in in its terminal).`))
    await deliverRequest(thread, mail, from, id, label)
  })().catch((err: unknown) => reportHandled(err, { area: 'agent-mail', op: 'launch recipient' }))
}

async function findTarget(fromId: string, agent: TuiAgent, projectDir: string): Promise<string | null> {
  if (!terminals) return null
  const previous = lastPeer.get(`${fromId}|${agent}`)
  if (previous && previous !== fromId) {
    const state = await terminals.agentState(previous)
    if (state.agent === agent) return previous
  }
  return terminals.findAgentTerminal(agent, projectDir, fromId)
}

function launch(agent: TuiAgent, from: TerminalView): Promise<string | null> {
  if (!emitLaunch) return Promise.resolve(null)
  const token = randomUUID()
  const created = new Promise<string | null>((resolve) => {
    pendingLaunch.set(token, resolve)
    setTimeout(() => { pendingLaunch.delete(token); resolve(null) }, CREATE_TIMEOUT_MS).unref?.()
  })
  emitLaunch({ token, agent, cwd: from.cwd, fromTerminalId: from.id })
  return created
}

async function waitReady(id: string): Promise<boolean> {
  if (!terminals) return false
  const deadline = Date.now() + READY_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (!terminals.list().some((item) => item.id === id)) return false
    const state = await terminals.agentState(id)
    if (state.kind !== 'unknown' && state.state === 'idle') return true
    await delay(500)
  }
  return false
}

/** 結果のファイルを置くフォルダ（そのターミナルのフォルダの .ferret/agent-mail）。作れなければ一時フォルダの下 */
async function mailDir(cwd: string): Promise<string> {
  const dir = join(cwd, '.ferret', 'agent-mail')
  try {
    const [{ mkdirContained }, { ensureGitExclude }] = await Promise.all([import('./sessions/containment'), import('./sessions')])
    await mkdirContained(dir, { root: cwd })
    void ensureGitExclude(projectDirOf(cwd)).catch(() => undefined)
    return dir
  } catch {
    // 書けないフォルダ（ホームの外・読み取り専用など）。受け口の隣に置く
    const ready = await prepare()
    const fallback = join(ready ? ready.base : tmpdir(), 'results')
    await mkdir(fallback, { recursive: true, mode: 0o700 })
    return fallback
  }
}

/** 長い本文はファイルに書いて場所を返す（貼り付けは短く） */
async function spillBody(body: string, dir: string, name: string): Promise<{ body: string; file: string | null }> {
  if (body.length <= MAX_PASTED_BODY_CHARS) return { body, file: null }
  const file = join(dir, name)
  const { writeFileNoFollow } = await import('./sessions/containment')
  await writeFileNoFollow(file, `${body}\n`)
  return { body: `${body.slice(0, 600).trimEnd()}\n…`, file }
}

async function deliverRequest(thread: Thread, mail: AgentMail, from: TerminalView, targetId: string, label: string): Promise<void> {
  const target = await viewOf(targetId)
  if (!target) return notifySender(from.id, renderFailure(thread.number, label, 'its terminal was closed'))
  thread.toId = targetId
  lastPeer.set(`${from.id}|${thread.toAgent}`, targetId)
  const dir = await mailDir(target.cwd)
  const now = new Date()
  const replyPath = join(dir, replyFileName(now, thread.number, label))
  const spilled = await spillBody(mail.body, dir, replyFileName(now, thread.number, 'request'))
  const text = renderRequest({ number: thread.number, fromLabel: from.label, fromTitle: from.title, body: spilled.body, bodyFile: spilled.file, file: mail.file, replyPath, cliPath: cliOf(targetId), platform: process.platform })
  const sent = await paste(targetId, text)
  if (!sent.ok) notifySender(from.id, renderFailure(thread.number, label, sent.message))
}

async function handleReply(mail: AgentMail, from: TerminalView, status: (line: string) => Promise<void>): Promise<void> {
  const thread = mail.replyTo !== null ? threads.get(mail.replyTo) : undefined
  if (!thread) return status(`error: request #${mail.replyTo} is not known (Ferret was restarted, or the number is wrong).`)
  if (thread.toId !== from.id) return status(`error: request #${thread.number} was not sent to this terminal.`)
  const sender = await viewOf(thread.fromId)
  if (!sender) return status(`error: the terminal that sent request #${thread.number} is closed.`)
  const dir = await mailDir(from.cwd)
  const spilled = await spillBody(mail.body, dir, replyFileName(new Date(), thread.number, 'reply-message'))
  const target = from.agent ?? thread.toAgent
  const text = renderReply({ number: thread.number, fromLabel: from.label, fromTitle: from.title, body: spilled.body, bodyFile: spilled.file, file: mail.file, agentTarget: target, cliPath: cliOf(thread.fromId), platform: process.platform })
  lastPeer.set(`${thread.fromId}|${thread.toAgent}`, from.id)
  await status(`ok: your reply to #${thread.number} is being pasted into ${sender.label} (Ferret terminal "${sender.title}").`)
  // 貼り付けは待たない（入力欄の準備待ちの間に、ほかの依頼を止めない）
  void paste(thread.fromId, text).then((sent) => {
    if (!sent.ok) notifySender(from.id, renderFailure(thread.number, sender.label, sent.message))
  })
}

/** 届けられなかったことを送り手のターミナルに貼る（Agent が読んで次を決める） */
function notifySender(id: string, text: string): void {
  void paste(id, text).catch(() => undefined)
}

function paste(id: string, text: string): Promise<{ ok: boolean; message: string }> {
  const run = async () => {
    if (!terminals) return { ok: false, message: 'Ferret is closing' }
    const result = await terminals.sendReview(id, text)
    return { ok: result.ok, message: result.message }
  }
  const previous = deliveryQueue.get(id) ?? Promise.resolve()
  const next = previous.then(run, run)
  deliveryQueue.set(id, next.catch(() => undefined))
  return next
}

// ───────────────────────── skill ─────────────────────────

function skillPath(agent: (typeof AGENT_SKILL_AGENTS)[number]): string {
  return join(agentConfigDir(agent, process.env, homedir(), join), 'skills', AGENT_MAIL_SKILL_NAME, 'SKILL.md')
}

/**
 * skill を、入なら使っている Agent（設定のフォルダがあるもの）に入れて今の版に合わせ、切なら Ferret が入れたものを外す。
 * 同じ名前で Ferret のものでない skill は触らない
 */
export async function syncAgentMailSkill(version: string): Promise<void> {
  const { writeSkill } = await import('./agentSkill')
  const text = renderAgentMailSkill(version)
  for (const agent of AGENT_SKILL_AGENTS) {
    const path = skillPath(agent)
    const current = await readFile(path, 'utf8').catch(() => null)
    if (current !== null && !isAgentMailSkill(current)) continue
    if (!agentMailEnabled()) {
      // Ferret が書いたファイルだけを消し、空になったフォルダを消す（リンクの先は消さない）
      if (current !== null && !(await lstat(path)).isSymbolicLink()) {
        await unlink(path)
        await rmdir(join(path, '..')).catch(() => undefined)
      }
      continue
    }
    if (current === text) continue
    const configured = await lstat(agentConfigDir(agent, process.env, homedir(), join)).then(() => true, () => false)
    if (!configured) continue
    await writeSkill(path, text)
  }
}
