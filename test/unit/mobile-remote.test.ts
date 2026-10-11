/**
 * スマホから操作の守りの決まり（src/shared/mobileRemote.ts）。合言葉・Host・Origin・回数の制限・URL・道・本文・画面の文字・設定の読み込み
 */
import { describe, expect, it, vi } from 'vitest'
vi.mock('electron', () => ({ app: { getPath: () => '/tmp/ade-mobile-remote-unit' } }))
import {
  FailureLimiter,
  MOBILE_REMOTE_DEFAULT_PORT,
  MOBILE_REMOTE_MAX_SCREEN,
  MOBILE_REMOTE_MAX_TEXT,
  REMOTE_KEYS,
  bearerToken,
  cleanScreenText,
  hostName,
  isAllowedHost,
  isIPv4,
  isPrivateLanIPv4,
  isRemoteKey,
  isSameOrigin,
  isTailscaleIPv4,
  isValidPort,
  isWellFormedToken,
  normalizeAgentState,
  parseKeyBody,
  parseSendBody,
  projectNameFor,
  reachableIPv4s,
  remotePort,
  remoteUrl,
  remoteUrls,
  routeRequest,
  sanitizeMobileRemotePrefs,
  tokenFromBytes,
  tokensEqual
} from '@shared/mobileRemote'
import { sanitize } from '../../src/main/settings'
import { splitSettings } from '../../src/main/settingsFile'
import { SETTINGS_SCHEMA, validateAgainstSchema } from '@shared/settingsSchema'

const TOKEN = 'A'.repeat(43)

describe('合言葉', () => {
  it('32 バイトから base64url の 43 文字（+ / = を含まない）', () => {
    const all = tokenFromBytes(new Uint8Array(32).fill(0xff))
    expect(all).toHaveLength(43)
    expect(all).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(all).not.toMatch(/[+/=]/)
    expect(isWellFormedToken(all)).toBe(true)
    expect(tokenFromBytes(new Uint8Array(32))).toBe('A'.repeat(43))
    const mixed = tokenFromBytes(Uint8Array.from({ length: 32 }, (_, i) => (i * 37 + 251) & 0xff))
    expect(isWellFormedToken(mixed)).toBe(true)
  })

  it('32 バイト以外は例外（短い乱数で弱い合言葉を作らない）', () => {
    expect(() => tokenFromBytes(new Uint8Array(31))).toThrow(RangeError)
    expect(() => tokenFromBytes(new Uint8Array(33))).toThrow(RangeError)
    expect(() => tokenFromBytes(new Uint8Array(0))).toThrow(RangeError)
  })

  it('形の確かめ: 43 文字の base64url だけ', () => {
    expect(isWellFormedToken(TOKEN)).toBe(true)
    expect(isWellFormedToken('A'.repeat(42))).toBe(false)
    expect(isWellFormedToken('A'.repeat(44))).toBe(false)
    expect(isWellFormedToken('A'.repeat(42) + '=')).toBe(false)
    expect(isWellFormedToken('A'.repeat(42) + '/')).toBe(false)
    expect(isWellFormedToken('A'.repeat(42) + '\n')).toBe(false)
    expect(isWellFormedToken('')).toBe(false)
    expect(isWellFormedToken(null)).toBe(false)
    expect(isWellFormedToken(123)).toBe(false)
  })

  it('比べる: 同じなら true、1 文字・長さ・空の違いは false', () => {
    expect(tokensEqual(TOKEN, TOKEN)).toBe(true)
    expect(tokensEqual(TOKEN, 'A'.repeat(42) + 'B')).toBe(false)
    expect(tokensEqual(TOKEN, 'B' + 'A'.repeat(42))).toBe(false)
    expect(tokensEqual(TOKEN, TOKEN + 'A')).toBe(false)
    expect(tokensEqual(TOKEN, TOKEN.slice(1))).toBe(false)
    expect(tokensEqual('', TOKEN)).toBe(false)
    expect(tokensEqual(TOKEN, '')).toBe(false)
    expect(tokensEqual('', '')).toBe(true)
    // 前半が一致するだけの文字列でも通さない
    expect(tokensEqual(TOKEN, TOKEN.slice(0, 20))).toBe(false)
    expect(tokensEqual(undefined as unknown as string, TOKEN)).toBe(false)
  })

  it('Bearer の値を取り出す（大文字小文字・前後の空白）。形が違えば null', () => {
    expect(bearerToken(`Bearer ${TOKEN}`)).toBe(TOKEN)
    expect(bearerToken(`bearer ${TOKEN}`)).toBe(TOKEN)
    expect(bearerToken(`Bearer   ${TOKEN}  `)).toBe(TOKEN)
    expect(bearerToken(`Basic ${TOKEN}`)).toBeNull()
    expect(bearerToken('Bearer')).toBeNull()
    expect(bearerToken('Bearer ')).toBeNull()
    expect(bearerToken(`Bearer ${TOKEN} extra`)).toBeNull()
    expect(bearerToken(TOKEN)).toBeNull()
    expect(bearerToken(undefined)).toBeNull()
    expect(bearerToken(['Bearer x'])).toBeNull()
  })
})

