/**
 * 実行環境の解決。
 * whisper の実行ファイル・モデル、GPUの有無、使えるLLM CLIを決める。
 *
 * **Electron の API には依存しない。** パス（`app.getPath('userData')` や
 * `process.resourcesPath`）は引数で受け取るので、単体テストできる。
 */
import { execFile } from 'node:child_process'
import { accessSync, constants as fsConstants, existsSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, relative, resolve as resolvePath } from 'node:path'
import type { PlatformName } from '@shared/types'
import type { WhisperModelId } from './stt/models'
import { whisperModels } from './stt/models'
import { commonBinaryDirs } from '../platform/binaryDirs'
import { pickWindowsWhereResult } from '../platform/windowsSpawn'
import { timedSync } from '@shared/report'

/** 呼び出し側（main）が渡すパス */
interface EnvironmentPaths {
  /** 配布時のリソースフォルダ（`process.resourcesPath`）。開発時は省略 */
  resourcesDir?: string
  /** モデルの置き場所（`join(app.getPath('userData'), 'models')`） */
  modelDir: string
}

/** テストで差し替える外部依存 */
export interface EnvironmentProbes {
  platform: PlatformName
  arch: string
  /** ホームフォルダ。~/.local/bin などを探すのに使う。省略時は探さない */
  home?: string
  /** ファイルが存在するか */
  exists: (path: string) => boolean
  /** PATH 上のコマンドの絶対パス。無ければ null（テストの差し替えは同期で返してよい） */
  which: (command: string) => Promise<string | null> | string | null
  /**
   * コマンドを実行して stdout+stderr を返す。失敗したら null。
   * GPUバックエンドの検出と CLI の有無の確認に使う。
   */
  run?: (command: string, args: string[]) => Promise<string | null>
}

const WHISPER_EXECUTABLE = 'whisper-cli'

/**
 * whisper の実行ファイルを探す。
 * 1. 配布時: `<resources>/whisper/<platform>-<arch>/whisper-cli`（同梱したもの）
 * 2. PATH 上
 * 3. Homebrew などの既定の場所（OSごと。platform/binaryDirs.ts）
 */
export async function resolveWhisperBinary(
  paths: EnvironmentPaths,
  probes: EnvironmentProbes
): Promise<string | null> {
  const name = probes.platform === 'win32' ? `${WHISPER_EXECUTABLE}.exe` : WHISPER_EXECUTABLE

  if (paths.resourcesDir) {
    const bundled = joinPath([paths.resourcesDir, 'whisper', `${probes.platform}-${probes.arch}`, name])
    if (probes.exists(bundled)) return bundled
  }

  const onPath = await probes.which(WHISPER_EXECUTABLE)
  if (onPath) return onPath

  for (const dir of commonBinaryDirs(probes.platform as NodeJS.Platform, probes.home ?? '')) {
    const candidate = joinPath([dir, name])
    if (probes.exists(candidate)) return candidate
  }
  return null
}

/** モデルファイルの置き場所。ユーザー設定フォルダの下に置く（プロジェクトを汚さない。NF-9） */
export function whisperModelPath(paths: EnvironmentPaths, id: WhisperModelId): string {
  return joinPath([paths.modelDir, whisperModels[id].file])
}

/**
 * GPU（Metal / CUDA / Vulkan）が使えるか。
 *
 * whisper-cli は起動時に読み込んだバックエンドを stderr へ出すので、それを見て判定する。
 * 実行できない場合は、macOS は Metal あり、それ以外は無しとみなす（控えめな既定）。
 */
export async function detectGpu(binary: string | null, probes: EnvironmentProbes): Promise<boolean> {
  if (binary && probes.run) {
    const out = await probes.run(binary, ['--help'])
    if (out !== null) {
      // 動的に読む版（公式の zip・Homebrew）は load_backend の行、静的にリンクした版は初期化の行で分かる
      return /loaded (MTL|Metal|CUDA|Vulkan|HIP|SYCL|OpenCL|MUSA|CANN) backend|ggml_cuda_init: found [1-9]|ggml_vulkan: Found [1-9]|ggml_metal_device_init|using (CUDA|Vulkan|Metal)\d* backend/i.test(out)
    }
  }
  return probes.platform === 'darwin'
}

/**
 * 使うモデル（おすすめ）を決める。
 * CPUのみでは `large-v3-turbo`（f16）が遅く、録画中の区切りの処理がたまって停止後に長く待たせる
 * （Issue #13: Windows の Ryzen AI MAX+ 395 で 4 スレッドだと実時間の 1.26 倍）。
 * CPU では量子化した `large-v3-turbo-q5_0`（メモリの読み出しが約 1/3 で速く、日本語の精度はほぼ同じ）をすすめる。
 * `small` は日本語の誤変換が目立つので、CPU でも既定にはしない（設計 5章①、05_pipeline_findings.md）。
 */
export function chooseWhisperModel(gpuAvailable: boolean): WhisperModelId {
  return gpuAvailable ? 'large-v3-turbo' : 'large-v3-turbo-q5_0'
}

