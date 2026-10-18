import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { STOP_HOOK_COMMAND, STOP_HOOK_MAX_BLOCKS, STOP_HOOK_SCRIPT_FILE, mergeStopHookSettings, stopHookScript } from '../../src/shared/research/stopHook'

/**
 * 「参入先を決め切る」の Stop フック。生成したスクリプトを node で実際に動かし、
 * 依頼を受けたセッションでだけ、conclusion.md が決め切った条件を満たすまで止めない（上限つき）ことを確かめる
 */

let root: string
const write = (rel: string, text: string) => {
  mkdirSync(dirname(join(root, rel)), { recursive: true })
  writeFileSync(join(root, rel), text)
}
const candidate = (id: string, stage = 'discovered') => write(`candidates/${id}.md`, `---\nid: ${id}\ntitle: t\nstage: ${stage}\n---\n本文\n`)
const experiment = (id: string) => write(`experiments/${id}.md`, `---\nid: ${id}\ncandidate: C001\nstatus: planned\n---\n`)

const DONE = `# 参入先の結論（更新: 2026-10-18）
状態: 決め切った

## 参入先
C001 入札案件探し — 官公庁向けの実績がある IT 企業の営業責任者が、公示のたびに月3万円払う
- 売るもの: 案件の要約

## 選んだ理由（上位3件の比較）
| | C001 | C002 | C003 |

## 選ばなかった候補
- C002: 接触経路が無い
- C003: 支出の証拠が弱い

## 残る不確かさと最初の実験
- X001: 10社に有料で試してもらう / 合格 3社 / 中止 0社
- 不合格なら: 第2候補 C002

## 人が決めること
- [ ] G1〜G3 を判定する
`

function run(transcript: string | null, session = 's1') {
  let transcriptPath: string | undefined
  if (transcript !== null) {
    transcriptPath = join(root, '..', `${session}-transcript.jsonl`)
    writeFileSync(transcriptPath, transcript)
  }
  const r = spawnSync(process.execPath, [join(root, STOP_HOOK_SCRIPT_FILE)], {
    input: JSON.stringify({ session_id: session, transcript_path: transcriptPath, hook_event_name: 'Stop', stop_hook_active: false }),
    encoding: 'utf8'
  })
  const out = r.stdout.trim()
  return { status: r.status, stderr: r.stderr, block: out ? (JSON.parse(out) as { decision: string; reason: string }) : null }
}
const DECIDE = JSON.stringify({ type: 'user', message: { content: '【参入先を決め切る（結論まで止まらない）】\nリサーチ…' } })

beforeEach(() => {
  const base = mkdtempSync(join(tmpdir(), 'ferret-stop-hook-'))
  root = join(base, 'research')
  write(STOP_HOOK_SCRIPT_FILE, stopHookScript('<!-- ferret-research:generated -->'))
  candidate('C001')
  candidate('C002')
  candidate('C003')
  candidate('C004', 'dropped')
  experiment('X001')
})
afterEach(() => rmSync(dirname(root), { recursive: true, force: true }))

