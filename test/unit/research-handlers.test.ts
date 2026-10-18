import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setLocale } from '@shared/i18n'
import { parseRecordFile, parseYaml } from '@shared/business/format'
import { emptyCandidate, emptyEvidence, emptyExperiment } from '@shared/research/records'
import { EXECUTION_QUESTIONS } from '@shared/business/records'
import type { Candidate, ResearchEvidence } from '@shared/research/model'
import type { PromoteResult, ResearchSnapshot } from '@shared/research/ipc'
import type { ConfirmRequest } from '../../src/main/business/store'
import { MAX_FOLDER_NAME, checkFolderName, folderNameFrom, researchHandlers, type ResearchDeps } from '../../src/main/research/handlers'
import { SEND_TICKET_MS } from '../../src/main/business/sendPass'

const NOW = new Date('2026-10-18T03:00:00.000Z')
const sha = (s: string) => createHash('sha256').update(s).digest('hex')

let dir: string
let root: string
let current: string | null
let clock: number
let consent: boolean
let confirmAnswer: boolean
let confirms: ConfirmRequest[]
let picked: Array<string | null>
let pickCalls: Array<{ title: string; defaultPath?: string; create?: boolean }>
let registeredResearch: string[]
let registeredBusiness: Array<{ folder: string; name: string; orchestraId: string | null }>
let sent: string[]
let h: ReturnType<typeof researchHandlers>

function makeHandlers(over: Partial<ResearchDeps> = {}) {
  return researchHandlers({
    root: () => current,
    now: () => new Date(clock),
    locale: () => 'ja',
    sender: { send: async (_t, text) => { sent.push(text); return { ok: true, message: '送りました', label: 'Codex' } } },
    consentSend: () => consent,
    confirm: async (r) => { confirms.push(r); return confirmAnswer },
    pickFolder: async (o) => { pickCalls.push(o); return picked.length ? picked.shift()! : null },
    registerResearch: (folder) => { registeredResearch.push(folder); current = folder; return { projectId: 'research-1' } },
    registerBusiness: (folder, name, orchestraId) => { registeredBusiness.push({ folder, name, orchestraId }); return { projectId: 'biz-1' } },
    manual: '# バーニングニーズ調査マニュアル\n',
    knowledge: '# 集客の5原則\n',
    ...over
  })
}

const call = <T = unknown>(channel: keyof typeof h, ...args: unknown[]): Promise<T> =>
  Promise.resolve().then(() => (h[channel] as (...a: unknown[]) => unknown)(...args)) as Promise<T>

beforeAll(() => setLocale('ja'))

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'research-handlers-')))
  root = join(dir, 'research')
  mkdirSync(root)
  current = root
  clock = NOW.getTime()
  consent = true
  confirmAnswer = true
  confirms = []
  picked = []
  pickCalls = []
  registeredResearch = []
  registeredBusiness = []
  sent = []
  h = makeHandlers()
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('フォルダ', () => {
  it('フォルダが無ければ status は空、ほかは断る。登録のキーがそろっている', async () => {
    current = null
    expect(await call('research:status')).toEqual({ root: null, isResearch: false, name: null })
    await expect(call('research:load')).rejects.toThrow('プロジェクトのフォルダを開いてください。')
    await expect(call('research:init', { name: 'x', scope: '' })).rejects.toThrow('プロジェクトのフォルダを開いてください。')
    current = root
    expect(await call('research:status')).toEqual({ root, isResearch: false, name: null })
    await call('research:init', { name: '日本の B2B', scope: '' })
    expect(await call('research:status')).toEqual({ root, isResearch: true, name: '日本の B2B' })
    expect(Object.keys(h).sort()).toEqual([
      'research:addProject', 'research:armSend', 'research:decideGate', 'research:deleteRecord', 'research:init', 'research:load', 'research:prompt',
      'research:promote', 'research:saveRecord', 'research:send', 'research:setStage', 'research:status', 'research:updateResearch'
    ].sort())
  })

  it('開いているフォルダが変われば、そのフォルダを読む（別フォルダの記録を混ぜない）', async () => {
    await call('research:init', { name: 'A', scope: '' })
    const other = join(dir, 'other')
    mkdirSync(other)
    current = other
    await call('research:init', { name: 'B', scope: '' })
    expect((await call<ResearchSnapshot>('research:load')).data.research.name).toBe('B')
    current = root
    expect((await call<ResearchSnapshot>('research:load')).data.research.name).toBe('A')
  })
})

