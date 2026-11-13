import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash, generateKeyPairSync } from 'node:crypto'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { signSshsig, sshPublicKeyLine } from '../../scripts/release-signing.mjs'
import {
  allFiles,
  assertUpdatesMatchSums,
  buildManifest,
  obsoleteFiles,
  parseArtifactName,
  parseSha256Sums,
  parseUpdateArtifactName,
  validateManifest
} from '../../scripts/release-r2-lib.mjs'
import { setReporter } from '../../src/shared/report'
import { AUTO_UPDATE_RESUME_DELAY_MS, INSTALL_KIND, checkOnUpdatePopoverOpen, installMethodFor, nsisInstallerArgs, type AutoUpdateStatus } from '../../src/shared/appUpdate'
import type { UpdateCheckResult } from '../../src/shared/appVersion'

vi.mock('electron', () => ({ app: { getVersion: () => '0.0.1' }, net: { fetch: vi.fn() } }))
const { verifiedUpdateFiles, verifiedReleaseFiles } = await import('../../src/main/releaseSignature')
const { RELEASE_BASE_URL, checkForUpdate, pickVerifiedOfKind, setReleaseSourceForTests, verifiedFileOfKind } = await import('../../src/main/updateCheck')
const { downloadVerifiedTo, UpdateDownloadError } = await import('../../src/main/updateDownload')
const { AutoUpdater } = await import('../../src/main/autoUpdate')
type AutoUpdateDeps = ConstructorParameters<typeof AutoUpdater>[0]
type VerifiedDownload = NonNullable<ReturnType<typeof verifiedFileOfKind>>

/**
 * 裏での更新（src/main/autoUpdate.ts）と、その前提の「署名で確かめたファイルだけを使う」決まり。
 * 配信元へは行かない（fetch を差し替える）。本物の入れ替え（再起動）はしない。
 */

const key = (() => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  return { pem: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(), line: sshPublicKeyLine(publicKey) }
})()
const otherKey = (() => {
  const { privateKey } = generateKeyPairSync('ed25519')
  return privateKey.export({ format: 'pem', type: 'pkcs8' }).toString()
})()
const sha = (s: string) => createHash('sha256').update(s).digest('hex')
const sumsOf = (lines: Array<[string, string]>) => Buffer.from(lines.map(([digest, name]) => `${digest}  ${name}\n`).join(''))

beforeEach(() => setReporter({ handled: vi.fn(), message: vi.fn(), breadcrumb: vi.fn() }))
afterEach(() => {
  setReporter(null)
  vi.unstubAllEnvs()
})

describe('入れ替えの方法（OS ごとの分岐）', () => {
  it('macOS は Squirrel.Mac に zip、Windows は NSIS の exe、Linux は AppImage なら置き換え・deb はインストーラーを開く', () => {
    expect(installMethodFor('darwin', {})).toBe('squirrel-mac')
    expect(installMethodFor('win32', {})).toBe('nsis')
    expect(installMethodFor('linux', { APPIMAGE: '/home/taro/Apps/Ferret-0.4.1-linux-x86_64.AppImage' })).toBe('appimage')
    expect(installMethodFor('linux', {})).toBe('deb')
    // 相対パスの APPIMAGE は信じない（置き換える場所を取り違えない）
    expect(installMethodFor('linux', { APPIMAGE: 'Ferret.AppImage' })).toBe('deb')
    expect(installMethodFor('freebsd', {})).toBeNull()
    expect(INSTALL_KIND).toEqual({ 'squirrel-mac': 'zip', nsis: 'exe', appimage: 'AppImage', deb: 'deb' })
  })
})

describe('自動更新用のファイル（macOS の zip）の署名', () => {
  const Z = sha('zip bytes')
  const zip = (version: string, name = `Ferret-${version}-mac-arm64.zip`, extra: Record<string, unknown> = {}) =>
    ({ name, sha256: Z, path: `releases/${version}/${name}`, size: 9, ...extra })

  it('署名の合う UPDATE-SHA256SUMS に同じ値で載っている zip だけを使う', () => {
    const sums = sumsOf([[Z, 'Ferret-1.2.0-mac-arm64.zip']])
    const sig = signSshsig(sums, key.pem)
    expect(verifiedUpdateFiles('1.2.0', [zip('1.2.0')], sums, sig, key.line)).toEqual([
      { name: 'Ferret-1.2.0-mac-arm64.zip', sha256: Z, size: 9, path: 'releases/1.2.0/Ferret-1.2.0-mac-arm64.zip', os: 'mac', arch: 'arm64', kind: 'zip' }
    ])
    // 作り直した版（b<n>/）も同じ名前なら通す
    expect(verifiedUpdateFiles('1.2.0', [zip('1.2.0', undefined, { path: 'releases/1.2.0/b2/Ferret-1.2.0-mac-arm64.zip' })], sums, sig, key.line)).toHaveLength(1)
  })

  it('別の鍵の署名・sha256 の違い・別の版の名前・配信元の外の path・インストーラーの名前は、どれも断る', () => {
    const sums = sumsOf([[Z, 'Ferret-1.2.0-mac-arm64.zip']])
    const sig = signSshsig(sums, key.pem)
    expect(verifiedUpdateFiles('1.2.0', [zip('1.2.0')], sums, signSshsig(sums, otherKey), key.line)).toBeNull()
    expect(verifiedUpdateFiles('1.2.0', [zip('1.2.0', undefined, { sha256: 'f'.repeat(64) })], sums, sig, key.line)).toBeNull()
    expect(verifiedUpdateFiles('9.0.0', [zip('9.0.0', 'Ferret-1.2.0-mac-arm64.zip')], sums, sig, key.line)).toBeNull()
    expect(verifiedUpdateFiles('1.2.0', [zip('1.2.0', undefined, { path: 'https://evil.example/Ferret-1.2.0-mac-arm64.zip' })], sums, sig, key.line)).toBeNull()
    expect(verifiedUpdateFiles('1.2.0', [zip('1.2.0', undefined, { path: 'releases/1.2.0/../x/Ferret-1.2.0-mac-arm64.zip' })], sums, sig, key.line)).toBeNull()
    // インストーラーの SHA256SUMS を自動更新用として出し直しても通らない（逆も同じ）
    const installerSums = sumsOf([[Z, 'Ferret-1.2.0-mac-arm64.dmg']])
    const installerSig = signSshsig(installerSums, key.pem)
    expect(verifiedUpdateFiles('1.2.0', [zip('1.2.0', 'Ferret-1.2.0-mac-arm64.dmg')], installerSums, installerSig, key.line)).toBeNull()
    expect(verifiedReleaseFiles('1.2.0', [zip('1.2.0')], sums, sig, key.line)).toBeNull()
  })
})

