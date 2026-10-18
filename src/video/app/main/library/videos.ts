/**
 * チャンネル（Ferret のプロジェクトのフォルダ）の中の動画の一覧と、動画1本の状態。
 * 旧 Solocut の main/services/videos.ts から移した。Electron に依存しない（単体テストで直接呼ぶ）。
 * どの関数も読めないフォルダ・壊れた JSON で投げない（Agent や他のツールが書くファイルなので）。
 */
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { join, relative, isAbsolute, sep } from 'node:path'
import { LEGACY_PROJECT_FILE, LEGACY_STATE_DIR, VIDEO_PROJECT_FILE, VIDEO_STATE_DIR } from '@video/names'
import { compareVideos, FINAL_CANDIDATES, isSafeVideoName, PREVIEW_CANDIDATES, type VideoEntry, type VideoList, type VideoStatus } from '../../shared/library'

/** `<parent>/<name>`。あれば `<name>-2`・`-3`… */
export function uniqueChild(parent: string, name: string, exists: (p: string) => boolean = existsSync): string {
  let dir = join(parent, name)
  for (let i = 2; exists(dir); i++) {
    if (i > 9999) throw new Error(`too many folders named ${name} in ${parent}`)
    dir = join(parent, `${name}-${i}`)
  }
  return dir
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return undefined
  }
}

function mtime(path: string): number {
  try {
    return statSync(path).mtimeMs
  } catch {
    return 0
  }
}

