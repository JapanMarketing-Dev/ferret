import { copyFile, lstat, mkdir, readFile, readdir, rm, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import {
  DEV_PLAYBOOK_HOWTO_MARKER,
  EMPTY_DEV_PLAYBOOK,
  MAX_SOURCE_FILE_BYTES,
  addSource,
  applyDigestResults,
  classifySourceInput,
  devPlaybookBody,
  devPlaybookPaths,
  devPlaybookTemplate,
  markRequested,
  newSourceId,
  provisionalTitle,
  rebuildState,
  removeSource,
  renderDevPlaybookHowTo,
  sanitizeDevPlaybookFile,
  serializeDevPlaybookFile,
  setSourceEnabled,
  sourceFileExtension,
  type DevPlaybookFile,
  type DevPlaybookPaths,
  type DevPlaybookSource,
  type DevPlaybookState,
  type DigestFileInfo
} from '@shared/devPlaybook'

/**
 * 開発方針のファイル（グローバルのフォルダの dev-playbook/。@shared/devPlaybook）を読み書きする。Electron に依存しない。
 * - sources.json は Ferret が書く（同じプロセスの中で順に書く。続けて押しても取りこぼさない）
 * - リンクのファイル・フォルダは読まない・書かない（別の場所を書き換えさせない）
 * - 選んだファイルは inputs/ に写す（Agent はグローバルのフォルダの中だけを読めばよい）
 */

export class DevPlaybookInputError extends Error {
  constructor(readonly reason: 'empty' | 'tooLong' | 'badUrl' | 'badFile' | 'tooLarge' | 'full' | 'notFound') {
    super(`dev playbook: ${reason}`)
    this.name = 'DevPlaybookInputError'
  }
}

async function isLink(path: string): Promise<boolean> {
  try { return (await lstat(path)).isSymbolicLink() } catch { return false }
}

async function readText(path: string): Promise<string | null> {
  try {
    if (await isLink(path)) return null
    return await readFile(path, 'utf8')
  } catch {
    return null // 無い（想定内）
  }
}

async function mtimeOf(path: string): Promise<number | null> {
  try {
    const s = await lstat(path)
    return s.isFile() ? s.mtimeMs : null
  } catch {
    return null
  }
}

async function writeIn(dir: string, file: string, text: string): Promise<void> {
  const { writeAtomic } = await import('./orchestrator')
  await writeAtomic(dir, file, text)
}

// 同じフォルダへの書き込みを順に行う（読んで直して書くの間に、別の操作が割り込まないように）
const queues = new Map<string, Promise<unknown>>()
function serialized<T>(folder: string, run: () => Promise<T>): Promise<T> {
  const prev = queues.get(folder) ?? Promise.resolve()
  const next = prev.catch(() => undefined).then(run)
  queues.set(folder, next)
  void next.finally(() => { if (queues.get(folder) === next) queues.delete(folder) }).catch(() => undefined)
  return next
}

export function pathsOf(globalFolder: string): DevPlaybookPaths {
  return devPlaybookPaths(globalFolder, join)
}

/** dev-playbook/・sources/・inputs/ と、playbook.md（無いときだけ雛形）・HOW-TO.md（Ferret の印のあるもの・無いものだけ）を用意する */
export async function ensureDevPlaybookFiles(globalFolder: string, lang: 'ja' | 'en'): Promise<DevPlaybookPaths> {
  const paths = pathsOf(globalFolder)
  if (await isLink(paths.dir)) return paths
  await mkdir(paths.digests, { recursive: true })
  await mkdir(paths.inputs, { recursive: true })
  if ((await mtimeOf(paths.playbook)) === null && !(await isLink(paths.playbook))) await writeIn(paths.dir, basename(paths.playbook), devPlaybookTemplate(lang))
  const howTo = await readText(paths.howTo)
  const want = renderDevPlaybookHowTo(paths)
  if ((howTo === null && !(await isLink(paths.howTo))) || (howTo !== null && howTo.includes(DEV_PLAYBOOK_HOWTO_MARKER) && howTo !== want)) {
    await writeIn(paths.dir, basename(paths.howTo), want)
  }
  return paths
}

export async function readDevPlaybookFile(globalFolder: string): Promise<DevPlaybookFile> {
  const text = await readText(pathsOf(globalFolder).sources)
  if (text === null) return EMPTY_DEV_PLAYBOOK
  try { return sanitizeDevPlaybookFile(JSON.parse(text)) } catch { return EMPTY_DEV_PLAYBOOK } // 壊れた JSON（想定内。次に書くときに直る）
}

async function writeDevPlaybookFile(globalFolder: string, file: DevPlaybookFile): Promise<void> {
  const paths = pathsOf(globalFolder)
  if (await isLink(paths.dir)) throw new Error(`refusing to write through a symbolic link: ${paths.dir}`)
  await mkdir(paths.dir, { recursive: true })
  await writeIn(paths.dir, basename(paths.sources), serializeDevPlaybookFile(file))
}

/** 写す方針の中身（無い・リンク・雛形のままなら空文字） */
export async function readDevPlaybook(globalFolder: string): Promise<string> {
  return devPlaybookBody(await readText(pathsOf(globalFolder).playbook))
}

/** sources/ の要約（取り込み中・待ちのものだけ読む） */
async function readDigests(paths: DevPlaybookPaths, ids: readonly string[]): Promise<Map<string, DigestFileInfo>> {
  const out = new Map<string, DigestFileInfo>()
  if (!ids.length || await isLink(paths.digests)) return out
  let names: string[]
  try { names = await readdir(paths.digests) } catch { return out }
  await Promise.all(ids.map(async (id) => {
    if (!names.includes(`${id}.md`)) return
    const path = join(paths.digests, `${id}.md`)
    const mtimeMs = await mtimeOf(path)
    const text = mtimeMs === null ? null : await readText(path)
    if (mtimeMs !== null && text !== null) out.set(id, { mtimeMs, text: text.slice(0, 20_000) })
  }))
  return out
}

/** Agent が書いたものを見て状態を進め（変われば sources.json に書く）、画面に出す状態を返す */
export function refreshDevPlaybook(globalFolder: string): Promise<DevPlaybookState> {
  return serialized(globalFolder, async () => {
    const paths = pathsOf(globalFolder)
    const file = await readDevPlaybookFile(globalFolder)
    const open = file.sources.filter((s) => s.status === 'digesting' || s.status === 'pending').map((s) => s.id)
    const playbookMtime = await mtimeOf(paths.playbook)
    const next = applyDigestResults(file, await readDigests(paths, open), playbookMtime)
    if (next !== file) await writeDevPlaybookFile(globalFolder, next)
    return stateOf(paths, next, playbookMtime, await readDevPlaybook(globalFolder))
  })
}

function stateOf(paths: DevPlaybookPaths, file: DevPlaybookFile, playbookMtime: number | null, body: string): DevPlaybookState {
  return { available: true, sources: file.sources, playbookPath: paths.playbook, hasPlaybook: !!body, rebuild: rebuildState(file, playbookMtime) }
}

export interface AddedSource {
  source: DevPlaybookSource
  /** 同じ URL がもうあった（新しく足していない） */
  duplicate: boolean
}

/** 入力欄の値（URL か貼り付けた文）を足す。文は inputs/<id>.md に写す */
export interface AddOptions {
  now?: Date
  /** id の乱数（0〜1） */
  rand?: number
  /** playbook.md の雛形の言語（まだ無いとき） */
  lang?: 'ja' | 'en'
}

export function addDevPlaybookInput(globalFolder: string, raw: unknown, { now = new Date(), rand = Math.random(), lang = 'en' }: AddOptions = {}): Promise<AddedSource> {
  const input = classifySourceInput(raw)
  if (!input.ok) return Promise.reject(new DevPlaybookInputError(input.reason))
  return serialized(globalFolder, async () => {
    const paths = await ensureDevPlaybookFiles(globalFolder, lang)
    const id = newSourceId(now, rand)
    const base = { id, addedAt: now.toISOString(), status: 'pending' as const, enabled: true }
    let source: DevPlaybookSource
    if (input.kind === 'text') {
      const name = `${id}.md`
      await writeIn(paths.inputs, name, `${input.text}\n`)
      source = { ...base, kind: 'text', input: name, title: provisionalTitle({ kind: 'text', text: input.text }) }
    } else {
      source = { ...base, kind: input.kind, url: input.url, title: provisionalTitle({ kind: input.kind, url: input.url }) }
    }
    const file = await readDevPlaybookFile(globalFolder)
    const added = addSource(file, source)
    if (!added) {
      if (source.input) await rm(join(paths.inputs, source.input), { force: true })
      throw new DevPlaybookInputError('full')
    }
    if (!added.duplicate) await writeDevPlaybookFile(globalFolder, added.file)
    return { source: added.source, duplicate: added.duplicate }
  })
}

/** 人が選んだファイル（main のファイル選択の結果だけを渡す）を inputs/ に写して足す */
export function addDevPlaybookFile(globalFolder: string, picked: string, { now = new Date(), rand = Math.random(), lang = 'en' }: AddOptions = {}): Promise<AddedSource> {
  return serialized(globalFolder, async () => {
    const ext = sourceFileExtension(picked)
    if (!ext) throw new DevPlaybookInputError('badFile')
    let info
    try { info = await stat(picked) } catch { throw new DevPlaybookInputError('badFile') }
    if (!info.isFile()) throw new DevPlaybookInputError('badFile')
    if (info.size > MAX_SOURCE_FILE_BYTES) throw new DevPlaybookInputError('tooLarge')
    const file = await readDevPlaybookFile(globalFolder)
    const id = newSourceId(now, rand)
    const name = `${id}.${ext}`
    const source: DevPlaybookSource = { id, kind: 'file', input: name, title: provisionalTitle({ kind: 'file', fileName: basename(picked) }), addedAt: now.toISOString(), status: 'pending', enabled: true }
    const added = addSource(file, source)
    if (!added) throw new DevPlaybookInputError('full')
    const paths = await ensureDevPlaybookFiles(globalFolder, lang)
    if (await isLink(paths.inputs)) throw new DevPlaybookInputError('badFile')
    await copyFile(picked, join(paths.inputs, name))
    await writeDevPlaybookFile(globalFolder, added.file)
    return { source, duplicate: false }
  })
}

async function change(globalFolder: string, id: unknown, edit: (file: DevPlaybookFile, id: string) => DevPlaybookFile): Promise<DevPlaybookFile> {
  return serialized(globalFolder, async () => {
    const file = await readDevPlaybookFile(globalFolder)
    if (typeof id !== 'string' || !file.sources.some((s) => s.id === id)) throw new DevPlaybookInputError('notFound')
    const next = edit(file, id)
    if (next !== file) await writeDevPlaybookFile(globalFolder, next)
    return next
  })
}

export function setDevPlaybookEnabled(globalFolder: string, id: unknown, enabled: boolean, now: Date = new Date()): Promise<DevPlaybookFile> {
  return change(globalFolder, id, (file, sid) => setSourceEnabled(file, sid, enabled === true, now))
}

/** 一覧から外し、要約と写しも消す */
export async function removeDevPlaybookSource(globalFolder: string, id: unknown, now: Date = new Date()): Promise<DevPlaybookFile> {
  const before = await readDevPlaybookFile(globalFolder)
  const source = before.sources.find((s) => s.id === id)
  const next = await change(globalFolder, id, (file, sid) => removeSource(file, sid, now))
  if (source) {
    const paths = pathsOf(globalFolder)
    if (!(await isLink(paths.digests))) await rm(join(paths.digests, `${source.id}.md`), { force: true })
    if (source.input && !(await isLink(paths.inputs))) await rm(join(paths.inputs, source.input), { force: true })
  }
  return next
}

/** Agent に渡した（取り込み中にする） */
export function markDevPlaybookRequested(globalFolder: string, id: string, now: Date = new Date()): Promise<DevPlaybookFile> {
  return change(globalFolder, id, (file, sid) => markRequested(file, sid, now))
}

/** 作り直しを Agent に渡した */
export function markDevPlaybookRebuildRequested(globalFolder: string, now: Date = new Date()): Promise<DevPlaybookFile> {
  return serialized(globalFolder, async () => {
    const file = await readDevPlaybookFile(globalFolder)
    const next = { ...file, rebuildRequestedAt: now.toISOString() }
    await writeDevPlaybookFile(globalFolder, next)
    return next
  })
}