describe('確かめたファイルから、入れ替えに使う種類を選ぶ', () => {
  const files = [
    { name: 'Ferret-2.0.0-mac-arm64.dmg', sha256: 'a'.repeat(64), size: 1, os: 'mac' as const, arch: 'arm64' as const, kind: 'dmg' as const, path: 'releases/2.0.0/Ferret-2.0.0-mac-arm64.dmg' },
    { name: 'Ferret-2.0.0-mac-arm64.zip', sha256: 'b'.repeat(64), size: 2, os: 'mac' as const, arch: 'arm64' as const, kind: 'zip' as const, path: 'releases/2.0.0/Ferret-2.0.0-mac-arm64.zip' },
    { name: 'Ferret-2.0.0-linux-x86_64.AppImage', sha256: 'c'.repeat(64), size: 3, os: 'linux' as const, arch: 'x64' as const, kind: 'AppImage' as const, path: 'releases/2.0.0/Ferret-2.0.0-linux-x86_64.AppImage' },
    { name: 'Ferret-2.0.0-linux-amd64.deb', sha256: 'd'.repeat(64), size: 4, os: 'linux' as const, arch: 'x64' as const, kind: 'deb' as const, path: 'releases/2.0.0/Ferret-2.0.0-linux-amd64.deb' }
  ]
  const set = { version: '2.0.0', files }
  it('OS・CPU・種類の合うものだけ。URL は配信元の下', () => {
    expect(pickVerifiedOfKind(set, 'zip', 'darwin', 'arm64')).toEqual({ version: '2.0.0', name: 'Ferret-2.0.0-mac-arm64.zip', sha256: 'b'.repeat(64), size: 2, kind: 'zip', url: `${RELEASE_BASE_URL}releases/2.0.0/Ferret-2.0.0-mac-arm64.zip` })
    expect(pickVerifiedOfKind(set, 'zip', 'darwin', 'x64')).toBeNull()
    expect(pickVerifiedOfKind(set, 'AppImage', 'linux', 'x64')?.name).toBe('Ferret-2.0.0-linux-x86_64.AppImage')
    expect(pickVerifiedOfKind(set, 'deb', 'linux', 'x64')?.name).toBe('Ferret-2.0.0-linux-amd64.deb')
    expect(pickVerifiedOfKind(set, 'exe', 'win32', 'x64')).toBeNull()
    expect(pickVerifiedOfKind(null, 'zip', 'darwin', 'arm64')).toBeNull()
  })
  it('配信元の外を指す path は使わない', () => {
    const evil = { version: '2.0.0', files: [{ ...files[1]!, path: 'https://evil.example/Ferret-2.0.0-mac-arm64.zip' }] }
    expect(pickVerifiedOfKind(evil, 'zip', 'darwin', 'arm64')).toBeNull()
  })
})