describe('Host（DNS rebinding の対策）', () => {
  it('IP の直書き・localhost・*.ts.net は受ける（ポート付きでも）', () => {
    for (const host of ['192.168.1.5:47615', '192.168.1.5', '10.0.0.2:80', '100.101.102.103:47615', '127.0.0.1:47615', 'localhost:47615', 'LOCALHOST',
      'my-mac.tail1234.ts.net:47615', 'my-mac.tail1234.ts.net', 'MY-MAC.TAIL1234.TS.NET', 'my-mac.tail1234.ts.net.', '[::1]:47615', '[fe80::1]', '[::ffff:192.168.1.5]:80']) {
      expect(isAllowedHost(host), host).toBe(true)
    }
  })

  it('ほかの名前・壊れた値は断る', () => {
    for (const host of ['evil.com', 'evil.com:47615', 'ts.net', 'evil-ts.net', 'my-mac.ts.net.evil.com', 'tail.ts.net@evil.com', 'localhost.evil.com', '192.168.1.5.nip.io',
      '1.2.3', '1.2.3.4.5', '256.1.1.1', '01.2.3.4', '0x7f.0.0.1', '', ' ', 'a b', '[::1', 'host:port:extra', '192.168.1.5:', 'x'.repeat(300)]) {
      expect(isAllowedHost(host), host).toBe(false)
    }
    expect(isAllowedHost(undefined)).toBe(false)
  })

  it('hostName はポートを外して小文字に', () => {
    expect(hostName('Example.TS.net:80')).toBe('example.ts.net')
    expect(hostName('[FE80::1]:47615')).toBe('[fe80::1]')
    expect(hostName('')).toBeNull()
    expect(hostName('a:99999999')).toBeNull()
  })

  it('IPv4 は 10 進の4つ組だけ', () => {
    expect(isIPv4('0.0.0.0')).toBe(true)
    expect(isIPv4('255.255.255.255')).toBe(true)
    expect(isIPv4('256.0.0.0')).toBe(false)
    expect(isIPv4('1.2.3.04')).toBe(false)
    expect(isIPv4('1.2.3.4 ')).toBe(false)
  })
})

describe('Origin', () => {
  it('無ければ通す・同じ host:port なら通す', () => {
    expect(isSameOrigin(undefined, '192.168.1.5:47615')).toBe(true)
    expect(isSameOrigin('http://192.168.1.5:47615', '192.168.1.5:47615')).toBe(true)
    expect(isSameOrigin('http://my.tail.ts.net:47615', 'MY.tail.ts.net:47615')).toBe(true)
  })

  it('ほかのサイト・ポート違い・https・壊れた値・null は断る', () => {
    expect(isSameOrigin('http://evil.com', '192.168.1.5:47615')).toBe(false)
    expect(isSameOrigin('http://192.168.1.5:9999', '192.168.1.5:47615')).toBe(false)
    expect(isSameOrigin('https://192.168.1.5:47615', '192.168.1.5:47615')).toBe(false)
    expect(isSameOrigin('null', '192.168.1.5:47615')).toBe(false)
    expect(isSameOrigin('not a url', '192.168.1.5:47615')).toBe(false)
    expect(isSameOrigin('http://192.168.1.5:47615', undefined)).toBe(false)
  })
})

