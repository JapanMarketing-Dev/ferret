import { describe, expect, it } from 'vitest'
import {
  daysBetween,
  isErrorResponse,
  isValidDate,
  isValidExperimentId,
  isValidSlug,
  LIMITS,
  MAX_BULLETS,
  validatePageContent,
  validatePutPageRequest,
  validateStatsRange,
} from '../src/contract'
import { sampleContent, samplePage } from './helpers'

describe('isValidSlug', () => {
  it.each(['abc', 'my-page', 'x01-lp', '0123456789', 'a'.repeat(48), '---'])('accepts %s', (slug) => {
    expect(isValidSlug(slug)).toBe(true)
  })
  it.each([
    '',
    'ab',
    'a'.repeat(49),
    'My-Page',
    'my_page',
    'my page',
    'my.page',
    'ページ',
    '../etc',
    'abc/def',
    'abc%2f',
    'abc\n',
    ' abc',
  ])('rejects %j', (slug) => {
    expect(isValidSlug(slug)).toBe(false)
  })
  it('rejects non-strings', () => {
    expect(isValidSlug(123)).toBe(false)
    expect(isValidSlug(null)).toBe(false)
    expect(isValidSlug(undefined)).toBe(false)
  })
})

describe('isValidExperimentId', () => {
  it.each(['X01', 'X99', 'X100', 'X9999'])('accepts %s', (id) => expect(isValidExperimentId(id)).toBe(true))
  it.each(['X1', 'X10000', 'x01', 'H01', 'X01 ', 'XAB', '', 'X-01'])('rejects %j', (id) =>
    expect(isValidExperimentId(id)).toBe(false),
  )
})

describe('validatePageContent', () => {
  it('accepts a full valid content', () => {
    const r = validatePageContent(sampleContent())
    expect(r.ok).toBe(true)
  })
  it('accepts empty optional fields and zero bullets', () => {
    const r = validatePageContent(
      sampleContent({ subhead: '', priceText: '', formIntro: '', footerNote: '', bullets: [] }),
    )
    expect(r.ok).toBe(true)
  })
  it.each(['headline', 'ctaLabel', 'consentText'] as const)('requires non-blank %s', (key) => {
    const r = validatePageContent(sampleContent({ [key]: '   ' }))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.issues.map((i) => i.path)).toContain(`content.${key}`)
  })
  it.each(Object.keys(LIMITS).filter((k) => k !== 'title' && k !== 'bullet') as (keyof typeof LIMITS)[])(
    'enforces max length of %s (boundary)',
    (key) => {
      const max = LIMITS[key]
      expect(validatePageContent(sampleContent({ [key]: 'あ'.repeat(max) })).ok).toBe(true)
      expect(validatePageContent(sampleContent({ [key]: 'あ'.repeat(max + 1) })).ok).toBe(false)
    },
  )
  it('counts astral characters as one', () => {
    expect(validatePageContent(sampleContent({ ctaLabel: '😀'.repeat(LIMITS.ctaLabel) })).ok).toBe(true)
  })
  it('enforces bullet count boundary (8 ok, 9 rejected)', () => {
    const eight = Array.from({ length: MAX_BULLETS }, (_, i) => `項目${i}`)
    expect(validatePageContent(sampleContent({ bullets: eight })).ok).toBe(true)
    expect(validatePageContent(sampleContent({ bullets: [...eight, '9'] })).ok).toBe(false)
  })
  it('enforces bullet length boundary', () => {
    expect(validatePageContent(sampleContent({ bullets: ['a'.repeat(LIMITS.bullet)] })).ok).toBe(true)
    expect(validatePageContent(sampleContent({ bullets: ['a'.repeat(LIMITS.bullet + 1)] })).ok).toBe(false)
  })
  it('rejects empty bullet and non-string bullet', () => {
    expect(validatePageContent(sampleContent({ bullets: [''] })).ok).toBe(false)
    expect(validatePageContent({ ...sampleContent(), bullets: [1] }).ok).toBe(false)
    expect(validatePageContent({ ...sampleContent(), bullets: 'a' }).ok).toBe(false)
  })
  it('rejects unknown keys', () => {
    const r = validatePageContent({ ...sampleContent(), html: '<b>x</b>' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.issues[0]?.path).toBe('content.html')
  })
  it('rejects __proto__ / constructor keys parsed from JSON', () => {
    const parsed = JSON.parse(`{"__proto__":{"x":1},${JSON.stringify(sampleContent()).slice(1)}`)
    expect(validatePageContent(parsed).ok).toBe(false)
    expect(validatePageContent({ ...sampleContent(), constructor: 'x' }).ok).toBe(false)
  })
  it('rejects missing keys', () => {
    const { footerNote: _f, ...rest } = sampleContent()
    const r = validatePageContent(rest)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.issues.map((i) => i.path)).toContain('content.footerNote')
  })
  it('rejects non-string values', () => {
    expect(validatePageContent({ ...sampleContent(), headline: 1 }).ok).toBe(false)
    expect(validatePageContent({ ...sampleContent(), subhead: null }).ok).toBe(false)
    expect(validatePageContent({ ...sampleContent(), priceText: { a: 1 } }).ok).toBe(false)
  })
  it('rejects non-objects', () => {
    for (const v of [null, [], 'x', 1, true]) expect(validatePageContent(v).ok).toBe(false)
  })
  it('rejects control characters and bidi overrides', () => {
    expect(validatePageContent(sampleContent({ headline: 'a\u0000b' })).ok).toBe(false)
    expect(validatePageContent(sampleContent({ subhead: 'a\u0007b' })).ok).toBe(false)
    expect(validatePageContent(sampleContent({ subhead: 'a\rb' })).ok).toBe(false)
    expect(validatePageContent(sampleContent({ subhead: 'a‮b' })).ok).toBe(false)
    expect(validatePageContent(sampleContent({ footerNote: 'a⁦b' })).ok).toBe(false)
  })
  it('allows newlines only in multi-line fields', () => {
    expect(validatePageContent(sampleContent({ subhead: '1行目\n2行目' })).ok).toBe(true)
    expect(validatePageContent(sampleContent({ consentText: '1\n2' })).ok).toBe(true)
    expect(validatePageContent(sampleContent({ headline: '1\n2' })).ok).toBe(false)
    expect(validatePageContent(sampleContent({ ctaLabel: '1\n2' })).ok).toBe(false)
    expect(validatePageContent(sampleContent({ bullets: ['1\n2'] })).ok).toBe(false)
  })
  it('accepts HTML-looking text (it is escaped on render, not rejected)', () => {
    expect(validatePageContent(sampleContent({ headline: '<b>太字</b>' })).ok).toBe(true)
  })
})