/**
 * whisper-cli に渡すスレッド数（-t）。
 * 渡さないと whisper-cli は min(4, コア数) しか使わず、16 コア 32 スレッドの CPU でも 4 スレッドで動いていた
 * （Issue #13: -t 16 で 2.3 倍速くなった）。区切りは1つずつ順に処理する（IncrementalTranscriber）ので、
 * 論理コアの半分（だいたい物理コアの数）を使う。少なくとも 4（コアが 4 未満ならその数）、多くても 16
 * （それより増やしても速くならず、ほかの操作が重くなる）。
 */
export function whisperThreads(logicalCpus: number): number {
  const n = Number.isFinite(logicalCpus) ? Math.floor(logicalCpus) : 0
  if (n <= 0) return 4
  if (n <= 4) return n
  return Math.min(16, Math.max(4, Math.floor(n / 2)))
}

/** detectGpu の結果を実行ファイルごとに覚える（--help の起動は Metal のライブラリの準備などで数百 ms かかる） */
const gpuCache = new Map<string, Promise<boolean>>()

/**
 * その whisper-cli が GPU を使えるか（覚えた結果を返す）。
 * timeoutMs を過ぎても分からなければ、OS からの控えめな既定（detectGpu と同じ）を返し、調べるのは裏で続ける
 */
export async function whisperUsesGpu(binary: string, probes: EnvironmentProbes, timeoutMs = 3000): Promise<boolean> {
  let hit = gpuCache.get(binary)
  if (!hit) {
    hit = detectGpu(binary, probes).catch(() => probes.platform === 'darwin')
    gpuCache.set(binary, hit)
  }
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([hit, new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(probes.platform === 'darwin'), timeoutMs) })])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/** テスト用：覚えた GPU の判定を消す */
export function clearWhisperGpuCache(): void {
  gpuCache.clear()
}

/**
 * 端末内の文字起こしで使うモデルのファイルを選ぶ。
 * 利用者が選んだもの（explicit。設定の whisperModel）があればそれ。無ければ、取得済みのモデルから
 * GPU なら large-v3-turbo を、CPU なら large-v3-turbo-q5_0 を先に選ぶ。どれも無ければ fallback（古い置き場所の small）
 */
export function pickLocalWhisperModel(opt: { explicit?: string | null; gpu: boolean; pathOf: (id: WhisperModelId) => string; exists: (path: string) => boolean; fallback: string }): string {
  if (opt.explicit) return opt.explicit
  const order: WhisperModelId[] = opt.gpu ? ['large-v3-turbo', 'large-v3-turbo-q5_0', 'small'] : ['large-v3-turbo-q5_0', 'large-v3-turbo', 'small']
  for (const id of order) {
    const path = opt.pathOf(id)
    if (opt.exists(path)) return path
  }
  return opt.fallback
}

interface WhisperRuntime {
  binary: string
  modelId: WhisperModelId
  modelPath: string
  gpuAvailable: boolean
  /** モデルが未ダウンロードなら true。呼び出し側は downloadWhisperModel() を走らせる */
  needsDownload: boolean
}

/** whisper を動かすのに必要なものを一度に解決する */
export async function resolveWhisperRuntime(
  paths: EnvironmentPaths,
  probes: EnvironmentProbes,
  override?: { modelId?: WhisperModelId }
): Promise<WhisperRuntime | { error: 'binary-not-found' }> {
  const binary = await resolveWhisperBinary(paths, probes)
  if (!binary) return { error: 'binary-not-found' }

  const gpuAvailable = await detectGpu(binary, probes)
  const modelId = override?.modelId ?? chooseWhisperModel(gpuAvailable)
  const modelPath = whisperModelPath(paths, modelId)
  return {
    binary,
    modelId,
    modelPath,
    gpuAvailable,
    needsDownload: !probes.exists(modelPath)
  }
}

// ───────────────────────── LLM CLI の検出 ─────────────────────────

type LlmRunnerKind = 'codex' | 'claude-code'

interface LlmRuntime {
  kind: LlmRunnerKind
  binary: string
  /** Claude Code のときだけ使う。Codex は config を無効化して既定モデルに任せる */
  model?: string
}

/**
 * 使えるCLIを検出する。
 * 既定は Codex（所要時間が安定）。無ければ Claude Code の sonnet（設計 6章）。
 */
export async function detectLlmRuntime(
  probes: EnvironmentProbes,
  preferred?: LlmRunnerKind
): Promise<LlmRuntime | null> {
  const [codex, claude] = await Promise.all([probes.which('codex'), probes.which('claude')])

  const candidates: LlmRuntime[] = []
  if (codex) candidates.push({ kind: 'codex', binary: codex })
  if (claude) candidates.push({ kind: 'claude-code', binary: claude, model: 'sonnet' })

  if (candidates.length === 0) return null
  if (preferred) {
    const hit = candidates.find((c) => c.kind === preferred)
    if (hit) return hit
  }
  // 既定の優先順は Codex → Claude Code
  return candidates[0]!
}

