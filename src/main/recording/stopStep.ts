/**
 * 録画を止める処理の1段（静止画の書き終わり・録画ウインドウの停止・操作ログの書き終わりなど）を、
 * 時間の上限つきで、投げずに走らせる。
 *
 * 停止は「必ず終わる」ことが大事。どれか1段が返ってこない（Windows で録画ウインドウの返事が来ない、
 * ファイルが他のプロセスに掴まれて書き終わらない など）・投げると、録画が「停止中」のまま残り、
 * それまでの音声・発話がレビューにならない。上限を過ぎた段はあきらめて次へ進み、理由を返す。
 */
export type StopStepResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: 'timeout' }
  | { ok: false; reason: 'error'; error: unknown }

export async function boundedStep<T>(run: () => Promise<T> | T, timeoutMs: number): Promise<StopStepResult<T>> {
  let timer: ReturnType<typeof setTimeout> | null = null
  const timeout = new Promise<StopStepResult<T>>((resolve) => {
    timer = setTimeout(() => resolve({ ok: false, reason: 'timeout' }), Math.max(0, timeoutMs))
    ;(timer as { unref?: () => void }).unref?.()
  })
  const work = (async (): Promise<StopStepResult<T>> => {
    try {
      return { ok: true, value: await run() }
    } catch (error) {
      return { ok: false, reason: 'error', error }
    }
  })()
  try {
    return await Promise.race([work, timeout])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/** 同期の後片付け（ウインドウを閉じる・知らせを送る）を、投げても次へ進むように走らせる */
export function safeStep(run: () => void, onError: (error: unknown) => void): void {
  try {
    run()
  } catch (error) {
    onError(error)
  }
}
