import { randomBytes } from 'node:crypto'
import { lstat, mkdir, readdir, readFile, readlink, rename, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { join } from 'node:path'
import {
  SUBAGENT_PREFIX,
  allOrchestratorChildren,
  orchestratorChildren,
  outsideFolders,
  planSubagents,
  agentsTemplate,
  memberLinkName,
  readmeTemplate,
  renderOrchestratorGuide,
  renderReadmeBlock,
  renderSubagent,
  rulesTemplate,
  withAdditionalDirectories,
  withGuideBlock,
  withoutGuideBlock,
  type ChildEntry,
  type GuideLanguage,
  type OrchestraRules,
  type OrchestratorChild
} from '@shared/orchestrator'
import { basename } from 'node:path'

/**
 * オーケストレーターのフォルダに、Agent が使うものを書く・消す（@shared/orchestrator）。
 * - .claude/agents/ferret-*.md: 子のプロジェクトごとの subagent（Ferret の印があるもの・まだ無いものだけ）
 * - .claude/settings.local.json の permissions.additionalDirectories: 親の外にある子のフォルダ（Ferret が足した分は
 *   .claude/ferret-orchestrator.json に控え、その分だけを入れ替える。利用者の値は残す）
 * - CLAUDE.md・AGENTS.md の Ferret の欄（印で囲んだ部分だけ）: 共通と個別を分けて並行に進める手順
 * どれもリンクなら書かない（別の場所を書き換えさせない）。一時ファイルに書いてから置き換える
 */

export interface OrchestratorSync {
  children: OrchestratorChild[]
  written: string[]
  removed: string[]
  /** 同じ名前で利用者のファイルがあるので書かなかったもの */
  skipped: string[]
}

type Registered = ReadonlyArray<{ id: string; folderPath: string; name: string; source?: string; urls?: ReadonlyArray<{ url?: string }> }>

/** .claude・.claude/agents・書き先がリンクだった（書かない。利用者に知らせる） */
export class SubagentLinkError extends Error {
  constructor(readonly path: string) {
    super(`refusing to write orchestrator files through a symbolic link: ${path}`)
    this.name = 'SubagentLinkError'
  }
}

const MANAGED_FILE = 'ferret-orchestrator.json'

async function isLink(path: string): Promise<boolean> {
  try { return (await lstat(path)).isSymbolicLink() } catch { return false }
}

async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true } catch { return false }
}

async function readText(path: string): Promise<string | null> {
  try { return await readFile(path, 'utf8') } catch { return null } // 無い（想定内）
}

/** 親のすぐ下のフォルダ（リンクは辿らない） */
async function childEntries(folder: string): Promise<ChildEntry[]> {
  const dirents = await readdir(folder, { withFileTypes: true })
  return Promise.all(dirents.filter((d) => d.isDirectory()).map(async (d) => ({ name: d.name, isGitRepo: await exists(join(folder, d.name, '.git')) })))
}

/** 子のプロジェクトを調べるだけ（書かない）。members はオーケストレーターに入れた既存のプロジェクトの id */
export async function findOrchestratorChildren(folder: string, registered: Registered, members: readonly string[] = [], known?: Record<string, string>): Promise<OrchestratorChild[]> {
  const links = known ? linksById(known, registered, members) : await currentLinks(folder, registered, members)
  return allOrchestratorChildren(folder, members, registered, orchestratorChildren(folder, await childEntries(folder), registered, join), links, join)
}

/** Ferret が作ったリンクの控え（.claude/ferret-orchestrator.json の links: 名前 → 指す先） */
async function readManaged(folder: string): Promise<{ additionalDirectories: string[]; links: Record<string, string> }> {
  try {
    const parsed = JSON.parse(await readText(join(folder, '.claude', MANAGED_FILE)) ?? '{}') as { additionalDirectories?: unknown; links?: unknown }
    const dirs = Array.isArray(parsed.additionalDirectories) ? parsed.additionalDirectories.filter((d): d is string => typeof d === 'string') : []
    const links = parsed.links && typeof parsed.links === 'object' && !Array.isArray(parsed.links)
      ? Object.fromEntries(Object.entries(parsed.links as Record<string, unknown>).filter((e): e is [string, string] => typeof e[1] === 'string'))
      : {}
    return { additionalDirectories: dirs, links }
  } catch {
    return { additionalDirectories: [], links: {} } // 壊れた控えは空とみなす（利用者のものには触れない）
  }
}

async function linkTarget(path: string): Promise<string | null> {
  try { return (await lstat(path)).isSymbolicLink() ? resolve(join(path, '..'), await readlink(path)) : null } catch { return null }
}

