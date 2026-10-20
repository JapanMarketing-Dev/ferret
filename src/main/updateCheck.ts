import { app, net } from 'electron'
import { compareAppVersions, isValidAppVersion, pickAppVersion, type UpdateCheckResult } from '@shared/appVersion'
// package.json はビルド時に埋め込む（dev 起動では app.getAppPath() がプロジェクト直下を指さないことがある）
import { version } from '../../package.json'
import { t } from '@shared/i18n'
import { IS_PACKAGED } from './runtime'
import { reportHandled } from '@shared/report'
import { SMALL_JSON_MAX_BYTES, readBoundedBytes, readBoundedJson, readBoundedText } from './boundedResponse'
import { RELEASE_PUBLIC_KEY, SIGNED_SUMS_MAX_BYTES, UPDATE_SUMS_NAME, verifiedReleaseFiles, verifiedUpdateFiles, type SignedReleaseFile, type SignedUpdateFile } from './releaseSignature'

/**
 * 更新の確認（フッターの「更新を確認」）。
 *
 * Orca は electron-updater で配布フィードを見て、ダウンロード・再起動まで行う
 * （~/bench/orca/src/main/updater.ts, updater/updater-setup.ts）。
 * このアプリは electron-updater を入れていない（署名・配布フィードも未整備）ので、
 * 配信元（R2）の latest.json と package.json の version を比べて案内するだけにする。
 * dev 起動でも同じで、自動で入れ替えることはしない。
 * latest.json は Cache-Control: max-age=300 で配られ、GitHub API のような回数の上限も認証も要らない。
 * 新しい版を案内する前に、releases/<版>/SHA256SUMS の署名を同梱の公開鍵で確かめ、latest.json のファイルの sha256 が
 * それに載っていることを確かめる（security-3 [2]。R2 だけを書き換えられても、偽の版へ案内しない。src/main/releaseSignature.ts）。
 * 確かめた版・名前・sha256 は main に持ったまま、「ダウンロード」でアプリが落として sha256 を確かめてから保存する
 * （security-4 [7]。ブラウザでサイトを開き直すと、確かめたあとに書き換えられた R2 の中身を選びうる。updateDownload.ts）。
 * 裏でのダウンロードと入れ替え（自動更新）は src/main/autoUpdate.ts。ここで確かめたファイルだけを使う。
 */

/** 配信元。独自ドメインへ移すときはここだけ変える（今は r2.dev の開発用 URL） */
export const RELEASE_BASE_URL = 'https://pub-588d93b3e875464f98d6cf98dc711a0c.r2.dev/'

/**
 * E2E だけの差し替え（偽の配信元と、その配信元の署名の鍵）。配布版（IS_PACKAGED）では読まない。
 * 配信元は手元のループバック（http://127.0.0.1:<port>/）だけを受け付ける
 */
export function e2eReleaseOverride(
  name: 'FERRET_E2E_RELEASE_BASE_URL' | 'FERRET_E2E_RELEASE_KEY',
  env: Record<string, string | undefined> = process.env,
  packaged: boolean = IS_PACKAGED
): string | null {
  if (packaged || env.ADE_E2E !== '1') return null
  const value = env[name]?.trim()
  if (!value) return null
  if (name === 'FERRET_E2E_RELEASE_BASE_URL') return /^http:\/\/127\.0\.0\.1:\d{2,5}\/$/.test(value) ? value : null
  return /^ssh-ed25519 [A-Za-z0-9+/=]+$/.test(value) ? value : null
}
const e2eOverride = (name: Parameters<typeof e2eReleaseOverride>[0]): string | null => e2eReleaseOverride(name)

/** いま使う配信元（ふだんは RELEASE_BASE_URL。E2E だけ偽の配信元） */
export function releaseBase(): string {
  return e2eOverride('FERRET_E2E_RELEASE_BASE_URL') ?? RELEASE_BASE_URL
}

/** 配布物の署名を確かめる公開鍵（ふだんは同梱の RELEASE_PUBLIC_KEY。E2E だけ偽の配信元の鍵） */
function releaseTrustKey(): string {
  return e2eOverride('FERRET_E2E_RELEASE_KEY') ?? RELEASE_PUBLIC_KEY
}