describe('合言葉の誤りの制限', () => {
  const make = (max = 3, windowMs = 1000) => {
    let now = 0
    const limiter = new FailureLimiter({ maxFailures: max, windowMs }, () => now)
    return { limiter, advance: (ms: number) => { now += ms } }
  }

  it('上限の手前までは止めない・上限で止める', () => {
    const { limiter } = make()
    limiter.fail('ip')
    limiter.fail('ip')
    expect(limiter.blockedFor('ip')).toBe(0)
    limiter.fail('ip')
    expect(limiter.blockedFor('ip')).toBe(1000)
  })

  it('窓が過ぎれば止めるのをやめて数え直す', () => {
    const { limiter, advance } = make()
    for (let i = 0; i < 3; i++) limiter.fail('ip')
    advance(999)
    expect(limiter.blockedFor('ip')).toBe(1)
    advance(1)
    expect(limiter.blockedFor('ip')).toBe(0)
    limiter.fail('ip')
    expect(limiter.blockedFor('ip')).toBe(0)
  })

  it('窓の外の誤りは前の分と合わせない', () => {
    const { limiter, advance } = make()
    limiter.fail('ip')
    limiter.fail('ip')
    advance(1000)
    limiter.fail('ip')
    expect(limiter.blockedFor('ip')).toBe(0)
  })

  it('相手ごとに数える・成功で数え直す', () => {
    const { limiter } = make()
    for (let i = 0; i < 3; i++) limiter.fail('a')
    expect(limiter.blockedFor('a')).toBeGreaterThan(0)
    expect(limiter.blockedFor('b')).toBe(0)
    limiter.fail('b')
    limiter.fail('b')
    limiter.succeed('b')
    limiter.fail('b')
    expect(limiter.blockedFor('b')).toBe(0)
  })

  it('覚える相手の数に上限（多数の IP でも膨らまない）', () => {
    let now = 0
    const limiter = new FailureLimiter({ maxFailures: 3, windowMs: 10_000, maxEntries: 5 }, () => now)
    for (let i = 0; i < 50; i++) { limiter.fail(`ip${i}`); now++ }
    expect(limiter.size()).toBeLessThanOrEqual(5)
  })
})

describe('URL', () => {
  const ifaces = {
    lo0: [{ address: '127.0.0.1', family: 'IPv4', internal: true }, { address: '::1', family: 'IPv6', internal: true }],
    en0: [{ address: 'fe80::1', family: 'IPv6', internal: false }, { address: '192.168.1.23', family: 'IPv4', internal: false }],
    utun4: [{ address: '100.101.102.103', family: 'IPv4', internal: false }],
    bridge: [{ address: '169.254.10.2', family: 'IPv4', internal: false }],
    docker: [{ address: '203.0.113.9', family: 4, internal: false }],
    dup: [{ address: '192.168.1.23', family: 'IPv4', internal: false }],
    off: undefined
  }

  it('内部・リンクローカル・IPv6 を除き、LAN → Tailscale → そのほかの順', () => {
    expect(reachableIPv4s(ifaces)).toEqual(['192.168.1.23', '100.101.102.103', '203.0.113.9'])
  })

  it('アドレスが無ければ空', () => {
    expect(reachableIPv4s({})).toEqual([])
    expect(reachableIPv4s({ lo0: [{ address: '127.0.0.1', family: 'IPv4', internal: true }] })).toEqual([])
  })

  it('合言葉はフラグメントに置く', () => {
    expect(remoteUrl('192.168.1.23', 47615, TOKEN)).toBe(`http://192.168.1.23:47615/#t=${TOKEN}`)
    expect(remoteUrls(['10.0.0.1', '100.64.0.1'], 50000, TOKEN)).toEqual([`http://10.0.0.1:50000/#t=${TOKEN}`, `http://100.64.0.1:50000/#t=${TOKEN}`])
    const url = new URL(remoteUrl('192.168.1.23', 47615, TOKEN))
    expect(url.pathname + url.search).toBe('/')
  })

  it('Tailscale と LAN の範囲の境目', () => {
    expect(isTailscaleIPv4('100.64.0.0')).toBe(true)
    expect(isTailscaleIPv4('100.127.255.255')).toBe(true)
    expect(isTailscaleIPv4('100.63.255.255')).toBe(false)
    expect(isTailscaleIPv4('100.128.0.0')).toBe(false)
    expect(isPrivateLanIPv4('172.16.0.1')).toBe(true)
    expect(isPrivateLanIPv4('172.31.255.255')).toBe(true)
    expect(isPrivateLanIPv4('172.15.0.1')).toBe(false)
    expect(isPrivateLanIPv4('172.32.0.1')).toBe(false)
    expect(isPrivateLanIPv4('192.169.0.1')).toBe(false)
    expect(isPrivateLanIPv4('10.255.255.255')).toBe(true)
    expect(isPrivateLanIPv4('nope')).toBe(false)
  })
})

