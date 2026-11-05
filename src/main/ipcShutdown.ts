/**
 * 終了の手順に入った後の IPC の返事。
 *
 * 以前は null を返していたが、画面は null を返さないチャネル（passwords:forPage など）の値として読み、
 * 閉じる途中の Windows で落ちていた（Sentry FERRET-28: Cannot read properties of null (reading 'accounts')）。
 * 終了は取り消されない（shuttingDown は戻らない）ので、返事をしないまま待たせる。
 * 画面はそのままプロセスごと閉じる。待たせた呼び出しは、画面の側で値を読む処理まで進まない
 */
export function replyAfterShutdown(): Promise<never> {
  return new Promise<never>(() => {})
}

/** 終了の途中でも受けるチャネル（終了の途中で main が頼む、ターミナルの最後の画面の文字） */
export function acceptsDuringShutdown(channel: string): boolean {
  return channel === 'terminal:restoreSave'
}
