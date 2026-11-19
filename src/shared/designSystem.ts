/**
 * デザインシステム（Storybook）のタブ。プロジェクトの Storybook を探し、起動のコマンドと開く URL を決める
 * （画面に依存しない純粋な処理。main の designSystem.ts と単体テストから使う）。
 *
 * - 置き場所の決まり: `.storybook/` があるか、package.json の scripts に `storybook dev` を呼ぶものがある
 * - 開く URL は手元（localhost・127.0.0.1・[::1]）の http/https だけ。タブの iframe も CSP もこの範囲に限る
 * - `.ferret/design-system.json` に `{ "url": "http://localhost:6006", "command": "pnpm storybook" }` を書けば、それを優先する
 */

export const DESIGN_SYSTEM_CONFIG = '.ferret/design-system.json'
export const DEFAULT_STORYBOOK_PORT = 6006

export type PackageManager = 'npm' | 'pnpm' | 'yarn' | 'bun'

export type DesignSystemState =
  /** Storybook が無い（Agent に作ってもらう） */
  | 'none'
  /** 置いてあるが、まだ動いていない（起動する） */
  | 'stopped'
  /** 動いている（タブに出す） */
  | 'running'

export interface DesignSystemStatus {
  state: DesignSystemState
  /** 開く URL（none でも、作ったときの既定を返す） */
  url: string
  /** 起動のコマンド（ターミナルに打つ1行）。none では無い */
  command?: string
}

/** 手元の Storybook の URL か（http/https、ホストは localhost・127.0.0.1・[::1]、ポートは 1〜65535） */
export function isLocalStorybookUrl(raw: unknown): raw is string {
  if (typeof raw !== 'string' || raw.length > 300) return false
  let url: URL
  try { url = new URL(raw) } catch { return false }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false
  if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) return false
  if (url.username || url.password) return false
  const port = url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80
  return Number.isInteger(port) && port >= 1 && port <= 65535
}

/** package.json の scripts から、Storybook の開発サーバーを起動するものを選ぶ（storybook という名前を優先） */
export function storybookScript(scripts: Record<string, unknown> | undefined): { name: string; port: number } | null {
  if (!scripts || typeof scripts !== 'object') return null
  const entries = Object.entries(scripts).filter((e): e is [string, string] => typeof e[1] === 'string')
  const isDev = (cmd: string) => /\bstorybook\s+dev\b/.test(cmd) || /\bstart-storybook\b/.test(cmd)
  const picked = entries.find(([name, cmd]) => name === 'storybook' && isDev(cmd)) ?? entries.find(([, cmd]) => isDev(cmd))
  if (!picked) return null
  return { name: picked[0], port: storybookPort(picked[1]) }
}

/** `storybook dev -p 6007` / `--port=6007` のポート。無ければ 6006 */
export function storybookPort(command: string): number {
  const m = /(?:^|\s)(?:-p|--port)(?:\s+|=)(\d{1,5})(?=\s|$)/.exec(command)
  const port = m ? Number(m[1]) : DEFAULT_STORYBOOK_PORT
  return port >= 1 && port <= 65535 ? port : DEFAULT_STORYBOOK_PORT
}

/** ロックファイルからパッケージマネージャーを選ぶ。無ければ npm */
export function packageManagerFor(files: readonly string[]): PackageManager {
  const has = (name: string) => files.includes(name)
  if (has('pnpm-lock.yaml')) return 'pnpm'
  if (has('bun.lockb') || has('bun.lock')) return 'bun'
  if (has('yarn.lock')) return 'yarn'
  return 'npm'
}

/**
 * 起動の1行。ブラウザを勝手に開かず、聞き返さない `--ci` を付ける（npm は `--` の後ろに渡す）。
 * スクリプトの名前は英数字と : . _ - だけ（シェルに打つので、それ以外は使わない）
 */
export function storybookStartCommand(pm: PackageManager, script: string): string | null {
  if (!/^[A-Za-z0-9:._-]{1,64}$/.test(script)) return null
  if (pm === 'npm') return `npm run ${script} -- --ci`
  if (pm === 'yarn') return `yarn ${script} --ci`
  return `${pm} run ${script} --ci`
}

/** `.ferret/design-system.json` を読む。形の違うものは捨てる（url は手元のものだけ、command は1行・短いものだけ） */
export function parseDesignSystemConfig(text: string | null): { url?: string; command?: string } {
  if (!text) return {}
  let raw: unknown
  try { raw = JSON.parse(text) } catch { return {} }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const r = raw as { url?: unknown; command?: unknown }
  const out: { url?: string; command?: string } = {}
  if (isLocalStorybookUrl(r.url)) out.url = r.url
  if (typeof r.command === 'string' && r.command.trim() && r.command.length <= 300 && !/[\r\n\0]/.test(r.command)) out.command = r.command.trim()
  return out
}

/** フォルダの手がかりから、Storybook があるか・起動のコマンド・URL を決める（動いているかは呼び出し側が確かめる） */
export function resolveDesignSystem(input: {
  /** package.json の中身（無ければ null） */
  packageJson: string | null
  /** `.storybook/` があるか */
  hasStorybookDir: boolean
  /** フォルダの直下のファイル名（ロックファイルを見る） */
  rootFiles: readonly string[]
  /** `.ferret/design-system.json` の中身（無ければ null） */
  config: string | null
}): { present: boolean; url: string; command?: string } {
  const config = parseDesignSystemConfig(input.config)
  let scripts: Record<string, unknown> | undefined
  try {
    const pkg = input.packageJson ? (JSON.parse(input.packageJson) as { scripts?: Record<string, unknown> }) : null
    scripts = pkg && typeof pkg === 'object' && pkg.scripts && typeof pkg.scripts === 'object' ? pkg.scripts : undefined
  } catch {
    scripts = undefined
  }
  const script = storybookScript(scripts)
  const url = config.url ?? `http://localhost:${script?.port ?? DEFAULT_STORYBOOK_PORT}`
  const command = config.command ?? (script ? storybookStartCommand(packageManagerFor(input.rootFiles), script.name) ?? undefined : undefined)
  const present = Boolean(script || config.url || config.command || input.hasStorybookDir)
  return { present, url, ...(command ? { command } : {}) }
}

/** Agent に頼む文（タブの［Agent に作ってもらう］）。skill ferret-design-system を使わせる */
export function designSystemRequest(lang: 'ja' | 'en'): string {
  return lang === 'ja'
    ? 'このプロジェクトのデザインシステムを Storybook で作ってください（skill ferret-design-system）。色・文字・余白のトークンと、画面で使う部品をすべて、状態ごと（通常・ホバー・無効・読み込み中・エラー・空）に stories にしてください。過去の指摘（skill ferret-feedback）で繰り返し出ているものは、部品とトークンに先に反映してください。できたら起動して、Ferret のデザインシステムのタブで見られるようにしてください。'
    : 'Build this project\'s design system in Storybook (skill ferret-design-system). Add stories for the colour, type and spacing tokens and for every component the screens use, in each state (default, hover, disabled, loading, error, empty). Build the recurring points from past feedback (skill ferret-feedback) into the components and tokens up front. When done, start it so it shows in Ferret\'s Design system tab.'
}
