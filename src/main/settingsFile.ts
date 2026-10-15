import { randomBytes } from 'node:crypto'
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, watch, writeFileSync, type FSWatcher } from 'node:fs'
import { homedir } from 'node:os'
import { basename, isAbsolute, join, resolve } from 'node:path'
import type { ProjectSession, Settings, SettingsFileError } from '@shared/types'
import { LEGACY_KEYS, SETTINGS_SCHEMA, STATE_KEYS, knownSettingsKeys, settingsSchemaText, validateAgainstSchema } from '@shared/settingsSchema'

/**
 * settings.json（利用者の設定）と state.json（再起動で戻す作業の状態）の読み書き。
 * Electron に依存させない（単体テストで一時フォルダを使うため）。パスの決定も呼び出し側から値を渡す。
 *
 * - 置き場所はどの OS でも同じ ~/.ferret。FERRET_CONFIG_DIR（旧 MOVIE_ADE_CONFIG_DIR）で上書きできる（resolveConfigDir）
 *   改名前の ~/.movie-ade は初回に写して残す（migrateLegacyConfigDir）
 * - 設定は人と Agent が直接書き換える前提。外部の変更は監視して取り込み、壊れていれば取り込まず、
 *   利用者のファイルも上書きしない（直るまでアプリからの保存は state.json だけ）
 * - 保存は一時ファイル＋rename で原子的に行う。知らない上の階層の項目はそのまま残す
 * - 自分の書き込みは中身で見分け、取り込み直さない（読み込みのループを起こさない）
 */

const SETTINGS_FILE = 'settings.json'
export const STATE_FILE = 'state.json'
const SCHEMA_FILE = 'settings.schema.json'
const SCHEMA_REF = `./${SCHEMA_FILE}`
const CONFIG_DIR_ENV = 'FERRET_CONFIG_DIR'
/** @deprecated 改名前の名前。FERRET_CONFIG_DIR が無いときだけ読む */
const LEGACY_CONFIG_DIR_ENV = 'MOVIE_ADE_CONFIG_DIR'
const CONFIG_DIR_NAME = '.ferret'
/** 改名前（MOVIE-ADE）の設定フォルダ。読むだけで書かない（写したあともバックアップとして残す） */
const LEGACY_CONFIG_DIR_NAME = '.movie-ade'
/** 写し終えた印。旧フォルダに置く（これがあれば、新しいフォルダを消しても写し直さない） */
export const MIGRATED_MARKER = 'MIGRATED-TO-FERRET.txt'
/** 改名のときに写すもの（settings.schema.json はアプリが書き直すので写さない） */
const MIGRATED_ENTRIES = [SETTINGS_FILE, STATE_FILE, 'usage', '.env'] as const

type BuildKind = 'dev' | 'packaged'

/**
 * 1度だけの片付け: 開発版の判定を誤っていた版（bd1d49b）の dev 起動は ~/.movie-ade 直下に書いた。
 * dev 起動で dev/ がまだ無く、直下の state.json に書いた版の印（writtenBy）が無ければ、それは dev が書いたものとみなして
 * settings.json・state.json・settings.schema.json を dev/ へ移す。元はバックアップのフォルダに写しを残す。
 * 印が packaged のもの（配布版が書いたもの）には触れない。移したら移した先のフォルダを返す。
 */
export function relocateMisplacedDevConfig(opt: { root: string; devDir: string; now?: Date }): string | null {
  if (existsSync(opt.devDir)) return null
  const rootState = join(opt.root, STATE_FILE)
  if (!existsSync(join(opt.root, SETTINGS_FILE)) || !existsSync(rootState)) return null
  let state: { writtenBy?: unknown }
  try { state = JSON.parse(readFileSync(rootState, 'utf8')) as { writtenBy?: unknown } } catch { return null }
  if (state.writtenBy !== undefined) return null
  const stamp = (opt.now ?? new Date()).toISOString().replace(/[:.]/g, '-')
  const backup = join(opt.root, `backup-dev-relocate-${stamp}`)
  mkdirSync(backup, { recursive: true })
  mkdirSync(opt.devDir, { recursive: true })
  for (const name of [SETTINGS_FILE, STATE_FILE, SCHEMA_FILE]) {
    const from = join(opt.root, name)
    if (!existsSync(from)) continue
    copyFileSync(from, join(backup, name))
    renameSync(from, join(opt.devDir, name))
  }
  return opt.devDir
}

