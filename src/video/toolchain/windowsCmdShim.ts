/**
 * Windows の npm / pnpm が置く .cmd（codex.cmd など）を、shell を使わずに起動できる形に解く部分。
 * Ferret 本体（src/main/platform/windowsSpawn.ts）と動画の CLI（src/video/cli）が共有するので、
 * node の組み込み以外に依存しない（i18n やエラーの型を持ち込まない）。
 *
 * Orca由来: ~/bench/orca/src/shared/child-process/windows-cmd-shim-resolution.ts（MIT, Copyright 2026 Lovecast Inc.）
 */
import { readFileSync, statSync } from 'node:fs'
import { win32 } from 'node:path'


/** テストで差し替えるファイルの読み取り */
export interface WindowsFs {
  /** 普通のファイルなら大きさを返す。無ければ null */
  fileSize: (path: string) => number | null
  readText: (path: string) => string | null
}

export const nodeWindowsFs: WindowsFs = {
  fileSize: (path) => {
    try {
      const stats = statSync(path)
      return stats.isFile() ? stats.size : null
    } catch {
      // 無いファイル（PATH の候補を順に調べている。想定内）
      return null
    }
  },
  readText: (path) => {
    try {
      return readFileSync(path, 'utf8')
    } catch {
      // 読めない候補は飛ばす（想定内）
      return null
    }
  }
}

/** Windows の環境変数名は大文字小文字を区別しない（JS のオブジェクトは区別する） */
export function readEnv(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const lower = name.toLowerCase()
  const key = Object.keys(env).find((k) => k.toLowerCase() === lower && env[k] !== undefined)
  return key ? env[key] : undefined
}

/** PATHEXT が無いときの cmd の既定。順番に意味がある（.COM が .EXE より先） */
const DEFAULT_PATHEXT = '.COM;.EXE;.BAT;.CMD'

export function pathExtensions(env: NodeJS.ProcessEnv): string[] {
  return (readEnv(env, 'PATHEXT') || DEFAULT_PATHEXT)
    .split(';')
    .map((ext) => ext.trim().toLowerCase())
    .filter((ext) => ext.startsWith('.'))
}

function absolutePathEntries(env: NodeJS.ProcessEnv): string[] {
  return (readEnv(env, 'PATH') ?? '')
    .split(';')
    .map((entry) => entry.trim().replace(/^"(.*)"$/, '$1'))
    // 相対の PATH は子プロセスの作業フォルダ次第なので、ここでは答えられない（Orca と同じ）
    .filter((entry) => entry.length > 0 && win32.isAbsolute(entry))
}

/**
 * 素のコマンド名（'codex'）を、cmd と同じ規則で PATH から探す。
 * 最初に「どれかの PATHEXT の綴り」が見つかったフォルダで決まり、その中では PATHEXT の順。
 * 拡張子の無いファイル（npm が並べて置く sh 用のスクリプト）は起動できないので選ばない。
 * すでにパスや拡張子が付いていれば、そのまま返す。
 */
export function findWindowsExecutable(command: string, env: NodeJS.ProcessEnv, fs: WindowsFs = nodeWindowsFs): string | null {
  if (win32.isAbsolute(command)) return fs.fileSize(command) !== null ? command : null
  if (/[\\/]/.test(command)) return null
  const extensions = pathExtensions(env)
  const hasExtension = extensions.some((ext) => command.toLowerCase().endsWith(ext))
  for (const dir of absolutePathEntries(env)) {
    if (hasExtension) {
      const candidate = win32.join(dir, command)
      if (fs.fileSize(candidate) !== null) return candidate
      continue
    }
    for (const ext of extensions) {
      const candidate = win32.join(dir, `${command}${ext}`)
      if (fs.fileSize(candidate) !== null) return candidate
    }
  }
  return null
}

// ───────────────────────── npm / pnpm の .cmd を読む ─────────────────────────

const DP0 = String.raw`(?:%~dp0|%dp0%)\\?`
const DP0_NODE_EXE = `"${DP0}node\\.exe"`
const dp0Path = (group: string): string => `"${DP0}(?<${group}>[^"\\r\\n]+)"`
const ECHO_OFF = String.raw`@echo off\n`
const FIND_DP0 = String.raw`GOTO start\n:find_dp0\nSET dp0=%~dp0\nEXIT /b\n:start\nSETLOCAL\nCALL :find_dp0\n`
const NODE_PATH_BLOCK = String.raw`(?:@IF NOT DEFINED NODE_PATH \(\n@SET "NODE_PATH=(?<nodePath>[^"\r\n]*)"\n\) ELSE \(\n@SET "NODE_PATH=(?<nodePathElse>[^"\r\n]*)"\n\)\n)?`
const PATHEXT_STRIP = String.raw`SET PATHEXT=%PATHEXT:;\.JS;=;%`

