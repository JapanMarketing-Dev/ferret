const BOT_UA =
  /bot|crawl|spider|slurp|scrap|facebookexternalhit|embedly|preview|headless|lighthouse|pagespeed|pingdom|uptime|monitor|curl|wget|python|httpclient|http-client|okhttp|go-http|axios|node-fetch|undici|java\/|libwww|phantomjs|selenium|puppeteer|playwright/i

/** UA が空、または明らかなボット・自動化ツールなら true */
export function isBot(userAgent: string | null): boolean {
  if (!userAgent || userAgent.trim().length < 8) return true
  return BOT_UA.test(userAgent)
}

export function clientIp(request: Request): string {
  return request.headers.get('CF-Connecting-IP') ?? 'unknown'
}

/**
 * 同一オリジンからの送信かどうか（CSRF 対策）。
 * - Sec-Fetch-Site があれば same-origin のときだけ通す。
 * - Origin があり "null" でなければ自分のオリジンと一致するときだけ通す。
 *   （Referrer-Policy: no-referrer のページからのフォーム POST は Origin が "null" になるため、
 *   その場合は Sec-Fetch-Site で判断する）
 * - どちらの手がかりもなければ拒否する。
 */
export function isSameOriginRequest(request: Request): boolean {
  const site = request.headers.get('Sec-Fetch-Site')
  const origin = request.headers.get('Origin')
  const self = new URL(request.url).origin
  if (site !== null && site !== 'same-origin') return false
  if (origin !== null && origin !== 'null' && origin !== self) return false
  if (site === null && (origin === null || origin === 'null')) return false
  return true
}