describe('research:addProject', () => {
  it('選ばなければ null（何も登録しない）', async () => {
    expect(await call('research:addProject')).toBeNull()
    expect(registeredResearch).toEqual([])
    expect(pickCalls[0]).toMatchObject({ title: 'ビジネスリサーチのフォルダを選ぶ', create: true })
  })

  it('選んだフォルダを登録し、research.yaml が無ければフォルダ名でひな型を書く', async () => {
    const folder = join(dir, '新しいリサーチ')
    mkdirSync(folder)
    picked = [folder]
    expect(await call('research:addProject')).toEqual({ projectId: 'research-1' })
    expect(registeredResearch).toEqual([folder])
    expect((parseYaml(readFileSync(join(folder, 'research.yaml'), 'utf8')) as Record<string, unknown>).name).toBe('新しいリサーチ')
    expect(existsSync(join(folder, '.research/README.md'))).toBe(true)
  })

  it('research.yaml が既にあれば書き換えない', async () => {
    await call('research:init', { name: '前からある', scope: 's' })
    const before = readFileSync(join(root, 'research.yaml'), 'utf8')
    picked = [root]
    await call('research:addProject')
    expect(readFileSync(join(root, 'research.yaml'), 'utf8')).toBe(before)
  })

  it('リンク・ファイル・相対のパス・無いフォルダは登録しない', async () => {
    const real = join(dir, 'real')
    mkdirSync(real)
    symlinkSync(real, join(dir, 'link'))
    writeFileSync(join(dir, 'file'), 'x')
    for (const p of [join(dir, 'link'), join(dir, 'file'), 'relative/path', join(dir, 'missing')]) {
      picked = [p]
      await expect(call('research:addProject'), p).rejects.toThrow('普通のフォルダ')
    }
    expect(registeredResearch).toEqual([])
  })
})

describe('送る許可の札', () => {
  const req = { promptId: 'who', candidateId: null, text: '本文', target: { kind: 'active' as const } }
  const arm = (over: Record<string, unknown> = {}) => call<{ ticket: string }>('research:armSend', { promptId: req.promptId, textHash: sha(req.text), target: req.target, ...over })
  const send = (r: Record<string, unknown>) => call<{ ok: boolean }>('research:send', r)

  beforeEach(async () => {
    await call('research:init', { name: 'R', scope: '' })
  })

  it('札なし・操作なし・偽の札は断る。札は1回きり', async () => {
    await expect(send(req)).rejects.toThrow('送るボタンを押してから')
    consent = false
    await expect(arm()).rejects.toThrow('送るボタンを押してから')
    await expect(send({ ...req, ticket: 'forged' })).rejects.toThrow('送るボタンを押してから')
    consent = true
    const { ticket } = await arm()
    consent = false
    expect(await send({ ...req, ticket })).toMatchObject({ ok: true })
    await expect(send({ ...req, ticket })).rejects.toThrow('送るボタンを押してから')
    expect(sent).toHaveLength(1)
  })

  it('札は本文・依頼・送り先に結び付く（違えば使えず、札も消える）', async () => {
    for (const change of [{ text: '別の本文' }, { promptId: 'what' }, { target: { kind: 'terminal', id: 't9' } }]) {
      const { ticket } = await arm()
      await expect(send({ ...req, ...change, ticket })).rejects.toThrow('送るボタンを押してから')
      await expect(send({ ...req, ticket })).rejects.toThrow('送るボタンを押してから')
    }
    expect(sent).toEqual([])
  })

  it('新しい Agent の札は、起動したターミナルへの送信に使える', async () => {
    const { ticket } = await arm({ target: { kind: 'new', agent: 'claude' } })
    expect(await send({ ...req, target: { kind: 'terminal', id: 't1' }, ticket })).toMatchObject({ ok: true })
  })

  it('60 秒を過ぎた札は使えない（境界: ちょうど 60 秒はまだ使える）', async () => {
    const t1 = (await arm()).ticket
    clock += SEND_TICKET_MS
    expect(await send({ ...req, ticket: t1 })).toMatchObject({ ok: true })
    const t2 = (await arm()).ticket
    clock += SEND_TICKET_MS + 1
    await expect(send({ ...req, ticket: t2 })).rejects.toThrow('送るボタンを押してから')
  })

  it('札を作ったフォルダと違うフォルダでは使えない', async () => {
    const { ticket } = await arm()
    const other = join(dir, 'other')
    mkdirSync(other)
    current = other
    await call('research:init', { name: 'O', scope: '' })
    await expect(send({ ...req, ticket })).rejects.toThrow('送るボタンを押してから')
    expect(sent).toEqual([])
  })

  it('知らない依頼・本文のハッシュの形・送り先・フォルダなしは札を作らない', async () => {
    await expect(arm({ promptId: 'S1-candidates' })).rejects.toThrow('依頼が見つかりません')
    await expect(arm({ textHash: 'zz' })).rejects.toThrow('本文')
    await expect(arm({ textHash: sha('x').toUpperCase() })).rejects.toThrow('本文')
    await expect(arm({ target: { kind: 'terminal', id: 'x'.repeat(201) } })).rejects.toThrow('送り先')
    await expect(call('research:armSend', null)).rejects.toThrow('依頼が見つかりません')
    current = null
    await expect(arm()).rejects.toThrow('プロジェクトのフォルダ')
  })
})

