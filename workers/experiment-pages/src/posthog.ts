import type { Env } from './env'

export interface PosthogConfig {
  key: string
  /** 送信先（api_host）のオリジン */
  apiHost: string
  /** array.js を読み込むオリジン */
  assetsOrigin: string
  /** CSP で許可するオリジン（重複なし） */
  origins: string[]
}

const KEY_PATTERN = /^[A-Za-z0-9_-]{8,128}$/

/**
 * POSTHOG_KEY と POSTHOG_HOST がそろって正しい形のときだけ有効にする。
 * PostHog Cloud（us.i.posthog.com / eu.i.posthog.com）は配信元が *-assets.i.posthog.com に分かれるため、
 * その組だけ追加で許可する。それ以外（自前のリバースプロキシなど）は指定ホストだけを許可する。
 */
export function resolvePosthog(env: Pick<Env, 'POSTHOG_KEY' | 'POSTHOG_HOST'>): PosthogConfig | null {
  const key = env.POSTHOG_KEY?.trim() ?? ''
  const host = env.POSTHOG_HOST?.trim() ?? ''
  if (!key || !host) return null
  if (!KEY_PATTERN.test(key)) return null
  let url: URL
  try {
    url = new URL(host)
  } catch {
    return null
  }
  if (url.protocol !== 'https:' || url.username || url.password) return null
  if ((url.pathname !== '/' && url.pathname !== '') || url.search || url.hash) return null
  const apiHost = url.origin
  const cloud = /^(us|eu)\.i\.posthog\.com$/.exec(url.hostname)
  const assetsOrigin = cloud ? `https://${cloud[1]}-assets.i.posthog.com` : apiHost
  const origins = [...new Set([apiHost, assetsOrigin])]
  return { key, apiHost, assetsOrigin, origins }
}
