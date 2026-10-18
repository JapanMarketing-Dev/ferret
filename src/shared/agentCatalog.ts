import type {
  AccountAgent,
  AgentLaunchConfig,
  AgentPreferences,
  BuiltinAgent,
  CustomAgent,
  CustomAgentId,
  TuiAgent
} from './types'

/**
 * ターミナルから起動できるコーディングエージェントの一覧（main・renderer・単体テストで共有する純粋なデータと関数）。
 *
 * Orca由来: ~/bench/orca/src/shared/tui-agent-config.ts（detectCmd / detectCmdAliases / launchCmd / expectedProcess）,
 *           ~/bench/orca/src/shared/tui-agent-permissions.ts（YOLO_TUI_AGENT_ARGS）,
 *           ~/bench/orca/src/renderer/src/lib/agent-catalog.tsx（label / homepageUrl。43種）,
 *           ~/bench/orca/src/shared/agent-process-recognition.ts,
 *           ~/bench/orca/src/shared/agent-node-package-entrypoints.ts,
 *           ~/bench/orca/src/shared/agent-node-entrypoint-identities.ts（MIT, Copyright 2026 Lovecast Inc.）
 *
 * Orca の一覧を土台に、2026-10 時点の公式ドキュメント・README で、実行ファイル名・入れ方・案内ページ・
 * 権限確認を省く引数を確かめ直した（verified）。確かめられなかった引数は空にしている（推測で入れない）。
 * Orca にあるもののうち、Orca 独自のラッパー（claude-agent-teams）と、正式版で opencode に統合された
 * opencode2 は外した。Orca の README の Supported Agents はすべて含め、表示名もそれに合わせる
 * （ORCA_SUPPORTED_AGENTS。単体テストで確かめる）。Orca に無い主要なもの
 * （Junie・OpenHands・Roo Code・Letta Code・ForgeCode・BLACKBOX）を足した。
 * 足すときは BuiltinAgent（types.ts）と下の表に1行ずつ足す。
 */

interface AgentCatalogEntry {
  label: string
  /** PATH 上にあればインストール済みとみなすコマンド（Orca の detectCmd） */
  detectCmd: string
  /** 同じエージェントを指す別名（Orca の detectCmdAliases。旧名を含む） */
  aliases?: readonly string[]
  /**
   * 起動コマンド（Orca の launchCmd。対話の画面を開くサブコマンドが要るもの。省略時は detectCmd）。
   * 実行ファイルとサブコマンドだけを書き、権限やフォルダの信頼に関わるフラグは入れない（security-5 [2]。trustArgs / yoloArgs へ）
   */
  launchCmd?: string
  /**
   * そのフォルダを信頼して開く引数（Muse の --trust-workspace など）。起動の決まり（agentPolicy.ts）が、
   * 設定の skipPermissions が入で登録したプロジェクトのフォルダのときだけ付ける
   */
  trustArgs?: string
  /** 権限確認を省く引数（Orca の YOLO_TUI_AGENT_ARGS を公式の資料で確かめ直したもの）。無い・確かめられないものは空 */
  yoloArgs: string
  /** 公式の入れ方（1つ）。公式が手順を出していないものは空 */
  install: string
  /**
   * Windows の公式の入れ方（1行。インストール用のターミナルは cmd.exe なので、PowerShell の手順は powershell -Command で包む）。
   * 無いときに install が POSIX のシェルでしか動かないもの（curl … | bash など）は、Windows では公式ページへのリンクだけを出す
   */
  installWindows?: string
  /** Linux の公式の入れ方（install が macOS の Homebrew だけのもの）。無ければ install をそのまま使う */
  installLinux?: string
  /** 公式の入れ方・始め方のページ */
  homepageUrl: string
  /** 2026-10 に公式の資料で、実行ファイル名・入れ方・引数を確かめられた */
  verified: boolean
  /** オンボーディングと設定で、検出の有無にかかわらず最初から見せる主要なもの */
  popular?: boolean
}

/** メニューに並べる順。主要なもの（popular）を先に、残りは名前の順 */
export const BUILTIN_AGENTS: readonly BuiltinAgent[] = [
  'claude',
  'codex',
  'antigravity',
  'cursor',
  'copilot',
  'devin',
  'opencode',
  'amp',
  'droid',
  'kiro',
  'hermes',
  'deepseek',
  'openclaw',
  'aider',
  'ante',
  'aug',
  'autohand',
  'blackbox',
  'cline',
  'codebuddy',
  'codebuff',
  'command-code',
  'continue',
  'crush',
  'dsh',
  'forge',
  'freebuff',
  'gemini',
  'goose',
  'grok',
  'junie',
  'kilo',
  'kimi',
  'letta',
  'mimo-code',
  'mistral-vibe',
  'muse',
  'omp',
  'openclaude',
  'openhands',
  'pi',
  'prime-agent',
  'qoder',
  'qwen-code',
  'roo',
  'rovo',
  'trae',
  'zcode'
]

