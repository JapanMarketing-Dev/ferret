import { defaultUrlLabel } from './projectUrl'
import type { CaptureSourceInfo, ProjectKind, ProjectTarget, TargetPurpose } from './types'

/**
 * プロジェクトの種類と確認先（ターゲット）の純粋な関数。main（設定の読み込み）と renderer（編集・ボタン）で共有する。
 *
 * 確認先は名前が自由で、件数の上限は無い。local / dev / prd は新しく足すときの名前の候補でしかない。
 * 種類によって確認先に入れるものが変わるが、データは種類を変えても失わないよう、どの種類でも全項目を保つ
 * （画面がその種類で使う欄だけを出す）。
 */

export const PROJECT_KINDS: readonly ProjectKind[] = ['web', 'mobile', 'desktop', 'other', 'video']
export const DEFAULT_PROJECT_KIND: ProjectKind = 'web'

/** 種類ごとに画面へ出す欄 */
export const KIND_FIELDS: Record<ProjectKind, { url: boolean; launchCommand: boolean; windowMatch: boolean }> = {
  web: { url: true, launchCommand: false, windowMatch: false },
  mobile: { url: true, launchCommand: true, windowMatch: true },
  desktop: { url: true, launchCommand: true, windowMatch: true },
  other: { url: true, launchCommand: true, windowMatch: true },
  // 動画のチャンネル。確認先は使わないが、公開先の URL（チャンネルのページなど）は置ける
  video: { url: true, launchCommand: false, windowMatch: false }
}

/** 新しく足すときの名前の候補（順に、まだ使っていないものを選ぶ） */
export const SUGGESTED_LABELS: Record<ProjectKind, readonly string[]> = {
  web: ['local', 'dev', 'prd', 'staging', 'preview'],
  mobile: ['iOS sim', 'Android emu', 'mobile web'],
  desktop: ['dev', 'app'],
  other: ['target'],
  video: ['channel']
}

/** 欄の入力例（placeholder） */
export const KIND_PLACEHOLDERS: Record<ProjectKind, { url: string; launchCommand: string; windowMatch: string }> = {
  web: { url: 'http://localhost:3000', launchCommand: '', windowMatch: '' },
  mobile: { url: 'http://localhost:8081', launchCommand: 'open -a Simulator', windowMatch: 'Simulator' },
  desktop: { url: 'http://localhost:1420', launchCommand: 'pnpm tauri dev', windowMatch: 'MyApp' },
  other: { url: 'http://localhost:3000', launchCommand: './run.sh', windowMatch: '' },
  video: { url: 'https://www.youtube.com/@channel', launchCommand: '', windowMatch: '' }
}

export function sanitizeProjectKind(raw: unknown): ProjectKind {
  return PROJECT_KINDS.includes(raw as ProjectKind) ? (raw as ProjectKind) : DEFAULT_PROJECT_KIND
}

// ───────────────────────── 確認先の区分（アプリ・デザイン・設計書）─────────────────────────

/**
 * 確認先の区分。開発中のアプリのほか、デザイン（Figma など）や設計書（Google Docs・Notion など）も
 * 同じ内蔵ブラウザで開いて録画・指摘できる。区分は feedback.md と Agent への指示に書き、
 * Agent が「コードではなくデザイン・文書を直す」と判断できるようにする。
 */
export const TARGET_PURPOSES: readonly TargetPurpose[] = ['app', 'design', 'doc', 'reference']
export const DEFAULT_TARGET_PURPOSE: TargetPurpose = 'app'

/** 区分ごとの名前の候補（app はプロジェクトの種類の候補を使う） */
export const PURPOSE_LABELS: Record<Exclude<TargetPurpose, 'app'>, readonly string[]> = {
  design: ['Figma', 'Design', 'Prototype', 'Penpot', 'Canva'],
  doc: ['Spec', 'PRD', 'Design doc', 'Notion', 'Docs'],
  reference: ['Reference', 'Competitor', 'Inspiration']
}

/** 区分ごとの URL の入力例 */
export const PURPOSE_URL_PLACEHOLDERS: Record<Exclude<TargetPurpose, 'app'>, string> = {
  design: 'https://www.figma.com/design/…',
  doc: 'https://docs.google.com/document/d/…',
  reference: 'https://www.example.com'
}

function sanitizeTargetPurpose(raw: unknown): TargetPurpose {
  return TARGET_PURPOSES.includes(raw as TargetPurpose) ? (raw as TargetPurpose) : DEFAULT_TARGET_PURPOSE
}

