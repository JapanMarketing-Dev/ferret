import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { LEGACY_AGENT_MAIL_SKILL_MARKER, removeLegacyAgentMailDirs, removeLegacyAgentMailSkill } from '../../src/main/agentMailCleanup'

/** 削除した「Agent どうしの依頼」の後片付け（src/main/agentMailCleanup.ts）。Ferret が書いたものだけを消す */
let root: string
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'ferret-mail-cleanup-test-')) })
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

const exists = (path: string) => readdir(path).then(() => true, () => false)
const FERRET_SKILL = `---\nname: ferret-agent-mail\n---\n\n${LEGACY_AGENT_MAIL_SKILL_MARKER} Ferret rewrites this file on start; local edits are overwritten. -->\n`

describe('removeLegacyAgentMailSkill', () => {
  it('Claude Code と Codex の、印のある skill を消してフォルダも消す', async () => {
    const home = join(root, 'home')
    for (const dir of [join(home, '.claude'), join(home, '.codex')]) {
      await mkdir(join(dir, 'skills', 'ferret-agent-mail'), { recursive: true })
      await writeFile(join(dir, 'skills', 'ferret-agent-mail', 'SKILL.md'), FERRET_SKILL)
    }
    const removed = await removeLegacyAgentMailSkill(home, {})
    expect(removed).toHaveLength(2)
    expect(await exists(join(home, '.claude', 'skills', 'ferret-agent-mail'))).toBe(false)
    expect(await exists(join(home, '.codex', 'skills', 'ferret-agent-mail'))).toBe(false)
    expect(await exists(join(home, '.claude', 'skills'))).toBe(true)
  })

  it('CLAUDE_CONFIG_DIR・CODEX_HOME の場所を見る', async () => {
    const claude = join(root, 'claude-config')
    await mkdir(join(claude, 'skills', 'ferret-agent-mail'), { recursive: true })
    await writeFile(join(claude, 'skills', 'ferret-agent-mail', 'SKILL.md'), FERRET_SKILL)
    expect(await removeLegacyAgentMailSkill(join(root, 'nohome'), { CLAUDE_CONFIG_DIR: claude })).toEqual([join(claude, 'skills', 'ferret-agent-mail', 'SKILL.md')])
  })

  it('印の無い（利用者の）skill は消さない', async () => {
    const home = join(root, 'home')
    const dir = join(home, '.claude', 'skills', 'ferret-agent-mail')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'SKILL.md'), '---\nname: ferret-agent-mail\n---\nmine\n')
    expect(await removeLegacyAgentMailSkill(home, {})).toEqual([])
    expect(await readdir(dir)).toEqual(['SKILL.md'])
  })

  it('リンクの skill は触らない。ほかのファイルがあればフォルダは残す', async () => {
    const home = join(root, 'home')
    const target = join(root, 'elsewhere.md')
    await writeFile(target, FERRET_SKILL)
    const linked = join(home, '.claude', 'skills', 'ferret-agent-mail')
    await mkdir(linked, { recursive: true })
    await symlink(target, join(linked, 'SKILL.md'))
    const kept = join(home, '.codex', 'skills', 'ferret-agent-mail')
    await mkdir(kept, { recursive: true })
    await writeFile(join(kept, 'SKILL.md'), FERRET_SKILL)
    await writeFile(join(kept, 'notes.txt'), 'x')
    expect(await removeLegacyAgentMailSkill(home, {})).toEqual([join(kept, 'SKILL.md')])
    expect(await readdir(linked)).toEqual(['SKILL.md'])
    expect(await readdir(kept)).toEqual(['notes.txt'])
  })

  it('設定のフォルダが無くても失敗しない', async () => {
    expect(await removeLegacyAgentMailSkill(join(root, 'missing'), {})).toEqual([])
  })
})

describe('removeLegacyAgentMailDirs', () => {
  it('Ferret の CLI がある受け口だけを消す', async () => {
    const posix = join(root, 'ferret-agent-mail-abc')
    await mkdir(join(posix, 'bin'), { recursive: true })
    await writeFile(join(posix, 'bin', 'ferret-agent-core'), '#!/bin/sh\n')
    await mkdir(join(posix, 'outbox'))
    const win = join(root, 'ferret-agent-mail-def')
    await mkdir(join(win, 'bin'), { recursive: true })
    await writeFile(join(win, 'bin', 'ferret-agent.ps1'), '')
    const other = join(root, 'ferret-agent-mail-zzz')
    await mkdir(join(other, 'bin'), { recursive: true })
    await writeFile(join(other, 'bin', 'something'), '')
    const unrelated = join(root, 'other-dir')
    await mkdir(join(unrelated, 'bin'), { recursive: true })
    await writeFile(join(unrelated, 'bin', 'ferret-agent-core'), '')
    const removed = await removeLegacyAgentMailDirs(root)
    expect(removed.sort()).toEqual([posix, win].sort())
    expect((await readdir(root)).sort()).toEqual(['ferret-agent-mail-zzz', 'other-dir'])
  })

  it('リンクは辿らない。置き場所が無くても失敗しない', async () => {
    const real = join(root, 'real')
    await mkdir(join(real, 'bin'), { recursive: true })
    await writeFile(join(real, 'bin', 'ferret-agent-core'), '')
    await symlink(real, join(root, 'ferret-agent-mail-link'))
    expect(await removeLegacyAgentMailDirs(root)).toEqual([])
    expect(await exists(join(real, 'bin'))).toBe(true)
    expect(await removeLegacyAgentMailDirs(join(root, 'missing'))).toEqual([])
  })
})