export const AGENT_CATALOG: Record<BuiltinAgent, AgentCatalogEntry> = {
  claude: {
    label: 'Claude Code',
    detectCmd: 'claude',
    yoloArgs: '--dangerously-skip-permissions',
    install: 'curl -fsSL https://claude.ai/install.sh | bash',
    // 公式の Windows CMD の手順（code.claude.com/docs/en/setup、2026-10 確認）
    installWindows: 'curl -fsSL https://claude.ai/install.cmd -o install.cmd && install.cmd && del install.cmd',
    homepageUrl: 'https://code.claude.com/docs/en/setup',
    verified: true,
    popular: true
  },
  codex: {
    label: 'Codex',
    detectCmd: 'codex',
    yoloArgs: '--dangerously-bypass-approvals-and-sandbox',
    install: 'npm install -g @openai/codex',
    homepageUrl: 'https://github.com/openai/codex',
    verified: true,
    popular: true
  },
  // 2026-10 から個人の Google アカウントでのログインが使えなくなり（「This client is no longer supported for Gemini
  // Code Assist for individuals」）、Antigravity への移行を案内される。API キー・Vertex AI では動くので一覧には残す
  gemini: {
    label: 'Gemini CLI',
    detectCmd: 'gemini',
    yoloArgs: '--approval-mode=yolo',
    install: 'npm install -g @google/gemini-cli',
    homepageUrl: 'https://github.com/google-gemini/gemini-cli',
    verified: true
  },
  cursor: {
    label: 'Cursor',
    detectCmd: 'agent',
    aliases: ['cursor-agent'],
    yoloArgs: '--force',
    install: 'curl https://cursor.com/install -fsS | bash',
    // 公式の Windows（native, PowerShell）の手順（cursor.com/docs/cli/installation、2026-10 確認）
    installWindows: 'powershell -NoProfile -Command "irm \'https://cursor.com/install?win32=true\' | iex"',
    homepageUrl: 'https://cursor.com/docs/cli/installation',
    verified: true,
    popular: true
  },
  copilot: {
    label: 'GitHub Copilot',
    detectCmd: 'copilot',
    yoloArgs: '--yolo',
    install: 'npm install -g @github/copilot',
    homepageUrl: 'https://docs.github.com/en/copilot/how-tos/set-up/install-copilot-cli',
    verified: true,
    popular: true
  },
  devin: {
    label: 'Devin',
    detectCmd: 'devin',
    yoloArgs: '--permission-mode bypass --respect-workspace-trust false',
    install: 'curl -fsSL https://cli.devin.ai/install.sh | bash',
    // 公式の Windows（PowerShell）の手順（docs.devin.ai/cli、2026-10 確認）
    installWindows: 'powershell -NoProfile -Command "irm https://static.devin.ai/cli/setup.ps1 | iex"',
    homepageUrl: 'https://docs.devin.ai/work-with-devin/devin-cli',
    verified: true,
    popular: true
  },
  opencode: {
    label: 'OpenCode',
    detectCmd: 'opencode',
    aliases: ['opencode2'],
    yoloArgs: '--auto',
    install: 'curl -fsSL https://opencode.ai/install | bash',
    // 公式の Windows の手順のうち npm（opencode.ai/docs、2026-10 確認）
    installWindows: 'npm install -g opencode-ai',
    homepageUrl: 'https://opencode.ai/docs/',
    verified: true,
    popular: true
  },
  amp: {
    label: 'Amp',
    detectCmd: 'amp',
    yoloArgs: '',
    install: 'curl -fsSL https://ampcode.com/install.sh | bash',
    homepageUrl: 'https://ampcode.com/docs/cli',
    verified: false,
    popular: true
  },
  droid: {
    label: 'Droid',
    detectCmd: 'droid',
    yoloArgs: '',
    install: 'curl -fsSL https://app.factory.ai/cli | sh',
    // 公式の Windows（PowerShell）の手順（docs.factory.com/cli/getting-started/quickstart、2026-10 確認）
    installWindows: 'powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://app.factory.ai/cli/windows | iex"',
    homepageUrl: 'https://docs.factory.com/cli/getting-started/quickstart',
    verified: true,
    popular: true
  },
  kiro: {
    label: 'Kiro',
    detectCmd: 'kiro-cli',
    launchCmd: 'kiro-cli chat',
    yoloArgs: '--trust-all-tools',
    install: 'curl -fsSL https://cli.kiro.dev/install | bash',
    // 公式の Windows の手順（kiro.dev/docs/cli/installation、2026-10 確認）
    installWindows: 'powershell -NoProfile -ExecutionPolicy Bypass -Command "irm \'https://cli.kiro.dev/install.ps1\' | iex"',
    homepageUrl: 'https://kiro.dev/docs/cli/',
    verified: true,
    popular: true
  },
  aider: {
    label: 'Aider',
    detectCmd: 'aider',
    yoloArgs: '--yes-always',
    install: 'python -m pip install aider-install && aider-install',
    homepageUrl: 'https://aider.chat/docs/install.html',
    verified: true
  },
  // Gemini CLI の後継（Google の Agent）。agy 1.3.4 の --help と公式の資料で確かめた（2026-10）
  antigravity: {
    label: 'Antigravity',
    detectCmd: 'agy',
    yoloArgs: '--dangerously-skip-permissions',
    install: 'curl -fsSL https://antigravity.google/cli/install.sh | bash',
    // 公式の Windows CMD の手順（antigravity.google/docs/cli/install、2026-10 確認）
    installWindows: 'curl -fsSL https://antigravity.google/cli/install.cmd -o install.cmd && install.cmd && del install.cmd',
    homepageUrl: 'https://antigravity.google/docs/cli/install',
    verified: true,
    popular: true
  },
  ante: {
    label: 'Ante',
    detectCmd: 'ante',
    yoloArgs: '--yolo',
    install: 'curl -fsSL https://ante.run/install.sh | bash',
    homepageUrl: 'https://ante.run/start/quickstart/',
    verified: true
  },
  aug: {
    label: 'Auggie',
    detectCmd: 'auggie',
    yoloArgs: '',
    install: 'npm install -g @augmentcode/auggie',
    homepageUrl: 'https://docs.augmentcode.com/cli/overview',
    verified: true
  },
  autohand: {
    label: 'Autohand Code',
    detectCmd: 'autohand',
    aliases: ['autohand-code'],
    yoloArgs: '--unrestricted',
    install: 'curl -fsSL https://autohand.ai/install.sh | bash',
    homepageUrl: 'https://github.com/autohandai/code-cli',
    verified: true
  },
  blackbox: {
    label: 'BLACKBOX CLI',
    detectCmd: 'blackbox',
    yoloArgs: '',
    install: 'curl -fsSL https://blackbox.ai/install.sh | bash',
    homepageUrl: 'https://docs.blackbox.ai/features/blackbox-cli/getting-started',
    verified: true
  },
  cline: {
    label: 'Cline',
    detectCmd: 'cline',
    yoloArgs: '--auto-approve true',
    install: 'npm i -g cline',
    homepageUrl: 'https://docs.cline.bot/cline-cli/overview',
    verified: true
  },
  codebuddy: {
    label: 'CodeBuddy',
    detectCmd: 'codebuddy',
    aliases: ['cbc', 'codebuddy-code'],
    yoloArgs: '--dangerously-skip-permissions',
    install: 'npm install -g @tencent-ai/codebuddy-code',
    homepageUrl: 'https://www.codebuddy.ai/docs/cli/installation',
    verified: true
  },
  codebuff: {
    label: 'Codebuff',
    detectCmd: 'codebuff',
    yoloArgs: '',
    install: 'npm install -g codebuff',
    homepageUrl: 'https://www.codebuff.com/docs/help/quick-start',
    verified: true
  },
  'command-code': {
    label: 'Command Code',
    detectCmd: 'command-code',
    aliases: ['cmdc'],
    trustArgs: '--trust',
    yoloArgs: '--yolo',
    install: 'npm i -g command-code@latest',
    homepageUrl: 'https://commandcode.ai/docs/quickstart',
    verified: true
  },
  continue: {
    label: 'Continue',
    detectCmd: 'cn',
    yoloArgs: '--auto',
    install: 'npm i -g @continuedev/cli',
    homepageUrl: 'https://docs.continue.dev/cli/quickstart',
    verified: true
  },
  crush: {
    label: 'Charm (Crush)',
    detectCmd: 'crush',
    yoloArgs: '--yolo',
    install: 'brew install charmbracelet/tap/crush',
    // Linux は npm、Windows は winget（github.com/charmbracelet/crush、2026-10 確認）
    installLinux: 'npm install -g @charmland/crush',
    installWindows: 'winget install charmbracelet.crush',
    homepageUrl: 'https://github.com/charmbracelet/crush',
    verified: true
  },
  dsh: {
    label: 'DeepSeek Harness',
    // npm の @deepseek-ai/dsh の実行ファイルは dsh。端末の画面は dsh tui（launcher-help）。
    // Orca は旧名の dsh-tui / dst で検出している
    detectCmd: 'dsh',
    aliases: ['dsh-tui', 'dst'],
    launchCmd: 'dsh tui',
    yoloArgs: '',
    install: 'npm install -g @deepseek-ai/dsh',
    homepageUrl: 'https://deepseek-harness.github.io/deepseek-harness/',
    verified: true
  },
  forge: {
    label: 'ForgeCode',
    detectCmd: 'forge',
    yoloArgs: '',
    install: 'curl -fsSL https://forgecode.dev/cli | sh',
    homepageUrl: 'https://forgecode.dev/docs/',
    verified: true
  },
  freebuff: {
    label: 'Freebuff',
    detectCmd: 'freebuff',
    yoloArgs: '',
    install: 'npm install -g freebuff',
    homepageUrl: 'https://freebuff.com/cli',
    verified: true
  },
  goose: {
    label: 'Goose',
    detectCmd: 'goose',
    launchCmd: 'goose session',
    yoloArgs: '',
    install: 'curl -fsSL https://github.com/aaif-goose/goose/releases/download/stable/download_cli.sh | bash',
    homepageUrl: 'https://goose-docs.ai/docs/getting-started/installation/',
    verified: true
  },
  grok: {
    label: 'Grok',
    detectCmd: 'grok',
    yoloArgs: '--permission-mode bypassPermissions',
    install: 'curl -fsSL https://x.ai/cli/install.sh | bash',
    // 公式の Windows（PowerShell）のスクリプト（x.ai/cli/install.ps1、2026-10 確認）
    installWindows: 'powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://x.ai/cli/install.ps1 | iex"',
    homepageUrl: 'https://github.com/xai-org/grok-build',
    verified: true
  },
  // DeepSeek の公式の連携先（api-docs.deepseek.com/quick_start/agent_integrations/hermes）。hermes setup で DeepSeek を選ぶ。
  // v0.22.2 の --tui で、貼り付け→Enter の送信と ESC+CR・LF の改行を確かめた（2026-10）
  hermes: {
    label: 'Hermes Agent',
    detectCmd: 'hermes',
    launchCmd: 'hermes --tui',
    yoloArgs: '--yolo',
    install: 'curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash',
    homepageUrl: 'https://hermes-agent.nousresearch.com/docs/',
    verified: true,
    popular: true
  },
  junie: {
    label: 'Junie CLI',
    detectCmd: 'junie',
    yoloArgs: '--brave',
    install: 'curl -fsSL https://junie.jetbrains.com/install.sh | bash',
    // 公式の Windows の手順（junie.jetbrains.com/docs/junie-cli.html、2026-10 確認）
    installWindows: 'powershell -NoProfile -ExecutionPolicy Bypass -Command "iex (irm \'https://junie.jetbrains.com/install.ps1\')"',
    homepageUrl: 'https://junie.jetbrains.com/docs/junie-cli.html',
    verified: true
  },
  kilo: {
    label: 'Kilocode',
    detectCmd: 'kilo',
    yoloArgs: '--auto',
    install: 'npm install -g @kilocode/cli',
    homepageUrl: 'https://kilo.ai/docs/code-with-ai/platforms/cli',
    verified: true
  },
  kimi: {
    label: 'Kimi',
    detectCmd: 'kimi',
    yoloArgs: '--yolo',
    install: 'curl -fsSL https://code.kimi.com/kimi-code/install.sh | bash',
    // 公式の Windows（PowerShell）の手順（2026-10 確認）
    installWindows: 'powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://code.kimi.com/kimi-code/install.ps1 | iex"',
    homepageUrl: 'https://www.kimi.com/code/docs/en/kimi-code-cli/guides/getting-started',
    verified: true
  },
  letta: {
    label: 'Letta Code',
    detectCmd: 'letta',
    yoloArgs: '--yolo',
    install: 'npm install -g @letta-ai/letta-code',
    homepageUrl: 'https://github.com/letta-ai/letta-code',
    verified: true
  },
  'mimo-code': {
    label: 'MiMo Code',
    detectCmd: 'mimo',
    yoloArgs: '--dangerously-skip-permissions',
    install: 'curl -fsSL https://mimo.xiaomi.com/install | bash',
    homepageUrl: 'https://mimo.xiaomi.com/coder',
    verified: true
  },
  'mistral-vibe': {
    label: 'Mistral Vibe',
    detectCmd: 'vibe',
    aliases: ['mistral-vibe'],
    yoloArgs: '--auto-approve',
    install: 'curl -LsSf https://mistral.ai/vibe/install.sh | bash',
    homepageUrl: 'https://github.com/mistralai/mistral-vibe',
    verified: true
  },
  muse: {
    label: 'Muse',
    detectCmd: 'muse',
    trustArgs: '--trust-workspace',
    yoloArgs: '--yolo',
    install: 'curl -fsSL https://dev.meta.ai/install.sh | sh',
    homepageUrl: 'https://dev.meta.ai/docs/muse-code',
    verified: true
  },
  omp: {
    label: 'oh-my-pi',
    detectCmd: 'omp',
    yoloArgs: '--yolo',
    install: 'curl -fsSL https://omp.sh/install | sh',
    homepageUrl: 'https://omp.sh/docs',
    verified: true
  },
  openclaude: {
    label: 'OpenClaude',
    detectCmd: 'openclaude',
    yoloArgs: '',
    install: 'npm install -g @gitlawb/openclaude@latest',
    homepageUrl: 'https://openclaude.gitlawb.com/',
    verified: false
  },
  // DeepSeek のモデルで動かす Hermes Agent（DeepSeek の案内どおりの組み合わせ）。Hermes の既定のモデルに関係なく
  // DeepSeek を使うよう、起動のたびに --provider deepseek と DeepSeek の案内のモデルを渡す。キーは hermes setup で入れる DEEPSEEK_API_KEY
  deepseek: {
    label: 'DeepSeek',
    detectCmd: 'hermes',
    launchCmd: 'hermes --tui --provider deepseek -m deepseek-v4-pro',
    yoloArgs: '--yolo',
    install: 'curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash',
    homepageUrl: 'https://api-docs.deepseek.com/quick_start/agent_integrations/hermes',
    verified: true,
    popular: true
  },
  // DeepSeek の公式の連携先（api-docs.deepseek.com/quick_start/agent_integrations/openclaw）。openclaw onboard で DeepSeek を選ぶ。
  // 2026.10.4 の chat（Gateway 不要）で、貼り付け→Enter の送信と ESC+CR・LF の改行を確かめた（2026-10）。Node 24.16+ が要る
  openclaw: {
    label: 'OpenClaw',
    detectCmd: 'openclaw',
    launchCmd: 'openclaw chat',
    yoloArgs: '',
    install: 'curl -fsSL https://openclaw.ai/install.sh | bash',
    homepageUrl: 'https://docs.openclaw.ai/',
    verified: true,
    popular: true
  },
  openhands: {
    label: 'OpenHands CLI',
    detectCmd: 'openhands',
    yoloArgs: '--always-approve',
    install: 'uv tool install openhands --python 3.12',
    homepageUrl: 'https://docs.openhands.dev/openhands/usage/cli/installation',
    verified: true
  },
  pi: {
    label: 'Pi',
    detectCmd: 'pi',
    yoloArgs: '',
    install: 'curl -fsSL https://pi.dev/install.sh | sh',
    homepageUrl: 'https://pi.dev',
    verified: true
  },
  'prime-agent': {
    label: 'Prime Agent',
    detectCmd: 'prime-agent',
    yoloArgs: '',
    install: 'curl -fsSL https://app.primeintellect.ai/prime-agent/install.sh | sh',
    homepageUrl: 'https://github.com/PrimeIntellect-ai/prime-agent',
    verified: false
  },
  qoder: {
    label: 'Qoder CLI',
    detectCmd: 'qoder',
    aliases: ['qodercli'],
    yoloArgs: '--yolo',
    install: 'curl -fsSL https://qoder.com/install | bash',
    // 公式の Windows CMD の手順（qoder.com/cli、2026-10 確認）
    installWindows: 'curl -fsSL https://qoder.com/install.cmd -o install.cmd && install.cmd && del install.cmd',
    homepageUrl: 'https://docs.qoder.com/cli/installation',
    verified: true
  },
  'qwen-code': {
    label: 'Qwen Code',
    detectCmd: 'qwen',
    yoloArgs: '--yolo',
    install: 'npm install -g @qwen-code/qwen-code@latest',
    homepageUrl: 'https://github.com/QwenLM/qwen-code',
    verified: true
  },
  roo: {
    label: 'Roo Code CLI',
    detectCmd: 'roo',
    yoloArgs: '',
    install: 'curl -fsSL https://raw.githubusercontent.com/RooCodeInc/Roo-Code/main/apps/cli/install.sh | sh',
    homepageUrl: 'https://github.com/RooCodeInc/Roo-Code/tree/main/apps/cli',
    verified: true
  },
  rovo: {
    label: 'Rovo Dev',
    detectCmd: 'acli',
    launchCmd: 'acli rovodev run',
    yoloArgs: '--yolo',
    install: 'brew tap atlassian/homebrew-acli && brew install acli',
    homepageUrl: 'https://support.atlassian.com/rovo/docs/install-and-run-rovo-dev-cli-on-your-device/',
    verified: true
  },
  trae: {
    label: 'Trae CLI',
    detectCmd: 'traecli',
    yoloArgs: '--permission-mode bypass_permissions',
    install: 'sh -c "$(curl -fsSL https://trae.cn/trae-cli/install_v2.sh)"',
    homepageUrl: 'https://docs.trae.cn/cli_get-started-with-trae-code-cli-2',
    verified: true
  },
  zcode: {
    label: 'ZCode',
    detectCmd: 'zcode',
    yoloArgs: '',
    install: '',
    homepageUrl: 'https://zcode.z.ai/en/docs',
    verified: false
  }
}