/** 確認先の区分（未設定・壊れた値は app） */
export function purposeOf(target: { purpose?: unknown } | null | undefined): TargetPurpose {
  return sanitizeTargetPurpose(target?.purpose)
}

/** ホスト名がこれか、そのサブドメインか */
const onHost = (host: string, domain: string) => host === domain || host.endsWith(`.${domain}`)

const DESIGN_HOSTS = ['figma.com', 'penpot.app', 'canva.com', 'sketch.com', 'zeplin.io', 'invisionapp.com', 'miro.com',
  'whimsical.com', 'xd.adobe.com', 'protopie.io', 'uizard.io', 'excalidraw.com', 'framer.com']
const DOC_HOSTS = ['docs.google.com', 'drive.google.com', 'notion.so', 'notion.site', 'notion.com', 'quip.com', 'coda.io',
  'paper.dropbox.com', 'sharepoint.com', 'onedrive.live.com', 'hackmd.io', 'scrapbox.io', 'cosense.app', 'esa.io', 'kibe.la',
  'docbase.io', 'gitbook.io', 'dropbox.com']

/**
 * URL から区分を推し量る（確認先を足すときの初期値。外れたら利用者が選び直す）。
 * localhost や知らないホストは app。PDF・GitHub / GitLab の Markdown や wiki・Confluence は doc。
 */
export function guessTargetPurpose(url: string): TargetPurpose {
  let parsed: URL
  try {
    parsed = new URL(url.trim())
  } catch {
    return 'app'
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return 'app'
  const host = parsed.hostname.toLowerCase()
  const path = parsed.pathname.toLowerCase()
  if (DESIGN_HOSTS.some((d) => onHost(host, d))) return 'design'
  if (DOC_HOSTS.some((d) => onHost(host, d))) return 'doc'
  if (/\.pdf$/.test(path)) return 'doc'
  if (host.includes('confluence') || (onHost(host, 'atlassian.net') && path.startsWith('/wiki'))) return 'doc'
  if (onHost(host, 'github.com') || onHost(host, 'gitlab.com')) {
    if (/\.(md|markdown|mdx|adoc|rst)$/.test(path) || /\/wikis?(\/|$)/.test(path)) return 'doc'
  }
  return 'app'
}

// ───────────────────────── 参考（外部サイト）の見分け ─────────────────────────

/** 名前が参考・競合のサイトを指しているか（「競合:調達info」「参考 A社」「Competitor」「reference」など。大文字小文字は問わない） */
export function looksLikeReferenceLabel(label: string | undefined): boolean {
  const l = (label ?? '').normalize('NFKC').toLowerCase()
  return /競合|参考|competitor|reference/.test(l)
}

/**
 * 登録した確認先の、指摘での区分。登録の区分をそのまま使い、アプリのままでも名前が参考・競合を指していれば reference
 * （区分を選ばずに競合のサイトを登録した場合も、Agent にそのサイトを直させない）
 */
export function registeredPurpose(target: { purpose?: unknown; label?: string; url?: string }): TargetPurpose {
  const purpose = purposeOf(target)
  return purpose === 'app' && looksLikeReferenceLabel(target.label) ? 'reference' : purpose
}

/** 手元・社内のホスト（localhost・127.0.0.1・::1・*.local・*.localhost・*.test・*.internal・プライベートの IPv4） */
export function isLocalHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '')
  if (!host || host === 'localhost' || host === '::1' || host === '0.0.0.0') return true
  if (/\.(local|localhost|test|internal|lan|home\.arpa)$/.test(host)) return true
  const ip = host.match(/^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/)
  if (ip) {
    const a = Number(ip[1])
    const b = Number(ip[2])
    return a === 127 || a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31) || (a === 169 && b === 254)
  }
  return false
}

const bareHost = (host: string) => host.toLowerCase().replace(/^www\./, '')

/** 同じサイトのホストか（同じ・どちらかがもう一方のサブドメイン。www. は無視） */
function sameSite(a: string, b: string): boolean {
  const x = bareHost(a)
  const y = bareHost(b)
  return x === y || x.endsWith(`.${y}`) || y.endsWith(`.${x}`)
}

/**
 * 登録に当たらない URL の区分（指摘の対象・右パネルの候補）。
 *   1. ホストから分かるデザイン・設計書（Figma・Google Docs など）はそのまま design / doc
 *   2. 手元のホスト（localhost など）は app
 *   3. プロジェクトにアプリの確認先（URL のあるもの。local / dev / prd）が1つ以上あり、そのどのホストとも同じサイトでなければ、
 *      録画中に見に行った外部のサイト（競合・お手本）とみなして reference
 *   4. アプリの確認先が1つも無ければ、自分のアプリのホストが分からないので app のまま（何でも参考にしない）
 * 参考と見なしても Agent に渡す指示は「自分のアプリに取り入れる・避ける」なので、自分のサイトを取り違えても害は小さい
 */