/** E2E の偽の配信元で動いているか（autoUpdate.ts が、本物の入れ替えをせずに流れだけを通すのに使う） */
export function usingE2eReleaseServer(): boolean {
  return e2eOverride('FERRET_E2E_RELEASE_BASE_URL') !== null && e2eOverride('FERRET_E2E_RELEASE_KEY') !== null
}
/** ダウンロードサイト（Workers の静的配信）。空にすると R2 上の自分の OS・CPU 向けファイルを直接開く */
export const DOWNLOAD_PAGE_URL = 'https://ferretade.dev/download'

const TIMEOUT_MS = 8000

/**
 * アプリの版。フッターの表示と更新確認の比較の両方で使う。
 * dev 起動の app.getVersion() は Electron の版を返すので、package.json の version を優先する。
 */
export function appVersion(): string {
  return pickAppVersion(version, app.getVersion())
}

/** latest.json の1ファイル（download-site と合意した形） */
export interface ReleaseFile {
  name: string
  path: string
  size: number
  sha256: string
  os: 'mac' | 'win' | 'linux'
  arch: 'arm64' | 'x64'
  kind: 'dmg' | 'exe' | 'AppImage' | 'deb'
  preview?: true
}

export interface ReleaseManifest {
  schema: 1
  version: string
  date: string
  prerelease: boolean
  notes: string
  notesUrl?: string
  files: ReleaseFile[]
  /** 自動更新だけが使うファイル（macOS の zip）。UPDATE-SHA256SUMS に載る。サイトには出さない */
  updates?: Array<{ name: string; path: string; size: number; sha256: string }>
}

const OS_OF: Partial<Record<NodeJS.Platform, ReleaseFile['os']>> = { darwin: 'mac', win32: 'win', linux: 'linux' }
/** Linux は AppImage を先に勧める（どの配布でも動く） */
const KIND_ORDER: ReleaseFile['kind'][] = ['dmg', 'exe', 'AppImage', 'deb']

/** 取得した JSON を確かめる。形が違えば null（単体テストから使うため export） */
export function parseManifest(raw: unknown): ReleaseManifest | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Partial<ReleaseManifest>
  if (r.schema !== 1 || typeof r.version !== 'string' || !Array.isArray(r.files)) return null
  const files = r.files.filter((f): f is ReleaseFile =>
    !!f && typeof f === 'object' && typeof f.path === 'string' && typeof f.name === 'string' &&
    (f.os === 'mac' || f.os === 'win' || f.os === 'linux') && (f.arch === 'arm64' || f.arch === 'x64'))
  return {
    schema: 1,
    version: r.version,
    date: typeof r.date === 'string' ? r.date : '',
    prerelease: r.prerelease === true,
    notes: typeof r.notes === 'string' ? r.notes : '',
    ...(typeof r.notesUrl === 'string' ? { notesUrl: r.notesUrl } : {}),
    files,
    ...(Array.isArray(r.updates)
      ? { updates: r.updates.filter((f): f is NonNullable<ReleaseManifest['updates']>[number] =>
        !!f && typeof f === 'object' && typeof f.name === 'string' && typeof f.path === 'string' && typeof f.size === 'number' && typeof f.sha256 === 'string') }
      : {})
  }
}

/** 自分の OS・CPU に合うファイル。正式版を先に、種類は KIND_ORDER の順で選ぶ */
export function pickReleaseFile(files: readonly ReleaseFile[], platform: NodeJS.Platform, arch: string): ReleaseFile | null {
  const os = OS_OF[platform]
  if (!os) return null
  const candidates = files.filter((f) => f.os === os && f.arch === arch)
  candidates.sort((a, b) => Number(!!a.preview) - Number(!!b.preview) || KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind))
  return candidates[0] ?? null
}

/**
 * 版を比べて結果にする。新しい版なら開く先を決める：
 * ダウンロードサイトが決まっていればそこ、無ければ R2 上の自分向けファイル、それも無ければ latest.json の notesUrl。
 */
