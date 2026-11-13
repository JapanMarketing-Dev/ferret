/**
 * グローバルのオーケストラ（src/main/globalOrchestra.ts・src/shared/globalOrchestra.ts）。
 * 既定で1回だけ足す・全部のプロジェクトが対象・どのプロジェクトも属さない・先頭に固定・全体のルールを写す
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ensureGlobalFolder, globalFolderPath, readGlobalRules, syncAgentGlobalRules, syncGlobalFiles, withGlobalOrchestra } from '../../src/main/globalOrchestra'
import {
  CLAUDE_GLOBAL_RULES_FILE,
  CODEX_BLOCK_END,
  CODEX_BLOCK_START,
  GLOBAL_RULES_MARKER,
  MAX_GLOBAL_RULES_CHARS,
  globalRulesBody,
  globalRulesTemplate,
  renderClaudeGlobalRules,
  renderCodexGlobalBlock,
  withCodexGlobalBlock
} from '../../src/shared/globalOrchestra'
import {
  currentOrchestra,
  groupOrchestras,
  isGlobalOrchestra,
  moveInTree,
  orchestraIdOf,
  orchestraMembers,
  removeOrchestra,
  treeDrop,
  treeRows
} from '../../src/shared/orchestras'
import { archiveFallback, canArchive, setArchived } from '../../src/shared/projectArchive'
import { sortOrchestras } from '../../src/shared/projectOrder'
import { renderOrchestratorGuide, renderSubagent, sanitizeOrchestraRules } from '../../src/shared/orchestrator'
import { PROJECTS_LIST_MARKER } from '../../src/shared/projectsSkill'
import { sanitize } from '../../src/main/settings'
import type { Project } from '../../src/shared/types'

const p = (id: string, extra: Partial<Project> = {}): Project => ({ id, name: id, folderPath: `/f/${id}`, urls: [], ...extra })
const o = (id: string, extra: Partial<Project> = {}) => p(id, { editorWorkspace: true, orchestrator: true, ...extra })
const g = (extra: Partial<Project> = {}) => o('G', { global: true, ...extra })
const ids = (list: readonly Project[]) => list.map((x) => x.id)
const NOW = new Date('2026-11-13T00:00:00Z')

// G: グローバル（先頭）、O1: a・b、O2: c。w は work、s は SSH、x は外したもの
const ALL: Project[] = [
  g(), o('O1'), p('a'), p('b', { orchestraId: 'O1' }), o('O2'), p('c', { orchestraId: 'O2' }),
  p('w', { work: true }), p('s', { source: 'ssh' }), p('x', { orchestraId: 'O2', orchestraExcluded: true })
]

describe('置き場', () => {
  it('配布版は ~/Ferret/global、開発版・E2E は設定フォルダの下（work と同じ決まり）', () => {
    expect(globalFolderPath({ home: '/home/taro', configDir: '/home/taro/.ferret', shared: true })).toBe(join('/home/taro', 'Ferret', 'global'))
    expect(globalFolderPath({ home: '/home/taro', configDir: '/home/taro/.ferret/dev', shared: false })).toBe(join('/home/taro/.ferret/dev', 'global'))
  })
})

describe('一覧に足す（既定で1回）', () => {
  it('無ければ先頭にオーケストラとして足す', () => {
    const next = withGlobalOrchestra([o('O1'), p('a')], '/home/taro/Ferret/global', 'グローバル', 'g1', NOW)
    expect(next).toHaveLength(3)
    expect(next[0]).toMatchObject({ id: 'g1', name: 'グローバル', folderPath: '/home/taro/Ferret/global', editorWorkspace: true, orchestrator: true, global: true, addedAt: NOW.toISOString() })
    expect(isGlobalOrchestra(next[0]!)).toBe(true)
    expect(ids(next.slice(1))).toEqual(['O1', 'a'])
  })

  it('もうあれば同じ配列を返す（アーカイブ・名前・置き場を変えてあっても足し直さない）', () => {
    const list = [g({ archived: true, name: 'みんな', folderPath: '/elsewhere' }), o('O1')]
    expect(withGlobalOrchestra(list, '/home/taro/Ferret/global', 'グローバル')).toBe(list)
  })

  it('同じフォルダを自分で登録していれば、それをグローバルにする（所属・外す・work の印は外す）', () => {
    const list = [o('O1'), p('mine', { folderPath: '/home/taro/Ferret/global', orchestraId: 'O1', orchestraExcluded: true })]
    const next = withGlobalOrchestra(list, '/home/taro/Ferret/global', 'グローバル')
    expect(next).toHaveLength(2)
    const mine = next.find((x) => x.id === 'mine')!
    expect(mine).toMatchObject({ global: true, editorWorkspace: true, orchestrator: true, name: 'mine' })
    expect(mine.orchestraId).toBeUndefined()
    expect(mine.orchestraExcluded).toBeUndefined()
  })

  it('フォルダを作る（あれば true のまま）。同じ名前のファイルがあれば false', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ferret-global-'))
    try {
      expect(ensureGlobalFolder(join(dir, 'Ferret', 'global'))).toBe(true)
      expect((await stat(join(dir, 'Ferret', 'global'))).isDirectory()).toBe(true)
      expect(ensureGlobalFolder(join(dir, 'Ferret', 'global'))).toBe(true)
      await writeFile(join(dir, 'file'), 'x')
      expect(ensureGlobalFolder(join(dir, 'file'))).toBe(false)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('設定の読み込みで印を残す。オーケストラでないものには付けない', () => {
    const settings = sanitize({ projects: [
      { id: 'g', folderPath: '/f/g', editorWorkspace: true, global: true },
      { id: 'n', folderPath: '/f/n', global: true },
      { id: 'b', folderPath: '/f/b', editorWorkspace: true, global: 'yes' }
    ] })
    expect(settings.projects[0]!.global).toBe(true)
    expect(settings.projects[1]!.global).toBeUndefined()
    expect(settings.projects[2]!.global).toBeUndefined()
  })
})

describe('対象と所属', () => {
  it('グローバルの対象は、どのグループのものも全部（work・SSH・外したもの・オーケストラは除く）', () => {
    expect(ids(orchestraMembers(ALL, 'G'))).toEqual(['a', 'b', 'c'])
    expect(ids(orchestraMembers(ALL, 'G', { includeExcluded: true }))).toEqual(['a', 'b', 'c', 'x'])
  })

  it('アーカイブしたもの・アーカイブしたグループの中のものは入れない。戻せば入る', () => {
    expect(ids(orchestraMembers(setArchived(ALL, 'a', true), 'G'))).toEqual(['b', 'c'])
    const hidden = setArchived(ALL, 'O2', true)
    expect(ids(orchestraMembers(hidden, 'G'))).toEqual(['a', 'b'])
    expect(ids(orchestraMembers(setArchived(hidden, 'O2', false), 'G'))).toEqual(['a', 'b', 'c'])
  })

  it('グループの対象は今までどおり（グローバルが先頭にあっても、所属の無いものは先頭のグループ）', () => {
    expect(ids(orchestraMembers(ALL, 'O1'))).toEqual(['a', 'b'])
    expect(ids(orchestraMembers(ALL, 'O2'))).toEqual(['c'])
    expect(orchestraIdOf(ALL, p('a'))).toBe('O1')
  })

  it('グローバルを指す所属は無効とみなし、先頭のグループに属する', () => {
    const list = [...ALL, p('z', { orchestraId: 'G' })]
    expect(orchestraIdOf(list, list.at(-1)!)).toBe('O1')
    expect(ids(orchestraMembers(list, 'O1'))).toContain('z')
  })

  it('グループが無ければ所属なし（グローバルには属さない）', () => {
    expect(orchestraIdOf([g(), p('a')], p('a'))).toBeNull()
    expect(ids(orchestraMembers([g(), p('a')], 'G'))).toEqual(['a'])
    expect(ids(groupOrchestras(ALL))).toEqual(['O1', 'O2'])
  })

  it('開いているもののオーケストラ。グローバルを開いていればグローバル、プロジェクトならそのグループ、無ければ先頭のグループ', () => {
    expect(currentOrchestra(ALL, 'G')?.id).toBe('G')
    expect(currentOrchestra(ALL, 'c')?.id).toBe('O2')
    expect(currentOrchestra(ALL, null)?.id).toBe('O1')
    expect(currentOrchestra([g()], null)?.id).toBe('G')
  })
})

describe('サイドバーの並び・移動', () => {
  it('グローバルはどの並びでも先頭', () => {
    const list = [o('O1', { name: 'A', lastOpenedAt: '2026-11-12T00:00:00Z' }), g({ name: 'Z' }), o('O2', { name: 'B' })]
    expect(ids(sortOrchestras(list, 'manual'))).toEqual(['G', 'O1', 'O2'])
    expect(ids(sortOrchestras(list, 'name'))).toEqual(['G', 'O1', 'O2'])
    expect(ids(sortOrchestras(list, 'recent'))).toEqual(['G', 'O1', 'O2'])
  })

  it('グローバルの行は子を持たない（プロジェクトはそれぞれのグループの下）', () => {
    const rows = treeRows(ALL, ALL, new Set())
    expect(rows[0]).toMatchObject({ project: { id: 'G' }, depth: 0, childCount: 0 })
    expect(rows.filter((r) => r.depth === 1).map((r) => r.project.id)).toEqual(['a', 'b', 's', 'c', 'x'])
  })

  it('プロジェクトをグローバルへは移せない。グローバルは動かさず、落とし先にもしない', () => {
    expect(moveInTree(ALL, 'a', 'G', null)).toEqual(ALL)
    const rows = treeRows(ALL, ALL, new Set())
    expect(treeDrop(ALL, rows, 'a', 'G', 'after')).toBeNull()
    expect(treeDrop(ALL, rows, 'G', 'O1', 'before')).toBeNull()
    expect(treeDrop(ALL, rows, 'O2', 'G', 'before')).toBeNull()
    // グループ同士の並べ替えは今までどおり
    expect(treeDrop(ALL, rows, 'O2', 'O1', 'before')).toEqual({ id: 'O2', to: null, before: 'O1' })
  })
})

describe('消す・隠す', () => {
  it('グローバルは子が無いので消せる（次の起動で足し直る）', () => {
    expect(ids(removeOrchestra(ALL, 'G')!)).toEqual(ids(ALL).filter((id) => id !== 'G'))
  })

  it('最後のグループは、グローバルがあっても消せない（子の移り先にグローバルを使わない）', () => {
    const list = [g(), o('O1'), p('a')]
    expect(removeOrchestra(list, 'O1')).toBeNull()
    const moved = removeOrchestra(ALL, 'O2')!
    expect(moved.find((x) => x.id === 'c')!.orchestraId).toBe('O1')
  })

  it('グローバルはいつでもアーカイブできる。最後のグループはグローバルがあってもできない', () => {
    expect(canArchive(ALL, 'G')).toBe(true)
    expect(canArchive([g(), o('O1'), p('a')], 'O1')).toBe(false)
    expect(canArchive(ALL, 'O1')).toBe(true)
  })

  it('隠したあとに開くのは、グループのオーケストラを先に選ぶ', () => {
    expect(archiveFallback(setArchived(ALL, 'a', true))?.id).toBe('O1')
    expect(archiveFallback([g(), p('a')])?.id).toBe('G')
  })
})

describe('全体のルール（rules.md）の中身', () => {
  it('雛形のままなら空（日本語・英語とも）', () => {
    expect(globalRulesBody(globalRulesTemplate('ja'))).toBe('')
    expect(globalRulesBody(globalRulesTemplate('en'))).toBe('')
    expect(globalRulesBody(null)).toBe('')
    expect(globalRulesBody('')).toBe('')
  })

  it('コメント・先頭の見出し・中身の無い箇条を外す。ほかの見出しと本文は残す', () => {
    const text = '# 全体のルール\r\n\r\n<!-- 説明\n2行目 -->\n- コミットは日本語\n-\n\n\n\n## テスト\n- E2E は書かない\n'
    expect(globalRulesBody(text)).toBe('- コミットは日本語\n\n## テスト\n- E2E は書かない')
  })

  it('外すとできるコメントも外す', () => {
    expect(globalRulesBody('<!<!-- x -->-- y -->rule')).toBe('rule')
  })

  it('長すぎるものは上限で切る', () => {
    expect(globalRulesBody(`- ${'a'.repeat(MAX_GLOBAL_RULES_CHARS * 2)}`).length).toBe(MAX_GLOBAL_RULES_CHARS)
  })

  it('Claude Code へのファイルは印と元の場所を持つ。空なら null（消す）', () => {
    const text = renderClaudeGlobalRules('- rule', '/g/rules.md')!
    expect(text).toContain(GLOBAL_RULES_MARKER)
    expect(text).toContain('/g/rules.md')
    expect(text).toContain('- rule')
    expect(renderClaudeGlobalRules('  \n', '/g/rules.md')).toBeNull()
  })
})

describe('Codex の AGENTS.md の欄', () => {
  const block = renderCodexGlobalBlock('- rule', '/g/rules.md')

  it('無いファイルには欄だけで作る。欄が要らなければ作らない', () => {
    expect(withCodexGlobalBlock(null, block)).toBe(`${block}\n`)
    expect(withCodexGlobalBlock(null, null)).toBeNull()
    expect(withCodexGlobalBlock('# mine\n', null)).toBeNull()
  })

  it('利用者の文の後ろに足し、2回目は欄だけ差し替える（利用者の文はそのまま）', () => {
    const first = withCodexGlobalBlock('# 自分のルール\n- A\n', block)!
    expect(first.startsWith('# 自分のルール\n- A\n\n')).toBe(true)
    expect(first).toContain(CODEX_BLOCK_START)
    expect(withCodexGlobalBlock(first, block)).toBeNull()
    const next = withCodexGlobalBlock(`${first}\n# 後ろの文\n`, renderCodexGlobalBlock('- new', '/g/rules.md'))!
    expect(next).toContain('- new')
    expect(next).not.toContain('- rule')
    expect(next.startsWith('# 自分のルール\n- A\n')).toBe(true)
    expect(next.trimEnd().endsWith('# 後ろの文')).toBe(true)
    expect(next.split(CODEX_BLOCK_START)).toHaveLength(2)
  })

  it('ルールが空になれば欄だけ外し、利用者の文を残す', () => {
    const withBlock = `# 前\n\n${block}\n\n# 後ろ\n`
    expect(withCodexGlobalBlock(withBlock, null)).toBe('# 前\n\n# 後ろ\n')
    expect(withCodexGlobalBlock(`${block}\n`, null)).toBe('')
  })

  it('終わりの印が無い壊れた欄は、新しく後ろに足す（前の文は消さない）', () => {
    const broken = `# 前\n${CODEX_BLOCK_START}\nold`
    const next = withCodexGlobalBlock(broken, block)!
    expect(next.startsWith(broken)).toBe(true)
    expect(next).toContain(CODEX_BLOCK_END)
  })
})

describe('オーケストラへの写し', () => {
  const child = { dir: 'a', name: 'A', agent: 'ferret-a', path: '/f/a', projectId: 'a' } as Parameters<typeof renderSubagent>[0]

  it('すべてのオーケストラの欄と subagent に全体のルールを書く', () => {
    const rules = { shared: 'S', global: '- G rule' }
    expect(renderOrchestratorGuide([child], rules)).toContain('- G rule')
    expect(renderSubagent(child, rules)).toContain('- G rule')
    expect(renderOrchestratorGuide([child], { shared: 'S' })).not.toContain('Global rules for every project')
  })

  it('グローバルの欄には、全部への適用の仕方と rules.md・projects.md の場所を書く', () => {
    const guide = renderOrchestratorGuide([child], undefined, { rulesPath: '/g/rules.md', projectsPath: '/g/projects.md' })
    expect(guide).toContain("Ferret's Global orchestra")
    expect(guide).toContain('/g/rules.md')
    expect(guide).toContain('/g/projects.md')
    expect(guide).toContain('one row per project')
    expect(guide.indexOf('Global orchestra')).toBeLessThan(guide.indexOf('## Orchestrator'))
    expect(renderOrchestratorGuide([child])).not.toContain('Global orchestra')
  })

  it('全体のルールは設定には持たない（読み込みで外す）', () => {
    expect(sanitizeOrchestraRules({ shared: 'S', global: 'G' })).toEqual({ shared: 'S' })
    expect(sanitizeOrchestraRules({ global: 'G' })).toBeUndefined()
  })
})

describe('ファイルの書き込み', () => {
  let dir: string
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'ferret-global-')) })
  afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

  it('rules.md は無いときだけ雛形を作り、書いたものは上書きしない。projects.md は今の登録で書く', async () => {
    const folder = join(dir, 'global')
    await mkdir(folder)
    await mkdir(join(dir, 'a'))
    const projects = [g({ folderPath: folder }), o('O1'), p('a', { folderPath: join(dir, 'a') })]
    await syncGlobalFiles(folder, projects, 'ja')
    expect(await readFile(join(folder, 'rules.md'), 'utf8')).toBe(globalRulesTemplate('ja'))
    expect(await readGlobalRules(folder)).toBe('')
    await writeFile(join(folder, 'rules.md'), '# x\n- 自分のルール\n')
    await syncGlobalFiles(folder, projects, 'ja')
    expect(await readGlobalRules(folder)).toBe('- 自分のルール')
    const list = await readFile(join(folder, 'projects.md'), 'utf8')
    expect(list).toContain(PROJECTS_LIST_MARKER)
    expect(list).toContain(join(dir, 'a'))
    expect(list).not.toContain('/f/O1')
  })

  it('利用者が置いた同じ名前の projects.md は書き直さない', async () => {
    await writeFile(join(dir, 'projects.md'), 'mine')
    await syncGlobalFiles(dir, [g({ folderPath: dir })], 'en')
    expect(await readFile(join(dir, 'projects.md'), 'utf8')).toBe('mine')
  })

  it('リンクの rules.md は読まない', async () => {
    await writeFile(join(dir, 'real.md'), '- secret')
    await symlink(join(dir, 'real.md'), join(dir, 'rules.md'))
    expect(await readGlobalRules(dir)).toBe('')
  })

  describe('Agent の全体の指示', () => {
    const env = {}
    const claudeFile = () => join(dir, '.claude', 'rules', CLAUDE_GLOBAL_RULES_FILE)

    it('設定のフォルダがある Agent にだけ書く', async () => {
      expect(await syncAgentGlobalRules('- rule', '/g/rules.md', dir, env)).toEqual({ changed: [], skipped: [] })
      await mkdir(join(dir, '.claude'))
      const result = await syncAgentGlobalRules('- rule', '/g/rules.md', dir, env)
      expect(result.changed).toEqual([claudeFile()])
      expect(await readFile(claudeFile(), 'utf8')).toContain('- rule')
    })

    it('Claude Code は Ferret のファイル、Codex は AGENTS.md の欄。同じなら書かず、空になれば外す', async () => {
      await mkdir(join(dir, '.claude'))
      await mkdir(join(dir, '.codex'))
      await writeFile(join(dir, '.codex', 'AGENTS.md'), '# 自分の指示\n')
      await writeFile(join(dir, '.claude', 'CLAUDE.md'), '# 自分の指示\n')
      const first = await syncAgentGlobalRules('- rule', '/g/rules.md', dir, env)
      expect(first.changed).toHaveLength(2)
      const codex = await readFile(join(dir, '.codex', 'AGENTS.md'), 'utf8')
      expect(codex.startsWith('# 自分の指示\n')).toBe(true)
      expect(codex).toContain('- rule')
      expect((await syncAgentGlobalRules('- rule', '/g/rules.md', dir, env)).changed).toEqual([])
      const cleared = await syncAgentGlobalRules('', '/g/rules.md', dir, env)
      expect(cleared.changed).toHaveLength(2)
      await expect(stat(claudeFile())).rejects.toThrow()
      expect(await readFile(join(dir, '.codex', 'AGENTS.md'), 'utf8')).toBe('# 自分の指示\n')
      // 利用者の CLAUDE.md には触れない
      expect(await readFile(join(dir, '.claude', 'CLAUDE.md'), 'utf8')).toBe('# 自分の指示\n')
    })

    it('Ferret のものでない同名のファイル・リンクは触らない', async () => {
      await mkdir(join(dir, '.claude', 'rules'), { recursive: true })
      await writeFile(claudeFile(), 'mine')
      await mkdir(join(dir, '.codex'))
      await writeFile(join(dir, 'other.md'), 'x')
      await symlink(join(dir, 'other.md'), join(dir, '.codex', 'AGENTS.md'))
      const result = await syncAgentGlobalRules('- rule', '/g/rules.md', dir, env)
      expect(result.changed).toEqual([])
      expect(result.skipped).toHaveLength(2)
      expect(await readFile(claudeFile(), 'utf8')).toBe('mine')
      expect(await readFile(join(dir, 'other.md'), 'utf8')).toBe('x')
    })

    it('CLAUDE_CONFIG_DIR・CODEX_HOME があればそちらに書く', async () => {
      const claude = join(dir, 'c')
      const codex = join(dir, 'x')
      await mkdir(claude)
      await mkdir(codex)
      await syncAgentGlobalRules('- rule', '/g/rules.md', dir, { CLAUDE_CONFIG_DIR: claude, CODEX_HOME: codex })
      expect(await readFile(join(claude, 'rules', CLAUDE_GLOBAL_RULES_FILE), 'utf8')).toContain('- rule')
      expect(await readFile(join(codex, 'AGENTS.md'), 'utf8')).toContain('- rule')
    })
  })
})
