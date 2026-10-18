import { describe, expect, it } from 'vitest'
import { escapeHtml, notFoundPage, posthogScript, renderPage, scriptJson, thanksPage } from '../src/html'
import { resolvePosthog } from '../src/posthog'
import { sampleContent } from './helpers'

const PAYLOADS = [
  '<script>alert(1)</script>',
  '"><img src=x onerror=alert(1)>',
  "'><svg/onload=alert(1)>",
  '</style><script>alert(1)</script>',
  '</title><script>alert(1)</script>',
  // biome-ignore lint/suspicious/noTemplateCurlyInString: XSS の試行文字列そのもの
  '`${alert(1)}`',
  '<!--',
  '&lt;script&gt;',
  '<a href="javascript:alert(1)">x</a>',
  '<iframe srcdoc="<script>alert(1)</script>">',
]

describe('escapeHtml', () => {
  it('escapes all significant characters', () => {
    expect(escapeHtml(`<>&"'\``)).toBe('&lt;&gt;&amp;&quot;&#39;&#96;')
  })
  it('double-escapes existing entities', () => {
    expect(escapeHtml('&lt;')).toBe('&amp;lt;')
  })
  it('leaves Japanese text as is', () => {
    expect(escapeHtml('日本語のテキスト')).toBe('日本語のテキスト')
  })
})

describe('scriptJson', () => {
  it('cannot break out of a script element', () => {
    const s = scriptJson({ a: '</script><script>alert(1)</script>', b: '  ', c: '&' })
    expect(s).not.toContain('<')
    expect(s).not.toContain('>')
    expect(s).not.toContain('&')
    expect(s).not.toContain(' ')
    expect(s).not.toContain(' ')
    expect(JSON.parse(s)).toEqual({ a: '</script><script>alert(1)</script>', b: '  ', c: '&' })
  })
})

function render(overrides = {}, title = 'タイトル') {
  return renderPage({ slug: 'test-page', title, content: sampleContent(overrides), nonce: 'NONCE', posthog: null })
}

function countTags(html: string, tag: string): number {
  return html.split(`<${tag}`).length - 1
}

describe('renderPage XSS', () => {
  const fields = ['headline', 'subhead', 'priceText', 'ctaLabel', 'formIntro', 'consentText', 'footerNote'] as const
  for (const field of fields) {
    it.each(PAYLOADS)(`escapes ${field}: %s`, (payload) => {
      const html = render({ [field]: payload })
      expect(html).not.toContain(payload)
      expect(countTags(html, 'script')).toBe(1)
      expect(countTags(html, 'img')).toBe(0)
      expect(countTags(html, 'svg')).toBe(0)
      expect(countTags(html, 'iframe')).toBe(0)
      expect(html).toContain(escapeHtml(payload))
    })
  }
  it.each(PAYLOADS)('escapes bullets: %s', (payload) => {
    const html = render({ bullets: [payload, payload] })
    expect(countTags(html, 'script')).toBe(1)
    expect(html.split(escapeHtml(payload)).length - 1).toBe(2)
  })
  it.each(PAYLOADS)('escapes title: %s', (payload) => {
    const html = render({}, payload)
    expect(countTags(html, 'script')).toBe(1)
    expect(html).toContain(`<title>${escapeHtml(payload)}</title>`)
  })
  it('escapes meta description attribute', () => {
    const html = render({ subhead: '" onload="alert(1)' })
    expect(html).toContain('content="&quot; onload=&quot;alert(1)"')
  })
})

