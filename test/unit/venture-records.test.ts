/**
 * ビジネスのフォルダの JSON の読み取り: venture.json・guardrails.json・approvals・external・streams、書き出し、次の id、規定の形の例
 */
import { describe, expect, it } from 'vitest'
import {
  CANONICAL_EXAMPLE, RECORD_MAX_ITEMS, RECORD_TEXT_LIMITS, STREAM_FILE_KEYS, nextRecordId, parseApprovals, parseExternalLog, parseGuardrails,
  parseStreamFile, parseVentureConfig, toJsonText
} from '../../src/shared/venture/records'
import { parseImportFile } from '../../src/shared/venture/import'
import { DEFAULT_LTV_MONTHS } from '../../src/shared/venture/model'

const j = (v: unknown): string => JSON.stringify(v)

describe('parseVentureConfig', () => {
  const ok = {
    version: 1,
    name: '翻訳サービス',
    createdAt: '2026-10-01T00:00:00.000Z',
    currency: 'JPY',
    members: [
      { role: 'business', folder: '/Users/me/biz', projectId: 'p1' },
      { role: 'dev', folder: '/Users/me/app' }
    ],
    economics: { marginRate: 0.6, ltvMonths: [6, 12], monthlyRevenuePerCustomer: null },
    funnelTargets: { clicks: 0.02, contracts: 0.1 }
  }
  it('正しい形はそのまま', () => {
    expect(parseVentureConfig(j(ok))).toEqual({ value: ok, issues: [] })
  })
  it('ファイルが無ければ null・issue なし', () => {
    expect(parseVentureConfig(null)).toEqual({ value: null, issues: [] })
  })
  it('壊れた JSON は null と badJson', () => {
    expect(parseVentureConfig('{')).toEqual({ value: null, issues: ['badJson'] })
  })
  it('オブジェクトでなければ badShape', () => {
    expect(parseVentureConfig('[]')).toEqual({ value: null, issues: ['badShape'] })
    expect(parseVentureConfig('"x"')).toEqual({ value: null, issues: ['badShape'] })
    expect(parseVentureConfig('null')).toEqual({ value: null, issues: ['badShape'] })
  })
  it('version が違えば null', () => {
    expect(parseVentureConfig(j({ ...ok, version: 2 }))).toEqual({ value: null, issues: ['version'] })
  })
  it('version が無ければ 1 とみなす', () => {
    const { version: _v, ...rest } = ok
    void _v
    expect(parseVentureConfig(j(rest)).value?.version).toBe(1)
  })
  it('BOM 付きでも読む', () => {
    expect(parseVentureConfig(`﻿${j(ok)}`).value?.name).toBe('翻訳サービス')
  })
  it('最小の形は既定で埋める', () => {
    expect(parseVentureConfig(j({ name: 'x' }))).toEqual({
      value: { version: 1, name: 'x', createdAt: '', currency: 'JPY', members: [], economics: { marginRate: null, ltvMonths: [...DEFAULT_LTV_MONTHS], monthlyRevenuePerCustomer: null } },
      issues: []
    })
  })
  it('名前が無ければ空の名前と issue', () => {
    const r = parseVentureConfig(j({}))
    expect(r.value?.name).toBe('')
    expect(r.issues).toEqual(['name'])
  })
  it('名前は上限で切り、前後の空白を外す', () => {
    expect(parseVentureConfig(j({ name: `  ${'n'.repeat(500)}` })).value?.name).toHaveLength(RECORD_TEXT_LIMITS.name)
  })
  it('通貨は大文字に、違う形なら JPY と issue', () => {
    expect(parseVentureConfig(j({ name: 'x', currency: 'usd' })).value?.currency).toBe('USD')
    const r = parseVentureConfig(j({ name: 'x', currency: 'yen!' }))
    expect(r.value?.currency).toBe('JPY')
    expect(r.issues).toEqual(['currency'])
  })
  it('メンバーの違う役割・フォルダの無い要素は捨てる', () => {
    const r = parseVentureConfig(j({ name: 'x', members: [{ role: 'boss', folder: '/a' }, { role: 'dev' }, { role: 'dev', folder: '' }, 'x', { role: 'video', folder: '/v' }] }))
    expect(r.value?.members).toEqual([{ role: 'video', folder: '/v' }])
    expect(r.issues).toEqual(['members[0]: role', 'members[1]: folder', 'members[2]: folder', 'members[3]: badShape'])
  })
  it('同じ役割・フォルダのメンバーは後を捨てる', () => {
    const r = parseVentureConfig(j({ name: 'x', members: [{ role: 'dev', folder: '/a' }, { role: 'dev', folder: '/a', projectId: 'p' }, { role: 'publish', folder: '/a' }] }))
    expect(r.value?.members).toHaveLength(2)
    expect(r.issues).toEqual(['members[1]: duplicate'])
  })
  it('projectId が文字列でなければ欄だけ捨てる', () => {
    const r = parseVentureConfig(j({ name: 'x', members: [{ role: 'dev', folder: '/a', projectId: 3 }] }))
    expect(r.value?.members).toEqual([{ role: 'dev', folder: '/a' }])
    expect(r.issues).toEqual(['members[0]: projectId'])
  })
  it('members が配列でなければ空と issue', () => {
    expect(parseVentureConfig(j({ name: 'x', members: {} })).issues).toEqual(['members'])
  })
  it('限界利益率は 0〜1', () => {
    expect(parseVentureConfig(j({ name: 'x', economics: { marginRate: 0 } })).value?.economics.marginRate).toBe(0)
    expect(parseVentureConfig(j({ name: 'x', economics: { marginRate: 1 } })).value?.economics.marginRate).toBe(1)
    const r = parseVentureConfig(j({ name: 'x', economics: { marginRate: 1.2 } }))
    expect(r.value?.economics.marginRate).toBeNull()
    expect(r.issues).toEqual(['economics.marginRate'])
    expect(parseVentureConfig(j({ name: 'x', economics: { marginRate: '0.5' } })).issues).toEqual(['economics.marginRate'])
  })
  it('継続月数は正の整数だけ（重複は1つ）。全部だめなら既定', () => {
    expect(parseVentureConfig(j({ name: 'x', economics: { ltvMonths: [12, 12, 24] } })).value?.economics.ltvMonths).toEqual([12, 24])
    const r = parseVentureConfig(j({ name: 'x', economics: { ltvMonths: [0, -1, 1.5, 'x'] } }))
    expect(r.value?.economics.ltvMonths).toEqual([...DEFAULT_LTV_MONTHS])
    expect(r.issues).toEqual(['economics.ltvMonths'])
  })
  it('顧客1件あたりの月の売上は 0 以上', () => {
    expect(parseVentureConfig(j({ name: 'x', economics: { monthlyRevenuePerCustomer: 5000 } })).value?.economics.monthlyRevenuePerCustomer).toBe(5000)
    expect(parseVentureConfig(j({ name: 'x', economics: { monthlyRevenuePerCustomer: -1 } })).issues).toEqual(['economics.monthlyRevenuePerCustomer'])
  })
  it('economics がオブジェクトでなければ既定と issue', () => {
    const r = parseVentureConfig(j({ name: 'x', economics: 3 }))
    expect(r.value?.economics.marginRate).toBeNull()
    expect(r.issues).toEqual(['economics'])
  })
  it('ファネルの目安は知っている段階の 0〜1 だけ', () => {
    const r = parseVentureConfig(j({ name: 'x', funnelTargets: { clicks: 0.5, bogus: 0.1, leads: 2, meetings: '0.1' } }))
    expect(r.value?.funnelTargets).toEqual({ clicks: 0.5 })
    expect(r.issues).toEqual(['funnelTargets.bogus', 'funnelTargets.leads', 'funnelTargets.meetings'])
  })
  it('ファネルの目安が1つも残らなければ欄ごと無し', () => {
    expect(parseVentureConfig(j({ name: 'x', funnelTargets: {} })).value).not.toHaveProperty('funnelTargets')
  })
})

