import { escapeRegExp } from './textHelpers'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * リリースの供給網のポリシー（セキュリティ報告 [1] [5]）。ファイルを読むだけで、何も動かさない。
 *   - GitHub Actions はコミットの SHA に固定する（タグは付け替えられる）。コメントに版を書く
 *   - @latest・版を固定しない npx を使わない
 *   - 外から来た値を扱うスクリプトで shell を使わない
 *   - secrets はジョブ全体ではなく、使うステップにだけ渡す。R2 のトークンを持つジョブはリポジトリへ書けない
 */

const root = resolve(__dirname, '../..')
const read = (p: string) => readFileSync(join(root, p), 'utf8')
const workflowDir = '.github/workflows'
const workflows = readdirSync(join(root, workflowDir)).filter((f) => /\.ya?ml$/.test(f)).map((f) => `${workflowDir}/${f}`)

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(join(root, dir))) {
    if (name === 'node_modules') continue
    const p = `${dir}/${name}`
    if (statSync(join(root, p)).isDirectory()) walk(p, out)
    else if (/\.(mjs|cjs|js|ts|sh)$/.test(name)) out.push(p)
  }
  return out
}
const scriptFiles = [...walk('scripts'), ...walk('tools'), ...walk('.github/scripts')]

/** トップレベルの jobs: の下を、ジョブごとの行に分ける（インデント 2 のキーがジョブ名） */
function jobsOf(text: string): Map<string, string[]> {
  const jobs = new Map<string, string[]>()
  let inJobs = false
  let current: string[] | null = null
  for (const line of text.split('\n')) {
    if (/^\S/.test(line)) {
      inJobs = line.startsWith('jobs:')
      current = null
      continue
    }
    if (!inJobs) continue
    const m = /^ {2}([\w-]+):\s*$/.exec(line)
    if (m) {
      current = []
      jobs.set(m[1], current)
    } else if (current) current.push(line)
  }
  return jobs
}

/** ジョブの直下（インデント 4）のキーの中身の行 */
function block(lines: string[], key: string): string[] {
  const start = lines.findIndex((l) => new RegExp(`^ {4}${key}:`).test(l))
  if (start < 0) return []
  const out = [lines[start]]
  for (const l of lines.slice(start + 1)) {
    if (/^ {0,4}\S/.test(l)) break
    out.push(l)
  }
  return out
}

