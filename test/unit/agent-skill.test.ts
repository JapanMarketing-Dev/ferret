import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, posix } from 'node:path'
import { AGENT_SKILL_NAME, SKILL_MARKER, agentSkillPath, isFerretSkill, renderAgentSkill } from '../../src/shared/agentSkill'
import { SETTINGS_SCHEMA, STATE_KEYS, type JsonSchema } from '../../src/shared/settingsSchema'
import { agentSkillStatus, installAgentSkill, syncAgentSkill } from '../../src/main/agentSkill'

const context = { settingsPath: '/home/taro/.ferret/settings.json', schemaPath: '/home/taro/.ferret/settings.schema.json', version: '9.9.9' }

describe('Ferret の設定を変える skill の中身', () => {
  const text = renderAgentSkill(context)

  it('Claude Code・Codex が読む SKILL.md の形（name・description の前書き）で、Ferret が書いた印がある', () => {
    expect(text.startsWith(`---\nname: ${AGENT_SKILL_NAME}\ndescription: `)).toBe(true)
    expect(isFerretSkill(text)).toBe(true)
    expect(isFerretSkill('---\nname: ferret-settings\n---\nmine')).toBe(false)
    expect(text).toContain(SKILL_MARKER)
  })

  it('作っている Chrome 拡張の登録・最新にする（reload）・外すをターミナルからできる手順を書く', () => {
    const section = text.slice(text.indexOf('## Chrome extensions you are building'), text.indexOf('## How to edit'))
    for (const word of ['**Register**', '`browserExtensions`', 'absolute path', '**Update to the latest build**', '`reload`', 'Unix time', '**Turn off / remove**', '"enabled": false', 'delete the entry']) expect(section).toContain(word)
    expect(section).toMatch(/at most \d+\)/)
    expect(text).toContain('`browserExtensions[].reload`')
  })

  it('オーケストラ（対象外・ルール・依頼・グローバル）を Agent が直接変えられる手順を書く。ダッシュボードの集計・human.md・コストは書かない', () => {
    const section = text.slice(text.indexOf('## Orchestras (several products under one agent)'), text.indexOf('## How to edit'))
    expect(section.length).toBeGreaterThan(1000)
    for (const word of ['"editorWorkspace": true', '`orchestraId`', '`projects[].orchestraExcluded: true`', '`orchestra.shared`', '`orchestra.allowed`', '`agentRequests.items`', '`hidden: true`', '"global": true', 'rules.md', 'in parallel', 'Interrupted work']) expect(section).toContain(word)
    for (const word of ['.ferret/dashboard.json', '.ferret/costs.json', 'monthlyUsd', '| No. | Product | URL | What to check |']) expect(section).not.toContain(word)
    expect(section).toContain('<Ferret user data>/editor-workspace')
    expect(renderAgentSkill({ ...context, editorWorkspacePath: '/home/taro/Library/Ferret/editor-workspace' })).toContain('`/home/taro/Library/Ferret/editor-workspace`')
    expect(text.split('\n')[2]).toMatch(/orchestra/)
  })

  it('この Ferret の設定ファイルとスキーマの場所を書く', () => {
    expect(text).toContain('`/home/taro/.ferret/settings.json`')
    expect(text).toContain('`/home/taro/.ferret/settings.schema.json`')
  })

  it('全体の項目はスキーマの上の階層のキーすべて（projects・状態・$schema を除く）。設定の項目が増えれば skill にも出る', () => {
    const top = Object.keys(SETTINGS_SCHEMA.properties!).filter((k) => !['$schema', 'projects', 'folderPath', 'url', 'viewport', 'activeProjectId', 'starPrompt'].includes(k))
    for (const key of top) expect(text).toContain(`| \`${key}\` |`)
    expect(text).not.toContain('| `projects` |')
    const extra = renderAgentSkill({ ...context, schema: { ...SETTINGS_SCHEMA, properties: { ...SETTINGS_SCHEMA.properties, brandNewKey: { type: 'boolean', description: 'A new thing.' } } } })
    expect(extra).toContain('| `brandNewKey` | boolean | A new thing. |')
  })

  it('プロジェクトの項目と確認先（URL・起動コマンド・ウインドウ）を、プロジェクトの範囲として分けて書く', () => {
    expect(text).toContain('### Project scope')
    for (const key of ['name', 'kind', 'folderPath']) expect(text).toContain(`| \`projects[].${key}\` |`)
    for (const key of ['url', 'launchCommand', 'windowMatch', 'purpose']) expect(text).toContain(`| \`projects[].urls[].${key}\` |`)
    expect(text).toContain('Decide the scope first')
  })

  it('キーを設定ファイルに書かせない。平文のキー（apiKey）は表に出さず、出さない理由を書く', () => {
    expect(text).toMatch(/Do not write API keys or tokens into the file/)
    expect(text).toContain('The plaintext `apiKey` fields are left out of this skill on purpose')
    expect(text).not.toMatch(/apiKey` \|/)
    expect(text).toContain('.apiKeyEnv` |')
  })

  it('アカウント（agentAccounts）は中の項目を出さず、Ferret の Accounts で変えるよう書く', () => {
    expect(text).not.toContain('| `agentAccounts.')
    expect(text).toMatch(/\| `agentAccounts` \| object \| Managed by Ferret, do not edit/)
    expect(text).toMatch(/Do not edit `agentAccounts`/)
  })

  // スキーマの葉（入れ子・配列の中も）を別の書き方でたどり、どれも skill の表にあることを確かめる。
  // 同じ形の子は <id> の1行にまとめるので、その段は <id> でもよく、そのときは元のキーが一覧にあること
  const leafPaths = (properties: Record<string, JsonSchema>, prefix: string[]): string[][] =>
    Object.entries(properties).flatMap(([key, value]) => {
      // 削除した項目（deprecated）は skill に載せない
      if (value.deprecated) return []
      const path = [...prefix, key]
      const nested = value.properties ?? (value.type === 'array' ? value.items?.properties : undefined)
      if (!nested) return [path]
      return [path, ...leafPaths(nested, value.properties ? path : [...prefix, `${key}[]`])]
    })
  const listed = (path: string[]): boolean => {
    const pattern = path.map((seg) => `(?:${seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}|<id>)`).join('\\.')
    const row = new RegExp(`^\\| \`${pattern}\` \\|`, 'm')
    if (!row.test(text)) return false
    const generic = text.match(row)![0]
    return generic.split('.').every((seg, i) => !seg.includes('<id>') || text.includes(`\`${path[i]}\``))
  }

  it('skill の表とスキーマが一致する: 秘密・アカウント・状態のほかは、どの階層の設定も漏れなく載る', () => {
    const skip = new Set(['$schema', 'agentAccounts', ...STATE_KEYS])
    // projects と projects[].urls そのものは表の前の文で説明する（中の項目は表に出る）
    const containers = new Set(['projects', 'projects[].urls'])
    const paths = leafPaths(SETTINGS_SCHEMA.properties!, []).filter((p) => !skip.has(p[0]) && !p.includes('apiKey') && !containers.has(p.join('.')))
    const missing = paths.filter((p) => !listed(p))
    expect(missing.map((p) => p.join('.'))).toEqual([])
    expect(paths.length).toBeGreaterThan(100)
  })

  it('入れ子の設定が増えれば、その行も出る（手で一覧を直さなくてよい）', () => {
    const capture = SETTINGS_SCHEMA.properties!.capture
    const extra = renderAgentSkill({ ...context, schema: { ...SETTINGS_SCHEMA, properties: { ...SETTINGS_SCHEMA.properties, capture: { ...capture, properties: { ...capture.properties, brandNewNested: { type: 'integer', description: 'Nested.', minimum: 1, maximum: 9, default: 2 } } } } } })
    expect(extra).toContain('| `capture.brandNewNested` | integer (1-9, default 2) | Nested. |')
    const noFooter = renderAgentSkill({ ...context, schema: { ...SETTINGS_SCHEMA, properties: { ...SETTINGS_SCHEMA.properties, layout: { type: 'object', description: 'x' } } } })
    expect(noFooter).not.toContain('layout.footer')
  })

  it('同じ形の子（提供元・パネル・フッターの項目）は <id> の1行にまとめ、キーの一覧を書く', () => {
    expect(text).toMatch(/\| `layout\.footer\.items\.<id>` \| boolean \| <id> is one of `/)
    expect(text).toMatch(/\| `organizer\.endpoints\.<id>\.baseUrl` \|/)
    expect(text).toContain('| `decision.pricing.outputPer1M` |')
  })
})

describe('skill を入れる・合わせる', () => {
  let home: string
  const where = () => ({ env: {}, home })
  const claudePath = () => agentSkillPath('claude', {}, home, join)
  const codexPath = () => agentSkillPath('codex', {}, home, join)

  beforeEach(async () => { home = await mkdtemp(join(tmpdir(), 'ferret-skill-')) })
  afterEach(async () => { await rm(home, { recursive: true, force: true }) })

  it('CLAUDE_CONFIG_DIR・CODEX_HOME があればそちらに置く', () => {
    expect(agentSkillPath('claude', { CLAUDE_CONFIG_DIR: '/x/claude' }, '/h', posix.join)).toBe('/x/claude/skills/ferret-settings/SKILL.md')
    expect(agentSkillPath('codex', { CODEX_HOME: '/x/codex' }, '/h', posix.join)).toBe('/x/codex/skills/ferret-settings/SKILL.md')
    expect(agentSkillPath('codex', {}, '/h', posix.join)).toBe('/h/.codex/skills/ferret-settings/SKILL.md')
  })

  it('使っている Agent（設定のフォルダがある）にだけ入れる。どれも無ければ Claude Code に入れる', async () => {
    await mkdir(join(home, '.codex'))
    const after = await installAgentSkill(context, undefined, where())
    expect(after.find((s) => s.agent === 'codex')).toMatchObject({ installed: true, upToDate: true })
    expect(after.find((s) => s.agent === 'claude')).toMatchObject({ installed: false })

    const empty = await mkdtemp(join(tmpdir(), 'ferret-skill-empty-'))
    try {
      const fresh = await installAgentSkill(context, undefined, { env: {}, home: empty })
      expect(fresh.find((s) => s.agent === 'claude')?.installed).toBe(true)
    } finally { await rm(empty, { recursive: true, force: true }) }
  })

  it('同じ名前で Ferret のものでない skill は上書きしない', async () => {
    await mkdir(join(home, '.claude', 'skills', 'ferret-settings'), { recursive: true })
    await writeFile(claudePath(), 'my own skill')
    const after = await installAgentSkill(context, ['claude'], where())
    expect(after.find((s) => s.agent === 'claude')).toMatchObject({ installed: false, foreign: true })
    expect(await readFile(claudePath(), 'utf8')).toBe('my own skill')
  })

  it('リンクを通しては書かない（別の場所のファイルを書き換えさせない）', async () => {
    const outside = join(home, 'outside.md')
    await writeFile(outside, 'outside')
    await mkdir(join(home, '.claude', 'skills', 'ferret-settings'), { recursive: true })
    await symlink(outside, claudePath())
    const after = await installAgentSkill(context, ['claude'], where())
    expect(after.find((s) => s.agent === 'claude')?.foreign).toBe(true)
    expect(await readFile(outside, 'utf8')).toBe('outside')
  })

  it('起動時は、入れてある Ferret の skill だけを今の設定の項目と置き場所に合わせる。入れていない Agent には足さない', async () => {
    await mkdir(join(home, '.claude'))
    await mkdir(join(home, '.codex'))
    await installAgentSkill(context, ['claude'], where())
    const moved = { ...context, settingsPath: '/elsewhere/settings.json', version: '10.0.0' }
    expect(await syncAgentSkill(moved, where())).toBe(1)
    expect(await readFile(claudePath(), 'utf8')).toContain('/elsewhere/settings.json')
    expect((await agentSkillStatus(moved, where())).find((s) => s.agent === 'codex')?.installed).toBe(false)
    await expect(readFile(codexPath(), 'utf8')).rejects.toThrow()
    // 同じ中身なら書き直さない
    expect(await syncAgentSkill(moved, where())).toBe(0)
  })
})
