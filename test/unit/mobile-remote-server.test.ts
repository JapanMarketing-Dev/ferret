/**
 * スマホから操作の HTTP の口（src/main/mobileRemote.ts）の結合テスト。
 * 127.0.0.1 の空いたポートで本物のサーバーを開き、偽のターミナル（TerminalManager の代わり）につないで、
 * 合言葉・Host・本文の上限・送信・キー・回数の制限・開け閉め・合言葉の作り直しを確かめる
 */
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createServer, request, type IncomingHttpHeaders, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TuiAgent } from '@shared/types'
import { isWellFormedToken } from '@shared/mobileRemote'
import { MobileRemoteServer, MobileRemoteService, SECURITY_HEADERS, listenErrorKind, type RemoteChecklistItem, type RemoteServerDeps, type RemoteTerminalSource } from '../../src/main/mobileRemote'

const TOKEN = 'T'.repeat(43)

class FakeTerminals implements RemoteTerminalSource {
  sent: Array<[string, string]> = []
  written: Array<[string, string]> = []
  sendResult: { ok: boolean; message: string; submitted?: boolean } = { ok: true, message: 'Sent to Claude Code', submitted: true }
  sendError: Error | null = null
  terminals: Array<{ id: string; cwd: string; title: string; agent: TuiAgent | null }> = [
    { id: 't1', cwd: '/work/shop/src', title: 'Claude Code', agent: 'claude' },
    { id: 't2', cwd: '/tmp/scratch', title: '1: zsh', agent: null }
  ]

  list() { return this.terminals }
  screenText(id: string) { return id === 't1' ? '\x1b[32m> Ready for your next task\x1b[0m   \n\n' : '$ ' }
  async agentStates(ids: readonly string[]) {
    return ids.map((id) => (id === 't1' ? { kind: 'claude-code', state: 'blocked', agent: 'claude' as TuiAgent } : { kind: 'unknown', state: 'unknown', agent: null }))
  }
  async sendReview(id: string, text: string) {
    this.sent.push([id, text])
    if (this.sendError) throw this.sendError
    return this.sendResult
  }
  write(id: string, data: string) { this.written.push([id, data]) }
}

interface Reply { status: number; headers: IncomingHttpHeaders; body: string; json: () => any }

/** fetch は Host を変えられないので node:http で送る（接続は使い回さない） */
function send(port: number, opts: { method?: string; path?: string; token?: string | null; headers?: Record<string, string>; body?: string | Buffer; chunked?: boolean } = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { Host: `127.0.0.1:${port}`, ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}), ...opts.headers }
    if (opts.body !== undefined && !opts.chunked) headers['Content-Length'] = String(Buffer.byteLength(opts.body))
    const req = request({ host: '127.0.0.1', port, method: opts.method ?? 'GET', path: opts.path ?? '/', headers, agent: false }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (c: Buffer) => chunks.push(c))
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8')
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body, json: () => JSON.parse(body) })
      })
    })
    req.on('error', reject)
    if (opts.body !== undefined) {
      if (opts.chunked) {
        // Content-Length を付けずに少しずつ送る
        const buf = Buffer.from(opts.body)
        for (let i = 0; i < buf.length; i += 4096) req.write(buf.subarray(i, i + 4096))
      } else req.write(opts.body)
    }
    req.end()
  })
}

const json = (value: unknown) => ({ body: JSON.stringify(value), headers: { 'Content-Type': 'application/json' } })

async function freePort(): Promise<number> {
  const s = createServer()
  await new Promise<void>((resolve) => s.listen(0, '127.0.0.1', resolve))
  const port = (s.address() as AddressInfo).port
  await new Promise<void>((resolve) => s.close(() => resolve()))
  return port
}

function connectRefused(port: number): Promise<boolean> {
  return send(port).then(() => false, (err: NodeJS.ErrnoException) => err.code === 'ECONNREFUSED')
}

