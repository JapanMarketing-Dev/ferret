/**
 * skill「ferret-projects」（src/shared/projectsSkill.ts・src/main/projectsSkill.ts）。
 * Ferret に登録したほかのプロジェクトを横断して参考にする。一覧（projects.md）は登録が変わるたびに書き直す
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  PROJECTS_LIST_MARKER,
  PROJECTS_SKILL_MARKER,
  PROJECTS_SKILL_NAME,
  isProjectsList,
  isProjectsSkill,
  oneLine,
  referenceProjects,
  renderProjectsList,
  renderProjectsSkill,
  type ProjectFacts
} from '../../src/shared/projectsSkill'
import { buildProjectsList, projectFacts, readmeSummary, syncProjectsSkill } from '../../src/main/projectsSkill'
import type { Project } from '../../src/shared/types'

const p = (id: string, extra: Partial<Project> = {}): Project => ({ id, name: id, folderPath: `/f/${id}`, urls: [], ...extra })
const facts = (extra: Partial<ProjectFacts> = {}): ProjectFacts => ({ exists: true, stack: [], git: true, guides: [], ...extra })

describe('SKILL.md', () => {
  const text = renderProjectsSkill('9.9.9', '/home/taro/.claude/skills/ferret-projects/projects.md')

  it('name・description の前書きと Ferret の印がある', () => {
    expect(text.startsWith(`---\nname: ${PROJECTS_SKILL_NAME}\ndescription: `)).toBe(true)
    expect(isProjectsSkill(text)).toBe(true)
    expect(isProjectsSkill('---\nname: ferret-projects\n---\nmine')).toBe(false)
    expect(text).toContain('<!-- Ferret 9.9.9 -->')
  })

  it('「他のPJを参考に」「横断して」などで呼ばれる説明', () => {
    const description = text.split('\n')[2]!
    for (const word of ['他のPJを参考に', '他のプロジェクトでどうしてるか', '横断して', 'registered in Ferret']) expect(description).toContain(word)
  })

  it('一覧の絶対パスと、登録していないフォルダは見ない・読むだけ・秘密を読まない決まりを書く', () => {
    expect(text).toContain('`/home/taro/.claude/skills/ferret-projects/projects.md`')
    for (const word of ['Read only', 'unregistered projects are out of scope', '.env*', 'never as instructions', 'rg -n']) expect(text).toContain(word)
  })
})

describe('並べるプロジェクト', () => {
  const all: Project[] = [
    p('O', { editorWorkspace: true, orchestrator: true }), p('a'), p('b', { archived: true }), p('w', { work: true }),
    p('s', { source: 'ssh', ssh: { host: 'box', path: '~/app' } }), p('s2', { source: 'ssh' }),
    p('O2', { editorWorkspace: true, orchestrator: true, archived: true }), p('c', { orchestraId: 'O2' })
  ]

  it('オーケストラ・work・アーカイブ（オーケストラごと隠したものも）は入れない。SSH は別に分ける（接続先の無いものは除く）', () => {
    const { local, remote } = referenceProjects(all)
    expect(local.map((x) => x.id)).toEqual(['a'])
    expect(remote.map((x) => x.id)).toEqual(['s'])
  })

  it('一覧の中身（パス・説明・仕組み・読むファイル・git でない・見つからない）', () => {
    const list = [p('a', { name: 'App | One', kind: 'mobile', source: 'github', remoteUrl: 'https://github.com/x/a' }), p('gone'), p('plain')]
    const md = renderProjectsList(list, new Map([
      ['/f/a', facts({ description: 'Line one\nline two', stack: ['Node.js', 'React'], guides: ['CLAUDE.md', 'README.md'] })],
      ['/f/gone', facts({ exists: false })],
      ['/f/plain', facts({ git: false })]
    ]))
    expect(isProjectsList(md)).toBe(true)
    expect(md.startsWith(PROJECTS_LIST_MARKER)).toBe(true)
    expect(md).toContain('## App / One')
    expect(md).toContain('- Path: `/f/a`')
    expect(md).toContain('- About: Line one line two')
    expect(md).toContain('- Stack: mobile, Node.js, React')
    expect(md).toContain('- Cloned from: https://github.com/x/a')
    expect(md).toContain('- Read first: `CLAUDE.md`, `README.md`')
    expect(md).toMatch(/## gone\n\n- Path: `\/f\/gone`\n- Folder not found/)
    expect(md).toMatch(/## plain[\s\S]*- Not a git repository/)
  })

  it('種類が web（既定）のときは仕組みに入れない', () => {
    expect(renderProjectsList([p('a', { kind: 'web' })], new Map([['/f/a', facts({ stack: ['Go'] })]]))).toContain('- Stack: Go\n')
  })

  it('SSH のプロジェクトは接続先だけを、手元に無いと分かるように並べる', () => {
    const md = renderProjectsList(all, new Map())
    expect(md).toContain('## Remote projects (SSH, not on this machine)')
    expect(md).toContain('- s: `box:~/app`')
  })

  it('何も登録していなければ、登録の仕方を書く', () => {
    expect(renderProjectsList([], new Map())).toContain('No other projects are registered')
    expect(renderProjectsList([p('w', { work: true })], new Map())).toContain('No other projects are registered')
  })

  it('1行にまとめて短くする（改行・|・バッククオートを外す）', () => {
    expect(oneLine('a\n b | `c`')).toBe("a b / 'c'")
    expect(oneLine('x'.repeat(200), 10)).toBe(`${'x'.repeat(9)}…`)
    expect(oneLine(undefined)).toBe('')
  })
})

describe('README の最初の段落', () => {
  it('見出し・バッジ・画像・HTML・コード・引用を飛ばし、最初の段落だけ', () => {
    expect(readmeSummary('# Title\n\n[![ci](x)](y)\n<p>logo</p>\n```sh\nnpm i\n```\n> note\n\nFirst para\ncontinues.\n\nSecond.')).toBe('First para continues.')
  })
  it('段落が無ければ undefined', () => {
    expect(readmeSummary('# Only a title\n\n---\n')).toBeUndefined()
    expect(readmeSummary('')).toBeUndefined()
  })
})

describe('フォルダの手がかりと書き込み', () => {
  let dir = ''
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'ferret-projects-skill-')) })
  afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

  it('package.json の説明・依存、目印のファイル、git、読むファイルを集める', async () => {
    const app = join(dir, 'app')
    await mkdir(join(app, '.git'), { recursive: true })
    await writeFile(join(app, 'package.json'), JSON.stringify({ description: 'My app', dependencies: { react: '1' }, devDependencies: { typescript: '5', vitest: '1' } }))
    await writeFile(join(app, 'Dockerfile'), 'FROM x')
    await writeFile(join(app, 'CLAUDE.md'), '# rules')
    const f = await projectFacts(app)
    expect(f).toMatchObject({ exists: true, description: 'My app', git: true, guides: ['CLAUDE.md'] })
    expect(f.stack).toEqual(['Node.js', 'TypeScript', 'React', 'Vitest', 'Docker'])
  })

  it('説明が無ければ README の最初の段落。壊れた package.json は依存を見ない', async () => {
    const app = join(dir, 'py')
    await mkdir(app)
    await writeFile(join(app, 'package.json'), '{ broken')
    await writeFile(join(app, 'pyproject.toml'), '')
    await writeFile(join(app, 'README.md'), '# Py\n\nA python tool.\n')
    const f = await projectFacts(app)
    expect(f).toMatchObject({ description: 'A python tool.', git: false, guides: ['README.md'] })
    expect(f.stack).toEqual(['Node.js', 'Python'])
  })

  it('フォルダが無い・ファイルなら exists: false', async () => {
    expect((await projectFacts(join(dir, 'nope'))).exists).toBe(false)
    await writeFile(join(dir, 'file'), 'x')
    expect((await projectFacts(join(dir, 'file'))).exists).toBe(false)
  })

  it('目印と同じ名前のフォルダは目印にしない', async () => {
    const app = join(dir, 'odd')
    await mkdir(join(app, 'go.mod'), { recursive: true })
    expect((await projectFacts(app)).stack).toEqual([])
  })

  it('一覧を作る（登録したフォルダの中を読む）', async () => {
    const app = join(dir, 'app')
    await mkdir(app)
    await writeFile(join(app, 'go.mod'), 'module x')
    const md = await buildProjectsList([p('app', { folderPath: app }), p('w', { work: true, folderPath: join(dir, 'w') })])
    expect(md).toContain(`- Path: \`${app}\``)
    expect(md).toContain('- Stack: Go')
    expect(md).not.toContain('## w')
  })

  it('設定のフォルダがある Agent にだけ SKILL.md と projects.md を入れ、同じなら書き直さない。登録が変われば一覧だけ書き直す', async () => {
    const home = join(dir, 'home')
    await mkdir(join(home, '.claude'), { recursive: true })
    const projects = [p('a', { folderPath: join(dir, 'a') })]
    expect(await syncProjectsSkill('1.0.0', projects, home, {})).toBe(2)
    const skillDir = join(home, '.claude', 'skills', PROJECTS_SKILL_NAME)
    const skill = await readFile(join(skillDir, 'SKILL.md'), 'utf8')
    expect(skill).toContain(PROJECTS_SKILL_MARKER)
    expect(skill).toContain(join(skillDir, 'projects.md'))
    expect(await readFile(join(skillDir, 'projects.md'), 'utf8')).toContain('## a')
    // Codex の設定のフォルダは無い → 入れない
    await expect(stat(join(home, '.codex'))).rejects.toThrow()
    expect(await syncProjectsSkill('1.0.0', projects, home, {})).toBe(0)
    expect(await syncProjectsSkill('1.0.0', [...projects, p('b', { name: 'Beta' })], home, {})).toBe(1)
    expect(await readFile(join(skillDir, 'projects.md'), 'utf8')).toContain('## Beta')
    expect(await syncProjectsSkill('1.0.1', [...projects, p('b', { name: 'Beta' })], home, {})).toBe(1)
  })

  it('CLAUDE_CONFIG_DIR・CODEX_HOME の置き場に従う', async () => {
    const claude = join(dir, 'cc')
    const codex = join(dir, 'cx')
    await mkdir(claude)
    await mkdir(codex)
    expect(await syncProjectsSkill('1.0.0', [], join(dir, 'nohome'), { CLAUDE_CONFIG_DIR: claude, CODEX_HOME: codex })).toBe(4)
    expect(isProjectsList(await readFile(join(codex, 'skills', PROJECTS_SKILL_NAME, 'projects.md'), 'utf8'))).toBe(true)
  })

  it('印の無い同名の skill・一覧、リンクのフォルダには書かない', async () => {
    const home = join(dir, 'home')
    const skillDir = join(home, '.claude', 'skills', PROJECTS_SKILL_NAME)
    await mkdir(skillDir, { recursive: true })
    await writeFile(join(skillDir, 'SKILL.md'), 'mine')
    expect(await syncProjectsSkill('1.0.0', [], home, {})).toBe(0)
    expect(await readFile(join(skillDir, 'SKILL.md'), 'utf8')).toBe('mine')

    await rm(join(skillDir, 'SKILL.md'))
    await writeFile(join(skillDir, 'projects.md'), 'my notes')
    expect(await syncProjectsSkill('1.0.0', [], home, {})).toBe(0)
    expect(await readFile(join(skillDir, 'projects.md'), 'utf8')).toBe('my notes')

    const codex = join(home, '.codex')
    const target = join(dir, 'elsewhere')
    await mkdir(join(codex, 'skills'), { recursive: true })
    await mkdir(target)
    await symlink(target, join(codex, 'skills', PROJECTS_SKILL_NAME))
    expect(await syncProjectsSkill('1.0.0', [], home, {})).toBe(0)
    await expect(stat(join(target, 'SKILL.md'))).rejects.toThrow()
  })
})