describe('ポートと設定', () => {
  it('ポートは 1024〜65535 の整数', () => {
    expect(isValidPort(1024)).toBe(true)
    expect(isValidPort(65535)).toBe(true)
    expect(isValidPort(1023)).toBe(false)
    expect(isValidPort(65536)).toBe(false)
    expect(isValidPort(0)).toBe(false)
    expect(isValidPort(-1)).toBe(false)
    expect(isValidPort(47615.5)).toBe(false)
    expect(isValidPort('47615')).toBe(false)
    expect(isValidPort(Number.NaN)).toBe(false)
  })

  it('既定（閉じる・既定のポート）だけなら書かない', () => {
    expect(sanitizeMobileRemotePrefs(undefined)).toBeUndefined()
    expect(sanitizeMobileRemotePrefs(null)).toBeUndefined()
    expect(sanitizeMobileRemotePrefs([])).toBeUndefined()
    expect(sanitizeMobileRemotePrefs('on')).toBeUndefined()
    expect(sanitizeMobileRemotePrefs({})).toBeUndefined()
    expect(sanitizeMobileRemotePrefs({ enabled: false })).toBeUndefined()
    expect(sanitizeMobileRemotePrefs({ port: MOBILE_REMOTE_DEFAULT_PORT })).toBeUndefined()
  })

  it('入れた・ポートを変えたものだけ残す。壊れた値は捨てる', () => {
    expect(sanitizeMobileRemotePrefs({ enabled: true })).toEqual({ enabled: true })
    expect(sanitizeMobileRemotePrefs({ enabled: 'true', port: 50000 })).toEqual({ port: 50000 })
    expect(sanitizeMobileRemotePrefs({ enabled: true, port: 80 })).toEqual({ enabled: true })
    expect(sanitizeMobileRemotePrefs({ enabled: true, port: 70000, token: 'leak' })).toEqual({ enabled: true })
  })

  it('使うポート: 未設定・壊れた値は既定', () => {
    expect(remotePort(undefined)).toBe(MOBILE_REMOTE_DEFAULT_PORT)
    expect(remotePort({})).toBe(MOBILE_REMOTE_DEFAULT_PORT)
    expect(remotePort({ port: 1 })).toBe(MOBILE_REMOTE_DEFAULT_PORT)
    expect(remotePort({ port: 50000 })).toBe(50000)
  })

  it('settings.json の読み込み: 既定は書かず、入れたものは残り、スキーマに合う', () => {
    expect(sanitize({}).mobileRemote).toBeUndefined()
    expect(sanitize({ mobileRemote: { enabled: false } }).mobileRemote).toBeUndefined()
    const s = sanitize({ mobileRemote: { enabled: true, port: 50000 } })
    expect(s.mobileRemote).toEqual({ enabled: true, port: 50000 })
    const { config } = splitSettings(s)
    expect(config.mobileRemote).toEqual({ enabled: true, port: 50000 })
    expect(validateAgainstSchema(config.mobileRemote, SETTINGS_SCHEMA.properties!.mobileRemote!)).toEqual([])
  })

  it('スキーマ: 範囲外のポート・知らない項目（合言葉など）を知らせる', () => {
    const schema = SETTINGS_SCHEMA.properties!.mobileRemote!
    expect(validateAgainstSchema({ port: 80 }, schema).length).toBeGreaterThan(0)
    expect(validateAgainstSchema({ port: 70000 }, schema).length).toBeGreaterThan(0)
    expect(validateAgainstSchema({ token: 'x' }, schema).length).toBeGreaterThan(0)
    expect(validateAgainstSchema({ enabled: 'yes' }, schema).length).toBeGreaterThan(0)
  })
})

