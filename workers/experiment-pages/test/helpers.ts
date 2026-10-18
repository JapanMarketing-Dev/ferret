import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { handleFetch } from '../src/app'
import type { PageContent, PutPageRequest } from '../src/contract'
import type { Env } from '../src/env'
import worker from '../src/index'
import { TEST_ADMIN_TOKEN } from './constants'

export const ORIGIN = 'https://pages.example.com'
export const CHROME_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36'

export interface SendOptions {
  env?: Partial<Env>
  /** 指定すると時刻を固定して handleFetch を直接呼ぶ（Sentry ラッパーを通らない） */
  now?: Date
}

export async function send(path: string, init: RequestInit = {}, opts: SendOptions = {}): Promise<Response> {
  const request = new Request(new URL(path, ORIGIN), init)
  const ctx = createExecutionContext()
  const e = { ...env, ...opts.env } as Env
  const res = opts.now
    ? await handleFetch(request, e, ctx, opts.now)
    : await (worker as Required<Pick<ExportedHandler<Env>, 'fetch'>>).fetch(
        request as Request<unknown, IncomingRequestCfProperties>,
        e,
        ctx,
      )
  await waitOnExecutionContext(ctx)
  return res
}

export function adminHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { Authorization: `Bearer ${TEST_ADMIN_TOKEN}`, ...extra }
}

export function admin(
  path: string,
  init: { method?: string; body?: unknown; headers?: Record<string, string> } = {},
  opts: SendOptions = {},
): Promise<Response> {
  const headers = adminHeaders(init.headers)
  let body: string | undefined
  if (init.body !== undefined) {
    body = typeof init.body === 'string' ? init.body : JSON.stringify(init.body)
    if (!('Content-Type' in headers)) headers['Content-Type'] = 'application/json'
  }
  return send(path, { method: init.method ?? 'GET', headers, body }, opts)
}

export function sampleContent(overrides: Partial<PageContent> = {}): PageContent {
  return {
    headline: '請求書の突合を 1 日から 10 分に',
    subhead: '経理担当者 1 人でも回せる月末処理',
    bullets: ['銀行明細を自動で取り込み', '差異だけを一覧に表示', 'freee と連携'],
    priceText: '月額 9,800 円（税別）',
    ctaLabel: '先行利用を申し込む',
    formIntro: '先行利用の案内をメールでお送りします。',
    consentText: '入力内容を本件の連絡のためだけに使うことに同意します。',
    footerNote: '運営: 株式会社サンプル',
    ...overrides,
  }
}

export function samplePage(overrides: Partial<PutPageRequest> = {}): PutPageRequest {
  return {
    experimentId: 'X01',
    title: '突合サービス（先行利用）',
    content: sampleContent(),
    status: 'published',
    ...overrides,
  }
}

export async function createPage(slug: string, overrides: Partial<PutPageRequest> = {}): Promise<Response> {
  const res = await admin(`/api/pages/${slug}`, { method: 'PUT', body: samplePage(overrides) })
  if (res.status !== 200 && res.status !== 201) throw new Error(`createPage failed: ${res.status} ${await res.text()}`)
  return res
}

export function browserHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return {
    'User-Agent': CHROME_UA,
    'CF-Connecting-IP': '203.0.113.10',
    'Sec-Fetch-Site': 'same-origin',
    Origin: 'null',
    ...extra,
  }
}

export function interestBody(fields: Record<string, string> = {}): string {
  return new URLSearchParams({
    name: '山田 太郎',
    company: '株式会社テスト',
    email: 'taro@example.com',
    message: '詳しく知りたいです',
    consent: 'yes',
    website: '',
    ...fields,
  }).toString()
}

export function postInterest(
  slug: string,
  body: string = interestBody(),
  headers: Record<string, string> = {},
  opts: SendOptions = {},
): Promise<Response> {
  return send(
    `/p/${slug}/interest`,
    {
      method: 'POST',
      headers: browserHeaders({ 'Content-Type': 'application/x-www-form-urlencoded', ...headers }),
      body,
    },
    opts,
  )
}

export async function countRows(table: string): Promise<number> {
  const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>()
  return row?.n ?? 0
}
