import { PREVIEW_SCHEME, type PreviewKind } from '@shared/preview'

/** ページの種類。md / Mermaid 以外のテキストは、読み取り専用のコードとして出す（レビューの対象にするため） */
export type PreviewPageKind = PreviewKind | 'code'
import { getLocale, t } from '@shared/i18n'

/**
 * プレビューのページの HTML を組み立てる（純粋関数。electron を読まない）。
 *
 * Orca は react-markdown と remark / rehype で描く（~/bench/orca/src/renderer/src/components/editor/
 * markdown-preview-document-engine.ts ほか、MIT）。ここは内蔵ブラウザへ渡す静的なページなので、
 * main で marked を使って HTML にし（markdown.ts。初めて描くときに読み込む）、```mermaid のブロックだけ <pre class="mermaid"> にして
 * ページ側（page.js）で Mermaid に描かせる。
 * 生の HTML は文字として出す（Agent が書いたファイルのスクリプトをレビュー対象のページで動かさない）。
 */

/**
 * ページで「外部の画像を読み込む」を押したときだけ付くクエリ。値は main が出した使い切りの合言葉で、
 * 値そのものは権限ではない（security-4 [6]。remoteGrant.ts）。保存する URL からは剥がす
 */
export { REMOTE_IMAGES_QUERY as REMOTE_IMAGES_PARAM } from '@shared/preview'

/**
 * ページのスクリプトは同梱の2本だけ。Mermaid の SVG は style 属性を使うので style は inline を許す。
 * 外部の画像（README のバッジなど）は既定で読まない（security-3 [5]）。利用者が押したページだけ https を許す。
 */
export function previewCsp(remoteImages = false): string {
  return [
    "default-src 'none'",
    `script-src ${PREVIEW_SCHEME}:`,
    `style-src ${PREVIEW_SCHEME}: 'unsafe-inline'`,
    `img-src ${PREVIEW_SCHEME}: data:${remoteImages ? ' https:' : ''}`,
    `font-src ${PREVIEW_SCHEME}: data:`,
    `connect-src ${PREVIEW_SCHEME}:`
  ].join('; ')
}

/**
 * 同梱の Mermaid（約 5MB）の URL。版を付けると、main はその版の間ずっと変わらないものとしてキャッシュしてよいと返す
 * （index.ts の immutable）。図ごと・ページごとに読み直さない。中身は同梱のファイルで、利用者の入力ではない
 */
export function mermaidScriptUrl(version?: string): string {
  return `${PREVIEW_SCHEME}://assets/mermaid.js${version ? `?v=${encodeURIComponent(version)}` : ''}`
}

export function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

export function mermaidBlock(source: string): string {
  return `<pre class="mermaid">${escapeHtml(source)}</pre>\n`
}

/**
 * 外の画像（http(s)・// で始まる・ほかのスキーム）か。プロジェクトの中の相対パスと data: は false。
 * プロジェクトの Markdown が書いた URL を黙って読みに行くと、利用者の IP・時刻が相手に渡る（security-3 [5]）
 */
export function isRemoteImageSource(href: string): boolean {
  const src = href.trim()
  if (src.startsWith('//')) return true
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(src)?.[1]?.toLowerCase()
  return scheme !== undefined && scheme !== 'data' && scheme !== PREVIEW_SCHEME
}

function remoteImageHost(href: string): string {
  try {
    return new URL(href.trim().startsWith('//') ? `https:${href.trim()}` : href.trim()).host || href
  } catch {
    return href
  }
}

/**
 * 外の画像は読み込まない印にする（行き先のホストを見せる）。利用者がページの「外部の画像を読み込む」を押したときだけ、
 * page.js が https の画像に置き換える（そのときだけ main が CSP で https を許す。index.ts）
 */
export function remoteImagePlaceholder(href: string, alt: string): string {
  const host = remoteImageHost(href)
  const label = alt.trim() ? `${alt.trim()} · ${host}` : host
  return `<span class="remote-image" data-remote-src="${escapeHtml(href.trim())}" data-remote-alt="${escapeHtml(alt)}" data-remote-host="${escapeHtml(host)}" title="${escapeHtml(href.trim())}">${escapeHtml(label)}</span>`
}

/** 開けないファイル（バイナリ・大きすぎる・読めない）のときの中身 */
export function renderPreviewMessage(message: string): string {
  return `<p class="mermaid-error">${escapeHtml(message)}</p>\n`
}

/**
 * プレビューのページ全体。スタイルとスクリプトは同梱のもの（ade-preview://assets/…）だけを読む。
 * Mermaid（5MB 強）は図があるときだけ page.js が読み込む。
 */
export function renderPreviewPage({ path, kind, body, remoteImages = false, mermaidSrc = mermaidScriptUrl() }: { path: string; kind: PreviewPageKind; body: string; remoteImages?: boolean; mermaidSrc?: string }): string {
  const name = path.slice(path.lastIndexOf('/') + 1)
  // page.js は辞書を読めないので、ページで出す文は data 属性で渡す（言語はページを返した時点のもの）
  const messages = `data-msg-mermaid-load="${escapeHtml(t('preview.mermaidLoadFailed'))}" data-msg-diagram-failed="${escapeHtml(t('preview.diagramFailed', { error: '{{error}}' }))}"` +
    ` data-msg-remote-blocked="${escapeHtml(t('preview.remoteImagesBlocked', { hosts: '{{hosts}}' }))}" data-msg-remote-load="${escapeHtml(t('preview.remoteImagesLoad'))}"` +
    ` data-remote-images="${remoteImages ? 'allow' : 'block'}" data-mermaid-src="${escapeHtml(mermaidSrc)}"`
  return `<!doctype html>
<html lang="${getLocale()}">
<head>
<meta charset="utf-8">
<meta name="color-scheme" content="light dark">
<title>${escapeHtml(name)}</title>
<link rel="stylesheet" href="ade-preview://assets/preview.css">
</head>
<body>
<main id="ade-preview" class="markdown-body${kind === 'mermaid' ? ' markdown-body--diagram' : ''}" data-path="${escapeHtml(path)}" ${messages}>
${body}</main>
<script src="ade-preview://assets/preview.js"></script>
</body>
</html>
`
}

/**
 * Markdown の編集画面の ```mermaid の図を描くページ（ade-preview://assets/mermaid-block.html）。
 * 親（renderer）が隠した sandbox の iframe を1つだけ置き、図のソースを postMessage で渡す。描いた SVG を返すだけで、ここには表示しない（mermaidBlock.js）
 */
export function renderMermaidBlockPage(mermaidSrc: string = mermaidScriptUrl()): string {
  return `<!doctype html>
<html lang="${getLocale()}">
<head>
<meta charset="utf-8">
<style>
html, body { margin: 0; padding: 0; background: transparent; overflow: hidden; }
#ade-mermaid { width: 1200px; }
</style>
</head>
<body>
<div id="ade-mermaid" data-msg-mermaid-load="${escapeHtml(t('preview.mermaidLoadFailed'))}" data-mermaid-src="${escapeHtml(mermaidSrc)}"></div>
<script src="ade-preview://assets/mermaid-block.js"></script>
</body>
</html>
`
}
