import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { describeTargetUrl, isMermaidFence, previewKind, previewPathFromUrl, previewUrl } from '@shared/preview'
import { readTextFile } from '../../src/main/files'
import { renderPreviewPage } from '../../src/main/preview/render'
import { renderPreviewBody } from '../../src/main/preview/markdown'

// 期待値は日本語の文言。画面の言語を日本語に固定する（既定は英語）
import { setLocale } from '@shared/i18n'
setLocale('ja')

describe('プレビューの URL', () => {
  it('相対パスと行き来できる（日本語・空白・# を含む名前も）', () => {
    for (const path of ['README.md', 'docs/設計 メモ.md', 'docs/a#b.mmd']) {
      expect(previewPathFromUrl(previewUrl(path))).toBe(path)
    }
    expect(previewUrl('docs/a b.md')).toBe('ade-preview://project/docs/a%20b.md')
  })

  it('クエリ・ハッシュは見ない（同じファイルの再読み込みは同じページ）', () => {
    expect(previewPathFromUrl('ade-preview://project/docs/a.md?fragment=1#top')).toBe('docs/a.md')
  })

  it('プレビュー以外の URL は null', () => {
    expect(previewPathFromUrl('http://localhost:3000/docs/a.md')).toBeNull()
    expect(previewPathFromUrl('ade-preview://assets/preview.js')).toBeNull()
    expect(previewPathFromUrl('ade-preview://project/')).toBeNull()
    expect(previewPathFromUrl('not a url')).toBeNull()
  })

  it('プレビューできるのは markdown と Mermaid だけ', () => {
    expect(previewKind('docs/A.MD')).toBe('markdown')
    expect(previewKind('flow.mmd')).toBe('mermaid')
    expect(previewKind('flow.mermaid')).toBe('mermaid')
    expect(previewKind('src/a.ts')).toBeNull()
  })

  it('feedback.md ではファイルの相対パスで示す', () => {
    expect(describeTargetUrl('ade-preview://project/docs/a.md')).toContain('docs/a.md')
    expect(describeTargetUrl('http://localhost:3000/')).toBeNull()
  })
})

describe('プレビューのパス検査', () => {
  let base: string
  let root: string

  beforeAll(async () => {
    base = await mkdtemp(join(tmpdir(), 'ade-preview-'))
    root = join(base, 'project')
    await mkdir(join(root, 'docs'), { recursive: true })
    await writeFile(join(root, 'docs', 'a.md'), '# A\n')
    await writeFile(join(base, 'secret.md'), '# secret\n')
  })

  afterAll(async () => {
    await rm(base, { recursive: true, force: true })
  })

  it('URL の中の符号化した .. でも外のファイルは読めない', async () => {
    const path = previewPathFromUrl('ade-preview://project/..%2Fsecret.md')
    expect(path).toBe('../secret.md')
    await expect(readTextFile(root, path!)).rejects.toThrow('プロジェクトフォルダの外')
  })

  it('文字の .. は URL の解決で根に丸められ、外へは出ない', async () => {
    const path = previewPathFromUrl('ade-preview://project/docs/../../secret.md')
    expect(path).toBe('secret.md')
    await expect(readTextFile(root, path!)).rejects.toThrow()
  })

  it('中のファイルは読める', async () => {
    const path = previewPathFromUrl(previewUrl('docs/a.md'))!
    await expect(readTextFile(root, path)).resolves.toMatchObject({ kind: 'text', content: '# A\n' })
  })
})

describe('Mermaid のブロックの抽出', () => {
  it('```mermaid は <pre class="mermaid"> になり、中身は文字として残る', () => {
    const html = renderPreviewBody('markdown', '# 図\n\n```mermaid\ngraph TD\n  A-->B["<b>x</b>"]\n```\n\n本文\n')
    expect(html).toContain('<pre data-line="3" class="mermaid">graph TD\n  A--&gt;B[&quot;&lt;b&gt;x&lt;/b&gt;&quot;]</pre>')
    expect(html).toContain('<h1 data-line="1">図</h1>')
    // 塊ごとに元の行が付く（プレビューからエディタの該当行へ飛ぶ）
    expect(html).toContain('<p data-line="8">本文</p>')
  })

  it('~~~ のフェンスと mmd の名前も Mermaid として扱う', () => {
    expect(renderPreviewBody('markdown', '~~~mmd\nsequenceDiagram\n~~~\n')).toContain('<pre data-line="1" class="mermaid">sequenceDiagram</pre>')
  })

  it('ほかの言語のコードはふつうのコードブロック', () => {
    const html = renderPreviewBody('markdown', '```ts\nconst a = 1\n```\n')
    expect(html).not.toContain('class="mermaid"')
    expect(html).toContain('<code class="language-ts">')
  })

  it('.mmd のファイルは全体を1つの図にする', () => {
    expect(renderPreviewBody('mermaid', 'graph LR\nA-->B')).toBe('<pre data-line="1" class="mermaid">graph LR\nA--&gt;B</pre>\n')
  })

  it('参照リンクの定義は塊ごとに描いても効く', () => {
    const html = renderPreviewBody('markdown', 'see [doc][d]\n\n[d]: https://example.com/\n')
    expect(html).toContain('<a href="https://example.com/">doc</a>')
  })

  it('md / Mermaid 以外のテキストは読み取り専用のコードとして出す', () => {
    expect(renderPreviewBody('code', 'const a = "<b>"\n')).toBe('<pre class="code-view" data-line="1"><code>const a = &quot;&lt;b&gt;&quot;\n</code></pre>\n')
  })

  it('フェンスの言語名の判定', () => {
    expect(isMermaidFence('mermaid')).toBe(true)
    expect(isMermaidFence(' Mermaid {theme=dark}')).toBe(true)
    expect(isMermaidFence('mermaidx')).toBe(false)
    expect(isMermaidFence(undefined)).toBe(false)
  })

  it('生の HTML は動かさずに文字で出す', () => {
    const html = renderPreviewBody('markdown', '<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>\n')
    expect(html).not.toContain('<script>')
    expect(html).not.toContain('<img')
  })

  it('ページは同梱のスクリプトとスタイルだけを読む', () => {
    const page = renderPreviewPage({ path: 'docs/<a>.md', kind: 'markdown', body: '<p>x</p>' })
    expect(page).toContain('<title>&lt;a&gt;.md</title>')
    expect(page).toContain('src="ade-preview://assets/preview.js"')
    expect(page).not.toMatch(/https?:\/\//)
  })
})
