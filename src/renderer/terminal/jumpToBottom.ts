/**
 * 「一番下へ」のボタンを出すか。上へスクロールして、下にまだ行がある間だけ出す
 * （Agent が出力し続けていても、1回押せば最新の行まで移れる。terminalClient.ts）
 */
export function isScrolledUp(buffer: { viewportY: number; baseY: number }): boolean {
  return buffer.viewportY < buffer.baseY
}

/**
 * 隠れていたターミナルを再び表示したときに、スクロール領域を測り直させるための行の動かし方（往復1行ずつ）。
 * xterm 5.5 は隠れている間に届いた出力でスクロール領域を「見えている高さ 0」で計算し、1画面分短いまま残す。
 * そのままだとホイールで下へ送っても最後の1画面の手前で止まる（Antigravity で見つかった）。
 * xterm がスクロールのたびに測り直すので、今の位置から1行動かして戻す。上の行が無いときは下へ動かして戻す。
 * スクロールできる行が無ければ何もしない
 */
export function viewportResyncSteps(buffer: { viewportY: number; baseY: number }): [number, number] | null {
  if (buffer.baseY <= 0) return null
  return buffer.viewportY > 0 ? [-1, 1] : [1, -1]
}
