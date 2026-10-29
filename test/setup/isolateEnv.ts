/**
 * Ferret のターミナルの中でテストを流すと、親の Ferret がタブに渡した変数（動画づくりの whisper の場所・Agent どうしの依頼の受け口・
 * 判定モデルの中継・内蔵ブラウザの CDP）を受け継ぎ、それを読むテストが手元でだけ落ちる（CI では無いので通る）。
 * どの環境でも同じ結果になるよう、テストの前に消す（テストが自分で入れる値はその後なので残る）
 */
const INHERITED_PREFIXES = ['FERRET_VIDEO_', 'FERRET_AGENT_', 'FERRET_DECISION_', 'FERRET_BROWSER_']

for (const key of Object.keys(process.env)) {
  if (INHERITED_PREFIXES.some((prefix) => key.startsWith(prefix))) delete process.env[key]
}
