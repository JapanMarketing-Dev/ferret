import { describe, expect, it } from 'vitest'
import { escapeHtml, parseInline, parseMarkdown, plainExcerpt, safeHref, toHtml, toPortableText, type Block } from '../../src/main/publish/markdown'

/** ブログの記事の Markdown を HTML・Portable Text にする（src/main/publish/markdown.ts） */

describe('parseInline', () => {
  it('強調・斜体・コード・リンク・裸の URL を読む', () => {
    expect(parseInline('a **b** *c* `d` [e](https://e.example) f https://g.example/x。')).toEqual([
      { t: 'text', text: 'a ' }, { t: 'strong', text: 'b' }, { t: 'text', text: ' ' }, { t: 'em', text: 'c' }, { t: 'text', text: ' ' },
      { t: 'code', text: 'd' }, { t: 'text', text: ' ' }, { t: 'link', text: 'e', href: 'https://e.example' }, { t: 'text', text: ' f ' },
      { t: 'link', text: 'https://g.example/x', href: 'https://g.example/x' }, { t: 'text', text: '。' }
    ])
  })

  it('文の終わりの句読点は URL に含めない', () => {
    expect(parseInline('see https://a.example/b.')).toEqual([{ t: 'text', text: 'see ' }, { t: 'link', text: 'https://a.example/b', href: 'https://a.example/b' }, { t: 'text', text: '.' }])
  })

  it('javascript: などのリンクは文字にする', () => {
    expect(parseInline('[x](javascript:alert(1))')).toEqual([{ t: 'text', text: 'x)' }])
    expect(parseInline('[x](data:text/html,hi)')).toEqual([{ t: 'text', text: 'x' }])
  })

  it('2 * 3 * 4 は斜体にしない。空は空', () => {
    expect(parseInline('2 * 3 * 4')).toEqual([{ t: 'text', text: '2 * 3 * 4' }])
    expect(parseInline('')).toEqual([])
  })

  it('safeHref は http(s)・mailto だけ', () => {
    expect(safeHref('https://a')).toBe(true)
    expect(safeHref('HTTP://a')).toBe(true)
    expect(safeHref('mailto:a@b')).toBe(true)
    expect(safeHref('javascript:x')).toBe(false)
    expect(safeHref('/relative')).toBe(false)
  })
})

describe('parseMarkdown', () => {
  it('見出し・段落・箇条書き・番号付き・引用・コード・区切り線を読む', () => {
    const md = ['# 題', '', '段落の1行目', '2行目', '', '- 一', '- [x] 二', '  続き', '1. いち', '2) に', '', '> 引用', '> 続き', '', '```ts', 'const a = 1', '```', '', '---', '## 終わり ##'].join('\n')
    expect(parseMarkdown(md)).toEqual([
      { t: 'heading', level: 1, inlines: [{ t: 'text', text: '題' }] },
      { t: 'paragraph', inlines: [{ t: 'text', text: '段落の1行目\n2行目' }] },
      { t: 'list', ordered: false, items: [[{ t: 'text', text: '一' }], [{ t: 'text', text: '二\n続き' }]] },
      { t: 'list', ordered: true, items: [[{ t: 'text', text: 'いち' }], [{ t: 'text', text: 'に' }]] },
      { t: 'quote', inlines: [{ t: 'text', text: '引用\n続き' }] },
      { t: 'code', text: 'const a = 1', lang: 'ts' },
      { t: 'rule' },
      { t: 'heading', level: 2, inlines: [{ t: 'text', text: '終わり' }] }
    ])
  })

  it('画像は行から取り出してその位置に置く（文と混じれば文が先）', () => {
    expect(parseMarkdown('前\n\n![図1](shots/a.png)\n文 ![図2](<b c.png> "title") 後\n\n終わり')).toEqual([
      { t: 'paragraph', inlines: [{ t: 'text', text: '前' }] },
      { t: 'image', alt: '図1', src: 'shots/a.png' },
      { t: 'paragraph', inlines: [{ t: 'text', text: '文 後' }] },
      { t: 'image', alt: '図2', src: 'b c.png' },
      { t: 'paragraph', inlines: [{ t: 'text', text: '終わり' }] }
    ])
  })

  it('空白を含む場所も、<> 無しで読む（題は捨てる）', () => {
    expect(parseMarkdown('![画面](shots/Screenshot 2026-10-11 at 15.33.03.png)\n![](a b.png "題")')).toEqual([
      { t: 'image', alt: '画面', src: 'shots/Screenshot 2026-10-11 at 15.33.03.png' },
      { t: 'image', alt: '', src: 'a b.png' }
    ])
  })

  it('front matter を外し、CRLF を読み、閉じていないコードは最後まで', () => {
    expect(parseMarkdown('---\ntitle: x\n---\r\n本文\r\n\r\n```\nopen')).toEqual([
      { t: 'paragraph', inlines: [{ t: 'text', text: '本文' }] },
      { t: 'code', text: 'open' }
    ])
  })

  it('空・空白だけは空', () => {
    expect(parseMarkdown('')).toEqual([])
    expect(parseMarkdown('  \n\n \t')).toEqual([])
  })

  it('箇条書きの種類が変わったら別のリストにし、段落が来たら閉じる', () => {
    const blocks = parseMarkdown('- a\n1. b\n段落')
    expect(blocks.map((b) => b.t)).toEqual(['list', 'list', 'paragraph'])
  })
})

