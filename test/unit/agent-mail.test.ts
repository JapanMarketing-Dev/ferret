/**
 * Agent どうしの依頼（@shared/agentMail）: 1通の形式・宛先の読み方・貼る文・数の上限・CLI（POSIX の sh）
 */
import { execFile, spawn } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import {
  AGENT_MAIL_MAGIC,
  AGENT_MAIL_SKILL_MARKER,
  MAIL_FILE_PATTERN,
  MailRateLimit,
  isAgentMailSkill,
  normalizeAgentTarget,
  parseAgentMail,
  quoteArg,
  renderAgentMailSkill,
  renderFailure,
  renderPosixCli,
  renderPowerShellCli,
  renderReply,
  renderRequest,
  renderSessionPosixCli,
  renderSessionWindowsCmd,
  replyFileName
} from '../../src/shared/agentMail'

const FROM = 'abcdefghijklmnopqrstuvwx'
const mail = (headers: string, body = 'hello') => `${AGENT_MAIL_MAGIC}\n${headers}\n\n${body}\n`

describe('1通の形式を読む', () => {
  it('send を読む。本文の空行・見出しに見える行もそのまま', () => {
    const r = parseAgentMail(mail(`kind: send\nfrom: ${FROM}\nto: codex\nreply-to: \nfile: \ncwd: /work/app`, 'line 1\n\nkind: reply\nto: x'))
    expect(r).toEqual({ ok: true, mail: { kind: 'send', from: FROM, to: 'codex', replyTo: null, file: null, cwd: '/work/app', body: 'line 1\n\nkind: reply\nto: x' } })
  })

  it('reply を読む。#3 と 3 は同じ。CRLF でも読む', () => {
    const r = parseAgentMail(mail(`kind: reply\nfrom: ${FROM}\nto: \nreply-to: #3\nfile: /r/3.md\ncwd: /w`, '').replace(/\n/g, '\r\n'))
    expect(r.ok && r.mail).toMatchObject({ kind: 'reply', replyTo: 3, file: '/r/3.md', body: '' })
  })

  it('Windows の絶対パスを受ける', () => {
    expect(parseAgentMail(mail(`kind: send\nfrom: ${FROM}\nto: codex\nfile: C:\\work\\req.md`)).ok).toBe(true)
    expect(parseAgentMail(mail(`kind: send\nfrom: ${FROM}\nto: codex\nfile: \\\\server\\share\\req.md`)).ok).toBe(true)
  })

  it.each([
    ['先頭行が違う', 'FERRET-AGENT-MAIL 2\nkind: send\n\nx'],
    ['空', ''],
    ['知らない見出し', mail(`kind: send\nfrom: ${FROM}\nto: codex\nevil: 1`)],
    ['同じ見出しが2回', mail(`kind: send\nfrom: ${FROM}\nto: codex\nto: claude`)],
    ['見出しの形でない行', mail(`kind: send\nfrom: ${FROM}\nthis is not a header`)],
    ['kind が無い', mail(`from: ${FROM}\nto: codex`)],
    ['kind が違う', mail(`kind: forward\nfrom: ${FROM}\nto: codex`)],
    ['合言葉が無い（Ferret の外）', mail('kind: send\nfrom: \nto: codex')],
    ['合言葉が短い', mail('kind: send\nfrom: abc\nto: codex')],
    ['合言葉に使えない文字', mail(`kind: send\nfrom: ${FROM}/../x\nto: codex`)],
    ['宛先が無い', mail(`kind: send\nfrom: ${FROM}\nto: `)],
    ['依頼の番号が無い', mail(`kind: reply\nfrom: ${FROM}\nreply-to: `)],
    ['依頼の番号が数でない', mail(`kind: reply\nfrom: ${FROM}\nreply-to: three`)],
    ['依頼の番号が長すぎる', mail(`kind: reply\nfrom: ${FROM}\nreply-to: 1234567890`)],
    ['相対のパス', mail(`kind: send\nfrom: ${FROM}\nto: codex\nfile: notes/req.md`)],
    ['本文もファイルも無い', mail(`kind: send\nfrom: ${FROM}\nto: codex`, '   \n  ')]
  ])('読まない: %s', (_name, text) => {
    expect(parseAgentMail(text).ok).toBe(false)
  })
})

