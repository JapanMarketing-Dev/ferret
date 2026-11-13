import { Marked } from 'marked'
import { isMermaidFence } from '@shared/preview'
import { escapeHtml, isRemoteImageSource, mermaidBlock, remoteImagePlaceholder, type PreviewPageKind } from './render'

/**
 * Markdown をプレビューの中身（<main> の内側）の HTML にする（純粋関数。electron を読まない）。
 * marked はプレビューを初めて開いたときだけ要るので、render.ts から分けて index.ts が動的 import で読む
 * （main の起動時に読み込む JS を減らす）。
 */

const marked = new Marked({
  gfm: true,
  renderer: {
    html({ text }) {
      return escapeHtml(text)
    },
    image({ href, text }) {
      return isRemoteImageSource(href) ? remoteImagePlaceholder(href, text) : false
    },
    code({ text, lang }) {
      // false を返すと marked の既定の描き方（<pre><code>）になる
      return isMermaidFence(lang) ? mermaidBlock(text) : false
    }
  }
})

/** 描いた塊の最初のタグに、元の行（1始まり）を付ける。プレビューからエディタの該当行へ飛ぶのに使う */
function withSourceLine(html: string, line: number): string {
  return html.replace(/^(\s*<[a-z][a-z0-9]*)/i, `$1 data-line="${line}"`)
}

/**
 * ページの中身（<main> の内側）。保存・編集のたびに、これだけを作り直して差し替える。
 * 最上位の塊（見出し・段落・リスト・表・コード・図）ごとに描き、それぞれに data-line を付ける。
 */
export function renderPreviewBody(kind: PreviewPageKind, source: string): string {
  if (kind === 'mermaid') return withSourceLine(mermaidBlock(source), 1)
  if (kind === 'code') return `<pre class="code-view" data-line="1"><code>${escapeHtml(source)}</code></pre>\n`
  const tokens = marked.lexer(source)
  let line = 1
  let html = ''
  for (const token of tokens) {
    // 参照リンク（[a]: url）の定義は文書全体で共有する
    const part = marked.parser(Object.assign([token], { links: tokens.links }))
    html += token.type === 'space' ? part : withSourceLine(part, line)
    line += token.raw.split('\n').length - 1
  }
  return html
}
