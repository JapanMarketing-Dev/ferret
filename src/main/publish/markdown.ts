/**
 * ブログの記事（Markdown）を、WordPress へ送る HTML と EmDash へ送る Portable Text にする。
 *
 * - 記事は AI か利用者が書く短い Markdown なので、よく使う形だけを読む（見出し・段落・箇条書き・番号付き・引用・コード・区切り線・画像・
 *   強調・斜体・コード・リンク・裸の URL）。入れ子の強調や表は文字のまま残す
 * - 画像（![説明](場所)）は行から取り出して、その位置に置く。場所は呼び出し側がアップロードした先に置き換える
 * - リンクは http(s) と mailto だけ（javascript: などは文字にする）。HTML は全部エスケープする（記事の中の HTML は文字として出す）
 */

export type Inline =
  | { t: 'text'; text: string }
  | { t: 'strong' | 'em' | 'code'; text: string }
  | { t: 'link'; text: string; href: string }

export type Block =
  | { t: 'heading'; level: number; inlines: Inline[] }
  | { t: 'paragraph'; inlines: Inline[] }
  | { t: 'list'; ordered: boolean; items: Inline[][] }
  | { t: 'quote'; inlines: Inline[] }
  | { t: 'code'; text: string; lang?: string }
  | { t: 'image'; alt: string; src: string }
  | { t: 'rule' }

