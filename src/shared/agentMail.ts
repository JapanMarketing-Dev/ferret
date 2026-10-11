import { AGENT_CATALOG, BUILTIN_AGENTS, isBuiltinAgent } from './agentCatalog'
import type { CustomAgent, TuiAgent } from './types'
import { quotePowerShellLiteral } from './shellQuote'
import { isAbsolutePath } from './browserExtensions'

/**
 * Agent どうしの依頼（agent mail）。Ferret のターミナルで動く Agent が、別の Agent に仕事を頼み、結果をファイルで受け取る。
 * 頼まれた Agent は、利用者に見えている Ferret のターミナルで動く（見えない裏の子プロセスにしない）。
 *
 * しくみ:
 *   1. Ferret は各ターミナルに環境変数を渡す（FERRET_AGENT_CLI・FERRET_AGENT_MAIL・FERRET_AGENT_ID）
 *   2. Agent は `"$FERRET_AGENT_CLI" send codex "…"` を実行する。CLI は FERRET_AGENT_MAIL のフォルダに1通のファイルを書き、
 *      Ferret が書く結果（.status）を数秒待って表示する
 *   3. Ferret は宛先の Agent のターミナル（無ければ送り手の隣に開く）へ本文を貼り付けて送信する
 *   4. 頼まれた Agent は結果をファイルに書き `"$FERRET_AGENT_CLI" reply <番号> --file <path> "要約"` を実行する。
 *      Ferret は送り手のターミナルへ要約とファイルの場所を貼り付けて送信する（送り手はそれを読んで続け、また頼める）
 *
 * FERRET_AGENT_ID はタブごとの合言葉。Ferret が開いたタブの中のプロセスだけが知っていて、どのタブからの依頼かをこれで決める。
 * Codex は名前に KEY・SECRET・TOKEN を含む環境変数をコマンドに渡さないので、その語を名前に使わない。
 * ここには Electron に依存しない純粋な処理だけを置く（読み書きと配送は src/main/agentMail.ts）。
 */

export const AGENT_MAIL_ENV = {
  cli: 'FERRET_AGENT_CLI',
  mailbox: 'FERRET_AGENT_MAIL',
  id: 'FERRET_AGENT_ID'
} as const

/**
 * PATH の先頭に足すフォルダを main の ptyEnv へ伝える名前（PTY には渡さない）。
 * Codex は shell_environment_policy.inherit = "core" だと独自の環境変数をコマンドに渡さない（2026-10 に本物で確認）。
 * そのため受け口と合言葉はタブごとの CLI（ferret-agent）の中に書き込み、その CLI のフォルダを PATH の先頭に置く。
 * 依頼文には相手のタブの CLI の絶対パスを書く（PATH を書き換えるシェルでも動く）
 */
export const AGENT_MAIL_BIN_ENV = 'FERRET_AGENT_BIN'

/** main → renderer: 宛先の Agent が居ないので、送り手の隣にこの Agent を開いて（開いたら main が依頼を貼る） */
export interface AgentMailLaunchRequest {
  /** terminal:create の agentMailToken に渡す */
  token: string
  agent: TuiAgent
  cwd: string
  /** 送り手のターミナル。その隣に開く */
  fromTerminalId: string
}

/** 1通のファイルの先頭行 */
export const AGENT_MAIL_MAGIC = 'FERRET-AGENT-MAIL 1'
/** 1通のファイルの上限（本文と見出し） */
export const MAX_MAIL_BYTES = 256 * 1024
/** 貼り付ける本文の上限。超えたら本文はファイルに書き、場所だけを貼る（TUI の入力欄に大きな貼り付けを入れない） */
export const MAX_PASTED_BODY_CHARS = 4000
/** 送り手のタブごとに、1時間に送れる数（Agent どうしが止まらずに往復し続けるのを止める） */
export const MAX_MAILS_PER_HOUR = 60

/** 1通のファイルの名前（CLI が付ける）。ほかの名前のファイルは読まない */
export const MAIL_FILE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}\.mail$/

export interface AgentMail {
  kind: 'send' | 'reply'
  /** 送り手のタブの合言葉（FERRET_AGENT_ID） */
  from: string
  /** send の宛先（codex・claude など。normalizeAgentTarget で読む） */
  to: string
  /** reply の宛先の依頼の番号 */
  replyTo: number | null
  /** 添えたファイルの絶対パス（無ければ null） */
  file: string | null
  /** CLI を実行したフォルダ */
  cwd: string | null
  body: string
}

