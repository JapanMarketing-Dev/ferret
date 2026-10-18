#!/usr/bin/env node
// 段階的デプロイ（Cloudflare Gradual Deployments）。
//
//   pnpm deploy:upload                     # 新しい版をアップロード（まだ配信しない）
//   pnpm deploy:gradual -- 10              # 最新の版に 10%、今の安定版に 90%
//   pnpm deploy:gradual -- 50 --version <id>
//   pnpm deploy:gradual -- 100             # 新しい版に全量（= 昇格）
//   pnpm deploy:gradual -- 10 --dry-run    # 実行するコマンドだけ表示
//
// 新しい版: --version で指定。なければ `wrangler versions list --json` の一番新しい版。
// 安定版: `wrangler deployments status --json` で今いちばん多く配信している、新しい版以外の版。
import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const wrangler = join(root, 'node_modules', '.bin', 'wrangler')

function fail(message) {
  console.error(`deploy:gradual: ${message}`)
  process.exit(1)
}

const args = process.argv.slice(2).filter((a) => a !== '--')
const dryRun = args.includes('--dry-run')
const vIndex = args.indexOf('--version')
const explicitVersion = vIndex >= 0 ? args[vIndex + 1] : undefined
const msgIndex = args.indexOf('--message')
const message = msgIndex >= 0 ? args[msgIndex + 1] : undefined
const valueIndexes = new Set([vIndex, msgIndex].filter((i) => i >= 0).map((i) => i + 1))
const positional = args.filter((a, i) => !a.startsWith('--') && !valueIndexes.has(i))
const percentRaw = positional[0]

if (!percentRaw || !/^\d{1,3}$/.test(percentRaw))
  fail('割合（1〜100 の整数）を指定してください。例: pnpm deploy:gradual -- 10')
const percent = Number(percentRaw)
if (percent < 1 || percent > 100) fail('割合は 1〜100 にしてください')
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
if (explicitVersion !== undefined && !UUID.test(explicitVersion))
  fail('--version には Version ID（UUID）を指定してください')

function wranglerJson(cmdArgs) {
  const out = execFileSync(wrangler, [...cmdArgs, '--json'], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  })
  return JSON.parse(out)
}

let newVersion = explicitVersion
if (!newVersion) {
  const versions = wranglerJson(['versions', 'list'])
  if (!Array.isArray(versions) || versions.length === 0)
    fail('版が見つかりません。先に pnpm deploy:upload を実行してください')
  newVersion = versions[versions.length - 1].id
}

const specs = [`${newVersion}@${percent}%`]
if (percent < 100) {
  const status = wranglerJson(['deployments', 'status'])
  const current = (status?.versions ?? [])
    .filter((v) => v.version_id !== newVersion)
    .sort((a, b) => b.percentage - a.percentage)[0]
  if (!current) fail('今配信中の安定版が見つかりません。初回は pnpm deploy:full を使ってください')
  specs.push(`${current.version_id}@${100 - percent}%`)
}

const cmd = ['versions', 'deploy', ...specs, '--yes']
if (message) cmd.push('--message', message)
console.log(`> wrangler ${cmd.join(' ')}`)
if (dryRun) process.exit(0)
execFileSync(wrangler, cmd, { cwd: root, stdio: 'inherit' })