describe('フォルダの名前', () => {
  it('1つの名前だけを通す（区切り・..・制御文字・使えない文字・. で始まる・長さ）', () => {
    expect(checkFolderName('  経理の証憑回収 ')).toBe('経理の証憑回収')
    expect(checkFolderName('a'.repeat(MAX_FOLDER_NAME))).toHaveLength(MAX_FOLDER_NAME)
    for (const bad of ['', '  ', 'a/b', 'a\\b', '..', '../x', 'a..b', '.hidden', 'a\u0000b', 'a\nb', 'a\u007fb', 'C:x', 'a*b', 'a?b', 'a"b', 'a<b', 'a|b', 'a'.repeat(MAX_FOLDER_NAME + 1), 3, null, {}]) {
      expect(() => checkFolderName(bad), JSON.stringify(bad)).toThrow('フォルダの名前')
    }
  })

  it('題名から作る名前は、使えない文字を - にし、空なら ID', () => {
    expect(folderNameFrom('経理/証憑:回収', 'C001')).toBe('経理-証憑-回収')
    expect(folderNameFrom('../../etc', 'C001')).toBe('etc')
    expect(folderNameFrom('  \n\t ', 'C001')).toBe('C001')
    expect(folderNameFrom('a'.repeat(200), 'C001')).toHaveLength(80)
    for (const t of ['a/b', '..', '.x', 'x\u0001y', '//']) expect(() => checkFolderName(folderNameFrom(t, 'C001'))).not.toThrow()
  })
})

