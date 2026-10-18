import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setLocale } from '@shared/i18n'
import { MAX_RECORD_BYTES, formatRecordFile, parseRecordFile, parseYaml } from '@shared/business/format'
import { emptyCandidate, emptyEvidence } from '@shared/research/records'
import { DEFAULT_WEIGHTS, type Candidate, type ResearchEvidence } from '@shared/research/model'
import type { BusinessSendTarget } from '@shared/business/ipc'
import { MemoryApprovalLedger } from '../../src/main/business/approvalLedger'
import { BLOCK_START as BUSINESS_BLOCK_START, BLOCK_END as BUSINESS_BLOCK_END } from '../../src/main/business/store'
import {
  BLOCK_END,
  BLOCK_START,
  GENERATED_MARK,
  LIMITS,
  ResearchStore,
  agentBlock,
  knowledgeCopy,
  localizeError,
  upsertBlock
} from '../../src/main/research/store'
import { UserFacingError } from '@shared/errors'

const NOW = new Date('2026-10-18T03:00:00.000Z')
const KNOWLEDGE = '# 集客の5原則\n\n本文\n'

let dir: string
let root: string
let ledger: MemoryApprovalLedger
let store: ResearchStore
let locale: 'ja' | 'en' = 'ja'

function make(extra: { loadBudgetBytes?: number; now?: () => Date } = {}): ResearchStore {
  return new ResearchStore({ root, now: () => NOW, locale: () => locale, knowledge: KNOWLEDGE, ledger, ...extra })
}
const read = (rel: string) => readFileSync(join(root, rel), 'utf8')
function write(rel: string, text: string | Buffer): void {
  mkdirSync(join(root, rel, '..'), { recursive: true })
  writeFileSync(join(root, rel), text)
}
const front = (rel: string) => parseRecordFile(read(rel)).data as Record<string, unknown>

function candidate(id = 'C001', over: (c: Candidate) => void = () => undefined): Candidate {
  const c = emptyCandidate(id, NOW.toISOString())
  c.title = '経理の証憑回収'
  c.scene = { company: '従業員20〜100人の会社', who: '経理担当', event: '月末の締め', outcome: '証憑を期限内に集め終える', currentHandling: 'メールで催促' }
  over(c)
  return c
}
function evidence(id = 'E001', over: Partial<ResearchEvidence> = {}): ResearchEvidence {
  return { ...emptyEvidence(id, NOW.toISOString()), candidate: 'C001', grade: 'contract', kind: 'spend', url: 'https://example.com/a', quote: '月額3万円', fact: '契約がある', inference: '払う意思', ...over }
}

beforeAll(() => setLocale('ja'))

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'research-store-')))
  root = join(dir, 'research')
  mkdirSync(root)
  ledger = new MemoryApprovalLedger()
  locale = 'ja'
  store = make()
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const init = () => store.init({ name: '日本の B2B', scope: '既存ソフトウェアへの支出' })

