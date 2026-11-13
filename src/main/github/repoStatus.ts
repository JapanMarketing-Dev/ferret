import { watch, type FSWatcher } from 'node:fs'
import type { GitRepoStatus } from '@shared/github'
import { run } from './gh'
import { AUTOMATIC_GIT_CONFIG, readGitStatus, trustedGit } from './gitSync'

/**
 * フッターの「どの GitHub / GitLab の、どのブランチか」。読み方と fetch・取り込み・push は gitSync.ts
 */
export async function gitRepoStatus(folderPath: string | null): Promise<GitRepoStatus> {
  // フッターが2か所（帯と「…」の中）にあるときなどに同じフォルダを同時に読むと git を重ねて走らせるので、走っている読み取りに相乗りする
  const key = folderPath ?? ''
  const running = reading.get(key)
  if (running) return running
  const next = readGitStatus(folderPath).finally(() => reading.delete(key))
  reading.set(key, next)
  return next
}
const reading = new Map<string, Promise<GitRepoStatus>>()

// ─── .git/HEAD の監視 ─────────────────────────────

let watched: { folder: string; watcher: FSWatcher | null } | null = null

/**
 * 開いているプロジェクトの .git を見張り、HEAD（ブランチの切り替え）と index（コミット・ステージ）が
 * 変わったら onChange を呼ぶ。続けて起きた変化はまとめて1回にする。
 * 呼ぶたびに対象のフォルダを確かめ、プロジェクトが変わっていれば見張り直す。
 */
export async function watchGitHead(folderPath: string | null, onChange: () => void): Promise<void> {
  if (watched?.folder === folderPath) return
  watched?.watcher?.close()
  watched = folderPath ? { folder: folderPath, watcher: null } : null
  if (!folderPath) return
  const current = watched
  // worktree では .git がファイルなので、git に本当の置き場を聞く
  const git = await trustedGit(folderPath)
  if (!git || watched !== current) return
  const gitDir = await run(git, ['-C', folderPath, ...AUTOMATIC_GIT_CONFIG, 'rev-parse', '--absolute-git-dir'], { timeoutMs: 5_000 })
  if (gitDir.failed || watched !== current) return
  let timer: NodeJS.Timeout | null = null
  try {
    current!.watcher = watch(gitDir.stdout.trim(), (_event, filename) => {
      if (filename !== 'HEAD' && filename !== 'index') return
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => { timer = null; onChange() }, 500)
    })
    current!.watcher.on('error', () => current!.watcher?.close())
  } catch {
    // 見張れなくても、定期の読み直しとウインドウを前に出したときの読み直しで追いつく
  }
}