describe('research:promote', () => {
  let parent: string

  async function setupCandidate(over: (c: Candidate) => void = () => undefined): Promise<void> {
    await call('research:init', { name: 'R', scope: '日本の B2B' })
    const c = emptyCandidate('C001', NOW.toISOString())
    c.title = '経理の証憑回収'
    c.customer = '従業員20〜100人の会社の経理担当'
    c.problem = '月末に証憑が集まらない'
    c.existingServices = [{ name: '既存サービスA', url: 'https://a.example', price: '月額3万円' }]
    c.why.reason = '既存の会計ソフトと併用でき、導入作業が要らない'
    c.why.reasonEvidence = ['E001']
    c.scores.demand = { score: 4, evidence: ['E001'], reason: '契約がある' }
    // 購買が起きる場面・調査の終了条件（canPromote が見る）
    c.scene = { company: '従業員20〜100人の会社', who: '経理担当', event: '月末の締め', outcome: '証憑を期限内に集め終える', currentHandling: 'メールで催促' }
    c.who.segment.attribute = '従業員20〜100人'
    c.deliverable = 'その会社の証憑の回収状況の一覧'
    c.monetization.freeToPaidPath = '無料の回収状況の一覧 → 月額の催促代行'
    c.how.monthlyPrice = 30000
    c.where.channels = [{ channel: 'outreach', state: 'notLooking', axes: { reachability: null, intent: null, cost: null, repeatability: null, scalability: null }, note: '公式の問い合わせ窓口' }]
    c.execution.supply = { plan: '協力会社2社で月50社まで', confirmed: true }
    over(c)
    // 証拠を指す前に、候補を先に作る（証拠は候補を指す）
    expect((await call<{ ok: boolean }>('research:saveRecord', 'candidate', { ...c, why: { ...c.why, reasonEvidence: [] }, scores: emptyCandidate('C001', NOW.toISOString()).scores }, '# メモ')).ok).toBe(true)
    const e: ResearchEvidence = { ...emptyEvidence('E001', NOW.toISOString()), candidate: 'C001', principle: 'why', grade: 'reviewComplaint', kind: 'complaint', url: 'https://review.example/1', quote: '会計ソフトと連携できず手作業', fact: '連携の不満がある', inference: '併用できるものを選ぶ' }
    expect((await call<{ ok: boolean }>('research:saveRecord', 'evidence', e, '')).ok).toBe(true)
    expect((await call<{ ok: boolean }>('research:saveRecord', 'candidate', c, '# メモ')).ok).toBe(true)
    const x = { ...emptyExperiment('X001'), candidate: 'C001', method: 'outreach', channel: 'outreach', hypothesis: '経理担当は月3万円で申し込むか', passCondition: '30社中3社が商談', stopCondition: '30社で0件' }
    expect((await call<{ ok: boolean }>('research:saveRecord', 'experiment', x, '')).ok).toBe(true)
  }
  async function passDesk(): Promise<void> {
    for (const gate of ['G1', 'G2', 'G3']) await call('research:decideGate', { candidateId: 'C001', gate, status: 'pass', note: '人' })
  }
  const promote = (over: Record<string, unknown> = {}) => call<PromoteResult | null>('research:promote', { candidateId: 'C001', orchestraId: 'orch-1', folderName: '', ...over })

  beforeEach(() => {
    parent = join(dir, 'businesses')
    mkdirSync(parent)
  })

  it('成功: 新しいフォルダに business.yaml（S6・H01）・H01・E・ALT・X・RESEARCH.md を書き、登録し、候補を selected にする', async () => {
    await setupCandidate()
    await passDesk()
    picked = [parent]
    const result = await promote({ folderName: '経理 証憑回収' })
    const target = join(parent, '経理 証憑回収')
    expect(result).toMatchObject({ projectId: 'biz-1', folder: target })
    // 確認 → 親フォルダのダイアログ（既定はリサーチの親）
    expect(confirms).toHaveLength(1)
    expect(confirms[0]!.message).toContain('C001')
    expect(confirms[0]!.detail).toContain('経理 証憑回収')
    expect(pickCalls[0]).toMatchObject({ defaultPath: dir, create: true })
    // business.yaml
    const biz = parseYaml(readFileSync(join(target, 'business.yaml'), 'utf8')) as Record<string, unknown>
    expect(biz).toMatchObject({ step: 'S6', currentHypothesis: 'H01' })
    // 実行条件の4点: 候補で書いたもの（供給）はそのまま、未入力の項目は既定の問い
    const execution = biz.execution as Record<string, { plan: string; confirmed: boolean }>
    expect(Object.keys(execution)).toEqual(['firstDeal', 'supply', 'firstExperiment', 'profitOps'])
    expect(execution.supply).toEqual({ plan: '協力会社2社で月50社まで', confirmed: true })
    expect(execution.firstDeal).toEqual({ plan: EXECUTION_QUESTIONS.firstDeal.ja, confirmed: false })
    // 記録
    const h01 = parseRecordFile(readFileSync(join(target, 'hypotheses/H01.md'), 'utf8')).data as Record<string, unknown>
    expect(h01).toMatchObject({ id: 'H01', stage: 'ネット上の有望仮説', verdict: '進める' })
    expect((h01.stageHistory as Array<{ note: string }>)[0]?.note).toContain('C001')
    expect(readdirSync(join(target, 'evidence')).filter((f) => /^E\d+\.md$/.test(f)).length).toBeGreaterThanOrEqual(1)
    expect(readdirSync(join(target, 'alternatives')).filter((f) => /^ALT\d+\.md$/.test(f)).length).toBeGreaterThanOrEqual(1)
    expect(readdirSync(join(target, 'experiments')).filter((f) => /^X\d+\.md$/.test(f)).length).toBeGreaterThanOrEqual(1)
    expect(readFileSync(join(target, 'RESEARCH.md'), 'utf8')).toContain('C001')
    expect(existsSync(join(target, 'principles/手法.md'))).toBe(true)
    // 登録（オーケストラの指定をそのまま渡す。開かない）
    expect(registeredBusiness).toEqual([{ folder: target, name: expect.any(String), orchestraId: 'orch-1' }])
    expect(current).toBe(root)
    // 候補
    const c = result!.snapshot.data.candidates[0]!
    expect(c.stage).toBe('selected')
    expect(c.promotedTo).toEqual({ folder: target, projectId: 'biz-1', at: NOW.toISOString() })
  })

  it('名前が空なら題名から作る。オーケストラが空なら null で渡す', async () => {
    await setupCandidate()
    await passDesk()
    picked = [parent]
    const r = await promote({ folderName: '', orchestraId: '' })
    expect(r?.folder).toBe(join(parent, '経理の証憑回収'))
    expect(registeredBusiness[0]?.orchestraId).toBeNull()
  })

  it('ゲート未通過なら断る（確認も出さない）', async () => {
    await setupCandidate()
    await call('research:decideGate', { candidateId: 'C001', gate: 'G1', status: 'pass', note: '' })
    picked = [parent]
    await expect(promote()).rejects.toThrow('足りないもの: G2, G3')
    expect(confirms).toEqual([])
    expect(readdirSync(parent)).toEqual([])
  })

  it('ファイルに pass と書いただけのゲート（人が決めていない）は通さない', async () => {
    await setupCandidate()
    const file = join(root, 'candidates/C001.md')
    const parsed = parseRecordFile(readFileSync(file, 'utf8'))
    const raw = parsed.data as Record<string, unknown>
    const pass = { status: 'pass', note: '', at: '2026-10-18T00:00:00Z' }
    const { formatRecordFile } = await import('@shared/business/format')
    writeFileSync(file, formatRecordFile({ ...raw, gates: { ...(raw.gates as object), G1: pass, G2: pass, G3: pass } }, parsed.body))
    picked = [parent]
    await expect(promote()).rejects.toThrow('G1, G2, G3')
    expect(registeredBusiness).toEqual([])
  })

  it('購買が起きる場面が埋まっていなければ断る', async () => {
    await setupCandidate((c) => { c.scene.event = '' })
    await passDesk()
    picked = [parent]
    await expect(promote()).rejects.toThrow('scene')
    expect(confirms).toEqual([])
  })

  it('調査の終了条件が残っていれば断る（見せる成果物が無い）', async () => {
    await setupCandidate((c) => { c.deliverable = '' })
    await passDesk()
    picked = [parent]
    await expect(promote()).rejects.toThrow('exit')
    expect(registeredBusiness).toEqual([])
  })

  it('選ばれる理由の裏付けが無ければ断る', async () => {
    await setupCandidate((c) => { c.why.reasonEvidence = [] })
    await passDesk()
    await expect(promote()).rejects.toThrow('whyReason')
  })

  it('確認で中止・親フォルダを選ばなければ、何も作らない', async () => {
    await setupCandidate()
    await passDesk()
    confirmAnswer = false
    picked = [parent]
    await expect(promote()).rejects.toThrow('やめました')
    expect(pickCalls).toEqual([])
    confirmAnswer = true
    picked = []
    expect(await promote()).toBeNull()
    expect(readdirSync(parent)).toEqual([])
    expect(registeredBusiness).toEqual([])
    expect((await call<ResearchSnapshot>('research:load')).data.candidates[0]!.stage).toBe('discovered')
  })

  it('既にあって空でないフォルダ・ファイル・リンクは断る。空のフォルダ（.DS_Store だけも）は使う', async () => {
    await setupCandidate()
    await passDesk()
    mkdirSync(join(parent, 'busy'))
    writeFileSync(join(parent, 'busy', 'keep.txt'), '大事')
    picked = [parent]
    await expect(promote({ folderName: 'busy' })).rejects.toThrow('空ではありません')
    expect(readdirSync(join(parent, 'busy'))).toEqual(['keep.txt'])
    writeFileSync(join(parent, 'file'), 'x')
    picked = [parent]
    await expect(promote({ folderName: 'file' })).rejects.toThrow('普通のフォルダでないもの')
    mkdirSync(join(dir, 'elsewhere'))
    symlinkSync(join(dir, 'elsewhere'), join(parent, 'link'))
    picked = [parent]
    await expect(promote({ folderName: 'link' })).rejects.toThrow('普通のフォルダでないもの')
    expect(readdirSync(join(dir, 'elsewhere'))).toEqual([])
    mkdirSync(join(parent, 'empty'))
    writeFileSync(join(parent, 'empty', '.DS_Store'), '')
    picked = [parent]
    expect((await promote({ folderName: 'empty' }))?.folder).toBe(join(parent, 'empty'))
  })

  it('不正な名前は確認を出す前に断る', async () => {
    await setupCandidate()
    await passDesk()
    for (const folderName of ['../escape', 'a/b', '..', '.git', 'x\u0000', 'a'.repeat(101), 42]) {
      picked = [parent]
      await expect(promote({ folderName }), String(folderName)).rejects.toThrow('フォルダの名前')
    }
    expect(confirms).toEqual([])
    expect(readdirSync(parent)).toEqual([])
    expect(existsSync(join(dir, 'escape'))).toBe(false)
  })

  it('リサーチのフォルダの中（とリサーチを含む場所）には作らない', async () => {
    await setupCandidate()
    await passDesk()
    picked = [root]
    await expect(promote({ folderName: 'inside' })).rejects.toThrow('リサーチのフォルダの中')
    expect(existsSync(join(root, 'inside'))).toBe(false)
  })

  it('親がリンク・相対のパスなら断る', async () => {
    await setupCandidate()
    await passDesk()
    symlinkSync(parent, join(dir, 'parent-link'))
    picked = [join(dir, 'parent-link')]
    await expect(promote({ folderName: 'x' })).rejects.toThrow('普通のフォルダ')
    picked = ['relative']
    await expect(promote({ folderName: 'x' })).rejects.toThrow('普通のフォルダ')
    expect(readdirSync(parent)).toEqual([])
  })

  it('既にプロジェクトにした候補・除外した候補・知らない候補・ID の形は断る', async () => {
    await setupCandidate()
    await passDesk()
    picked = [parent]
    await promote({ folderName: 'first' })
    picked = [parent]
    await expect(promote({ folderName: 'second' })).rejects.toThrow('alreadyPromoted')
    expect(existsSync(join(parent, 'second'))).toBe(false)
    expect(registeredBusiness).toHaveLength(1)
    await expect(promote({ candidateId: 'C404' })).rejects.toThrow('C404 はありません')
    await expect(promote({ candidateId: '../C001' })).rejects.toThrow('形が違います')
    await expect(call('research:promote', null)).rejects.toThrow('正しくありません')
    await expect(promote({ orchestraId: 5 })).rejects.toThrow('オーケストラ')
  })

  it('除外した候補は断る', async () => {
    await setupCandidate()
    await passDesk()
    await call('research:setStage', { candidateId: 'C001', stage: 'dropped', reason: '到達できない' })
    await expect(promote()).rejects.toThrow('dropped')
  })

  it('二重に押しても1回だけ進める', async () => {
    await setupCandidate()
    await passDesk()
    picked = [parent, parent]
    const results = await Promise.allSettled([promote({ folderName: 'one' }), promote({ folderName: 'two' })])
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    expect(String((results.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason)).toContain('途中')
    expect(registeredBusiness).toHaveLength(1)
  })

  it('確認とダイアログの間に除外されたら、作る前に断る', async () => {
    h = makeHandlers({
      pickFolder: async () => {
        await h['research:setStage']({ candidateId: 'C001', stage: 'dropped', reason: 'やめた' })
        return parent
      }
    })
    await setupCandidate()
    await passDesk()
    await expect(promote({ folderName: 'late' })).rejects.toThrow('dropped')
    expect(existsSync(join(parent, 'late'))).toBe(false)
  })
})