describe('parseGuardrails', () => {
  const empty = { version: 1, budgets: [], checks: [] }
  it('ファイルが無ければ空・issue なし', () => {
    expect(parseGuardrails(null)).toEqual({ value: empty, issues: [] })
  })
  it('壊れた JSON は空と badJson', () => {
    expect(parseGuardrails('nope')).toEqual({ value: empty, issues: ['badJson'] })
  })
  it('正しい形', () => {
    const v = {
      version: 1,
      budgets: [
        { channel: '*', daily: null, monthly: 100000 },
        { channel: 'google-ads', daily: 3000, monthly: 60000 }
      ],
      checks: [{ id: 'C01', category: 'privacy', text: '顧客の名前を出さない' }]
    }
    expect(parseGuardrails(j(v))).toEqual({ value: v, issues: [] })
  })
  it('daily・monthly が無ければ null', () => {
    expect(parseGuardrails(j({ budgets: [{ channel: 'x' }] })).value.budgets).toEqual([{ channel: 'x', daily: null, monthly: null }])
  })
  it('違う経路・形は捨てる。負の上限は欄だけ null', () => {
    const r = parseGuardrails(j({ budgets: [{ channel: 'myspace', daily: 1 }, 3, { channel: 'x', daily: -1, monthly: 'a' }] }))
    expect(r.value.budgets).toEqual([{ channel: 'x', daily: null, monthly: null }])
    expect(r.issues).toEqual(['budgets[0]: channel', 'budgets[1]: badShape', 'budgets[2]: daily', 'budgets[2]: monthly'])
  })
  it('同じ経路の上限は後を捨てる', () => {
    const r = parseGuardrails(j({ budgets: [{ channel: 'x', daily: 1 }, { channel: 'x', daily: 2 }] }))
    expect(r.value.budgets).toEqual([{ channel: 'x', daily: 1, monthly: null }])
    expect(r.issues).toEqual(['budgets[1]: duplicate channel x'])
  })
  it('チェック項目: 違う分類・空の文・id の重複', () => {
    const r = parseGuardrails(
      j({
        checks: [
          { id: 'C01', category: 'quality', text: 'a' },
          { id: 'C02', category: 'law', text: 'b' },
          { id: 'C03', category: 'brand', text: '' },
          { id: ' C01 ', category: 'terms', text: 'dup' }
        ]
      })
    )
    expect(r.value.checks).toEqual([{ id: 'C01', category: 'quality', text: 'a' }])
    expect(r.issues).toEqual(['checks[1]: category', 'checks[2]: text', 'checks[3]: duplicate id C01'])
  })
  it('budgets・checks が配列でなければ空と issue', () => {
    expect(parseGuardrails(j({ budgets: {}, checks: 'x' })).issues).toEqual(['budgets: badShape', 'checks: badShape'])
  })
  it('version が違えば空', () => {
    expect(parseGuardrails(j({ version: 3, budgets: [{ channel: 'x' }] }))).toEqual({ value: empty, issues: ['version'] })
  })
})

