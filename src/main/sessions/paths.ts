/**
 * セッションフォルダの構成（設計 8章）。
 *
 * <project>/.ferret/reviews/20261002-104012/
 * ├── feedback.md          Agentが読む本体
 * ├── 01.png …             指摘の画像
 * ├── session.json         文字起こし・LLM出力・編集結果
 * ├── events.jsonl         操作ログ
 * ├── label.json           一覧の整理（名前・アーカイブ・送った時刻）
 * ├── summary.json         一覧用の要約（session.json を保存したときに書く）
 * ├── progress.json        指摘ごとの進み具合（Agent と利用者が書く。@shared/findingProgress）
 * ├── recording.webm       動画（既定7日で自動削除）
 * ├── recording.trimmed.webm  何もない時間を削った版（▷ で使う。同じく7日で削除）
 * ├── work/                静止画・音声の中間ファイル（分解完了後に削除）
 * └── takes/2/ …           あとから追記した録画（sessions/takes.ts）。中は上と同じ形
 *                          （recording.webm・events.jsonl・transcript.jsonl・capture.json・work/）
 */
import { existsSync } from 'node:fs'
import { lstat } from 'node:fs/promises'
import { readDirEntries } from '../dirEntries'
import { assertContained } from './containment'
import { HISTORY_LIMITS } from './limits'
import { basename, join } from 'node:path'

export const ADE_DIR = '.ferret'
/**
 * 改名前（MOVIE-ADE）のフォルダ。新しくは書かないが、履歴に出し続ける（利用者のファイルは黙って移さない）。
 * 同じ ID が両方にあれば .ferret/ を使う
 */
export const LEGACY_ADE_DIR = '.ade-movie'
const REVIEWS_DIR = 'reviews'

export interface SessionPaths {
  /** セッションID（フォルダ名）。例 20261002-104012 */
  id: string
  /** 絶対パス */
  dir: string
  /** プロジェクトからの相対パス。送信の指示文に使う（`.ferret/reviews/<id>`。古いレビューは `.ade-movie/reviews/<id>`） */
  relativeDir: string
  feedbackMd: string
  sessionJson: string
  eventsJsonl: string
  /** 一覧の整理（名前・アーカイブ・送った時刻）。session.json が無い・壊れていても付けられるよう別にする */
  labelJson: string
  /** 一覧用の要約。一覧のたびに session.json と events.jsonl を読まずに済ませる（summary.ts） */
  summaryJson: string
  /** 指摘ごとの進み具合。Agent が作業しながら書く（progress.ts） */
  progressJson: string
  /** 人の判断（OK / NG / Comment / 開き直し）の記録。Ferret だけが書く（Agent が progress.json を書き直しても OK を失わない） */
  verdictsJson: string
  recording: string
  /** 何もない時間を削った版（trim.ts）。元の recording.webm と同じく保存期間で消える */
  trimmedRecording: string
  workDir: string
  /** 音声チャンクの置き場所（work/audio） */
  audioDir: string
  /** 静止画の置き場所（work/frames） */
  framesDir: string
}

/** 日時からセッションIDを作る。ローカル時刻の `YYYYMMDD-HHMMSS` */
export function sessionId(date: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return (
    `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}` +
    `-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`
  )
}

/** セッションIDとして妥当か（フォルダ一覧の読み込みで使う） */
export function isSessionId(name: string): boolean {
  return /^\d{8}-\d{6}$/.test(name)
}

export function reviewsRoot(projectDir: string, base: string = ADE_DIR): string {
  return join(projectDir, base, REVIEWS_DIR)
}

/** レビューを探すフォルダ（新しい順の優先度: .ferret/ → .ade-movie/） */
export function reviewsRoots(projectDir: string): string[] {
  return [reviewsRoot(projectDir, ADE_DIR), reviewsRoot(projectDir, LEGACY_ADE_DIR)]
}

/**
 * 両方のフォルダにあるセッションID（重複は1つ）を新しい順に返す。まだ録画していないプロジェクトにはフォルダが無い（想定内）。
 * リンク・ジャンクション（.ferret・reviews・レビューのフォルダ）をたどる先のものは一覧に出さない（containment.ts）。
 * 1つのフォルダで見る名前は scannedNames まで、返すのは max 件まで（security-4 [10]。細工した大量のフォルダで止まらない）。
 * truncated は、見きれなかった・max で打ち切った名前があったか
 */