describe('checkForUpdate（macOS は自動更新用の zip も確かめる）', () => {
  const zipBody = 'zip bytes'
  const dmgBody = 'dmg bytes'
  const names = { dmg: 'Ferret-99.0.0-mac-arm64.dmg', zip: 'Ferret-99.0.0-mac-arm64.zip' }
  const base = 'http://127.0.0.1:43210/'
  function server(updateSig: (sums: Buffer) => string) {
    const sums = sumsOf([[sha(dmgBody), names.dmg]])
    const updateSums = sumsOf([[sha(zipBody), names.zip]])
    return (async (url: string) => {
      if (!url.startsWith(base)) throw new Error(`went outside the fake origin: ${url}`)
      if (url.endsWith('latest.json')) {
        return Response.json({ schema: 1, version: '99.0.0', date: '', prerelease: false, notes: '',
          files: [{ name: names.dmg, path: `releases/99.0.0/${names.dmg}`, size: dmgBody.length, sha256: sha(dmgBody), os: 'mac', arch: 'arm64', kind: 'dmg' }],
          updates: [{ name: names.zip, path: `releases/99.0.0/${names.zip}`, size: zipBody.length, sha256: sha(zipBody), os: 'mac', arch: 'arm64', kind: 'zip' }] })
      }
      if (url.endsWith('/UPDATE-SHA256SUMS')) return new Response(updateSums)
      if (url.endsWith('/UPDATE-SHA256SUMS.sig')) return new Response(updateSig(updateSums))
      if (url.endsWith('/SHA256SUMS')) return new Response(sums)
      if (url.endsWith('/SHA256SUMS.sig')) return new Response(signSshsig(sums, key.pem))
      return new Response('nope', { status: 404 })
    }) as unknown as typeof fetch
  }
  beforeEach(() => setReleaseSourceForTests({ base, key: key.line }))
  afterEach(() => setReleaseSourceForTests(null))

  it('署名の合う zip があれば、入れ替えに使うファイルとして持つ（インストーラーの案内はそのまま）', async () => {
    const r = await checkForUpdate(server((s) => signSshsig(s, key.pem)), 'darwin')
    expect(r.state).toBe('available')
    // verifiedFileOfKind はこのプロセスの OS と CPU で選ぶ（arm64 の Linux・Windows では mac の zip を選ばない）
    if (process.platform === 'darwin' && process.arch === 'arm64') {
      expect(verifiedFileOfKind('zip')).toMatchObject({ name: names.zip, sha256: sha(zipBody), url: `${base}releases/99.0.0/${names.zip}` })
    }
  })

  it('zip の署名が合わなければ、自動更新のファイルは持たない（新しい版の案内と手動のダウンロードは残る）', async () => {
    const r = await checkForUpdate(server((s) => signSshsig(s, otherKey)), 'darwin')
    expect(r.state).toBe('available')
    expect(verifiedFileOfKind('zip')).toBeNull()
  })

  it('macOS 以外は zip を取りに行かない', async () => {
    const seen: string[] = []
    const inner = server((s) => signSshsig(s, key.pem))
    const r = await checkForUpdate((async (url: string) => { seen.push(url); return inner(url) }) as unknown as typeof fetch, 'linux')
    expect(r.state).toBe('available')
    expect(seen.some((u) => u.includes('UPDATE-SHA256SUMS'))).toBe(false)
  })
})

describe('downloadVerifiedTo（自動更新のダウンロード）', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'auto-update-dl-')) })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))
  const body = 'x'.repeat(5000)
  const file: VerifiedDownload = { version: '3.0.0', name: 'Ferret-3.0.0-win-x64.exe', sha256: sha(body), size: body.length, kind: 'exe', url: `${RELEASE_BASE_URL}releases/3.0.0/Ferret-3.0.0-win-x64.exe` }
  const serve = (text: string) => (async () => new Response(text)) as unknown as typeof fetch

  it('合ったものだけを dir/<名前> に置き、進み具合を知らせる', async () => {
    const progress: number[] = []
    const placed = await downloadVerifiedTo(file, dir, serve(body), undefined, (received) => progress.push(received))
    expect(placed).toBe(join(dir, file.name))
    expect(readFileSync(placed, 'utf8')).toBe(body)
    expect(progress.at(-1)).toBe(body.length)
    expect(readdirSync(dir)).toEqual([file.name])
  })

  it('中身が署名の値と違えば断り、何も残さない', async () => {
    await expect(downloadVerifiedTo(file, dir, serve('y'.repeat(5000)))).rejects.toBeInstanceOf(UpdateDownloadError)
    await expect(downloadVerifiedTo(file, dir, serve(body + '!'))).rejects.toBeInstanceOf(UpdateDownloadError)
    expect(readdirSync(dir)).toEqual([])
    expect(existsSync(join(dir, file.name))).toBe(false)
  })
})

