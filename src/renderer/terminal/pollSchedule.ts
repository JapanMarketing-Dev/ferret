/**
 * Agent の状態の問い合わせ（terminal:agentStates）を、どのペインに今回行うか。
 *
 * 表示中のプロジェクトのペインは毎回（2.5 秒ごと）、裏のプロジェクトのペインは HIDDEN_PROJECT_POLL_MS ごと。
 * 多くのプロジェクトで Agent を並べて動かすと、見ていないペインまで毎秒調べて main の CPU を使っていた。
 * 裏のペインも間隔を空けて調べ続けるので、終わった・確認待ちの通知は届く（少し遅れるだけ）
 */

/** 裏のプロジェクトのペインを調べる間隔 */
export const HIDDEN_PROJECT_POLL_MS = 4000

/**
 * 今回調べるペイン。lastPolled は各ペインを最後に調べた時刻（調べたら呼び出し側が now を書く）。
 * タイマーのずれで取りこぼさないよう、間隔より少し早くても調べる
 */
export function panesDueForPoll(
  keys: readonly string[],
  foreground: ReadonlySet<string>,
  lastPolled: ReadonlyMap<string, number>,
  now: number,
  hiddenIntervalMs = HIDDEN_PROJECT_POLL_MS
): string[] {
  const slack = 250
  return keys.filter((key) => {
    if (foreground.has(key)) return true
    const last = lastPolled.get(key)
    return last === undefined || now - last >= hiddenIntervalMs - slack
  })
}