/**
 * Orca の README「Supported Agents」に載っている順の id（2026-10 時点、+ any CLI agent はカスタムで対応）。
 * Orca由来: ~/bench/orca/README.md（MIT, Copyright 2026 Lovecast Inc.）
 */
export const ORCA_SUPPORTED_AGENTS: readonly BuiltinAgent[] = [
  'claude', 'codex', 'grok', 'cursor', 'copilot', 'muse',
  'dsh', 'zcode', 'opencode', 'mimo-code', 'amp', 'openclaude',
  'antigravity', 'pi', 'omp', 'hermes', 'devin', 'goose',
  'aug', 'autohand', 'crush', 'cline', 'codebuddy', 'codebuff',
  'freebuff', 'command-code', 'continue', 'droid', 'kilo', 'kimi',
  'kiro', 'mistral-vibe', 'qwen-code', 'rovo'
]

export const TUI_AGENT_LABEL: Record<BuiltinAgent, string> = Object.fromEntries(
  BUILTIN_AGENTS.map((agent) => [agent, AGENT_CATALOG[agent].label])
) as Record<BuiltinAgent, string>

/**
 * 既定で起動の引数に入れるもの（設定の Launch で消せる）。
 * Claude Code の --chrome は Claude in Chrome の連携を使えるようにする（`claude --help`、2.1.289 で確認）
 */
