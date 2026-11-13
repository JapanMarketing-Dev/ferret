import type { PlatformName } from './types'

/**
 * よく使うサービスの CLI（Git のホスティング・デプロイ先・クラウド・データベース・エラー監視・決済・コンテナ・
 * モバイル・仮想マシン・AI）の一覧と、OS ごとのインストール・ログインのコマンド
 * （main・renderer・単体テストで共有する純粋なデータと関数）。
 *
 * 設定の「よく使うサービスの CLI」の一覧と、判定モデル・文字起こし・整理の「Agent に設定を頼む」から使う。
 * どれも入れるのは任意（Ferret 自体はどれが無くても動く）。入っていないものは警告ではなく「未インストール」と出す。
 * ボタンを押すと内蔵ターミナルの新しいタブでこの表のコマンドをそのまま走らせる。
 * 画面や外部から受け取った文字をコマンドに混ぜない（引数はすべてこの表の固定の文字列。シェル注入にならない）。
 *
 * コマンドは各公式ドキュメント（homepageUrl）の手順。公式が1行の手順を出していない OS や、確かめられない OS は省く
 * （その OS ではコマンドを出さず、公式ページへのリンクだけにする。推測のコマンドは書かない）。
 * Windows の内蔵ターミナルは cmd.exe なので、PowerShell の手順は powershell -Command で包む。
 */

export type CliToolId =
  | 'gh'
  | 'glab'
  | 'vercel'
  | 'netlify'
  | 'wrangler'
  | 'firebase'
  | 'flyctl'
  | 'railway'
  | 'heroku'
  | 'aws'
  | 'gcloud'
  | 'az'
  | 'supabase'
  | 'neonctl'
  | 'pscale'
  | 'turso'
  | 'sentry'
  | 'datadog'
  | 'stripe'
  | 'docker'
  | 'kubectl'
  | 'xcode'
  | 'adb'
  | 'eas'
  | 'fastlane'
  | 'utm'
  | 'lima'
  | 'multipass'
  | 'ollama'

/** 種類（一覧の見出し）。並びは CLI_TOOL_CATEGORIES */
export type CliToolCategory = 'git' | 'deploy' | 'cloud' | 'database' | 'monitoring' | 'payments' | 'containers' | 'mobile' | 'vm' | 'ai'

/** 見出しの順 */
export const CLI_TOOL_CATEGORIES: readonly CliToolCategory[] = [
  'git', 'deploy', 'cloud', 'database', 'monitoring', 'payments', 'containers', 'mobile', 'vm', 'ai'
]

export type CliToolOs = 'darwin' | 'linux' | 'win32'

interface CliToolEntry {
  label: string
  category: CliToolCategory
  /** PATH 上にあればインストール済みとみなすコマンド（名前）。決まった場所に入るアプリは絶対パス */
  detectCmd: string
  /** 画面に出すコマンド名（detectCmd が絶対パスのとき） */
  displayCmd?: string
  /** 同じ CLI の別名・別の置き場（fly など） */
  aliases?: readonly string[]
  /**
   * 版を出す引数。出力の最初の版らしい数字を読む。無ければ走らせない
   * （utmctl は UTM への Apple Events で OS の許可を求めることがあり、xcrun は未インストールだと OS のダイアログを出すので走らせない）
   */
  versionArg?: string | readonly string[]
  /** OS ごとの公式の入れ方（1行）。無い OS は公式ページへのリンクだけ */
  install: Partial<Record<CliToolOs, string>>
  /** ログイン（ブラウザで認証する対話のコマンド）。要らないものは無し */
  login?: string
  /** PATH に入っていないことがある公式のインストール先（ホームからの相対） */
  homeBinDirs?: readonly string[]
  /** 使える OS（無ければ全部）。ほかの OS では検出せず「macOS のみ」などと出す */
  platforms?: readonly CliToolOs[]
  /** サービスのサイト（どんなサービスかを見る。一覧のリンク） */
  siteUrl: string
  /** 公式の入れ方のページ（1行の手順が無い OS で開く） */
  homepageUrl: string
}