/** 今の npm（cmd-shim）。codex.cmd はこの形 */
const NPM_PROG_NODE_SHIM = new RegExp(
  String.raw`^${ECHO_OFF}${FIND_DP0}IF EXIST ${DP0_NODE_EXE} \(\nSET "_prog=${DP0}node\.exe"\n\) ELSE \(\nSET "_prog=node"\n${PATHEXT_STRIP}\n\)\nendLocal & goto #_undefined_# 2>NUL \|\| title %COMSPEC% & "%_prog%" +${dp0Path('script')} +%\*$`,
  'i'
)
/** 古い npm と pnpm（@zkochan/cmd-shim）。分岐ごとに同じスクリプトを書く */
const BRANCHED_NODE_SHIM = new RegExp(
  String.raw`^(?:@SETLOCAL\n)?${NODE_PATH_BLOCK}@?IF EXIST ${DP0_NODE_EXE} \(\n${DP0_NODE_EXE} +${dp0Path('script')} +%\*\n\) ELSE \(\n(?:@?SETLOCAL\n)?@?${PATHEXT_STRIP}\nnode +${dp0Path('scriptElse')} +%\*\n\)$`,
  'i'
)
/** 同梱の .exe をそのまま呼ぶ形（npm / pnpm） */
const NPM_DIRECT_SHIM = new RegExp(String.raw`^${ECHO_OFF}(?:${FIND_DP0})?${dp0Path('target')} +%\*$`, 'i')
const PNPM_DIRECT_SHIM = new RegExp(String.raw`^(?:@SETLOCAL\n)?@?${dp0Path('target')} +%\*$`, 'i')

/** 読み違いの印。`:` はドライブ指定（D:evil.js）で .cmd のフォルダの外へ出られるので拒む（Orca の注記） */
const UNSAFE_SHIM_PATH = /[%^&|<>":\r\n]/

type ParsedWindowsCmdShim =
  | { kind: 'node'; script: string; nodePathPrefix?: string }
  | { kind: 'direct'; target: string }

function isPlainRelativePath(spelled: string): boolean {
  return !UNSAFE_SHIM_PATH.test(spelled) && !win32.isAbsolute(spelled)
}

/** 生成された .cmd かどうかを見分ける。形が完全に一致しなければ null（読み違えて別のものを起動するよりよい） */
export function parseWindowsCmdShim(contents: string): ParsedWindowsCmdShim | null {
  const canonical = contents
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join('\n')

  const prog = NPM_PROG_NODE_SHIM.exec(canonical)?.groups
  if (prog?.script) return isPlainRelativePath(prog.script) ? { kind: 'node', script: prog.script } : null

  const branched = BRANCHED_NODE_SHIM.exec(canonical)?.groups
  if (branched?.script) {
    if (branched.script !== branched.scriptElse || !isPlainRelativePath(branched.script)) return null
    const nodePath = branched.nodePath
    if (nodePath === undefined) return { kind: 'node', script: branched.script }
    if (nodePath.includes('%') || branched.nodePathElse !== `${nodePath};%NODE_PATH%`) return null
    return { kind: 'node', script: branched.script, nodePathPrefix: nodePath }
  }

  for (const pattern of [NPM_DIRECT_SHIM, PNPM_DIRECT_SHIM]) {
    const target = pattern.exec(canonical)?.groups?.target
    if (target) return isPlainRelativePath(target) ? { kind: 'direct', target } : null
  }
  return null
}

/**
 * .cmd が選ぶのと同じ node を探す。隣の node.exe、無ければ PATH の node。
 * PATH で最初に見つかった綴りが .exe 以外（node.cmd など）なら null にして cmd.exe 経由に任せる。
 * その先の node.exe まで探すと、.cmd とは別のものを起動してしまう（Orca の注記）。
 */
function resolveShimNode(directory: string, env: NodeJS.ProcessEnv, fs: WindowsFs): string | null {
  const sibling = win32.join(directory, 'node.exe')
  if (fs.fileSize(sibling) !== null) return sibling
  const extensions = pathExtensions(env)
  for (const dir of absolutePathEntries(env)) {
    for (const ext of extensions) {
      const candidate = win32.join(dir, `node${ext}`)
      if (fs.fileSize(candidate) === null) continue
      return ext === '.exe' ? candidate : null
    }
  }
  return null
}

/** 本物の .cmd は 2KB 未満。これより大きいものは生成されたものではない */
const MAX_SHIM_BYTES = 64 * 1024

export interface WindowsCmdShimResolution {
  program: string
  prefixArgs: string[]
  /** pnpm の .cmd が NODE_PATH を足すときだけ */
  env?: NodeJS.ProcessEnv
}

export function resolveWindowsCmdShim(program: string, env: NodeJS.ProcessEnv, fs: WindowsFs = nodeWindowsFs): WindowsCmdShimResolution | null {
  if (!win32.isAbsolute(program)) return null
  const size = fs.fileSize(program)
  if (size === null || size > MAX_SHIM_BYTES) return null
  const contents = fs.readText(program)
  const parsed = contents === null ? null : parseWindowsCmdShim(contents)
  if (!parsed) return null
  const directory = win32.dirname(program)

  if (parsed.kind === 'direct') {
    const target = win32.resolve(directory, parsed.target)
    const lower = target.toLowerCase()
    if (!lower.endsWith('.exe') && !lower.endsWith('.com')) return null
    return fs.fileSize(target) !== null ? { program: target, prefixArgs: [] } : null
  }

  const script = win32.resolve(directory, parsed.script)
  if (fs.fileSize(script) === null) return null
  const node = resolveShimNode(directory, env, fs)
  if (!node) return null
  if (!parsed.nodePathPrefix) return { program: node, prefixArgs: [script] }
  const key = Object.keys(env).find((k) => k.toLowerCase() === 'node_path') ?? 'NODE_PATH'
  const existing = env[key]
  return { program: node, prefixArgs: [script], env: { ...env, [key]: existing ? `${parsed.nodePathPrefix};${existing}` : parsed.nodePathPrefix } }
}