const DEFAULT_LAUNCH_ARGS: Partial<Record<BuiltinAgent, string>> = { claude: '--chrome' }

/** 既定の起動。権限確認を省く引数は、ここではなく起動のとき（resolveAgentLaunchPolicy）に skipPermissions を見て付ける */
export function defaultLaunchConfig(agent: BuiltinAgent): AgentLaunchConfig {
  const entry = AGENT_CATALOG[agent]
  return { command: entry.launchCmd ?? entry.detectCmd, args: DEFAULT_LAUNCH_ARGS[agent] ?? '' }
}

/** 既定の設定。権限確認を省いて起動する（利用者が設定で切れる） */
export const DEFAULT_AGENT_PREFERENCES: AgentPreferences = {
  launch: Object.fromEntries(BUILTIN_AGENTS.map((agent) => [agent, defaultLaunchConfig(agent)])) as Record<
    BuiltinAgent,
    AgentLaunchConfig
  >,
  customAgents: [],
  disabledAgents: [],
  startupAgents: ['claude', 'codex'],
  skipPermissions: true,
  notify: false,
  restoreTerminals: true,
  windowsShell: 'powershell',
  agentMail: true
}

// ───────────────────────── 権限確認を省く引数 ─────────────────────────

/**
 * skipPermissions で権限確認を省く引数を付ける Agent。フラグを `--help` で確かめたものだけ
 * （Claude Code 2.1.289 の --dangerously-skip-permissions、Codex 0.160.0 の --dangerously-bypass-approvals-and-sandbox。2026-10 確認）
 */
