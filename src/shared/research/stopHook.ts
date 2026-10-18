/**
 * 「参入先を決め切る」を Claude Code に最後までやらせる Stop フック（リサーチのフォルダに Ferret が書く）。
 *
 *   .research/stop-check.mjs   … 判定のスクリプト（node の標準だけで動く。Ferret が書き直す）
 *   .claude/settings.json      … hooks.Stop にこのスクリプトを足す（利用者の設定は残し、無ければ足すだけ）
 *
 * Claude Code がターンを終えようとするたびに呼ばれ、次のときだけ終わらせずに続けさせる（{"decision":"block","reason"}）:
 *   - そのセッションで「参入先を決め切る」の依頼（見出し【参入先を決め切る…】／【Decide where to enter…】）を受けている
 *   - conclusion.md が決め切った条件を満たしていない（足りないものを reason に並べる）
 * ほかの依頼だけのセッションでは何もしない。続けさせる回数は1セッション MAX_BLOCKS 回まで（費用が際限なく増えないように）。
 * 判定は形だけを見る（中身の正しさは人が見る）: 状態が「決め切った」・参入先の候補が1つ・除外していない候補がすべて出てくる・
 * 実験が experiments/ にある・第2候補・人が決めることのチェックリスト
 */

export const STOP_HOOK_SCRIPT_FILE = '.research/stop-check.mjs'
export const STOP_HOOK_STATE_DIR = '.research/stop-hook'
export const STOP_HOOK_SETTINGS_FILE = '.claude/settings.json'
/** 1セッションで続けさせる上限 */
export const STOP_HOOK_MAX_BLOCKS = 50
export const STOP_HOOK_COMMAND = `node "$CLAUDE_PROJECT_DIR/${STOP_HOOK_SCRIPT_FILE}"`

