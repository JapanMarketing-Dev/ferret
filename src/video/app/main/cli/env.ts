import { existsSync } from 'node:fs'
import { chmod, mkdir, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { VIDEO_BIN_ENV, VIDEO_CLI, VIDEO_ELECTRON_ENV, VIDEO_ENV_PREFIX } from '@video/names'
import type { VideoMainContext } from '../context'

/**
 * 内蔵ターミナルのタブに足す環境変数（担当: CLI）。
 * `ferret-video` の入ったフォルダを VIDEO_BIN_ENV で渡すと、src/main/terminal.ts の ptyEnv が PATH の先頭へ移す。
 *
 * 起動ごとに `<userData>/video-cli/bin/` へ `ferret-video`（POSIX sh）と `ferret-video.cmd` を書く。
 * どちらも FERRET_VIDEO_ELECTRON（Ferret 自身の実行ファイル）があれば ELECTRON_RUN_AS_NODE=1 でそれを、
 * 無ければ PATH の node で `<appOutDir>/video-cli/ferret-video.mjs`（src/video/build/cliPlugin.ts が作る）を動かす。
 */

/** 組み込みテンプレートの場所を CLI へ渡す変数（src/video/templates/load.ts の TEMPLATES_DIR_ENV と同じ） */
export const VIDEO_TEMPLATES_ENV = `${VIDEO_ENV_PREFIX}TEMPLATES_DIR`
/** CLI の whisper（旧 SOLOCUT_WHISPER_CLI / SOLOCUT_WHISPER_MODEL / SOLOCUT_WHISPER_MODEL_SMALL） */
export const VIDEO_WHISPER_CLI_ENV = `${VIDEO_ENV_PREFIX}WHISPER_CLI`
export const VIDEO_WHISPER_MODEL_ENV = `${VIDEO_ENV_PREFIX}WHISPER_MODEL`
export const VIDEO_WHISPER_MODEL_SMALL_ENV = `${VIDEO_ENV_PREFIX}WHISPER_MODEL_SMALL`

export interface VideoCliPaths {
  /** まとめた CLI（out/video-cli/ferret-video.mjs） */
  bundle: string
  /** 組み込みテンプレート（out/video-cli/templates） */
  templatesDir: string
  /** ラッパーを書くフォルダ（<userData>/video-cli/bin） */
  binDir: string
}

export function videoCliPaths(ctx: Pick<VideoMainContext, 'appOutDir' | 'userDataDir'>): VideoCliPaths {
  return {
    bundle: join(ctx.appOutDir, 'video-cli', `${VIDEO_CLI}.mjs`),
    templatesDir: join(ctx.appOutDir, 'video-cli', 'templates'),
    binDir: join(ctx.userDataDir, 'video-cli', 'bin')
  }
}

/** sh の1語にする（'…' で囲み、中の ' は '\'' にする） */
export function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}

/** POSIX のラッパー。bundle は絶対パス（ラッパーは userData 側、本体はアプリの中にあるため） */
export function posixWrapper(bundle: string): string {
  return `#!/bin/sh
# ${VIDEO_CLI}: Ferret の Electron（Node として）か、PATH の node で動画づくりの CLI を動かす。Ferret が起動ごとに書き直す。
SCRIPT=${shQuote(bundle)}
if [ -n "$${VIDEO_ELECTRON_ENV}" ] && [ -x "$${VIDEO_ELECTRON_ENV}" ]; then
  ELECTRON_RUN_AS_NODE=1 exec "$${VIDEO_ELECTRON_ENV}" "$SCRIPT" "$@"
fi
exec node "$SCRIPT" "$@"
`
}

/** cmd.exe のラッパー（CRLF）。% は %% にしないと変数として読まれる */
export function cmdWrapper(bundle: string): string {
  const script = bundle.replace(/%/g, '%%')
  const e = VIDEO_ELECTRON_ENV
  return [
    '@echo off',
    `rem ${VIDEO_CLI}: runs the video CLI with Ferret's Electron (as Node) when available, else with node from PATH.`,
    'setlocal',
    `set "SCRIPT=${script}"`,
    `if not defined ${e} goto node`,
    `if not exist "%${e}%" goto node`,
    'set "ELECTRON_RUN_AS_NODE=1"',
    `"%${e}%" "%SCRIPT%" %*`,
    'exit /b %ERRORLEVEL%',
    ':node',
    'node "%SCRIPT%" %*',
    'exit /b %ERRORLEVEL%',
    ''
  ].join('\r\n')
}

export interface WhisperForCli {
  cli?: string | null
  /** large-v3-turbo など（CLI の whisper-model） */
  model?: string | null
  /** small（CLI の whisper-model-small） */
  modelSmall?: string | null
}