describe('宛先の名前', () => {
  const custom = [{ id: 'custom:my-bot' as const, name: 'My Bot', command: 'bot', args: '' }]
  it.each([
    ['codex', 'codex'], ['Codex', 'codex'], [' CODEX ', 'codex'], ['claude', 'claude'], ['Claude Code', 'claude'], ['claude-code', 'claude'],
    ['cc', 'claude'], ['gemini', 'gemini'], ['gemini-cli', 'gemini'], ['my bot', 'custom:my-bot'], ['custom:my-bot', 'custom:my-bot'], ['my-bot', 'custom:my-bot'],
    ['hermes', 'hermes'], ['Hermes Agent', 'hermes'], ['openclaw', 'openclaw'], ['clawdbot', 'openclaw'], ['deepseek', 'deepseek'], ['DeepSeek', 'deepseek']
  ])('%s → %s', (name, agent) => {
    expect(normalizeAgentTarget(name, custom)).toBe(agent)
  })
  it.each(['', '  ', 'nobody', 'codex2', '../codex'])('分からない: %j', (name) => {
    expect(normalizeAgentTarget(name, custom)).toBeNull()
  })
})

describe('貼る文', () => {
  it('依頼に番号・送り手・結果のファイル・返し方を書く', () => {
    const text = renderRequest({ number: 7, fromLabel: 'Claude Code', fromTitle: 'Claude Code', body: 'Review src/auth', bodyFile: null, file: '/w/req.md', replyPath: '/w/.ferret/agent-mail/x 7.md', cliPath: '/tmp/fam/terminals/ab/ferret-agent', platform: 'darwin' })
    expect(text).toContain('[Ferret agent mail #7] Request from Claude Code')
    expect(text).toContain('Review src/auth')
    expect(text).toContain('Attached file: /w/req.md')
    // 相手のタブの CLI を絶対パスで書く（環境変数を消す Agent の中でも動く）
    expect(text).toContain(`/tmp/fam/terminals/ab/ferret-agent reply 7 --file '/w/.ferret/agent-mail/x 7.md'`)
  })

  it('Windows は PowerShell の書き方', () => {
    const text = renderRequest({ number: 1, fromLabel: 'Codex', fromTitle: 'Codex', body: 'x', bodyFile: 'C:\\w\\r.md', file: null, replyPath: 'C:\\w\\a b.md', cliPath: 'C:\\T\\ferret agent.cmd', platform: 'win32' })
    expect(text).toContain("& 'C:\\T\\ferret agent.cmd' reply 1 --file 'C:\\w\\a b.md'")
    expect(text).toContain('without the leading &')
    expect(text).toContain('The full request is in C:\\w\\r.md')
  })

  it('返事に結果のファイルと、同じ相手へ続けて頼む書き方', () => {
    const text = renderReply({ number: 2, fromLabel: 'Codex', fromTitle: 'Codex', body: '3 issues', bodyFile: null, file: '/w/r.md', agentTarget: 'codex', cliPath: '/t/c1/ferret-agent', platform: 'linux' })
    expect(text).toContain('[Ferret agent mail #2 reply] Codex')
    expect(text).toContain('Result file: /w/r.md')
    expect(text).toContain('/t/c1/ferret-agent send codex')
  })

  it('届けられなかった知らせ', () => {
    expect(renderFailure(4, 'Codex', 'closed')).toBe('[Ferret agent mail #4] Could not deliver to Codex: closed')
    expect(renderFailure(null, 'Codex', 'closed')).toBe('[Ferret agent mail] Could not deliver to Codex: closed')
  })

  it('引用: POSIX は必要なときだけ単引用符、Windows は二重引用符', () => {
    expect(quoteArg('/a/b.md', 'darwin')).toBe('/a/b.md')
    expect(quoteArg("/a/it's.md", 'darwin')).toBe(`'/a/it'\\''s.md'`)
    expect(quoteArg('/a/$(rm).md', 'linux')).toBe(`'/a/$(rm).md'`)
    expect(quoteArg('C:\\a "b"', 'win32')).toBe(`'C:\\a "b"'`)
    // PowerShell の単引用符の中では $ と ` を展開しない。単引用符（和文のものも）は二重にする
    expect(quoteArg('C:\\$work\\`x', 'win32')).toBe("'C:\\$work\\`x'")
    expect(quoteArg("C:\\it's ‘q’", 'win32')).toBe("'C:\\it''s ‘‘q’’'")
  })

  it('結果のファイルの名前は日時・番号・Agent', () => {
    expect(replyFileName(new Date(2026, 9, 10, 9, 5), 12, 'Claude Code')).toBe('20261010-0905-12-claude-code.md')
    expect(replyFileName(new Date(2026, 0, 2, 23, 59), 1, '../..')).toBe('20260102-2359-1-agent.md')
  })

  it('1通の名前の決まり', () => {
    expect(MAIL_FILE_PATTERN.test('1760000000-123-456.mail')).toBe(true)
    for (const bad of ['.hidden.mail', 'a/b.mail', 'x.mail.tmp', 'x.status', `${'a'.repeat(100)}.mail`, '-x.mail']) expect(MAIL_FILE_PATTERN.test(bad)).toBe(false)
  })
})