export function stopHookScript(generatedMark: string): string {
  return `// ${generatedMark}
// Ferret が書くファイル（ビジネスリサーチの Stop フック）。手で直さない（Ferret が書き直す）。
// 「参入先を決め切る」の依頼を受けたセッションで、conclusion.md が決め切った条件を満たすまで Claude Code を止めない。
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const MAX_BLOCKS = ${STOP_HOOK_MAX_BLOCKS}
const MARKERS = { ja: '【参入先を決め切る', en: '【Decide where to enter' }
const root = dirname(dirname(fileURLToPath(import.meta.url)))

const readText = (p) => { try { return readFileSync(p, 'utf8') } catch { return null } }
let input = {}
try { input = JSON.parse(readFileSync(0, 'utf8') || '{}') } catch { input = {} }

const transcript = typeof input.transcript_path === 'string' ? readText(input.transcript_path) : null
const locale = transcript === null ? null : transcript.includes(MARKERS.ja) ? 'ja' : transcript.includes(MARKERS.en) ? 'en' : null
if (locale === null) process.exit(0)
const t = (ja, en) => (locale === 'en' ? en : ja)

const front = (text) => {
  const m = /^---\\r?\\n([\\s\\S]*?)\\r?\\n---/.exec(text)
  return m ? m[1] : ''
}
const field = (text, key) => {
  const m = new RegExp('^' + key + ':\\\\s*["\\']?([^"\\'\\\\s#]+)', 'm').exec(text)
  return m ? m[1] : null
}
const records = (dir, re) => {
  let names = []
  try { names = readdirSync(join(root, dir)) } catch { return [] }
  return names.filter((n) => re.test(n)).map((n) => {
    const head = front(readText(join(root, dir, n)) ?? '')
    return { id: field(head, 'id') ?? n.replace(/\\.md$/, ''), stage: field(head, 'stage'), status: field(head, 'status') }
  })
}
const sections = (text) => {
  const out = {}
  for (const part of text.split(/^## /m).slice(1)) {
    const nl = part.indexOf('\\n')
    out[(nl < 0 ? part : part.slice(0, nl)).trim()] = nl < 0 ? '' : part.slice(nl + 1)
  }
  return out
}
const section = (all, names) => {
  const key = Object.keys(all).find((k) => names.some((n) => k.startsWith(n)))
  return key === undefined ? null : all[key]
}

function missing() {
  const text = readText(join(root, 'conclusion.md'))
  if (text === null) return [t('conclusion.md がまだ無い（参入先の結論を書く）', 'conclusion.md does not exist yet (write the entry decision)')]
  const out = []
  if (!/^(状態|Status)\\s*[:：]\\s*(決め切った|decided)/im.test(text)) out.push(t('「状態: 決め切った」になっていない（6つの条件を満たしたら書く）', 'the status is not "Status: decided" (write it once all six conditions hold)'))
  const all = sections(text)
  const entry = section(all, ['参入先', 'Where to enter'])
  const firstLine = (entry ?? '').split('\\n').map((l) => l.trim()).find((l) => l) ?? ''
  const entryIds = [...new Set(firstLine.match(/\\bC\\d{2,4}\\b/g) ?? [])]
  if (entryIds.length !== 1) out.push(t('「## 参入先」の最初の行に候補の ID が1つだけ無い（「A か B」にしない）', 'the first line under "## Where to enter" does not name exactly one candidate ID (never "A or B")'))
  const open = records('candidates', /^C\\d{2,4}\\.md$/).filter((c) => c.stage !== 'dropped').map((c) => c.id)
  const absent = open.filter((id) => !new RegExp('\\\\b' + id + '\\\\b').test(text))
  if (absent.length) out.push(t('選ばなかった理由が無い候補: ' + absent.join(', '), 'candidates with no reason for not choosing them: ' + absent.join(', ')))
  const experiments = new Set(records('experiments', /^X\\d{2,4}\\.md$/).map((x) => x.id))
  const named = [...new Set(text.match(/\\bX\\d{2,4}\\b/g) ?? [])]
  if (!named.some((id) => experiments.has(id))) out.push(t('最初の実験（experiments/ に status: planned で設計した X???）が conclusion.md に無い', 'no first experiment (an X??? designed in experiments/ with status: planned) in conclusion.md'))
  if (!/(第2候補|runner-up)[^\\n]*\\bC\\d{2,4}\\b/i.test(text)) out.push(t('不合格のときの第2候補（C???）が無い', 'no runner-up candidate (C???) for when the experiment fails'))
  const people = section(all, ['人が決めること', 'What people decide'])
  if (people === null || !/^\\s*- \\[[ xX]\\]/m.test(people)) out.push(t('「## 人が決めること」のチェックリスト（- [ ] …）が無い', 'no checklist (- [ ] …) under "## What people decide"'))
  return out
}

const session = String(input.session_id ?? 'unknown').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 80) || 'unknown'
const stateDir = join(root, ${JSON.stringify(STOP_HOOK_STATE_DIR)})
const statePath = join(stateDir, session + '.json')
let blocks = 0
try { blocks = Number(JSON.parse(readFileSync(statePath, 'utf8')).blocks) || 0 } catch { blocks = 0 }
const save = (n) => { try { mkdirSync(stateDir, { recursive: true }); writeFileSync(statePath, JSON.stringify({ blocks: n })) } catch { /* 書けなくても判定は続ける */ } }

const left = missing()
if (left.length === 0) { if (existsSync(statePath)) save(0); process.exit(0) }
if (blocks >= MAX_BLOCKS) {
  process.stderr.write(t('参入先の結論がまだですが、続けさせる上限（' + MAX_BLOCKS + ' 回）に達したので止めます。', 'The entry decision is not settled, but the limit of ' + MAX_BLOCKS + ' continuations was reached, so stopping.') + '\\n')
  process.exit(0)
}
save(blocks + 1)
const reason = t(
  'まだ止まらない。参入先を決め切るまで続ける（' + (blocks + 1) + '/' + MAX_BLOCKS + '）。conclusion.md に足りないもの:\\n- ' + left.join('\\n- ') + '\\n結論を変えうるいちばん大きな不確かさから調べ、conclusion.md を書き直す。人に確認・中間報告をせず、決め切った条件（.research/README.md）を満たすまで続ける。',
  'Do not stop yet. Keep going until the entry is settled (' + (blocks + 1) + '/' + MAX_BLOCKS + '). Missing in conclusion.md:\\n- ' + left.join('\\n- ') + '\\nResearch the biggest uncertainty that could change the conclusion and rewrite conclusion.md. Do not ask people or report progress; continue until the done conditions (.research/README.md) hold.'
)
process.stdout.write(JSON.stringify({ decision: 'block', reason }))
`
}

/**
 * .claude/settings.json に Stop フックを足した中身。既にあれば・読めない（JSON でない・形が違う）なら null（書かない。利用者の設定を壊さない）
 */
export function mergeStopHookSettings(current: string | null): string | null {
  let settings: Record<string, unknown> = {}
  if (current !== null && current.trim()) {
    try {
      const parsed: unknown = JSON.parse(current)
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
      settings = parsed as Record<string, unknown>
    } catch {
      return null
    }
  }
  const hooks = settings.hooks ?? {}
  if (!hooks || typeof hooks !== 'object' || Array.isArray(hooks)) return null
  const stop = (hooks as Record<string, unknown>).Stop ?? []
  if (!Array.isArray(stop)) return null
  const already = stop.some((group) => Array.isArray((group as { hooks?: unknown })?.hooks)
    && ((group as { hooks: unknown[] }).hooks).some((h) => typeof (h as { command?: unknown })?.command === 'string' && (h as { command: string }).command.includes(STOP_HOOK_SCRIPT_FILE)))
  if (already) return null
  const next = { ...settings, hooks: { ...(hooks as Record<string, unknown>), Stop: [...stop, { hooks: [{ type: 'command', command: STOP_HOOK_COMMAND, timeout: 30 }] }] } }
  return `${JSON.stringify(next, null, 2)}\n`
}