export const SKIP_PERMISSION_AGENTS: readonly BuiltinAgent[] = ['claude', 'codex']

/**
 * yoloArgs のほかに、同じ意味になる既知の書き方（Claude Code / Codex の公式の資料、2026-10 確認）。
 * 1要素が1つの単位（フラグと、その値）。`--flag=value` の形も同じとみなす
 */
const EXTRA_BYPASS_UNITS: Partial<Record<BuiltinAgent, readonly string[]>> = {
  claude: ['--dangerously-skip-permissions', '--allow-dangerously-skip-permissions', '--permission-mode bypassPermissions'],
  codex: ['--dangerously-bypass-approvals-and-sandbox', '--yolo', '--sandbox danger-full-access', '-s danger-full-access',
    '--ask-for-approval never', '-a never', '-c sandbox_mode=danger-full-access', '-c approval_policy=never']
}

/**
 * 利用者が確認の仕方を自分で選んだ印のフラグ。引数にあれば、権限確認を省く引数を足さない
 * （Codex は --sandbox などと --dangerously-bypass-approvals-and-sandbox を一緒に渡せない）
 */
const MODE_FLAGS: Partial<Record<BuiltinAgent, readonly string[]>> = {
  claude: ['--permission-mode'],
  codex: ['--sandbox', '-s', '--ask-for-approval', '-a', '--full-auto', '--approve-for-me']
}

