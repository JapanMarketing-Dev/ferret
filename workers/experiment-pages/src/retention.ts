import { log } from './log'
import { addDays, jstDay } from './time'

export const INTEREST_RETENTION_DAYS = 180
export const DEDUPE_RETENTION_DAYS = 2

export interface RetentionResult {
  interests: number
  seenHashes: number
  rateCounters: number
}

/**
 * 保持期間を過ぎたデータを消す（毎日の cron から呼ぶ）。
 * - 関心表明: 作成から 180 日を過ぎたもの
 * - 重複除外ハッシュ: 日付（日本時間）が今日から 2 日より前のもの
 * - 回数制限カウンタ: 期限切れのもの
 */
export async function runRetention(db: D1Database, now: Date): Promise<RetentionResult> {
  const interestCutoff = new Date(now.getTime() - INTEREST_RETENTION_DAYS * 86_400_000).toISOString()
  const seenCutoff = addDays(jstDay(now), -DEDUPE_RETENTION_DAYS)
  const [i, s, r] = await db.batch([
    db.prepare('DELETE FROM interests WHERE created_at < ?').bind(interestCutoff),
    db.prepare('DELETE FROM seen_hashes WHERE day < ?').bind(seenCutoff),
    db.prepare('DELETE FROM rate_counters WHERE expires_at < ?').bind(now.toISOString()),
  ])
  const result = {
    interests: i?.meta.changes ?? 0,
    seenHashes: s?.meta.changes ?? 0,
    rateCounters: r?.meta.changes ?? 0,
  }
  log('info', 'retention_done', { ...result })
  return result
}
