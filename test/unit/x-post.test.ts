import { describe, expect, it } from 'vitest'
import { X_MAX_PARTS, X_MAX_WEIGHT, markdownToPostText, splitForThread, xIntentUrl, xWeightedLength } from '../../src/shared/xPost'

/** X への投稿文の下ごしらえ（src/shared/xPost.ts）。外へは送らない */

describe('X の数え方（xWeightedLength）', () => {
  it('英数字は1、日本語は2で数える', () => {
    expect(xWeightedLength('')).toBe(0)
    expect(xWeightedLength('abc 123')).toBe(7)
    expect(xWeightedLength('こんにちは')).toBe(10)
    expect(xWeightedLength('Ferretで投稿')).toBe(6 + 3 * 2)
  })

  it('一般句読点の範囲（– — ‘ ’ “ ” …）は1', () => {
    expect(xWeightedLength('–—‘’“”')).toBe(6)
    expect(xWeightedLength('…')).toBe(2) // … は範囲外なので2
  })

  it('URL は長さによらず23', () => {
    expect(xWeightedLength('https://example.com')).toBe(23)
    expect(xWeightedLength(`https://example.com/${'a'.repeat(200)}`)).toBe(23)
    expect(xWeightedLength('見て https://japan-marketing.co.jp/blog/1 です')).toBe(2 * 2 + 1 + 23 + 1 + 4)
    expect(xWeightedLength('www.example.com')).toBe(23)
  })

  it('URL の後ろに続く日本語の句読点は URL に含めない', () => {
    expect(xWeightedLength('https://a.example。')).toBe(23 + 2)
    expect(xWeightedLength('（https://a.example）')).toBe(2 + 23 + 2)
  })

  it('絵文字は ZWJ・肌の色・国旗を含めて1つで2', () => {
    expect(xWeightedLength('😀')).toBe(2)
    expect(xWeightedLength('👍🏽')).toBe(2)
    expect(xWeightedLength('👨‍👩‍👧')).toBe(2)
    expect(xWeightedLength('🇯🇵')).toBe(2)
  })

  it('濁点を分けて書いた文字は NFC にまとめてから数える', () => {
    expect(xWeightedLength('が')).toBe(xWeightedLength('が'))
  })

  it('上限ちょうどと1つ超え', () => {
    expect(xWeightedLength('a'.repeat(X_MAX_WEIGHT))).toBe(280)
    expect(xWeightedLength('あ'.repeat(140))).toBe(280)
    expect(xWeightedLength('あ'.repeat(140) + 'a')).toBe(281)
  })
})

describe('Markdown から投稿文（markdownToPostText）', () => {
  it('見出し・強調・コード・引用の記号を外す', () => {
    expect(markdownToPostText('# 題\n\n**太字**と*斜体*と`code`\n\n> 引用')).toBe('題\n\n太字と斜体とcode\n\n引用')
  })

  it('リンクは「文字 URL」、同じならURLだけ。画像は消す', () => {
    expect(markdownToPostText('[記事](https://a.example/x) と [https://b.example](https://b.example) ![図](a.png)')).toBe('記事 https://a.example/x と https://b.example')
  })

  it('箇条書きは「・」、チェックボックスも外す。番号付きは残す', () => {
    expect(markdownToPostText('- 一\n* 二\n- [x] 三\n1. 四')).toBe('・一\n・二\n・三\n1. 四')
  })

  it('front matter・HTML のコメント・コードブロックの囲み・区切り線を外す', () => {
    const md = '---\ntitle: x\n---\n<!-- 下書き -->\n本文\n\n```ts\nconst a = 1\n```\n\n---\n\n終わり'
    expect(markdownToPostText(md)).toBe('本文\n\nconst a = 1\n\n終わり')
  })

  it('HTML のタグは外して中の文字を残し、<br> と段落の終わりは改行にする', () => {
    expect(markdownToPostText('<div align="center">\n<img src="a.svg" alt="x">\n</div>\n\n声と画面で。<br>次の行<br/>')).toBe('声と画面で。\n次の行')
    expect(markdownToPostText('<p>一</p><p>二</p>')).toBe('一\n二')
    expect(markdownToPostText('<scr<script>ipt>alert(1)</script>')).toBe('alert(1)')
    expect(markdownToPostText('1 < 2 と a<b')).toBe('1 < 2 と a<b')
  })

  it('snake_case の下線と掛け算の * は崩さない', () => {
    expect(markdownToPostText('file_name_here と 2 * 3 * 4')).toBe('file_name_here と 2 * 3 * 4')
  })

  it('CRLF をそろえ、3行以上の空きを詰める。空なら空', () => {
    expect(markdownToPostText('a\r\n\r\n\r\n\r\nb  ')).toBe('a\n\nb')
    expect(markdownToPostText('')).toBe('')
    expect(markdownToPostText('   \n\n  ')).toBe('')
  })
})