describe('parseApprovals', () => {
  const req = { id: 'A001', kind: 'post', title: 'X に投稿', detail: '本文', refs: ['P001'], createdAt: '2026-10-01T00:00:00Z', by: 'agent' }
  it('{ requests: [...] } を読む', () => {
    expect(parseApprovals(j({ requests: [req] }))).toEqual({ value: [req], issues: [] })
  })
  it('ファイルの status・decidedAt・answer は読まない・返さない', () => {
    const r = parseApprovals(j({ requests: [{ ...req, status: 'approved', decidedAt: 'x', answer: 'ok' }] }))
    expect(r.value[0]).not.toHaveProperty('status')
    expect(r.value[0]).not.toHaveProperty('decidedAt')
    expect(r.value[0]).not.toHaveProperty('answer')
    expect(r.issues).toEqual([])
  })
  it('知らない欄は返さない', () => {
    expect(parseApprovals(j({ requests: [{ ...req, extra: 1 }] })).value[0]).not.toHaveProperty('extra')
  })
  it('ファイルが無ければ空', () => {
    expect(parseApprovals(null)).toEqual({ value: [], issues: [] })
  })
  it('requests が無ければ空・issue なし', () => {
    expect(parseApprovals('{}')).toEqual({ value: [], issues: [] })
  })
  it('形が違えば空と issue', () => {
    expect(parseApprovals('[1]')).toEqual({ value: [], issues: ['badShape'] })
    expect(parseApprovals(j({ requests: {} }))).toEqual({ value: [], issues: ['requests: badShape'] })
    expect(parseApprovals('{"requests": [')).toEqual({ value: [], issues: ['badJson'] })
  })
  it('違う種類（コードで固定）は要素ごと捨てる', () => {
    const r = parseApprovals(j({ requests: [{ ...req, kind: 'deleteEverything' }] }))
    expect(r.value).toEqual([])
    expect(r.issues).toEqual(['requests[0]: kind'])
  })
  it('id・題が無ければ捨てる', () => {
    const r = parseApprovals(j({ requests: [{ ...req, id: '' }, { ...req, id: 'A002', title: '   ' }, { ...req, id: 7 }] }))
    expect(r.value).toEqual([])
    expect(r.issues).toEqual(['requests[0]: id', 'requests[1]: title', 'requests[2]: id'])
  })
  it('id の重複は後を捨てる', () => {
    const r = parseApprovals(j({ requests: [req, { ...req, title: '別' }] }))
    expect(r.value).toHaveLength(1)
    expect(r.value[0].title).toBe('X に投稿')
    expect(r.issues).toEqual(['requests[1]: duplicate id A001'])
  })
  it('detail・refs・createdAt は無ければ既定', () => {
    expect(parseApprovals(j({ requests: [{ id: 'A1', kind: 'billing', title: 't' }] })).value).toEqual([{ id: 'A1', kind: 'billing', title: 't', detail: '', refs: [], createdAt: '' }])
  })
  it('refs の文字列でない値は捨てる（重複も1つ）', () => {
    const r = parseApprovals(j({ requests: [{ ...req, refs: ['T1', 2, 'T1', '', null] }] }))
    expect(r.value[0].refs).toEqual(['T1'])
    expect(r.issues).toEqual(['requests[0]: refs'])
  })
  it('by の違う値は欄だけ捨てる', () => {
    const r = parseApprovals(j({ requests: [{ ...req, by: 'robot' }] }))
    expect(r.value[0]).not.toHaveProperty('by')
    expect(r.issues).toEqual(['requests[0]: by'])
  })
  it('detail は上限で切る', () => {
    const r = parseApprovals(j({ requests: [{ ...req, detail: 'd'.repeat(RECORD_TEXT_LIMITS.detail + 5) }] }))
    expect(r.value[0].detail).toHaveLength(RECORD_TEXT_LIMITS.detail)
  })
  it('id の前後の空白は外す', () => {
    expect(parseApprovals(j({ requests: [{ ...req, id: ' A009 ' }] })).value[0].id).toBe('A009')
  })
  it('要素の数の上限', () => {
    const requests = Array.from({ length: RECORD_MAX_ITEMS + 2 }, (_, i) => ({ ...req, id: `A${i}` }))
    const r = parseApprovals(j({ requests }))
    expect(r.value).toHaveLength(RECORD_MAX_ITEMS)
    expect(r.issues).toEqual(['requests: tooMany'])
  })
})