const npm = (pkg: string) => `npm install -g ${pkg}`
/** cmd.exe から PowerShell の1行を走らせる（公式の手順が PowerShell のもの） */
const powershell = (script: string) => `powershell -NoProfile -ExecutionPolicy Bypass -Command "${script}"`
const allOs = (command: string) => ({ darwin: command, linux: command, win32: command })
/**
 * Linux は利用者のシェル（fish のこともある）に関係なく動くよう bash -c で包み、入っているパッケージ管理で分ける。
 * 中身は単一引用符で包むので、中に単一引用符を書かない（括弧などは \ でエスケープする）
 */
const bashBranches = (branches: ReadonlyArray<readonly [test: string, command: string]>, fallback: string) =>
  `bash -c '${branches.map(([test, command], i) => `${i === 0 ? 'if' : 'elif'} ${test}; then ${command}`).join('; ')}; else ${fallback}; fi'`
const has = (bin: string) => `type -p ${bin} >/dev/null`
const seeDocs = (url: string) => `echo "See ${url}" && false`

/**
 * gh の Linux（github.com/cli/cli/blob/trunk/docs/install_linux.md、2026-10 確認）。
 * Homebrew があればそれ、無ければ公式の apt の手順・dnf（dnf5 と dnf4 の両方）の手順
 */
const GH_LINUX = bashBranches([
  [has('brew'), 'brew install gh'],
  [has('apt'), '(type -p wget >/dev/null || (sudo apt update && sudo apt install wget -y))'
    + ' && sudo mkdir -p -m 755 /etc/apt/keyrings'
    + ' && out=$(mktemp) && wget -nv -O$out https://cli.github.com/packages/githubcli-archive-keyring.gpg'
    + ' && cat $out | sudo tee /etc/apt/keyrings/githubcli-archive-keyring.gpg > /dev/null'
    + ' && sudo chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg'
    + ' && sudo mkdir -p -m 755 /etc/apt/sources.list.d'
    + ' && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main"'
    + ' | sudo tee /etc/apt/sources.list.d/github-cli.list > /dev/null'
    + ' && sudo apt update && sudo apt install gh -y'],
  [has('dnf'), '(sudo dnf install -y dnf5-plugins && sudo dnf config-manager addrepo --from-repofile=https://cli.github.com/packages/rpm/gh-cli.repo'
    + ' || (sudo dnf install -y dnf-command\\(config-manager\\) && sudo dnf config-manager --add-repo https://cli.github.com/packages/rpm/gh-cli.repo))'
    + ' && sudo dnf install -y gh']
], seeDocs('https://github.com/cli/cli/blob/trunk/docs/install_linux.md'))

/**
 * glab の Linux（gitlab.com/gitlab-org/cli/-/blob/main/docs/installation_options.md、2026-10 確認）。
 * 公式に支えるのは Homebrew。無ければ同じページに載る snap・dnf・pacman
 */
const GLAB_LINUX = bashBranches([
  [has('brew'), 'brew install glab'],
  [has('snap'), 'sudo snap install glab'],
  [has('dnf'), 'sudo dnf install -y glab'],
  [has('pacman'), 'sudo pacman -S --noconfirm glab']
], seeDocs('https://gitlab.com/gitlab-org/cli/-/releases'))

/** kubectl の Linux（kubernetes.io/docs/tasks/tools/install-kubectl-linux。Homebrew か snap。無ければページ） */
const KUBECTL_LINUX = bashBranches([
  [has('brew'), 'brew install kubectl'],
  [has('snap'), 'sudo snap install kubectl --classic']
], seeDocs('https://kubernetes.io/docs/tasks/tools/install-kubectl-linux/'))

/** adb の Linux（ディストリビューションのパッケージ。Debian / Ubuntu は adb、Fedora・Arch は android-tools） */
const ADB_LINUX = bashBranches([
  [has('apt'), 'sudo apt install -y adb'],
  [has('dnf'), 'sudo dnf install -y android-tools'],
  [has('pacman'), 'sudo pacman -S --noconfirm android-tools']
], seeDocs('https://developer.android.com/tools/releases/platform-tools'))