function makeDeps(fake: FakeTerminals, extra: Partial<RemoteServerDeps> = {}): RemoteServerDeps {
  return {
    terminals: () => fake,
    token: () => TOKEN,
    projects: () => [{ name: 'shop', folderPath: '/work/shop' }],
    agentLabel: (agent) => (agent === 'claude' ? 'Claude Code' : String(agent)),
    locale: () => 'ja',
    checklist: async () => [{ key: 'B1', label: 'shop', url: 'https://example.com', note: 'Check the cart', answer: '1. OK' }],
    limiter: { maxFailures: 3, windowMs: 60_000 },
    ...extra
  }
}

describe('MobileRemoteServer', () => {
  let fake: FakeTerminals
  let server: MobileRemoteServer
  let port: number
  let onError: ReturnType<typeof vi.fn<(err: unknown, op: string) => void>>

  beforeEach(async () => {
    fake = new FakeTerminals()
    onError = vi.fn<(err: unknown, op: string) => void>()
    server = new MobileRemoteServer(makeDeps(fake, { onError }))
    await server.start(0, '127.0.0.1')
    port = server.port!
  })

  afterEach(async () => {
    await server.stop()
  })

  it('ページは合言葉なしで返す（秘密を含まない）。守りのヘッダー付き、CORS のヘッダーなし', async () => {
    const res = await send(port)
    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toContain('text/html')
    expect(res.body).toContain('<html lang="ja">')
    expect(res.body).toContain('<script src="/app.js"></script>')
    expect(res.body).not.toContain(TOKEN)
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) expect(res.headers[name.toLowerCase()]).toBe(value)
    expect(res.headers['content-security-policy']).toContain("default-src 'self'")
    expect(res.headers['cache-control']).toBe('no-store')
    expect(res.headers['x-frame-options']).toBe('DENY')
    expect(res.headers['access-control-allow-origin']).toBeUndefined()
  })

  it('JS・CSS・アイコンを型付きで返す。インラインのスクリプトは無い', async () => {
    const js = await send(port, { path: '/app.js' })
    expect(js.status).toBe(200)
    expect(js.headers['content-type']).toContain('text/javascript')
    expect(js.body).toContain("'Authorization': 'Bearer ' + token")
    const css = await send(port, { path: '/app.css' })
    expect(css.headers['content-type']).toContain('text/css')
    expect(css.body).toContain('prefers-color-scheme: dark')
    const icon = await send(port, { path: '/icon.svg' })
    expect(icon.headers['content-type']).toBe('image/svg+xml')
    const page = await send(port)
    expect(page.body).not.toMatch(/<script>(?!<)/)
    expect(page.body).not.toMatch(/<style>/)
  })

  it('ページの言語は Ferret の言語に合わせる', async () => {
    await server.stop()
    server = new MobileRemoteServer(makeDeps(fake, { locale: () => 'en' }))
    await server.start(0, '127.0.0.1')
    const res = await send(server.port!)
    expect(res.body).toContain('<html lang="en">')
    expect(res.body).toContain('Ferret Remote')
  })

  it('HEAD は本文なし', async () => {
    const res = await send(port, { method: 'HEAD' })
    expect(res.status).toBe(200)
    expect(res.body).toBe('')
  })

  it('合言葉なし・違う合言葉・Basic は 401', async () => {
    expect((await send(port, { path: '/api/terminals' })).status).toBe(401)
    const wrong = await send(port, { path: '/api/terminals', token: 'X'.repeat(43) })
    expect(wrong.status).toBe(401)
    expect(wrong.headers['www-authenticate']).toBe('Bearer')
    expect(wrong.body).not.toContain(TOKEN)
    expect((await send(port, { path: '/api/terminals', headers: { Authorization: `Basic ${TOKEN}` } })).status).toBe(401)
  })

  it('合言葉が合えば一覧を返す（プロジェクト名・Agent の名前・状態）', async () => {
    const res = await send(port, { path: '/api/terminals', token: TOKEN })
    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toContain('application/json')
    expect(res.json()).toEqual({ terminals: [
      { id: 't1', title: 'Claude Code', project: 'shop', agent: 'Claude Code', state: 'blocked' },
      { id: 't2', title: '1: zsh', project: 'scratch', agent: '', state: 'unknown' }
    ] })
  })

  it('Host が IP・localhost・*.ts.net 以外なら、合言葉が合っていても断る（DNS rebinding）', async () => {
    for (const host of ['evil.com', `evil.com:${port}`, 'attacker.example:80', `127.0.0.1.nip.io:${port}`]) {
      expect((await send(port, { path: '/api/terminals', token: TOKEN, headers: { Host: host } })).status, host).toBe(403)
      expect((await send(port, { headers: { Host: host } })).status, host).toBe(403)
    }
    expect((await send(port, { path: '/api/terminals', token: TOKEN, headers: { Host: `my-mac.tail1234.ts.net:${port}` } })).status).toBe(200)
    expect((await send(port, { path: '/api/terminals', token: TOKEN, headers: { Host: `localhost:${port}` } })).status).toBe(200)
  })

  it('画面の文字は制御を落として返す', async () => {
    const res = await send(port, { path: '/api/terminals/t1/screen', token: TOKEN })
    expect(res.status).toBe(200)
    expect(res.json()).toEqual({ id: 't1', title: 'Claude Code', project: 'shop', agent: 'Claude Code', state: 'blocked', text: '> Ready for your next task' })
  })

  it('送信は「Agentへ送信」と同じ sendReview に本文を渡す', async () => {
    const res = await send(port, { method: 'POST', path: '/api/terminals/t1/send', token: TOKEN, ...json({ text: '  Please fix the login bug\r\nthanks ' }) })
    expect(res.status).toBe(200)
    expect(res.json()).toEqual({ ok: true, message: 'Sent to Claude Code', submitted: true })
    expect(fake.sent).toEqual([['t1', 'Please fix the login bug\nthanks']])
    expect(fake.written).toEqual([])
  })

  it('sendReview が断れば 409 と理由（確認待ちなど）', async () => {
    fake.sendResult = { ok: false, message: 'The agent is waiting for a confirmation' }
    const res = await send(port, { method: 'POST', path: '/api/terminals/t1/send', token: TOKEN, ...json({ text: 'go' }) })
    expect(res.status).toBe(409)
    expect(res.json()).toEqual({ ok: false, message: 'The agent is waiting for a confirmation' })
  })

  it('sendReview が例外なら 500（中身は返さない）。onError に渡す', async () => {
    fake.sendError = new Error(`boom ${TOKEN}`)
    const res = await send(port, { method: 'POST', path: '/api/terminals/t1/send', token: TOKEN, ...json({ text: 'go' }) })
    expect(res.status).toBe(500)
    expect(res.body).not.toContain('boom')
    expect(onError).toHaveBeenCalledWith(fake.sendError, 'handle request')
  })

  it('空・長すぎ・形の違う本文は 400、JSON でなければ 400', async () => {
    expect((await send(port, { method: 'POST', path: '/api/terminals/t1/send', token: TOKEN, ...json({ text: '   ' }) })).json()).toEqual({ error: 'empty' })
    expect((await send(port, { method: 'POST', path: '/api/terminals/t1/send', token: TOKEN, ...json({ text: 'x'.repeat(8001) }) })).json()).toEqual({ error: 'tooLong' })
    expect((await send(port, { method: 'POST', path: '/api/terminals/t1/send', token: TOKEN, ...json({ message: 'x' }) })).status).toBe(400)
    const bad = await send(port, { method: 'POST', path: '/api/terminals/t1/send', token: TOKEN, body: '{not json', headers: { 'Content-Type': 'application/json' } })
    expect(bad.status).toBe(400)
    expect(bad.json()).toEqual({ error: 'invalidJson' })
    expect(fake.sent).toEqual([])
  })

  it('JSON 以外の Content-Type は 415（フォームからの送信を受けない）', async () => {
    const res = await send(port, { method: 'POST', path: '/api/terminals/t1/send', token: TOKEN, body: 'text=hi', headers: { 'Content-Type': 'application/x-www-form-urlencoded' } })
    expect(res.status).toBe(415)
    expect((await send(port, { method: 'POST', path: '/api/terminals/t1/send', token: TOKEN, body: '{"text":"hi"}' })).status).toBe(415)
    expect((await send(port, { method: 'POST', path: '/api/terminals/t1/send', token: TOKEN, body: '{"text":"hi"}', headers: { 'Content-Type': 'application/json; charset=utf-8' } })).status).toBe(200)
  })

  it('ほかのサイトの Origin からの POST は 403', async () => {
    const res = await send(port, { method: 'POST', path: '/api/terminals/t1/send', token: TOKEN, body: '{"text":"hi"}', headers: { 'Content-Type': 'application/json', Origin: 'http://evil.com' } })
    expect(res.status).toBe(403)
    const same = await send(port, { method: 'POST', path: '/api/terminals/t1/send', token: TOKEN, body: '{"text":"hi"}', headers: { 'Content-Type': 'application/json', Origin: `http://127.0.0.1:${port}` } })
    expect(same.status).toBe(200)
    expect(fake.sent).toEqual([['t1', 'hi']])
  })

  it('本文が上限（16KB）を超えたら 413（Content-Length でも、少しずつ送られても）', async () => {
    const big = JSON.stringify({ text: 'x'.repeat(20_000) })
    const declared = await send(port, { method: 'POST', path: '/api/terminals/t1/send', token: TOKEN, body: big, headers: { 'Content-Type': 'application/json' } })
    expect(declared.status).toBe(413)
    const chunked = await send(port, { method: 'POST', path: '/api/terminals/t1/send', token: TOKEN, body: big, chunked: true, headers: { 'Content-Type': 'application/json' } })
    expect(chunked.status).toBe(413)
    expect(fake.sent).toEqual([])
    // ちょうど上限の手前は通る（中の文字は上限で断られる）
    const near = JSON.stringify({ text: 'y'.repeat(16 * 1024 - 20) })
    expect((await send(port, { method: 'POST', path: '/api/terminals/t1/send', token: TOKEN, body: near, headers: { 'Content-Type': 'application/json' } })).status).toBe(400)
  })

  it('キーは決めた列だけを write する（Ctrl+C・Enter・↑・1）', async () => {
    for (const key of ['ctrl-c', 'enter', 'up', '1']) {
      expect((await send(port, { method: 'POST', path: '/api/terminals/t2/key', token: TOKEN, ...json({ key }) })).status).toBe(200)
    }
    expect(fake.written).toEqual([['t2', '\x03'], ['t2', '\r'], ['t2', '\x1b[A'], ['t2', '1']])
    const bad = await send(port, { method: 'POST', path: '/api/terminals/t2/key', token: TOKEN, ...json({ key: '\x04' }) })
    expect(bad.status).toBe(400)
    expect(fake.written).toHaveLength(4)
  })

  it('知らないターミナルは 404（画面・送信・キー）', async () => {
    expect((await send(port, { path: '/api/terminals/t99/screen', token: TOKEN })).status).toBe(404)
    expect((await send(port, { method: 'POST', path: '/api/terminals/t99/send', token: TOKEN, ...json({ text: 'hi' }) })).status).toBe(404)
    expect((await send(port, { method: 'POST', path: '/api/terminals/t99/key', token: TOKEN, ...json({ key: 'enter' }) })).status).toBe(404)
    expect(fake.sent).toEqual([])
    expect(fake.written).toEqual([])
  })

  it('知らない道は 404・メソッドの違いは 405（どちらも合言葉の前）', async () => {
    expect((await send(port, { path: '/nope' })).status).toBe(404)
    expect((await send(port, { path: '/api/terminals/../../etc/passwd', token: TOKEN })).status).toBe(404)
    const wrong = await send(port, { method: 'DELETE', path: '/api/terminals' })
    expect(wrong.status).toBe(405)
    expect(wrong.headers.allow).toBe('GET, POST')
    expect((await send(port, { method: 'OPTIONS', path: '/api/terminals' })).headers['access-control-allow-origin']).toBeUndefined()
  })

  it('合言葉の誤りが続いたら、正しい合言葉でもしばらく 429', async () => {
    for (let i = 0; i < 3; i++) expect((await send(port, { path: '/api/terminals', token: 'W'.repeat(43) })).status).toBe(401)
    const blocked = await send(port, { path: '/api/terminals', token: TOKEN })
    expect(blocked.status).toBe(429)
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0)
    expect((await send(port, { method: 'POST', path: '/api/terminals/t1/send', token: TOKEN, ...json({ text: 'hi' }) })).status).toBe(429)
    expect(fake.sent).toEqual([])
    // ページは止めない（合言葉を使わない）
    expect((await send(port)).status).toBe(200)
  })

  it('窓が過ぎれば、また受け付ける', async () => {
    await server.stop()
    let now = 1_000
    server = new MobileRemoteServer(makeDeps(fake, { limiter: { maxFailures: 2, windowMs: 10_000 } }), () => now)
    await server.start(0, '127.0.0.1')
    const p = server.port!
    await send(p, { path: '/api/terminals', token: 'bad' })
    await send(p, { path: '/api/terminals', token: 'bad' })
    expect((await send(p, { path: '/api/terminals', token: TOKEN })).status).toBe(429)
    now += 10_000
    expect((await send(p, { path: '/api/terminals', token: TOKEN })).status).toBe(200)
  })

  it('正しい合言葉で数え直す（ときどきの打ち間違いでは止めない）', async () => {
    await send(port, { path: '/api/terminals', token: 'bad' })
    await send(port, { path: '/api/terminals', token: 'bad' })
    expect((await send(port, { path: '/api/terminals', token: TOKEN })).status).toBe(200)
    await send(port, { path: '/api/terminals', token: 'bad' })
    await send(port, { path: '/api/terminals', token: 'bad' })
    expect((await send(port, { path: '/api/terminals', token: TOKEN })).status).toBe(200)
  })

  it('human.md の確認の一覧（読むだけ）。読めなければ空で onError', async () => {
    const res = await send(port, { path: '/api/checklist', token: TOKEN })
    expect(res.json()).toEqual({ items: [{ key: 'B1', label: 'shop', url: 'https://example.com', note: 'Check the cart', answer: '1. OK' }] })
    expect((await send(port, { path: '/api/checklist' })).status).toBe(401)
    await server.stop()
    const failing = vi.fn()
    server = new MobileRemoteServer(makeDeps(fake, { onError: failing, checklist: async (): Promise<RemoteChecklistItem[]> => { throw new Error('read fail') } }))
    await server.start(0, '127.0.0.1')
    expect((await send(server.port!, { path: '/api/checklist', token: TOKEN })).json()).toEqual({ items: [] })
    expect(failing).toHaveBeenCalledWith(expect.any(Error), 'read checklist')
  })

  it('ターミナルの用意ができる前は 503', async () => {
    await server.stop()
    server = new MobileRemoteServer(makeDeps(fake, { terminals: () => null }))
    await server.start(0, '127.0.0.1')
    expect((await send(server.port!, { path: '/api/terminals', token: TOKEN })).status).toBe(503)
  })

  it('合言葉は要求のたびに読む（取り替えたら次の要求から効く）', async () => {
    await server.stop()
    let token = TOKEN
    server = new MobileRemoteServer(makeDeps(fake, { token: () => token }))
    await server.start(0, '127.0.0.1')
    const p = server.port!
    expect((await send(p, { path: '/api/terminals', token: TOKEN })).status).toBe(200)
    token = 'N'.repeat(43)
    expect((await send(p, { path: '/api/terminals', token: TOKEN })).status).toBe(401)
    expect((await send(p, { path: '/api/terminals', token })).status).toBe(200)
  })

  it('閉じたらポートが空く（つながったままの接続も切る）', async () => {
    const p = port
    expect((await send(p)).status).toBe(200)
    await server.stop()
    expect(server.port).toBeNull()
    expect(await connectRefused(p)).toBe(true)
    // 二度閉じても例外にならない
    await server.stop()
  })
})

