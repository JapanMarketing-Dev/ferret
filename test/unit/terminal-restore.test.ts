/**
 * 画面を読み込み直した（⌘R・HMR）あと、生きているターミナルに新しく作らずつなぎ直す。
 * 戻す先の無い孤立したターミナルだけを片付ける。
 */
import { describe, expect, it } from 'vitest'
import type { TerminalSessionInfo } from '@shared/types'
import { TerminalHistory } from '../../src/main/terminalHistory'
import { leaf, splitLeaf } from '../../src/renderer/terminal/paneTree'
import {
  buildTerminalSnapshot,
  dropRestoredPanes,
  maxKeySeq,
  parseTerminalSnapshot,
  planTerminalRestore,
  type TerminalSnapshot
} from '../../src/renderer/terminal/restorePlan'

const projects = [
  { id: 'p1', folderPath: '/w/app' },
  { id: 'p2', folderPath: '/w/site' }
]

function live(id: string, cwd: string, agent: TerminalSessionInfo['agent'] = null): TerminalSessionInfo {
  return { id, pid: 100, cwd, title: agent ? agent : `${id}: zsh`, agent }
}

function keyMaker() {
  let n = 100
  return (kind: 'tab' | 'pane') => `${kind}${++n}`
}

/** p1 に Claude Code と、右に分割したシェル。p2 に Codex。プロジェクトなしにシェル */
const snapshot: TerminalSnapshot = {
  version: 1,
  tabs: [
    { key: 'tab1', projectId: 'p1', layout: splitLeaf(leaf('pane1'), 'pane1', 'vertical', 'pane2'), activePane: 'pane2' },
    { key: 'tab2', projectId: 'p2', layout: leaf('pane3'), activePane: 'pane3' },
    { key: 'tab3', projectId: null, layout: leaf('pane4'), activePane: 'pane4' }
  ],
  panes: [
    { key: 'pane1', title: 'Claude Code', launch: 'claude', cwd: '/w/app', ptyId: 't1' },
    { key: 'pane2', title: '2: zsh', launch: null, cwd: '/w/app', ptyId: 't2' },
    { key: 'pane3', title: 'Codex', launch: 'codex', cwd: '/w/site', ptyId: 't3' },
    { key: 'pane4', title: '4: zsh', launch: null, cwd: null, ptyId: 't4' }
  ],
  activeByProject: { p1: 'tab1', p2: 'tab2', '': 'tab3' }
}

const allLive = [live('t1', '/w/app', 'claude'), live('t2', '/w/app'), live('t3', '/w/site', 'codex'), live('t4', '/Users/me')]

describe('planTerminalRestore', () => {
  it('記録と生きているターミナルが揃っていれば、元のタブ・分割の形のまま全部つなぎ直す（新しく作るものは無い）', () => {
    const plan = planTerminalRestore({ snapshot, live: allLive, projects, newKey: keyMaker() })
    expect(plan.close).toEqual([])
    expect(plan.tabs).toEqual(snapshot.tabs)
    // すべてのペインに PTY がある＝ terminal:create は呼ばれない
    expect(plan.panes.map((pane) => pane.ptyId)).toEqual(['t1', 't2', 't3', 't4'])
    expect(plan.panes.every((pane) => typeof pane.ptyId === 'string')).toBe(true)
    expect(plan.activeByProject).toEqual(snapshot.activeByProject)
  })

  it('終了したペインだけを分割から外し、選択中だったら残りへ移す', () => {
    const plan = planTerminalRestore({ snapshot, live: allLive.filter((t) => t.id !== 't2'), projects, newKey: keyMaker() })
    expect(plan.tabs[0]).toEqual({ key: 'tab1', projectId: 'p1', layout: leaf('pane1'), activePane: 'pane1' })
    expect(plan.close).toEqual([])
  })

  it('登録を外したプロジェクトのターミナルだけを片付け、ほかは戻す', () => {
    const plan = planTerminalRestore({ snapshot, live: allLive, projects: [projects[0]!], newKey: keyMaker() })
    expect(plan.close).toEqual(['t3'])
    expect(plan.tabs.map((tab) => tab.key)).toEqual(['tab1', 'tab3'])
    expect(plan.activeByProject).toEqual({ p1: 'tab1', '': 'tab3' })
  })

  it('記録が無くても、登録済みのプロジェクトのフォルダで開いていたものは1枚ずつタブを作って戻し、当てはまらないものだけ片付ける', () => {
    const plan = planTerminalRestore({ snapshot: null, live: allLive, projects, newKey: keyMaker() })
    expect(plan.close).toEqual(['t4'])
    expect(plan.tabs.map((tab) => tab.projectId)).toEqual(['p1', 'p1', 'p2'])
    expect(plan.panes.find((pane) => pane.ptyId === 't1')).toMatchObject({ launch: 'claude', title: 'claude', cwd: '/w/app' })
  })

  it('記録に無いターミナルが後から増えていたら、そのプロジェクトに足す', () => {
    const plan = planTerminalRestore({ snapshot, live: [...allLive, live('t9', '/w/site/')], projects, newKey: keyMaker() })
    expect(plan.close).toEqual([])
    expect(plan.tabs.at(-1)).toMatchObject({ projectId: 'p2' })
    expect(plan.panes.at(-1)).toMatchObject({ ptyId: 't9' })
  })

  it('生きているターミナルが無ければ何も戻さない', () => {
    expect(planTerminalRestore({ snapshot, live: [], projects, newKey: keyMaker() })).toEqual({
      tabs: [],
      panes: [],
      activeByProject: {},
      close: [],
      dormant: []
    })
  })

  it('PTY を作らずに置いていたペイン（dormant）は、分割の形に残して dormant に返す', () => {
    const withDormant: TerminalSnapshot = {
      ...snapshot,
      panes: snapshot.panes.map((pane) => (pane.key === 'pane1' ? { ...pane, ptyId: null, dormant: true } : pane))
    }
    const plan = planTerminalRestore({ snapshot: withDormant, live: allLive.filter((t) => t.id !== 't1'), projects, newKey: keyMaker() })
    expect(plan.tabs[0]).toEqual(snapshot.tabs[0])
    expect(plan.dormant.map((pane) => pane.key)).toEqual(['pane1'])
    expect(plan.panes.map((pane) => pane.key)).toEqual(['pane2', 'pane3', 'pane4'])
  })

  it('dormant だけのタブも残る。生きているターミナルが1つも無くても', () => {
    const only: TerminalSnapshot = {
      version: 1,
      tabs: [{ key: 'tab2', projectId: 'p2', layout: leaf('pane3'), activePane: 'pane3' }],
      panes: [{ key: 'pane3', title: 'Codex', launch: 'codex', cwd: '/w/site', ptyId: null, dormant: true }],
      activeByProject: { p2: 'tab2' }
    }
    const plan = planTerminalRestore({ snapshot: only, live: [], projects, newKey: keyMaker() })
    expect(plan.tabs).toEqual(only.tabs)
    expect(plan.dormant.map((pane) => pane.key)).toEqual(['pane3'])
    expect(plan.activeByProject).toEqual({ p2: 'tab2' })
  })

  it('dormant でも登録を外したプロジェクトのものは戻さない', () => {
    const gone: TerminalSnapshot = {
      ...snapshot,
      panes: snapshot.panes.map((pane) => (pane.key === 'pane3' ? { ...pane, ptyId: null, dormant: true } : pane))
    }
    const plan = planTerminalRestore({ snapshot: gone, live: allLive, projects: [projects[0]!], newKey: keyMaker() })
    expect(plan.dormant).toEqual([])
  })

  it('dormant の印の無い、PTY の無いペインは今までどおり外す', () => {
    const noPty: TerminalSnapshot = {
      ...snapshot,
      panes: snapshot.panes.map((pane) => (pane.key === 'pane3' ? { ...pane, ptyId: null } : pane))
    }
    const plan = planTerminalRestore({ snapshot: noPty, live: allLive.filter((t) => t.id !== 't3'), projects, newKey: keyMaker() })
    expect(plan.dormant).toEqual([])
    expect(plan.tabs.map((tab) => tab.key)).toEqual(['tab1', 'tab3'])
  })

  it('つなぎ直す前に終了したペインは、計画から外す', () => {
    const plan = planTerminalRestore({ snapshot, live: allLive, projects, newKey: keyMaker() })
    const dropped = dropRestoredPanes(plan, new Set(['pane3']))
    expect(dropped.tabs.map((tab) => tab.key)).toEqual(['tab1', 'tab3'])
    expect(dropped.activeByProject).toEqual({ p1: 'tab1', '': 'tab3' })
  })
})