export type ParseResult = { ok: true; mail: AgentMail } | { ok: false; error: string }

const HEADER_KEYS = new Set(['kind', 'from', 'to', 'reply-to', 'file', 'cwd'])

/** CLI が書いた1通を読む。見出し（key: value の行）・空行・本文 */
export function parseAgentMail(text: string): ParseResult {
  const normalized = text.replace(/\r\n/g, '\n')
  const lines = normalized.split('\n')
  if (lines[0]?.trim() !== AGENT_MAIL_MAGIC) return { ok: false, error: 'not an agent mail file' }
  const headers = new Map<string, string>()
  let i = 1
  for (; i < lines.length; i++) {
    const line = lines[i]!
    if (line.trim() === '') { i++; break }
    const match = /^([a-z-]+):[ \t]?(.*)$/.exec(line)
    if (!match || !HEADER_KEYS.has(match[1]!) || headers.has(match[1]!)) return { ok: false, error: `bad header line ${i + 1}` }
    headers.set(match[1]!, match[2]!.trim())
  }
  const kind = headers.get('kind')
  if (kind !== 'send' && kind !== 'reply') return { ok: false, error: 'kind must be send or reply' }
  const from = headers.get('from') ?? ''
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(from)) return { ok: false, error: 'run this inside a Ferret terminal (FERRET_AGENT_ID is missing)' }
  const to = (headers.get('to') ?? '').trim()
  const replyRaw = (headers.get('reply-to') ?? '').trim().replace(/^#/, '')
  const replyTo = /^\d{1,9}$/.test(replyRaw) ? Number(replyRaw) : null
  if (kind === 'send' && !to) return { ok: false, error: 'missing recipient (for example: send codex "...")' }
  if (kind === 'reply' && replyTo === null) return { ok: false, error: 'missing request number (for example: reply 3 "...")' }
  const file = (headers.get('file') ?? '').trim() || null
  if (file !== null && !isAbsolutePath(file)) return { ok: false, error: 'the --file path must be absolute' }
  const cwd = (headers.get('cwd') ?? '').trim() || null
  const body = lines.slice(i).join('\n').replace(/\s+$/, '')
  if (!body && !file) return { ok: false, error: 'nothing to send: give a message or --file <path>' }
  return { ok: true, mail: { kind, from, to, replyTo, file, cwd, body } }
}


/** よく使う呼び方 → Agent の id */
const TARGET_ALIASES: Record<string, string> = {
  'claude-code': 'claude',
  claudecode: 'claude',
  cc: 'claude',
  'gemini-cli': 'gemini',
  'copilot-cli': 'copilot',
  'cursor-agent': 'cursor',
  'github-copilot': 'copilot'
}

/**
 * 宛先の名前 → Agent。組み込みの id・表示名（Claude Code など）・よく使う別名・カスタムの id か名前。大文字小文字と空白は区別しない。
 * 分からなければ null
 */
export function normalizeAgentTarget(name: string, customAgents: readonly CustomAgent[] = []): TuiAgent | null {
  const key = name.trim().toLowerCase().replace(/\s+/g, '-')
  if (!key) return null
  const aliased = TARGET_ALIASES[key] ?? key
  if (isBuiltinAgent(aliased)) return aliased
  for (const agent of BUILTIN_AGENTS) {
    if (AGENT_CATALOG[agent].label.toLowerCase().replace(/\s+/g, '-') === key) return agent
  }
  for (const custom of customAgents) {
    if (custom.id.toLowerCase() === key || custom.id.toLowerCase() === `custom:${key}` || custom.name.trim().toLowerCase().replace(/\s+/g, '-') === key) return custom.id
  }
  return null
}

/** 結果のファイルの名前（プロジェクトの .ferret/agent-mail/ の下）。起動ごとの番号の重なりで古い結果を上書きしないよう日時を付ける */
export function replyFileName(at: Date, number: number, agent: string): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  const stamp = `${at.getFullYear()}${pad(at.getMonth() + 1)}${pad(at.getDate())}-${pad(at.getHours())}${pad(at.getMinutes())}`
  const slug = agent.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'agent'
  return `${stamp}-${number}-${slug}.md`
}