describe('init', () => {
  it('ひな型を書く: research.yaml・フォルダ・ナレッジ・README・context・CLAUDE.md/AGENTS.md の案内', async () => {
    const snap = await init()
    expect(snap.data.research).toMatchObject({ name: '日本の B2B', scope: '既存ソフトウェアへの支出', weights: DEFAULT_WEIGHTS, createdAt: NOW.toISOString() })
    for (const d of ['candidates', 'evidence', 'experiments', 'principles', '.research', '.research/sent', '.research/trash']) expect(lstatSync(join(root, d)).isDirectory()).toBe(true)
    const yaml = parseYaml(read('research.yaml')) as Record<string, unknown>
    expect(yaml.name).toBe('日本の B2B')
    expect(read('principles/knowledge.md')).toBe(knowledgeCopy(KNOWLEDGE, '2026-10-18'))
    expect(read('principles/knowledge.md')).toContain(GENERATED_MARK)
    expect(read('.research/README.md').startsWith(GENERATED_MARK)).toBe(true)
    expect(read('.research/context.md').length).toBeGreaterThan(10)
    for (const f of ['CLAUDE.md', 'AGENTS.md']) {
      expect(read(f)).toContain(BLOCK_START)
      expect(read(f)).toContain('.research/context.md')
    }
  })

  it('名前が要る。長すぎる名前・文字でない値は断る', async () => {
    await expect(store.init({ name: '  ', scope: '' })).rejects.toThrow('リサーチの名前を入れてください')
    await expect(store.init({ name: 'a'.repeat(LIMITS.name + 1), scope: '' })).rejects.toThrow('100 文字まで')
    await expect(store.init({ name: 3, scope: '' })).rejects.toThrow('正しくありません')
    await expect(store.init(null)).rejects.toThrow('リサーチの名前')
    expect(existsSync(join(root, 'research.yaml'))).toBe(false)
  })

  it('2回目は research.yaml を上書きしない。人が書いた README（印なし）は触らない。印のあるものは書き直す', async () => {
    await init()
    write('research.yaml', 'name: 変えた名前\n')
    write('.research/README.md', '# 人が書いた\n')
    write('principles/knowledge.md', `${GENERATED_MARK}\n古い版\n`)
    const snap = await store.init({ name: '別の名前', scope: '' })
    expect(snap.data.research.name).toBe('変えた名前')
    expect(read('.research/README.md')).toBe('# 人が書いた\n')
    expect(read('principles/knowledge.md')).toBe(knowledgeCopy(KNOWLEDGE, '2026-10-18'))
  })

  it('写した日だけが違うナレッジは書き直さない', async () => {
    await init()
    const later = make({ now: () => new Date('2026-11-01T00:00:00Z') })
    await later.init({})
    expect(read('principles/knowledge.md')).toContain('/ 2026-10-18')
  })

  it('CLAUDE.md の人の文とビジネスの案内は残し、リサーチの印の間だけ差し替える', async () => {
    const business = `${BUSINESS_BLOCK_START}\nビジネス\n${BUSINESS_BLOCK_END}`
    write('CLAUDE.md', `# 人の文\n\n${business}\n`)
    await init()
    locale = 'en'
    await make().init({})
    const text = read('CLAUDE.md')
    expect(text.startsWith('# 人の文')).toBe(true)
    expect(text).toContain(business)
    expect(text.split(BLOCK_START)).toHaveLength(2)
    expect(text).toContain('Ferret business research')
  })

  it('CLAUDE.md がリンクなら触らない（リンク先を書き換えない）', async () => {
    writeFileSync(join(dir, 'target.md'), 'outside\n')
    symlinkSync(join(dir, 'target.md'), join(root, 'CLAUDE.md'))
    await init()
    expect(readFileSync(join(dir, 'target.md'), 'utf8')).toBe('outside\n')
    expect(lstatSync(join(root, 'CLAUDE.md')).isSymbolicLink()).toBe(true)
  })

  it('.git があれば送った履歴とゴミ箱を .git/info/exclude に足す（1回だけ）', async () => {
    mkdirSync(join(root, '.git', 'info'), { recursive: true })
    await init()
    await make().init({})
    const ex = read('.git/info/exclude')
    expect(ex.match(/\.research\/sent\//g)).toHaveLength(1)
    expect(ex).toContain('.research/trash/')
    expect(ex).toContain('.research/stop-hook/')
  })

  it('Stop フック: スクリプトと .claude/settings.json を書き、利用者の設定は残す。印の無いスクリプトは書き直さない', async () => {
    write('.claude/settings.json', JSON.stringify({ model: 'opus' }))
    await init()
    expect(read('.research/stop-check.mjs')).toContain('ferret-research:generated')
    const settings = JSON.parse(read('.claude/settings.json')) as { model: string; hooks: { Stop: Array<{ hooks: Array<{ command: string }> }> } }
    expect(settings.model).toBe('opus')
    expect(settings.hooks.Stop[0]!.hooks[0]!.command).toContain('.research/stop-check.mjs')
    // 2回目も重ねない
    await init()
    expect((JSON.parse(read('.claude/settings.json')) as typeof settings).hooks.Stop).toHaveLength(1)
    write('.research/stop-check.mjs', '// 自分で直した')
    await init()
    expect(read('.research/stop-check.mjs')).toBe('// 自分で直した')
  })

  it('agentBlock: どの言語でも、ゴール（参入先を1つに決め切る・結論は conclusion.md・決め切るまで止まらない）を書く', () => {
    expect(agentBlock('ja')).toContain('参入する市場を1つに決め切る')
    expect(agentBlock('ja')).toContain('止まらない')
    expect(agentBlock('en')).toContain('settle on exactly one market to enter')
    expect(agentBlock('en')).toContain('conclusion.md')
  })

  it('upsertBlock: 空・印なし・印あり', () => {
    const b = agentBlock('ja')
    expect(upsertBlock(null, b)).toBe(`${b}\n`)
    expect(upsertBlock('  ', b)).toBe(`${b}\n`)
    expect(upsertBlock('# x\n\n\n', b)).toBe(`# x\n\n${b}\n`)
    expect(upsertBlock(`a\n${BLOCK_START}\nold\n${BLOCK_END}\nb`, b)).toBe(`a\n${b}\nb`)
  })
})

describe('読み込み', () => {
  it('research.yaml が無いフォルダは断る。status は false', async () => {
    await expect(store.load()).rejects.toThrow('まだビジネスリサーチではありません')
    expect(await store.status()).toEqual({ isResearch: false, name: null })
    await init()
    expect(await store.status()).toEqual({ isResearch: true, name: '日本の B2B' })
  })

  it('壊れた YAML・前置きなし・ID 違い・名前の形違い・リンク・巨大なファイルは problems に出し、ほかは読む', async () => {
    await init()
    expect((await store.saveRecord('candidate', candidate('C001'), 'メモ')).ok).toBe(true)
    write('candidates/C002.md', '---\ntitle: [壊れ\n---\n')
    write('candidates/C003.md', '前置きなし\n')
    write('candidates/C004.md', formatRecordFile({ id: 'C999', title: 'x' }, ''))
    write('candidates/note.md', formatRecordFile({ title: 'x' }, ''))
    write('candidates/C005.txt', 'ignored')
    writeFileSync(join(dir, 'outside.md'), formatRecordFile({ title: '外' }, ''))
    symlinkSync(join(dir, 'outside.md'), join(root, 'candidates', 'C006.md'))
    write('candidates/C007.md', `---\ntitle: big\n---\n${'a'.repeat(MAX_RECORD_BYTES + 10)}`)
    const snap = await store.load()
    expect(snap.data.candidates.map((c) => c.id)).toEqual(['C001'])
    const byPath = Object.fromEntries(snap.data.problems.map((p) => [p.path, p.message]))
    expect(byPath['candidates/C002.md']).toMatch(/^YAML を読めません/)
    expect(byPath['candidates/C003.md']).toContain('YAML がありません')
    expect(byPath['candidates/C004.md']).toContain('C999')
    expect(byPath['candidates/note.md']).toContain('C001')
    expect(byPath['candidates/C006.md']).toBe('リンクなので読みません')
    expect(byPath['candidates/C007.md']).toContain('大きすぎる')
    expect(byPath['candidates/C005.txt']).toBeUndefined()
  })

  it('壊れた research.yaml は problems に出して読み、書き込みは断る', async () => {
    await init()
    write('research.yaml', 'name: [x\n')
    const snap = await store.load()
    expect(snap.data.problems[0]?.path).toBe('research.yaml')
    expect(snap.data.research.name).toBe('research')
    const r = store.saveRecord('candidate', candidate(), '')
    await expect(r).rejects.toThrow('research.yaml が壊れている')
    await expect(store.updateResearch({ name: 'x' })).rejects.toThrow('research.yaml が壊れている')
  })

  it('型の違う値は直して読み、直したことを problems に出す（1ファイル5件まで）', async () => {
    await init()
    write('candidates/C001.md', formatRecordFile({ title: 'x', stage: 'winner', scores: { demand: 9, spend: 9, reach: 9, profit: 9, competition: 9, delivery: 9 } }, ''))
    const snap = await store.load()
    const msgs = snap.data.problems.filter((p) => p.path === 'candidates/C001.md').map((p) => p.message)
    expect(msgs).toHaveLength(6)
    expect(msgs[0]).toContain('stage:')
    expect(msgs[5]).toContain('ほかに 2 件')
  })

  it('記録のフォルダがリンクなら読まない', async () => {
    await init()
    rmSync(join(root, 'evidence'), { recursive: true })
    mkdirSync(join(dir, 'ev'))
    writeFileSync(join(dir, 'ev', 'E001.md'), formatRecordFile({ fact: 'x' }, ''))
    symlinkSync(join(dir, 'ev'), join(root, 'evidence'))
    const snap = await store.load()
    expect(snap.data.evidence).toEqual([])
    expect(snap.data.problems.find((p) => p.path === 'evidence/')?.message).toContain('リンク')
  })

  it('読む量の上限を超えたら途中でやめて1回だけ知らせる', async () => {
    await init()
    for (let i = 1; i <= 5; i++) write(`evidence/E00${i}.md`, formatRecordFile({ fact: 'x'.repeat(1000) }, ''))
    const small = make({ loadBudgetBytes: 2500 })
    const snap = await small.load()
    expect(snap.data.evidence.length).toBeLessThan(5)
    expect(snap.data.problems.filter((p) => p.message.includes('一部だけ'))).toHaveLength(1)
  })
})

describe('saveRecord', () => {
  beforeEach(async () => { await init() })

  it('保存して読み直せる（前置き + 本文）', async () => {
    const r = await store.saveRecord('candidate', candidate(), '# メモ\n本文')
    expect(r.ok).toBe(true)
    const f = front('candidates/C001.md')
    expect(f.title).toBe('経理の証憑回収')
    expect(parseRecordFile(read('candidates/C001.md')).body.trim()).toBe('# メモ\n本文')
    if (r.ok) expect(r.snapshot.data.candidates[0]?.title).toBe('経理の証憑回収')
  })

  it('本文が null なら既存の本文を保つ（新しい記録は空）。空文字は空にする', async () => {
    await store.saveRecord('candidate', candidate(), 'Agent のメモ')
    expect((await store.saveRecord('candidate', candidate('C001', (c) => { c.title = '変えた' }), null)).ok).toBe(true)
    expect(parseRecordFile(read('candidates/C001.md')).body.trim()).toBe('Agent のメモ')
    expect(front('candidates/C001.md').title).toBe('変えた')
    expect((await store.saveRecord('candidate', candidate('C002'), null)).ok).toBe(true)
    expect(parseRecordFile(read('candidates/C002.md')).body).toBe('')
    await store.saveRecord('candidate', candidate(), '')
    expect(parseRecordFile(read('candidates/C001.md')).body).toBe('')
  })

  it('error の検査があれば書かない。warning は書いて返す', async () => {
    const bad = await store.saveRecord('candidate', candidate('C001', (c) => { c.how.marginRate = 2 }), '')
    expect(bad).toMatchObject({ ok: false })
    expect(bad.issues.map((i) => i.code)).toEqual(['rateOutOfRange'])
    expect(existsSync(join(root, 'candidates/C001.md'))).toBe(false)
    const warn = await store.saveRecord('candidate', candidate('C001', (c) => { c.scores.demand.score = 3 }), '')
    expect(warn.ok).toBe(true)
    expect(warn.issues.map((i) => `${i.level}:${i.code}`)).toEqual(['warning:scoreUnbacked'])
  })

  it('型と違う値（画面のバグ・乗っ取り）は寄せて warning で知らせる', async () => {
    const r = await store.saveRecord('candidate', { ...candidate(), scores: { ...candidate().scores, reach: { score: 9, evidence: [], reason: '' } } }, '')
    expect(r.ok).toBe(true)
    expect(r.issues.map((i) => `${i.level}:${i.field}:${i.code}`)).toEqual(['warning:scores.reach.score:fixBadScore'])
    expect((front('candidates/C001.md').scores as Record<string, { score: unknown }>).reach.score).toBeNull()
  })

  it('知らない種類・ID の形・本文の型と長さ・記録の大きさを断る', async () => {
    await expect(store.saveRecord('hypothesis', candidate(), '')).rejects.toThrow('記録の種類')
    expect((await store.saveRecord('candidate', { ...candidate(), id: '../C001' }, '')).issues[0]?.code).toBe('idInvalid')
    expect((await store.saveRecord('candidate', { ...candidate(), id: 'E001' }, '')).issues[0]?.code).toBe('idInvalid')
    expect((await store.saveRecord('candidate', null, '')).issues[0]?.code).toBe('idInvalid')
    expect((await store.saveRecord('candidate', candidate(), 5)).issues[0]?.code).toBe('bodyInvalid')
    expect((await store.saveRecord('candidate', candidate(), 'a'.repeat(LIMITS.body + 1))).issues[0]?.code).toBe('bodyTooLong')
    const big = candidate('C001', (c) => { c.who.companies = Array.from({ length: 1000 }, () => ({ company: 'x'.repeat(600), industry: '', employees: null, situation: '', inferredProblem: '', evidenceUrl: '', buyerRole: '', reachPath: '' })) })
    expect((await store.saveRecord('candidate', big, '')).issues[0]?.code).toBe('recordTooLarge')
    expect(readdirSync(join(root, 'candidates'))).toEqual([])
  })

  it('壊れたファイルは上書きしない', async () => {
    write('candidates/C001.md', '---\ntitle: [x\n---\n手で書いた大事なメモ\n')
    const r = await store.saveRecord('candidate', candidate(), '')
    expect(r).toMatchObject({ ok: false, issues: [{ code: 'recordBroken' }] })
    expect(read('candidates/C001.md')).toContain('手で書いた大事なメモ')
  })

  it('人だけが変える欄（段階・除外の理由・ゲート・promotedTo・作った日）は保存で変えない', async () => {
    await store.saveRecord('candidate', candidate(), '')
    await store.decideGate({ candidateId: 'C001', gate: 'G1', status: 'pass', note: '人' })
    const forged = candidate('C001', (c) => {
      c.stage = 'selected'
      c.dropReason = 'x'
      c.gates.G2 = { status: 'pass', note: '', at: '2026-10-18T00:00:00Z' }
      c.gates.G1 = { status: 'fail', note: '', at: '' }
      c.promotedTo = { folder: '/tmp/x', projectId: 'p', at: '' }
      c.createdAt = '1999-01-01T00:00:00Z'
    })
    const r = await store.saveRecord('candidate', forged, '')
    expect(r.ok).toBe(true)
    const c = (await store.load()).data.candidates[0]!
    expect(c.stage).toBe('discovered')
    expect(c.dropReason).toBe('')
    expect(c.gates.G1.status).toBe('pass')
    expect(c.gates.G2.status).toBe('pending')
    expect(c.promotedTo).toBeNull()
    expect(c.createdAt).toBe(NOW.toISOString())
  })

  it('証拠: 知らない候補は error。確認日が未来は error', async () => {
    expect((await store.saveRecord('evidence', evidence(), '')).issues.map((i) => i.code)).toEqual(['unknownCandidate'])
    await store.saveRecord('candidate', candidate(), '')
    expect((await store.saveRecord('evidence', evidence('E001', { checkedAt: '2026-10-19' }), '')).issues.map((i) => i.code)).toEqual(['dateFuture'])
    expect((await store.saveRecord('evidence', evidence(), '')).ok).toBe(true)
  })

  it('同時の保存は1つずつ書き、全部残る', async () => {
    const results = await Promise.all(Array.from({ length: 12 }, (_, i) => store.saveRecord('candidate', candidate(`C${String(i + 1).padStart(3, '0')}`), `本文 ${i}`)))
    expect(results.every((r) => r.ok)).toBe(true)
    const snap = await store.load()
    expect(snap.data.candidates).toHaveLength(12)
    // 同じ ID を同時に保存しても、最後のものが壊れずに残る
    await Promise.all(['a', 'b', 'c'].map((t) => store.saveRecord('candidate', candidate('C001', (c) => { c.title = t }), t)))
    expect(front('candidates/C001.md').title).toBe('c')
  })

  it('失敗した保存のあとも次の保存は進む', async () => {
    await expect(store.saveRecord('nope', {}, '')).rejects.toThrow()
    expect((await store.saveRecord('candidate', candidate(), '')).ok).toBe(true)
  })
})

describe('deleteRecord', () => {
  beforeEach(async () => { await init() })

  it('ゴミ箱へ動かす（戻せる）', async () => {
    await store.saveRecord('candidate', candidate(), 'メモ')
    const snap = await store.deleteRecord('candidate', 'C001')
    expect(snap.data.candidates).toEqual([])
    const trashed = readdirSync(join(root, '.research/trash'))
    expect(trashed).toHaveLength(1)
    expect(trashed[0]).toMatch(/^candidate-C001-2026-10-18T03-00-00-000Z\.md$/)
  })

  it('知らない種類・ID の形・無いもの・リンクは断る', async () => {
    await expect(store.deleteRecord('approval', 'C001')).rejects.toThrow('記録の種類')
    await expect(store.deleteRecord('candidate', '../x')).rejects.toThrow('形が違います')
    await expect(store.deleteRecord('candidate', 'C404')).rejects.toThrow('C404 はありません')
    writeFileSync(join(dir, 'o.md'), 'x')
    symlinkSync(join(dir, 'o.md'), join(root, 'candidates/C002.md'))
    await expect(store.deleteRecord('candidate', 'C002')).rejects.toThrow('普通のファイルではない')
    expect(existsSync(join(dir, 'o.md'))).toBe(true)
  })
})

describe('updateResearch', () => {
  beforeEach(async () => { await init() })

  it('名前・対象範囲・重み・足切り・目安を変える', async () => {
    const weights = { demand: 30, spend: 20, reach: 20, profit: 10, competition: 10, delivery: 10 }
    const snap = await store.updateResearch({ name: ' 新 ', scope: 's', weights, cutoffs: { demand: 3, reach: null }, funnelTargets: { discovered: 500 }, minTargetCount: 50 })
    expect(snap.data.research).toMatchObject({ name: '新', scope: 's', weights, minTargetCount: 50 })
    expect(snap.data.research.cutoffs).toMatchObject({ demand: 3, reach: null, spend: null })
    expect(snap.data.research.funnelTargets.discovered).toBe(500)
    expect(snap.data.research.funnelTargets.evidenced).toBe(100)
  })

  it('不正な値は断り、ファイルを変えない', async () => {
    const before = read('research.yaml')
    const w = { ...DEFAULT_WEIGHTS }
    for (const patch of [
      null, [], 'x',
      { name: '' }, { name: 'a'.repeat(101) }, { scope: 3 },
      { weights: { ...w, demand: 101 } }, { weights: { ...w, demand: -1 } }, { weights: { ...w, demand: Number.NaN } }, { weights: { demand: 10 } },
      { weights: { demand: 0, spend: 0, reach: 0, profit: 0, competition: 0, delivery: 0 } },
      { cutoffs: { demand: 0 } }, { cutoffs: { demand: 6 } }, { cutoffs: { demand: 2.5 } }, { cutoffs: [] },
      { funnelTargets: { discovered: -1 } }, { funnelTargets: { discovered: 1.5 } }, { funnelTargets: { discovered: Infinity } },
      { minTargetCount: 0 }, { minTargetCount: 1.2 }, { minTargetCount: '100' }
    ]) {
      await expect(store.updateResearch(patch), JSON.stringify(patch)).rejects.toThrow(UserFacingError)
    }
    expect(read('research.yaml')).toBe(before)
  })
})

describe('ゲート（人の判断の正本はフォルダの外）', () => {
  beforeEach(async () => {
    await init()
    await store.saveRecord('candidate', candidate(), 'メモ')
  })

  it('順に pass にできる。前が pass でなければ断る。fail・pending はいつでも', async () => {
    await expect(store.decideGate({ candidateId: 'C001', gate: 'G2', status: 'pass', note: '' })).rejects.toThrow('前のゲート')
    let snap = await store.decideGate({ candidateId: 'C001', gate: 'G1', status: 'pass', note: '100社' })
    expect(snap.data.candidates[0]!.gates.G1).toMatchObject({ status: 'pass', note: '100社', at: NOW.toISOString() })
    snap = await store.decideGate({ candidateId: 'C001', gate: 'G2', status: 'pass', note: '' })
    snap = await store.decideGate({ candidateId: 'C001', gate: 'G5', status: 'fail', note: '' })
    expect(snap.data.candidates[0]!.gates.G5.status).toBe('fail')
    snap = await store.decideGate({ candidateId: 'C001', gate: 'G2', status: 'pending', note: '' })
    expect(snap.data.candidates[0]!.gates.G2).toEqual({ status: 'pending', note: '', at: '' })
    expect(snap.data.problems).toEqual([])
    // 本文は残る
    expect(parseRecordFile(read('candidates/C001.md')).body.trim()).toBe('メモ')
  })

  it('ファイルに直接 pass と書いても（Agent など）正本と合わなければ pending として扱い、知らせる', async () => {
    const raw = front('candidates/C001.md')
    write('candidates/C001.md', formatRecordFile({ ...raw, gates: { ...(raw.gates as object), G1: { status: 'pass', note: '', at: '2026-10-18T00:00:00Z' } } }, ''))
    const snap = await store.load()
    expect(snap.data.candidates[0]!.gates.G1.status).toBe('pending')
    expect(snap.data.problems.map((p) => p.message)).toEqual(['G1 の判断が Ferret で人が決めたものと合わないため、pending として扱います'])
    // その状態から G2 を pass にはできない
    await expect(store.decideGate({ candidateId: 'C001', gate: 'G2', status: 'pass', note: '' })).rejects.toThrow('前のゲート')
  })

  it('人が決めたあとにファイルのメモ・日時を書き換えても合わない（pending にする）', async () => {
    await store.decideGate({ candidateId: 'C001', gate: 'G1', status: 'pass', note: '人' })
    const raw = front('candidates/C001.md')
    const gates = raw.gates as Record<string, Record<string, unknown>>
    write('candidates/C001.md', formatRecordFile({ ...raw, gates: { ...gates, G1: { ...gates.G1, note: '書き換え' } } }, ''))
    expect((await store.load()).data.candidates[0]!.gates.G1.status).toBe('pending')
  })

  it('別のフォルダの正本の判断は使えない（台帳はフォルダごと）', async () => {
    await store.decideGate({ candidateId: 'C001', gate: 'G1', status: 'pass', note: '' })
    const other = new ResearchStore({ root, now: () => NOW, ledger: new MemoryApprovalLedger() })
    expect((await other.load()).data.candidates[0]!.gates.G1.status).toBe('pending')
  })

  it('不正な入力を断る', async () => {
    for (const input of [null, { candidateId: 'C001', gate: 'G8', status: 'pass' }, { candidateId: 'C001', gate: 'G1', status: 'ok' }, { candidateId: '../C001', gate: 'G1', status: 'pass' }, { candidateId: 'C404', gate: 'G1', status: 'pass' }, { candidateId: 'C001', gate: 'G1', status: 'pass', note: 'a'.repeat(LIMITS.note + 1) }]) {
      await expect(store.decideGate(input), JSON.stringify(input)?.slice(0, 80)).rejects.toThrow(UserFacingError)
    }
  })
})

describe('setStage', () => {
  beforeEach(async () => {
    await init()
    await store.saveRecord('candidate', candidate(), '')
  })

  it('段階を変える。dropped は理由が要る。selected は「プロジェクトにする」だけ。同じ段階は断る', async () => {
    await expect(store.setStage({ candidateId: 'C001', stage: 'dropped', reason: ' ' })).rejects.toThrow('除外する理由')
    let snap = await store.setStage({ candidateId: 'C001', stage: 'dropped', reason: '到達できない' })
    expect(snap.data.candidates[0]).toMatchObject({ stage: 'dropped', dropReason: '到達できない' })
    snap = await store.setStage({ candidateId: 'C001', stage: 'evidenced', reason: '' })
    expect(snap.data.candidates[0]).toMatchObject({ stage: 'evidenced', dropReason: '' })
    await expect(store.setStage({ candidateId: 'C001', stage: 'evidenced', reason: '' })).rejects.toThrow('既に')
    await expect(store.setStage({ candidateId: 'C001', stage: 'selected', reason: '' })).rejects.toThrow('プロジェクトにする')
    await expect(store.setStage({ candidateId: 'C001', stage: 'winner', reason: '' })).rejects.toThrow('段階が正しくありません')
  })

  it('プロジェクトにした候補の段階は変えない', async () => {
    await store.markPromoted('C001', { folder: '/x', projectId: 'p', at: NOW.toISOString() })
    await expect(store.setStage({ candidateId: 'C001', stage: 'dropped', reason: 'x' })).rejects.toThrow('既にプロジェクト')
  })
})

describe('依頼と送信', () => {
  const sent: Array<{ target: BusinessSendTarget; text: string }> = []
  const ok = { send: async (target: BusinessSendTarget, text: string) => { sent.push({ target, text }); return { ok: true, message: '送りました', label: 'Codex' } } }
  beforeEach(async () => {
    sent.length = 0
    await init()
    await store.saveRecord('candidate', candidate(), '')
  })

  it('prompt: 知らない依頼・候補を断り、全文を返す', async () => {
    await expect(store.prompt({ promptId: 'hack', candidateId: null })).rejects.toThrow('依頼が見つかりません')
    await expect(store.prompt({ promptId: 'who', candidateId: 'C404' })).rejects.toThrow('C404 はありません')
    await expect(store.prompt({ promptId: 'who', candidateId: '../x' })).rejects.toThrow('形が違います')
    const v = await store.prompt({ promptId: 'who', candidateId: 'C001' })
    expect(v).toMatchObject({ id: 'who', candidateId: 'C001' })
    expect(v.text.length).toBeGreaterThan(50)
    expect((await store.prompt({ promptId: 'discover', candidateId: '' })).candidateId).toBeNull()
  })

  it('send: 守ることを main が付け、送れたときだけ .research/sent/ に残す', async () => {
    const r = await store.send({ promptId: 'who', candidateId: 'C001', text: '本文', target: { kind: 'active' } }, ok)
    expect(r).toEqual({ ok: true, message: '送りました' })
    expect(sent[0]!.text).toContain('本文')
    expect(sent[0]!.text).toContain('守ること')
    const files = readdirSync(join(root, '.research/sent'))
    expect(files).toEqual(['2026-10-18T03-00-00-000Z-who.md'])
    expect(parseRecordFile(read(`.research/sent/${files[0]}`)).data).toMatchObject({ promptId: 'who', candidateId: 'C001', target: 'Codex' })
    // 同じ時刻にもう1回送っても上書きしない
    await store.send({ promptId: 'who', candidateId: 'C001', text: '本文2', target: { kind: 'active' } }, ok)
    expect(readdirSync(join(root, '.research/sent')).sort()).toEqual(['2026-10-18T03-00-00-000Z-who-2.md', '2026-10-18T03-00-00-000Z-who.md'])
    // 末尾に既に守ることがあれば二重に付けない
    const withRules = sent[0]!.text
    await store.send({ promptId: 'who', candidateId: 'C001', text: withRules, target: { kind: 'active' } }, ok)
    expect(sent[2]!.text).toBe(withRules)
  })

  it('send: 前の版の案内のままの CLAUDE.md・AGENTS.md も、送る前にいまの案内（参入先を決め切るゴール）へ書き直す', async () => {
    write('AGENTS.md', `# 自分のメモ\n\n${BLOCK_START}\n古い案内\n${BLOCK_END}\n`)
    await store.send({ promptId: 'decide', candidateId: null, text: '本文', target: { kind: 'active' } }, ok)
    const agents = read('AGENTS.md')
    expect(agents).toContain('# 自分のメモ')
    expect(agents).not.toContain('古い案内')
    expect(agents).toContain('参入する市場を1つに決め切る')
    expect(agents).toContain('conclusion.md')
    expect(read('.research/context.md')).toContain('ゴール: 参入する市場を1つに決め切る')
    // 決め切った条件は README にもある（AGENTS.md だけを読んだ Agent も辿れる）
    expect(read('.research/README.md')).toContain('## 参入先を決め切った条件（conclusion.md）')
    expect(read('.research/README.md')).toContain('「A か B」にしない')
  })

  it('送れなければ ok:false で履歴を残さない（例外も送れなかったとして返す）', async () => {
    const no = await store.send({ promptId: 'who', candidateId: null, text: 'x', target: { kind: 'active' } }, { send: async () => ({ ok: false, message: 'いません', label: '' }) })
    expect(no).toEqual({ ok: false, message: 'いません' })
    const boom = await store.send({ promptId: 'who', candidateId: null, text: 'x', target: { kind: 'active' } }, { send: async () => { throw new Error('secret path /Users/x') } })
    expect(boom).toEqual({ ok: false, message: '送れませんでした。もう一度送ってください。' })
    expect(readdirSync(join(root, '.research/sent'))).toEqual([])
  })

  it('不正な依頼・空・長すぎ・送り先を断る', async () => {
    for (const req of [null, { promptId: 'x', text: 'a', target: { kind: 'active' } }, { promptId: 'who', text: ' ', target: { kind: 'active' } }, { promptId: 'who', text: 'a'.repeat(LIMITS.sendText + 1), target: { kind: 'active' } }, { promptId: 'who', text: 'a', target: { kind: 'terminal', id: '' } }, { promptId: 'who', text: 'a', target: { kind: 'new', agent: 'gpt' } }]) {
      await expect(store.send(req, ok)).rejects.toThrow(UserFacingError)
    }
    expect(sent).toEqual([])
  })
})

describe('文の言語', () => {
  it('fsx の日本語の文は画面の言語の文にする（英語）', () => {
    setLocale('en')
    try {
      const e = localizeError(new UserFacingError('フォルダの中にリンクがあるため、読み書きしません。リンクを普通のフォルダ・ファイルに置き換えてください。')) as Error
      expect(e.message).toContain('contains a link')
      const other = new Error('x')
      expect(localizeError(other)).toBe(other)
    } finally {
      setLocale('ja')
    }
  })

  it('英語の画面では断る文も英語', async () => {
    setLocale('en')
    try {
      await expect(store.load()).rejects.toThrow('not a business research yet')
    } finally {
      setLocale('ja')
    }
  })

  it('README・案内は locale の言語で書く', async () => {
    locale = 'en'
    await make().init({ name: 'x', scope: '' })
    expect(read('CLAUDE.md')).toContain('Ferret business research')
  })
})