describe('数の上限（直近1時間）', () => {
  it('上限ちょうどまで送れて、次は断る。時間が過ぎれば戻る。タブごとに別', () => {
    const limit = new MailRateLimit(3, 1000)
    expect([limit.take('a', 0), limit.take('a', 1), limit.take('a', 2), limit.take('a', 3)]).toEqual([true, true, true, false])
    expect(limit.take('b', 3)).toBe(true)
    expect(limit.take('a', 999)).toBe(false)
    expect(limit.take('a', 1000)).toBe(true) // 0 の分が窓の外へ
    limit.reset('a')
    expect([limit.take('a', 1001), limit.take('a', 1002)]).toEqual([true, true])
  })
})

describe('skill と Windows の CLI', () => {
  it('skill は印・名前・使う場面・返し方を持つ', () => {
    const text = renderAgentMailSkill('9.9.9')
    expect(text.startsWith('---\nname: ferret-agent-mail\ndescription: ')).toBe(true)
    expect(isAgentMailSkill(text)).toBe(true)
    expect(text).toContain(AGENT_MAIL_SKILL_MARKER)
    expect(text).toContain('ferret-agent send codex')
    expect(text).toContain('$FERRET_AGENT_CLI')
    expect(text).toContain('reply N --file')
    expect(text).toContain('Ferret 9.9.9')
    expect(isAgentMailSkill('---\nname: ferret-agent-mail\n---\nmine')).toBe(false)
  })

  it('Windows のタブごとの入口は setlocal の中で受け口と合言葉を決めて ps1 を呼ぶ。% と " は入れない', () => {
    expect(renderSessionWindowsCmd('C:\\T\\core.ps1', 'C:\\T\\out%x"', 'abc')).toBe('@echo off\r\nsetlocal\r\nset "FERRET_AGENT_MAIL=C:\\T\\outx"\r\nset "FERRET_AGENT_ID=abc"\r\npowershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "C:\\T\\core.ps1" %*\r\n')
    const ps = renderPowerShellCli()
    expect(ps).toContain(`"${AGENT_MAIL_MAGIC}\`nkind: $kind\`nfrom: $self`)
    expect(ps).toContain('$env:FERRET_AGENT_MAIL')
    expect(ps).toContain('UTF8Encoding $false')
  })
})

// ───────────────────────── POSIX の CLI を実際に動かす ─────────────────────────

const posix = process.platform !== 'win32'
const work = mkdtempSync(join(tmpdir(), 'agent-mail-cli-'))
afterAll(() => rmSync(work, { recursive: true, force: true }))

function setup() {
  const dir = mkdtempSync(join(work, 'case-'))
  const mailbox = join(dir, 'outbox')
  mkdirSync(mailbox)
  const cli = join(dir, 'ferret-agent')
  writeFileSync(cli, renderPosixCli())
  chmodSync(cli, 0o755)
  return { dir, mailbox, cli }
}

