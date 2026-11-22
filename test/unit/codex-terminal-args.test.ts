/**
 * Codex を Ferret のターミナルで代替画面なし（--no-alt-screen）で開く（src/shared/agentPolicy.ts の terminalArgsFor）。
 * 代替画面だとホイールを Codex が受けて上端で前の会話を読み込み、表示が跳ねてスクロールしにくい
 */
import { describe, expect, it } from 'vitest'
import { resolveAgentLaunchPolicy, terminalArgsFor } from '../../src/shared/agentPolicy'

const launch = (args: string, extra: Partial<Parameters<typeof resolveAgentLaunchPolicy>[0]> = {}) => {
  const result = resolveAgentLaunchPolicy({ agent: 'codex', command: '', args, projectId: null, skipPermissions: false, shell: 'posix', ...extra })
  return result.ok ? result.argv : null
}

describe('Codex の代替画面を使わない', () => {
  it('対話の画面を開くときは --no-alt-screen を足す（続きから開くときも）', () => {
    expect(launch('')).toEqual(['codex', '--no-alt-screen'])
    expect(launch('--model o4')).toEqual(['codex', '--no-alt-screen', '--model', 'o4'])
    expect(launch('', { resume: true })).toEqual(['codex', 'resume', '--last', '--no-alt-screen'])
    expect(launch('"fix the bug"')).toEqual(['codex', '--no-alt-screen', 'fix the bug'])
  })

  it('自分で書いていれば重ねない', () => {
    expect(launch('--no-alt-screen')).toEqual(['codex', '--no-alt-screen'])
    expect(terminalArgsFor('codex', [], ['--no-alt-screen=true'])).toEqual([])
  })

  it('対話の画面でないサブコマンドには足さない（コマンドの欄・引数の欄どちらでも）', () => {
    expect(terminalArgsFor('codex', ['exec'], [])).toEqual([])
    expect(terminalArgsFor('codex', [], ['review'])).toEqual([])
    expect(terminalArgsFor('codex', [], ['login'])).toEqual([])
    expect(launch('', { command: 'codex exec' })).toEqual(['codex', 'exec'])
    // -- の後はプロンプトなので、サブコマンドとして読まない
    expect(terminalArgsFor('codex', [], ['--', 'review'])).toEqual(['--no-alt-screen'])
  })

  it('ほかの Agent には足さない', () => {
    expect(terminalArgsFor('claude', [], [])).toEqual([])
    expect(terminalArgsFor('gemini', [], [])).toEqual([])
  })
})