describe('記録の読み書き', () => {
  it('書いた記録を読み戻せる。壊れた記録は null', () => {
    const built = buildTerminalSnapshot({
      tabs: snapshot.tabs,
      panes: snapshot.panes.map(({ ptyId: _ptyId, ...rest }) => rest),
      ptyIdOf: (key) => snapshot.panes.find((pane) => pane.key === key)?.ptyId ?? null,
      activeByProject: snapshot.activeByProject
    })
    expect(parseTerminalSnapshot(JSON.stringify(built))).toEqual(snapshot)
    expect(parseTerminalSnapshot('{oops')).toBeNull()
    expect(parseTerminalSnapshot(JSON.stringify({ version: 2 }))).toBeNull()
    expect(parseTerminalSnapshot(null)).toBeNull()
  })

  it('PTY の無い、作らずに置いているペインにだけ dormant の印を付け、読み直しても残る', () => {
    const built = buildTerminalSnapshot({
      tabs: snapshot.tabs,
      panes: snapshot.panes.map(({ ptyId: _ptyId, ...rest }) => rest),
      ptyIdOf: (key) => (key === 'pane1' || key === 'pane2' ? null : 'tX'),
      dormantOf: (key) => key === 'pane1' || key === 'pane3',
      activeByProject: snapshot.activeByProject
    })
    expect(built.panes.filter((pane) => pane.dormant).map((pane) => pane.key)).toEqual(['pane1'])
    expect(parseTerminalSnapshot(JSON.stringify(built))?.panes[0]).toMatchObject({ key: 'pane1', ptyId: null, dormant: true })
  })

  it('新しいキーが記録と重ならないよう、通し番号の最大を出す', () => {
    expect(maxKeySeq(['tab1', 'tab12', 'x3'], 'tab')).toBe(12)
    expect(maxKeySeq([], 'pane')).toBe(0)
  })
})

describe('TerminalHistory（直近の出力）', () => {
  it('上限までは全部返す', () => {
    const history = new TerminalHistory(100)
    history.push('hello\r\n')
    history.push('\x1b[31mred\x1b[0m')
    expect(history.snapshot()).toBe('hello\r\n\x1b[31mred\x1b[0m')
  })

  it('上限を超えたら古い側を捨て、最初の改行の後ろから返す（制御シーケンスの途中から始めない）', () => {
    const history = new TerminalHistory(12)
    history.push('aaaa\x1b[31mbb\ncc')
    history.push('dddd\n')
    const text = history.snapshot()
    expect(text).toBe('ccdddd\n')
    expect(text.length).toBeLessThanOrEqual(12)
  })
})
