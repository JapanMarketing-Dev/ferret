import { rm } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * 削除した「発信」（X・ブログへの投稿の下書き。2026-11-13 に機能ごと削除）が userData に残したものを消す。
 * X のトークン・ブログの秘密が入っているので、起動ごとに確かめて消す（配布版・開発版とも）。
 * 消すのは前の版が使っていたこの2つの場所だけ。無くても失敗しない。リンクは辿らない（リンクそのものを消す）
 */
export const LEGACY_PUBLISH_PATHS = ['publish', 'publish-connections.bin'] as const

export async function removeLegacyPublishData(userData: string): Promise<string[]> {
  const removed: string[] = []
  let failure: unknown = null
  for (const name of LEGACY_PUBLISH_PATHS) {
    const path = join(userData, name)
    try {
      await rm(path, { recursive: true })
      removed.push(path)
    } catch (err) {
      // 無いのはふつう。消せないもの（権限など）は、もう1つを消してから知らせる
      if ((err as NodeJS.ErrnoException | null)?.code !== 'ENOENT') failure ??= err
    }
  }
  if (failure) throw failure
  return removed
}