describe('parseExternalLog', () => {
  const a = { at: '2026-10-01T10:00:00Z', kind: 'post', approvalId: 'A001', summary: 'X に投稿', result: 'ok', url: 'https://x.com/1', via: 'ferret' }
  it('{ actions: [...] } を読む', () => {
    expect(parseExternalLog(j({ actions: [a] }))).toEqual({ value: [a], issues: [] })
  })
  it('承認の id が無くても読む（画面で「承認なし」）', () => {
    const { approvalId: _x, ...rest } = a
    void _x
    expect(parseExternalLog(j({ actions: [rest] })).value[0]).not.toHaveProperty('approvalId')
  })
  it('id が無いので同じ内容も重複にしない', () => {
    expect(parseExternalLog(j({ actions: [a, a] })).value).toHaveLength(2)
  })
  it('at・kind・summary が無い・違えば捨てる', () => {
    const r = parseExternalLog(j({ actions: [{ ...a, at: 1 }, { ...a, kind: 'x' }, { ...a, summary: '' }] }))
    expect(r.value).toEqual([])
    expect(r.issues).toEqual(['actions[0]: at', 'actions[1]: kind', 'actions[2]: summary'])
  })
  it('via の違う値は欄だけ捨てる', () => {
    expect(parseExternalLog(j({ actions: [{ ...a, via: 'robot' }] })).value[0]).not.toHaveProperty('via')
  })
  it('ファイルが無ければ空', () => {
    expect(parseExternalLog(null)).toEqual({ value: [], issues: [] })
  })
})