describe('Stop フックのスクリプト', () => {
  it('「参入先を決め切る」を受けていないセッションでは何もしない（ほかの依頼・トランスクリプトが無い）', () => {
    for (const t of [JSON.stringify({ type: 'user', message: { content: '【2 需要・支出・不満の証拠（What）】' } }), null]) {
      expect(run(t)).toMatchObject({ status: 0, block: null })
    }
    expect(existsSync(join(root, '.research/stop-hook'))).toBe(false)
  })

  it('conclusion.md が無ければ止めずに続けさせ、回数を数える', () => {
    const r = run(DECIDE)
    expect(r.status).toBe(0)
    expect(r.block?.decision).toBe('block')
    expect(r.block?.reason).toContain('conclusion.md がまだ無い')
    expect(r.block?.reason).toContain(`1/${STOP_HOOK_MAX_BLOCKS}`)
    expect(JSON.parse(readFileSync(join(root, '.research/stop-hook/s1.json'), 'utf8'))).toEqual({ blocks: 1 })
  })

  it('決め切った条件を満たせば止めてよい（回数も 0 に戻す）。除外した候補は書かなくてよい', () => {
    run(DECIDE)
    write('conclusion.md', DONE)
    expect(run(DECIDE)).toMatchObject({ status: 0, block: null })
    expect(JSON.parse(readFileSync(join(root, '.research/stop-hook/s1.json'), 'utf8'))).toEqual({ blocks: 0 })
  })

  it('足りないものを並べる: 状態・参入先が2つ・理由の無い候補・実験・第2候補・チェックリスト', () => {
    write('conclusion.md', `# 参入先の結論
状態: まだ

## 参入先
C001 か C002

## 残る不確かさと最初の実験
- X009: 未設計

## 人が決めること
- G1 を判定する
`)
    const reason = run(DECIDE).block?.reason ?? ''
    for (const s of ['「状態: 決め切った」になっていない', '候補の ID が1つだけ無い', '選ばなかった理由が無い候補: C003', '最初の実験', '第2候補（C???）が無い', 'チェックリスト']) expect(reason).toContain(s)
    expect(reason).not.toContain('C004')
  })

  it('続けさせるのは1セッション上限まで。超えたら止めてよい（stderr で知らせる）。セッションごとに数える', () => {
    write('.research/stop-hook/s1.json', JSON.stringify({ blocks: STOP_HOOK_MAX_BLOCKS }))
    const r = run(DECIDE)
    expect(r).toMatchObject({ status: 0, block: null })
    expect(r.stderr).toContain('上限')
    expect(run(DECIDE, 's2').block?.decision).toBe('block')
  })

  it('英語の依頼なら英語で続けさせる', () => {
    const en = JSON.stringify({ type: 'user', message: { content: '【Decide where to enter (do not stop until concluded)】' } })
    expect(run(en).block?.reason).toContain('conclusion.md does not exist yet')
  })

  it('英語の見出しの結論も決め切ったと読める', () => {
    write('conclusion.md', `Status: decided
## Where to enter
C001 bid search
## Candidates not chosen
- C002: no channel
- C003: weak evidence
## Remaining uncertainty and the first experiment
- X001: pass 3 / stop 0
- If it fails: runner-up C002
## What people decide
- [ ] judge G1–G3
`)
    expect(run(JSON.stringify({ c: '【Decide where to enter' })).block).toBeNull()
  })
})

describe('.claude/settings.json に足す', () => {
  const stopCommands = (text: string) => (JSON.parse(text) as { hooks: { Stop: Array<{ hooks: Array<{ command: string }> }> } }).hooks.Stop.flatMap((g) => g.hooks.map((h) => h.command))

  it('無ければ作る。利用者の設定・ほかのフックは残して足すだけ', () => {
    expect(stopCommands(mergeStopHookSettings(null)!)).toEqual([STOP_HOOK_COMMAND])
    const mine = JSON.stringify({ model: 'opus', hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo mine' }] }], PreToolUse: [] } })
    const next = JSON.parse(mergeStopHookSettings(mine)!) as Record<string, unknown>
    expect(next.model).toBe('opus')
    expect((next.hooks as Record<string, unknown>).PreToolUse).toEqual([])
    expect(stopCommands(JSON.stringify(next))).toEqual(['echo mine', STOP_HOOK_COMMAND])
  })

  it('もう入っている・読めない・形が違うなら書かない（null）', () => {
    expect(mergeStopHookSettings(mergeStopHookSettings(null))).toBeNull()
    for (const bad of ['{ broken', '[]', '"x"', JSON.stringify({ hooks: [] }), JSON.stringify({ hooks: { Stop: {} } })]) expect(mergeStopHookSettings(bad)).toBeNull()
  })
})