describe('GitHub Actions の固定', () => {
  it.each(workflows)('%s の uses は 40 桁のコミット SHA と版のコメントで固定している', (file) => {
    const uses = read(file)
      .split('\n')
      .filter((l) => /^\s*(-\s+)?uses:/.test(l))
    expect(uses.length).toBeGreaterThan(0)
    for (const line of uses) {
      expect(line, line).toMatch(/uses:\s+[\w.-]+\/[\w./-]+@[0-9a-f]{40}\s+#\s+v\d+\.\d+\.\d+\s*$/)
    }
  })

  it.each(workflows)('%s に @latest・版の範囲の道具を使う箇所が無い', (file) => {
    const text = read(file)
    expect(text).not.toMatch(/@latest\b/)
    expect(text).not.toMatch(/\bnpx\b(?![^\n]*@\d+\.\d+\.\d+)/)
    // pnpm の版も固定する
    for (const m of text.matchAll(/^\s+version:\s*(\S+)\s*$/gm)) expect(m[1]).toMatch(/^\d+\.\d+\.\d+$/)
  })

  it.each(workflows)('%s は secrets をジョブ全体の env に置かない（使うステップにだけ渡す）', (file) => {
    const text = read(file)
    // トップレベルの env
    expect(text).not.toMatch(/^env:[\s\S]*?secrets\./m)
    for (const [name, lines] of jobsOf(text)) {
      expect(block(lines, 'env').join('\n'), `${file} の ${name}`).not.toMatch(/secrets\./)
    }
  })

  it('release は鍵も R2 のトークンも持たず、署名・下書き・R2 への公開をしない（security-7 [3][8]。公開は手元の手順だけ）', () => {
    const text = read(`${workflowDir}/release.yml`)
    expect(text).toMatch(/^permissions:\n {2}contents: read$/m)
    expect(text).not.toMatch(/secrets\./)
    // コメントの説明は除いて、実際に動くところに署名・R2・下書きが無い
    const code = text.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n')
    expect(code).not.toMatch(/release-signing\.mjs|release-r2\.mjs|gh release (create|upload)|workflow_dispatch|environment:/)
    expect(text).not.toMatch(/attest-build-provenance|id-token:/)
    // どのジョブもリポジトリへ書けない
    for (const [name, lines] of jobsOf(text)) expect(block(lines, 'permissions').join('\n'), name).not.toMatch(/write/)
    // 作ったジョブの中で sha256 を残す（受け渡しの後の値ではない）
    expect(text).toMatch(/sha256sum Ferret-\*/)
    // workflow の入力や vars を run の中へ式で直接埋め込まない（env を通す）
    for (const [name, lines] of jobsOf(text)) {
      const runs = lines.join('\n').split(/\n\s+(?=- |[\w-]+:)/).filter((b) => /^\s*run:/.test(b))
      for (const r of runs) expect(r, name).not.toMatch(/\$\{\{\s*(inputs|vars|github\.event)\./)
    }
  })

  it('どの workflow も署名の鍵・R2 のトークンを使わない（鍵を持つ処理がタグの中身を動かさない。security-7 [3]）', () => {
    for (const file of workflows) expect(read(file), file).not.toMatch(/RELEASE_SIGNING_KEY|CLOUDFLARE_API_TOKEN/)
  })
})

describe('workflow 全体の決まり（Orca を参考に足した workflow にも効かせる）', () => {
  /** - で始まる step ごとの行（インデントで区切る） */
  function steps(text: string): string[] {
    const out: string[] = []
    let current: string[] | null = null
    let indent = -1
    for (const line of text.split('\n')) {
      const m = /^(\s*)- /.exec(line)
      if (m && /^\s*- (uses|name|run|id|if|env|with):?/.test(line) && (indent < 0 || m[1].length <= indent)) {
        if (current) out.push(current.join('\n'))
        current = [line]
        indent = m[1].length
      } else if (current) {
        if (/^\S/.test(line) || (/\S/.test(line) && line.search(/\S/) <= indent && !/^\s*- /.test(line))) {
          out.push(current.join('\n'))
          current = null
          indent = -1
        } else current.push(line)
      }
    }
    if (current) out.push(current.join('\n'))
    return out
  }

  it.each(workflows)('%s は最上位の permissions を読むだけにし、書く権限はジョブごとに付ける', (file) => {
    const text = read(file)
    const top = /^permissions:\n((?: {2}.*\n)*)/m.exec(text)
    expect(top, file).not.toBeNull()
    expect(top![1]).not.toMatch(/write/)
    expect(text).not.toMatch(/\b(write-all|read-all)\b/)
  })

  it.each(workflows)('%s のジョブはすべて timeout-minutes を持つ', (file) => {
    for (const [name, lines] of jobsOf(read(file))) {
      expect(lines.some((l) => /^ {4}timeout-minutes:\s*\d+/.test(l)), `${file} の ${name}`).toBe(true)
    }
  })

  it.each(workflows)('%s の ubuntu は 24.04 に固定し、macOS は cross-platform と release だけで使う', (file) => {
    const text = read(file)
    const runners = [...text.matchAll(/^\s*(?:runs-on|runner):\s*(\S+)/gm)].map((m) => m[1])
    expect(runners.length).toBeGreaterThan(0)
    for (const r of runners) {
      if (/^ubuntu/.test(r)) expect(r, file).toBe('ubuntu-24.04')
      if (/^macos/.test(r)) expect([`${workflowDir}/cross-platform.yml`, `${workflowDir}/release.yml`]).toContain(file)
    }
  })

  it.each(workflows)('%s は E2E を参照しない（公開リポジトリには e2e/ を出さない）', (file) => {
    // 説明のコメント（「E2E は流さない」など）は除いて、実際に動く行だけを見る
    const code = read(file).split('\n').filter((l) => !/^\s*#/.test(l)).map((l) => l.replace(/\s#\s.*$/, '')).join('\n')
    expect(code).not.toMatch(/\be2e\b|playwright/i)
  })

  it.each(workflows)('%s の checkout は資格情報を残さない', (file) => {
    for (const step of steps(read(file)).filter((s) => /uses:\s+actions\/checkout@/.test(s))) {
      expect(step, file).toMatch(/persist-credentials:\s*false/)
    }
  })

  it.each(workflows)('%s の run の中へ入力・vars・イベントの値を式で直接埋め込まない（env を通す）', (file) => {
    for (const step of steps(read(file)).filter((s) => /^\s*-?\s*run:|\n\s+run:/.test(s))) {
      const run = step.slice(step.search(/run:/))
      expect(run, file).not.toMatch(/\$\{\{\s*(inputs|vars|github\.event|github\.head_ref)\b/)
    }
  })

  it.each(workflows)('%s が pull_request_target なら、PR のコードを取らず secrets も使わない', (file) => {
    const text = read(file)
    if (!/^\s+pull_request_target:/m.test(text)) return
    expect(text).not.toMatch(/actions\/checkout@/)
    expect(text).not.toMatch(/secrets\./)
    expect(text).not.toMatch(/github\.event\.pull_request\.head|github\.head_ref/)
  })

  it('Dependabot は main へ出し、actions と npm を見て、出たばかりの版は待つ', () => {
    const text = read('.github/dependabot.yml')
    const updates = text.split(/\n(?= {2}- package-ecosystem:)/).slice(1)
    expect(updates.map((u) => /package-ecosystem:\s*(\S+)/.exec(u)![1]).sort()).toEqual(['github-actions', 'npm'])
    for (const u of updates) {
      expect(u).toMatch(/target-branch:\s*main/)
      expect(u).toMatch(/cooldown:\n\s+default-days:\s*[1-9]\d*/)
    }
  })

  it('Orca を参考に足した workflow が実際にある（パスの書き間違いで素通りしない）', () => {
    expect(workflows).toEqual(expect.arrayContaining(['codeql.yml', 'dependency-review.yml', 'issue-labels.yml', 'pr-labels.yml', 'pr-caches.yml'].map((f) => `${workflowDir}/${f}`)))
  })
})

describe('secrets が無くても、タグの push で必ず落ちるワークフローにしない', () => {
  // 署名・R2 の secrets はまだ置かず、手元の手順で公開している。置いていないあいだも Release を赤にしない（RULES.md）
  const text = read(`${workflowDir}/release.yml`)
  const jobs = jobsOf(text)
  /** ジョブの steps を、- で始まる step ごとに分ける */
  const stepsOf = (lines: string[]) => lines.join('\n').split(/\n(?= {6}- )/).filter((b) => /^ {6}- /.test(b))

  it('release は secrets を使わないので、鍵が無くても落ちない（security-7 [3]）', () => {
    expect(text).not.toMatch(/secrets\./)
    expect([...jobs.keys()]).toEqual(['build'])
  })

  it('dependency review は依存グラフが切れているリポジトリでは notice を出して飛ばす', () => {
    const steps = stepsOf(jobsOf(read(`${workflowDir}/dependency-review.yml`)).get('review')!)
    expect(steps[0]).toMatch(/dependency-graph\/compare/)
    expect(steps[0]).toMatch(/::notice /)
    const action = steps.find((b) => /actions\/dependency-review-action@/.test(b))!
    expect(action).toMatch(/if: steps\.graph\.outputs\.enabled == 'true'/)
  })
})

describe('スクリプトの外の道具の起動', () => {
  it.each(scriptFiles)('%s で shell を使って起動しない', (file) => {
    expect(read(file)).not.toMatch(/shell:\s*(true|process\.platform)/)
  })

  it.each(scriptFiles)('%s に @latest や版を固定しない npx の指定が無い', (file) => {
    const text = read(file)
    expect(text).not.toMatch(/['"`][\w@/.-]+@latest['"`]/)
    expect(text).not.toMatch(/spawnSync\(\s*['"]npx['"]/)
  })

  it('package.json のスクリプトは npx で版を固定しない道具を取らない', () => {
    const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> }
    for (const [name, cmd] of Object.entries(pkg.scripts)) {
      expect(cmd, name).not.toMatch(/@latest\b/)
      expect(cmd, name).not.toMatch(/npx\s+(--yes\s+)?[\w@/.-]+@\d+(\.\d+)?(\s|$)/)
    }
  })

  it('wrangler は devDependencies で版を固定し、pnpm-lock.yaml に integrity がある', () => {
    const pkg = JSON.parse(read('package.json')) as { devDependencies: Record<string, string> }
    const version = pkg.devDependencies.wrangler
    expect(version).toMatch(/^\d+\.\d+\.\d+$/)
    const lock = read('pnpm-lock.yaml')
    expect(lock).toMatch(new RegExp(`\\n {2}wrangler@${escapeRegExp(version)}:\\n {4}resolution: \\{integrity: sha512-`))
  })

  it('release-r2.mjs は manifest の値をローカルのパスに使わず、R2 から読んだ JSON を確かめてから使う', () => {
    const text = read('scripts/release-r2.mjs')
    expect(text).not.toMatch(/join\(work,\s*f\.name\)/)
    expect(text).not.toMatch(/WRANGLER\s*=\s*process\.env/)
    expect(text).toMatch(/validateManifest\(/)
    expect(text).toMatch(/validateIndex\(/)
    // R2 の manifest・索引は getManifest / getIndex を通して読む（getJson を直接使うのは、その2つと「あるかどうか」だけ）
    const direct = [...text.matchAll(/getJson\(([^)]*)\)/g)].map((m) => m[1])
    expect(direct.sort()).toEqual(['`releases/${version}/manifest.json`', "'versions.json'", 'key', 'key'].sort())
  })

  it('検査の対象のファイルが実際にある（パスの書き間違いで素通りしない）', () => {
    // relative は OS の区切り（Windows は \）で返すので / にそろえて比べる
    expect(scriptFiles.map((f) => relative(root, join(root, f)).split(sep).join('/'))).toEqual(expect.arrayContaining(['scripts/release-r2.mjs', 'scripts/release-github.mjs', 'scripts/release-tools.mjs', 'scripts/sentry-sourcemaps.mjs', 'scripts/sentry-release.mjs', 'scripts/dev.mjs', 'scripts/install-app-deps.mjs']))
    expect(workflows).toEqual(expect.arrayContaining([`${workflowDir}/release.yml`, `${workflowDir}/cross-platform.yml`]))
  })
})

describe('ブランチは main だけ（develop は 2026-10-15 に廃止）', () => {
  it('workflow・Dependabot・公開の手順が develop ブランチを前提にしない', () => {
    for (const f of [...workflows, '.github/dependabot.yml', 'scripts/release-ci.mjs', 'CONTRIBUTING.md']) {
      expect(read(f), f).not.toMatch(/\bdevelop\b/)
    }
    expect(read('.github/workflows/cross-platform.yml')).toMatch(/branches:\s*\[main\]/)
    expect(read('.github/workflows/codeql.yml')).toMatch(/branches:\s*\[main\]/)
  })

  it('公開の squash は main だけを push し、既定の元も main', () => {
    const text = read('scripts/publish-squash.sh')
    expect(text).toContain('SOURCE_REF="${1:-main}"')
    const push = /^PUSH_CMD="(.*)"$/m.exec(text)![1]
    expect(push).toBe('git push $REMOTE $COMMIT:refs/heads/$BRANCH')
    expect(push).not.toMatch(/develop/)
  })
})