describe('parseStreamFile', () => {
  it('STREAM_FILE_KEYS の形', () => {
    expect(STREAM_FILE_KEYS).toEqual({ ads: 'campaigns', content: 'items', images: 'items', support: 'tickets', satisfaction: 'responses', checks: 'results' })
  })
  it('ファイルが無ければ空', () => {
    for (const kind of Object.keys(STREAM_FILE_KEYS) as Array<keyof typeof STREAM_FILE_KEYS>) expect(parseStreamFile(kind, null)).toEqual({ value: [], issues: [] })
  })
  it('壊れた JSON は空と badJson', () => {
    expect(parseStreamFile('ads', '{x')).toEqual({ value: [], issues: ['badJson'] })
  })
  it('違う鍵の配列は読まない（ads は campaigns）', () => {
    expect(parseStreamFile('ads', j({ items: [{ id: 'AD01' }] })).value).toEqual([])
  })

  it('ads', () => {
    const c = { id: 'AD01', channel: 'google-ads', name: '指名', status: 'running', dailyBudget: 3000, landingUrl: 'https://a', approvalId: 'A001', note: 'n' }
    expect(parseStreamFile('ads', j({ campaigns: [c] }))).toEqual({ value: [c], issues: [] })
    const r = parseStreamFile('ads', j({ campaigns: [{ ...c, id: 'AD02', status: 'live' }, { ...c, id: 'AD03', channel: 'myspace' }, { ...c, id: 'AD04', dailyBudget: -1 }] }))
    expect(r.value.map((x) => x.id)).toEqual(['AD04'])
    expect(r.value[0]).not.toHaveProperty('dailyBudget')
    expect(r.issues).toEqual(['campaigns[0]: status', 'campaigns[1]: channel', 'campaigns[2]: dailyBudget'])
  })

  it('content', () => {
    const p = { id: 'P001', channel: 'blog', title: '記事', status: 'draft', due: '2026-10-10', file: 'streams/content/drafts/P001.md' }
    expect(parseStreamFile('content', j({ items: [p] })).value).toEqual([p])
    expect(parseStreamFile('content', j({ items: [{ ...p, channel: 'myspace' }] })).issues).toEqual(['items[0]: channel'])
    expect(parseStreamFile('content', j({ items: [{ ...p, status: 'published' }] })).value).toEqual([])
  })

  it('images', () => {
    const i = { id: 'IMG01', purpose: 'OG 画像', prompt: '青い背景', status: 'requested' }
    expect(parseStreamFile('images', j({ items: [i] })).value).toEqual([i])
    expect(parseStreamFile('images', j({ items: [{ id: 'IMG02', status: 'generated' }] })).value).toEqual([{ id: 'IMG02', purpose: '', prompt: '', status: 'generated' }])
  })

  it('support', () => {
    const t = { id: 'T001', receivedAt: '2026-10-01', channel: 'email', customer: '顧客A', subject: '料金', summary: '年払いは？', kind: 'inquiry', status: 'open' }
    expect(parseStreamFile('support', j({ tickets: [t] })).value).toEqual([t])
    const r = parseStreamFile('support', j({ tickets: [{ ...t, id: 'T002', kind: 'spam' }, { ...t, id: 'T003', status: 'done' }, t, t] }))
    expect(r.value).toHaveLength(1)
    expect(r.issues).toEqual(['tickets[0]: kind', 'tickets[1]: status', 'tickets[3]: duplicate id T001'])
  })
  it('support の欠けた文字列は空で埋める', () => {
    expect(parseStreamFile('support', j({ tickets: [{ id: 'T9', kind: 'other', status: 'closed' }] })).value).toEqual([
      { id: 'T9', receivedAt: '', channel: '', customer: '', subject: '', summary: '', kind: 'other', status: 'closed' }
    ])
  })

  it('satisfaction の点数の幅', () => {
    const r = parseStreamFile(
      'satisfaction',
      j({
        responses: [
          { id: 'R1', date: '2026-10-01', method: 'nps', score: 10, tags: ['価格', '価格', 'UI'] },
          { id: 'R2', date: '2026-10-01', method: 'nps', score: 11 },
          { id: 'R3', date: '2026-10-01', method: 'nps', score: 7.5 },
          { id: 'R4', date: '2026-10-01', method: 'csat', score: 0 },
          { id: 'R5', date: '2026-10-01', method: 'csat', score: 4.5 },
          { id: 'R6', date: '2026-10-01', method: 'interview', comment: '高い' },
          { id: 'R7', method: 'nps', score: 1 },
          { id: 'R8', date: '2026-10-01', method: 'poll' }
        ]
      })
    )
    expect(r.value.map((x) => [x.id, x.score])).toEqual([
      ['R1', 10],
      ['R2', undefined],
      ['R3', undefined],
      ['R4', undefined],
      ['R5', 4.5],
      ['R6', undefined]
    ])
    expect(r.value[0].tags).toEqual(['価格', 'UI'])
    expect(r.value[1]).not.toHaveProperty('score')
    expect(r.issues).toEqual(['responses[1]: score', 'responses[2]: score', 'responses[3]: score', 'responses[6]: date', 'responses[7]: method'])
  })

  it('checks', () => {
    const c = { id: 'CK001', target: 'streams/content/drafts/P001.md', checkId: 'C01', result: 'fail', note: '個人名', checkedAt: '2026-10-01' }
    expect(parseStreamFile('checks', j({ results: [c] })).value).toEqual([c])
    expect(parseStreamFile('checks', j({ results: [{ ...c, result: 'ok' }] })).issues).toEqual(['results[0]: result'])
    expect(parseStreamFile('checks', j({ results: [{ ...c, checkId: '' }] })).issues).toEqual(['results[0]: checkId'])
  })

  it('要素がオブジェクトでなければ捨てる', () => {
    const r = parseStreamFile('images', j({ items: [null, 1, 'x', []] }))
    expect(r.value).toEqual([])
    expect(r.issues).toEqual(['items[0]: badShape', 'items[1]: badShape', 'items[2]: badShape', 'items[3]: badShape'])
  })

  it('文字列でない任意の欄は欄だけ捨てる', () => {
    const r = parseStreamFile('ads', j({ campaigns: [{ id: 'AD1', channel: 'x', name: 'n', status: 'planned', note: 5 }] }))
    expect(r.value[0]).not.toHaveProperty('note')
    expect(r.issues).toEqual(['campaigns[0]: note'])
  })
})