export function judgeManifest(
  current: string,
  manifest: ReleaseManifest,
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
  downloadPage: string = DOWNLOAD_PAGE_URL
): UpdateCheckResult {
  const latest = manifest.version.trim().replace(/^v/i, '')
  if (!isValidAppVersion(latest)) return { state: 'error', current, message: t('update.errors.badVersion', { tag: manifest.version }) }
  if (compareAppVersions(latest, current) <= 0) return { state: 'latest', current, latest }
  const file = pickReleaseFile(manifest.files, platform, arch)
  // path に別のサイトの絶対URLが入っていても開かない（配信元の下だけ）
  const base = releaseBase()
  const fileUrl = file ? new URL(file.path.replace(/^\/+/, ''), base).toString() : ''
  const url = downloadPage ||
    (fileUrl.startsWith(base) ? fileUrl : '') ||
    (manifest.notesUrl?.startsWith('https://') ? manifest.notesUrl : base)
  return { state: 'available', current, latest, url }
}

/**
 * 確認できなかったことを Sentry へ warning（area: update）で知らせる。理由の種類だけを付ける（URL・本文は付けない）。
 * ネットワークの失敗（network / timeout）も、配信元の不調に気づけるよう送る。ただし端末がネットワークにつながっていない
 * （net.isOnline() が false）ときの network は送らず、つながっていても続けて UPDATE_NETWORK_REPORT_AFTER 回失敗したときだけ送る
 * （checkForUpdate）。利用者の側の一時的な事情で、配信元やアプリの不調ではない。
 */
function reportCheckFailure(reason: 'http' | 'bad-manifest' | 'bad-version' | 'network' | 'timeout' | 'unsigned' | 'unsigned-update', err?: unknown): void {
  // net の失敗の文（net::ERR_…）は手がかりになるので残す。URL は送る前の除去で落ちる
  reportHandled(err instanceof Error ? err : new Error(`update check failed: ${reason}`), { area: 'update', op: `check update: ${reason}` })
}

/**
 * releases/<版>/SHA256SUMS(.sig) を取り、署名と latest.json のファイルを突き合わせる。
 * 確かめたファイル / 'unsigned'（無い・合わない。恒久的）/ 一時的な HTTP の失敗（5xx・429）はその状態の数。ネットワークの失敗は例外のまま
 */
async function releaseSignature(fetcher: typeof net.fetch, manifest: ReleaseManifest, latest: string, signal: AbortSignal): Promise<SignedReleaseFile[] | 'unsigned' | number> {
  // latest は judgeManifest が版の形を確かめたもの。配信元の下の固定の名前だけを読む
  const base = new URL(`releases/${latest}/`, releaseBase())
  // 配信元の外へのリダイレクトは追わない（security-7 [12]。中身の署名とは別に、行き先を配信元に留める）
  const responses = await Promise.all(['SHA256SUMS', 'SHA256SUMS.sig'].map((name) => fetcher(new URL(name, base).toString(), { signal, redirect: 'error' })))
  const transient = responses.find((r) => r.status >= 500 || r.status === 429)
  if (transient) return transient.status
  const [sumsRes, sigRes] = responses as [Response, Response]
  if (!sumsRes.ok || !sigRes.ok) return 'unsigned'
  const sums = await readBoundedBytes(sumsRes, SIGNED_SUMS_MAX_BYTES)
  const signature = await readBoundedText(sigRes, SIGNED_SUMS_MAX_BYTES)
  // 版・製品・OS・CPU・種類・置き場所は、署名した名前と版から作る（manifest の値は使わない。security-4 [3]）
  return verifiedReleaseFiles(latest, manifest.files, sums, signature, releaseTrustKey()) ?? 'unsigned'
}

/**
 * releases/<版>/UPDATE-SHA256SUMS(.sig) を取り、latest.json の updates（macOS の zip）を突き合わせる。
 * 無い・合わない・取れないときは空（自動更新はせず、インストーラーの「ダウンロード」を出す）。案内そのものは止めない
 */
