/**
 * シェルに渡す1語の引用（いくつかの場所で別々に書いていたものをまとめる）
 */

/**
 * PowerShell の単引用符の文字列。中の `$` と「`」は展開しない。
 * PowerShell は和文のシングルクォート（‘’ など）でも文字列を閉じるので、それも二重にする
 */
export function quotePowerShellLiteral(value: string): string {
  return `'${value.replace(/['‘’‚‛]/g, '$&$&')}'`
}

/**
 * 1つの引数を、CommandLineToArgvW と cmd.exe の両方が同じに読むように囲む。
 * 中の `"` は `\"` ではなく `""` と書く（cmd の「`"` の数」が偶数のまま保たれる）。
 * `%VAR%` は囲みの中でも展開されるので、いったん囲みを閉じて `^%` にする。
 */
export function quoteWindowsCmdArgument(value: string): string {
  if (!/[\\"%]/.test(value)) return `"${value}"`
  let quoted = '"'
  let backslashes = 0
  for (const char of value) {
    if (char === '\\') {
      backslashes += 1
      continue
    }
    if (char === '"') {
      quoted += `${'\\'.repeat(backslashes * 2)}""`
      backslashes = 0
      continue
    }
    if (char === '%') {
      quoted += `${'\\'.repeat(backslashes * 2)}"^%"`
      backslashes = 0
      continue
    }
    quoted += `${'\\'.repeat(backslashes)}${char}`
    backslashes = 0
  }
  // 末尾の \ は閉じる " の直前に来るので倍にする（C:\dir\ が " を飲み込まないように）
  return `${quoted}${'\\'.repeat(backslashes * 2)}"`
}
