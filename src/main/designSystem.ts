import { readdir, readFile, stat } from 'node:fs/promises'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { join } from 'node:path'
import { DESIGN_SYSTEM_CONFIG, isLocalStorybookUrl, resolveDesignSystem, type DesignSystemStatus } from '@shared/designSystem'

/**
 * デザインシステムのタブ（Storybook）の状態。プロジェクトのフォルダは読むだけ（package.json・.storybook/・
 * .ferret/design-system.json・直下のファイル名）。動いているかは手元の URL に HTTP で聞いて確かめる。
 * 起動そのものは renderer がターミナルで行う（出力が見え、人が止められる）
 */

/** 読むファイルの大きさの上限 */
const MAX_BYTES = 256 * 1024
/** 動いているかを聞く時間の上限 */
const PROBE_TIMEOUT_MS = 1200

async function readSmall(path: string): Promise<string | null> {
  try {
    const info = await stat(path)
    if (!info.isFile() || info.size > MAX_BYTES) return null
    return await readFile(path, 'utf8')
  } catch {
    return null
  }
}

async function isDir(path: string): Promise<boolean> {
  try { return (await stat(path)).isDirectory() } catch { return false }
}

/** TLS の証明書の検証で止まったか（つながって、サーバーは答えている） */
export function isCertificateError(err: { code?: string } | null | undefined): boolean {
  const code = err?.code ?? ''
  return /CERT|SELF_SIGNED|UNABLE_TO_VERIFY|ERR_TLS/.test(code)
}

/** 手元の URL が HTTP で答えるか（状態コードは問わない。つながらない・時間切れなら false） */
export function probeLocalUrl(url: string, timeoutMs = PROBE_TIMEOUT_MS): Promise<boolean> {
  if (!isLocalStorybookUrl(url)) return Promise.resolve(false)
  return new Promise((resolve) => {
    let done = false
    const finish = (ok: boolean) => { if (!done) { done = true; resolve(ok) } }
    try {
      const req = (url.startsWith('https:') ? httpsRequest : httpRequest)(url, { method: 'GET', timeout: timeoutMs }, (res) => {
        res.resume()
        finish(true)
      })
      req.on('timeout', () => { req.destroy(); finish(false) })
      // 手元の https が自己署名の証明書なら、検証は外さずに「答えている」とだけ見る（中身は読まない）
      req.on('error', (err: NodeJS.ErrnoException) => finish(isCertificateError(err)))
      req.end()
    } catch {
      finish(false)
    }
  })
}

export async function designSystemStatus(root: string, probe: (url: string) => Promise<boolean> = probeLocalUrl): Promise<DesignSystemStatus> {
  const [packageJson, hasStorybookDir, rootFiles, config] = await Promise.all([
    readSmall(join(root, 'package.json')),
    isDir(join(root, '.storybook')),
    readdir(root).catch(() => [] as string[]),
    readSmall(join(root, ...DESIGN_SYSTEM_CONFIG.split('/')))
  ])
  const found = resolveDesignSystem({ packageJson, hasStorybookDir, rootFiles: rootFiles.slice(0, 500), config })
  if (!found.present) return { state: 'none', url: found.url }
  const running = await probe(found.url)
  return { state: running ? 'running' : 'stopped', url: found.url, ...(found.command ? { command: found.command } : {}) }
}
