import { describe, expect, it } from 'vitest'
import {
  CLI_TOOL_IDS,
  CLI_TOOLS,
  cliDetectCommands,
  cliInstallCommand,
  cliLoginCommand,
  cliToolForInstallUrl,
  parseCliVersion
} from '@shared/cliTools'

describe('CLI の一覧', () => {
  it('一覧の順に全部が並び、重なりが無い', () => {
    expect(new Set(CLI_TOOL_IDS).size).toBe(CLI_TOOL_IDS.length)
    expect([...CLI_TOOL_IDS].sort()).toEqual(Object.keys(CLI_TOOLS).sort())
  })

  it('案内のページは https', () => {
    for (const id of CLI_TOOL_IDS) expect(CLI_TOOLS[id].homepageUrl).toMatch(/^https:\/\//)
  })

  it('コマンドは1行で、改行や外から差し込む場所（{{…}}・${…} の展開）を持たない', () => {
    for (const id of CLI_TOOL_IDS) {
      const commands = [...Object.values(CLI_TOOLS[id].install), CLI_TOOLS[id].login].filter((c): c is string => !!c)
      for (const command of commands) {
        expect(command).not.toMatch(/[\r\n]/)
        expect(command).not.toMatch(/\{\{|\$\{|`/)
      }
    }
  })
})

describe('OS ごとのインストールコマンド', () => {
  it('gh は macOS が Homebrew、Linux は Homebrew か公式の apt / dnf、Windows が winget', () => {
    expect(cliInstallCommand('gh', 'darwin')).toBe('brew install gh')
    const linux = cliInstallCommand('gh', 'linux') ?? ''
    expect(linux.startsWith("bash -c 'if type -p brew >/dev/null; then brew install gh; elif type -p apt")).toBe(true)
    expect(linux).toContain('https://cli.github.com/packages')
    expect(linux).toContain('sudo dnf install -y gh')
    // 単一引用符で包むので、中に単一引用符が無い
    expect(linux.slice("bash -c '".length, -1)).not.toContain("'")
    expect(cliInstallCommand('gh', 'win32')).toBe('winget install --id GitHub.cli -e')
  })

  it('npm のものは OS に関係なく同じ', () => {
    for (const platform of ['darwin', 'linux', 'win32'] as const) {
      expect(cliInstallCommand('wrangler', platform)).toBe('npm install -g wrangler')
      expect(cliInstallCommand('vercel', platform)).toBe('npm install -g vercel')
      expect(cliInstallCommand('firebase', platform)).toBe('npm install -g firebase-tools')
    }
  })

  it('Windows の PowerShell の手順は cmd.exe から動くよう powershell -Command で包む', () => {
    expect(cliInstallCommand('ollama', 'win32')).toBe('powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://ollama.com/install.ps1 | iex"')
    expect(cliInstallCommand('aws', 'win32')).toMatch(/^powershell .* -Command "irm https:\/\/awscli\.amazonaws\.com\/v2\/install\.ps1 \| iex"$/)
    for (const id of CLI_TOOL_IDS) {
      const command = cliInstallCommand(id, 'win32')
      if (!command) continue
      // POSIX のシェルや Homebrew の手順を Windows に出さない
      expect(command).not.toMatch(/\|\s*(ba|z)?sh\b|^brew\s/)
    }
  })

  it('macOS・Linux は公式のスクリプト（Ollama・AWS）', () => {
    expect(cliInstallCommand('ollama', 'darwin')).toBe('curl -fsSL https://ollama.com/install.sh | sh')
    expect(cliInstallCommand('aws', 'linux')).toBe('curl -fsSL https://awscli.amazonaws.com/v2/install.sh | bash')
  })

  it('公式の1行の手順が無い OS は undefined（リンクだけ）', () => {
    expect(cliInstallCommand('docker', 'darwin')).toBeUndefined()
    expect(cliInstallCommand('docker', 'win32')).toBeUndefined()
    expect(cliInstallCommand('docker', 'linux')).toMatch(/get\.docker\.com/)
  })

  it('Linux 以外の Unix は Linux の手順を使う', () => {
    expect(cliInstallCommand('gh', 'freebsd')).toBe(cliInstallCommand('gh', 'linux'))
  })
})

describe('ログインと検出', () => {
  it('ログインのコマンド（Ollama・Docker は無し）', () => {
    expect(cliLoginCommand('gh')).toBe('gh auth login --web -h github.com')
    expect(cliLoginCommand('glab')).toBe('glab auth login')
    expect(cliLoginCommand('wrangler')).toBe('wrangler login')
    expect(cliLoginCommand('ollama')).toBeUndefined()
    expect(cliLoginCommand('docker')).toBeUndefined()
  })

  it('別名も検出に使う', () => {
    expect(cliDetectCommands('flyctl')).toEqual(['flyctl', 'fly'])
    expect(cliDetectCommands('gh')).toEqual(['gh'])
  })
})

describe('parseCliVersion', () => {
  it('よくある出力から版を読む', () => {
    expect(parseCliVersion('gh version 2.81.0 (2026-09-01)\nhttps://github.com/cli/cli/releases/tag/v2.81.0')).toBe('2.81.0')
    expect(parseCliVersion(' ⛅️ wrangler 4.42.0\n')).toBe('4.42.0')
    expect(parseCliVersion('aws-cli/2.32.1 Python/3.13.7 Darwin/25.0.0 exe/arm64')).toBe('2.32.1')
    expect(parseCliVersion('ollama version is 0.12.3')).toBe('0.12.3')
    expect(parseCliVersion('flyctl v0.3.190 darwin/arm64 Commit: abc')).toBe('0.3.190')
    expect(parseCliVersion('Google Cloud SDK 540.0.0\nbq 2.1.22')).toBe('540.0.0')
  })

  it('版が無ければ null', () => {
    expect(parseCliVersion('')).toBeNull()
    expect(parseCliVersion('command not found')).toBeNull()
  })
})

describe('cliToolForInstallUrl', () => {
  it('Ollama のダウンロードページは ollama の CLI に当てる', () => {
    expect(cliToolForInstallUrl('https://ollama.com/download')).toBe('ollama')
    expect(cliToolForInstallUrl('https://www.ollama.com/download')).toBe('ollama')
  })

  it('当てられないものは null（リンクのまま）', () => {
    expect(cliToolForInstallUrl('https://lmstudio.ai/download')).toBeNull()
    expect(cliToolForInstallUrl('https://evil.example/ollama.com')).toBeNull()
    expect(cliToolForInstallUrl('not a url')).toBeNull()
    expect(cliToolForInstallUrl(undefined)).toBeNull()
  })
})

describe('setupCliTool（AI の接続先の欄に出す CLI）', () => {
  it('Account ID が要る Cloudflare は wrangler、端末内の Ollama は ollama、ほかは無し', async () => {
    const { setupCliTool } = await import('@shared/cliSetup')
    expect(setupCliTool({ needsAccountId: true })).toBe('wrangler')
    expect(setupCliTool({ local: true, installUrl: 'https://ollama.com/download' })).toBe('ollama')
    expect(setupCliTool({ local: true, installUrl: 'https://lmstudio.ai/download' })).toBeNull()
    expect(setupCliTool({})).toBeNull()
  })
})

describe('runCliAction（ボタンから内蔵ターミナルへ）', () => {
  it('ターミナルが受け取れば、その OS のカタログのコマンドとタブ名を渡す', async () => {
    const { runCliAction } = await import('../../src/renderer/lib/cliTools')
    const requests: Array<{ command: string; title?: string }> = []
    const r = await runCliAction('wrangler', 'login', 'Sign in: Wrangler', { request: (req) => { requests.push(req); return true }, platform: 'darwin' })
    expect(r).toEqual({ result: 'terminal', command: 'wrangler login' })
    expect(requests).toEqual([{ command: 'wrangler login', title: 'Sign in: Wrangler' }])
    const w = await runCliAction('gh', 'install', 'x', { request: () => true, platform: 'win32' })
    expect(w.command).toBe('winget install --id GitHub.cli -e')
  })

  it('ターミナルが無ければコマンドを写す。写せなければ failed', async () => {
    const { runCliAction } = await import('../../src/renderer/lib/cliTools')
    const copied: string[] = []
    expect(await runCliAction('gh', 'install', 'x', { request: () => false, copy: async (t) => { copied.push(t) }, platform: 'darwin' }))
      .toEqual({ result: 'copied', command: 'brew install gh' })
    expect(copied).toEqual(['brew install gh'])
    expect((await runCliAction('gh', 'install', 'x', { request: () => false, copy: async () => { throw new Error('denied') }, platform: 'darwin' })).result).toBe('failed')
  })

  it('その OS にコマンドが無ければ何も送らない', async () => {
    const { runCliAction } = await import('../../src/renderer/lib/cliTools')
    let called = false
    const r = await runCliAction('docker', 'install', 'x', { request: () => { called = true; return true }, platform: 'darwin' })
    expect(r.result).toBe('failed')
    expect(called).toBe(false)
    expect((await runCliAction('ollama', 'login', 'x', { request: () => { called = true; return true } })).result).toBe('failed')
    expect(called).toBe(false)
  })

  it('その OS で使えない CLI（UTM を Windows で）は何も送らない', async () => {
    const { runCliAction } = await import('../../src/renderer/lib/cliTools')
    let called = false
    const r = await runCliAction('utm', 'install', 'x', { request: () => { called = true; return true }, platform: 'win32' })
    expect(r.result).toBe('failed')
    expect(called).toBe(false)
  })
})

describe('よく使うサービスの CLI のカタログ', () => {
  it('どの CLI もサイトと公式ページ（https）・種類を持ち、どの種類にも1つ以上ある', async () => {
    const { CLI_TOOL_CATEGORIES, cliSiteHost } = await import('@shared/cliTools')
    const { isSafeExternalUrl } = await import('@shared/setupGuide')
    for (const id of CLI_TOOL_IDS) {
      const entry = CLI_TOOLS[id]
      expect(isSafeExternalUrl(entry.siteUrl), id).toBe(true)
      expect(isSafeExternalUrl(entry.homepageUrl), id).toBe(true)
      expect(CLI_TOOL_CATEGORIES, id).toContain(entry.category)
      expect(cliSiteHost(id), id).toMatch(/^[a-z0-9.-]+\.[a-z]+$/)
    }
    for (const category of CLI_TOOL_CATEGORIES) {
      expect(CLI_TOOL_IDS.some((id) => CLI_TOOLS[id].category === category), category).toBe(true)
    }
    expect(new Set(CLI_TOOL_IDS.map((id) => CLI_TOOLS[id].label)).size).toBe(CLI_TOOL_IDS.length)
  })

  it('一覧の順は種類ごとにまとまっている', async () => {
    const { CLI_TOOL_CATEGORIES } = await import('@shared/cliTools')
    const order = CLI_TOOL_IDS.map((id) => CLI_TOOL_CATEGORIES.indexOf(CLI_TOOLS[id].category))
    expect(order).toEqual([...order].sort((a, b) => a - b))
  })

  it('各 OS で、インストールコマンドか公式ページか「その OS では使えない」のどれかになる', async () => {
    const { cliToolSupported } = await import('@shared/cliTools')
    for (const id of CLI_TOOL_IDS) {
      const platforms = CLI_TOOLS[id].platforms
      for (const os of ['darwin', 'linux', 'win32'] as const) {
        const supported = cliToolSupported(id, os)
        expect(supported, `${id} ${os}`).toBe(!platforms || platforms.includes(os))
        // 使えない OS にはコマンドを出さない（カタログにも書かない）
        if (!supported) {
          expect(cliInstallCommand(id, os), `${id} ${os}`).toBeUndefined()
          expect(CLI_TOOLS[id].install[os], `${id} ${os}`).toBeUndefined()
        }
      }
    }
  })

  it('種類の振り分け（Wrangler はホスティング、Sentry は監視、UTM は仮想マシン）', () => {
    expect(CLI_TOOLS.wrangler.category).toBe('deploy')
    expect(CLI_TOOLS.sentry.category).toBe('monitoring')
    expect(CLI_TOOLS.supabase.category).toBe('database')
    expect(CLI_TOOLS.stripe.category).toBe('payments')
    expect(CLI_TOOLS.docker.category).toBe('containers')
    expect(CLI_TOOLS.adb.category).toBe('mobile')
    expect(CLI_TOOLS.utm.category).toBe('vm')
    expect(CLI_TOOLS.ollama.category).toBe('ai')
    // AI・モデルには AI の CLI だけ
    expect(CLI_TOOL_IDS.filter((id) => CLI_TOOLS[id].category === 'ai')).toEqual(['ollama'])
  })

  it('Sentry CLI は OS ごとの公式の入れ方とログイン', () => {
    expect(cliInstallCommand('sentry', 'darwin')).toBe('brew install getsentry/tools/sentry-cli')
    expect(cliInstallCommand('sentry', 'linux')).toBe('curl -sL https://sentry.io/get-cli/ | sh')
    expect(cliInstallCommand('sentry', 'win32')).toBe('npm install -g @sentry/cli')
    expect(cliLoginCommand('sentry')).toBe('sentry-cli login')
    expect(cliDetectCommands('sentry')).toEqual(['sentry-cli'])
  })

  it('UTM は macOS だけ。Homebrew の cask で入れ、アプリの中の utmctl があるかだけを見る（走らせない）', async () => {
    const { cliVersionArgs, cliDisplayCommand } = await import('@shared/cliTools')
    expect(cliInstallCommand('utm', 'darwin')).toBe('brew install --cask utm')
    expect(cliInstallCommand('utm', 'win32')).toBeUndefined()
    expect(cliInstallCommand('utm', 'linux')).toBeUndefined()
    expect(cliDetectCommands('utm')).toEqual(['/Applications/UTM.app/Contents/MacOS/utmctl'])
    expect(cliDisplayCommand('utm')).toBe('utmctl')
    // utmctl・xcrun を走らせると OS のダイアログ（自動化の許可・ツールのインストール）が出ることがある
    expect(cliVersionArgs('utm')).toBeNull()
    expect(cliVersionArgs('xcode')).toBeNull()
    expect(cliLoginCommand('utm')).toBeUndefined()
  })

  it('Xcode のコマンドラインツールは macOS だけで、置き場の絶対パスで見る', async () => {
    const { cliToolSupported } = await import('@shared/cliTools')
    expect(cliToolSupported('xcode', 'darwin')).toBe(true)
    expect(cliToolSupported('xcode', 'win32')).toBe(false)
    expect(cliInstallCommand('xcode', 'darwin')).toBe('xcode-select --install')
    for (const command of cliDetectCommands('xcode')) expect(command.startsWith('/')).toBe(true)
  })

  it('kubectl の版は手元だけを見る（クラスタに繋がない）', async () => {
    const { cliVersionArgs } = await import('@shared/cliTools')
    expect(cliVersionArgs('kubectl')).toEqual(['version', '--client'])
    expect(cliVersionArgs('gh')).toEqual(['--version'])
  })

  it('絶対パスで見るものは macOS 向けだけ（ほかの OS で POSIX の絶対パスを探さない）', () => {
    for (const id of CLI_TOOL_IDS) {
      if (!cliDetectCommands(id).some((c) => c.includes('/'))) continue
      expect(CLI_TOOLS[id].platforms, id).toEqual(['darwin'])
    }
  })
})

describe('mapWithLimit（版の読み取りを同時にいくつまで走らせるか）', () => {
  it('同時に limit 個までしか走らせず、結果は入力の順', async () => {
    const { mapWithLimit, VERSION_CONCURRENCY } = await import('../../src/main/cliTools')
    let active = 0
    let peak = 0
    const items = Array.from({ length: 20 }, (_, i) => i)
    const out = await mapWithLimit(items, VERSION_CONCURRENCY, async (i) => {
      active++
      peak = Math.max(peak, active)
      await new Promise((r) => setTimeout(r, (20 - i) % 3))
      active--
      return i * 2
    })
    expect(out).toEqual(items.map((i) => i * 2))
    expect(peak).toBeLessThanOrEqual(VERSION_CONCURRENCY)
    expect(peak).toBeGreaterThan(1)
    expect(await mapWithLimit([], 4, async (x: number) => x)).toEqual([])
  })
})