/** ![説明](場所) と ![説明](<場所>)。場所は空白を含んでよい（スクリーンショットの名前など）。"題" は捨てる */
const IMAGE = /!\[([^\]\n]*)\]\(\s*(?:<([^>\n]+)>|([^)\n]+?))(?:\s+"[^"\n]*")?\s*\)/g
const INLINE = /`([^`\n]+)`|\[([^\]\n]+)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)|\*\*([^*\n]+)\*\*|__([^_\n]+)__|(?<![*\w])\*(?=\S)([^*\n]*?\S)\*(?!\*)|(https?:\/\/[^\s<>()「」『』（）、。]+)/g

/** 送ってよいリンク先か */
export function safeHref(href: string): boolean {
  return /^(https?:\/\/|mailto:)/i.test(href.trim())
}

/** 1行の中の強調・リンクを読む */
export function parseInline(text: string): Inline[] {
  const out: Inline[] = []
  const push = (item: Inline) => {
    const last = out[out.length - 1]
    if (item.t === 'text' && last?.t === 'text') last.text += item.text
    else if (item.t !== 'text' || item.text) out.push(item)
  }
  let last = 0
  for (const m of text.matchAll(INLINE)) {
    const index = m.index ?? 0
    push({ t: 'text', text: text.slice(last, index) })
    last = index + m[0].length
    if (m[1] !== undefined) push({ t: 'code', text: m[1] })
    else if (m[2] !== undefined) push(safeHref(m[3]) ? { t: 'link', text: m[2], href: m[3] } : { t: 'text', text: m[2] })
    else if (m[4] !== undefined || m[5] !== undefined) push({ t: 'strong', text: m[4] ?? m[5] })
    else if (m[6] !== undefined) push({ t: 'em', text: m[6] })
    else if (m[7] !== undefined) {
      // 文の終わりの句読点は URL に含めない
      const url = m[7].replace(/[.,;:!?]+$/, '')
      push({ t: 'link', text: url, href: url })
      push({ t: 'text', text: m[7].slice(url.length) })
    }
  }
  push({ t: 'text', text: text.slice(last) })
  return out
}

/** 行の中の画像を取り出す（画像と、画像を除いた残りの文） */
function takeImages(line: string): { images: Array<{ alt: string; src: string }>; rest: string } {
  const images: Array<{ alt: string; src: string }> = []
  const rest = line.replace(IMAGE, (_, alt: string, bracketed: string | undefined, plain: string | undefined) => {
    images.push({ alt: alt.trim(), src: (bracketed ?? plain ?? '').trim() })
    return ''
  })
  return { images, rest: images.length ? rest.replace(/\s{2,}/g, ' ').trim() : rest }
}

export function parseMarkdown(markdown: string): Block[] {
  const lines = markdown.replace(/\r\n?/g, '\n').replace(/^---\n[\s\S]*?\n---(?:\n|$)/, '').split('\n')
  const blocks: Block[] = []
  let paragraph: string[] = []
  // 閉じた関数の中で書き換えるので、初期値で null に絞り込ませない
  let list = null as { ordered: boolean; items: string[] } | null
  let quote: string[] = []

  const flushParagraph = () => {
    if (paragraph.length) blocks.push({ t: 'paragraph', inlines: parseInline(paragraph.join('\n')) })
    paragraph = []
  }
  const flushList = () => {
    if (list?.items.length) blocks.push({ t: 'list', ordered: list.ordered, items: list.items.map(parseInline) })
    list = null
  }
  const flushQuote = () => {
    if (quote.length) blocks.push({ t: 'quote', inlines: parseInline(quote.join('\n')) })
    quote = []
  }
  const flushAll = () => { flushParagraph(); flushList(); flushQuote() }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const fenceMatch = /^\s{0,3}(```|~~~)\s*([\w+-]*)/.exec(line)
    if (fenceMatch) {
      flushAll()
      const body: string[] = []
      i++
      while (i < lines.length && !lines[i].trimStart().startsWith(fenceMatch[1])) body.push(lines[i++])
      blocks.push({ t: 'code', text: body.join('\n'), ...(fenceMatch[2] ? { lang: fenceMatch[2] } : {}) })
      continue
    }
    if (!line.trim()) { flushAll(); continue }
    if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) { flushAll(); blocks.push({ t: 'rule' }); continue }

    const { images, rest } = takeImages(line)
    if (images.length) {
      // 画像だけの行・文と画像の混じった行。文は前の段落に足してから画像を置く
      if (rest) {
        if (list || quote.length) flushAll()
        paragraph.push(rest)
      }
      flushAll()
      for (const image of images) blocks.push({ t: 'image', ...image })
      continue
    }

    const heading = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line)
    if (heading) {
      flushAll()
      blocks.push({ t: 'heading', level: heading[1].length, inlines: parseInline(heading[2]) })
      continue
    }
    const quoted = /^\s{0,3}>\s?(.*)$/.exec(line)
    if (quoted) {
      flushParagraph(); flushList()
      quote.push(quoted[1])
      continue
    }
    const bullet = /^\s{0,3}[-*+]\s+(?:\[[ xX]\]\s+)?(.*)$/.exec(line)
    const numbered = /^\s{0,3}\d{1,9}[.)]\s+(.*)$/.exec(line)
    if (bullet || numbered) {
      flushParagraph(); flushQuote()
      const ordered = Boolean(numbered)
      if (list && list.ordered !== ordered) flushList()
      list ??= { ordered, items: [] }
      list.items.push((bullet ?? numbered)![1])
      continue
    }
    if (list && /^\s{2,}\S/.test(line)) {
      // 箇条書きの続きの行
      list.items[list.items.length - 1] += `\n${line.trim()}`
      continue
    }
    if (list) flushList()
    if (quote.length) flushQuote()
    paragraph.push(line.trim())
  }
  flushAll()
  return blocks
}

export function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

function inlineHtml(inlines: Inline[]): string {
  return inlines.map((i) => {
    const text = escapeHtml(i.text).replace(/\n/g, '<br>')
    if (i.t === 'strong') return `<strong>${text}</strong>`
    if (i.t === 'em') return `<em>${text}</em>`
    if (i.t === 'code') return `<code>${text}</code>`
    if (i.t === 'link') return `<a href="${escapeHtml(i.href)}">${text}</a>`
    return text
  }).join('')
}

/** 画像・動画の置き場所（アップロードした先）。分からなければ null（その画像は出さない） */
export type MediaResolver<T> = (src: string, alt: string) => T | null

export interface HtmlMedia {
  url: string
  kind: 'image' | 'video'
}