describe('validatePutPageRequest', () => {
  it('accepts a valid request', () => {
    const r = validatePutPageRequest(samplePage())
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value.status).toBe('published')
  })
  it('accepts draft', () => {
    expect(validatePutPageRequest(samplePage({ status: 'draft' })).ok).toBe(true)
  })
  it.each(['archived', 'PUBLISHED', '', null, 1])('rejects status %j', (status) => {
    expect(validatePutPageRequest({ ...samplePage(), status }).ok).toBe(false)
  })
  it('rejects unknown top-level keys', () => {
    const r = validatePutPageRequest({ ...samplePage(), slug: 'x' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.issues.some((i) => i.path === 'slug')).toBe(true)
  })
  it('rejects bad experimentId', () => {
    expect(validatePutPageRequest({ ...samplePage(), experimentId: 'H01' }).ok).toBe(false)
    expect(validatePutPageRequest({ ...samplePage(), experimentId: undefined }).ok).toBe(false)
  })
  it('enforces title boundary', () => {
    expect(validatePutPageRequest(samplePage({ title: 't'.repeat(LIMITS.title) })).ok).toBe(true)
    expect(validatePutPageRequest(samplePage({ title: 't'.repeat(LIMITS.title + 1) })).ok).toBe(false)
    expect(validatePutPageRequest(samplePage({ title: '' })).ok).toBe(false)
  })
  it('collects nested content issues', () => {
    const r = validatePutPageRequest({ ...samplePage(), content: { ...sampleContent(), extra: 1 } })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.issues.map((i) => i.path)).toContain('content.extra')
  })
  it('rejects arrays and primitives', () => {
    for (const v of [null, [], 'x', 0]) expect(validatePutPageRequest(v).ok).toBe(false)
  })
  it('rejects class instances', () => {
    class Fake {
      experimentId = 'X01'
    }
    expect(validatePutPageRequest(new Fake()).ok).toBe(false)
  })
})

describe('dates', () => {
  it.each(['2026-01-01', '2024-02-29', '2026-12-31'])('valid %s', (d) => expect(isValidDate(d)).toBe(true))
  it.each([
    '2026-02-29',
    '2026-13-01',
    '2026-00-10',
    '2026-04-31',
    '2026-1-1',
    '20260101',
    '2026-01-01T00:00:00Z',
    '1999-12-31',
    '2101-01-01',
    '',
  ])('invalid %j', (d) => expect(isValidDate(d)).toBe(false))
  it('daysBetween', () => {
    expect(daysBetween('2026-01-01', '2026-01-01')).toBe(0)
    expect(daysBetween('2026-01-01', '2027-01-01')).toBe(365)
    expect(daysBetween('2026-03-01', '2026-02-28')).toBe(-1)
  })
})

describe('validateStatsRange', () => {
  it('accepts same day', () => {
    expect(validateStatsRange('2026-10-01', '2026-10-01').ok).toBe(true)
  })
  it('accepts exactly 366 days inclusive and rejects 367', () => {
    expect(validateStatsRange('2026-01-01', '2027-01-01').ok).toBe(true) // 366 days
    expect(validateStatsRange('2026-01-01', '2027-01-02').ok).toBe(false) // 367 days
  })
  it('rejects reversed range', () => {
    expect(validateStatsRange('2026-10-02', '2026-10-01').ok).toBe(false)
  })
  it('rejects missing / malformed', () => {
    expect(validateStatsRange(null, '2026-10-01').ok).toBe(false)
    expect(validateStatsRange('2026-10-01', null).ok).toBe(false)
    expect(validateStatsRange('2026/10/01', '2026-10-01').ok).toBe(false)
  })
})

describe('isErrorResponse', () => {
  it('detects error shape', () => {
    expect(isErrorResponse({ error: { code: 'not_found', message: 'x' } })).toBe(true)
    expect(isErrorResponse({ error: 'x' })).toBe(false)
    expect(isErrorResponse(null)).toBe(false)
  })
})