/** タブ・runVideoCli へ渡す環境変数を組み立てる（純粋） */
export function buildVideoEnv(o: { binDir?: string | null; electron?: string | null; templatesDir?: string | null; whisper?: WhisperForCli }): Record<string, string> {
  const env: Record<string, string> = {}
  if (o.binDir) env[VIDEO_BIN_ENV] = o.binDir
  if (o.electron) env[VIDEO_ELECTRON_ENV] = o.electron
  if (o.templatesDir) env[VIDEO_TEMPLATES_ENV] = o.templatesDir
  if (o.whisper?.cli) env[VIDEO_WHISPER_CLI_ENV] = o.whisper.cli
  if (o.whisper?.model) env[VIDEO_WHISPER_MODEL_ENV] = o.whisper.model
  if (o.whisper?.modelSmall) env[VIDEO_WHISPER_MODEL_SMALL_ENV] = o.whisper.modelSmall
  return env
}

/**
 * Ferret が文字起こしに使っているモデルを、CLI の2つの枠（large / small）に振り分ける（重複ダウンロードを避ける）。
 * 探す順は src/main/index.ts の localModel() と同じ: ADE_WHISPER_MODEL → userData/models の large-v3-turbo → ~/.cache/ade-movie の small。
 */
export function ferretWhisperModels(o: { adeWhisperModel?: string; userDataDir: string; home: string; exists: (p: string) => boolean }): Pick<WhisperForCli, 'model' | 'modelSmall'> {
  const out: Pick<WhisperForCli, 'model' | 'modelSmall'> = {}
  const put = (p: string): void => {
    if (!o.exists(p)) return
    if (/small/i.test(p.split(/[\\/]/).pop() ?? '')) out.modelSmall ??= p
    else out.model ??= p
  }
  if (o.adeWhisperModel) put(o.adeWhisperModel)
  put(join(o.userDataDir, 'models', 'ggml-large-v3-turbo.bin'))
  put(join(o.home, '.cache', 'ade-movie', 'models', 'ggml-small.bin'))
  return out
}

/** ラッパーを書く（POSIX は実行権限つき）。毎回書き直す（アプリの場所が変わっても追いつく） */
export async function writeVideoCliWrappers(binDir: string, bundle: string, platform: NodeJS.Platform = process.platform): Promise<void> {
  await mkdir(binDir, { recursive: true })
  await writeFile(join(binDir, `${VIDEO_CLI}.cmd`), cmdWrapper(bundle), 'utf8')
  if (platform !== 'win32') {
    const sh = join(binDir, VIDEO_CLI)
    await writeFile(sh, posixWrapper(bundle), { encoding: 'utf8', mode: 0o755 })
    await chmod(sh, 0o755)
  }
}

/** Ferret の whisper-cli（同梱 → PATH → Homebrew などの既定の場所）。見つからなければ null */
async function ferretWhisperCli(ctx: Pick<VideoMainContext, 'isPackaged'>): Promise<string | null> {
  try {
    const { nodeProbes, resolveWhisperBinary } = await import('../../../../main/pipeline/environment')
    return await resolveWhisperBinary({ modelDir: '', ...(ctx.isPackaged ? { resourcesDir: process.resourcesPath } : {}) }, nodeProbes(null))
  } catch {
    return null
  }
}

/** 起動中に1回だけ書く・探す（タブを開くたびにやり直さない） */
let prepared: Promise<Record<string, string>> | null = null

/** アプリ全体で共通の値（テンプレート・whisper・Electron）。runVideoCli も使う */
export function videoCliBaseEnv(ctx: VideoMainContext): Promise<Record<string, string>> {
  prepared ??= (async () => {
    const paths = videoCliPaths(ctx)
    let binDir: string | null = paths.binDir
    try {
      await writeVideoCliWrappers(paths.binDir, paths.bundle)
    } catch (err) {
      binDir = null
      ctx.reportHandled(err, { area: 'video', op: 'cli-wrappers' })
    }
    const whisper: WhisperForCli = {
      cli: await ferretWhisperCli(ctx),
      ...ferretWhisperModels({ adeWhisperModel: process.env.ADE_WHISPER_MODEL, userDataDir: ctx.userDataDir, home: homedir(), exists: existsSync })
    }
    return buildVideoEnv({
      binDir,
      electron: process.execPath,
      templatesDir: existsSync(paths.templatesDir) ? paths.templatesDir : null,
      whisper
    })
  })()
  return prepared
}

export async function videoTerminalEnv(ctx: VideoMainContext): Promise<Record<string, string>> {
  return { ...(await videoCliBaseEnv(ctx)) }
}

/** テスト用: 次の呼び出しで書き直す */
export function resetVideoCliEnvForTest(): void {
  prepared = null
}