async function updateSignature(fetcher: typeof net.fetch, manifest: ReleaseManifest, latest: string, signal: AbortSignal): Promise<SignedUpdateFile[]> {
  if (!manifest.updates?.length) return []
  try {
    const base = new URL(`releases/${latest}/`, releaseBase())
    const [sumsRes, sigRes] = await Promise.all([UPDATE_SUMS_NAME, `${UPDATE_SUMS_NAME}.sig`].map((name) => fetcher(new URL(name, base).toString(), { signal, redirect: 'error' }))) as [Response, Response]
    if (!sumsRes.ok || !sigRes.ok) return []
    const sums = await readBoundedBytes(sumsRes, SIGNED_SUMS_MAX_BYTES)
    const signature = await readBoundedText(sigRes, SIGNED_SUMS_MAX_BYTES)
    const signed = verifiedUpdateFiles(latest, manifest.updates, sums, signature, releaseTrustKey())
    if (!signed) reportCheckFailure('unsigned-update')
    return signed ?? []
  } catch {
    return []
  }
}

/** 署名で確かめた、この OS・CPU 向けのファイル（アプリが落とすもの）。確かめるたびに置き換える */
export interface VerifiedDownload {
  version: string
  name: string
  sha256: string
  size: number
  kind: SignedReleaseFile['kind'] | SignedUpdateFile['kind']
  url: string
}
let verified: VerifiedDownload | null = null
/** 最後の確認で署名を確かめた、この版のファイルすべて（インストーラーと自動更新用。autoUpdate.ts が種類で選ぶ） */
let verifiedSet: { version: string; files: ReadonlyArray<SignedReleaseFile | SignedUpdateFile> } | null = null

/** 最後の更新の確認で確かめた、この OS・CPU 向けのファイル。無ければ null */
export function verifiedDownload(): VerifiedDownload | null {
  return verified
}

/** 確かめたファイルから、この OS・CPU 向けのものを選ぶ。URL は配信元の下の、署名した名前の置き場所 */
export function pickVerifiedDownload(version: string, files: readonly SignedReleaseFile[], platform: NodeJS.Platform = process.platform, arch: string = process.arch): VerifiedDownload | null {
  const file = pickReleaseFile(files, platform, arch)
  return file ? toVerifiedDownload(version, file) : null
}

/** 確かめたファイルを、配信元の下の URL 付きにする。配信元の外を指せば null */
function toVerifiedDownload(version: string, file: SignedReleaseFile | SignedUpdateFile): VerifiedDownload | null {
  const base = releaseBase()
  const url = new URL(file.path, base).toString()
  if (!url.startsWith(base)) return null
  return { version, name: file.name, sha256: file.sha256, size: file.size, kind: file.kind, url }
}

/**
 * 確かめたファイルから、この OS・CPU 向けの決まった種類（zip / exe / AppImage / deb）を選ぶ。無ければ null（自動更新はしない）。
 * 自動更新（autoUpdate.ts）が使う。種類は入れ替えの方法で決まる（mac は zip、Windows は exe、Linux は AppImage か deb）
 */
export function pickVerifiedOfKind(
  set: { version: string; files: ReadonlyArray<SignedReleaseFile | SignedUpdateFile> } | null,
  kind: VerifiedDownload['kind'],
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch
): VerifiedDownload | null {
  const os = OS_OF[platform]
  const file = set?.files.find((f) => f.os === os && f.arch === arch && f.kind === kind)
  return set && file ? toVerifiedDownload(set.version, file) : null
}

/** 最後の更新の確認で確かめた、この OS・CPU 向けの決まった種類のファイル */
export function verifiedFileOfKind(kind: VerifiedDownload['kind']): VerifiedDownload | null {
  return pickVerifiedOfKind(verifiedSet, kind)
}

/**
 * 続けてネットワークで確かめられなかった回数。スリープ明け・Wi-Fi の切り替え・VPN のつなぎ直しの直後は、
 * つながっている（isOnline が true）のに DNS などがまだ戻っておらず失敗する（Sentry FERRET-1N: 0.4.16 で明けて1秒後、
 * 期限の過ぎた定期の確認が復帰の通知より先に動いた）。1回きりは端末の事情なので送らず、
 * UPDATE_NETWORK_REPORT_AFTER 回続いたときに1度だけ送る（配信元の不調には気づける）。配信元から返事が来たら数え直す
 */