export function unregisteredUrlPurpose(url: string, presets: ReadonlyArray<{ url?: string; purpose?: unknown; label?: string }> = []): TargetPurpose {
  const guessed = guessTargetPurpose(url)
  if (guessed !== 'app') return guessed
  let host: string
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return 'app'
    host = parsed.hostname
  } catch {
    return 'app'
  }
  if (isLocalHost(host)) return 'app'
  const appHosts = presets.flatMap((p) => {
    if (!p.url || registeredPurpose(p) !== 'app') return []
    try {
      return [new URL(p.url).hostname]
    } catch {
      return []
    }
  })
  if (appHosts.length === 0) return 'app'
  return appHosts.some((h) => sameSite(h, host)) ? 'app' : 'reference'
}

const text = (v: unknown, max = 2000): string => (typeof v === 'string' ? v.trim().slice(0, max) : '')

/** URL・起動コマンド・ウインドウのどれも無い確認先は、何もできないので捨てる */
export function hasTargetContent(target: Pick<ProjectTarget, 'url' | 'launchCommand' | 'windowMatch'>): boolean {
  return !!(target.url || target.launchCommand || target.windowMatch)
}

/**
 * 設定ファイルの確認先を型どおりに直す。
 * URL だけを持っていた頃の {id, label, url} はそのまま通る（移行で何も失わない）。
 * id が無いもの・重なるものには新しい id を振る。名前が無ければ中身から付ける。
 */
export function sanitizeProjectTargets(raw: unknown, newId: () => string = () => crypto.randomUUID()): ProjectTarget[] {
  if (!Array.isArray(raw)) return []
  const seen = new Set<string>()
  return raw.flatMap((item): ProjectTarget[] => {
    if (!item || typeof item !== 'object') return []
    const r = item as Partial<Record<keyof ProjectTarget, unknown>>
    const url = text(r.url)
    const launchCommand = text(r.launchCommand)
    const windowMatch = text(r.windowMatch, 200)
    if (!url && !launchCommand && !windowMatch) return []
    let id = text(r.id, 200)
    if (!id || seen.has(id)) id = newId()
    seen.add(id)
    const label = text(r.label, 100) || url || windowMatch || launchCommand
    // 区分は app 以外のときだけ持つ（無い・知らない値は app。区分の無かった頃の設定もそのまま app）
    const purpose = sanitizeTargetPurpose(r.purpose)
    // 録画中の待ち受けは、ウインドウの名前があるときだけ持つ（@shared/captureTracks）
    const watch = windowMatch && (r.watch === 'record' || r.watch === 'switch') ? r.watch : undefined
    return [{ id, label, ...(url ? { url } : {}), ...(launchCommand ? { launchCommand } : {}), ...(windowMatch ? { windowMatch } : {}),
      ...(watch ? { watch } : {}), ...(purpose !== 'app' ? { purpose } : {}) }]
  })
}

/** まだ使っていない候補の名前。候補を使い切ったら「候補 2」「候補 3」…（デザイン・設計書は区分の候補から） */
export function suggestTargetLabel(kind: ProjectKind, targets: readonly Pick<ProjectTarget, 'label'>[], purpose: TargetPurpose = 'app'): string {
  const used = new Set(targets.map((t) => t.label.trim().toLowerCase()))
  const candidates = purpose === 'app' ? SUGGESTED_LABELS[kind] : PURPOSE_LABELS[purpose]
  const free = candidates.find((label) => !used.has(label.toLowerCase()))
  if (free) return free
  const base = candidates[0] ?? 'target'
  for (let n = 2; ; n++) if (!used.has(`${base} ${n}`.toLowerCase())) return `${base} ${n}`
}

/** 確認先を末尾に足す（編集中は中身が空でもよい。保存時の sanitize で空のものは落ちる） */
export function addTarget(targets: readonly ProjectTarget[], kind: ProjectKind, init: Partial<Omit<ProjectTarget, 'id'>> = {}, id: string = crypto.randomUUID()): ProjectTarget[] {
  return [...targets, { id, label: init.label ?? suggestTargetLabel(kind, targets, purposeOf(init)), ...stripEmpty(init) }]
}