describe('AutoUpdater（裏での確認 → ダウンロード → 再起動して更新）', () => {
  const file: VerifiedDownload = { version: '2.0.0', name: 'Ferret-2.0.0-mac-arm64.zip', sha256: 'a'.repeat(64), size: 100, kind: 'zip', url: `${RELEASE_BASE_URL}releases/2.0.0/Ferret-2.0.0-mac-arm64.zip` }
  const available: UpdateCheckResult = { state: 'available', current: '1.0.0', latest: '2.0.0', url: 'https://ferretade.dev/download' }

  function setup(over: Partial<AutoUpdateDeps> = {}) {
    let auto = true
    const emitted: AutoUpdateStatus[] = []
    const calls: string[] = []
    const deps: AutoUpdateDeps = {
      method: 'squirrel-mac',
      enabled: true,
      canInstall: true,
      check: async () => available,
      verifiedFile: (kind) => (kind === 'zip' ? file : null),
      download: async (f, _dir, onProgress) => {
        calls.push(`download ${f.name}`)
        onProgress(50, 100)
        onProgress(100, 100)
        return `/cache/${f.name}`
      },
      hashFile: async () => null,
      prepareDir: async (keep) => ({ dir: '/cache', target: `/cache/${keep}` }),
      stage: async (method, path) => { calls.push(`stage ${method} ${path}`) },
      install: async (method, path) => { calls.push(`install ${method} ${path}`) },
      installOnQuit: (method, path) => { calls.push(`quit ${method} ${path}`); return true },
      getAutoDownload: () => auto,
      setAutoDownload: (on) => { auto = on },
      emit: (s) => emitted.push(s),
      report: vi.fn(),
      failedMessage: () => 'failed',
      ...over
    }
    return { updater: new AutoUpdater(deps), emitted, calls, deps }
  }
  const settle = () => new Promise((r) => setTimeout(r, 0))

  it('新しい版を見つけたら裏でダウンロードし、進み具合を出して、準備ができたら「再起動して更新」にする', async () => {
    const { updater, emitted, calls } = setup()
    await updater.checkNow()
    await settle()
    await settle()
    expect(calls).toEqual(['download Ferret-2.0.0-mac-arm64.zip', 'stage squirrel-mac /cache/Ferret-2.0.0-mac-arm64.zip'])
    const phases = emitted.map((s) => s.progress.phase === 'downloading' ? `downloading ${s.progress.percent}` : s.progress.phase)
    expect(phases).toContain('downloading 50')
    expect(phases.at(-1)).toBe('ready')
    expect(updater.status().progress).toEqual({ phase: 'ready', version: '2.0.0', action: 'restart' })
    expect(await updater.install()).toBe(true)
    expect(calls.at(-1)).toBe('install squirrel-mac /cache/Ferret-2.0.0-mac-arm64.zip')
    // 入れ替えが始まったら二度押さない
    expect(await updater.install()).toBe(false)
  })

  it('checkIfStale: まだ確かめていなければ確かめ、前の確認から maxAge たつまでは確かめない（スリープ明け・ウインドウに戻ったとき）', async () => {
    let now = 1_000_000
    let checks = 0
    const { updater } = setup({ now: () => now, check: async () => { checks++; return available }, getAutoDownload: () => false })
    await updater.checkIfStale(60 * 60 * 1000)
    expect(checks).toBe(1)
    now += 30 * 60 * 1000
    expect(updater.checkIfStale(60 * 60 * 1000)).toBeNull()
    expect(checks).toBe(1)
    now += 31 * 60 * 1000
    await updater.checkIfStale(60 * 60 * 1000)
    expect(checks).toBe(2)
    // スリープ明け（maxAge 0）は必ず確かめる
    await updater.checkIfStale(0)
    expect(checks).toBe(3)
  })

  it('スリープ明け: すぐには確かめず、ネットワークが戻るのを待ってから確かめる。待つ間はウインドウに戻っても確かめない（FERRET-1N）', async () => {
    vi.useFakeTimers()
    try {
      const check = vi.fn(async () => ({ state: 'latest', current: '1.0.0', latest: '1.0.0' }) as UpdateCheckResult)
      const { updater } = setup({ check })
      updater.resumed()
      // 明けた直後（Wi-Fi・DNS がまだ戻っていない）には確かめない。ウインドウに戻ったときの確認も待つ
      expect(updater.checkIfStale(0)).toBeNull()
      await vi.advanceTimersByTimeAsync(AUTO_UPDATE_RESUME_DELAY_MS - 1)
      expect(check).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(1)
      expect(check).toHaveBeenCalledTimes(1)
      // 待ち終えたら、ふだんどおり（ウインドウに戻ったとき・一定間隔）
      vi.setSystemTime(Date.now() + 1)
      await updater.checkIfStale(0)
      expect(check).toHaveBeenCalledTimes(2)
      await vi.advanceTimersByTimeAsync(6 * 60 * 60 * 1000)
      expect(check).toHaveBeenCalledTimes(3)
      // 利用者の［更新を確認］は待たない
      updater.resumed()
      await updater.checkNow()
      expect(check).toHaveBeenCalledTimes(4)
      updater.stop()
      // 配布版でない起動は、明けても確かめない
      const off = setup({ enabled: false, check })
      off.updater.resumed()
      await vi.advanceTimersByTimeAsync(AUTO_UPDATE_RESUME_DELAY_MS)
      expect(check).toHaveBeenCalledTimes(4)
    } finally {
      vi.useRealTimers()
    }
  })

  it('checkIfStale: 配布版でない起動（enabled でない）では確かめない', () => {
    let checks = 0
    const { updater } = setup({ enabled: false, check: async () => { checks++; return available } })
    expect(updater.checkIfStale(0)).toBeNull()
    expect(checks).toBe(0)
  })

  it('バージョンの表示を開いたときの確認: 配布版と、裏の更新が動く起動（E2E の偽の配信元）だけ。開発版の起動は本物の配信元へ行かない', () => {
    expect(checkOnUpdatePopoverOpen(true, null)).toBe(true)
    expect(checkOnUpdatePopoverOpen(true, { supported: false })).toBe(true)
    expect(checkOnUpdatePopoverOpen(false, { supported: true })).toBe(true)
    expect(checkOnUpdatePopoverOpen(false, { supported: false })).toBe(false)
    // 状態がまだ届いていない開発版は確かめない
    expect(checkOnUpdatePopoverOpen(false, null)).toBe(false)
  })

  it('自動のダウンロードがオフなら、見つけても落とさない。［ダウンロード］で始める', async () => {
    const { updater, calls } = setup()
    updater.setAutoDownload(false)
    await updater.checkNow()
    await settle()
    expect(calls).toEqual([])
    expect(updater.status()).toMatchObject({ autoDownload: false, supported: true, progress: { phase: 'idle' } })
    expect(await updater.download()).toBe(true)
    expect(updater.status().progress.phase).toBe('ready')
  })

  it('オンに戻したとき新しい版があれば、すぐ始める', async () => {
    const { updater, calls } = setup()
    updater.setAutoDownload(false)
    await updater.checkNow()
    updater.setAutoDownload(true)
    await settle()
    await settle()
    expect(calls[0]).toBe('download Ferret-2.0.0-mac-arm64.zip')
  })

  it('署名で確かめたファイルが無い版（署名が合わない・この OS 向けの zip が無い）は、落とさず手動の案内だけ', async () => {
    const { updater, calls } = setup({ verifiedFile: () => null })
    await updater.checkNow()
    await settle()
    expect(calls).toEqual([])
    expect(updater.status().supported).toBe(false)
    expect(await updater.download()).toBe(false)
  })

  it('確かめたファイルの版が、案内している版と違えば使わない', async () => {
    const { updater, calls } = setup({ verifiedFile: () => ({ ...file, version: '1.5.0' }) })
    await updater.checkNow()
    await settle()
    expect(calls).toEqual([])
    expect(updater.status().supported).toBe(false)
  })

  it('開発版の起動（enabled でない）・入れ替えの方法が無い OS では、確かめても落とさない', async () => {
    for (const over of [{ enabled: false }, { method: null }] as Array<Partial<AutoUpdateDeps>>) {
      const { updater, calls } = setup(over)
      await updater.checkNow()
      await settle()
      expect(calls).toEqual([])
      expect(updater.status().supported).toBe(false)
    }
  })

  it('E2E（canInstall でない）は確かめるところまで。Squirrel.Mac に渡さず、再起動もしない', async () => {
    const { updater, calls } = setup({ canInstall: false })
    await updater.checkNow()
    await settle()
    await settle()
    expect(calls).toEqual(['download Ferret-2.0.0-mac-arm64.zip'])
    expect(updater.status().progress.phase).toBe('ready')
    expect(await updater.install()).toBe(false)
    expect(calls).toHaveLength(1)
  })

  it('ダウンロード（sha256 の違いなど）や Squirrel.Mac の準備に失敗したら「失敗」にし、［もう一度］で始め直せる', async () => {
    let fail = true
    const { updater, deps } = setup({
      download: async (f) => {
        if (fail) throw new UpdateDownloadError('digest')
        return `/cache/${f.name}`
      }
    })
    await updater.checkNow()
    await settle()
    await settle()
    expect(updater.status().progress).toEqual({ phase: 'failed', version: '2.0.0', message: 'failed' })
    expect(deps.report).toHaveBeenCalled()
    fail = false
    expect(await updater.download()).toBe(true)
    expect(updater.status().progress.phase).toBe('ready')

    const staging = setup({ stage: async () => { throw new Error('Squirrel.Mac rejected the update') } })
    await staging.updater.checkNow()
    await settle()
    await settle()
    expect(staging.updater.status().progress.phase).toBe('failed')
    expect(await staging.updater.install()).toBe(false)
  })

  it('前の起動で落として確かめたものが残っていれば、落とし直さない', async () => {
    const { updater, calls } = setup({ hashFile: async () => file.sha256 })
    await updater.checkNow()
    await settle()
    await settle()
    expect(calls).toEqual(['stage squirrel-mac /cache/Ferret-2.0.0-mac-arm64.zip'])
    expect(updater.status().progress.phase).toBe('ready')
  })

  it('deb は「インストーラーを開く」。何度でも開ける', async () => {
    const debFile = { ...file, name: 'Ferret-2.0.0-linux-amd64.deb', kind: 'deb' as const }
    const { updater, calls } = setup({ method: 'deb', verifiedFile: (kind) => (kind === 'deb' ? debFile : null) })
    await updater.checkNow()
    await settle()
    await settle()
    expect(updater.status().progress).toEqual({ phase: 'ready', version: '2.0.0', action: 'open-installer' })
    expect(await updater.install()).toBe(true)
    expect(await updater.install()).toBe(true)
    expect(calls.filter((c) => c.startsWith('install deb'))).toHaveLength(2)
  })

  it('確認は同時に1回だけ。署名の無い版（unverified）は落とさない', async () => {
    let calls = 0
    const { updater } = setup({ check: async () => { calls++; return { state: 'unverified', current: '1.0.0', latest: '2.0.0' } } })
    const [a, b] = await Promise.all([updater.checkNow(), updater.checkNow()])
    expect(a).toBe(b)
    expect(calls).toBe(1)
    await settle()
    expect(updater.status().progress.phase).toBe('idle')
  })

  const exe: VerifiedDownload = { ...file, name: 'Ferret-2.0.0-win-x64.exe', kind: 'exe', url: `${RELEASE_BASE_URL}releases/2.0.0/Ferret-2.0.0-win-x64.exe` }
  const nsis = (over: Partial<AutoUpdateDeps> = {}) => setup({ method: 'nsis', verifiedFile: (kind) => (kind === 'exe' ? exe : null), ...over })
  const ready = async (updater: InstanceType<typeof AutoUpdater>) => {
    await updater.checkNow()
    await settle()
    await settle()
  }

  it('閉じたとき: 準備ができていれば、起動し直さずに入れる。次に開いたとき新しい版（NSIS は --force-run を付けない）', async () => {
    const { updater, calls } = nsis()
    await ready(updater)
    expect(updater.status()).toMatchObject({ progress: { phase: 'ready', action: 'restart' }, installOnQuit: true })
    expect(updater.installOnQuit()).toBe(true)
    expect(calls.at(-1)).toBe('quit nsis /cache/Ferret-2.0.0-win-x64.exe')
    expect(nsisInstallerArgs('quit')).toEqual(['--updated', '/S'])
    expect(nsisInstallerArgs('restart')).toEqual(['--updated', '/S', '--force-run'])
    // AppImage も同じ経路
    const appImage = { ...file, name: 'Ferret-2.0.0-linux-x86_64.AppImage', kind: 'AppImage' as const }
    const linux = setup({ method: 'appimage', verifiedFile: (kind) => (kind === 'AppImage' ? appImage : null) })
    await ready(linux.updater)
    expect(linux.updater.installOnQuit()).toBe(true)
    expect(linux.calls.at(-1)).toBe('quit appimage /cache/Ferret-2.0.0-linux-x86_64.AppImage')
  })

  it('閉じたとき: 二重に走らない。［再起動して更新］で入れ替えが始まっていれば、閉じたときはもう走らせない', async () => {
    const first = nsis()
    await ready(first.updater)
    expect(first.updater.installOnQuit()).toBe(true)
    expect(first.updater.installOnQuit()).toBe(false)
    expect(await first.updater.install()).toBe(false)
    expect(first.calls.filter((c) => c.startsWith('quit') || c.startsWith('install'))).toEqual(['quit nsis /cache/Ferret-2.0.0-win-x64.exe'])

    const restarted = nsis()
    await ready(restarted.updater)
    expect(await restarted.updater.install()).toBe(true)
    // 再起動して更新 → app.quit → quit の順に届いても、インストーラーは1回だけ
    expect(restarted.updater.installOnQuit()).toBe(false)
    expect(restarted.calls.filter((c) => c.startsWith('quit'))).toEqual([])
    expect(restarted.updater.status().installOnQuit).toBe(false)
  })

  it('［再起動して更新］のあとの quit では、選んだ入れ替え（NSIS のインストーラー）を後始末が済んだここで1回だけ起動する（FERRET-1Q）', async () => {
    let pending = 1
    const pendingCalls: string[] = []
    const { updater, calls } = nsis({ runPendingInstall: () => { pendingCalls.push('pending install'); return pending-- > 0 } })
    await ready(updater)
    expect(await updater.install()).toBe(true)
    expect(pendingCalls).toEqual([])
    expect(updater.installOnQuit()).toBe(true)
    expect(updater.installOnQuit()).toBe(false)
    expect(pendingCalls).toEqual(['pending install', 'pending install'])
    // 閉じたときの入れ替え（起動し直さない方）は走らせない
    expect(calls.filter((c) => c.startsWith('quit'))).toEqual([])
  })

  it('閉じたとき: 自動の更新がオフなら入れない（手動で落としたものも）。macOS は［再起動して更新］まで Squirrel.Mac に渡さない', async () => {
    const off = nsis()
    off.updater.setAutoDownload(false)
    await ready(off.updater)
    expect(await off.updater.download()).toBe(true)
    expect(off.updater.status()).toMatchObject({ progress: { phase: 'ready' }, installOnQuit: false })
    expect(off.updater.installOnQuit()).toBe(false)
    expect(off.calls.some((c) => c.startsWith('quit'))).toBe(false)

    const mac = setup()
    mac.updater.setAutoDownload(false)
    await ready(mac.updater)
    expect(await mac.updater.download()).toBe(true)
    expect(mac.calls).toEqual(['download Ferret-2.0.0-mac-arm64.zip'])
    expect(mac.updater.status().installOnQuit).toBe(false)
    // 押したときに渡して、すぐ入れ替える
    expect(await mac.updater.install()).toBe(true)
    expect(mac.calls.slice(1)).toEqual(['stage squirrel-mac /cache/Ferret-2.0.0-mac-arm64.zip', 'install squirrel-mac /cache/Ferret-2.0.0-mac-arm64.zip'])
  })

  it('閉じたとき（macOS）: 自動の更新がオンなら Squirrel.Mac に渡しておき、閉じたあとは Squirrel.Mac が入れる。オンに戻すと、手動で落としたものも渡す', async () => {
    const mac = setup()
    await ready(mac.updater)
    expect(mac.calls).toContain('stage squirrel-mac /cache/Ferret-2.0.0-mac-arm64.zip')
    expect(mac.updater.status().installOnQuit).toBe(true)
    expect(mac.updater.installOnQuit()).toBe(true)
    // 渡したものは取り下げられないので、あとでオフにしても閉じたときに入る（表示もそのまま）
    const staged = setup()
    await ready(staged.updater)
    staged.updater.setAutoDownload(false)
    expect(staged.updater.status().installOnQuit).toBe(true)

    const manual = setup()
    manual.updater.setAutoDownload(false)
    await ready(manual.updater)
    await manual.updater.download()
    expect(manual.calls.some((c) => c.startsWith('stage'))).toBe(false)
    manual.updater.setAutoDownload(true)
    await settle()
    expect(manual.calls.filter((c) => c.startsWith('stage') || c.startsWith('download'))).toEqual([
      'download Ferret-2.0.0-mac-arm64.zip', 'stage squirrel-mac /cache/Ferret-2.0.0-mac-arm64.zip'
    ])
    expect(manual.updater.status().installOnQuit).toBe(true)
  })

  it('閉じたとき: 署名と照らし終える前（確認前・ダウンロード中・照らして合わなかった）・deb・開発版では入れない', async () => {
    // 確認前
    const before = nsis()
    expect(before.updater.installOnQuit()).toBe(false)
    // ダウンロード中
    let finish: (path: string) => void = () => undefined
    const pending = nsis({ download: () => new Promise<string>((resolve) => { finish = resolve }) })
    await pending.updater.checkNow()
    await settle()
    expect(pending.updater.status().progress.phase).toBe('downloading')
    expect(pending.updater.installOnQuit()).toBe(false)
    finish('/cache/Ferret-2.0.0-win-x64.exe')
    await settle()
    expect(pending.updater.status().progress.phase).toBe('ready')
    // 照らして合わなかった
    const tampered = nsis({ download: async () => { throw new UpdateDownloadError('digest') } })
    await ready(tampered.updater)
    expect(tampered.updater.status().progress.phase).toBe('failed')
    expect(tampered.updater.installOnQuit()).toBe(false)
    // deb はインストーラーを開くだけ（閉じても入れない）
    const debFile = { ...file, name: 'Ferret-2.0.0-linux-amd64.deb', kind: 'deb' as const }
    const deb = setup({ method: 'deb', verifiedFile: (kind) => (kind === 'deb' ? debFile : null) })
    await ready(deb.updater)
    expect(deb.updater.status().installOnQuit).toBe(false)
    expect(deb.updater.installOnQuit()).toBe(false)
    // 開発版の起動（enabled でない）
    const dev = nsis({ enabled: false })
    await ready(dev.updater)
    expect(dev.updater.installOnQuit()).toBe(false)
    for (const u of [before, pending, tampered, deb, dev]) expect(u.calls.some((c) => c.startsWith('quit'))).toBe(false)
    // 入れ替えに失敗しても、終了の途中で落ちない（Sentry へ知らせるだけ）
    const broken = nsis({ installOnQuit: () => { throw new Error('installer missing') } })
    await ready(broken.updater)
    expect(broken.updater.installOnQuit()).toBe(false)
    expect(broken.deps.report).toHaveBeenCalled()
  })

  it('起動時と一定間隔で確かめる（enabled のときだけ）', async () => {
    vi.useFakeTimers()
    try {
      const check = vi.fn(async () => ({ state: 'latest', current: '1.0.0', latest: '1.0.0' }) as UpdateCheckResult)
      const off = setup({ enabled: false, check })
      off.updater.start()
      await vi.advanceTimersByTimeAsync(7 * 60 * 60 * 1000)
      expect(check).not.toHaveBeenCalled()
      const on = setup({ check })
      on.updater.start()
      await vi.advanceTimersByTimeAsync(20 * 1000)
      expect(check).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(6 * 60 * 60 * 1000)
      expect(check).toHaveBeenCalledTimes(2)
      on.updater.stop()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('installUpdateOnQuit（閉じたときの入れ替えそのもの）', () => {
  let dir = ''
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'ferret-quit-')) })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))
  const fileFor = (name: string, body: string): VerifiedDownload =>
    ({ version: '2.0.0', name, sha256: sha(body), size: body.length, kind: 'AppImage', url: `${RELEASE_BASE_URL}releases/2.0.0/${name}` })

  it('AppImage: 版を含む名前なら新しい名前で並べて古い方を消す。起動し直さない', async () => {
    const { installUpdateOnQuit } = await import('../../src/main/autoUpdateInstall')
    const current = join(dir, 'Ferret-1.0.0-linux-x86_64.AppImage')
    writeFileSync(current, 'old')
    const downloaded = join(dir, 'download.AppImage')
    writeFileSync(downloaded, 'new body')
    vi.stubEnv('APPIMAGE', current)
    expect(installUpdateOnQuit('appimage', downloaded, fileFor('Ferret-2.0.0-linux-x86_64.AppImage', 'new body'))).toBe(true)
    const placed = join(dir, 'Ferret-2.0.0-linux-x86_64.AppImage')
    expect(readFileSync(placed, 'utf8')).toBe('new body')
    // Windows のファイルには実行の権限が無い
    if (process.platform !== 'win32') expect(statSync(placed).mode & 0o111).not.toBe(0)
    expect(existsSync(current)).toBe(false)
  })

  it('落としてから閉じるまでに中身が変わっていれば入れない。macOS（Squirrel.Mac が入れる）・deb は何もしない', async () => {
    const { installUpdateOnQuit } = await import('../../src/main/autoUpdateInstall')
    const current = join(dir, 'Ferret.AppImage')
    writeFileSync(current, 'old')
    const downloaded = join(dir, 'download.AppImage')
    writeFileSync(downloaded, 'swapped')
    vi.stubEnv('APPIMAGE', current)
    expect(() => installUpdateOnQuit('appimage', downloaded, fileFor('Ferret-2.0.0-linux-x86_64.AppImage', 'new body'))).toThrow()
    expect(readFileSync(current, 'utf8')).toBe('old')
    expect(installUpdateOnQuit('squirrel-mac', downloaded, fileFor('Ferret-2.0.0-mac-arm64.zip', 'swapped'))).toBe(false)
    expect(installUpdateOnQuit('deb', downloaded, fileFor('Ferret-2.0.0-linux-amd64.deb', 'swapped'))).toBe(false)
  })
})

