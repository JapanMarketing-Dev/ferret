/**
 * LibreOffice（soffice）で Office の文書の形式を変える（.xls → .xlsx・編集した .xlsx → .xls など）。
 *
 * - soffice は決まった置き場所（/Applications/LibreOffice.app・Homebrew・Program Files・/usr/bin など）と、
 *   PATH の絶対パスのうちプロジェクトの外のものだけから探す（プロジェクトの中に置かれた soffice は動かさない）
 * - 変える前に、中身を作業フォルダへ写してから渡す（プロジェクトのパス・ファイル名をコマンドに渡さない。
 *   `-` で始まる名前や、変えている間の差し替えの影響を受けない）
 * - soffice は同じ利用者の設定（UserInstallation）を2つ同時に使えないので、専用の設定を作業フォルダに置き、1つずつ順に動かす。
 *   利用者が開いている LibreOffice とも混ざらない
 * - 決まった時間を過ぎたら止める。結果はパス・大きさ・更新日時ごとに覚え（ディスクの作業フォルダ）、同じものは変え直さない
 */
import { spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { constants as fsConstants } from 'node:fs'
import { access, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { delimiter, join, posix } from 'node:path'
import { pathToFileURL } from 'node:url'
import { resolveTrustedExecutable } from './agentExecutable'

/** 1回の変換の待ち時間の上限（初めての起動は設定を作るので数秒かかる） */
export const CONVERT_TIMEOUT_MS = 120_000
/** 覚えておく変換の結果の数 */
const CACHE_ENTRIES = 24
/** 見つからなかったときに探し直すまでの間（入れた直後に開き直せるよう短く） */
const MISSING_RECHECK_MS = 15_000

export class SofficeMissingError extends Error {
  constructor() {
    super('LibreOffice (soffice) was not found')
  }
}

export class ConvertFailedError extends Error {}

/** soffice のよくある置き場所（上から順に使う） */
export function sofficeCandidates(platform: NodeJS.Platform, env: NodeJS.ProcessEnv, home: string): string[] {
  if (platform === 'darwin') {
    return [
      '/Applications/LibreOffice.app/Contents/MacOS/soffice',
      posix.join(home, 'Applications/LibreOffice.app/Contents/MacOS/soffice'),
      '/opt/homebrew/bin/soffice',
      '/usr/local/bin/soffice'
    ]
  }
  if (platform === 'win32') {
    const roots = [env.ProgramFiles, env['ProgramFiles(x86)'], env.ProgramW6432, 'C:\\Program Files', 'C:\\Program Files (x86)']
      .filter((r): r is string => Boolean(r))
    return [...new Set(roots)].map((r) => `${r.replace(/[\\/]+$/, '')}\\LibreOffice\\program\\soffice.exe`)
  }
  return [
    '/usr/bin/soffice', '/usr/bin/libreoffice', '/usr/local/bin/soffice', '/usr/local/bin/libreoffice',
    '/usr/lib/libreoffice/program/soffice', '/opt/libreoffice/program/soffice', '/snap/bin/libreoffice',
    '/var/lib/flatpak/exports/bin/org.libreoffice.LibreOffice'
  ]
}

async function isExecutableFile(path: string): Promise<boolean> {
  try {
    const info = await stat(path)
    if (!info.isFile()) return false
    if (process.platform !== 'win32') await access(path, fsConstants.X_OK)
    return true
  } catch {
    return false
  }
}

export interface FindSofficeOptions {
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
  home?: string
  /** いまのプロジェクト（PATH にこの中のフォルダがあっても使わない） */
  root?: string
  isExecutable?: (path: string) => Promise<boolean>
  /** PATH も探す（既定は探す） */
  searchPath?: boolean
}

/** soffice の絶対パス。無ければ null */
export async function findSoffice(options: FindSofficeOptions = {}): Promise<string | null> {
  const platform = options.platform ?? process.platform
  const env = options.env ?? process.env
  const home = options.home ?? env.HOME ?? env.USERPROFILE ?? ''
  const check = options.isExecutable ?? isExecutableFile
  for (const candidate of sofficeCandidates(platform, env, home)) if (await check(candidate)) return candidate
  if (options.searchPath === false) return null
  // PATH（Finder から起動すると PATH は短いので、上の決まった場所を先に見る）
  for (const head of platform === 'win32' ? ['soffice.exe', 'soffice'] : ['soffice', 'libreoffice']) {
    const dirs = platform === 'win32' ? undefined : (env.PATH ?? '').split(delimiter)
    const found = await resolveTrustedExecutable(head, { env, cwd: options.root ?? process.cwd(), dirs }).catch(() => null)
    if (found?.ok && !/\.(cmd|bat)$/i.test(found.path)) return found.path
  }
  return null
}

/** 変換の行き先の指定（`xlsx` のような拡張子だけ・`xls:MS Excel 97` のような書き出しの名前付き）から、できるファイルの拡張子 */
export function targetExtension(target: string): string {
  const ext = target.split(':')[0]!.trim().toLowerCase()
  if (!/^[a-z0-9]{1,8}$/.test(ext)) throw new ConvertFailedError(`bad conversion target: ${target}`)
  return ext
}

/** OOXML へ変えるときの書き出しの名前（はっきり指定する。拡張子だけだと別の形式を選ぶ版がある） */
export const OOXML_TARGETS = {
  docx: 'docx:MS Word 2007 XML',
  xlsx: 'xlsx:Calc MS Excel 2007 XML',
  pptx: 'pptx:Impress MS PowerPoint 2007 XML'
} as const

export function sofficeArgs(profileDir: string, target: string, outDir: string, input: string): string[] {
  return [
    `-env:UserInstallation=${pathToFileURL(profileDir).href}`,
    '--headless', '--invisible', '--norestore', '--nologo', '--nodefault', '--nolockcheck',
    '--convert-to', target, '--outdir', outDir, input
  ]
}

export type RunProcess = (command: string, args: string[], timeoutMs: number) => Promise<{ code: number | null; timedOut: boolean; stderr: string }>

const runProcess: RunProcess = (command, args, timeoutMs) => new Promise((resolve, reject) => {
  const child = spawn(command, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true, detached: process.platform !== 'win32' })
  let stderr = ''
  let timedOut = false
  child.stderr?.on('data', (chunk: Buffer) => { if (stderr.length < 4000) stderr += chunk.toString('utf8') })
  const timer = setTimeout(() => {
    timedOut = true
    // 子のプロセス（oosplash → soffice.bin）ごと止める
    try {
      if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL')
      else child.kill('SIGKILL')
    } catch {
      child.kill('SIGKILL')
    }
  }, timeoutMs)
  child.on('error', (err) => { clearTimeout(timer); reject(err) })
  child.on('close', (code) => { clearTimeout(timer); resolve({ code, timedOut, stderr }) })
})

export interface OfficeConverterOptions {
  /** 作業フォルダ（設定・変換の途中・覚えた結果） */
  workDir: string
  locate: () => Promise<string | null>
  run?: RunProcess
  timeoutMs?: number
}

export class OfficeConverter {
  private readonly workDir: string
  private readonly locate: () => Promise<string | null>
  private readonly run: RunProcess
  private readonly timeoutMs: number
  private queue: Promise<unknown> = Promise.resolve()
  private located: { path: string | null; at: number } | null = null
  /** 覚えた結果（キー → 作業フォルダのファイル）。古い順 */
  private readonly cache = new Map<string, string>()
  private cacheReady: Promise<void> | null = null

  constructor(options: OfficeConverterOptions) {
    this.workDir = options.workDir
    this.locate = options.locate
    this.run = options.run ?? runProcess
    this.timeoutMs = options.timeoutMs ?? CONVERT_TIMEOUT_MS
  }

  /** soffice の場所（見つからなければ null。少しの間覚える） */
  async soffice(): Promise<string | null> {
    const hit = this.located
    if (hit && (hit.path || Date.now() - hit.at < MISSING_RECHECK_MS)) return hit.path
    const path = await this.locate()
    this.located = { path, at: Date.now() }
    return path
  }

  async available(): Promise<boolean> {
    return (await this.soffice()) !== null
  }

  /**
   * input（拡張子 inputExt の中身）を target（`xlsx`・`xls:MS Excel 97` など）へ変える。
   * cacheKey を渡すと、同じキーの結果を覚えて使い回す
   */
  convert(input: Uint8Array, inputExt: string, target: string, cacheKey?: string): Promise<Uint8Array> {
    const job = this.queue.then(() => this.convertNow(input, inputExt, target, cacheKey))
    // 失敗しても次の変換は続ける
    this.queue = job.catch(() => undefined)
    return job
  }

  private async prepareCache(): Promise<void> {
    // 前の起動の結果は捨てる（どの文書のものか覚えていない）
    this.cacheReady ??= rm(join(this.workDir, 'cache'), { recursive: true, force: true }).then(() => mkdir(join(this.workDir, 'cache'), { recursive: true })).then(() => undefined)
    await this.cacheReady
  }

  private async convertNow(input: Uint8Array, inputExt: string, target: string, cacheKey?: string): Promise<Uint8Array> {
    const outExt = targetExtension(target)
    if (!/^\.[a-z0-9]{1,8}$/i.test(inputExt)) throw new ConvertFailedError(`bad input extension: ${inputExt}`)
    await this.prepareCache()
    const key = cacheKey ? createHash('sha256').update(`${cacheKey}\n${target}`).digest('hex') : null
    if (key) {
      const cached = this.cache.get(key)
      if (cached) {
        const bytes = await readFile(cached).catch(() => null)
        if (bytes) {
          // 使ったものを新しい側へ
          this.cache.delete(key)
          this.cache.set(key, cached)
          return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.length)
        }
        this.cache.delete(key)
      }
    }
    const soffice = await this.soffice()
    if (!soffice) throw new SofficeMissingError()
    const job = join(this.workDir, `job-${randomBytes(6).toString('hex')}`)
    const outDir = join(job, 'out')
    await mkdir(outDir, { recursive: true })
    try {
      const source = join(job, `document${inputExt.toLowerCase()}`)
      await writeFile(source, input, { mode: 0o600 })
      const result = await this.run(soffice, sofficeArgs(join(this.workDir, 'profile'), target, outDir, source), this.timeoutMs)
      if (result.timedOut) throw new ConvertFailedError('conversion timed out')
      const output = join(outDir, `document.${outExt}`)
      const bytes = await readFile(output).catch(() => null)
      if (!bytes || bytes.length === 0) throw new ConvertFailedError(`conversion failed (exit ${result.code ?? 'signal'})${result.stderr ? `: ${result.stderr.trim().slice(0, 300)}` : ''}`)
      if (key) await this.remember(key, outExt, bytes)
      return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.length)
    } finally {
      await rm(job, { recursive: true, force: true }).catch(() => undefined)
    }
  }

  private async remember(key: string, ext: string, bytes: Uint8Array): Promise<void> {
    const file = join(this.workDir, 'cache', `${key}.${ext}`)
    try {
      await writeFile(file, bytes, { mode: 0o600 })
    } catch {
      return
    }
    this.cache.delete(key)
    this.cache.set(key, file)
    while (this.cache.size > CACHE_ENTRIES) {
      const [oldest, path] = this.cache.entries().next().value as [string, string]
      this.cache.delete(oldest)
      await rm(path, { force: true }).catch(() => undefined)
    }
  }
}
