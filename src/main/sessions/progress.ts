/**
 * 指摘ごとの進み具合（progress.json）の読み書き。形と読み方は @shared/findingProgress。
 *
 * Agent も同じファイルを書くので、Ferret は書く直前に読み直して重ねる（Agent の書いた分を消さない）。
 * 書き途中のファイルを Agent が読まないよう、別名に書いてから置き換える（containment.ts。リンクをたどってフォルダの外へ読み書きしない）。
 * 人の判断の記録は Ferret だけが書く verdicts.json にも残し、読むときに重ねる（Agent が history を消したり、OK 済みを
 * human_review に書き戻したりしても、OK は消えない。@shared/findingProgress の withVerdictLog）。
 * 変更は ProjectWatcher（files.ts）が fs:changed で知らせ、renderer が読み直す。
 */
import { readFileNoFollow, writeFileNoFollow } from './containment'
import { applyProgress, parseProgress, parseVerdictLog, serializeProgress, verdictLogOf, withVerdictLog, type ProgressMap, type ProgressPatchValue, type VerdictLog } from '@shared/findingProgress'
import type { SessionPaths } from './paths'

/** 読めなければ空（まだ誰も書いていない・壊れた JSON）。knownIds を渡すと知らないIDを落とす */
export async function readProgress(paths: SessionPaths, knownIds?: Iterable<string>): Promise<ProgressMap> {
  const ids = knownIds ? [...knownIds] : undefined
  let map: ProgressMap = {}
  try {
    map = parseProgress(JSON.parse(await readFileNoFollow(paths.progressJson)), ids)
  } catch {
    // 送る前のレビューには progress.json が無い。Agent が書き損じた JSON・リンクになった progress.json も未対応として読む（想定内）
  }
  return withVerdictLog(map, await readVerdictLog(paths), ids)
}

/** 判断の記録。無い・読めなければ空（記録を書く前の版で作ったレビュー。想定内） */
async function readVerdictLog(paths: SessionPaths): Promise<VerdictLog> {
  try {
    return parseVerdictLog(JSON.parse(await readFileNoFollow(paths.verdictsJson)))
  } catch {
    return {}
  }
}

const queues = new Map<string, Promise<unknown>>()

/** 変更を重ねて書く。同じレビューへの書き込みは順番に行う */
export async function updateProgress(paths: SessionPaths, patch: Record<string, ProgressPatchValue>): Promise<ProgressMap> {
  return updateProgressWith(paths, (current) => applyProgress(current, patch))
}

/** 読み直した今の値から次の値を作って書く（人の判断の記録など、重ね方が決まった形でないとき） */
export async function updateProgressWith(paths: SessionPaths, next: (current: ProgressMap) => ProgressMap): Promise<ProgressMap> {
  // 前の書き込みの失敗はその呼び出し側へ返し済み（順番待ちに使うだけ。想定内）
  const work = (queues.get(paths.dir) ?? Promise.resolve()).catch(() => {}).then(async () => {
    const merged = next(await readProgress(paths))
    // 判断の記録を先に書く（progress.json の書き込みが失敗しても OK を失わない）
    await writeFileNoFollow(paths.verdictsJson, `${JSON.stringify(verdictLogOf(merged), null, 2)}\n`)
    await writeFileNoFollow(paths.progressJson, `${JSON.stringify(serializeProgress(merged), null, 2)}\n`)
    return merged
  })
  queues.set(paths.dir, work)
  try { return await work } finally { if (queues.get(paths.dir) === work) queues.delete(paths.dir) }
}
