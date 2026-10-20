/**
 * 登録したプロジェクトのフォルダを、Claude Code / Codex に信頼済みとして先に書く（Orca と同じ）。
 * 一時フォルダの中に偽のホームを作って確かめる。本物の ~/.claude.json や ~/.codex には触らない。
 */
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  resetTrustMemo,
  applyAgentWorkspaceTrust,
  applyClaudeFolderTrust,
  grantClaudeFolderTrust,
  grantCodexProjectTrust,
  isRegisteredProjectFolder,
  parseProjectHeaderPath,
  resolveClaudeGlobalConfigFile,
  upsertCodexProjectTrust
} from '../../src/main/agentWorkspaceTrust'

let root: string
let home: string
let project: string

beforeEach(() => {
  resetTrustMemo()
  root = mkdtempSync(join(tmpdir(), 'ade-trust-'))
  home = join(root, 'home')
  project = join(root, 'work', 'my-app')
  mkdirSync(home, { recursive: true })
  mkdirSync(project, { recursive: true })
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

describe('Claude Code の設定', () => {
  it('projects[<path>].hasTrustDialogAccepted だけを足し、ほかの項目は残す', () => {
    const change = applyClaudeFolderTrust(
      { numStartups: 3, projects: { '/a': { allowedTools: ['x'] } } },
      ['/a', '/b']
    )
    expect(change).toEqual({
      kind: 'changed',
      config: {
        numStartups: 3,
        projects: { '/a': { allowedTools: ['x'], hasTrustDialogAccepted: true }, '/b': { hasTrustDialogAccepted: true } }
      }
    })
  })

  it('信頼済みなら何もしない。projects の形が壊れていれば書かない', () => {
    expect(applyClaudeFolderTrust({ projects: { '/a': { hasTrustDialogAccepted: true } } }, ['/a']).kind).toBe('unchanged')
    expect(applyClaudeFolderTrust({ projects: [] }, ['/a']).kind).toBe('refuse')
  })

  it('読む設定ファイルは CLAUDE_CONFIG_DIR（アカウント切り替え）を優先し、古い .config.json があればそれ', () => {
    const none = () => false
    // パスは OS の区切り（Windows は \\）で組み立てられるので、期待値も join で作る
    expect(resolveClaudeGlobalConfigFile({ env: {}, homeDir: '/h', exists: none })).toBe(join('/h', '.claude.json'))
    expect(resolveClaudeGlobalConfigFile({ env: { CLAUDE_CONFIG_DIR: '/acc' }, homeDir: '/h', exists: none })).toBe(join('/acc', '.claude.json'))
    const legacy = join('/h', '.claude', '.config.json')
    expect(resolveClaudeGlobalConfigFile({ env: {}, homeDir: '/h', exists: (p) => p === legacy })).toBe(legacy)
  })

  it('ファイルを読み込んで項目を足し、権限を保ったまま置き換える。ファイルが無ければ作らない', async () => {
    const file = join(home, '.claude.json')
    expect(await grantClaudeFolderTrust(file, [project])).toBe('missing-config')
    expect(existsSync(file)).toBe(false)

    writeFileSync(file, JSON.stringify({ userID: 'u', projects: { '/other': { x: 1 } } }))
    chmodSync(file, 0o600)
    expect(await grantClaudeFolderTrust(file, [project])).toBe('granted')
    const saved = JSON.parse(readFileSync(file, 'utf8'))
    expect(saved.userID).toBe('u')
    expect(saved.projects['/other']).toEqual({ x: 1 })
    expect(saved.projects[project]).toEqual({ hasTrustDialogAccepted: true })
    // Windows には POSIX の権限が無い（常に 0o666 と返る）ので、権限の確認は macOS / Linux だけ
    if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(await grantClaudeFolderTrust(file, [project])).toBe('unchanged')
  })

  it('続けて開くときは前に読んだ信頼の一覧を使い、外で書き換えられたら読み直す', async () => {
    const file = join(home, '.claude.json')
    const other = join(root, 'work', 'other')
    mkdirSync(other, { recursive: true })
    writeFileSync(file, JSON.stringify({ projects: { [project]: { hasTrustDialogAccepted: true } } }))
    expect(await grantClaudeFolderTrust(file, [project])).toBe('unchanged')
    // 別のフォルダは前の一覧に無いので、ロックを取って読み直して足す
    expect(await grantClaudeFolderTrust(file, [other])).toBe('granted')
    expect(JSON.parse(readFileSync(file, 'utf8')).projects[other]).toEqual({ hasTrustDialogAccepted: true })
    // Claude が書き換えた（信頼を外した）。大きさが変わるので読み直す
    writeFileSync(file, JSON.stringify({ projects: {}, note: 'rewritten by claude' }))
    expect(await grantClaudeFolderTrust(file, [project])).toBe('granted')
    expect(JSON.parse(readFileSync(file, 'utf8')).note).toBe('rewritten by claude')
  })

  it('壊れた JSON は書き換えない。Claude のロックが取られていれば書かない', async () => {
    const file = join(home, '.claude.json')
    writeFileSync(file, '{ broken')
    expect(await grantClaudeFolderTrust(file, [project])).toBe('unreadable')
    expect(readFileSync(file, 'utf8')).toBe('{ broken')

    writeFileSync(file, '{}')
    mkdirSync(`${file}.lock`)
    expect(await grantClaudeFolderTrust(file, [project])).toBe('locked')
    expect(readFileSync(file, 'utf8')).toBe('{}')
    // 他人のロックは消さない
    expect(existsSync(`${file}.lock`)).toBe(true)
  })
})

describe('Codex の config.toml', () => {
  it('表が無ければ末尾に足し、既存の行はそのまま残す', () => {
    const before = 'model = "gpt-5"\n# コメント\n'
    expect(upsertCodexProjectTrust(before, '/w/app')).toBe(
      'model = "gpt-5"\n# コメント\n\n[projects."/w/app"]\ntrust_level = "trusted"\n'
    )
    expect(upsertCodexProjectTrust('', '/w/app')).toBe('[projects."/w/app"]\ntrust_level = "trusted"\n')
  })

  it('表があれば trust_level だけを書き換えるか足す。信頼済みなら変えない', () => {
    const untrusted = '[projects."/w/app"]\ntrust_level = "untrusted"\nfoo = 1\n\n[other]\ntrust_level = "x"\n'
    expect(upsertCodexProjectTrust(untrusted, '/w/app')).toBe(
      '[projects."/w/app"]\ntrust_level = "trusted"\nfoo = 1\n\n[other]\ntrust_level = "x"\n'
    )
    const noKey = '[projects."/w/app"]\nfoo = 1\n'
    expect(upsertCodexProjectTrust(noKey, '/w/app')).toBe('[projects."/w/app"]\ntrust_level = "trusted"\nfoo = 1\n')
    const trusted = '["projects"."/w/app"]\ntrust_level = "trusted"\n'
    expect(upsertCodexProjectTrust(trusted, '/w/app')).toBe(trusted)
  })

  it('CRLF を保ち、複数行の文字列の中の [projects...] は見出しと見なさない', () => {
    expect(upsertCodexProjectTrust('a = 1\r\n', '/w')).toBe('a = 1\r\n\r\n[projects."/w"]\r\ntrust_level = "trusted"\r\n')
    const tricky = 'note = """\n[projects."/w"]\n"""\n'
    expect(upsertCodexProjectTrust(tricky, '/w')).toBe(`${tricky}\n[projects."/w"]\ntrust_level = "trusted"\n`)
  })

  it('見出しの書き方の違い（引用符・エスケープ）を読み分ける', () => {
    expect(parseProjectHeaderPath('[projects."/a\\"b"]')).toBe('/a"b')
    expect(parseProjectHeaderPath("[projects.'/c']  # x")).toBe('/c')
    expect(parseProjectHeaderPath('[projects]')).toBeNull()
    expect(parseProjectHeaderPath('[[projects."/a"]]')).toBeNull()
  })

  it('CODEX_HOME のフォルダが無ければ書かない。あればファイルを作るか書き足す', () => {
    expect(grantCodexProjectTrust(join(home, '.codex', 'config.toml'), project)).toBe('missing-config')
    mkdirSync(join(home, '.codex'))
    expect(grantCodexProjectTrust(join(home, '.codex', 'config.toml'), project)).toBe('granted')
    expect(readFileSync(join(home, '.codex', 'config.toml'), 'utf8')).toContain('trust_level = "trusted"')
    expect(grantCodexProjectTrust(join(home, '.codex', 'config.toml'), project)).toBe('unchanged')
  })
})

describe('起動のときの判断', () => {
  it('登録済みのプロジェクトのフォルダそのものだけを信頼する（サブフォルダ・ホームは含めない）', () => {
    expect(isRegisteredProjectFolder(project, [project])).toBe(true)
    expect(isRegisteredProjectFolder(join(project, 'src'), [project])).toBe(false)
    expect(isRegisteredProjectFolder(home, [project])).toBe(false)
  })

  it('登録していないフォルダやほかのエージェントには書かない', async () => {
    const file = join(home, '.claude.json')
    writeFileSync(file, '{}')
    expect(await applyAgentWorkspaceTrust({ agent: 'claude', cwd: home, projectFolders: [project], env: {}, homeDir: home })).toBe('skipped')
    expect(await applyAgentWorkspaceTrust({ agent: 'gemini', cwd: project, projectFolders: [project], env: {}, homeDir: home })).toBe('skipped')
    expect(readFileSync(file, 'utf8')).toBe('{}')
  })

  it('アカウント切り替え中は CLAUDE_CONFIG_DIR / CODEX_HOME の側に書く', async () => {
    const account = join(root, 'account')
    mkdirSync(account)
    writeFileSync(join(account, '.claude.json'), '{}')
    writeFileSync(join(home, '.claude.json'), '{}')
    expect(
      await applyAgentWorkspaceTrust({ agent: 'claude', cwd: project, projectFolders: [project], env: { CLAUDE_CONFIG_DIR: account }, homeDir: home })
    ).toBe('granted')
    expect(readFileSync(join(home, '.claude.json'), 'utf8')).toBe('{}')
    expect(JSON.parse(readFileSync(join(account, '.claude.json'), 'utf8')).projects).toBeTruthy()

    const codexHome = join(root, 'codex-account')
    mkdirSync(codexHome)
    expect(
      await applyAgentWorkspaceTrust({ agent: 'codex', cwd: project, projectFolders: [project], env: { CODEX_HOME: codexHome }, homeDir: home })
    ).toBe('granted')
    expect(existsSync(join(home, '.codex', 'config.toml'))).toBe(false)
    expect(readFileSync(join(codexHome, 'config.toml'), 'utf8')).toContain('trust_level = "trusted"')
  })
})