/** CLI を走らせ、受け口に来た1通を読んで status を書く（Ferret の代わり） */
function run(args: string[], options: { env?: Record<string, string | undefined>; input?: string; answer?: string; cwd?: string } = {}) {
  const { dir, mailbox, cli } = setup()
  const env: Record<string, string> = { PATH: process.env.PATH ?? '/usr/bin:/bin', FERRET_AGENT_MAIL: mailbox, FERRET_AGENT_ID: FROM }
  for (const [k, v] of Object.entries(options.env ?? {})) { if (v === undefined) delete env[k]; else env[k] = v }
  return new Promise<{ code: number | null; stdout: string; stderr: string; mail: string | null }>((resolve) => {
    const child = spawn(cli, args, { env, cwd: options.cwd ?? dir, stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    let seen: string | null = null
    child.stdout.on('data', (d) => { stdout += d })
    child.stderr.on('data', (d) => { stderr += d })
    if (options.input !== undefined) child.stdin.end(options.input)
    else child.stdin.end()
    const watcher = setInterval(() => {
      if (!existsSync(mailbox)) return
      for (const name of readdirSync(mailbox)) {
        if (!name.endsWith('.mail')) continue
        seen = readFileSync(join(mailbox, name), 'utf8')
        rmSync(join(mailbox, name))
        writeFileSync(join(mailbox, name.replace(/\.mail$/, '.status')), `${options.answer ?? 'ok: delivered #1'}\n`)
      }
    }, 20)
    child.on('close', (code) => { clearInterval(watcher); resolve({ code, stdout, stderr, mail: seen }) })
  })
}

describe.runIf(posix)('タブごとの CLI（環境変数を消す Agent の中）', () => {
  it('環境変数が無くても、書き込んだ受け口と合言葉で送れる。引用符・空白入りのパスも', async () => {
    const { dir, mailbox, cli: core } = setup()
    const odd = join(dir, "it's a dir")
    mkdirSync(odd)
    const wrapper = join(odd, 'ferret-agent')
    writeFileSync(wrapper, renderSessionPosixCli(core, mailbox, FROM))
    chmodSync(wrapper, 0o755)
    const got = await new Promise<{ code: number | null; out: string; mail: string | null }>((resolve) => {
      let mail: string | null = null
      const child = execFile(wrapper, ['send', 'codex', 'hi'], { env: { PATH: process.env.PATH } }, (err, out) => resolve({ code: err ? (err as { code?: number }).code ?? 1 : 0, out, mail }))
      const watcher = setInterval(() => {
        for (const name of readdirSync(mailbox)) {
          if (!name.endsWith('.mail')) continue
          mail = readFileSync(join(mailbox, name), 'utf8')
          rmSync(join(mailbox, name))
          writeFileSync(join(mailbox, name.replace(/\.mail$/, '.status')), 'ok: delivered\n')
        }
      }, 20)
      child.on('close', () => clearInterval(watcher))
    })
    expect(got.code).toBe(0)
    expect(got.out).toContain('ok: delivered')
    const parsed = parseAgentMail(got.mail!)
    expect(parsed.ok && parsed.mail).toMatchObject({ from: FROM, to: 'codex', body: 'hi' })
  })
})

describe.runIf(posix)('POSIX の CLI', () => {
  it('send: 1通を書き、Ferret の結果を出して 0 で終わる。status は消す', async () => {
    const r = await run(['send', 'codex', 'Review', 'src/auth', 'please'])
    expect(r.code).toBe(0)
    expect(r.stdout).toContain('ok: delivered #1')
    const parsed = parseAgentMail(r.mail!)
    expect(parsed.ok && parsed.mail).toMatchObject({ kind: 'send', from: FROM, to: 'codex', replyTo: null, file: null, body: 'Review src/auth please' })
  })

  it('Ferret が error を返したら 1 で終わる', async () => {
    const r = await run(['send', 'nobody', 'x'], { answer: 'error: unknown agent "nobody"' })
    expect(r.code).toBe(1)
    expect(r.stdout).toContain('unknown agent')
  })

  it('reply と --file（相対は今のフォルダから絶対へ）', async () => {
    const { dir } = setup()
    writeFileSync(join(dir, 'result.md'), '# result')
    const r = await run(['reply', '3', '--file', 'result.md', 'done:', '2 fixed'], { cwd: dir })
    expect(r.code).toBe(0)
    const parsed = parseAgentMail(r.mail!)
    expect(parsed.ok && parsed.mail).toMatchObject({ kind: 'reply', replyTo: 3, body: 'done: 2 fixed' })
    expect(parsed.ok && parsed.mail.file?.endsWith('/result.md')).toBe(true)
    expect(parsed.ok && parsed.mail.file?.startsWith('/')).toBe(true)
  })

  it('本文を標準入力から読む。記号・改行・%・$ をそのまま運ぶ', async () => {
    const body = `line1 $HOME %s %n \\ "q" 'q' \`x\`\n\nline3 日本語`
    const r = await run(['send', 'claude'], { input: body })
    expect(r.code).toBe(0)
    const parsed = parseAgentMail(r.mail!)
    expect(parsed.ok && parsed.mail.body).toBe(body)
  })

  it('--file だけでも送れる', async () => {
    const { dir } = setup()
    writeFileSync(join(dir, 'req.md'), 'x')
    const r = await run(['send', 'codex', '--file', join(dir, 'req.md')])
    expect(r.code).toBe(0)
    const parsed = parseAgentMail(r.mail!)
    expect(parsed.ok && parsed.mail).toMatchObject({ file: join(dir, 'req.md'), body: '' })
  })

  it('Ferret のターミナルの外（環境変数が無い）は 3 で止まり、何も書かない', async () => {
    for (const env of [{ FERRET_AGENT_MAIL: undefined }, { FERRET_AGENT_ID: undefined }, { FERRET_AGENT_MAIL: '/nonexistent/ferret-mail' }]) {
      const r = await run(['send', 'codex', 'x'], { env })
      expect(r.code).toBe(3)
      expect(r.stderr).toContain('inside a terminal opened by Ferret')
      expect(r.mail).toBeNull()
    }
  })

  it.each([
    [['send']],
    [[]],
    [['forward', 'codex', 'x']],
    [['send', 'codex', '--file']],
    [['send', 'codex']]
  ])('使い方の誤りは 2: %j', async (args) => {
    const r = await run(args)
    expect(r.code).toBe(2)
    expect(r.mail).toBeNull()
  })

  it('無いファイル・改行入りの宛先は 2 で止める', async () => {
    const missing = await run(['send', 'codex', '--file', '/nonexistent/req.md'])
    expect(missing.code).toBe(2)
    expect(missing.stderr).toContain('no such file')
    const newline = await run(['send', 'codex\nkind: reply', 'x'])
    expect(newline.code).toBe(2)
    expect(newline.mail).toBeNull()
  })

  it('一時ファイルを残さない（書き終えてから .mail に名前を変える）', async () => {
    const { mailbox, cli } = setup()
    await new Promise<void>((resolve) => {
      const child = execFile(cli, ['send', 'codex', 'x'], { env: { PATH: process.env.PATH, FERRET_AGENT_MAIL: mailbox, FERRET_AGENT_ID: FROM } }, () => resolve())
      const watcher = setInterval(() => {
        for (const name of readdirSync(mailbox)) {
          if (!name.endsWith('.mail')) continue
          rmSync(join(mailbox, name))
          writeFileSync(join(mailbox, name.replace(/\.mail$/, '.status')), 'ok\n')
          clearInterval(watcher)
        }
      }, 20)
      child.on('close', () => clearInterval(watcher))
    })
    expect(readdirSync(mailbox)).toEqual([])
  })
})

import { prependPathEntry } from '../../src/main/terminalEnv'

describe('PATH の先頭に CLI のフォルダを足す', () => {
  it('POSIX: 先頭に足し、同じものは重ねない', () => {
    const env = { PATH: '/usr/bin:/t/a:/bin' }
    prependPathEntry(env, '/t/a', 'darwin', ':')
    expect(env.PATH).toBe('/t/a:/usr/bin:/bin')
  })
  it('PATH が無ければ作る。空のフォルダは足さない', () => {
    const env: Record<string, string> = {}
    prependPathEntry(env, '', 'linux', ':')
    expect(env).toEqual({})
    prependPathEntry(env, '/t/a', 'linux', ':')
    expect(env).toEqual({ PATH: '/t/a' })
  })
  it('Windows: 大文字小文字の違う Path をまとめる', () => {
    const env: Record<string, string> = { Path: 'C:\\Windows', PATH: 'C:\\Other' }
    prependPathEntry(env, 'C:\\T\\a', 'win32', ';')
    expect(env).toEqual({ Path: 'C:\\T\\a;C:\\Windows;C:\\Other' })
  })
})
