/**
 * X の OAuth のコールバック（http://127.0.0.1:<固定のポート>/x/callback）を、端末の中だけで1回受ける。
 *
 * - 127.0.0.1 だけで待つ（ほかの端末からは届かない）。決めたパス・GET 以外は 404 で無視して待ち続ける
 * - state が合わないものは断って待ち続ける（別のページから送り込まれた code を使わない）
 * - 受けたら（許可・拒否どちらでも）閉じる。時間切れ・取り消しでも閉じる
 */
import { createServer, type Server } from 'node:http'
import { UserFacingError } from '@shared/errors'
import { escapeHtml } from './markdown'
import { publishText } from './store'

export interface CallbackWaiter {
  /** 待ち受けを始めた（ポートが使えた）とき解決する */
  ready: Promise<void>
  /** 許可されたら code。拒否・時間切れ・取り消しは例外 */
  code: Promise<string>
  cancel: () => void
}

export interface CallbackOptions {
  host: string
  port: number
  path: string
  state: string
  timeoutMs: number
  /** 受けたあとにブラウザに出す文 */
  doneMessage: string
  failedMessage: string
}

function page(message: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Ferret</title></head><body style="font-family:system-ui,sans-serif;padding:48px;text-align:center"><p>${escapeHtml(message)}</p></body></html>`
}

export function waitForCallback(options: CallbackOptions): CallbackWaiter {
  let server: Server | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  let settle: { resolve: (code: string) => void; reject: (err: Error) => void } | null = null
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
  }

  const ready = new Promise<void>((resolve, reject) => {
    server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', `http://${options.host}:${options.port}`)
      if (req.method !== 'GET' || url.pathname !== options.path) {
        res.writeHead(404).end()
        return
      }
      if (url.searchParams.get('state') !== options.state) {
        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' }).end(page(options.failedMessage))
        return
      }
      const error = url.searchParams.get('error')
      const value = url.searchParams.get('code')
      if (error || !value) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(page(options.failedMessage))
        finish(new UserFacingError(publishText('publish.errors.xDenied')))
        return
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(page(options.doneMessage))
      finish(null, value)
    })
    server.once('error', (err: NodeJS.ErrnoException) => {
      const failure = err.code === 'EADDRINUSE'
        ? new UserFacingError(publishText('publish.errors.xPortBusy', { port: options.port }))
        : err
      reject(failure)
      finish(failure)
    })
    server.listen(options.port, options.host, () => {
      timer = setTimeout(() => finish(new UserFacingError(publishText('publish.errors.xTimeout'))), options.timeoutMs)
      resolve()
    })
  })
  ready.catch(() => undefined)

  return { ready, code, cancel: () => finish(new UserFacingError(publishText('publish.errors.xCancelled'))) }
}