export function updateTarget(targets: readonly ProjectTarget[], id: string, patch: Partial<Omit<ProjectTarget, 'id'>>): ProjectTarget[] {
  return targets.map((t) => {
    if (t.id !== id) return t
    const merged: ProjectTarget = { ...t, ...patch }
    // 空にした欄は消す（設定ファイルに空文字を残さない）
    for (const key of ['url', 'launchCommand', 'windowMatch'] as const) if (!merged[key]?.trim()) delete merged[key]
    if (!merged.watch || !merged.windowMatch) delete merged.watch
    if (purposeOf(merged) === 'app') delete merged.purpose
    return merged
  })
}

export function removeTarget(targets: readonly ProjectTarget[], id: string): ProjectTarget[] {
  return targets.filter((t) => t.id !== id)
}

/** from の位置の確認先を to の位置へ動かす（範囲外は端に寄せる） */
export function moveTarget(targets: readonly ProjectTarget[], from: number, to: number): ProjectTarget[] {
  if (from < 0 || from >= targets.length) return [...targets]
  const list = [...targets]
  const [item] = list.splice(from, 1)
  list.splice(Math.max(0, Math.min(to, list.length)), 0, item!)
  return list
}

function stripEmpty(init: Partial<Omit<ProjectTarget, 'id'>>): Partial<ProjectTarget> {
  const out: Partial<ProjectTarget> = {}
  for (const key of ['url', 'launchCommand', 'windowMatch'] as const) if (init[key]?.trim()) out[key] = init[key]!.trim()
  if (out.windowMatch && (init.watch === 'record' || init.watch === 'switch')) out.watch = init.watch
  if (purposeOf(init) !== 'app') out.purpose = purposeOf(init)
  return out
}

/**
 * URL を変えたときの区分。区分がいまの URL から推した値のまま（＝利用者が選び直していない）なら、新しい URL から推し直す。
 * 選び直していれば、その区分を保つ
 */
export function purposeAfterUrlChange(target: Pick<ProjectTarget, 'url' | 'purpose'>, nextUrl: string): TargetPurpose {
  const current = purposeOf(target)
  return current === guessTargetPurpose(target.url ?? '') ? guessTargetPurpose(nextUrl) : current
}

/** 名前が自動で付いた候補のままか（空・種類や区分の候補・URL から付けた local / dev / stg / prd・「候補 2」の形） */
export function isSuggestedLabel(label: string, kind: ProjectKind): boolean {
  const l = label.trim().toLowerCase()
  if (!l) return true
  const candidates = [...SUGGESTED_LABELS[kind], ...PURPOSE_LABELS.design, ...PURPOSE_LABELS.doc, ...PURPOSE_LABELS.reference, 'local', 'dev', 'stg', 'prd'].map((c) => c.toLowerCase())
  return candidates.some((c) => l === c || (l.startsWith(`${c} `) && /^\d+$/.test(l.slice(c.length + 1))))
}

/**
 * 編集欄の変更に、区分の追従を足す。
 *   - URL を変えたら、区分を選び直していない限り URL から推し直す（figma.com → design など）
 *   - 区分が変わったら、名前が自動の候補のままなら新しい区分の候補に付け直す（local → Figma など）
 * siblings は同じプロジェクトの確認先（名前の重なりを避ける）
 */
export function followPurpose(
  target: ProjectTarget,
  patch: Partial<Omit<ProjectTarget, 'id'>>,
  kind: ProjectKind,
  siblings: readonly Pick<ProjectTarget, 'id' | 'label'>[] = []
): Partial<Omit<ProjectTarget, 'id'>> {
  const out = { ...patch }
  if (patch.url !== undefined && patch.purpose === undefined) {
    const next = purposeAfterUrlChange(target, patch.url)
    if (next !== purposeOf(target)) out.purpose = next
  }
  // 名前に「競合」「参考」などを書いたアプリの確認先は、参考（外部サイト）を勧める（選び直せる）
  if (patch.label !== undefined && patch.purpose === undefined && purposeOf({ ...target, ...out }) === 'app' && looksLikeReferenceLabel(patch.label)) {
    out.purpose = 'reference'
  }
  if (out.purpose !== undefined && purposeOf(out) !== purposeOf(target) && patch.label === undefined && isSuggestedLabel(target.label, kind)) {
    out.label = suggestTargetLabel(kind, siblings.filter((s) => s.id !== target.id), purposeOf(out))
  }
  return out
}

/**
 * 開いている URL をそのまま確認先にするときの1件。区分は URL から推し、
 * 名前はアプリなら local / dev / prd、デザイン・設計書なら区分の候補（Figma・Spec など）
 */