/** 引数の並びを単位に分ける（フラグと、そのあとに続くフラグでない値） */
function argUnits(args: string): string[][] {
  const units: string[][] = []
  for (const token of args.trim().split(/\s+/).filter(Boolean)) {
    const last = units[units.length - 1]
    if (token.startsWith('-') || !last) units.push([token])
    else last.push(token)
  }
  return units
}

/** その Agent の、権限確認を省く引数の単位（小文字にそろえない。フラグは大文字小文字を区別する） */
export function bypassArgUnits(agent: BuiltinAgent): string[][] {
  return [...argUnits(AGENT_CATALOG[agent].yoloArgs), ...(EXTRA_BYPASS_UNITS[agent] ?? []).flatMap(argUnits)]
}

/** 名前に関係なく、どの Agent でも権限確認を省く引数とみなすフラグの頭 */
export const BYPASS_FLAG_PREFIXES: readonly string[] = ['--dangerously-', '--allow-dangerously-']

/** その Agent の、フォルダを信頼して開く引数の単位 */
export function trustArgUnits(agent: BuiltinAgent): string[][] {
  return argUnits(AGENT_CATALOG[agent].trustArgs ?? '')
}

/** その Agent の、確認の仕方を選ぶフラグ（引数にあれば、権限確認を省く引数を足さない） */
export function permissionModeFlags(agent: BuiltinAgent): readonly string[] {
  return MODE_FLAGS[agent] ?? []
}

/**
 * 以前の版の既定の起動コマンド（フォルダの信頼の引数をコマンドの欄に入れていた）。
 * 保存された設定がこれのままなら、今の既定に戻す（security-5 [2]）
 */
const LEGACY_LAUNCH_COMMANDS: Partial<Record<BuiltinAgent, readonly string[]>> = {
  'command-code': ['command-code --trust'],
  muse: ['muse --trust-workspace']
}

export function isBuiltinAgent(value: unknown): value is BuiltinAgent {
  return typeof value === 'string' && Object.hasOwn(AGENT_CATALOG, value)
}

function isCustomAgentId(value: unknown): value is CustomAgentId {
  return typeof value === 'string' && /^custom:[a-z0-9][a-z0-9-]{0,47}$/.test(value)
}

export function isAccountAgent(value: unknown): value is AccountAgent {
  return value === 'claude' || value === 'codex'
}

export function findCustomAgent(prefs: Pick<AgentPreferences, 'customAgents'> | null | undefined, id: TuiAgent): CustomAgent | undefined {
  // 古い形の設定（customAgents が無い）でも落ちないようにする
  return Array.isArray(prefs?.customAgents) ? prefs.customAgents.find((custom) => custom?.id === id) : undefined
}

/**
 * 表示名。カスタムは登録した名前、見つからなければ id の後半。
 * 設定の読み込み途中などで id が文字列でないときも落ちず、空文字を返す
 */
export function agentLabel(agent: TuiAgent | null | undefined, prefs?: Pick<AgentPreferences, 'customAgents'> | null): string {
  if (typeof agent !== 'string') return ''
  if (isBuiltinAgent(agent)) return TUI_AGENT_LABEL[agent]
  const name = findCustomAgent(prefs, agent)?.name
  return (typeof name === 'string' && name.trim()) || (agent.startsWith('custom:') ? agent.slice('custom:'.length) : agent)
}

/** 名前からカスタムエージェントの id を作る。重なれば -2, -3… を付ける */
export function newCustomAgentId(name: string, existing: readonly string[]): CustomAgentId {
  const base =
    name
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'agent'
  let id = `custom:${base}` as CustomAgentId
  for (let n = 2; existing.includes(id); n++) id = `custom:${base}-${n}` as CustomAgentId
  return id
}

