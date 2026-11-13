/**
 * 初めて開いたプロジェクトのターミナル（src/renderer/terminal/startupLaunch.ts）。
 * プロジェクトは設定の Agent を起動し、オーケストラは何も開かない（2026-11-13 本人指示）
 */
import { describe, expect, it } from 'vitest'
import { startupLaunches } from '../../src/renderer/terminal/startupLaunch'

const none = new Set<string>()

describe('最初に開くタブ', () => {
  it('プロジェクトは startupAgents の順に Agent を起動する', () => {
    expect(startupLaunches({ projectId: 'p', orchestra: false, startupAgents: ['claude', 'codex'], disabled: none })).toEqual(['claude', 'codex'])
  })

  it('オーケストラは Agent もシェルも開かない（設定に Agent があっても）', () => {
    expect(startupLaunches({ projectId: 'o', orchestra: true, startupAgents: ['claude', 'codex'], disabled: none })).toEqual([])
    expect(startupLaunches({ projectId: 'o', orchestra: true, startupAgents: [], disabled: none })).toEqual([])
  })

  it('無効にした Agent は除く。全部無効なら素のシェル1つ', () => {
    expect(startupLaunches({ projectId: 'p', orchestra: false, startupAgents: ['claude', 'codex'], disabled: new Set(['claude']) })).toEqual(['codex'])
    expect(startupLaunches({ projectId: 'p', orchestra: false, startupAgents: ['claude'], disabled: new Set(['claude']) })).toEqual([null])
  })

  it('startupAgents が空なら素のシェル1つ', () => {
    expect(startupLaunches({ projectId: 'p', orchestra: false, startupAgents: [], disabled: none })).toEqual([null])
  })

  it('プロジェクトを開いていないときは Agent を起動せず、素のシェル1つ', () => {
    expect(startupLaunches({ projectId: null, orchestra: false, startupAgents: ['claude'], disabled: none })).toEqual([null])
  })

  it('渡した配列をそのまま返さない（呼び出し側が変えても設定に響かない）', () => {
    const agents = ['claude'] as const
    const out = startupLaunches({ projectId: 'p', orchestra: false, startupAgents: agents, disabled: none })
    expect(out).not.toBe(agents)
  })
})
