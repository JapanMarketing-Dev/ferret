import { constants } from 'node:fs'
import { lstat, mkdir, open, readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Project } from '@shared/types'
import { AGENT_SKILL_AGENTS, agentConfigDir } from '@shared/agentSkill'
import {
  PROJECTS_LIST_FILE,
  PROJECTS_SKILL_NAME,
  isProjectsList,
  isProjectsSkill,
  referenceProjects,
  renderProjectsList,
  renderProjectsSkill,
  type ProjectFacts
} from '@shared/projectsSkill'
import { writePrivateFileAtomic } from './atomicFile'

/**
 * skill「ferret-projects」（@shared/projectsSkill）を、使っている Agent（設定のフォルダがあるもの）に入れ、
 * 横の projects.md を今の登録に合わせる（起動時と、プロジェクトの一覧が変わったとき）。
 * - 同じ名前で Ferret のものでない skill（印の無いもの）・リンクは触らない（ferret-browser と同じ）
 * - projects.md は一時ファイルに書いてから置き換える（atomicFile）。中身が同じなら書かない
 * - プロジェクトのフォルダは読むだけ（package.json・README の頭・目印のファイルの有無）。大きさを決めて読み、パイプなどは開かない
 */

const PACKAGE_JSON_MAX = 256 * 1024
const README_HEAD = 8 * 1024

async function isFile(path: string): Promise<boolean> {
  try { return (await stat(path)).isFile() } catch { return false }
}

async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true } catch { return false }
}

/** 普通のファイルの先頭だけを読む（無い・普通のファイルでなければ null） */
async function readHead(path: string, max: number): Promise<string | null> {
  try {
    if (!(await stat(path)).isFile()) return null
    const handle = await open(path, constants.O_RDONLY | ((constants as { O_NONBLOCK?: number }).O_NONBLOCK ?? 0))
    try {
      const buf = Buffer.alloc(max)
      const { bytesRead } = await handle.read(buf, 0, max, 0)
      return buf.subarray(0, bytesRead).toString('utf8')
    } finally {
      await handle.close()
    }
  } catch {
    return null
  }
}

/** README の最初の段落（見出し・バッジ・画像・HTML の行は飛ばす） */
export function readmeSummary(text: string): string | undefined {
  const para: string[] = []
  let inCode = false
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (line.startsWith('```')) { inCode = !inCode; continue }
    if (inCode) continue
    const skip = !line || line.startsWith('#') || line.startsWith('<') || line.startsWith('![') || line.startsWith('[![') || /^[-=*_]{3,}$/.test(line) || line.startsWith('>')
    if (skip) {
      if (para.length) break
      continue
    }
    para.push(line)
  }
  const joined = para.join(' ').trim()
  return joined || undefined
}

/** package.json の依存から分かる主なフレームワーク（並びは表示の順） */
const DEP_LABELS: Array<[string, string]> = [
  ['typescript', 'TypeScript'], ['electron', 'Electron'], ['next', 'Next.js'], ['react-native', 'React Native'], ['expo', 'Expo'],
  ['react', 'React'], ['vue', 'Vue'], ['svelte', 'Svelte'], ['@angular/core', 'Angular'], ['astro', 'Astro'], ['vite', 'Vite'],
  ['express', 'Express'], ['hono', 'Hono'], ['fastify', 'Fastify'], ['@nestjs/core', 'NestJS'], ['prisma', 'Prisma'],
  ['tailwindcss', 'Tailwind CSS'], ['wrangler', 'Cloudflare Workers'], ['vitest', 'Vitest'], ['jest', 'Jest']
]

/** フォルダの直下の目印のファイル → 言語・仕組み */
const MARKER_FILES: Array<[string, string]> = [
  ['Cargo.toml', 'Rust'], ['go.mod', 'Go'], ['pyproject.toml', 'Python'], ['requirements.txt', 'Python'], ['Gemfile', 'Ruby'],
  ['Package.swift', 'Swift'], ['pubspec.yaml', 'Flutter/Dart'], ['build.gradle', 'Gradle (Java/Kotlin)'], ['build.gradle.kts', 'Gradle (Kotlin)'],
  ['composer.json', 'PHP'], ['deno.json', 'Deno'], ['Dockerfile', 'Docker'], ['wrangler.toml', 'Cloudflare Workers'], ['wrangler.jsonc', 'Cloudflare Workers']
]

