/**
 * Electron 本体（dist/）が無ければ取得する。
 *
 * pnpm はビルドスクリプトの結果をストアにキャッシュするため、クリーンインストールでも
 * electron の postinstall（バイナリのダウンロード）が走らず、`dist/` が無いまま終わることがある。
 * その状態だと `pnpm dev` も「Electron が見つからない」で止まるので、
 * インストールの最後に存在を確かめ、無ければ electron 自身の install.js を実行する。
 */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

const require = createRequire(import.meta.url)

let packageDir
try {
  packageDir = dirname(require.resolve('electron/package.json'))
} catch {
  console.warn('[electron] パッケージが見つかりません。スキップします')
  process.exit(0)
}

if (existsSync(join(packageDir, 'path.txt')) && existsSync(join(packageDir, 'dist'))) {
  process.exit(0)
}

console.log('[electron] 本体が見つかりません。取得します')
const result = spawnSync(process.execPath, [join(packageDir, 'install.js')], {
  cwd: packageDir,
  stdio: 'inherit'
})

if (result.status !== 0 || !existsSync(join(packageDir, 'dist'))) {
  console.error(
    '[electron] 本体を取得できませんでした。手動で次を実行してください:\n' +
      `  node "${join(packageDir, 'install.js')}"`
  )
  process.exit(1)
}