describe('道', () => {
  it('ページと JS・CSS・アイコン（GET・HEAD）', () => {
    expect(routeRequest('GET', '/')).toEqual({ kind: 'page' })
    expect(routeRequest('HEAD', '/index.html')).toEqual({ kind: 'page' })
    expect(routeRequest('GET', '/?x=1')).toEqual({ kind: 'page' })
    expect(routeRequest('GET', '/app.js')).toEqual({ kind: 'asset', name: 'app.js' })
    expect(routeRequest('GET', '/app.css')).toEqual({ kind: 'asset', name: 'app.css' })
    expect(routeRequest('GET', '/icon.svg')).toEqual({ kind: 'asset', name: 'icon.svg' })
    expect(routeRequest('POST', '/')).toEqual({ error: 405 })
  })

  it('API', () => {
    expect(routeRequest('GET', '/api/terminals')).toEqual({ kind: 'terminals' })
    expect(routeRequest('GET', '/api/checklist')).toEqual({ kind: 'checklist' })
    expect(routeRequest('GET', '/api/terminals/t1/screen')).toEqual({ kind: 'screen', id: 't1' })
    expect(routeRequest('POST', '/api/terminals/t12/send')).toEqual({ kind: 'send', id: 't12' })
    expect(routeRequest('POST', '/api/terminals/t12/key')).toEqual({ kind: 'key', id: 't12' })
  })

  it('メソッドの違いは 405', () => {
    expect(routeRequest('POST', '/api/terminals')).toEqual({ error: 405 })
    expect(routeRequest('GET', '/api/terminals/t1/send')).toEqual({ error: 405 })
    expect(routeRequest('PUT', '/api/terminals/t1/key')).toEqual({ error: 405 })
    expect(routeRequest('POST', '/api/terminals/t1/screen')).toEqual({ error: 405 })
    expect(routeRequest('OPTIONS', '/api/terminals')).toEqual({ error: 405 })
    expect(routeRequest(undefined, '/')).toEqual({ error: 405 })
  })

  it('知らない道・形の違う id・パスの細工は 404', () => {
    for (const url of ['/api', '/api/', '/api/terminals/', '/api/terminals/t1', '/api/terminals/t1/screen/x', '/api/terminals/t1/delete',
      '/api/terminals/..%2Fetc/screen', '/api/terminals/a%20b/screen', '/api/terminals/%E0%A4%A/screen', `/api/terminals/${'a'.repeat(65)}/screen`,
      '/../etc/passwd', '/app.js.map', '/favicon.ico', '//evil.com/', 'http://evil.com/', '*', '']) {
      expect(routeRequest('GET', url), url).toEqual({ error: 404 })
    }
    expect(routeRequest('GET', undefined)).toEqual({ kind: 'page' })
  })
})

