/**
 * 公開の前に、依存の既知の脆弱性で止める（scripts/publish-squash.sh の 3b）。
 *
 * osv-scanner の JSON（`osv-scanner --format json -r <フォルダ>`）を標準入力で受け取り、
 * High・Critical（CVSS 7.0 以上。点数が無ければ GitHub のアドバイザリの HIGH / CRITICAL）が1件でもあれば
 * 一覧を出して 1 で終わる。Medium 以下と重さの分からないものは表示だけして通す。
 *
 *   osv-scanner --format json -r . | node scripts/vuln-gate.mjs
 *
 * 判定は純粋な関数（blockingFindings）にして、単体テストで固定する（ネットワークは使わない）。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/** 止める重さの下限（CVSS） */
export const BLOCK_SCORE = 7.0

/**
 * アドバイザリの重さ。'block'（High 以上）・'pass'（Medium 以下）・'unknown'（点数も分類も無い）
 * @param {string | undefined} maxSeverity groups[].max_severity（CVSS の点数の文字列。無ければ ''）
 * @param {string | undefined} label vulnerabilities[].database_specific.severity（LOW / MODERATE / HIGH / CRITICAL）
 * @returns {'block' | 'pass' | 'unknown'}
 */
export function classify(maxSeverity, label) {
  const score = Number.parseFloat(maxSeverity ?? '')
  if (Number.isFinite(score)) return score >= BLOCK_SCORE ? 'block' : 'pass'
  const l = String(label ?? '').toUpperCase()
  if (l === 'HIGH' || l === 'CRITICAL') return 'block'
  if (l === 'LOW' || l === 'MODERATE' || l === 'MEDIUM') return 'pass'
  return 'unknown'
}

/**
 * osv-scanner の結果から、止めるもの・重さの分からないものを取り出す
 * @param {any} report osv-scanner の JSON
 * @returns {{ blocking: Array<{ package: string, version: string, id: string, severity: string, source: string }>, unknown: Array<{ package: string, version: string, id: string, severity: string, source: string }> }}
 */
export function blockingFindings(report) {
  const blocking = []
  const unknown = []
  for (const result of report?.results ?? []) {
    const source = String(result?.source?.path ?? '')
    for (const pkg of result?.packages ?? []) {
      const name = String(pkg?.package?.name ?? '?')
      const version = String(pkg?.package?.version ?? '?')
      const vulns = new Map((pkg?.vulnerabilities ?? []).map((v) => [v?.id, v]))
      for (const group of pkg?.groups ?? []) {
        const ids = group?.ids ?? []
        const label = ids.map((id) => vulns.get(id)?.database_specific?.severity).find((s) => typeof s === 'string')
        const kind = classify(group?.max_severity, label)
        const row = { package: name, version, id: ids.join(','), severity: group?.max_severity || label || '?', source }
        if (kind === 'block') blocking.push(row)
        else if (kind === 'unknown') unknown.push(row)
      }
    }
  }
  return { blocking, unknown }
}

function main() {
  const text = readFileSync(0, 'utf8')
  let report
  try {
    report = JSON.parse(text)
  } catch {
    console.error('osv-scanner の出力を JSON として読めませんでした')
    process.exit(2)
  }
  const { blocking, unknown } = blockingFindings(report)
  const line = (r) => `  ${r.package}@${r.version}  ${r.id}  (${r.severity})  ${r.source}`
  if (unknown.length) console.log(`重さの分からない既知の脆弱性（止めない。内容を確かめる）:\n${unknown.map(line).join('\n')}`)
  if (blocking.length) {
    console.error(`High・Critical の既知の脆弱性があります:\n${blocking.map(line).join('\n')}`)
    process.exit(1)
  }
  console.log('High・Critical の既知の脆弱性はありません')
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main()
