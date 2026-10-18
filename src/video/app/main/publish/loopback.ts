/**
 * インストール型アプリの OAuth（RFC 8252）のリダイレクトを、端末の中のループバックで1回だけ受ける（YouTube・TikTok で共用）。
 * Ferret の X の受け口（src/main/publish/xAuthServer.ts）と同じ作法に、旧 Solocut の loopback.ts の「空いているポート」を足したもの。
 *
 * - 127.0.0.1 だけで待つ（ほかの端末からは届かない）。GET と決めたパス以外は 404 で無視して待ち続ける（favicon など）
 * - state が合わないものは 400 で断って待ち続ける（別のページから送り込まれた code を使わない。そのページに接続を止めさせもしない）
 * - 許可・拒否どちらでも受けたら閉じる。時間切れ・取り消しでも閉じる
 * - port 0 は空いているポート（Google はループバックの任意のポートを許す）。固定のポート（TikTok の 47823）が使われていれば分かる文で断る
 */
import { createServer, type Server } from 'node:http'
import { UserFacingError } from '@shared/errors'
import { t } from '@shared/i18n'

export const LOOPBACK_HOST = '127.0.0.1'

export interface LoopbackOptions {
  /** 0 = 空いているポート */
  port: number
  /** リダイレクトのパス（Google は '/'、TikTok は '/tiktok/callback'） */
  path: string
  state: string
  timeoutMs: number
  /** ブラウザのタブに出す名前（YouTube / TikTok） */
  label: string
}

export interface LoopbackWaiter {
  /** 待ち受けを始めたら、そのリダイレクト URI で解決する */
  ready: Promise<string>
  /** 許可されたら code。拒否・時間切れ・取り消しは例外 */
  code: Promise<string>
  cancel: () => void
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)

function page(message: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Ferret</title></head><body style="font-family:system-ui,sans-serif;padding:48px;text-align:center"><p>${esc(message)}</p></body></html>`
}

/** 待ち受けた本当のポートから、認可の要求に書くリダイレクト URI（Google の '/' は付けない） */
export function redirectUriFor(port: number, path: string): string {
  return `http://${LOOPBACK_HOST}:${port}${path === '/' ? '' : path}`
}

export function waitForLoopback(o: LoopbackOptions): LoopbackWaiter {
  let server: Server | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  let settle: { resolve: (code: string) => void; reject: (err: Error) => void } | null = null
  /** 待ち受けが始まる前に終わったとき ready も終わらせる（始まったあとは何もしない） */
  let rejectReady: ((err: Error) => void) | null = null
  const code = new Promise<string>((resolve, reject) => { settle = { resolve, reject } })
  // 呼び出し側が待つ前に失敗しても、捕まえていない例外にしない
  code.catch(() => undefined)

  const finish = (err: Error | null, value?: string) => {
    if (!settle) return
    const s = settle
    settle = null
    if (timer) clearTimeout(timer)
    server?.close()
    server?.closeAllConnections?.()
    if (err) s.reject(err)
    else s.resolve(value ?? '')
    rejectReady?.(err ?? new UserFacingError(t('video.publish.errors.cancelled')))
  }

  const ready = new Promise<string>((resolve, reject) => {
    rejectReady = reject
    server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', `http://${LOOPBACK_HOST}`)
      if (req.method !== 'GET' || url.pathname !== o.path) {
        res.writeHead(404).end()
        return
      }
      if (url.searchParams.get('state') !== o.state) {
        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' }).end(page(t('video.publish.auth.failedPage', { target: o.label })))
        return
      }
      const error = url.searchParams.get('error')
      const value = url.searchParams.get('code')
      if (error || !value) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(page(t('video.publish.auth.failedPage', { target: o.label })))
        finish(new UserFacingError(t('video.publish.errors.denied', { target: o.label })))
        return
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(page(t('video.publish.auth.donePage', { target: o.label })))
      finish(null, value)
    })
    server.once('error', (err: NodeJS.ErrnoException) => {
      const failure = err.code === 'EADDRINUSE' && o.port
        ? new UserFacingError(t('video.publish.errors.portBusy', { port: o.port }))
        : err
      reject(failure)
      finish(failure)
    })
    server.listen(o.port, LOOPBACK_HOST, () => {
      // 待ち受けが始まる前に取り消された: 開いたままにしない
      if (!settle) {
        server?.close()
        reject(new UserFacingError(t('video.publish.errors.cancelled')))
        return
      }
      const addr = server?.address()
      const port = typeof addr === 'object' && addr ? addr.port : o.port
      timer = setTimeout(() => finish(new UserFacingError(t('video.publish.errors.timeout'))), o.timeoutMs)
      rejectReady = null
      resolve(redirectUriFor(port, o.path))
    })
  })
  ready.catch(() => undefined)

  return { ready, code, cancel: () => finish(new UserFacingError(t('video.publish.errors.cancelled'))) }
}