/** Lima の Linux（lima-vm.io/docs/installation。1行の公式の手順は Homebrew だけ） */
const LIMA_LINUX = bashBranches([[has('brew'), 'brew install lima']], seeDocs('https://lima-vm.io/docs/installation/'))

/** 一覧の順（種類ごと、よく使うものを先に） */
export const CLI_TOOL_IDS: readonly CliToolId[] = [
  'gh', 'glab',
  'vercel', 'netlify', 'wrangler', 'firebase', 'flyctl', 'railway', 'heroku',
  'aws', 'gcloud', 'az',
  'supabase', 'neonctl', 'pscale', 'turso',
  'sentry', 'datadog',
  'stripe',
  'docker', 'kubectl',
  'xcode', 'adb', 'eas', 'fastlane',
  'utm', 'lima', 'multipass',
  'ollama'
]

export const CLI_TOOLS: Record<CliToolId, CliToolEntry> = {
  // ── Git のホスティング ──
  gh: {
    label: 'GitHub CLI', category: 'git', detectCmd: 'gh', versionArg: '--version',
    // github.com/cli/cli#installation
    install: { darwin: 'brew install gh', linux: GH_LINUX, win32: 'winget install --id GitHub.cli -e' },
    login: 'gh auth login --web -h github.com',
    siteUrl: 'https://cli.github.com/',
    homepageUrl: 'https://github.com/cli/cli#installation'
  },
  glab: {
    label: 'GitLab CLI', category: 'git', detectCmd: 'glab', versionArg: 'version',
    // gitlab.com/gitlab-org/cli（Homebrew が公式に支える入れ方。Windows は winget）
    install: { darwin: 'brew install glab', linux: GLAB_LINUX, win32: 'winget install --id glab.glab -e' },
    login: 'glab auth login',
    siteUrl: 'https://gitlab.com/gitlab-org/cli',
    homepageUrl: 'https://gitlab.com/gitlab-org/cli#installation'
  },

  // ── ホスティング・デプロイ ──
  vercel: {
    label: 'Vercel CLI', category: 'deploy', detectCmd: 'vercel', versionArg: '--version',
    install: allOs(npm('vercel')), login: 'vercel login',
    siteUrl: 'https://vercel.com/', homepageUrl: 'https://vercel.com/docs/cli'
  },
  netlify: {
    label: 'Netlify CLI', category: 'deploy', detectCmd: 'netlify', versionArg: '--version',
    install: allOs(npm('netlify-cli')), login: 'netlify login',
    siteUrl: 'https://www.netlify.com/',
    homepageUrl: 'https://docs.netlify.com/api-and-cli-guides/cli-guides/get-started-with-cli/'
  },
  wrangler: {
    // Cloudflare Workers・Pages（エッジのホスティング）。Workers AI の Account ID を調べるのにも使う
    label: 'Cloudflare Wrangler', category: 'deploy', detectCmd: 'wrangler', versionArg: '--version',
    // npm のパッケージ（Cloudflare の資料はプロジェクトごとの導入を勧めるが、Account ID を調べる・ログインする用途には全体に入れる）
    install: allOs(npm('wrangler')),
    login: 'wrangler login',
    siteUrl: 'https://workers.cloudflare.com/',
    homepageUrl: 'https://developers.cloudflare.com/workers/wrangler/install-and-update/'
  },
  firebase: {
    label: 'Firebase CLI', category: 'deploy', detectCmd: 'firebase', versionArg: '--version',
    install: allOs(npm('firebase-tools')), login: 'firebase login',
    siteUrl: 'https://firebase.google.com/', homepageUrl: 'https://firebase.google.com/docs/cli'
  },
  flyctl: {
    label: 'Fly.io (flyctl)', category: 'deploy', detectCmd: 'flyctl', aliases: ['fly'], versionArg: 'version',
    // fly.io/docs/flyctl/install（スクリプトは ~/.fly/bin に入れる）
    install: {
      darwin: 'curl -L https://fly.io/install.sh | sh',
      linux: 'curl -L https://fly.io/install.sh | sh',
      win32: powershell('iwr https://fly.io/install.ps1 -useb | iex')
    },
    login: 'flyctl auth login',
    homeBinDirs: ['.fly/bin'],
    siteUrl: 'https://fly.io/',
    homepageUrl: 'https://fly.io/docs/flyctl/install/'
  },
  railway: {
    label: 'Railway CLI', category: 'deploy', detectCmd: 'railway', versionArg: '--version',
    install: allOs(npm('@railway/cli')), login: 'railway login',
    siteUrl: 'https://railway.com/', homepageUrl: 'https://docs.railway.com/guides/cli'
  },
  heroku: {
    label: 'Heroku CLI', category: 'deploy', detectCmd: 'heroku', versionArg: '--version',
    // devcenter.heroku.com/articles/heroku-cli（Windows は公式が支える npm）
    install: {
      darwin: 'brew install heroku/brew/heroku',
      linux: 'curl https://cli-assets.heroku.com/install.sh | sh',
      win32: npm('heroku')
    },
    login: 'heroku login',
    siteUrl: 'https://www.heroku.com/',
    homepageUrl: 'https://devcenter.heroku.com/articles/heroku-cli'
  },

  // ── クラウド ──
  aws: {
    label: 'AWS CLI', category: 'cloud', detectCmd: 'aws', versionArg: '--version',
    // docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html（公式が勧めるインストールスクリプト）
    install: {
      darwin: 'curl -fsSL https://awscli.amazonaws.com/v2/install.sh | bash',
      linux: 'curl -fsSL https://awscli.amazonaws.com/v2/install.sh | bash',
      win32: powershell('irm https://awscli.amazonaws.com/v2/install.ps1 | iex')
    },
    // コンソールの資格情報でログインする（AWS CLI 2.32 以降）
    login: 'aws login',
    siteUrl: 'https://aws.amazon.com/cli/',
    homepageUrl: 'https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html'
  },
  gcloud: {
    label: 'Google Cloud CLI', category: 'cloud', detectCmd: 'gcloud', versionArg: '--version',
    // docs.cloud.google.com/sdk/docs/downloads-interactive（Windows は公式のインストーラを落として開く）
    install: {
      darwin: 'curl https://sdk.cloud.google.com | bash',
      linux: 'curl https://sdk.cloud.google.com | bash',
      win32: powershell("$f = Join-Path $env:Temp 'GoogleCloudSDKInstaller.exe'; (New-Object Net.WebClient).DownloadFile('https://dl.google.com/dl/cloudsdk/channels/rapid/GoogleCloudSDKInstaller.exe', $f); & $f")
    },
    login: 'gcloud auth login',
    homeBinDirs: ['google-cloud-sdk/bin'],
    siteUrl: 'https://cloud.google.com/cli',
    homepageUrl: 'https://cloud.google.com/sdk/docs/install'
  },
  az: {
    label: 'Azure CLI', category: 'cloud', detectCmd: 'az', versionArg: '--version',
    // learn.microsoft.com/cli/azure/install-azure-cli（Linux の1行は Debian / Ubuntu 向け）
    install: {
      darwin: 'brew install azure-cli',
      linux: "curl -fsSL 'https://azurecliprod.blob.core.windows.net/$root/deb_install.sh' | sudo bash",
      win32: 'winget install --exact --id Microsoft.AzureCLI'
    },
    login: 'az login',
    siteUrl: 'https://azure.microsoft.com/',
    homepageUrl: 'https://learn.microsoft.com/en-us/cli/azure/install-azure-cli'
  },

  // ── データベース・バックエンド ──
  supabase: {
    label: 'Supabase CLI', category: 'database', detectCmd: 'supabase', versionArg: '--version',
    // supabase.com/docs/guides/local-development/cli/getting-started（Windows は Scoop）
    install: {
      darwin: 'brew install supabase/tap/supabase',
      linux: 'brew install supabase/tap/supabase',
      win32: 'scoop bucket add supabase https://github.com/supabase/scoop-bucket.git && scoop install supabase'
    },
    login: 'supabase login',
    siteUrl: 'https://supabase.com/',
    homepageUrl: 'https://supabase.com/docs/guides/local-development/cli/getting-started'
  },
  neonctl: {
    label: 'Neon CLI', category: 'database', detectCmd: 'neonctl', versionArg: '--version',
    // neon.com/docs/reference/neon-cli（npm の neonctl。ブラウザで認証するのは neonctl auth）
    install: allOs(npm('neonctl')),
    login: 'neonctl auth',
    siteUrl: 'https://neon.com/',
    homepageUrl: 'https://neon.com/docs/reference/neon-cli'
  },
  pscale: {
    label: 'PlanetScale CLI', category: 'database', detectCmd: 'pscale', versionArg: 'version',
    // github.com/planetscale/cli#installation（macOS は公式の tap、Windows は公式の Scoop の bucket。Linux は deb・rpm を落とす手順なのでページ）
    install: {
      darwin: 'brew install planetscale/tap/pscale',
      win32: 'scoop bucket add pscale https://github.com/planetscale/scoop-bucket.git && scoop install pscale'
    },
    login: 'pscale auth login',
    siteUrl: 'https://planetscale.com/',
    homepageUrl: 'https://github.com/planetscale/cli#installation'
  },
  turso: {
    label: 'Turso CLI', category: 'database', detectCmd: 'turso', versionArg: '--version',
    // docs.turso.tech/cli/installation（Windows は WSL の中で Linux の手順。スクリプトは ~/.turso に入れる）
    install: {
      darwin: 'brew install tursodatabase/tap/turso',
      linux: 'curl -sSfL https://get.tur.so/install.sh | bash'
    },
    login: 'turso auth login',
    homeBinDirs: ['.turso'],
    siteUrl: 'https://turso.tech/',
    homepageUrl: 'https://docs.turso.tech/cli/installation'
  },

  // ── エラー・監視 ──
  sentry: {
    label: 'Sentry CLI', category: 'monitoring', detectCmd: 'sentry-cli', versionArg: '--version',
    // docs.sentry.io/cli/installation（macOS は公式の tap、Linux は公式のスクリプト、Windows は npm のパッケージ）
    install: {
      darwin: 'brew install getsentry/tools/sentry-cli',
      linux: 'curl -sL https://sentry.io/get-cli/ | sh',
      win32: npm('@sentry/cli')
    },
    login: 'sentry-cli login',
    siteUrl: 'https://sentry.io/',
    homepageUrl: 'https://docs.sentry.io/cli/installation/'
  },
  datadog: {
    // ログインのコマンドは無い（API キーを環境変数で渡す）
    label: 'Datadog CI', category: 'monitoring', detectCmd: 'datadog-ci', versionArg: '--version',
    install: allOs(npm('@datadog/datadog-ci')),
    siteUrl: 'https://www.datadoghq.com/',
    homepageUrl: 'https://github.com/DataDog/datadog-ci#installation'
  },

  // ── 決済 ──
  stripe: {
    label: 'Stripe CLI', category: 'payments', detectCmd: 'stripe', versionArg: '--version',
    // docs.stripe.com/stripe-cli/install は npm を案内し、github.com/stripe/stripe-cli#installation は macOS に Homebrew・
    // Windows に WinGet を挙げる（2026-10 確認）。Linux の apt・yum は複数行の手順なので npm
    install: { darwin: 'brew install stripe', linux: npm('@stripe/cli'), win32: 'winget install --id Stripe.StripeCLI -e' },
    login: 'stripe login',
    siteUrl: 'https://stripe.com/',
    homepageUrl: 'https://docs.stripe.com/stripe-cli/install'
  },

  // ── コンテナ ──
  docker: {
    label: 'Docker', category: 'containers', detectCmd: 'docker', versionArg: '--version',
    // docs.docker.com。macOS・Windows は Docker Desktop のインストーラ（1行の公式手順が無い）。Linux は公式の便利スクリプト
    install: { linux: 'curl -fsSL https://get.docker.com -o get-docker.sh && sudo sh get-docker.sh' },
    siteUrl: 'https://www.docker.com/',
    homepageUrl: 'https://docs.docker.com/get-started/get-docker/'
  },
  kubectl: {
    // 版は手元だけを見る（引数なしの version はクラスタに繋ぎに行き、待たされる）
    label: 'kubectl', category: 'containers', detectCmd: 'kubectl', versionArg: ['version', '--client'],
    // kubernetes.io/docs/tasks/tools
    install: { darwin: 'brew install kubectl', linux: KUBECTL_LINUX, win32: 'winget install -e --id Kubernetes.kubectl' },
    siteUrl: 'https://kubernetes.io/',
    homepageUrl: 'https://kubernetes.io/docs/tasks/tools/'
  },

  // ── モバイル ──
  xcode: {
    // xcrun は未インストールだと OS の「コマンドラインツールを入れますか」を出すので走らせず、置き場があるかだけを見る
    label: 'Xcode Command Line Tools', category: 'mobile', platforms: ['darwin'],
    detectCmd: '/Library/Developer/CommandLineTools/usr/bin/xcrun',
    aliases: ['/Applications/Xcode.app/Contents/Developer/usr/bin/xcodebuild'],
    displayCmd: 'xcrun',
    install: { darwin: 'xcode-select --install' },
    siteUrl: 'https://developer.apple.com/xcode/',
    homepageUrl: 'https://developer.apple.com/xcode/resources/'
  },
  adb: {
    // 版は adb version（サーバーは起こさない）。Android Studio の SDK の platform-tools も探す
    label: 'Android Platform Tools (adb)', category: 'mobile', detectCmd: 'adb', versionArg: 'version',
    install: {
      darwin: 'brew install --cask android-platform-tools',
      linux: ADB_LINUX,
      win32: 'winget install --id Google.PlatformTools -e'
    },
    homeBinDirs: ['Library/Android/sdk/platform-tools', 'Android/Sdk/platform-tools', 'AppData/Local/Android/Sdk/platform-tools'],
    siteUrl: 'https://developer.android.com/tools/adb',
    homepageUrl: 'https://developer.android.com/tools/releases/platform-tools'
  },
  eas: {
    label: 'Expo EAS CLI', category: 'mobile', detectCmd: 'eas', versionArg: '--version',
    install: allOs(npm('eas-cli')),
    login: 'eas login',
    siteUrl: 'https://expo.dev/',
    homepageUrl: 'https://github.com/expo/eas-cli'
  },
  fastlane: {
    // docs.fastlane.tools/getting-started/ios/setup（1行の手順は macOS の Homebrew。ほかは Ruby の用意からなのでページ）
    label: 'fastlane', category: 'mobile', detectCmd: 'fastlane', versionArg: '--version',
    install: { darwin: 'brew install fastlane' },
    siteUrl: 'https://fastlane.tools/',
    homepageUrl: 'https://docs.fastlane.tools/'
  },

  // ── 仮想マシン ──
  utm: {
    // UTM はアプリ（Homebrew の cask）。utmctl は UTM に Apple Events で話し、OS の自動化の許可を求めることがあるので走らせず、
    // アプリの中の utmctl があるかだけを見る
    label: 'UTM', category: 'vm', platforms: ['darwin'],
    detectCmd: '/Applications/UTM.app/Contents/MacOS/utmctl',
    displayCmd: 'utmctl',
    install: { darwin: 'brew install --cask utm' },
    siteUrl: 'https://mac.getutm.app/',
    homepageUrl: 'https://docs.getutm.app/scripting/utmctl/'
  },
  lima: {
    label: 'Lima', category: 'vm', platforms: ['darwin', 'linux'], detectCmd: 'limactl', versionArg: '--version',
    install: { darwin: 'brew install lima', linux: LIMA_LINUX },
    siteUrl: 'https://lima-vm.io/',
    homepageUrl: 'https://lima-vm.io/docs/installation/'
  },
  multipass: {
    // canonical.com/multipass/install（Windows はインストーラ）
    label: 'Multipass', category: 'vm', detectCmd: 'multipass', versionArg: 'version',
    install: { darwin: 'brew install --cask multipass', linux: 'sudo snap install multipass' },
    siteUrl: 'https://canonical.com/multipass',
    homepageUrl: 'https://canonical.com/multipass/install'
  },

  // ── AI・モデル ──
  ollama: {
    label: 'Ollama', category: 'ai', detectCmd: 'ollama', versionArg: '--version',
    // ollama.com/download/mac・linux・windows
    install: {
      darwin: 'curl -fsSL https://ollama.com/install.sh | sh',
      linux: 'curl -fsSL https://ollama.com/install.sh | sh',
      win32: powershell('irm https://ollama.com/install.ps1 | iex')
    },
    siteUrl: 'https://ollama.com/',
    homepageUrl: 'https://ollama.com/download'
  }
}