let networkFailures = 0

/** スリープに入るところで OS が通信を止めた失敗か（単体テストから使う） */
export function isSuspendedNetworkError(err: unknown): boolean {
  return err instanceof Error && err.message.includes('ERR_NETWORK_IO_SUSPENDED')
}
export const UPDATE_NETWORK_REPORT_AFTER = 3

/** 単体テスト用 */
export function resetUpdateNetworkFailuresForTest(): void {
  networkFailures = 0
}

/** 端末がネットワークにつながっているか。分からなければ true（送る側に倒す） */
function deviceOnline(): boolean {
  try {
    return net.isOnline()
  } catch {
    return true
  }
}

export async function checkForUpdate(
  fetcher: typeof net.fetch = net.fetch,
  platform: NodeJS.Platform = process.platform,
  isOnline: () => boolean = deviceOnline
): Promise<UpdateCheckResult> {
  const current = appVersion()
  verified = null
  verifiedSet = null
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const res = await fetcher(new URL('latest.json', releaseBase()).toString(), { headers: { Accept: 'application/json' }, signal: controller.signal, redirect: 'error' })
    networkFailures = 0
    // まだ latest.json を置いていない。失敗ではなく案内として出す
    if (res.status === 404 || res.status === 403) return { state: 'no-release', current }
    if (!res.ok) {
      reportCheckFailure('http', new Error(`update check failed: HTTP ${res.status}`))
      return { state: 'error', current, message: t('update.errors.http', { status: res.status }) }
    }
    const manifest = parseManifest(await readBoundedJson(res, SMALL_JSON_MAX_BYTES).catch(() => null))
    if (!manifest) {
      reportCheckFailure('bad-manifest')
      return { state: 'error', current, message: t('update.errors.badManifest') }
    }
    const result = judgeManifest(current, manifest)
    if (result.state === 'error') reportCheckFailure('bad-version')
    if (result.state !== 'available') return result
    return await verifyAvailable(fetcher, manifest, result, controller.signal, platform)
  } catch (err) {
    const aborted = err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError')
    // つながっていない端末の失敗（net::ERR_INTERNET_DISCONNECTED・ERR_NAME_NOT_RESOLVED など）は送らない。画面には「確認できなかった」を出す
    // 続いたときだけ送る（networkFailures の説明）
    // スリープに入るところで OS が通信を止めた失敗（net::ERR_NETWORK_IO_SUSPENDED）は数えない。
    // 寝たり起きたりを繰り返す端末で続けて3回になり、送られていた（FERRET-1N 0.6.30 の Windows）
    if ((aborted || isOnline()) && !isSuspendedNetworkError(err) && ++networkFailures === UPDATE_NETWORK_REPORT_AFTER) reportCheckFailure(aborted ? 'timeout' : 'network', err)
    return { state: 'error', current, message: aborted ? t('update.errors.timeout') : t('update.errors.network') }
  } finally {
    clearTimeout(timer)
  }
}

/** 入れる版の署名を確かめ、この OS 向けのファイルを覚える（新しい版の案内と、選んだ版の両方で使う） */
async function verifyAvailable(
  fetcher: typeof net.fetch,
  manifest: ReleaseManifest,
  result: Extract<UpdateCheckResult, { state: 'available' }>,
  signal: AbortSignal,
  platform: NodeJS.Platform
): Promise<UpdateCheckResult> {
  const current = result.current
  const signed = await releaseSignature(fetcher, manifest, result.latest, signal)
  // 配信元の一時的な不調（5xx・429）は、ネットワークの失敗と同じく「あとで試す」
  if (typeof signed === 'number') {
    reportCheckFailure('http', new Error(`update check failed: HTTP ${signed} (signature)`))
    return { state: 'error', current, message: t('update.errors.http', { status: signed }) }
  }
  if (signed === 'unsigned') {
    reportCheckFailure('unsigned')
    return { state: 'unverified', current, latest: result.latest }
  }
  verified = pickVerifiedDownload(result.latest, signed)
  // 自動更新用のファイル（macOS の zip）は、mac のときだけ取りに行く。確かめられなければ自動更新をせずに案内だけ
  const updates = platform === 'darwin' ? await updateSignature(fetcher, manifest, result.latest, signal) : []
  verifiedSet = { version: result.latest, files: [...signed, ...updates] }
  return result
}