export function toHtml(blocks: Block[], resolve: MediaResolver<HtmlMedia>): string {
  return blocks.flatMap((b): string[] => {
    switch (b.t) {
      case 'heading': return [`<h${b.level}>${inlineHtml(b.inlines)}</h${b.level}>`]
      case 'paragraph': return [`<p>${inlineHtml(b.inlines)}</p>`]
      case 'quote': return [`<blockquote><p>${inlineHtml(b.inlines)}</p></blockquote>`]
      case 'list': {
        const tag = b.ordered ? 'ol' : 'ul'
        return [`<${tag}>${b.items.map((item) => `<li>${inlineHtml(item)}</li>`).join('')}</${tag}>`]
      }
      case 'code': return [`<pre><code${b.lang ? ` class="language-${escapeHtml(b.lang)}"` : ''}>${escapeHtml(b.text)}</code></pre>`]
      case 'rule': return ['<hr>']
      case 'image': {
        const media = resolve(b.src, b.alt)
        if (!media) return []
        if (media.kind === 'video') return [`<figure class="wp-block-video"><video controls src="${escapeHtml(media.url)}"></video></figure>`]
        return [`<figure class="wp-block-image"><img src="${escapeHtml(media.url)}" alt="${escapeHtml(b.alt)}"></figure>`]
      }
    }
  }).join('\n')
}

/** Portable Text の画像・動画（EmDash へアップロードしたもの） */
export interface PortableMedia {
  kind: 'image' | 'video'
  /** EmDash の media の id */
  id: string
  /** 開ける URL（EmDash の中なら /_emdash/api/media/file/… のような相対でもよい） */
  url: string
  width?: number
  height?: number
}

type PortableBlock = Record<string, unknown>

export function toPortableText(blocks: Block[], resolve: MediaResolver<PortableMedia>): PortableBlock[] {
  let n = 0
  const key = () => `k${(n++).toString(36)}`
  const textBlock = (inlines: Inline[], extra: Record<string, unknown>): PortableBlock => {
    const markDefs: Array<{ _key: string; _type: 'link'; href: string }> = []
    const children = inlines.map((i) => {
      const marks: string[] = []
      if (i.t === 'strong') marks.push('strong')
      else if (i.t === 'em') marks.push('em')
      else if (i.t === 'code') marks.push('code')
      else if (i.t === 'link') {
        const k = key()
        markDefs.push({ _key: k, _type: 'link', href: i.href })
        marks.push(k)
      }
      return { _type: 'span', _key: key(), text: i.text, marks }
    })
    return { _type: 'block', _key: key(), style: 'normal', markDefs, children: children.length ? children : [{ _type: 'span', _key: key(), text: '', marks: [] }], ...extra }
  }
  return blocks.flatMap((b): PortableBlock[] => {
    switch (b.t) {
      case 'heading': return [textBlock(b.inlines, { style: `h${Math.min(6, Math.max(1, b.level))}` })]
      case 'paragraph': return [textBlock(b.inlines, {})]
      case 'quote': return [textBlock(b.inlines, { style: 'blockquote' })]
      case 'list': return b.items.map((item) => textBlock(item, { listItem: b.ordered ? 'number' : 'bullet', level: 1 }))
      case 'code': return [{ _type: 'code', _key: key(), code: b.text, ...(b.lang ? { language: b.lang } : {}) }]
      case 'rule': return []
      case 'image': {
        const media = resolve(b.src, b.alt)
        if (!media) return []
        // 動画は Portable Text の標準の形が無いので、ファイルへのリンクにする
        if (media.kind === 'video') return [textBlock([{ t: 'link', text: b.alt || media.url, href: media.url }], {})]
        return [{
          _type: 'image', _key: key(), asset: { _ref: media.id, url: media.url },
          ...(b.alt ? { alt: b.alt } : {}), ...(media.width ? { width: media.width } : {}), ...(media.height ? { height: media.height } : {})
        }]
      }
    }
  })
}

/** 記事の本文の先頭の段落の文字（抜粋に使う） */
export function plainExcerpt(blocks: Block[], max = 160): string {
  const first = blocks.find((b): b is Extract<Block, { t: 'paragraph' }> => b.t === 'paragraph')
  const text = first ? first.inlines.map((i) => i.text).join('').replace(/\s+/g, ' ').trim() : ''
  return Array.from(text).length > max ? `${Array.from(text).slice(0, max - 1).join('')}…` : text
}
