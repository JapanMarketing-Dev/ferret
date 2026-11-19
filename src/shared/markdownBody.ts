/** 人と Agent が書く Markdown（グローバルの rules.md・開発方針の playbook.md）から、Agent の指示へ写す中身を取り出す */

/**
 * 人と Agent が書く Markdown から写す中身。コメント（<!-- -->）・先頭の見出し（# …）・中身の無い箇条（- だけ）を外し、前後の空行を詰め、max 文字で切る。
 * 雛形のままなら空文字（rules.md と、開発方針の playbook.md が使う）
 */
export function markdownBody(text: string | null | undefined, max: number): string {
  if (!text) return ''
  // 外したあとにまたコメントができることがあるので、変わらなくなるまで繰り返す
  let plain = text.replace(/\r\n?/g, '\n')
  let before: string
  do {
    before = plain
    plain = plain.replace(/<!--[\s\S]*?-->/g, '')
  } while (plain !== before)
  const lines = plain.split('\n')
  const firstContent = lines.findIndex((l) => l.trim() !== '')
  if (firstContent >= 0 && /^#\s/.test(lines[firstContent]!.trim())) lines.splice(firstContent, 1)
  const body = lines
    .filter((l) => !/^\s*[-*]\s*$/.test(l))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return body.length > max ? body.slice(0, max).trimEnd() : body
}
