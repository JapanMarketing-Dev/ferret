import { delay } from '@shared/delay'

/**
 * SSH のタブ（リモートの tmux の中。セッションだけマウスを有効にしている。src/shared/sshCommand.ts）への入力の扱い（純粋な関数）。
 * xterm.js は tmux の求めに応じて、ホイール・クリック・ドラッグを SGR のマウスの報告（ESC [ < b ; x ; y M か m）にして送る。
 */

const SGR_MOUSE_PREFIX = '\x1b[<'
const SGR_MOUSE_REPORT = /\x1b\[<\d+;\d+;\d+[Mm]/
const SGR_MOUSE_REPORTS = /\x1b\[<(\d+);\d+;\d+[Mm]/g

/** マウスの報告を含むか（ホイール・クリック・ドラッグ。tmux のコピーモードに入りうる） */
export function hasMouseReport(data: string): boolean {
  return data.includes(SGR_MOUSE_PREFIX) && SGR_MOUSE_REPORT.test(data)
}

/**
 * 右ボタンの報告（押す・離す・押したままの移動。修飾キー付きも）を落とす。ホイール（64〜）と 8 番以降のボタン（128〜）は残す。
 * tmux は右クリックで自分のメニューを開き、押したまま動かして離した位置の項目（Kill・Respawn・Split など）を実行する。
 * Ferret の右クリックのメニューの下に隠れた tmux のメニューで、Agent のペインが終わりかねないので渡さない
 * （右クリックはこれまで通り Ferret のメニューだけ）
 */
export function dropRightButtonReports(data: string): string {
  if (!data.includes(SGR_MOUSE_PREFIX)) return data
  // b の下 2 ビットがボタン（0 左・1 中・2 右）、4・8・16 が修飾キー、32 が押したままの移動、64 がホイール、128 が 8 番以降のボタン
  return data.replace(SGR_MOUSE_REPORTS, (report, button: string) => ((Number(button) & 0xc3) === 2 ? '' : report))
}

/**
 * コピーモードを抜けたあと、描き直しが届いて renderer が画面を知らせ直すまで待つ（上限 limitMs）。
 * 抜ける前（since）より後の出力を見てから、その出力より後の画面の知らせを待つ。待たないと、Agent の状態の判定が
 * 上へ戻した位置の古い画面（昔の確認の表示など）を見てしまう。届いたら true、上限・タブが閉じたときは false
 */
export async function waitForRedraw(input: {
  since: number
  /** 最後に PTY の出力が届いた時刻 */
  outputAt: () => number | undefined
  /** 最後に renderer が画面の文字を知らせた時刻 */
  screenAt: () => number | undefined
  alive: () => boolean
  limitMs: number
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}): Promise<boolean> {
  const now = input.now ?? Date.now
  const sleep = input.sleep ?? delay
  const deadline = now() + input.limitMs
  let redrawAt: number | null = null
  for (;;) {
    if (!input.alive()) return false
    const output = input.outputAt()
    if (redrawAt === null && output !== undefined && output > input.since) redrawAt = output
    const screen = input.screenAt()
    if (redrawAt !== null && screen !== undefined && screen > redrawAt) return true
    if (now() >= deadline) return false
    await sleep(50)
  }
}
