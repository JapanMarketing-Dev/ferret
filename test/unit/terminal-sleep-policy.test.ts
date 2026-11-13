/**
 * Agent を休ませる決まり（src/renderer/terminal/sleepPolicy.ts）。
 * 休ませるのはメモリの知らせの「止める」を押したときだけ（自動では休ませない）。ここは「休ませて続きから戻せるか」だけを見る
 */
import { describe, expect, it } from 'vitest'
import * as policy from '../../src/renderer/terminal/sleepPolicy'
import { getPaneDirectory, publishPaneDirectory, resumableKeys, type SleepCandidate } from '../../src/renderer/terminal/sleepPolicy'

function pane(over: Partial<SleepCandidate> & { key: string }): SleepCandidate {
  return { launch: 'claude', cwd: '/b', accountId: null, awake: true, restorable: true, ...over }
}

describe('resumableKeys（休ませて続きから戻せるペイン）', () => {
  it('Claude Code・Codex は戻せる', () => {
    expect([...resumableKeys([pane({ key: 'c' }), pane({ key: 'x', launch: 'codex' })])]).toEqual(['c', 'x'])
  })

  it('素のシェル・続きから起動し直せない Agent は戻せない', () => {
    expect([...resumableKeys([pane({ key: 'sh', launch: null }), pane({ key: 'g', launch: 'cursor', cwd: '/g' })])]).toEqual([])
  })

  it('もう止まっている・戻せない（ログイン・1回きりのコマンド）ペインは戻せない', () => {
    expect([...resumableKeys([pane({ key: 'dead', awake: false }), pane({ key: 'login', restorable: false, cwd: '/l' })])]).toEqual([])
  })

  it('同じ Agent・フォルダ・アカウントのペインが2つあれば、どちらも戻せない（--continue で取り違える）', () => {
    expect([...resumableKeys([pane({ key: 'c1' }), pane({ key: 'c2' })])]).toEqual([])
  })

  it('止まっているペインも数に入れる（起動し直すと同じ会話を取り合う）', () => {
    expect([...resumableKeys([pane({ key: 'c1' }), pane({ key: 'c2', awake: false })])]).toEqual([])
  })

  it('フォルダかアカウントが違えば、それぞれ戻せる', () => {
    expect([...resumableKeys([pane({ key: 'c1' }), pane({ key: 'c2', cwd: '/other' }), pane({ key: 'c3', accountId: 'work' })])]).toEqual(['c1', 'c2', 'c3'])
  })

  it('同じフォルダでも素のシェルは数に入れない', () => {
    expect([...resumableKeys([pane({ key: 'c' }), pane({ key: 'sh', launch: null })])]).toEqual(['c'])
  })

  it('空なら空', () => {
    expect(resumableKeys([]).size).toBe(0)
  })
})

describe('自動で休ませる仕組みは無い（2026-11-13 本人指示）', () => {
  it('時間で休ませる関数・間隔を持たない', () => {
    expect('panesToSleep' in policy).toBe(false)
    expect('trackHidden' in policy).toBe(false)
    expect('SLEEP_AFTER_MS' in policy).toBe(false)
  })
})

describe('publishPaneDirectory（メモリの知らせが読むペインの一覧）', () => {
  it('main のターミナルID で引け、置き直すと前のものは消える', () => {
    publishPaneDirectory([{ ptyId: 't1', launch: 'claude', state: 'idle', resumable: true }])
    expect(getPaneDirectory().get('t1')?.resumable).toBe(true)
    publishPaneDirectory([{ ptyId: 't2', launch: null, state: 'unknown', resumable: false }])
    expect(getPaneDirectory().has('t1')).toBe(false)
    expect(getPaneDirectory().get('t2')?.launch).toBeNull()
    publishPaneDirectory([])
    expect(getPaneDirectory().size).toBe(0)
  })
})