describe('本文', () => {
  it('送る文字: 前後の空白を落とし、改行は残す', () => {
    expect(parseSendBody({ text: '  fix the bug  ' })).toEqual({ text: 'fix the bug' })
    expect(parseSendBody({ text: 'a\r\nb\rc' })).toEqual({ text: 'a\nb\nc' })
    expect(parseSendBody({ text: 'tab\there' })).toEqual({ text: 'tab\there' })
  })

  it('制御文字（ESC・NUL・Ctrl+C など）は落とす（キーは別の口で決まったものだけ）', () => {
    expect(parseSendBody({ text: 'ok\x1b[2J\x00\x03!' })).toEqual({ text: 'ok[2J!' })
    expect(parseSendBody({ text: '\x1b\x03' })).toEqual({ error: 'empty' })
  })

  it('空・長すぎ・形の違いは断る', () => {
    expect(parseSendBody({ text: '' })).toEqual({ error: 'empty' })
    expect(parseSendBody({ text: '   \n ' })).toEqual({ error: 'empty' })
    expect(parseSendBody({ text: 'x'.repeat(MOBILE_REMOTE_MAX_TEXT) })).toEqual({ text: 'x'.repeat(MOBILE_REMOTE_MAX_TEXT) })
    expect(parseSendBody({ text: 'x'.repeat(MOBILE_REMOTE_MAX_TEXT + 1) })).toEqual({ error: 'tooLong' })
    expect(parseSendBody({ text: 1 })).toEqual({ error: 'invalid' })
    expect(parseSendBody({})).toEqual({ error: 'invalid' })
    expect(parseSendBody(null)).toEqual({ error: 'invalid' })
    expect(parseSendBody(['x'])).toEqual({ error: 'invalid' })
    expect(parseSendBody('text')).toEqual({ error: 'invalid' })
  })

  it('キー: 決めた名前だけ', () => {
    expect(parseKeyBody({ key: 'enter' })).toEqual({ key: 'enter' })
    expect(parseKeyBody({ key: 'ctrl-c' })).toEqual({ key: 'ctrl-c' })
    expect(parseKeyBody({ key: '1' })).toEqual({ key: '1' })
    for (const key of ['ENTER', 'ctrl-d', '\x03', '4', '', 'toString', '__proto__', 'constructor', 1, null]) {
      expect(parseKeyBody({ key }), String(key)).toEqual({ error: 'invalid' })
    }
    expect(parseKeyBody(null)).toEqual({ error: 'invalid' })
    expect(parseKeyBody([])).toEqual({ error: 'invalid' })
  })

  it('キーの列は端末の決まりどおり', () => {
    expect(REMOTE_KEYS.enter).toBe('\r')
    expect(REMOTE_KEYS.esc).toBe('\x1b')
    expect(REMOTE_KEYS['ctrl-c']).toBe('\x03')
    expect(REMOTE_KEYS.up).toBe('\x1b[A')
    expect(REMOTE_KEYS.down).toBe('\x1b[B')
    expect(isRemoteKey('hasOwnProperty')).toBe(false)
  })
})

describe('画面の文字', () => {
  it('残った制御（色・カーソル・タイトル）を落とし、行末の空白と末尾の空行を削る', () => {
    expect(cleanScreenText('\x1b[31mred\x1b[0m  \r\n\x1b]0;title\x07next\x1b[?25l\n\n\n')).toBe('red\nnext')
    expect(cleanScreenText('a\x00b\x07c')).toBe('abc')
    expect(cleanScreenText('')).toBe('')
    expect(cleanScreenText('\n\n')).toBe('')
  })

  it('上限を超えたら末尾を残す', () => {
    const text = 'head\n' + 'x'.repeat(MOBILE_REMOTE_MAX_SCREEN)
    const out = cleanScreenText(text)
    expect(out).toHaveLength(MOBILE_REMOTE_MAX_SCREEN)
    expect(out.startsWith('head')).toBe(false)
    expect(cleanScreenText('abcdef', 3)).toBe('def')
  })

  it('日本語・絵文字はそのまま', () => {
    expect(cleanScreenText('完了しました ✅')).toBe('完了しました ✅')
  })
})

describe('プロジェクトの名前', () => {
  const projects = [
    { name: 'shop', folderPath: '/work/shop' },
    { name: 'shop-admin', folderPath: '/work/shop/admin/' },
    { name: 'win', folderPath: 'C:\\work\\win' }
  ]

  it('作業フォルダが入っている、いちばん深いプロジェクト', () => {
    expect(projectNameFor('/work/shop', projects)).toBe('shop')
    expect(projectNameFor('/work/shop/src/app', projects)).toBe('shop')
    expect(projectNameFor('/work/shop/admin/src', projects)).toBe('shop-admin')
    expect(projectNameFor('C:\\work\\win\\src', projects)).toBe('win')
  })

  it('前方一致だけの別フォルダは別物・無ければフォルダ名', () => {
    expect(projectNameFor('/work/shopping', projects)).toBe('shopping')
    expect(projectNameFor('/Users/me', [])).toBe('me')
    expect(projectNameFor('/', [])).toBe('/')
  })

  it('状態は4つにまとめる', () => {
    expect(normalizeAgentState('working')).toBe('working')
    expect(normalizeAgentState('blocked')).toBe('blocked')
    expect(normalizeAgentState('idle')).toBe('idle')
    expect(normalizeAgentState('done')).toBe('unknown')
    expect(normalizeAgentState('')).toBe('unknown')
  })
})