describe('toJsonText', () => {
  it('2スペース・末尾改行', () => {
    expect(toJsonText({ a: [1] })).toBe('{\n  "a": [\n    1\n  ]\n}\n')
  })
  it('読み直すと同じ', () => {
    const v = { version: 1, budgets: [{ channel: '*', daily: null, monthly: 1 }], checks: [] }
    expect(parseGuardrails(toJsonText(v)).value).toEqual(v)
  })
})

describe('nextRecordId', () => {
  it('最大の次', () => {
    expect(nextRecordId('A', ['A001', 'A003', 'A002'], 3)).toBe('A004')
  })
  it('無ければ 1', () => {
    expect(nextRecordId('A', [], 3)).toBe('A001')
    expect(nextRecordId('T', ['X001', 'TA1'], 3)).toBe('T001')
  })
  it('桁を超えたら増やす', () => {
    expect(nextRecordId('A', ['A999'], 3)).toBe('A1000')
  })
  it('幅より長い id も数として比べる', () => {
    expect(nextRecordId('AD', ['AD9', 'AD10'], 2)).toBe('AD11')
  })
  it('接頭辞の正規表現の文字をそのまま扱う', () => {
    expect(nextRecordId('A.', ['AB01', 'A.02'], 2)).toBe('A.03')
  })
  it('接頭辞の後ろに数以外があれば数えない', () => {
    expect(nextRecordId('P', ['P001x', 'P002'], 3)).toBe('P003')
  })
  it('幅 0 は0埋めなし', () => {
    expect(nextRecordId('C', ['C7'], 0)).toBe('C8')
  })
})

describe('CANONICAL_EXAMPLE', () => {
  it('取り込みでそのまま読める', () => {
    const r = parseImportFile({ path: 'data/agent/example.json', source: 'canonical', bytes: new TextEncoder().encode(toJsonText(CANONICAL_EXAMPLE)), currency: 'JPY' })
    expect(r.issues).toEqual([])
    expect(r.rows).toHaveLength(CANONICAL_EXAMPLE.rows.length)
  })
  it('version 1', () => {
    expect(CANONICAL_EXAMPLE.version).toBe(1)
  })
})