/** process.platform の値（renderer からも読めるよう NodeJS の型を使わない） */
type MailPlatform = string

/**
 * シェルに貼る1語（POSIX は単引用符、Windows は PowerShell の単引用符）。
 * Windows で二重引用符にすると、PowerShell が中の `$` と「`」を展開する（`C:\$work\` のようなフォルダが別の値になる）
 */
export function quoteArg(value: string, platform: MailPlatform): string {
  if (platform === 'win32') return quotePowerShellLiteral(value)
  return /^[A-Za-z0-9_./:@%+=,-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`
}

/** Agent に見せる、そのタブの CLI を呼ぶ書き方（POSIX のシェルはそのまま、Windows は PowerShell の &） */
export function cliInvocation(cliPath: string, platform: MailPlatform): string {
  return platform === 'win32' ? `& ${quoteArg(cliPath, platform)}` : quoteArg(cliPath, platform)
}

export interface RequestText {
  number: number
  fromLabel: string
  fromTitle: string
  body: string
  /** 本文が長くてファイルに書いたとき、その場所 */
  bodyFile: string | null
  /** 送り手が添えたファイル */
  file: string | null
  /** 結果を書くファイル */
  replyPath: string
  /** 頼まれた側のタブの CLI の絶対パス */
  cliPath: string
  platform: MailPlatform
}

/** 頼まれた Agent のターミナルに貼る文。Agent が読む文なので英語 */
export function renderRequest(r: RequestText): string {
  const cli = cliInvocation(r.cliPath, r.platform)
  const lines = [
    `[Ferret agent mail #${r.number}] Request from ${r.fromLabel} (Ferret terminal "${r.fromTitle}"). The user is watching this terminal.`,
    ''
  ]
  if (r.body) lines.push(r.body, '')
  if (r.bodyFile) lines.push(`The full request is in ${r.bodyFile} . Read it first.`, '')
  if (r.file) lines.push(`Attached file: ${r.file}`, '')
  lines.push(
    `When you are done, write your full result (findings, what you changed, how you checked it) to ${r.replyPath} , then send it back with:`,
    `  ${cli} reply ${r.number} --file ${quoteArg(r.replyPath, r.platform)} "<one-line summary>"`,
    'Reply even if you could not finish (say why). Do not ask the user; Ferret pastes your reply into the sender\'s terminal.'
  )
  if (r.platform === 'win32') lines.push('(From bash, run the same command without the leading &. From cmd, also use double quotes instead of single quotes.)')
  return lines.join('\n')
}

export interface ReplyText {
  number: number
  fromLabel: string
  fromTitle: string
  body: string
  bodyFile: string | null
  file: string | null
  /** 頼んだ Agent に、続けて同じ相手へ頼む書き方を見せるための宛先 */
  agentTarget: string
  /** 頼んだ側のタブの CLI の絶対パス */
  cliPath: string
  platform: MailPlatform
}

/** 頼んだ Agent のターミナルに貼る返事 */
export function renderReply(r: ReplyText): string {
  const cli = cliInvocation(r.cliPath, r.platform)
  const lines = [`[Ferret agent mail #${r.number} reply] ${r.fromLabel} (Ferret terminal "${r.fromTitle}") answered your request #${r.number}.`, '']
  if (r.body) lines.push(r.body, '')
  if (r.bodyFile) lines.push(`The full reply is in ${r.bodyFile} .`, '')
  if (r.file) lines.push(`Result file: ${r.file} . Read it and continue your task.`, '')
  lines.push(`To ask ${r.fromLabel} again (it keeps its conversation), run: ${cli} send ${r.agentTarget} "..."`)
  return lines.join('\n')
}

/** 届けられなかったことを送り手に知らせる文 */
export function renderFailure(number: number | null, target: string, reason: string): string {
  return `[Ferret agent mail${number !== null ? ` #${number}` : ''}] Could not deliver to ${target}: ${reason}`
}

/**
 * 送り手のタブごとの数の上限（直近1時間）。Agent どうしが止まらずに往復し続けると、利用者の枠を使い切るため。
 * 利用者が自分で入力すれば数え直す（reset）
 */
export class MailRateLimit {
  private sent = new Map<string, number[]>()
  constructor(private readonly limit = MAX_MAILS_PER_HOUR, private readonly windowMs = 60 * 60 * 1000) {}

  /** 送ってよければ数えて true */
  take(key: string, now = Date.now()): boolean {
    const recent = (this.sent.get(key) ?? []).filter((at) => now - at < this.windowMs)
    if (recent.length >= this.limit) {
      this.sent.set(key, recent)
      return false
    }
    recent.push(now)
    this.sent.set(key, recent)
    return true
  }

  reset(key: string): void {
    this.sent.delete(key)
  }
}

/**
 * macOS・Linux の CLI（POSIX の sh）。1通のファイルを書いて、Ferret の結果（.status）を待って表示する。
 * jq・node などには頼らない（Agent の中のどのシェルからでも、Codex の砂場の中からでも動く）
 */
export function renderPosixCli(): string {
  return `#!/bin/sh
# Ferret agent mail: ask another coding agent that runs in a visible Ferret terminal, and reply to requests.
# Generated by Ferret on every start. Do not edit.
set -u
usage() {
  cat >&2 <<'EOF'
usage:
  ferret-agent send <agent> [--file <path>] [message...]    ask another agent (codex, claude, gemini, ...)
  ferret-agent reply <number> [--file <path>] [message...]  send your result back for request #<number>
The message can also come from stdin. Ferret pastes it into the other agent's terminal and submits it.
EOF
  exit 2
}
mailbox="\${${AGENT_MAIL_ENV.mailbox}:-}"
self="\${${AGENT_MAIL_ENV.id}:-}"
if [ -z "$mailbox" ] || [ -z "$self" ] || [ ! -d "$mailbox" ]; then
  echo "ferret-agent: run this inside a terminal opened by Ferret (agent mail is off or Ferret was restarted)" >&2
  exit 3
fi
[ $# -ge 2 ] || usage
cmd=$1; target=$2; shift 2
case "$cmd" in
  send) kind=send; to=$target; reply_to= ;;
  reply) kind=reply; to=; reply_to=$target ;;
  *) usage ;;
esac
file=
if [ "\${1:-}" = "--file" ]; then
  [ $# -ge 2 ] || usage
  file=$2; shift 2
fi
if [ -n "$file" ]; then
  case "$file" in /*) ;; *) file="$PWD/$file" ;; esac
  if [ ! -f "$file" ]; then echo "ferret-agent: no such file: $file" >&2; exit 2; fi
fi
case "$to$reply_to$file$PWD" in *'
'*) echo "ferret-agent: names and paths must not contain line breaks" >&2; exit 2 ;; esac
if [ $# -gt 0 ]; then body=$*; elif [ ! -t 0 ]; then body=$(cat); else body=; fi
if [ -z "$body" ] && [ -z "$file" ]; then echo "ferret-agent: nothing to send (give a message or --file)" >&2; exit 2; fi
name="$(date +%s)-$$-\${RANDOM:-0}"
tmp="$mailbox/.$name.tmp"
umask 077
{
  printf '%s\\n' '${AGENT_MAIL_MAGIC}'
  printf 'kind: %s\\nfrom: %s\\nto: %s\\nreply-to: %s\\nfile: %s\\ncwd: %s\\n\\n' "$kind" "$self" "$to" "$reply_to" "$file" "$PWD"
  printf '%s\\n' "$body"
} > "$tmp" || { echo "ferret-agent: could not write to $mailbox" >&2; exit 4; }
mv "$tmp" "$mailbox/$name.mail" || exit 4
status="$mailbox/$name.status"
i=0
while [ $i -lt 100 ]; do
  if [ -f "$status" ]; then
    cat "$status"
    code=0
    head -n 1 "$status" | grep -q '^error' && code=1
    rm -f "$status"
    exit $code
  fi
  sleep 0.1 2>/dev/null || sleep 1
  i=$((i + 1))
done
echo "ferret-agent: Ferret has not picked up the message yet; it will be delivered when Ferret reads it."
`
}

/** Windows の CLI の本体（PowerShell）。.cmd から呼ぶ */
export function renderPowerShellCli(): string {
  return `# Ferret agent mail: ask another coding agent that runs in a visible Ferret terminal, and reply to requests.
# Generated by Ferret on every start. Do not edit.
$ErrorActionPreference = 'Stop'
function Show-Usage {
  [Console]::Error.WriteLine('usage: ferret-agent send <agent> [--file <path>] [message...] | ferret-agent reply <number> [--file <path>] [message...]')
  exit 2
}
$mailbox = $env:${AGENT_MAIL_ENV.mailbox}
$self = $env:${AGENT_MAIL_ENV.id}
if (-not $mailbox -or -not $self -or -not (Test-Path -LiteralPath $mailbox -PathType Container)) {
  [Console]::Error.WriteLine('ferret-agent: run this inside a terminal opened by Ferret (agent mail is off or Ferret was restarted)')
  exit 3
}
if ($args.Count -lt 2) { Show-Usage }
$cmd = [string]$args[0]; $target = [string]$args[1]
$rest = @(); if ($args.Count -gt 2) { $rest = $args[2..($args.Count - 1)] }
if ($cmd -eq 'send') { $kind = 'send'; $to = $target; $replyTo = '' }
elseif ($cmd -eq 'reply') { $kind = 'reply'; $to = ''; $replyTo = $target }
else { Show-Usage }
$file = ''
if ($rest.Count -ge 1 -and [string]$rest[0] -eq '--file') {
  if ($rest.Count -lt 2) { Show-Usage }
  $file = [string]$rest[1]
  if ($rest.Count -gt 2) { $rest = $rest[2..($rest.Count - 1)] } else { $rest = @() }
}
$cwd = (Get-Location).ProviderPath
if ($file) {
  if (-not [System.IO.Path]::IsPathRooted($file)) { $file = Join-Path $cwd $file }
  if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { [Console]::Error.WriteLine("ferret-agent: no such file: $file"); exit 2 }
}
if (($to + $replyTo + $file + $cwd) -match '[\\r\\n]') { [Console]::Error.WriteLine('ferret-agent: names and paths must not contain line breaks'); exit 2 }
$body = ($rest | ForEach-Object { [string]$_ }) -join ' '
if (-not $body -and [Console]::IsInputRedirected) { $body = [Console]::In.ReadToEnd() }
if (-not $body -and -not $file) { [Console]::Error.WriteLine('ferret-agent: nothing to send (give a message or --file)'); exit 2 }
$name = '{0}-{1}-{2}' -f [DateTimeOffset]::UtcNow.ToUnixTimeSeconds(), $PID, (Get-Random -Maximum 1000000)
$text = "${AGENT_MAIL_MAGIC}\`nkind: $kind\`nfrom: $self\`nto: $to\`nreply-to: $replyTo\`nfile: $file\`ncwd: $cwd\`n\`n$body\`n"
$tmp = Join-Path $mailbox ".$name.tmp"
[System.IO.File]::WriteAllText($tmp, $text, (New-Object System.Text.UTF8Encoding $false))
Move-Item -LiteralPath $tmp -Destination (Join-Path $mailbox "$name.mail")
$status = Join-Path $mailbox "$name.status"
for ($i = 0; $i -lt 100; $i++) {
  if (Test-Path -LiteralPath $status) {
    $out = [System.IO.File]::ReadAllText($status)
    Remove-Item -LiteralPath $status -Force
    Write-Output $out.TrimEnd()
    if ($out.StartsWith('error')) { exit 1 } else { exit 0 }
  }
  Start-Sleep -Milliseconds 100
}
Write-Output 'ferret-agent: Ferret has not picked up the message yet; it will be delivered when Ferret reads it.'
`
}

/**
 * タブごとの CLI（POSIX）。受け口と合言葉を書き込み、本体（renderPosixCli）を呼ぶ。
 * 環境変数を消す Agent（Codex の inherit = "core"）の中でも、PATH かこの絶対パスで呼べば動く
 */
export function renderSessionPosixCli(corePath: string, mailbox: string, id: string): string {
  const q = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`
  return `#!/bin/sh\n# Ferret agent mail for one Ferret terminal. Generated by Ferret; removed when the terminal closes.\n${AGENT_MAIL_ENV.mailbox}=${q(mailbox)} ${AGENT_MAIL_ENV.id}=${q(id)} exec ${q(corePath)} "$@"\n`
}

/** タブごとの CLI（Windows の .cmd）。setlocal の中で受け口と合言葉を決めて、本体の ps1 を呼ぶ */
export function renderSessionWindowsCmd(corePs1: string, mailbox: string, id: string): string {
  const v = (value: string) => value.replace(/[%"\r\n]/g, '')
  return `@echo off\r\nsetlocal\r\nset "${AGENT_MAIL_ENV.mailbox}=${v(mailbox)}"\r\nset "${AGENT_MAIL_ENV.id}=${v(id)}"\r\npowershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${v(corePs1)}" %*\r\n`
}

// ───────────────────────── skill ─────────────────────────

export const AGENT_MAIL_SKILL_NAME = 'ferret-agent-mail'
export const AGENT_MAIL_SKILL_MARKER = '<!-- ferret-agent-mail-skill: generated by Ferret. Ferret rewrites this file on start; local edits are overwritten. -->'

/** Claude Code・Codex に入れる skill。Agent が読む文なので英語 */
export function renderAgentMailSkill(version: string): string {
  const cli = 'ferret-agent'
  return `---
name: ${AGENT_MAIL_SKILL_NAME}
description: Ask another coding agent (Codex, Claude Code, Gemini CLI, or any agent Ferret can start) that runs in a visible Ferret terminal to do a task — security check, code review, testing, verification, investigation, implementation — and get its result back as a file, then keep going back and forth. Use when the user asks you to have another agent do something ("have Codex check this", "ask Claude Code to…", "get a second opinion from Codex", "Codexにセキュリティチェックしてもらって", "Codexに頼んで"), and when a message starting with "[Ferret agent mail" arrives. Works only inside Ferret terminals (the ferret-agent command is on PATH there).
---

${AGENT_MAIL_SKILL_MARKER}
<!-- Ferret ${version} -->

# Ferret agent mail

Ferret runs each coding agent in its own terminal that the user can see. With this skill you hand work to another agent in one of those terminals instead of running it invisibly. Ferret pastes your request into that agent's terminal (opening one next to yours if none is running), and pastes the agent's reply back into yours as a new message.

Ferret puts the \`ferret-agent\` command on PATH in its terminals. If \`command -v ferret-agent\` finds nothing, use the path in \`$${AGENT_MAIL_ENV.cli}\` instead; if both are missing you are not inside a Ferret terminal, so tell the user to run you from one.

## Ask another agent

\`\`\`sh
${cli} send codex "Run a security review of the changes in src/auth (git diff main). List concrete issues with file:line and a fix for each."
\`\`\`

- The recipient is an agent name: \`codex\`, \`claude\`, \`gemini\`, \`cursor\`, \`copilot\`, … (the same agent as you also works: it goes to another terminal).
- For a long request, write it to a file and pass \`--file <path>\` (any message after it is sent too). The message can also come from stdin.
- The command prints whether Ferret delivered it and the request number (#N).
- Then do not wait, poll or sleep for the answer. Continue with work that does not depend on it, or end your turn. The reply arrives in your terminal as a new message that starts with \`[Ferret agent mail #N reply]\`, with the path of a result file. Read that file and continue.
- Sending to the same agent again reaches the same terminal, and that agent keeps its conversation, so you can say "re-check after my fixes" without repeating everything. This is how you run a loop: you implement, the other agent checks, you fix, you send again — until it reports no issues.
- Write self-contained requests: the other agent does not see your conversation. Name the files, the goal, what "done" means and what to put in the result.
- Do not start other agents yourself in the background (for example \`codex exec\`, \`claude -p\`, or hidden subagents) when the user wants another agent's work: use this so the user can watch it.

## When you receive a request

A request starts with \`[Ferret agent mail #N] Request from …\`. Do the task, write the full result to the file the request names (Ferret prepares the folder \`.ferret/agent-mail/\` in the project, which git ignores), then reply:

\`\`\`sh
${cli} reply N --file <that file> "One-line summary: 3 issues found, 2 fixed"
\`\`\`

Reply even when you could not finish, and say why. Do not ask the user questions about the request; the sender is waiting for your reply.

## Windows PowerShell

\`ferret-agent send codex "..."\` works the same (it is ferret-agent.cmd on PATH). If it is not found, use \`& $env:${AGENT_MAIL_ENV.cli} send codex "..."\`.
`
}

export function isAgentMailSkill(text: string): boolean {
  return text.includes(AGENT_MAIL_SKILL_MARKER)
}
