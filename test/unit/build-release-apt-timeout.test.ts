import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// Linux のビルドで apt が snapshot.debian.org の応答待ちのまま止まらないこと（0.7.11 で3時間止まった）
const script = readFileSync(resolve(__dirname, '../../scripts/build-release.sh'), 'utf8')
const linux = script.slice(script.indexOf("<<'LINUX'"), script.indexOf('\nLINUX\n'))

describe('build-release.sh の apt', () => {
  it('タイムアウトとやり直しの回数を決めている', () => {
    expect(linux).toMatch(/Acquire::http::Timeout=\d+/)
    expect(linux).toMatch(/Acquire::https::Timeout=\d+/)
    expect(linux).toMatch(/Acquire::Retries=\d+/)
  })

  it('apt-get の呼び出しはすべてその設定を使う', () => {
    const calls = linux.split('\n').filter((l) => /^\s*(if )?apt-get\b/.test(l.trim()))
    expect(calls.length).toBeGreaterThanOrEqual(2)
    for (const c of calls) expect(c).toContain('"${APT_NET[@]}"')
  })

  it('install は失敗しても間を空けて入れ直し、回数で止める（0.7.12 の 503）', () => {
    expect(linux).toMatch(/for attempt in 1 2 3 4 5; do\n\s+if apt-get "\$\{APT_NET\[@\]\}" install/)
    expect(linux).toMatch(/\[ "\$attempt" = 5 \].*exit 1/)
  })
})