export function cliOsKey(platform: PlatformName): CliToolOs {
  return platform === 'win32' ? 'win32' : platform === 'darwin' ? 'darwin' : 'linux'
}

/** その OS で使える CLI か（UTM・Xcode は macOS だけ） */
export function cliToolSupported(id: CliToolId, platform: PlatformName): boolean {
  const platforms = CLI_TOOLS[id].platforms
  return !platforms || platforms.includes(cliOsKey(platform))
}

/** その OS のインストールコマンド。公式の1行の手順が無い・その OS で使えなければ undefined（公式ページへのリンクだけを出す） */
export function cliInstallCommand(id: CliToolId, platform: PlatformName): string | undefined {
  if (!cliToolSupported(id, platform)) return undefined
  return CLI_TOOLS[id].install[cliOsKey(platform)]?.trim() || undefined
}

/** ログインのコマンド（OS に関係ない）。要らないものは undefined */
export function cliLoginCommand(id: CliToolId): string | undefined {
  return CLI_TOOLS[id].login?.trim() || undefined
}

/** 検出に使うコマンド名（本体と別名） */
export function cliDetectCommands(id: CliToolId): string[] {
  const entry = CLI_TOOLS[id]
  return [entry.detectCmd, ...(entry.aliases ?? [])]
}