/** コマンド文字列の先頭語（`npx -y foo` なら npx、`FOO=1 bar` なら bar） */
export function firstCommandWord(command: string): string {
  const words = command.trim().split(/\s+/).filter((word) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(word))
  return words[0]?.replace(/^["']|["']$/g, '') ?? ''
}

/** PATH で探すコマンド。カスタムはコマンドの先頭語 */
export function detectCommandsFor(agent: TuiAgent, prefs: Pick<AgentPreferences, 'customAgents'>): string[] {
  if (isBuiltinAgent(agent)) {
    const entry = AGENT_CATALOG[agent]
    return [entry.detectCmd, ...(entry.aliases ?? [])]
  }
  const custom = findCustomAgent(prefs, agent)
  const word = custom ? firstCommandWord(custom.command) : ''
  return word ? [word] : []
}

// ───────────────────────── 前面プロセスからエージェントを同定する ─────────────────────────

const PROCESS_EXTENSION_RE = /\.(?:exe|cmd|bat|ps1)$/i
const SCRIPT_EXTENSION_RE = /\.(?:js|mjs|cjs|py|pyw)$/i
/** node / python などで動くCLIは、前面プロセス名が実行系になる。その次の引数（スクリプト）を見る */
const WRAPPER_PROCESSES = new Set(['node', 'bun', 'deno', 'python', 'python3'])
/**
 * スクリプト名だけでは決められない（index.js など）ものは、インストール先のパスで決める
 * （Orca の NODE_PACKAGE_SCRIPT_ENTRYPOINTS / EXACT_NODE_ENTRYPOINT_IDENTITIES から本システムの対象だけ）
 */
const PACKAGE_PATH_IDENTITIES: ReadonlyArray<{ pattern: RegExp; agent: BuiltinAgent }> = [
  { pattern: /node_modules\/@openai\/codex\//, agent: 'codex' },
  // npm 版の Claude Code。macOS / Linux は process.title で claude に見えるが、Windows のコマンド行は node.exe …\cli.js のまま
  { pattern: /node_modules\/@anthropic-ai\/claude-code\//, agent: 'claude' },
  { pattern: /node_modules\/@google\/gemini-cli\//, agent: 'gemini' },
  { pattern: /(?:^|\/)cursor-agent\/versions\/[^/]+\/index\.js$/, agent: 'cursor' },
  // 公式インストーラの Claude Code は ~/.local/share/claude/versions/<版> の実体を claude のリンクから動かす
  { pattern: /(?:^|\/)claude\/versions\/[^/]+$/, agent: 'claude' }
]

/**
 * 版番号だけの実行ファイル名（公式インストーラの Claude Code は前面プロセス名が「2.1.288」になる）。
 * 名前では決められないので、呼び出し側はコマンド行（ps の args）で判定し直す
 */
export function isVersionProcessName(name: string): boolean {
  return /^\d+\.\d+\.\d+(?:[-+.][\w.-]*)?$/.test(normalizeProcessName(name))
}

function normalizeProcessName(token: string | undefined, stripScript = false): string {
  if (!token) return ''
  const unquoted = token.trim().replace(/^["']|["']$/g, '')
  const base = (unquoted.split(/[\\/]/).pop() ?? unquoted).toLowerCase().replace(PROCESS_EXTENSION_RE, '')
  return stripScript ? base.replace(SCRIPT_EXTENSION_RE, '') : base
}

function processTable(prefs: Pick<AgentPreferences, 'customAgents'>): Map<string, TuiAgent> {
  const table = new Map<string, TuiAgent>()
  for (const agent of BUILTIN_AGENTS) {
    const entry = AGENT_CATALOG[agent]
    for (const name of [entry.detectCmd, ...(entry.aliases ?? []), firstCommandWord(entry.launchCmd ?? '')]) {
      const normalized = normalizeProcessName(name)
      if (normalized && !table.has(normalized)) table.set(normalized, agent)
    }
  }
  for (const custom of Array.isArray(prefs.customAgents) ? prefs.customAgents : []) {
    const normalized = normalizeProcessName(custom.processName?.trim() || firstCommandWord(custom.command))
    // 実行系（npx や node）だけでは同定できないので登録しない
    if (normalized && !WRAPPER_PROCESSES.has(normalized) && normalized !== 'npx' && !table.has(normalized)) {
      table.set(normalized, custom.id)
    }
  }
  return table
}

function agentForName(normalized: string, table: Map<string, TuiAgent>): TuiAgent | null {
  const exact = table.get(normalized)
  if (exact) return exact
  // Codex は codex-aarch64-apple-darwin のような名前で動くことがある（Orca の注記）。grok も同様
  if (normalized.startsWith('codex-')) return 'codex'
  if (normalized.startsWith('grok-')) return 'grok'
  return null
}

/**
 * プロセス名またはコマンド行から、どのエージェントかを返す。分からなければ null。
 * `node /opt/homebrew/bin/gemini` のように実行系が前に来る形も見る。
 */
export function agentForProcess(commandLine: string, prefs: Pick<AgentPreferences, 'customAgents'> = { customAgents: [] }): TuiAgent | null {
  const tokens = commandLine.trim().split(/\s+/).filter(Boolean)
  if (tokens.length === 0) return null
  const table = processTable(prefs)
  const head = normalizeProcessName(tokens[0])
  const direct = agentForName(head, table)
  if (direct) return direct
  const first = tokens[0]!.replace(/^["']|["']$/g, '').replace(/\\/g, '/')
  for (const identity of PACKAGE_PATH_IDENTITIES) if (identity.pattern.test(first)) return identity.agent
  if (!WRAPPER_PROCESSES.has(head)) return null
  const rest = tokens.slice(1).filter((token) => !token.startsWith('-'))
  // python -m aider
  const moduleIndex = tokens.indexOf('-m')
  if (moduleIndex > 0 && tokens[moduleIndex + 1]) {
    const moduleAgent = agentForName(tokens[moduleIndex + 1]!.split('.')[0]!.toLowerCase(), table)
    if (moduleAgent) return moduleAgent
  }
  const script = rest[0]
  if (!script) return null
  const path = script.replace(/\\/g, '/')
  for (const identity of PACKAGE_PATH_IDENTITIES) if (identity.pattern.test(path)) return identity.agent
  return agentForName(normalizeProcessName(script, true), table)
}

// ───────────────────────── 設定の読み込み ─────────────────────────

const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '')
/** 新しい版で増えるかもしれない組み込みのエージェントの id の形（小文字・数字・ハイフン） */
const FUTURE_AGENT_ID = /^[a-z0-9][a-z0-9-]{0,47}$/

/**
 * 保存された設定を型どおりに直す。壊れた値は既定へ戻し、以前の形（claude / codex だけの launch）もそのまま引き継ぐ。
 * 登録の無いカスタムや知らない id は、startupAgents / disabledAgents から外す。
 * id のあるカスタムは書きかけでも残す（id が無く、名前かコマンドが空のものだけ捨てる）。
 */
export function sanitizeAgentPreferences(raw: unknown): AgentPreferences {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const rawLaunch = (r.launch && typeof r.launch === 'object' ? r.launch : {}) as Record<string, unknown>
  const launch = { ...DEFAULT_AGENT_PREFERENCES.launch }
  // 新しい版の設定に、この版が知らないエージェントの起動コマンドがあっても捨てずに持っておく（古い版に戻しても失わない）。
  // 使うのは BUILTIN_AGENTS にあるものだけなので、知らないものは起動にもメニューにも出ない
  for (const [agent, value] of Object.entries(rawLaunch)) {
    const c = value as Partial<AgentLaunchConfig> | undefined
    if (!isBuiltinAgent(agent) && FUTURE_AGENT_ID.test(agent) && c && text(c.command)) {
      ;(launch as Record<string, AgentLaunchConfig>)[agent] = { command: text(c.command), args: text(c.args) }
    }
  }
  for (const agent of BUILTIN_AGENTS) {
    const c = rawLaunch[agent] as Partial<AgentLaunchConfig> | undefined
    // 空白だけのコマンドも未設定とみなして既定に戻す。引数は利用者が書いたまま
    if (c && text(c.command)) launch[agent] = { command: text(c.command), args: text(c.args) }
    // 以前の既定のコマンド（信頼の引数入り）は今の既定へ。信頼は起動の決まりが skipPermissions を見て付ける
    if (LEGACY_LAUNCH_COMMANDS[agent]?.includes(launch[agent].command)) launch[agent] = { ...launch[agent], command: defaultLaunchConfig(agent).command }
  }
  // skipPermissions の無い以前の設定は、引数が以前の既定（空）のままなら今の既定（Claude Code の --chrome）にする
  const skipPermissions = typeof r.skipPermissions === 'boolean' ? r.skipPermissions : DEFAULT_AGENT_PREFERENCES.skipPermissions
  if (typeof r.skipPermissions !== 'boolean') {
    for (const agent of BUILTIN_AGENTS) {
      const fallback = DEFAULT_AGENT_PREFERENCES.launch[agent]
      if (launch[agent].command === fallback.command && launch[agent].args === '') launch[agent] = { ...fallback }
    }
  }

  const customAgents: CustomAgent[] = []
  for (const item of Array.isArray(r.customAgents) ? r.customAgents : []) {
    if (!item || typeof item !== 'object') continue
    const c = item as Partial<CustomAgent>
    const name = text(c.name)
    const command = text(c.command)
    // 設定画面は入力のたびに保存するので、書きかけ（名前やコマンドが空）でも id があれば残す。
    // 使えるかどうか（コマンドが空なら起動できない）はメニュー側で見る
    if (!isCustomAgentId(c.id) && (!name || !command)) continue
    const ids = customAgents.map((agent) => agent.id)
    const id = isCustomAgentId(c.id) && !ids.includes(c.id) ? c.id : newCustomAgentId(name, ids)
    const processName = text(c.processName)
    // アイコンの文字は2文字まで（絵文字などの合字も1文字として数える）
    const icon = [...text(c.icon)].slice(0, 2).join('')
    customAgents.push({ id, name, command, args: text(c.args), ...(processName ? { processName } : {}), ...(icon ? { icon } : {}) })
  }

  const known = (value: unknown): value is TuiAgent =>
    isBuiltinAgent(value) || customAgents.some((custom) => custom.id === value)
  const list = (value: unknown, fallback: readonly TuiAgent[]): TuiAgent[] =>
    Array.isArray(value) ? [...new Set(value.filter(known))] : [...fallback]

  // 書きかけ（コマンドが空）のカスタムは起動できないので、起動時に開く一覧には入れない
  const launchable = (agent: TuiAgent): boolean => isBuiltinAgent(agent) || Boolean(findCustomAgent({ customAgents }, agent)?.command)
  // 無効の一覧は、知らない id（新しい版のエージェント）も残してよい（何も起動しない・何にも当たらない）
  const disabledAgents = Array.isArray(r.disabledAgents)
    ? [...new Set(r.disabledAgents.filter((value): value is TuiAgent => known(value) || (typeof value === 'string' && FUTURE_AGENT_ID.test(value))))]
    : [...DEFAULT_AGENT_PREFERENCES.disabledAgents]
  return {
    launch,
    customAgents,
    disabledAgents,
    startupAgents: list(r.startupAgents, DEFAULT_AGENT_PREFERENCES.startupAgents).filter(launchable),
    skipPermissions,
    notify: typeof r.notify === 'boolean' ? r.notify : DEFAULT_AGENT_PREFERENCES.notify,
    restoreTerminals: typeof r.restoreTerminals === 'boolean' ? r.restoreTerminals : DEFAULT_AGENT_PREFERENCES.restoreTerminals,
    windowsShell: r.windowsShell === 'cmd' || r.windowsShell === 'powershell' ? r.windowsShell : DEFAULT_AGENT_PREFERENCES.windowsShell,
    agentMail: typeof r.agentMail === 'boolean' ? r.agentMail : DEFAULT_AGENT_PREFERENCES.agentMail
  }
}
