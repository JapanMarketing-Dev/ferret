import { createServer, request, type Server } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { waitForCallback, type CallbackWaiter } from '../../src/main/publish/xAuthServer'

/** X の OAuth のコールバックを受ける端末の中のサーバー（src/main/publish/xAuthServer.ts）。本物の 127.0.0.1 で待つ */

const HOST = '127.0.0.1'
let waiter: CallbackWaiter | null = null
let blocker: Server | null = null
afterEach(async () => {
  waiter?.cancel()
  waiter = null
  await new Promise<void>((resolve) => (blocker ? blocker.close(() => resolve()) : resolve()))
  blocker = null
})

/** 空いていそうなポート（テストごとに変える） */
function port(): number {
  return 41000 + Math.floor(Math.random() * 8000)
}

function start(p: number, timeoutMs = 5000): CallbackWaiter {
  waiter = waitForCallback({ host: HOST, port: p, path: '/x/callback', state: 'STATE', timeoutMs, doneMessage: 'done <ok>', failedMessage: 'failed' })
  return waiter
}

function get(p: number, path: string, method = 'GET'): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: HOST, port: p, path, method }, (res) => {
      let body = ''
      res.on('data', (c: Buffer) => { body += c.toString() })
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }))
    })
    req.on('error', reject)
    req.end()
  })
}

describe('waitForCallback', () => {
  it('state の合う code を受けて閉じ、ブラウザには文をエスケープして出す', async () => {
    const p = port()
    const w = start(p)
    await w.ready
    const res = await get(p, '/x/callback?state=STATE&code=abc')
    expect(res.status).toBe(200)
    expect(res.body).toContain('done &lt;ok&gt;')
    expect(await w.code).toBe('abc')
    await expect(get(p, '/x/callback?state=STATE&code=again')).rejects.toThrow()
  })

  it('state が違う・パスが違う・GET でないものは無視して待ち続ける', async () => {
    const p = port()
    const w = start(p)
    await w.ready
    expect((await get(p, '/x/callback?state=OTHER&code=evil')).status).toBe(400)
    expect((await get(p, '/x/callback?code=evil')).status).toBe(400)
    expect((await get(p, '/other?state=STATE&code=evil')).status).toBe(404)
    expect((await get(p, '/x/callback?state=STATE&code=evil', 'POST')).status).toBe(404)
    await get(p, '/x/callback?state=STATE&code=good')
    expect(await w.code).toBe('good')
  })

  it('拒否（error）・code 無しは断る', async () => {
    const p = port()
    const w = start(p)
    await w.ready
    await get(p, '/x/callback?state=STATE&error=access_denied')
    await expect(w.code).rejects.toMatchObject({ userFacing: true })
    const p2 = port()
    const w2 = start(p2)
    await w2.ready
    await get(p2, '/x/callback?state=STATE')
    await expect(w2.code).rejects.toMatchObject({ userFacing: true })
  })

  it('時間切れ・取り消しで断り、ポートを閉じる', async () => {
    const p = port()
    const w = start(p, 50)
    await w.ready
    await expect(w.code).rejects.toMatchObject({ userFacing: true })
    await expect(get(p, '/x/callback?state=STATE&code=late')).rejects.toThrow()
    const p2 = port()
    const w2 = start(p2)
    await w2.ready
    w2.cancel()
    await expect(w2.code).rejects.toMatchObject({ userFacing: true })
    // 2回目の取り消しは何もしない
    w2.cancel()
  })

  it('ポートが使われていれば ready も code も断る', async () => {
    const p = port()
    blocker = createServer(() => undefined)
    await new Promise<void>((resolve) => blocker!.listen(p, HOST, () => resolve()))
    const w = start(p)
    await expect(w.ready).rejects.toMatchObject({ userFacing: true })
    await expect(w.code).rejects.toMatchObject({ userFacing: true })
  })
})
