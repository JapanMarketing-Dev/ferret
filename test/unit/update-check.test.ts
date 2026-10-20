import { afterEach, describe, expect, it, vi } from 'vitest'
import { setReporter, type Reporter } from '../../src/shared/report'

vi.mock('electron', () => ({ app: { getVersion: () => '44.5.1' }, net: { fetch: vi.fn() } }))
const { checkForUpdate, resetUpdateNetworkFailuresForTest, UPDATE_NETWORK_REPORT_AFTER } = await import('../../src/main/updateCheck')
const { version } = await import('../../package.json')

/**
 * 更新の確認（checkForUpdate）の結果と、確認できなかったときに Sentry へ warning（area: update）で知らせること。
 * 配信元へは取りに行かない（fetch を差し替える）。
 */

const manifest = (v: string) => ({ schema: 1, version: v, date: '', prerelease: false, notes: '', files: [] })
const respond = (status: number, body: unknown) =>
  (async () => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status })) as unknown as typeof fetch

function captured() {
  const handled = vi.fn<Reporter['handled']>()
  setReporter({ handled, message: vi.fn(), breadcrumb: vi.fn() })
  return handled
}

afterEach(() => {
  setReporter(null)
  resetUpdateNetworkFailuresForTest()
})

describe('checkForUpdate', () => {
  it('配信元の版が今と同じなら最新（dev 起動も package.json の版で比べる）', async () => {
    const handled = captured()
    const r = await checkForUpdate(respond(200, manifest(version)))
    expect(r).toEqual({ state: 'latest', current: version, latest: version })
    expect(handled).not.toHaveBeenCalled()
  })
  it('まだ latest.json が無い（404）のは失敗にしない・送らない', async () => {
    const handled = captured()
    expect((await checkForUpdate(respond(404, 'not found'))).state).toBe('no-release')
    expect(handled).not.toHaveBeenCalled()
  })
  it('ネットワークの失敗は、静かな「確認できなかった」にし、続けて UPDATE_NETWORK_REPORT_AFTER 回のときに1度だけ area: update で送る', async () => {
    const handled = captured()
    const fail = (async () => { throw new Error('net::ERR_INTERNET_DISCONNECTED') }) as unknown as typeof fetch
    for (let i = 1; i < UPDATE_NETWORK_REPORT_AFTER; i++) expect((await checkForUpdate(fail)).state).toBe('error')
    expect(handled).not.toHaveBeenCalled()
    await checkForUpdate(fail)
    expect(handled).toHaveBeenCalledWith(expect.objectContaining({ message: 'net::ERR_INTERNET_DISCONNECTED' }),
      { kind: 'handled', area: 'update', op: 'check update: network' }, 'warning')
    // 続いても同じ失敗を何度も送らない
    await checkForUpdate(fail)
    expect(handled).toHaveBeenCalledTimes(1)
  })
  it('スリープ明けなどの1回きりの失敗は送らない。配信元から返事が来たら数え直す（FERRET-1N: 0.4.16 で明けて1秒後）', async () => {
    const handled = captured()
    const fail = (async () => { throw new Error('net::ERR_NAME_NOT_RESOLVED') }) as unknown as typeof fetch
    for (let round = 0; round < 3; round++) {
      for (let i = 1; i < UPDATE_NETWORK_REPORT_AFTER; i++) await checkForUpdate(fail, 'darwin', () => true)
      await checkForUpdate(respond(200, manifest(version)))
    }
    expect(handled).not.toHaveBeenCalled()
  })
  it('端末がネットワークにつながっていないときの失敗は数えない・送らない（画面には「確認できなかった」を出す。FERRET-1N）', async () => {
    const handled = captured()
    const fail = (async () => { throw new Error('net::ERR_NAME_NOT_RESOLVED') }) as unknown as typeof fetch
    for (let i = 0; i < UPDATE_NETWORK_REPORT_AFTER + 2; i++) expect((await checkForUpdate(fail, 'darwin', () => false)).state).toBe('error')
    expect(handled).not.toHaveBeenCalled()
    // つながっているのに名前が引けないのが続くのは、配信元の不調かもしれないので送る
    for (let i = 0; i < UPDATE_NETWORK_REPORT_AFTER; i++) await checkForUpdate(fail, 'darwin', () => true)
    expect(handled.mock.calls.map((c) => c[1].op)).toEqual(['check update: network'])
  })
  it('スリープに入るところで OS が止めた通信（ERR_NETWORK_IO_SUSPENDED）は、続いても数えない・送らない（FERRET-1N 0.6.30 の Windows）', async () => {
    const handled = captured()
    const suspended = (async () => { throw new Error('net::ERR_NETWORK_IO_SUSPENDED') }) as unknown as typeof fetch
    for (let i = 0; i < UPDATE_NETWORK_REPORT_AFTER + 2; i++) expect((await checkForUpdate(suspended, 'win32', () => true)).state).toBe('error')
    expect(handled).not.toHaveBeenCalled()
    // ほかの失敗の数え方は変わらない
    const fail = (async () => { throw new Error('net::ERR_CONNECTION_RESET') }) as unknown as typeof fetch
    for (let i = 0; i < UPDATE_NETWORK_REPORT_AFTER; i++) await checkForUpdate(fail, 'win32', () => true)
    expect(handled).toHaveBeenCalledTimes(1)
  })
  it('時間切れが続けば timeout として送る', async () => {
    const handled = captured()
    const slow = (async () => { throw Object.assign(new Error('aborted'), { name: 'AbortError' }) }) as unknown as typeof fetch
    for (let i = 0; i < UPDATE_NETWORK_REPORT_AFTER; i++) expect((await checkForUpdate(slow)).state).toBe('error')
    expect(handled.mock.calls.map((c) => c[1].op)).toEqual(['check update: timeout'])
  })
  it('壊れた latest.json・HTTP の失敗・読めない版も送る', async () => {
    const handled = captured()
    expect((await checkForUpdate(respond(200, '{broken'))).state).toBe('error')
    expect((await checkForUpdate(respond(500, 'oops'))).state).toBe('error')
    expect((await checkForUpdate(respond(200, manifest('not-a-version')))).state).toBe('error')
    expect(handled.mock.calls.map((c) => c[1].op)).toEqual(['check update: bad-manifest', 'check update: http', 'check update: bad-version'])
  })
})