/**
 * 設定フォルダを決める。
 *   1. FERRET_CONFIG_DIR、無ければ MOVIE_ADE_CONFIG_DIR（~ で始まればホームに展開）
 *   2. E2E・--user-data-dir の起動は、その userData の下（本物の ~/.ferret・~/.movie-ade に触れない）
 *   3. 配布版は ~/.ferret、dev 起動は ~/.ferret/dev（開発中の変更で本物の設定を壊さない）
 */
export function resolveConfigDir(opt: { env: NodeJS.ProcessEnv; home?: string; isPackaged: boolean; isolatedUserData?: string | null }): string {
  const home = opt.home ?? homedir()
  const override = configDirOverride(opt.env)
  if (override) {
    const expanded = override === '~' ? home : override.startsWith('~/') || override.startsWith('~\\') ? join(home, override.slice(2)) : override
    return isAbsolute(expanded) ? expanded : resolve(expanded)
  }
  if (opt.isolatedUserData) return join(opt.isolatedUserData, 'config')
  return opt.isPackaged ? join(home, CONFIG_DIR_NAME) : join(home, CONFIG_DIR_NAME, 'dev')
}

/** 設定フォルダの上書きの指定（新しい名前を優先）。空なら undefined */
export function configDirOverride(env: NodeJS.ProcessEnv): string | undefined {
  return env[CONFIG_DIR_ENV]?.trim() || env[LEGACY_CONFIG_DIR_ENV]?.trim() || undefined
}

/** 改名前の既定の設定フォルダ（~/.movie-ade、dev は ~/.movie-ade/dev）。写す元 */
export function legacyConfigDir(opt: { home?: string; isPackaged: boolean }): string {
  const home = opt.home ?? homedir()
  return opt.isPackaged ? join(home, LEGACY_CONFIG_DIR_NAME) : join(home, LEGACY_CONFIG_DIR_NAME, 'dev')
}

/**
 * 改名（MOVIE-ADE → Ferret）の1度だけの引っ越し。新しいフォルダ（to）にまだ settings.json も state.json も無く、
 * 旧フォルダ（from）に写すものがあり、写し終えた印が無ければ、settings.json・state.json・usage/・.env を写す。
 * 旧フォルダはバックアップとして残し（消さない・動かさない）、印だけを置く。
 * to のフォルダ自体はあってよい（配布版の ~/.ferret は、先に起動した dev が ~/.ferret/dev を作ると既にある）。
 * 隣の一時フォルダに写してから1つずつ rename し、settings.json と state.json を最後にする（途中で落ちても次の起動でやり直せる）。
 * to に既にあるものは上書きしない。写したら to を返す。何もしなければ null。
 */