export async function listSessionIdsPage(projectDir: string, options: { max?: number; scannedNames?: number } = {}): Promise<{ ids: string[]; truncated: boolean }> {
  const max = options.max ?? Number.POSITIVE_INFINITY
  const scanLimit = options.scannedNames ?? HISTORY_LIMITS.scannedNames
  const candidates = new Map<string, string>()
  let truncated = false
  for (const root of reviewsRoots(projectDir)) {
    try { assertContained(projectDir, root) } catch { continue }
    // 上限まで読む（Windows は opendir を使わない。dirEntries.ts・FERRET-1Q）
    const read = await readDirEntries(root, scanLimit).catch(() => null)
    if (!read) continue
    if (read.truncated) truncated = true
    for (const entry of read.entries) {
      if (isSessionId(entry.name) && !candidates.has(entry.name)) candidates.set(entry.name, root)
    }
  }
  // ID は日時の形（20261002-104012）なので、文字の順がそのまま時刻の順
  const sorted = [...candidates.keys()].sort((a, b) => (a < b ? 1 : a > b ? -1 : 0))
  const ids: string[] = []
  for (const name of sorted) {
    if (ids.length >= max) {
      truncated = true
      break
    }
    const st = await lstat(join(candidates.get(name)!, name)).catch(() => null)
    if (st?.isDirectory()) ids.push(name)
  }
  return { ids, truncated }
}

/** 両方のフォルダにあるセッションID（新しい順。見る名前の数に上限がある） */
export async function listSessionIds(projectDir: string): Promise<string[]> {
  return (await listSessionIdsPage(projectDir)).ids
}

/**
 * セッションのパス。base を省くと、.ferret/ に無く .ade-movie/ にだけあるものは .ade-movie/ を指す（古いレビューを読む）。
 * 新しく作るときは base に ADE_DIR を渡す（store.ts の createSession）
 */
export function sessionPaths(projectDir: string, id: string, base?: string): SessionPaths {
  const folder = base ?? (!existsSync(join(reviewsRoot(projectDir, ADE_DIR), id)) && existsSync(join(reviewsRoot(projectDir, LEGACY_ADE_DIR), id)) ? LEGACY_ADE_DIR : ADE_DIR)
  const dir = join(reviewsRoot(projectDir, folder), id)
  // 名前の上で中にあっても、途中のリンクで外へ向いていれば使わない（書き込み・rm -r が外へ届くため）
  assertContained(projectDir, dir)
  const workDir = join(dir, 'work')
  return {
    id,
    dir,
    relativeDir: `${folder}/${REVIEWS_DIR}/${id}`,
    feedbackMd: join(dir, 'feedback.md'),
    sessionJson: join(dir, 'session.json'),
    eventsJsonl: join(dir, 'events.jsonl'),
    labelJson: join(dir, 'label.json'),
    summaryJson: join(dir, 'summary.json'),
    progressJson: join(dir, 'progress.json'),
    verdictsJson: join(dir, 'verdicts.json'),
    recording: join(dir, 'recording.webm'),
    trimmedRecording: join(dir, 'recording.trimmed.webm'),
    workDir,
    audioDir: join(workDir, 'audio'),
    framesDir: join(workDir, 'frames')
  }
}

const TAKES_DIR = 'takes'

/**
 * 追記した録画（2 本目から）の置き場所。ID と送信の指示文はレビューのものを使い、ファイルだけ takes/<n>/ に分ける。
 * n が 1 ならレビューそのもの
 */
export function takePaths(paths: SessionPaths, n: number): SessionPaths {
  if (n <= 1) return paths
  const dir = join(paths.dir, TAKES_DIR, String(n))
  assertContained(paths.dir, dir)
  const workDir = join(dir, 'work')
  return {
    ...paths,
    dir,
    sessionJson: join(dir, 'session.json'),
    eventsJsonl: join(dir, 'events.jsonl'),
    labelJson: join(dir, 'label.json'),
    summaryJson: join(dir, 'summary.json'),
    recording: join(dir, 'recording.webm'),
    trimmedRecording: join(dir, 'recording.trimmed.webm'),
    workDir,
    audioDir: join(workDir, 'audio'),
    framesDir: join(workDir, 'frames')
  }
}

/** 追記した録画の静止画は `takes/<n>/<ファイル名>` の形で session.json の frames に入れる（最初の録画はファイル名だけ） */
const TAKE_FRAME = /^takes\/(\d+)\/([^/\\]+)$/

/** session.json の静止画のパス（FrameRef.path）から、実際のファイルの絶対パスを作る */
export function frameFilePath(paths: SessionPaths, framePath: string): string {
  const take = TAKE_FRAME.exec(framePath)
  if (take) return join(takePaths(paths, Number(take[1])).framesDir, take[2]!)
  return join(paths.framesDir, basename(framePath))
}