function hasFile(dir: string, test: (name: string) => boolean): boolean {
  try {
    return readdirSync(dir, { withFileTypes: true }).some((e) => e.isFile() && test(e.name))
  } catch {
    return false
  }
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** 動画1本のフォルダか（ferret-video.json、または旧 solocut.json がある） */
export function videoProjectKind(dir: string): 'current' | 'legacy' | null {
  if (existsSync(join(dir, VIDEO_PROJECT_FILE))) return 'current'
  if (existsSync(join(dir, LEGACY_PROJECT_FILE))) return 'legacy'
  return null
}

function posted(dir: string): boolean {
  for (const state of [VIDEO_STATE_DIR, LEGACY_STATE_DIR]) {
    const res = readJson(join(dir, state, 'publish-result.json'))
    if (isObj(res) && Array.isArray(res.results) && res.results.some((r) => isObj(r) && r.ok === true)) return true
    const st = readJson(join(dir, state, 'status.json'))
    const steps = isObj(st) ? st.steps : st
    if (Array.isArray(steps) && steps.some((s) => isObj(s) && s.step === 'publish' && s.state === 'done')) return true
  }
  const tl = readJson(join(dir, 'timeline.json'))
  const outputs = isObj(tl) ? tl.outputs : undefined
  return Array.isArray(outputs) && outputs.some((o) => isObj(o) && isObj(o.publish) && (o.publish.status === 'published' || o.publish.status === 'scheduled'))
}

const isVideoFile = (n: string) => /\.(mp4|mov|webm)$/i.test(n) && !n.endsWith('.part') && !n.startsWith('.')

/** ファイルから安く決める状態: 投稿の結果 → posted、書き出し（renders/…mp4）→ done、撮った素材 → editing、ほかは new */
export function videoStatus(dir: string): VideoStatus {
  if (posted(dir)) return 'posted'
  if (FINAL_CANDIDATES.some((rel) => existsSync(join(dir, rel))) || hasFile(join(dir, 'renders'), isVideoFile) || hasFile(join(dir, 'renders', 'youtube'), isVideoFile)) return 'done'
  const any = (n: string) => !n.startsWith('.')
  if (hasFile(join(dir, 'media', 'takes'), any) || hasDir(join(dir, 'media', 'takes')) || hasFile(join(dir, 'media', 'imports'), any)) return 'editing'
  return 'new'
}

/** 撮影は media/takes/<take id>/ のフォルダになる */
function hasDir(dir: string): boolean {
  try {
    return readdirSync(dir, { withFileTypes: true }).some((e) => e.isDirectory() && !e.name.startsWith('.'))
  } catch {
    return false
  }
}

export function readVideo(dir: string, name: string): VideoEntry {
  const kind = videoProjectKind(dir)
  const file = kind === 'legacy' ? LEGACY_PROJECT_FILE : VIDEO_PROJECT_FILE
  const state = kind === 'legacy' ? LEGACY_STATE_DIR : VIDEO_STATE_DIR
  const j = readJson(join(dir, file))
  const title = isObj(j) && typeof j.title === 'string' && j.title.trim() ? j.title.trim() : name
  const updatedAt = Math.max(mtime(dir), mtime(join(dir, file)), mtime(join(dir, 'timeline.json')), mtime(join(dir, state, 'status.json')))
  const entry: VideoEntry = { dir, name, title, status: videoStatus(dir), updatedAt }
  if (kind === 'legacy') entry.legacy = true
  const tpl = isObj(j) && isObj(j.template) && typeof j.template.id === 'string' ? j.template.id : undefined
  if (tpl) entry.template = tpl
  return entry
}

function readRoot(root: string): { entries: import('node:fs').Dirent[] } | { error: string } {
  try {
    return { entries: readdirSync(root, { withFileTypes: true }) }
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code
    return { error: code === 'EACCES' || code === 'EPERM' ? 'permission' : code === 'ENOTDIR' ? 'notDir' : String((e as Error).message ?? e) }
  }
}

/** チャンネルの直下で動画のプロジェクトのフォルダ（旧 Solocut も）を新しい順に。投げない */
export function listVideos(root: string): VideoList {
  if (!existsSync(root)) return { root, exists: false, videos: [] }
  const r = readRoot(root)
  if ('error' in r) return { root, exists: true, videos: [], error: r.error }
  const videos: VideoEntry[] = []
  for (const e of r.entries) {
    // フォルダを指すリンクは辿らない（チャンネルの外を一覧に出さない）
    if (!e.isDirectory() || e.name.startsWith('.')) continue
    const dir = join(root, e.name)
    try {
      if (!videoProjectKind(dir)) continue
      videos.push(readVideo(dir, e.name))
    } catch {
      // 読めないフォルダは飛ばして残りを出す
    }
  }
  videos.sort(compareVideos)
  return { root, exists: true, videos }
}

/** フォルダが動画のチャンネルか（直下に動画のプロジェクトのフォルダが1つでもある）。最初の上限件だけを見る */
export function isVideoChannel(root: string, limit = 500): boolean {
  if (!root) return false
  const r = readRoot(root)
  if ('error' in r) return false
  let seen = 0
  for (const e of r.entries) {
    if (!e.isDirectory() || e.name.startsWith('.') || e.name === 'node_modules') continue
    if (++seen > limit) return false
    if (videoProjectKind(join(root, e.name))) return true
  }
  return false
}

/** child が root の中（root 自身は含まない）か。どちらも実体のパス（realpath）で比べる */
export function isStrictlyInside(root: string, child: string): boolean {
  const rel = relative(root, child)
  return rel !== '' && !isAbsolute(rel) && rel.split(sep)[0] !== '..'
}

/**
 * renderer から来た動画のフォルダ名を、チャンネルの中の実体の絶対パスにする。
 * 名前は直下の1段だけ（../・区切り文字・隠しフォルダは断る）。リンクでチャンネルの外を指すもの・動画のプロジェクトでないものも断る。
 */
export function resolveVideoDir(root: string | null, name: unknown): string {
  if (!root) throw new Error('no project is open')
  if (!isSafeVideoName(name)) throw new Error('invalid video folder name')
  let realRoot: string
  let real: string
  try {
    realRoot = realpathSync(root)
    real = realpathSync(join(root, name))
  } catch {
    throw new Error(`video folder not found: ${name}`)
  }
  if (!isStrictlyInside(realRoot, real)) throw new Error('video folder is outside the channel')
  if (!statSync(real).isDirectory() || !videoProjectKind(real)) throw new Error(`not a video project: ${name}`)
  return real
}

/**
 * いちばん新しい再生できる書き出し（動画のフォルダからの相対）。プレビューと完成動画のうち新しい方
 * （同じ時刻なら完成動画）。どちらも無ければ renders/ の下の一番新しい動画（縦の書き出し・サムネイルは除く）
 */
export function latestRender(dir: string): string | null {
  const first = (rels: readonly string[]) => {
    for (const rel of rels) {
      const m = mtime(join(dir, rel))
      if (m > 0) return { rel, m }
    }
    return null
  }
  const preview = first(PREVIEW_CANDIDATES)
  const final = first(FINAL_CANDIDATES)
  if (preview || final) return !final ? preview!.rel : !preview ? final.rel : preview.m > final.m ? preview.rel : final.rel
  let best: { rel: string; m: number } | null = null
  const walk = (rel: string, depth: number) => {
    if (depth > 2) return
    let entries: import('node:fs').Dirent[]
    try {
      entries = readdirSync(join(dir, rel), { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const child = `${rel}/${e.name}`
      if (e.isDirectory()) {
        if (e.name.startsWith('.') || e.name === 'tiktok' || e.name === 'youtube-shorts' || e.name === 'thumbnails') continue
        walk(child, depth + 1)
      } else if (e.isFile() && isVideoFile(e.name)) {
        const m = mtime(join(dir, child))
        if (!best || m > best.m) best = { rel: child, m }
      }
    }
  }
  walk('renders', 0)
  return (best as { rel: string } | null)?.rel ?? null
}

/** 動画のフォルダの中のファイルを、チャンネルからの相対パス（ade-media://project/ で開く形、区切りは /）にする */
export function channelRelative(root: string, dir: string, rel: string): string {
  let realRoot = root
  try {
    realRoot = realpathSync(root)
  } catch {
    /* 無ければそのまま */
  }
  return relative(realRoot, join(dir, rel)).split(sep).join('/')
}
