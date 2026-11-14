/** メニューの上端。入れ物（高さ boxHeight）の中に収まるよう、下からはみ出す分だけ上へ寄せる。入れ物より高ければ上に揃える */
export function clampMenuTop(y: number, menuHeight: number, boxHeight: number, margin = 4): number {
  return Math.max(margin, Math.min(y, boxHeight - menuHeight - margin))
}