export function migrateLegacyConfigDir(opt: { from: string; to: string; now?: Date }): string | null {
  if (existsSync(join(opt.to, SETTINGS_FILE)) || existsSync(join(opt.to, STATE_FILE))) return null
  if (!existsSync(opt.from) || existsSync(join(opt.from, MIGRATED_MARKER))) return null
  const entries = MIGRATED_ENTRIES.filter((name) => existsSync(join(opt.from, name)))
  if (entries.length === 0) return null
  const tmp = `${opt.to}.migrating-${process.pid}`
  rmSync(tmp, { recursive: true, force: true })
  mkdirSync(tmp, { recursive: true })
  try {
    for (const name of entries) cpSync(join(opt.from, name), join(tmp, name), { recursive: true, preserveTimestamps: true })
    mkdirSync(opt.to, { recursive: true })
    const last = new Set<string>([SETTINGS_FILE, STATE_FILE])
    for (const name of [...entries.filter((n) => !last.has(n)), ...entries.filter((n) => last.has(n))]) {
      if (!existsSync(join(opt.to, name))) renameSync(join(tmp, name), join(opt.to, name))
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
  const stamp = (opt.now ?? new Date()).toISOString()
  writeFileSync(join(opt.from, MIGRATED_MARKER),
    `MOVIE-ADE was renamed to Ferret. On ${stamp} these files were copied to ${opt.to}:\n${entries.join('\n')}\n` +
    'This folder is kept as a backup. Ferret no longer reads it; you can delete it once you no longer need it.\n', 'utf8')
  return opt.to
}

/** 作業の状態（state.json）。設定ではないので利用者が書き換える前提にしない */
interface PersistedState {
  version: 1
  folderPath: string | null
  url: string
  viewport: Settings['viewport']
  activeProjectId: string | null
  /** プロジェクトごとの開いていたタブ・URL（project.id → session） */
  sessions: Record<string, ProjectSession>
  /** GitHub の star のお願いを出した回数など（src/shared/starPrompt.ts）。設定ではないので settings.json に出さない */
  starPrompt?: Settings['starPrompt']
  /** 書いたのが開発版か配布版か（relocateMisplacedDevConfig が見る） */
  writtenBy?: BuildKind
}

/** 上の階層の並び。人が読みやすい順に書く（無いものは飛ばす。残りは後ろへ） */
const KEY_ORDER = ['$schema', 'theme', 'locale', 'projects', 'agents', 'agentPrompt', 'agentAccounts', 'capture', 'whisperModel', 'organizer',
  'layout', 'splitRatio', 'feedbackTargets', 'browserExtensions', 'crashReports', 'crashReportsNoticeShown', 'autoUpdate', 'mobileRemote', 'onboarding']

/** 実行中の設定を、settings.json に書く設定と state.json に書く状態へ分ける */
export function splitSettings(settings: Settings): { config: Record<string, unknown>; state: PersistedState } {
  const sessions: Record<string, ProjectSession> = {}
  const projects = settings.projects.map(({ session, ...project }) => {
    if (session) sessions[project.id] = session
    return project
  })
  const config: Record<string, unknown> = {}
  const drop = new Set<string>([...STATE_KEYS, ...LEGACY_KEYS])
  for (const [key, value] of Object.entries(settings)) {
    if (drop.has(key) || value === undefined) continue
    config[key] = key === 'projects' ? projects : value
  }
  return {
    config,
    state: { version: 1, folderPath: settings.folderPath, url: settings.url, viewport: settings.viewport, activeProjectId: settings.activeProjectId, sessions,
      ...(settings.starPrompt ? { starPrompt: settings.starPrompt } : {}) }
  }
}

/** 書きかけの settings.json を読んだときの読み直しの間隔（合計 0.3秒） */
const PARTIAL_READ_RETRIES = [50, 100, 150] as const

/** settings.json と state.json を、sanitize に渡す1つの値へ戻す。状態側に無い項目は設定側（移行前の古いファイル）の値を使う */
export function mergeSettings(config: Record<string, unknown>, state: unknown): Record<string, unknown> {
  const s = (state && typeof state === 'object' ? state : {}) as Partial<PersistedState>
  const merged: Record<string, unknown> = { ...config }
  for (const key of STATE_KEYS) if (key in s) merged[key] = s[key]
  const sessions = s.sessions && typeof s.sessions === 'object' ? s.sessions : {}
  if (Array.isArray(config.projects)) {
    merged.projects = config.projects.map((p) => {
      if (!p || typeof p !== 'object') return p
      const id = (p as { id?: unknown }).id
      const session = typeof id === 'string' ? sessions[id] : undefined
      return session ? { ...p, session } : p
    })
  }
  return merged
}

/** 0 始まりの文字位置を 1 始まりの行・列にする */
function lineColumn(text: string, position: number): { line: number; column: number } {
  const before = text.slice(0, Math.max(0, Math.min(position, text.length)))
  const lines = before.split('\n')
  return { line: lines.length, column: lines[lines.length - 1].length + 1 }
}

/** スキーマの違反の場所（/capture/keepDays）から、だいたいの行を探す */
function lineOfPath(text: string, path: string): number | undefined {
  let pos = -1
  for (const segment of path.split('/').filter(Boolean)) {
    if (/^\d+$/.test(segment)) continue
    const next = text.indexOf(JSON.stringify(segment), pos + 1)
    if (next < 0) break
    pos = next
  }
  return pos < 0 ? undefined : lineColumn(text, pos).line
}

/**
 * JSON の最初の誤りの位置（0 始まり）。V8 の JSON.parse は位置を出さないことがあるので、小さな読み取りで探す。
 * 正しい JSON なら -1。
 */
function jsonErrorPosition(text: string): number {
  let i = 0
  const ws = () => { while (i < text.length && ' \t\n\r'.includes(text[i]!)) i++ }
  const fail = (): never => { throw i }
  const literal = (word: string) => { if (text.startsWith(word, i)) i += word.length; else fail() }
  const string = () => {
    i++
    while (i < text.length && text[i] !== '"') {
      if (text[i] === '\\') i++
      else if (text.charCodeAt(i) < 0x20) fail()
      i++
    }
    if (i >= text.length) fail()
    i++
  }
  const number = () => {
    const m = /^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?/.exec(text.slice(i))
    if (!m) fail()
    i += m![0].length
  }
  const value = (): void => {
    ws()
    const c = text[i]
    if (c === '{') {
      i++; ws()
      if (text[i] === '}') { i++; return }
      for (;;) {
        ws(); if (text[i] !== '"') fail()
        string(); ws()
        if (text[i] !== ':') fail()
        i++; value(); ws()
        if (text[i] === ',') { i++; continue }
        if (text[i] === '}') { i++; return }
        fail()
      }
    }
    if (c === '[') {
      i++; ws()
      if (text[i] === ']') { i++; return }
      for (;;) {
        value(); ws()
        if (text[i] === ',') { i++; continue }
        if (text[i] === ']') { i++; return }
        fail()
      }
    }
    if (c === '"') return string()
    if (c === 't') return literal('true')
    if (c === 'f') return literal('false')
    if (c === 'n') return literal('null')
    return number()
  }
  try {
    value(); ws()
    return i < text.length ? i : -1
  } catch (pos) {
    return typeof pos === 'number' ? pos : 0
  }
}

/** エラーに載せるスキーマの違反の件数の上限（AI への修正依頼に並べる分。残りは Agent がスキーマと照らして見つける） */
export const SETTINGS_ERROR_ISSUE_LIMIT = 20

type ParsedSettings = { ok: true; value: Record<string, unknown> } | { ok: false; error: SettingsFileError }

/** settings.json の文字列を読む。JSON の誤り・スキーマの違反は、行つきのエラーにする */
export function parseSettingsText(text: string): ParsedSettings {
  let value: unknown
  try {
    value = JSON.parse(text.replace(/^﻿/, ''))
  } catch (err) {
    // V8 は「Unexpected token '}', ..."locale": }" is not valid JSON」のように中身を引用するので、引用を落とす（行と列は別に出す）
    const message = (err instanceof Error ? err.message : String(err)).replace(/,\s*(\.\.\.)?"[\s\S]*$/, '')
    const lc = /line (\d+) column (\d+)/.exec(message)
    const pos = /position (\d+)/.exec(message)
    const source = text.replace(/^\uFEFF/, '')
    const where = lc ? { line: Number(lc[1]), column: Number(lc[2]) } : lineColumn(source, pos ? Number(pos[1]) : Math.max(0, jsonErrorPosition(source)))
    return { ok: false, error: { kind: 'parse', message: text.trim() ? message : 'The file is empty.', ...where } }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, error: { kind: 'schema', message: 'The top level must be a JSON object.', path: '/', line: 1 } }
  }
  const issues = validateAgainstSchema(value, SETTINGS_SCHEMA)
  if (issues.length) {
    const listed = issues.slice(0, SETTINGS_ERROR_ISSUE_LIMIT).map((issue) => {
      const at = lineOfPath(text, issue.path)
      return { path: issue.path, message: issue.message, ...(at ? { line: at } : {}) }
    })
    const first = listed[0]
    return { ok: false, error: { kind: 'schema', message: `${first.path}: ${first.message}${issues.length > 1 ? ` (+${issues.length - 1} more)` : ''}`, path: first.path, ...(first.line ? { line: first.line } : {}), issues: listed } }
  }
  return { ok: true, value: value as Record<string, unknown> }
}

/** Windows で、他のプロセス（ウイルス対策・エディタ・Agent・索引）が開いている間だけ起きる失敗 */
const TRANSIENT_FS_CODES = new Set(['EBUSY', 'EPERM', 'EACCES', 'EAGAIN'])

export function isTransientFsError(err: unknown): boolean {
  return TRANSIENT_FS_CODES.has(String((err as NodeJS.ErrnoException | null)?.code ?? ''))
}

/** main を止めずに待てる長さの同期の待ち（数十ミリ秒だけ） */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/** 一時的な失敗のやり直しの間隔（合計 約0.75秒） */
export const TRANSIENT_RETRY_DELAYS_MS = [25, 50, 100, 200, 375] as const

interface RetryOptions {
  /** 既定は process.platform。やり直すのは win32 だけ（他の OS の EACCES・EPERM は本当の権限の問題） */
  platform?: NodeJS.Platform
  sleep?: (ms: number) => void
}

/**
 * Windows の一時的な失敗（EBUSY・EPERM・EACCES）は少し待ってやり直す。
 * Windows では、置き換え先・読む先を他のプロセスが開いている間（ウイルス対策の検査・エディタ・Agent の読み取り）は rename や読み取りが失敗する。
 * 1度で諦めると、保存が落ちて再起動でプロジェクトが消えたように見えたり（issue #5）、起動時に読めずに空の一覧で始まったりした
 */
export function retryTransientSync<T>(run: () => T, opt: RetryOptions = {}): T {
  const retry = (opt.platform ?? process.platform) === 'win32'
  const sleep = opt.sleep ?? sleepSync
  for (let attempt = 0; ; attempt++) {
    try {
      return run()
    } catch (err) {
      if (!retry || !isTransientFsError(err) || attempt >= TRANSIENT_RETRY_DELAYS_MS.length) throw err
      sleep(TRANSIENT_RETRY_DELAYS_MS[attempt]!)
    }
  }
}

type AtomicWriteOptions = RetryOptions & { rename?: (from: string, to: string) => void }

/** 一時ファイルに書いてから置き換える。途中で落ちても、元のファイルか新しいファイルのどちらかが残る */
export function writeFileAtomicSync(target: string, text: string, opt: AtomicWriteOptions = {}): void {
  // 同じミリ秒の2つの保存が同じ一時ファイルに書かないよう、乱数を足す
  const tmp = join(resolve(target, '..'), `.${basename(target)}.${process.pid}.${Date.now().toString(36)}${randomBytes(4).toString('hex')}.tmp`)
  const rename = opt.rename ?? renameSync
  try {
    writeFileSync(tmp, text, { encoding: 'utf8', mode: 0o600 })
    retryTransientSync(() => rename(tmp, target), opt)
  } catch (err) {
    rmSync(tmp, { force: true })
    throw err
  }
}

/** 設定に平文のキー（apiKey）が書かれている場所。設定のページで警告する */
export function plaintextKeyPaths(config: unknown, path = ''): string[] {
  if (!config || typeof config !== 'object') return []
  return Object.entries(config as Record<string, unknown>).flatMap(([key, value]) =>
    key === 'apiKey' && typeof value === 'string' && value ? [`${path}/${key}`] : plaintextKeyPaths(value, `${path}/${key}`))
}

interface SettingsFileStoreOptions {
  dir: string
  /** 以前の置き場所（userData/settings.json）。新しいファイルが無いときだけ1度読む。消さない */
  legacyFile?: string | null
  /** 壊れた値を直す（src/main/settings.ts の sanitize） */
  sanitize: (raw: unknown) => Settings
  /** 外部の変更を取り込んだ（読み込んだ生の値。state は含まない） */
  onExternalChange?: (config: Record<string, unknown>) => void
  /** 壊れている状態になった・直った（null） */
  onErrorChange?: (error: SettingsFileError | null) => void
  debounceMs?: number
  /** state.json に書く印（開発版か配布版か） */
  writtenBy?: BuildKind
  /** settings.json の読み取り（単体テストで Windows の一時的な失敗・書きかけを再現する） */
  readFile?: (path: string) => string
  /** 一時的な失敗のやり直しの OS と待ち方、置き換えの関数（単体テスト用） */
  retry?: AtomicWriteOptions
}

interface LoadResult {
  settings: Settings
  error: SettingsFileError | null
  /** 以前の置き場所から移した */
  migrated: boolean
}

export class SettingsFileStore {
  readonly settingsPath: string
  readonly statePath: string
  readonly schemaPath: string
  private extras: Record<string, unknown> = {}
  private schemaRef: string = SCHEMA_REF
  /** 最後に読んだ・書いた settings.json の中身。監視でこれと同じなら自分の書き込み（取り込まない） */
  private lastText: string | null = null
  private lastStateText: string | null = null
  private errorValue: SettingsFileError | null = null
  private watcher: FSWatcher | null = null
  private timer: NodeJS.Timeout | null = null
  /**
   * settings.json の中身を読めたか（または初回で無かったか）。読めないまま（Windows のファイルの掴みっぱなしなど）で始めたときは、
   * 手元の設定が既定値なので、settings.json へ書くと登録したプロジェクト・オーケストラを空で上書きしてしまう（issue #5）。
   * 読めるまで settings.json には書かない（state.json だけ）。監視（checkNow）で読めたら取り込んで書けるようにする
   */
  private configLoaded = false

  constructor(private readonly opt: SettingsFileStoreOptions) {
    this.settingsPath = join(opt.dir, SETTINGS_FILE)
    this.statePath = join(opt.dir, STATE_FILE)
    this.schemaPath = join(opt.dir, SCHEMA_FILE)
  }

  get dir(): string {
    return this.opt.dir
  }

  /** 今の settings.json が壊れているか（壊れている間は settings.json へ書かない） */
  get error(): SettingsFileError | null {
    return this.errorValue
  }

  private setError(error: SettingsFileError | null): void {
    const same = JSON.stringify(error) === JSON.stringify(this.errorValue)
    this.errorValue = error
    if (!same) this.opt.onErrorChange?.(error)
  }

  private readSettingsFile(): string {
    const read = this.opt.readFile ?? ((path: string) => readFileSync(path, 'utf8'))
    return retryTransientSync(() => read(this.settingsPath), this.opt.retry)
  }

  private readState(): unknown {
    try {
      const text = readFileSync(this.statePath, 'utf8')
      this.lastStateText = text
      return JSON.parse(text)
    } catch {
      // 状態が無い（初回・移行直後）・壊れている。状態は無くても設定は使える
      return {}
    }
  }

  private remember(config: Record<string, unknown>, text: string): void {
    const known = knownSettingsKeys()
    this.extras = Object.fromEntries(Object.entries(config).filter(([key]) => !known.has(key)))
    this.schemaRef = typeof config.$schema === 'string' && config.$schema ? config.$schema : SCHEMA_REF
    this.lastText = text
    this.configLoaded = true
  }

  /** settings.json を読めて、アプリから書いてよいか（読めないまま始めたときは false） */
  get loaded(): boolean {
    return this.configLoaded
  }

  /** 起動時に1度。新しいファイルが無ければ以前の置き場所から移す（以前のファイルはそのまま残す） */
  load(): LoadResult {
    mkdirSync(this.opt.dir, { recursive: true })
    // スキーマは補助のファイル。置き換えに失敗しても（Windows でエディタが開いているなど）設定は読む。
    // 以前はここで投げて読み込みごと失敗し、既定値（プロジェクト0件）で始まり、終了時にそれで settings.json を上書きした（issue #5）
    try {
      this.writeSchema()
    } catch (err) {
      console.warn('[settings] settings.schema.json を書けませんでした', (err as NodeJS.ErrnoException)?.code ?? err)
    }
    let text: string | null = null
    try {
      text = this.readSettingsFile()
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        // 読めない（やり直しても掴まれたまま・権限）。状態だけで始め、settings.json には書かない。監視で読めたら取り込む
        console.warn('[settings] settings.json を読めませんでした。読めるまで上書きしません', (err as NodeJS.ErrnoException)?.code ?? err)
        return { settings: this.opt.sanitize(mergeSettings({}, this.readState())), error: null, migrated: false }
      }
    }
    if (text === null) {
      // 初回。以前の userData/settings.json があれば、設定と状態の両方をそこから作る
      let legacy: unknown = {}
      let migrated = false
      // state.json があるなら移行は済んでいる（settings.json を消して既定へ戻したときに、古い設定を蘇らせない）
      if (this.opt.legacyFile && existsSync(this.opt.legacyFile) && !existsSync(this.statePath)) {
        try {
          legacy = JSON.parse(readFileSync(this.opt.legacyFile, 'utf8'))
          migrated = true
        } catch {
          // 以前のファイルが壊れていれば既定値で始める（以前のファイルには触れない）
        }
      }
      const settings = this.opt.sanitize(legacy)
      this.configLoaded = true
      this.saveSync(settings)
      return { settings, error: null, migrated }
    }
    let parsed = parseSettingsText(text)
    // 空・JSON の途中で切れている：Agent やエディタが書いている途中を読んだのかもしれない。少し待って読み直す
    for (let attempt = 0; !parsed.ok && parsed.error.kind === 'parse' && attempt < PARTIAL_READ_RETRIES.length; attempt++) {
      ;(this.opt.retry?.sleep ?? sleepSync)(PARTIAL_READ_RETRIES[attempt]!)
      try {
        text = this.readSettingsFile()
      } catch {
        break
      }
      parsed = parseSettingsText(text)
    }
    const state = this.readState()
    if (!parsed.ok) {
      // 壊れていても起動は続ける。読める範囲で直し、利用者のファイルは直るまで上書きしない
      let raw: Record<string, unknown> = {}
      try { raw = JSON.parse(text) as Record<string, unknown> } catch { /* JSON として読めない。状態だけで始める */ }
      this.lastText = text
      this.configLoaded = true
      this.setError(parsed.error)
      return { settings: this.opt.sanitize(mergeSettings(raw && typeof raw === 'object' ? raw : {}, state)), error: parsed.error, migrated: false }
    }
    this.remember(parsed.value, text)
    return { settings: this.opt.sanitize(mergeSettings(parsed.value, state)), error: null, migrated: false }
  }

  /** 配布するスキーマを設定フォルダへ置く（中身が同じなら書かない） */
  writeSchema(): void {
    const text = settingsSchemaText()
    try {
      if (existsSync(this.schemaPath) && readFileSync(this.schemaPath, 'utf8') === text) return
    } catch { /* 読めなければ書き直す */ }
    writeFileAtomicSync(this.schemaPath, text, this.opt.retry)
  }

  /** settings.json に書く文字列。$schema を先頭に、知らない項目は後ろにそのまま残す */
  configText(settings: Settings): string {
    const { config } = splitSettings(settings)
    const ordered: Record<string, unknown> = { $schema: this.schemaRef }
    for (const key of KEY_ORDER) if (key !== '$schema' && config[key] !== undefined) ordered[key] = config[key]
    for (const [key, value] of Object.entries(config)) if (!(key in ordered) && key !== '$schema') ordered[key] = value
    for (const [key, value] of Object.entries(this.extras)) if (!(key in ordered)) ordered[key] = value
    return `${JSON.stringify(ordered, null, 2)}\n`
  }

  /**
   * 保存の直前に、settings.json が外から変わっていないかを見る（Claude Code などが書いた直後で、監視がまだ取り込んでいない）。
   * 変わっていれば、上の階層の項目ごとに3方向でまとめる：アプリが前の内容から変えた項目はアプリの値、それ以外は外の値。
   * まとめたものを書いて、外部の変更として取り込み直す。外のファイルが壊れていれば書かずに監視に任せる。
   * 変わっていなければ null（ふつうに書く）。
   * 前は確かめずに書いていたので、Agent が browserExtensions の enabled を false にした直後にアプリが別の理由で保存すると、
   * Agent の変更が古い値で上書きされて消えた（0.6.6 の確認で見つけた）
   */
  private mergeExternalBeforeSave(ours: string): 'merged' | 'deferred' | null {
    if (this.lastText === null) return null
    let disk: string
    try {
      disk = readFileSync(this.settingsPath, 'utf8')
    } catch {
      return null
    }
    if (disk === this.lastText) return null
    const theirs = parseSettingsText(disk)
    if (!theirs.ok) {
      // 外のファイルが壊れている。上書きせず、監視（checkNow）がエラーとして出す
      setImmediate(() => this.checkNow())
      return 'deferred'
    }
    let base: Record<string, unknown> = {}
    try { base = JSON.parse(this.lastText) as Record<string, unknown> } catch { /* 前の内容が読めなければ外の値を優先 */ }
    const mine = JSON.parse(ours) as Record<string, unknown>
    const merged: Record<string, unknown> = { ...theirs.value }
    for (const key of new Set([...Object.keys(mine), ...Object.keys(base)])) {
      if (key === '$schema' || JSON.stringify(mine[key]) === JSON.stringify(base[key])) continue
      if (mine[key] === undefined) delete merged[key]
      else merged[key] = mine[key]
    }
    const text = `${JSON.stringify(merged, null, 2)}\n`
    this.remember(merged, text)
    if (text !== disk) writeFileAtomicSync(this.settingsPath, text, this.opt.retry)
    // 取り込みは今の保存が終わってから（保存の途中で設定を差し替えない）
    setImmediate(() => this.opt.onExternalChange?.(merged))
    return 'merged'
  }

  /** 保存する。settings.json が壊れている間は state.json だけを書く。変わっていなければ書かない */
  saveSync(settings: Settings): void {
    mkdirSync(this.opt.dir, { recursive: true })
    // 読めないまま始めた（configLoaded が false）間は、既定値で利用者の settings.json を上書きしない
    if (!this.errorValue && this.configLoaded) {
      const text = this.configText(settings)
      if (text !== this.lastText && this.mergeExternalBeforeSave(text) === null) {
        // 先に覚えてから書く（監視が書き込みに先に気づいても、自分の書き込みと分かる）。
        // 書けなければ元に戻す。戻さないと「書いた」扱いのままになり、同じ内容では終了時にも書き直さない（Orca #18271）
        const previous = this.lastText
        this.lastText = text
        try {
          writeFileAtomicSync(this.settingsPath, text, this.opt.retry)
        } catch (err) {
          this.lastText = previous
          throw err
        }
      }
    }
    const state = splitSettings(settings).state
    const stateText = `${JSON.stringify(this.opt.writtenBy ? { ...state, writtenBy: this.opt.writtenBy } : state, null, 2)}\n`
    if (stateText !== this.lastStateText) {
      const previous = this.lastStateText
      this.lastStateText = stateText
      try {
        writeFileAtomicSync(this.statePath, stateText, this.opt.retry)
      } catch (err) {
        this.lastStateText = previous
        throw err
      }
    }
  }

  /** 生の settings.json（設定のページのエディタで開く） */
  readText(): string {
    try {
      return readFileSync(this.settingsPath, 'utf8')
    } catch {
      return this.lastText ?? ''
    }
  }

  /**
   * アプリ内のエディタからの保存。確かめてから書き、外部の変更と同じく取り込む。
   * 壊れていれば書かずにエラーを返す（エディタの内容は残る）。
   */
  writeText(text: string): { ok: true; config: Record<string, unknown> } | { ok: false; error: SettingsFileError } {
    const parsed = parseSettingsText(text)
    if (!parsed.ok) return parsed
    this.remember(parsed.value, text)
    writeFileAtomicSync(this.settingsPath, text, this.opt.retry)
    this.setError(null)
    return { ok: true, config: parsed.value }
  }

  /** settings.json の外部の変更を見張る。フォルダを見張る（エディタの保存は rename で入れ替わるため） */
  watch(): void {
    if (this.watcher) return
    try {
      this.watcher = watch(this.opt.dir, { persistent: false }, (_event, filename) => {
        if (filename && filename.toString() !== SETTINGS_FILE) return
        if (this.timer) clearTimeout(this.timer)
        this.timer = setTimeout(() => {
          this.timer = null
          this.checkNow()
        }, this.opt.debounceMs ?? 200)
        this.timer.unref?.()
      })
      this.watcher.on('error', () => this.close())
    } catch {
      // 見張れない（ネットワークドライブなど）。再起動すれば読み直す
      this.watcher = null
    }
  }

  /** ファイルを読み直して、変わっていれば取り込む（単体テストからも呼ぶ） */
  checkNow(): 'unchanged' | 'applied' | 'invalid' | 'missing' {
    let text: string
    try {
      text = this.readSettingsFile()
    } catch {
      // 消えた・エディタが入れ替えている途中。次の変更を待つ（消えたからといって作り直さない）
      return 'missing'
    }
    if (text === this.lastText && !this.errorValue && this.configLoaded) return 'unchanged'
    const parsed = parseSettingsText(text)
    if (!parsed.ok) {
      this.lastText = text
      this.setError(parsed.error)
      return 'invalid'
    }
    this.remember(parsed.value, text)
    this.setError(null)
    this.opt.onExternalChange?.(parsed.value)
    return 'applied'
  }

  close(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.watcher?.close()
    this.watcher = null
  }
}