export function urlTarget(url: string, kind: ProjectKind, siblings: readonly Pick<ProjectTarget, 'label'>[], id: string = crypto.randomUUID()): ProjectTarget {
  const purpose = guessTargetPurpose(url)
  if (purpose === 'app') return { id, label: defaultUrlLabel(url), url }
  return { id, label: suggestTargetLabel(kind, siblings, purpose), url, purpose }
}

/** ツールバーに並べる順（アプリ → デザイン → 設計書 → 参考。同じ区分の中は登録の順のまま） */
export function groupTargetsByPurpose<T extends Pick<ProjectTarget, 'purpose'>>(targets: readonly T[]): Array<{ purpose: TargetPurpose; targets: T[] }> {
  return TARGET_PURPOSES.map((purpose) => ({ purpose, targets: targets.filter((t) => purposeOf(t) === purpose) })).filter((g) => g.targets.length > 0)
}

/**
 * 確認先の並びを変える（ツールバーのボタンをドラッグ）。from を to の前（before）か後ろへ動かす。
 * ボタンは区分（アプリ・デザイン・設計書）ごとにまとめて出すので、区分をまたぐ移動はしない（元の並びのまま返す）
 */
export function dropTarget<T extends Pick<ProjectTarget, 'id' | 'purpose'>>(targets: readonly T[], fromId: string, toId: string, before: boolean): T[] {
  const from = targets.find((t) => t.id === fromId)
  const to = targets.find((t) => t.id === toId)
  if (!from || !to || from === to || purposeOf(from) !== purposeOf(to)) return [...targets]
  const rest = targets.filter((t) => t !== from)
  const at = rest.indexOf(to) + (before ? 0 : 1)
  return [...rest.slice(0, at), from, ...rest.slice(at)]
}

/** URL を持つ確認先だけ（内蔵ブラウザで開けるもの） */
export function urlTargets<T extends ProjectTarget>(targets: readonly T[]): Array<T & { url: string }> {
  return targets.filter((t): t is T & { url: string } => !!t.url)
}

/**
 * 確認先のボタンを押したときにすること。
 *   url    … URL を内蔵ブラウザで開く
 *   window … 起動コマンドがあればターミナルで走らせ、ウインドウを録画の対象に選ぶ（URL もあれば開く）
 *   none   … 何もできない（書きかけ）
 * web のプロジェクトは常に URL として扱う（起動コマンドやウインドウの欄を出していないため）。
 */
type TargetAction =
  | { kind: 'url'; url: string }
  | { kind: 'window'; launchCommand?: string; windowMatch?: string; url?: string }
  | { kind: 'none' }

export function targetAction(target: ProjectTarget, projectKind: ProjectKind = DEFAULT_PROJECT_KIND): TargetAction {
  const fields = KIND_FIELDS[projectKind]
  const launchCommand = fields.launchCommand ? target.launchCommand : undefined
  const windowMatch = fields.windowMatch ? target.windowMatch : undefined
  if (launchCommand || windowMatch) {
    return { kind: 'window', ...(launchCommand ? { launchCommand } : {}), ...(windowMatch ? { windowMatch } : {}), ...(target.url ? { url: target.url } : {}) }
  }
  if (target.url) return { kind: 'url', url: target.url }
  return { kind: 'none' }
}

const norm = (s: string) => s.normalize('NFKC').toLowerCase().trim()

/**
 * 録画の対象の一覧から、ウインドウの名前に合うものを選ぶ（画面全体は選ばない）。
 * 完全一致 → 前方一致 → 部分一致 の順に、より短い名前（＝余計な語の少ないもの）を選ぶ。
 * macOS のウインドウ名は「アプリ名 - 文書名」の形が多いので、部分一致まで見る。
 * アプリ名（macOS で分かるとき）にも合わせる。iOS シミュレータの題名は端末名（iPhone 16 Pro）なので、「Simulator」はアプリ名で当たる。
 */
export function matchWindowSource(sources: readonly CaptureSourceInfo[], match: string | undefined): CaptureSourceInfo | null {
  const want = norm(match ?? '')
  if (!want) return null
  const windows = sources.filter((s) => s.kind === 'window')
  const score = (name: string): number => {
    const n = norm(name)
    if (n === want) return 0
    if (n.startsWith(want)) return 1
    if (n.includes(want)) return 2
    return -1
  }
  let best: { source: CaptureSourceInfo; score: number } | null = null
  for (const source of windows) {
    const scores = [score(source.name), source.appName ? score(source.appName) : -1].filter((v) => v >= 0)
    if (scores.length === 0) continue
    const s = Math.min(...scores)
    if (!best || s < best.score || (s === best.score && source.name.length < best.source.name.length)) best = { source, score: s }
  }
  return best?.source ?? null
}
