/**
 * Windows で CLI（codex / claude など）を child_process.spawn するための解決。
 *
 * Orca由来: ~/bench/orca/src/shared/child-process/spawn-resolution.ts,
 *           ~/bench/orca/src/shared/child-process/windows-command-line.ts,
 *           ~/bench/orca/src/shared/child-process/windows-cmd-shim-resolution.ts（MIT, Copyright 2026 Lovecast Inc.）
 *
 * Windows には次の3つの落とし穴がある。
 * 1. spawn('codex') は PATHEXT を見ない（libuv は .exe / .com しか補わない）。npm で入れた CLI は
 *    codex.cmd なので「見つからない」で失敗する。→ PATH と PATHEXT から実体のパスを探す
 * 2. Node は .cmd / .bat を shell なしで起動しない（CVE-2024-27980 の対策で EINVAL）。
 *    → npm / pnpm が生成した .cmd なら中身を読んで `node.exe <script>` を直接起動する
 * 3. それ以外の .cmd は cmd.exe 経由になる。cmd は `"` の数え方と `%VAR%` の展開が独特なので、
 *    引数は cmd と CommandLineToArgvW の両方が同じに読む書き方にする
 *
 * Orca の判断の流れはそのままに、キャッシュと Defender 向けの細かい分岐は省いた。
 * ファイルの読み書きは引数で差し替えられるので、macOS / Linux でも単体テストできる。
 */
import { t } from '@shared/i18n'
import { UserFacingError } from '@shared/errors'
import { quoteWindowsCmdArgument } from '@shared/shellQuote'
import { findWindowsExecutable, nodeWindowsFs, pathExtensions, readEnv, resolveWindowsCmdShim, type WindowsFs } from '@video/toolchain/windowsCmdShim'

export { findWindowsExecutable, parseWindowsCmdShim, type WindowsFs } from '@video/toolchain/windowsCmdShim'

/**
 * `where` の出力から、起動できるものを選ぶ。
 * npm の置き場には codex（sh 用・拡張子なし）・codex.cmd・codex.ps1 が並び、`where` は拡張子なしを先に出すことがある。
 */
export function pickWindowsWhereResult(output: string, env: NodeJS.ProcessEnv = {}): string | null {
  const extensions = pathExtensions(env).filter((ext) => ext !== '.ps1')
  const lines = output.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0)
  return lines.find((line) => extensions.some((ext) => line.toLowerCase().endsWith(ext))) ?? null
}

// ───────────────────────── cmd.exe 用の引数の書き方 ─────────────────────────


/**
 * cmd.exe に渡す1つの引数（windowsVerbatimArguments: true で渡す）。
 * /d は AutoRun を読まない、/v:off は ! を文字のままにする、/s は外側の " を1組だけ外す。
 */
export function buildWindowsCmdShimCommandLine(program: string, args: readonly string[]): string {
  for (const value of [program, ...args]) {
    // cmd は囲みの中でも改行でコマンドを終える
    if (/[\r\n]/.test(value)) throw new UserFacingError(t('platform.errors.cmdNewline'))
  }
  return `/d /v:off /s /c "${[program, ...args].map(quoteWindowsCmdArgument).join(' ')}"`
}

function isCmdInterpretedProgram(program: string): boolean {
  const lower = program.toLowerCase()
  return lower.endsWith('.cmd') || lower.endsWith('.bat')
}

// ───────────────────────── まとめ ─────────────────────────

interface ResolvedSpawn {
  file: string
  args: string[]
  env: NodeJS.ProcessEnv
  /** cmd.exe に組み立て済みの1行を渡すときだけ true */
  windowsVerbatimArguments?: boolean
}

/**
 * spawn に渡す実際のファイル・引数を決める。Windows 以外はそのまま返す。
 * shell: true は使わない（引数をそのまま連結するうえ windowsHide が効かなくなる。Orca の注記）。
 */
export function resolveSpawn(
  program: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
  fs: WindowsFs = nodeWindowsFs
): ResolvedSpawn {
  if (platform !== 'win32') return { file: program, args: [...args], env }
  const found = findWindowsExecutable(program, env, fs) ?? program
  if (!isCmdInterpretedProgram(found)) return { file: found, args: [...args], env }
  const shim = resolveWindowsCmdShim(found, env, fs)
  if (shim) return { file: shim.program, args: [...shim.prefixArgs, ...args], env: shim.env ?? env }
  return {
    file: readEnv(env, 'ComSpec') ?? 'cmd.exe',
    args: [buildWindowsCmdShimCommandLine(found, args)],
    env,
    windowsVerbatimArguments: true
  }
}