describe('renderPage structure', () => {
  const html = render()
  it('is Japanese, has viewport, title and description', () => {
    expect(html.startsWith('<!doctype html><html lang="ja">')).toBe(true)
    expect(html).toContain('<meta name="viewport" content="width=device-width,initial-scale=1">')
    expect(html).toContain('<meta name="description"')
  })
  it('uses nonce on inline style and script', () => {
    expect(html).toContain('<style nonce="NONCE">')
    expect(html).toContain('<script nonce="NONCE">')
    expect(html).not.toMatch(/<(script|style)(?![^>]*nonce="NONCE")[^>]*>/)
  })
  it('has no inline event handlers or style attributes', () => {
    expect(html).not.toMatch(/\son[a-z]+=/i)
    expect(html).not.toMatch(/\sstyle=/i)
  })
  it('labels every visible input', () => {
    for (const id of ['name', 'company', 'email', 'message', 'consent', 'website']) {
      expect(html).toContain(`<label for="${id}"`)
      expect(html).toContain(`id="${id}"`)
    }
  })
  it('posts the form to the same-origin interest endpoint', () => {
    expect(html).toContain('<form method="post" action="/p/test-page/interest">')
  })
  it('has the honeypot hidden from assistive tech and tab order', () => {
    expect(html).toMatch(/<div class="hp" aria-hidden="true">.*tabindex="-1"/)
  })
  it('requires email and consent', () => {
    expect(html).toMatch(/id="email"[^>]*required|required[^>]*id="email"/)
    expect(html).toMatch(/name="consent" type="checkbox" value="yes" required/)
  })
  it('has exactly one h1', () => {
    expect(countTags(html, 'h1')).toBe(1)
  })
  it('omits empty optional blocks', () => {
    const h = render({ bullets: [], priceText: '', footerNote: '', subhead: '', formIntro: '' })
    expect(h).not.toContain('<ul>')
    expect(h).not.toContain('<footer>')
    expect(h).not.toContain('class="price"')
  })
  it('stays under 15KB with typical content', () => {
    expect(new TextEncoder().encode(html).byteLength).toBeLessThan(15 * 1024)
  })
  it('stays under 15KB with long realistic content', () => {
    const big = render({
      headline: 'あ'.repeat(60),
      subhead: 'い'.repeat(200),
      bullets: Array.from({ length: 8 }, () => 'う'.repeat(80)),
      formIntro: 'え'.repeat(200),
      consentText: 'お'.repeat(300),
      footerNote: 'か'.repeat(200),
    })
    expect(new TextEncoder().encode(big).byteLength).toBeLessThan(15 * 1024)
  })
  it('never references third-party hosts without PostHog', () => {
    expect(html).not.toMatch(/https?:\/\//)
  })
})

describe('posthogScript', () => {
  const ph = resolvePosthog({ POSTHOG_KEY: 'phc_fake', POSTHOG_HOST: 'https://us.i.posthog.com' })
  it('resolves cloud host with assets host', () => {
    expect(ph?.origins).toEqual(['https://us.i.posthog.com', 'https://us-assets.i.posthog.com'])
  })
  it('configures privacy options', () => {
    if (!ph) throw new Error('posthog config missing')
    const s = posthogScript(ph, 'N')
    expect(s).toContain('"person_profiles":"identified_only"')
    expect(s).toContain('"maskAllInputs":true')
    expect(s).toContain('"css_selector_allowlist":["#cta"]')
    expect(s).toContain('https://us-assets.i.posthog.com/static/array.js')
    expect(s.startsWith('<script nonce="N">')).toBe(true)
  })
  it('is included in the page only when configured', () => {
    if (!ph) throw new Error('posthog config missing')
    const on = renderPage({ slug: 'abc', title: 't', content: sampleContent(), nonce: 'N', posthog: ph })
    expect(countTags(on, 'script')).toBe(2)
    expect(on).toContain('posthog')
    expect(render()).not.toContain('posthog')
  })
})

describe('other pages', () => {
  it('404 page has no script', () => {
    const h = notFoundPage('N')
    expect(h).not.toContain('<script')
    expect(h).toContain('lang="ja"')
  })
  it('thanks page escapes and truncates name', () => {
    const h = thanksPage('N', 'abc', `<b>${'長'.repeat(100)}`)
    expect(h).toContain('&lt;b&gt;')
    expect(h).not.toContain('<b>')
    expect(h).not.toContain('長'.repeat(40))
  })
  it('thanks page without name has no greeting', () => {
    expect(thanksPage('N', 'abc', '   ')).not.toContain('様')
  })
})
