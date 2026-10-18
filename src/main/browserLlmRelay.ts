import type { IncomingMessage, ServerResponse } from 'node:http'
import { Readable } from 'node:stream'

/**
 * browser-use の Agent（API で動かすとき）の LLM の呼び出しを、Ferret が保存したキーで送り直す中継（browserCdp.ts の口の下）。
 *
 *   GET  /<合言葉>/llm/providers          → キーのある（またはキーの要らない端末内の）接続先と既定のモデル
 *   ANY  /<合言葉>/llm/<接続先>/<残り>     → <接続先の baseUrl>/<残り> へ。キーのヘッダーは中継が付け、受け取ったキーのヘッダーは捨てる
 *
 * キーはターミナル・環境変数・browser-use の側に出ない（判定モデルの中継と同じ考え方）。応答は状態コードも本文もそのまま流す（SSE も）。
 * 接続先は下の表に限る（任意の URL へは送らない）。
 */

export type RelayKind = 'openai-chat' | 'anthropic-messages'

export interface RelayProvider {
  id: string
  label: string
  kind: RelayKind
  baseUrl: string
  model: string
  /** キーが要らない（端末内のモデル） */
  local?: boolean
}

/** browser-use の ChatOpenAI・ChatAnthropic の base_url で使える接続先（Gemini は Google の OpenAI 互換の口） */
export const RELAY_PROVIDERS: readonly RelayProvider[] = [
  { id: 'anthropic', label: 'Anthropic', kind: 'anthropic-messages', baseUrl: 'https://api.anthropic.com', model: 'claude-sonnet-5-5' },
  { id: 'openai', label: 'OpenAI', kind: 'openai-chat', baseUrl: 'https://api.openai.com/v1', model: 'gpt-6.1-sol' },
  { id: 'gemini', label: 'Google Gemini', kind: 'openai-chat', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', model: 'gemini-3.8-flash' },
  { id: 'openrouter', label: 'OpenRouter', kind: 'openai-chat', baseUrl: 'https://openrouter.ai/api/v1', model: 'anthropic/claude-sonnet-5.5' },
  { id: 'vercel-gateway', label: 'Vercel AI Gateway', kind: 'openai-chat', baseUrl: 'https://ai-gateway.vercel.sh/v1', model: 'anthropic/claude-sonnet-5.5' },
  { id: 'ollama', label: 'Ollama', kind: 'openai-chat', baseUrl: 'http://localhost:11434/v1', model: 'gpt-oss:20b', local: true },
  { id: 'lmstudio', label: 'LM Studio', kind: 'openai-chat', baseUrl: 'http://localhost:1234/v1', model: '', local: true }
]

export interface LlmRelayDeps {
  /** その接続先のキー（無ければ undefined）。値は記録・エラーに出さない */
  key(providerId: string): Promise<string | undefined>
  fetch?: typeof fetch
}

/** 送り直す要求のヘッダー（キー・Cookie・接続の制御は渡さない） */
const PASS_REQUEST_HEADERS = ['content-type', 'accept', 'anthropic-version', 'anthropic-beta', 'openai-beta', 'user-agent']
/** 返す応答のヘッダー */
const PASS_RESPONSE_HEADERS = ['content-type', 'cache-control', 'retry-after', 'x-request-id', 'request-id']
const MAX_BODY_BYTES = 32 * 1024 * 1024

function authHeaders(provider: RelayProvider, key: string): Record<string, string> {
  return provider.kind === 'anthropic-messages' ? { 'x-api-key': key } : { authorization: `Bearer ${key}` }
}

async function readBody(req: IncomingMessage): Promise<Buffer | null> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string)
    size += buf.length
    if (size > MAX_BODY_BYTES) return null
    chunks.push(buf)
  }
  return Buffer.concat(chunks)
}

export class LlmRelay {
  constructor(private readonly deps: LlmRelayDeps) {}

  /** 使える接続先（キーのあるもの・端末内のもの）。順番は上の表のとおり（先頭が既定） */
  async available(): Promise<Array<Pick<RelayProvider, 'id' | 'label' | 'kind' | 'model'>>> {
    const out: Array<Pick<RelayProvider, 'id' | 'label' | 'kind' | 'model'>> = []
    for (const p of RELAY_PROVIDERS) {
      if (p.local || (await this.deps.key(p.id).catch(() => undefined))) out.push({ id: p.id, label: p.label, kind: p.kind, model: p.model })
    }
    return out
  }

  /** path は合言葉を外したあとの /llm/... */
  async handle(path: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
    const json = (status: number, body: unknown): void => {
      if (res.headersSent) {
        res.end()
        return
      }
      res.writeHead(status, { 'Content-Type': 'application/json; charset=UTF-8', 'Cache-Control': 'no-store' })
      res.end(JSON.stringify(body))
    }
    if (path === '/llm/providers') {
      if (req.method !== 'GET') return json(405, { error: 'method not allowed' })
      return json(200, { providers: await this.available() })
    }
    const match = /^\/llm\/([a-z-]+)(\/.*)?$/.exec(path)
    const provider = match ? RELAY_PROVIDERS.find((p) => p.id === match[1]) : undefined
    if (!match || !provider) return json(404, { error: 'unknown provider' })
    const rest = match[2] ?? '/'
    if (rest.includes('..')) return json(400, { error: 'bad path' })
    const key = provider.local ? undefined : await this.deps.key(provider.id).catch(() => undefined)
    if (!provider.local && !key) return json(401, { error: `No API key for ${provider.label} in Ferret. Add it in Ferret's settings (AI keys), or use a subscription agent instead.` })
    const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : await readBody(req)
    if (body === null) return json(413, { error: 'request too large' })
    const headers: Record<string, string> = {}
    for (const name of PASS_REQUEST_HEADERS) {
      const value = req.headers[name]
      if (typeof value === 'string') headers[name] = value
    }
    if (key) Object.assign(headers, authHeaders(provider, key))
    const query = (req.url ?? '').includes('?') ? (req.url ?? '').slice((req.url ?? '').indexOf('?')) : ''
    const doFetch = this.deps.fetch ?? fetch
    let upstream: Response
    try {
      upstream = await doFetch(`${provider.baseUrl}${rest}${query}`, { method: req.method ?? 'POST', headers, ...(body ? { body: new Uint8Array(body) } : {}) })
    } catch {
      return json(502, { error: `Could not reach ${provider.label}` })
    }
    const out: Record<string, string> = {}
    for (const name of PASS_RESPONSE_HEADERS) {
      const value = upstream.headers.get(name)
      if (value) out[name] = value
    }
    res.writeHead(upstream.status, out)
    if (!upstream.body) return void res.end()
    Readable.fromWeb(upstream.body as import('node:stream/web').ReadableStream).on('error', () => res.destroy()).pipe(res)
  }
}