describe('リリースの手順（自動更新用の zip と UPDATE-SHA256SUMS）', () => {
  const base = { version: '0.5.0', date: '2026-10-04T00:00:00Z', prerelease: false, notes: '', product: 'Ferret' }
  const dmg = { name: 'Ferret-0.5.0-mac-arm64.dmg', os: 'mac' as const, arch: 'arm64', kind: 'dmg', size: 10, sha256: 'a'.repeat(64) }
  const zip = { name: 'Ferret-0.5.0-mac-arm64.zip', os: 'mac' as const, arch: 'arm64', kind: 'zip', size: 11, sha256: 'b'.repeat(64) }

  it('zip は自動更新用の名前として読み、インストーラーの名前にはしない（サイト・0.4.x のアプリの files に入れない）', () => {
    expect(parseUpdateArtifactName('Ferret-0.5.0-mac-arm64.zip', '0.5.0')).toEqual({ name: 'Ferret-0.5.0-mac-arm64.zip', product: 'Ferret', os: 'mac', arch: 'arm64', kind: 'zip' })
    expect(parseUpdateArtifactName('Ferret-0.5.0-mac-arm64.zip.blockmap', '0.5.0')).toBeNull()
    expect(parseUpdateArtifactName('Ferret-0.4.0-mac-arm64.zip', '0.5.0')).toBeNull()
    expect(parseUpdateArtifactName('Ferret-0.5.0-win-x64.zip', '0.5.0')).toBeNull()
    expect(parseArtifactName('Ferret-0.5.0-mac-arm64.zip', '0.5.0')).toBeNull()
  })

  it('manifest は zip を updates に分けて置き、検証・差し替え・片付けの対象に含める', () => {
    const m = buildManifest({ ...base, files: [dmg], updates: [zip] })
    expect(m.files.map((f) => f.name)).toEqual([dmg.name])
    expect(m.updates).toEqual([{ ...zip, path: 'releases/0.5.0/Ferret-0.5.0-mac-arm64.zip' }])
    expect(validateManifest(m, '0.5.0')).toBe(m)
    expect(allFiles(m).map((f) => f.name)).toEqual([dmg.name, zip.name])
    const rebuilt = buildManifest({ ...base, files: [dmg], updates: [zip], build: 2 })
    expect(obsoleteFiles(m, rebuilt)).toEqual(['releases/0.5.0/Ferret-0.5.0-mac-arm64.dmg', 'releases/0.5.0/Ferret-0.5.0-mac-arm64.zip'])
    // updates が無い版（0.4.x まで）は今までと同じ形
    expect(buildManifest({ ...base, files: [dmg] })).not.toHaveProperty('updates')
  })

  it('updates の名前・path・sha256 の形が違えば止める', () => {
    const m = buildManifest({ ...base, files: [dmg], updates: [zip] })
    expect(() => validateManifest({ ...m, updates: [{ ...m.updates![0]!, name: 'Ferret-0.5.0-mac-arm64.dmg' }] }, '0.5.0')).toThrow(/自動更新のファイル名/)
    expect(() => validateManifest({ ...m, updates: [{ ...m.updates![0]!, path: 'releases/0.4.0/Ferret-0.5.0-mac-arm64.zip' }] }, '0.5.0')).toThrow(/path/)
    expect(() => validateManifest({ ...m, updates: [{ ...m.updates![0]!, sha256: 'xyz' }] }, '0.5.0')).toThrow(/sha256/)
    expect(() => validateManifest({ ...m, updates: [] }, '0.5.0')).toThrow(/updates/)
  })

  it('UPDATE-SHA256SUMS と updates が過不足なく一致しなければ公開しない', () => {
    const m = buildManifest({ ...base, files: [dmg], updates: [zip] })
    expect(() => assertUpdatesMatchSums(m, parseSha256Sums(`${zip.sha256}  ${zip.name}\n`))).not.toThrow()
    expect(() => assertUpdatesMatchSums(m, parseSha256Sums(`${'c'.repeat(64)}  ${zip.name}\n`))).toThrow(/sha256/)
    expect(() => assertUpdatesMatchSums(m, null)).toThrow(/UPDATE-SHA256SUMS/)
    expect(() => assertUpdatesMatchSums(buildManifest({ ...base, files: [dmg] }), parseSha256Sums(`${zip.sha256}  ${zip.name}\n`))).toThrow()
    expect(() => assertUpdatesMatchSums(buildManifest({ ...base, files: [dmg] }), null)).not.toThrow()
  })
})
