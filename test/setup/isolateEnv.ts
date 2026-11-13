/**
 * Ferret のターミナルの中でテストを流すと、親の Ferret がタブに渡した変数（動画づくりの whisper の場所・Agent どうしの依頼の受け口・
 * 判定モデルの中継・内蔵ブラウザの CDP）を受け継ぎ、それを読むテストが手元でだけ落ちる（CI では無いので通る）。
 * どの環境でも同じ結果になるよう、テストの前に消す（テストが自分で入れる値はその後なので残る）
 */
const INHERITED_PREFIXES = ['FERRET_VIDEO_', 'FERRET_AGENT_', 'FERRET_DECISION_', 'FERRET_BROWSER_']

for (const key of Object.keys(process.env)) {
  if (INHERITED_PREFIXES.some((prefix) => key.startsWith(prefix))) delete process.env[key]
}

/*
 * ログインシェルの PATH（src/main/agentDetection.ts の loginShellPath。`$SHELL -ilc`）を、利用者の rc を読む本物のシェルで取らない。
 * zsh の rc は手元で 1.5〜2 秒かかり、git・Agent の検出を通るテストがそのたびに待っていた（全体が10秒を超える一因）。
 * ターミナルのシェル（SHELL）はそのままにし、PATH を読むシェルだけを rc の軽い /bin/sh にする（VITEST の中だけ効く）
 */
if (process.platform !== 'win32') process.env.FERRET_TEST_LOGIN_SHELL = '/bin/sh'