/** 配信元に置いてある版（versions.json。直近の版から）。選んで入れるのに使う */
export interface ReleaseVersionInfo {
  version: string
  date: string
  prerelease: boolean
}

const MAX_LISTED_VERSIONS = 20

/** versions.json を確かめる。形の違う行は捨てる（単体テストから使うため export） */
export function parseVersionsIndex(raw: unknown): ReleaseVersionInfo[] {
  const list = raw && typeof raw === 'object' ? (raw as { versions?: unknown }).versions : null
  if (!Array.isArray(list)) return []
  const seen = new Set<string>()
  return list.flatMap((item): ReleaseVersionInfo[] => {
    const r = item && typeof item === 'object' ? (item as Record<string, unknown>) : null
    const version = typeof r?.version === 'string' ? r.version.trim().replace(/^v/i, '') : ''
    if (!isValidAppVersion(version) || seen.has(version)) return []
    seen.add(version)
    const date = typeof r?.date === 'string' && Number.isFinite(Date.parse(r.date)) ? r.date : ''
    return [{ version, date, prerelease: r?.prerelease === true }]
  }).sort((a, b) => compareAppVersions(b.version, a.version)).slice(0, MAX_LISTED_VERSIONS)
}

/** 配信元の版の一覧。取れなければ空 */
export async function listReleaseVersions(fetcher: typeof net.fetch = net.fetch): Promise<ReleaseVersionInfo[]> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const res = await fetcher(new URL('versions.json', releaseBase()).toString(), { headers: { Accept: 'application/json' }, signal: controller.signal, redirect: 'error' })
    if (!res.ok) return []
    return parseVersionsIndex(await readBoundedJson(res, SMALL_JSON_MAX_BYTES).catch(() => null))
  } catch {
    // つながらない（想定内）。一覧を出さないだけ
    return []
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 選んだ版（古い版へ戻すことも含む）を入れられるか確かめる。releases/<版>/manifest.json を読み、新しい版の案内と同じく
 * 署名した SHA256SUMS で中身を確かめてから、この OS 向けのファイルを覚える。今と同じ版なら latest
 */
export async function checkForVersion(version: string, fetcher: typeof net.fetch = net.fetch, platform: NodeJS.Platform = process.platform): Promise<UpdateCheckResult> {
  const current = appVersion()
  const wanted = version.trim().replace(/^v/i, '')
  if (!isValidAppVersion(wanted)) return { state: 'error', current, message: t('update.errors.badVersion', { tag: version }) }
  if (compareAppVersions(wanted, current) === 0) return { state: 'latest', current, latest: wanted }
  verified = null
  verifiedSet = null
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const res = await fetcher(new URL(`releases/${wanted}/manifest.json`, releaseBase()).toString(), { headers: { Accept: 'application/json' }, signal: controller.signal, redirect: 'error' })
    if (!res.ok) return { state: 'error', current, message: t('update.errors.http', { status: res.status }) }
    const manifest = parseManifest(await readBoundedJson(res, SMALL_JSON_MAX_BYTES).catch(() => null))
    if (!manifest || manifest.version.trim().replace(/^v/i, '') !== wanted) return { state: 'error', current, message: t('update.errors.badManifest') }
    // 新しい版の案内と同じ形にする（古い版でも available として扱い、確かめたファイルを落とす）
    const judged = judgeManifest('0.0.0', manifest, platform)
    if (judged.state !== 'available') return { state: 'error', current, message: t('update.errors.badManifest') }
    return await verifyAvailable(fetcher, manifest, { ...judged, current }, controller.signal, platform)
  } catch (err) {
    const aborted = err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError')
    return { state: 'error', current, message: aborted ? t('update.errors.timeout') : t('update.errors.network') }
  } finally {
    clearTimeout(timer)
  }
}
