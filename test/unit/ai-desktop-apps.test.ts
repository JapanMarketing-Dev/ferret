/**
 * プロジェクトのフォルダを AI のデスクトップアプリ（ChatGPT・Claude・Gemini）で開く
 * （src/shared/aiDesktopApps.ts・src/main/aiDesktopApps.ts・Sidebar.tsx のプロジェクトのメニュー）
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getApplicationNameForProtocol: () => '' } }))

import { setLocale } from '@shared/i18n'
import { AI_DESKTOP_APPS, aiDesktopApp, aiDesktopAppsSupported, canOpenInAiApp, isAiDesktopAppId, macOpenArgs } from '../../src/shared/aiDesktopApps'
import { installedAiApps, openProjectInAiApp, type AiDesktopAppDeps } from '../../src/main/aiDesktopApps'
import type { Project } from '../../src/shared/types'

setLocale('ja')

const project = (over: Partial<Project> = {}): Project => ({ id: 'p1', name: 'shop', folderPath: '/Users/taro/shop', urls: [], ...over })

function deps(installed: Record<string, string>, over: Partial<AiDesktopAppDeps> = {}) {
  const calls: string[][] = []
  const value: AiDesktopAppDeps = {
    platform: 'darwin',
    appNameForProtocol: (protocol) => installed[protocol] ?? '',
    runOpen: async (args) => { calls.push(args) },
    ...over
  }
  return { value, calls }
}

const ALL = { 'codex://': 'ChatGPT', 'claude://': 'Claude', 'googlegemini://': 'Gemini' }

describe('AI のデスクトップアプリの一覧', () => {
  it('ChatGPT・Claude・Gemini を、フォルダを受け取れる macOS のアプリとして持つ', () => {
    expect(AI_DESKTOP_APPS.map((a) => [a.id, a.macBundleId, a.protocol])).toEqual([
      ['chatgpt', 'com.openai.codex', 'codex://'],
      ['claude', 'com.anthropic.claudefordesktop', 'claude://'],
      ['gemini', 'com.google.GeminiMacOS', 'googlegemini://']
    ])
    expect(aiDesktopApp('claude').label).toBe('Claude')
  })

  it('知らない名前は受け付けない', () => {
    expect(isAiDesktopAppId('gemini')).toBe(true)
    for (const bad of ['', 'GEMINI', 'cursor', null, 1, {}]) expect(isAiDesktopAppId(bad)).toBe(false)
  })

  it('macOS だけで出す', () => {
    expect(aiDesktopAppsSupported('darwin')).toBe(true)
    expect(aiDesktopAppsSupported('win32')).toBe(false)
    expect(aiDesktopAppsSupported('linux')).toBe(false)
  })

  it('手元にフォルダがあるプロジェクトだけで出す（SSH・すべてのプロダクトは出さない）', () => {
    expect(canOpenInAiApp(project())).toBe(true)
    expect(canOpenInAiApp(project({ source: 'github' }))).toBe(true)
    expect(canOpenInAiApp(project({ orchestrator: true }))).toBe(true)
    expect(canOpenInAiApp(project({ source: 'ssh' }))).toBe(false)
    expect(canOpenInAiApp(project({ editorWorkspace: true }))).toBe(false)
  })

  it('open には bundle id と絶対パスだけを渡す', () => {
    expect(macOpenArgs(aiDesktopApp('chatgpt'), '/Users/taro/shop')).toEqual(['-b', 'com.openai.codex', '/Users/taro/shop'])
    expect(macOpenArgs(aiDesktopApp('chatgpt'), '/Users/taro/物体 認識')).toEqual(['-b', 'com.openai.codex', '/Users/taro/物体 認識'])
    expect(macOpenArgs(aiDesktopApp('chatgpt'), '-a')).toBeNull()
    expect(macOpenArgs(aiDesktopApp('chatgpt'), 'relative/dir')).toBeNull()
    expect(macOpenArgs(aiDesktopApp('chatgpt'), '')).toBeNull()
  })
})

describe('入っているアプリを調べる', () => {
  it('URL スキームを開くアプリがあるものだけ返す', () => {
    expect(installedAiApps(deps(ALL).value)).toEqual(['chatgpt', 'claude', 'gemini'])
    expect(installedAiApps(deps({ 'claude://': 'Claude' }).value)).toEqual(['claude'])
    expect(installedAiApps(deps({ 'claude://': '   ' }).value)).toEqual([])
  })

  it('macOS 以外は空', () => {
    expect(installedAiApps(deps(ALL, { platform: 'win32' }).value)).toEqual([])
  })

  it('調べるのに失敗したアプリは出さない', () => {
    const d = deps(ALL, { appNameForProtocol: (p) => { if (p === 'codex://') throw new Error('x'); return 'App' } })
    expect(installedAiApps(d.value)).toEqual(['claude', 'gemini'])
  })
})

describe('プロジェクトのフォルダを開く', () => {
  it('登録済みのプロジェクトのフォルダを、そのアプリで開く', async () => {
    const d = deps(ALL)
    await openProjectInAiApp([project()], 'p1', 'gemini', d.value)
    expect(d.calls).toEqual([['-b', 'com.google.GeminiMacOS', '/Users/taro/shop']])
  })

  it('知らないプロジェクト・知らないアプリ・SSH・すべてのプロダクトは開かない', async () => {
    const d = deps(ALL)
    await expect(openProjectInAiApp([project()], 'nope', 'claude', d.value)).rejects.toThrow('プロジェクトが見つかりません')
    await expect(openProjectInAiApp([project()], 42, 'claude', d.value)).rejects.toThrow('プロジェクトが見つかりません')
    await expect(openProjectInAiApp([project()], 'p1', 'cursor', d.value)).rejects.toThrow('プロジェクトが見つかりません')
    await expect(openProjectInAiApp([project({ source: 'ssh' })], 'p1', 'claude', d.value)).rejects.toThrow('プロジェクトが見つかりません')
    await expect(openProjectInAiApp([project({ editorWorkspace: true })], 'p1', 'claude', d.value)).rejects.toThrow('プロジェクトが見つかりません')
    expect(d.calls).toEqual([])
  })

  it('入っていなければ、そう伝える', async () => {
    const d = deps({ 'claude://': 'Claude' })
    await expect(openProjectInAiApp([project()], 'p1', 'chatgpt', d.value)).rejects.toThrow('ChatGPT のデスクトップアプリが見つかりません')
    expect(d.calls).toEqual([])
  })

  it('macOS 以外では開かない', async () => {
    const d = deps(ALL, { platform: 'linux' })
    await expect(openProjectInAiApp([project()], 'p1', 'claude', d.value)).rejects.toThrow('Claude のデスクトップアプリが見つかりません')
  })

  it('open が失敗したら、開けなかったと伝える', async () => {
    const d = deps(ALL, { runOpen: async () => { throw new Error('LSOpenURLsWithRole() failed') } })
    await expect(openProjectInAiApp([project()], 'p1', 'claude', d.value)).rejects.toThrow('Claude で開けませんでした')
  })

  it('フォルダが絶対パスでなければ開かない', async () => {
    const d = deps(ALL)
    await expect(openProjectInAiApp([project({ folderPath: '-n' })], 'p1', 'claude', d.value)).rejects.toThrow('Claude で開けませんでした')
    expect(d.calls).toEqual([])
  })
})

describe('つなぎ込み', () => {
  it('IPC とサイドバーのメニューにつながっている', () => {
    const ipc = readFileSync('src/shared/ipc.ts', 'utf8')
    expect(ipc).toContain("'project:aiApps': () => AiDesktopAppId[]")
    expect(ipc).toContain("'project:openInAiApp': (id: string, app: AiDesktopAppId) => void")
    const main = readFileSync('src/main/index.ts', 'utf8')
    expect(main).toContain("openProjectInAiApp(currentSettings().projects, id, appId)")
    const sidebar = readFileSync('src/renderer/components/Sidebar.tsx', 'utf8')
    expect(sidebar).toContain("window.ade.invoke('project:openInAiApp', menuProject.id, id)")
    expect(sidebar).toContain('canOpenInAiApp(menuProject) && aiApps.length > 0')
  })
})