/** `node:path` を動的 import せずに済ませる（この関数はテストで多用するため） */
function joinPath(parts: string[]): string {
  const sep = parts.some((p) => p.includes('\\')) && !parts[0]!.startsWith('/') ? '\\' : '/'
  return parts
    .map((p, i) => (i === 0 ? p.replace(/[/\\]+$/, '') : p.replace(/^[/\\]+|[/\\]+$/g, '')))
    .filter((p) => p.length > 0)
    .join(sep)
}

/** which の結果を覚える時間（PATH の変化は30秒で拾い直す） */
const WHICH_CACHE_MS = 30_000
const whichCache = new Map<string, { value: Promise<string | null>; at: number }>()

/** 既定の probes（main から使う）。Electron には依存しない */
/** Windows の where を待つ上限 */
const WHERE_TIMEOUT_MS = 2000

/** path が dir そのものかその下か（実体のパスどうしで比べる） */
function isInsideDir(path: string, dir: string): boolean {
  const rel = relative(resolvePath(dir), resolvePath(path))
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/**
 * which と同じ探し方（macOS / Linux）。PATH のフォルダを前から見て、実行できるファイルの最初のものを返す。
 * コマンドに区切りが入っていれば探さない（PATH の外のパスは扱わない）。
 * 空・`.`・相対の項目は使わない（今のフォルダ＝プロジェクトを指す）。実体（リンクの先）が exclude（開いているプロジェクト）の
 * 中のものも使わない（security-7 [15]。Agent の実行ファイルと同じ決まり。agentExecutable.ts）
 */
export function findOnPath(
  command: string, pathValue: string, isExecutable: (path: string) => boolean,
  options: { exclude?: string | null; realpath?: (path: string) => string | null } = {}
): string | null {
  if (!command || command.includes('/')) return null
  const real = options.realpath ?? ((p: string) => { try { return realpathSync(p) } catch { return null } })
  const exclude = options.exclude ? (real(options.exclude) ?? options.exclude) : null
  for (const dir of pathValue.split(':')) {
    if (!dir || !dir.startsWith('/')) continue
    const candidate = `${dir.replace(/\/+$/, '')}/${command}`
    if (!isExecutable(candidate)) continue
    const target = real(candidate) ?? candidate
    if (exclude && isInsideDir(target, exclude)) continue
    return candidate
  }
  return null
}

function isExecutableFile(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false
    accessSync(path, fsConstants.X_OK)
    return true
  } catch {
    return false
  }
}

/**
 * project は開いているプロジェクト。その中の実行ファイルは PATH にあっても使わない（security-7 [15]）。
 * Windows の where は今のフォルダを先に探すので、アプリのフォルダで動かし、プロジェクトの中の結果は捨てる
 */
export function nodeProbes(project: string | null = null): EnvironmentProbes {
  return {
    platform: process.platform as PlatformName,
    arch: process.arch,
    home: homedir(),
    exists: (p) => existsSync(p),
    which: (command) => {
      /*
       * capture:availability（指摘の画面を開くたび）などで何度も呼ばれるので、結果を30秒覚える（見つからないことも、探している途中も）。
       * macOS / Linux は which を起動せず、PATH のフォルダを順に見る。
       * Windows の where は PATHEXT と npm のスクリプトの扱いがあるのでそのまま使うが、非同期で起動し、止まる上限を付ける
       * （同期で起動すると main が 0.1〜0.6 秒止まっていた。FERRET-M）。同期で見る macOS / Linux の時間は重い処理として控える
       */
      const key = `${command}\0${project ?? ''}`
      const hit = whichCache.get(key)
      if (hit && Date.now() - hit.at < WHICH_CACHE_MS) return hit.value
      const value = process.platform !== 'win32'
        ? Promise.resolve(timedSync(`which:${command}`.slice(0, 40), () => findOnPath(command, process.env.PATH ?? '', isExecutableFile, { exclude: project })))
        : new Promise<string | null>((resolve) => {
          execFile('where', [command], { encoding: 'utf8', windowsHide: true, timeout: WHERE_TIMEOUT_MS, cwd: dirname(process.execPath) }, (err, stdout) => {
            // 見つからない・時間切れは null（想定内）。Windows の where は npm の拡張子なしのスクリプトを先に出すことがある。起動できるものを選ぶ。
            // 相対・プロジェクトの中の結果は使わない
            const lines = err ? '' : stdout.split(/\r?\n/).filter((line) => {
              const p = line.trim()
              return /^[a-zA-Z]:[\\/]/.test(p) && !(project && p.toLowerCase().startsWith(`${project.replace(/[\\/]+$/, '').toLowerCase()}\\`))
            }).join('\n')
            resolve(lines ? pickWindowsWhereResult(lines, process.env) : null)
          })
        })
      whichCache.set(key, { value, at: Date.now() })
      return value
    },
    run: async (command, args) =>
      new Promise((resolve) => {
        execFile(command, args, { timeout: 20_000, encoding: 'utf8', windowsHide: true }, (_err, stdout, stderr) => {
          const text = `${stdout ?? ''}${stderr ?? ''}`
          resolve(text.length > 0 ? text : null)
        })
      })
  }
}