describe('MobileRemoteService', () => {
  let dir: string
  let fake: FakeTerminals
  const interfaces = () => ({
    en0: [{ address: '192.168.1.23', family: 'IPv4', internal: false }],
    utun4: [{ address: '100.101.102.103', family: 'IPv4', internal: false }],
    lo0: [{ address: '127.0.0.1', family: 'IPv4', internal: true }]
  })
  const services: MobileRemoteService[] = []
  const make = (extra: Partial<ConstructorParameters<typeof MobileRemoteService>[0]> = {}) => {
    const { token: _token, ...deps } = makeDeps(fake)
    const service = new MobileRemoteService({ tokenFile: join(dir, 'mobile-remote-token'), deps, interfaces, host: '127.0.0.1', ...extra })
    services.push(service)
    return service
  }

  beforeAll(() => { dir = mkdtempSync(join(tmpdir(), 'ferret-remote-')) })
  afterAll(() => rmSync(dir, { recursive: true, force: true }))
  beforeEach(() => {
    fake = new FakeTerminals()
    rmSync(join(dir, 'mobile-remote-token'), { force: true })
  })
  afterEach(async () => {
    await Promise.all(services.splice(0).map((s) => s.stop()))
  })

  it('既定（未設定）は開かない', async () => {
    const service = make()
    const state = await service.apply(undefined)
    expect(state).toEqual({ enabled: false, port: 47615, running: false, urls: [], qr: null, error: null })
  })

  it('入れると開き、合言葉を所有者だけが読めるファイルに作り、URL と QR を返す', async () => {
    const port = await freePort()
    const onChange = vi.fn()
    const service = make({ onChange })
    const state = await service.apply({ enabled: true, port })
    expect(state.running).toBe(true)
    expect(state.error).toBeNull()
    const token = readFileSync(join(dir, 'mobile-remote-token'), 'utf8').trim()
    expect(isWellFormedToken(token)).toBe(true)
    if (process.platform !== 'win32') expect(statSync(join(dir, 'mobile-remote-token')).mode & 0o777).toBe(0o600)
    expect(state.urls).toEqual([`http://192.168.1.23:${port}/#t=${token}`, `http://100.101.102.103:${port}/#t=${token}`])
    expect(state.qr?.size).toBeGreaterThan(21)
    expect(state.qr?.path).toMatch(/^M\d+ \d+h\d+v1h-\d+z/)
    expect(onChange).toHaveBeenLastCalledWith(state)
    expect((await send(port, { path: '/api/terminals', token })).status).toBe(200)
  })

  it('保存した合言葉を次の起動でも使う（ブックマークが使える）。壊れていれば作り直す', async () => {
    const port = await freePort()
    const first = make()
    const a = await first.apply({ enabled: true, port })
    await first.stop()
    const second = make()
    const b = await second.apply({ enabled: true, port })
    expect(b.urls[0]).toBe(a.urls[0])
    await second.stop()
    writeFileSync(join(dir, 'mobile-remote-token'), 'short\n')
    const third = make()
    const c = await third.apply({ enabled: true, port })
    expect(c.urls[0]).not.toBe(a.urls[0])
    expect(isWellFormedToken(readFileSync(join(dir, 'mobile-remote-token'), 'utf8').trim())).toBe(true)
  })

  it('切ったらポートを閉じる', async () => {
    const port = await freePort()
    const service = make()
    await service.apply({ enabled: true, port })
    expect((await send(port)).status).toBe(200)
    const state = await service.apply({ enabled: false, port })
    expect(state.running).toBe(false)
    expect(state.urls).toEqual([])
    expect(await connectRefused(port)).toBe(true)
  })

  it('ポートを変えたら開き直す', async () => {
    const [p1, p2] = [await freePort(), await freePort()]
    const service = make()
    await service.apply({ enabled: true, port: p1 })
    const state = await service.apply({ enabled: true, port: p2 })
    expect(state.port).toBe(p2)
    expect(await connectRefused(p1)).toBe(true)
    expect((await send(p2)).status).toBe(200)
  })

  it('ポートが使われていれば portInUse を返し、落ちない。空けば開ける', async () => {
    const blocker: Server = createServer()
    await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', resolve))
    const port = (blocker.address() as AddressInfo).port
    const service = make()
    const state = await service.apply({ enabled: true, port })
    expect(state).toMatchObject({ enabled: true, running: false, error: 'portInUse', urls: [], qr: null })
    await new Promise<void>((resolve) => blocker.close(() => resolve()))
    const retry = await service.apply({ enabled: true, port })
    expect(retry).toMatchObject({ running: true, error: null })
  })

  it('リンクを作り直すと、古い合言葉は 401・新しいものは 200', async () => {
    const port = await freePort()
    const service = make()
    const before = await service.apply({ enabled: true, port })
    const oldToken = before.urls[0]!.split('#t=')[1]!
    const after = await service.resetToken()
    const newToken = after.urls[0]!.split('#t=')[1]!
    expect(newToken).not.toBe(oldToken)
    expect(after.qr?.path).not.toBe(before.qr?.path)
    expect((await send(port, { path: '/api/terminals', token: oldToken })).status).toBe(401)
    expect((await send(port, { path: '/api/terminals', token: newToken })).status).toBe(200)
    expect(readFileSync(join(dir, 'mobile-remote-token'), 'utf8').trim()).toBe(newToken)
  })

  it('続けて切り替えても順に処理し、最後の設定どおりになる', async () => {
    const port = await freePort()
    const service = make()
    const [, , last] = await Promise.all([service.apply({ enabled: true, port }), service.apply({ enabled: false, port }), service.apply({ enabled: true, port })])
    expect(last.running).toBe(true)
    const off = await Promise.all([service.apply({ enabled: true, port }), service.apply({ enabled: false, port })])
    expect(off[1].running).toBe(false)
    expect(await connectRefused(port)).toBe(true)
  })

  it('アドレスが無ければ URL も QR も空（待ち受けは続ける）', async () => {
    const port = await freePort()
    const service = make({ interfaces: () => ({ lo0: [{ address: '127.0.0.1', family: 'IPv4', internal: true }] }) })
    const state = await service.apply({ enabled: true, port })
    expect(state).toMatchObject({ running: true, urls: [], qr: null })
  })

  it('合言葉を保存できなければ開かない（failed）', async () => {
    const onError = vi.fn()
    const { token: _token, ...deps } = makeDeps(fake, { onError })
    // ファイルを置くべき所がファイル（フォルダを作れない）
    writeFileSync(join(dir, 'not-a-dir'), 'x')
    const service = new MobileRemoteService({ tokenFile: join(dir, 'not-a-dir', 'token'), deps, interfaces, host: '127.0.0.1' })
    services.push(service)
    const state = await service.apply({ enabled: true, port: await freePort() })
    expect(state).toMatchObject({ running: false, error: 'failed' })
    expect(onError).toHaveBeenCalledWith(expect.anything(), 'save token')
  })

  it('開けなかった理由の分類', () => {
    expect(listenErrorKind(Object.assign(new Error('x'), { code: 'EADDRINUSE' }))).toBe('portInUse')
    expect(listenErrorKind(Object.assign(new Error('x'), { code: 'EACCES' }))).toBe('permission')
    expect(listenErrorKind(Object.assign(new Error('x'), { code: 'EPERM' }))).toBe('permission')
    expect(listenErrorKind(new Error('x'))).toBe('failed')
    expect(listenErrorKind(null)).toBe('failed')
  })
})