const sameFolder = (a: string, b: string) => resolve(a).replace(/[\\/]+$/, '').toLowerCase() === resolve(b).replace(/[\\/]+$/, '').toLowerCase()

function linksById(links: Record<string, string>, registered: Registered, members: readonly string[]): Map<string, string> {
  const out = new Map<string, string>()
  for (const id of members) {
    const project = registered.find((p) => p.id === id)
    const hit = project && Object.entries(links).find(([, target]) => sameFolder(target, project.folderPath))
    if (hit) out.set(id, hit[0])
  }
  return out
}

/** 今あるリンクのうち、入れたプロジェクトを指しているもの（id → 名前）。書かない */
async function currentLinks(folder: string, registered: Registered, members: readonly string[]): Promise<Map<string, string>> {
  const managed = await readManaged(folder)
  const out = new Map<string, string>()
  for (const id of members) {
    const project = registered.find((p) => p.id === id)
    if (!project) continue
    for (const [name, target] of Object.entries(managed.links)) {
      if (sameFolder(target, project.folderPath) && (await linkTarget(join(folder, name))) !== null) out.set(id, name)
    }
  }
  return out
}

/**
 * 入れたプロジェクトを、メインフォルダの下のサブフォルダ（リンク）として見せる。フォルダそのものは動かさない。
 * Windows は管理者の権限の要らない junction。入れなくなったものは、Ferret が作ったリンクで、まだ同じ先を指すものだけ消す
 */
async function syncMemberLinks(folder: string, registered: Registered, members: readonly string[], managedLinks: Record<string, string>): Promise<Record<string, string>> {
  const wanted = members.flatMap((id) => {
    const p = registered.find((x) => x.id === id && x.source !== 'ssh')
    return p && !sameFolder(p.folderPath, folder) ? [p] : []
  })
  const next: Record<string, string> = {}
  for (const [name, target] of Object.entries(managedLinks)) {
    const path = join(folder, name)
    const still = wanted.some((p) => sameFolder(p.folderPath, target))
    const current = await linkTarget(path)
    if (still && current !== null && sameFolder(current, target)) next[name] = target
    else if (!still && current !== null && sameFolder(current, target)) await unlink(path).catch(() => undefined)
  }
  const taken = new Set((await readdir(folder)).map((n) => n.toLowerCase()))
  for (const project of wanted) {
    if (Object.values(next).some((t) => sameFolder(t, project.folderPath))) continue
    const name = memberLinkName(project.folderPath, taken)
    try {
      await symlink(project.folderPath, join(folder, name), process.platform === 'win32' ? 'junction' : 'dir')
      taken.add(name.toLowerCase())
      next[name] = project.folderPath
    } catch { /* 作れなければ本当のフォルダで動かす（additionalDirectories で読み書きできる） */ }
  }
  return next
}

async function claudeDir(folder: string): Promise<string> {
  const claude = join(folder, '.claude')
  if (await isLink(claude) || await isLink(join(claude, 'agents'))) throw new SubagentLinkError(claude)
  return claude
}

async function existingSubagents(dir: string): Promise<Array<{ file: string; text: string | null }>> {
  let names: string[]
  try { names = await readdir(dir) } catch { return [] } // まだ無い（想定内）
  return Promise.all(names.filter((n) => n.startsWith(SUBAGENT_PREFIX) && n.endsWith('.md')).map(async (file) => {
    const path = join(dir, file)
    if (await isLink(path)) return { file, text: null }
    return { file, text: await readText(path) }
  }))
}

/** フォルダごとの合わせる処理の列（同じフォルダを2つ同時に読み書きしない） */
const syncQueues = new Map<string, Promise<unknown>>()

/**
 * 子ごとの subagent・追加のフォルダ・Ferret の欄を、今の子に合わせる。enabled が false なら Ferret が書いたものを全部外す。
 * 同じフォルダへの呼び出しは1本の列に並べる。プロジェクトを消す・開くと「すべてのプロダクト」の合わせが同時に2回走り、
 * settings.local.json の読み書きが重なって一時ファイルの名前もぶつかっていた（Sentry FERRET-1T: EEXIST）
 */
export function syncOrchestrator(folder: string, registered: Registered, enabled = true, members: readonly string[] = [], lang: GuideLanguage = 'en', rules?: OrchestraRules, name?: string): Promise<OrchestratorSync> {
  const key = resolve(folder)
  const run = () => syncOrchestratorNow(folder, registered, enabled, members, lang, rules, name)
  const next = (syncQueues.get(key) ?? Promise.resolve()).then(run, run)
  // 失敗は呼び出し側へ返す。列には順番待ちのためだけに残し、終わったら外す（想定内）
  const tail = next.catch(() => undefined)
  syncQueues.set(key, tail)
  void tail.then(() => { if (syncQueues.get(key) === tail) syncQueues.delete(key) })
  return next
}

