/// <reference types="electron-vite/node" />
import { readFile } from 'node:fs/promises'
import { app, type Session, type WebContents } from 'electron'
import mermaidScript from 'mermaid/dist/mermaid.min.js?asset'
// 小さいページのスタイルとスクリプトは文字列として埋め込む（CSS は ?asset だと Vite の CSS 処理に取られる）
import pageScript from './page.js?raw'
import pageStyle from './page.css?raw'
import mermaidBlockScript from './mermaidBlock.js?raw'
import { PREVIEW_ASSET_HOST, PREVIEW_PROJECT_HOST, PREVIEW_SCHEME, previewKind, previewPathFromUrl } from '@shared/preview'
import { readTextFile } from '../files'
import { previewImageType, readPreviewImage } from './image'
import { consumeRemoteImagesGrant, isRemoteImagesGrantRequest, issueRemoteImagesGrant } from './remoteGrant'
import { mermaidScriptUrl, previewCsp, REMOTE_IMAGES_PARAM, renderMermaidBlockPage, renderPreviewMessage, renderPreviewPage } from './render'
import { t } from '@shared/i18n'
import { reportHandled } from '@shared/report'

/**
 * markdown / Mermaid のプレビューを返すカスタムプロトコル（ade-preview://）。
 *
 * renderer の DOM ではなく内蔵ブラウザ（WebContentsView）で開くページにすることで、
 * 録画・ペンと文字の書き込み・要素情報の仕組みがそのまま使える（指摘の URL にファイルの相対パスが残る）。
 * ファイルの読み出しは src/main/files.ts の検査を通す（プロジェクトの外・外を指すリンクは断る）。
 * Mermaid は npm の同梱版を返す（CDN は使わない。オフラインでも描ける）。
 */

/** 同梱の Mermaid の版付きの URL（アプリの版。更新すれば URL が変わるので、古いキャッシュを使わない） */
// 版が取れない（Electron の外の単体テストなど）ときは版なしの URL（キャッシュさせない今までの形）
const mermaidSrc = (): string => {
  let version: string | undefined
  try {
    version = app.getVersion()
  } catch {
    version = undefined
  }
  return mermaidScriptUrl(version)
}

/**
 * 版付きの URL で読んだ同梱の Mermaid は、その版の間ずっと同じなのでキャッシュしてよい（図ごと・ページごとに 5MB を読み直さない）。
 * 中身はアプリに同梱したファイルだけで、利用者の入力・プロジェクトのファイルではない。ほかの応答は今までどおり no-store
 */
export const IMMUTABLE_ASSET_CACHE = 'public, max-age=31536000, immutable'

/** 同梱のアセット。Mermaid（5MB 強）はファイルのまま置き、使うときだけ読む */
const ASSETS: Record<string, { load: () => Promise<string | Buffer>; type: string }> = {
  'mermaid.js': { load: () => readFile(mermaidScript), type: 'text/javascript; charset=utf-8' },
  'preview.js': { load: async () => pageScript, type: 'text/javascript; charset=utf-8' },
  'preview.css': { load: async () => pageStyle, type: 'text/css; charset=utf-8' },
  // Markdown の編集画面の ```mermaid の図を1つだけ描くページ（renderer が sandbox の iframe に入れる。mermaidBlock.js）
  'mermaid-block.html': { load: async () => renderMermaidBlockPage(mermaidSrc()), type: 'text/html; charset=utf-8' },
  'mermaid-block.js': { load: async () => mermaidBlockScript, type: 'text/javascript; charset=utf-8' }
}

function respond(body: string | Buffer, type: string, status = 200, remoteImages = false, cache = 'no-store'): Response {
  return new Response(typeof body === 'string' ? body : new Uint8Array(body), {
    status,
    headers: { 'Content-Type': type, 'Content-Security-Policy': previewCsp(remoteImages), 'Cache-Control': cache }
  })
}

const HTML = 'text/html; charset=utf-8'

/** Markdown の描画（marked 入り）は、プレビューを初めて描くときに読み込む（main の起動時に読む JS を減らす） */
const loadMarkdown = (): Promise<typeof import('./markdown')> => import('./markdown')