/** 画面に出すコマンド名 */
export function cliDisplayCommand(id: CliToolId): string {
  return CLI_TOOLS[id].displayCmd ?? CLI_TOOLS[id].detectCmd
}

/** 版を読む引数。走らせないものは null */
export function cliVersionArgs(id: CliToolId): string[] | null {
  const arg = CLI_TOOLS[id].versionArg
  if (arg === undefined) return null
  return typeof arg === 'string' ? [arg] : [...arg]
}

/** サイトのホスト名（一覧のリンクの文字。www. は省く） */
export function cliSiteHost(id: CliToolId): string {
  try {
    return new URL(CLI_TOOLS[id].siteUrl).hostname.replace(/^www\./, '')
  } catch {
    return CLI_TOOLS[id].siteUrl
  }
}

/** `<cli> --version` の出力から版（2.32.0 など）を読む。読めなければ null */
export function parseCliVersion(output: string): string | null {
  const match = /\bv?(\d+\.\d+(?:\.\d+)?(?:[-+][0-9A-Za-z.-]+)?)/.exec(output)
  return match ? match[1]! : null
}

/** 検出の結果（main の cliTools:list が返す） */
export interface CliToolStatus {
  id: CliToolId
  installed: boolean
  /** 版（読めなければ null） */
  version: string | null
}

/** 設定の画面の「インストール」リンク（判定モデルの Ollama など）の URL に当たる CLI。無ければ null */
export function cliToolForInstallUrl(url: string | undefined): CliToolId | null {
  if (!url) return null
  try {
    const host = new URL(url).hostname.replace(/^www\./, '')
    if (host === 'ollama.com') return 'ollama'
  } catch {
    // URL でない（想定内。リンクのまま）
  }
  return null
}