describe('スレッドに分ける（splitForThread）', () => {
  const allFit = (parts: string[]) => parts.every((p) => xWeightedLength(p) <= X_MAX_WEIGHT && p.trim() === p && p.length > 0)

  it('空は0件、収まれば1件のまま（前後の空白は落とす）', () => {
    expect(splitForThread('')).toEqual({ parts: [], overflow: false })
    expect(splitForThread('  \n ')).toEqual({ parts: [], overflow: false })
    expect(splitForThread('  短い  ')).toEqual({ parts: ['短い'], overflow: false })
    expect(splitForThread('あ'.repeat(140)).parts).toHaveLength(1)
  })

  it('段落の切れ目で分ける', () => {
    const a = 'あ'.repeat(100), b = 'い'.repeat(100)
    expect(splitForThread(`${a}\n\n${b}`).parts).toEqual([a, b])
  })

  it('収まる段落はまとめる', () => {
    const { parts } = splitForThread(['一'.repeat(30), '二'.repeat(30), '三'.repeat(130)].join('\n\n'))
    expect(parts).toEqual([`${'一'.repeat(30)}\n\n${'二'.repeat(30)}`, '三'.repeat(130)])
  })

  it('長い段落は句点で分ける', () => {
    const sentence = `${'文'.repeat(59)}。`
    const { parts } = splitForThread(sentence.repeat(5))
    expect(parts).toEqual([sentence.repeat(2), sentence.repeat(2), sentence])
    expect(allFit(parts)).toBe(true)
  })

  it('句点の無い長い文は文字で切り、元の文字を失わない', () => {
    const text = 'あ'.repeat(500)
    const { parts } = splitForThread(text)
    expect(parts.join('')).toBe(text)
    expect(parts.map((p) => p.length)).toEqual([140, 140, 140, 80])
  })

  it('絵文字・結合文字を途中で切らない', () => {
    const text = '👨‍👩‍👧'.repeat(200)
    const { parts } = splitForThread(text)
    expect(parts.join('')).toBe(text)
    expect(parts.every((p) => [...new Intl.Segmenter().segment(p)].every((s) => s.segment === '👨‍👩‍👧'))).toBe(true)
    expect(allFit(parts)).toBe(true)
  })

  it('英文は ! ? . の後ろの空白で切れる', () => {
    const s = `${'word '.repeat(19)}end. `
    const { parts } = splitForThread(s.repeat(4).trim())
    expect(allFit(parts)).toBe(true)
    expect(parts.length).toBe(2)
  })

  it('上限の件数を超えたら overflow', () => {
    const text = Array.from({ length: X_MAX_PARTS + 3 }, () => 'あ'.repeat(140)).join('\n\n')
    const result = splitForThread(text)
    expect(result.parts).toHaveLength(X_MAX_PARTS)
    expect(result.overflow).toBe(true)
  })

  it('上限を引数で変えられる', () => {
    expect(splitForThread('abcdef', 3).parts).toEqual(['abc', 'def'])
  })
})

describe('投稿画面の URL（xIntentUrl）', () => {
  it('本文を符号化して x.com の投稿画面へ', () => {
    const url = new URL(xIntentUrl('こんにちは #Ferret & https://a.example/?q=1'))
    expect(url.origin + url.pathname).toBe('https://x.com/intent/post')
    expect(url.searchParams.get('text')).toBe('こんにちは #Ferret & https://a.example/?q=1')
    expect([...url.searchParams.keys()]).toEqual(['text'])
  })

  it('改行を保ち、280文字の日本語でも内蔵ブラウザに渡せる長さ（8000未満）', () => {
    expect(new URL(xIntentUrl('a\n\nb')).searchParams.get('text')).toBe('a\n\nb')
    expect(xIntentUrl('あ'.repeat(140)).length).toBeLessThan(8000)
  })
})