async function handle(request: Request, getRoot: () => string | null): Promise<Response> {
  const url = new URL(request.url)

  if (url.hostname === PREVIEW_ASSET_HOST) {
    const name = url.pathname.replace(/^\/+/, '')
    const asset = ASSETS[name]
    if (!asset) return respond('Not found', 'text/plain', 404)
    // 同梱の Mermaid を今の版の URL で読んだときだけ、キャッシュしてよいと返す（違う版・版なしは no-store）
    const cache = name === 'mermaid.js' && `${url.protocol}//${url.host}${url.pathname}${url.search}` === mermaidSrc() ? IMMUTABLE_ASSET_CACHE : 'no-store'
    return respond(await asset.load(), asset.type, 200, false, cache)
  }

  const root = getRoot()
  const path = previewPathFromUrl(request.url)
  if (url.hostname !== PREVIEW_PROJECT_HOST || !root || !path) return respond('Not found', 'text/plain', 404)

  // 「外部の画像を読み込む」のボタン（page.js）だけが、この文書に1回使える合言葉を受け取る（security-4 [6]。remoteGrant.ts）
  if (isRemoteImagesGrantRequest(request.method, request.headers)) {
    return new Response(JSON.stringify({ token: issueRemoteImagesGrant(path) }), {
      status: 200,
      headers: { 'Content-Type': 'application/json', 'Content-Security-Policy': previewCsp(), 'Cache-Control': 'no-store' }
    })
  }
  if (request.method.toUpperCase() !== 'GET' && request.method.toUpperCase() !== 'HEAD') return respond('Not found', 'text/plain', 404)

  // 画像は生のまま返す（markdown から参照される）。md / Mermaid 以外のテキストは読み取り専用のコードのページ
  const imageType = previewImageType(path)
  if (imageType) {
    // 大きさの上限・普通のファイルだけ（image.ts）
    const image = await readPreviewImage(root, path)
    if (image.status === 200) return respond(image.body, imageType)
    return image.status === 413 ? respond('Too large', 'text/plain', 413) : respond('Not found', 'text/plain', 404)
  }
  const kind = previewKind(path) ?? 'code'

  let body: string
  try {
    const result = await readTextFile(root, path)
    body = result.kind === 'text' ? (await loadMarkdown()).renderPreviewBody(kind, result.content) : renderPreviewMessage(result.reason)
  } catch (err) {
    const message = err instanceof Error && err.message === t('files.errors.outside') ? err.message : t('preview.readFailed')
    body = renderPreviewMessage(message)
  }
  // ?fragment=1 は保存のたびに page.js が取り直す中身だけ
  if (url.searchParams.get('fragment') === '1') return respond(body, HTML)
  // URL の値そのものは権限にしない。main が出した、この文書の使い切りの合言葉のときだけ https の画像を許す
  const remoteImages = consumeRemoteImagesGrant(url.searchParams.get(REMOTE_IMAGES_PARAM), path)
  return respond(renderPreviewPage({ path, kind, body, remoteImages, mermaidSrc: mermaidSrc() }), HTML, 200, remoteImages)
}

/**
 * セッションごとに登録する（内蔵ブラウザは別の partition、エディタの横並びの iframe は既定のセッション）。
 * スキームの特権（standard / secure / fetch）は app の ready 前に registerSchemesAsPrivileged で宣言しておくこと。
 */
export function registerPreviewProtocol(sessions: Session[], getRoot: () => string | null): void {
  for (const ses of sessions) {
    if (ses.protocol.isProtocolHandled(PREVIEW_SCHEME)) continue
    ses.protocol.handle(PREVIEW_SCHEME, (request) =>
      handle(request, getRoot).catch((err: unknown) => {
        console.warn('[preview] プレビューを返せませんでした', err)
    reportHandled(err, { area: 'preview', op: 'serve preview' })
        return respond('Error', 'text/plain', 500)
      })
    )
  }
}

/** 編集中の内容をページの中身にする（ファイルは読まないので、パスは種類の判定にだけ使う） */
export async function renderPreviewSource(path: unknown, source: unknown): Promise<string> {
  const kind = typeof path === 'string' ? previewKind(path) : null
  if (!kind || typeof source !== 'string') return ''
  return (await loadMarkdown()).renderPreviewBody(kind, source)
}

/**
 * 内蔵ブラウザがプレビューを開いていて、そのファイルが変わったら中身だけ差し替えさせる。
 * reload() にしないのは、録画中の書き込み（注入スクリプト）を消さないため。
 */
export function refreshPreviewIn(contents: WebContents | null, changedPaths: readonly string[]): void {
  if (!contents || contents.isDestroyed()) return
  const path = previewPathFromUrl(contents.getURL())
  if (!path || !changedPaths.includes(path)) return
  // 読み込み中・破棄済みのページでは呼べない（想定内。次の変更で呼び直す）
  void contents.executeJavaScript('window.__adePreviewRefresh && window.__adePreviewRefresh()').catch(() => undefined)
}