async function syncOrchestratorNow(folder: string, registered: Registered, enabled: boolean, members: readonly string[], lang: GuideLanguage, rules?: OrchestraRules, name?: string): Promise<OrchestratorSync> {
  const claude = await claudeDir(folder)
  const managed = await readManaged(folder)
  const links = await syncMemberLinks(folder, registered, enabled ? members : [], managed.links)
  const children = enabled ? await findOrchestratorChildren(folder, registered, members, links) : []
  const agents = join(claude, 'agents')
  const plan = planSubagents(await existingSubagents(agents), children.map((c) => ({ file: `${c.agent}.md`, text: renderSubagent({ ...c, orchestraFolder: folder }, rules) })))
  if (plan.write.length) await mkdir(agents, { recursive: true, mode: 0o755 })
  for (const w of plan.write) await writeAtomic(agents, w.file, w.text)
  for (const file of plan.remove) await rm(join(agents, file), { force: true })
  await syncAdditionalDirectories(claude, outsideFolders(children), links)
  // CLAUDE.md: Agent への進め方（Ferret の欄）＋人が書く共通・プロダクトごとのルール。AGENTS.md は CLAUDE.md を読むよう伝える。
  // README.md: 人向けの使い方とプロダクトの一覧。人が書く部分は最初に作るときの雛形だけ
  const guide = renderOrchestratorGuide(children, rules)
  await syncGuide(folder, 'CLAUDE.md', enabled ? guide : null, rulesTemplate(children, lang))
  await syncGuide(folder, 'AGENTS.md', enabled ? guide : null, agentsTemplate(lang))
  await syncGuide(folder, 'README.md', enabled ? renderReadmeBlock(children, lang) : null, readmeTemplate(basename(folder), lang), 'before')
  // フィードバックから学ぶプレイブック（feedback/playbook.md）。無いときだけ雛形を作り、あるものは上書きしない。
  // 作れなくても（リンク・書けないフォルダ）ほかの同期は済んでいるので続ける
  if (enabled) await (await import('./feedbackLog')).seedPlaybook(folder, name ?? basename(folder)).catch(() => false)
  return { children, written: plan.write.map((w) => w.file), removed: plan.remove, skipped: plan.skipped }
}

async function syncAdditionalDirectories(claude: string, wanted: readonly string[], links: Record<string, string>): Promise<void> {
  const managedPath = join(claude, MANAGED_FILE)
  const previous = (await readManaged(join(claude, '..'))).additionalDirectories
  const hasLinks = Object.keys(links).length > 0
  if (!previous.length && !wanted.length && !hasLinks) {
    await rm(managedPath, { force: true })
    return
  }
  const settingsPath = join(claude, 'settings.local.json')
  const next = withAdditionalDirectories(await readText(settingsPath), previous, wanted)
  await mkdir(claude, { recursive: true, mode: 0o755 })
  if (next !== null) await writeAtomic(claude, 'settings.local.json', next)
  if (wanted.length || hasLinks) await writeAtomic(claude, MANAGED_FILE, `${JSON.stringify({ additionalDirectories: wanted, links }, null, 2)}\n`)
  else await rm(managedPath, { force: true })
}

async function syncGuide(folder: string, file: string, block: string | null, tail: string, order: 'block-first' | 'before' = 'block-first'): Promise<void> {
  const path = join(folder, file)
  if (await isLink(path)) throw new SubagentLinkError(path)
  const current = await readText(path)
  // README は使い方（人が書く部分）を上に、プロダクトの一覧を下に置く
  const next = block === null ? withoutGuideBlock(current) : current === null && order === 'before' ? `${tail.replace(/\s*$/, '')}\n\n${block}\n` : withGuideBlock(current, block, tail)
  if (next !== null) await writeAtomic(folder, file, next)
}

export async function writeAtomic(dir: string, file: string, text: string): Promise<void> {
  const path = join(dir, file)
  if (await isLink(dir) || await isLink(path)) throw new SubagentLinkError(path)
  // 名前に乱数を足す（同じミリ秒の書き込みでもぶつけない）。消すのは自分が作った一時ファイルだけ。
  // 以前は EEXIST でも相手の一時ファイルを消し、相手の rename まで失敗させていた（FERRET-1T）
  const tmp = join(dir, `.${file}.${process.pid}.${Date.now().toString(36)}.${randomBytes(4).toString('hex')}.tmp`)
  let created = false
  try {
    await writeFile(tmp, text, { encoding: 'utf8', mode: 0o644, flag: 'wx' })
    created = true
    await rename(tmp, path)
  } catch (err) {
    if (created) await rm(tmp, { force: true })
    throw err
  }
}