describe('toHtml', () => {
  const resolve = (src: string) => src === 'a.png' ? { url: 'https://cdn.example/a.png', kind: 'image' as const } : src === 'v.mp4' ? { url: 'https://cdn.example/v.mp4', kind: 'video' as const } : null

  it('すべての文字をエスケープし、許したリンクだけ a にする', () => {
    const html = toHtml(parseMarkdown('<script>alert(1)</script> & "q"\n\n[ok](https://x.example/?a=1&b="2") [ng](javascript:x)'), resolve)
    expect(html).not.toContain('<script>')
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;q&quot;')
    expect(html).toContain('<a href="https://x.example/?a=1&amp;b=&quot;2&quot;">ok</a>')
    expect(html).not.toContain('javascript:')
  })

  it('画像・動画は置き場所に置き換え、分からないものは出さない', () => {
    const html = toHtml(parseMarkdown('![説明"](a.png)\n\n![](v.mp4)\n\n![](missing.png)'), resolve)
    expect(html).toBe('<figure class="wp-block-image"><img src="https://cdn.example/a.png" alt="説明&quot;"></figure>\n<figure class="wp-block-video"><video controls src="https://cdn.example/v.mp4"></video></figure>')
  })

  it('見出し・箇条書き・引用・コード・改行', () => {
    const html = toHtml(parseMarkdown('## 見出し\n\n1. a\n2. b\n\n> q\n\n```js\n<b>\n```\n\n行1\n行2'), resolve)
    expect(html).toBe(['<h2>見出し</h2>', '<ol><li>a</li><li>b</li></ol>', '<blockquote><p>q</p></blockquote>', '<pre><code class="language-js">&lt;b&gt;</code></pre>', '<p>行1<br>行2</p>'].join('\n'))
  })

  it('escapeHtml は5文字を置き換える', () => {
    expect(escapeHtml(`<>&"'`)).toBe('&lt;&gt;&amp;&quot;&#39;')
  })
})

describe('toPortableText', () => {
  const resolve = (src: string) => src === 'a.png' ? { kind: 'image' as const, id: 'M1', url: '/_emdash/api/media/file/k.png', width: 10, height: 20 }
    : src === 'v.mp4' ? { kind: 'video' as const, id: 'M2', url: 'https://cms.example/_emdash/api/media/file/v.mp4' } : null

  it('段落・見出し・引用・箇条書きを block に、リンクを markDefs にする（_key は重ならない）', () => {
    const pt = toPortableText(parseMarkdown('## 題\n\n**太** と [l](https://l.example)\n\n> q\n\n- a\n- b\n\n1. c'), resolve)
    expect(pt.map((b) => [b._type, b.style, b.listItem])).toEqual([
      ['block', 'h2', undefined], ['block', 'normal', undefined], ['block', 'blockquote', undefined],
      ['block', 'normal', 'bullet'], ['block', 'normal', 'bullet'], ['block', 'normal', 'number']
    ])
    const para = pt[1] as { children: Array<{ text: string; marks: string[] }>; markDefs: Array<{ _key: string; href: string }> }
    expect(para.children.map((c) => c.text)).toEqual(['太', ' と ', 'l'])
    expect(para.children[0]!.marks).toEqual(['strong'])
    expect(para.markDefs).toEqual([{ _key: para.children[2]!.marks[0], _type: 'link', href: 'https://l.example' }])
    const keys = JSON.stringify(pt).match(/"_key":"[^"]+"/g)!
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('画像は EmDash の image ブロック、動画はリンク、分からないものは出さない。区切り線は出さない', () => {
    const pt = toPortableText(parseMarkdown('![説明](a.png)\n\n![動画](v.mp4)\n\n![](nope.png)\n\n---'), resolve)
    expect(pt).toHaveLength(2)
    expect(pt[0]).toEqual({ _type: 'image', _key: expect.any(String), asset: { _ref: 'M1', url: '/_emdash/api/media/file/k.png' }, alt: '説明', width: 10, height: 20 })
    expect((pt[1] as { markDefs: Array<{ href: string }> }).markDefs[0]!.href).toBe('https://cms.example/_emdash/api/media/file/v.mp4')
  })

  it('コードは code ブロック、空の段落にも span を1つ置く', () => {
    const pt = toPortableText([{ t: 'code', text: 'x', lang: 'ts' }, { t: 'paragraph', inlines: [] }] as Block[], resolve)
    expect(pt[0]).toEqual({ _type: 'code', _key: expect.any(String), code: 'x', language: 'ts' })
    expect((pt[1] as { children: unknown[] }).children).toHaveLength(1)
  })
})

describe('plainExcerpt', () => {
  it('最初の段落の文字を、空白をまとめて上限で切る', () => {
    expect(plainExcerpt(parseMarkdown('## 見出し\n\n**一**\n二'))).toBe('一 二')
    expect(plainExcerpt(parseMarkdown('あ'.repeat(200)), 10)).toBe(`${'あ'.repeat(9)}…`)
    expect(plainExcerpt(parseMarkdown('あ'.repeat(10)), 10)).toBe('あ'.repeat(10))
    expect(plainExcerpt([])).toBe('')
  })
})