const GUIDE_FILES = ['CLAUDE.md', 'AGENTS.md', 'README.md']

/** 1つのフォルダの手がかりを集める（読むだけ） */
export async function projectFacts(folder: string): Promise<ProjectFacts> {
  try {
    if (!(await stat(folder)).isDirectory()) return { exists: false, stack: [], git: false, guides: [] }
  } catch {
    return { exists: false, stack: [], git: false, guides: [] }
  }
  const stack: string[] = []
  let description: string | undefined
  const pkgText = await readHead(join(folder, 'package.json'), PACKAGE_JSON_MAX)
  if (pkgText !== null) {
    stack.push('Node.js')
    try {
      const pkg = JSON.parse(pkgText) as { description?: unknown; dependencies?: Record<string, unknown>; devDependencies?: Record<string, unknown> }
      if (typeof pkg.description === 'string' && pkg.description.trim()) description = pkg.description
      const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) }
      for (const [dep, label] of DEP_LABELS) if (Object.prototype.hasOwnProperty.call(deps, dep)) stack.push(label)
    } catch {
      // 読めない package.json（大きすぎて途中で切れた・壊れている）は依存を見ない
    }
  }
  for (const [file, label] of MARKER_FILES) if (await isFile(join(folder, file))) stack.push(label)
  const guides: string[] = []
  for (const file of GUIDE_FILES) if (await isFile(join(folder, file))) guides.push(file)
  if (!description && guides.includes('README.md')) {
    const head = await readHead(join(folder, 'README.md'), README_HEAD)
    if (head) description = readmeSummary(head)
  }
  return { exists: true, ...(description ? { description } : {}), stack: [...new Set(stack)], git: await exists(join(folder, '.git')), guides }
}

/** projects.md の中身（今の登録とフォルダの中身から） */
export async function buildProjectsList(projects: readonly Project[]): Promise<string> {
  const { local } = referenceProjects(projects)
  const facts = new Map<string, ProjectFacts>()
  await Promise.all(local.map(async (p) => { facts.set(p.folderPath, await projectFacts(p.folderPath)) }))
  return renderProjectsList(projects, facts)
}

async function isLink(path: string): Promise<boolean> {
  try { return (await lstat(path)).isSymbolicLink() } catch { return false }
}

/**
 * skill と一覧を入れて、今の版・今の登録に合わせる。書いたファイルの数を返す。
 * 設定のフォルダが無い Agent（使っていない）には入れない。印の無い同名の skill・リンクは触らない
 */
export async function syncProjectsSkill(version: string, projects: readonly Project[], home: string = homedir(), env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const { writeSkill } = await import('./agentSkill')
  let list: string | null = null
  let written = 0
  for (const agent of AGENT_SKILL_AGENTS) {
    const configDir = agentConfigDir(agent, env, home, join)
    if (!(await exists(configDir))) continue
    const dir = join(configDir, 'skills', PROJECTS_SKILL_NAME)
    const skillPath = join(dir, 'SKILL.md')
    const listPath = join(dir, PROJECTS_LIST_FILE)
    if (await isLink(dir) || await isLink(skillPath) || await isLink(listPath)) continue
    const current = await readFile(skillPath, 'utf8').catch(() => null)
    if (current !== null && !isProjectsSkill(current)) continue
    const currentList = await readFile(listPath, 'utf8').catch(() => null)
    if (currentList !== null && !isProjectsList(currentList)) continue
    const text = renderProjectsSkill(version, listPath)
    if (current !== text) {
      await writeSkill(skillPath, text)
      written++
    }
    list ??= await buildProjectsList(projects)
    if (currentList !== list) {
      await mkdir(dir, { recursive: true })
      await writePrivateFileAtomic(listPath, list)
      written++
    }
  }
  return written
}
