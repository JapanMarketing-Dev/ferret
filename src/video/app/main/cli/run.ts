import { VIDEO_BIN_ENV } from '@video/names'
import type { VideoMainContext } from '../context'
import { videoCliBaseEnv } from './env'

/**
 * main の中から `ferret-video` を呼ぶ（担当: CLI）。子プロセスを作らず、同じプロセスで CLI の main() を動かす。
 * 動画の一覧・新しい動画・取り込み（ingest）・状態（status --json）など、アプリが CLI と同じ処理をしたいときに使う。
 * CLI のコードは重い（zod・yaml・ffmpeg の呼び出し）ので、初めて呼んだときに読み込む。
 *
 * 環境変数: CLI の io.env は process.env に options.env を重ねたもの。
 * ただしツールの場所・組み込みテンプレート・FERRET_VIDEO_HOME など、CLI の奥で process.env を直接読む値は
 * 呼び出しごとには変えられない。アプリ全体で共通の値（configureVideoCli で渡した ctx から作るもの）を、
 * process.env に無いときだけ入れる。
 */
export interface VideoCliResult {
  code: number
  stdout: string
  stderr: string
}

export interface RunVideoCliOptions {
  cwd: string
  env?: Record<string, string | undefined>
  /** stderr を届いた順に受け取る（--json のときは `{"progress":…}` の行。取り込みの進み具合に使える） */
  onStderr?: (chunk: string) => void
}

type CliModule = typeof import('@video/cli')

let cliModule: Promise<CliModule> | null = null
let baseEnv: (() => Promise<Record<string, string>>) | null = null

/** main の起動時に1回呼ぶ（テンプレートの場所・whisper を決めるため）。呼ばないと組み込みテンプレートが見つからないことがある */
export function configureVideoCli(ctx: VideoMainContext): void {
  baseEnv = () => videoCliBaseEnv(ctx)
}

/** テスト用: 共通の値を差し替える（null で無しに戻す） */
export function setVideoCliBaseEnvForTest(env: Record<string, string> | null): void {
  baseEnv = env ? async () => env : null
}

/** 共通の値のうち、まだ process.env に無いものを入れる（PATH へ移す bin の変数は入れない） */
export function applyProcessDefaults(env: Record<string, string>, target: NodeJS.ProcessEnv = process.env): void {
  for (const [k, v] of Object.entries(env)) {
    if (k === VIDEO_BIN_ENV) continue
    if (target[k] === undefined || target[k] === '') target[k] = v
  }
}

export async function runVideoCli(argv: string[], options: RunVideoCliOptions): Promise<VideoCliResult> {
  let stdout = ''
  let stderr = ''
  const err = (s: string): void => {
    stderr += s
    options.onStderr?.(s)
  }
  try {
    if (baseEnv) applyProcessDefaults(await baseEnv())
    cliModule ??= import('@video/cli')
    const { main } = await cliModule.catch((e: unknown) => {
      cliModule = null
      throw e
    })
    const env: NodeJS.ProcessEnv = { ...process.env }
    for (const [k, v] of Object.entries(options.env ?? {})) {
      if (v === undefined) delete env[k]
      else env[k] = v
    }
    const code = await main(argv, {
      cwd: options.cwd,
      env,
      stdout: (s) => {
        stdout += s
      },
      stderr: err,
      isTTY: false
    })
    return { code, stdout, stderr }
  } catch (e) {
    // main() は自分のエラーを code で返す。ここへ来るのは読み込みの失敗などの想定外のもの
    err(`ferret-video: ${(e as Error)?.stack ?? String(e)}\n`)
    return { code: 1, stdout, stderr }
  }
}
