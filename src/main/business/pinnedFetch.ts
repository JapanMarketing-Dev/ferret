/**
 * 実験ページの管理 API へ送る道（DNS の差し替え対策）。
 *
 * 名前を引いて確かめてから別に fetch すると、確かめたときは公開のアドレス・つなぐときは社内のアドレス、という
 * DNS rebinding が通る。ここでは Node の http/https に lookup を渡し、引いた結果を確かめて、確かめたアドレスそのものを
 * ソケットに渡す（つなぐ先＝確かめた先）。TLS の SNI と証明書の名前の確認は URL の名前のまま（servername）。
 * リダイレクトは追わない。応答の大きさは呼び出し側（readBoundedJson）、時間は init.signal で切る。
 * Electron の net.fetch（OS のプロキシ）は使わない（lookup を差し込めないため）
 */
import http from 'node:http'
import https from 'node:https'
import type { LookupAddress, LookupOneOptions, LookupAllOptions } from 'node:dns'
import { isIP } from 'node:net'
import { Readable } from 'node:stream'
import type { FetchLike, LookupAll } from './pages'

export class BlockedAddressError extends Error {
  readonly code = 'EBLOCKEDADDRESS'
}

type LookupCallback = (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void

/**
 * http.request の lookup に渡す関数。すべてのアドレスが許されるときだけ、その1つ目（all のときは全部）を返す。
 * 1つでも許されないアドレスがあれば断る（混ぜて返す DNS で社内へ向けさせない）
 */
export function pinnedLookup(resolve: LookupAll, allowed: (address: string, hostname: string) => boolean) {
  return (hostname: string, options: LookupOneOptions | LookupAllOptions | number, callback: LookupCallback): void => {
    resolve(hostname).then((addresses) => {
      if (!addresses.length) return callback(Object.assign(new Error('no address'), { code: 'ENOTFOUND' }), '')
      if (addresses.some((a) => !allowed(a.address, hostname))) return callback(new BlockedAddressError('blocked address'), '')
      const wantFamily = typeof options === 'number' ? options : options?.family
      const usable = wantFamily === 4 || wantFamily === 6 ? addresses.filter((a) => a.family === wantFamily) : addresses
      if (!usable.length) return callback(Object.assign(new Error('no address'), { code: 'ENOTFOUND' }), '')
      if (typeof options === 'object' && options && (options as LookupAllOptions).all) return callback(null, usable.map((a) => ({ address: a.address, family: a.family })))
      callback(null, usable[0]!.address, usable[0]!.family)
    }, (err: unknown) => callback(err as NodeJS.ErrnoException, ''))
  }
}

/** 確かめたアドレスにだけつなぐ fetch（GET・PUT・POST と文字列の本文だけ） */
export function createPinnedFetch(resolve: LookupAll, allowed: (address: string, hostname: string) => boolean): FetchLike {
  const lookup = pinnedLookup(resolve, allowed)
  return (url, init = {}) => new Promise<Response>((done, fail) => {
    const u = new URL(url)
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return fail(new TypeError('unsupported protocol'))
    const host = u.hostname.replace(/^\[|\]$/g, '')
    // IP の直書きは lookup を通らないので、ここで確かめる
    if (isIP(host) !== 0 && !allowed(host, u.hostname)) return fail(new BlockedAddressError('blocked address'))
    const headers: Record<string, string> = {}
    new Headers(init.headers).forEach((v, k) => { headers[k] = v })
    const body = typeof init.body === 'string' ? init.body : undefined
    if (body !== undefined) headers['content-length'] = String(Buffer.byteLength(body))
    const mod = u.protocol === 'https:' ? https : http
    const req = mod.request(u, {
      method: init.method ?? 'GET',
      headers,
      lookup: lookup as unknown as http.RequestOptions['lookup'],
      ...(u.protocol === 'https:' && isIP(host) === 0 ? { servername: u.hostname } : {}),
      ...(init.signal ? { signal: init.signal } : {}),
      agent: false
    }, (res) => {
      const responseHeaders = new Headers()
      for (const [k, v] of Object.entries(res.headers)) {
        if (Array.isArray(v)) for (const x of v) responseHeaders.append(k, x)
        else if (typeof v === 'string') responseHeaders.set(k, v)
      }
      const status = res.statusCode ?? 0
      const nullBody = status === 204 || status === 304 || init.method === 'HEAD'
      if (nullBody) res.resume()
      done(new Response(nullBody ? null : (Readable.toWeb(res) as ReadableStream<Uint8Array>), { status: status < 200 || status > 599 ? 502 : status, headers: responseHeaders }))
    })
    req.on('error', fail)
    req.end(body)
  })
}
