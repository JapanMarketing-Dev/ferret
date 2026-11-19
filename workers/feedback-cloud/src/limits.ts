/**
 * この Worker だけが使う値（頻度の上限と、読む数の上限）。形と大きさの正本は src/shared/feedbackCloud.ts。
 */
import type { Window } from '../../feedback-relay/src/limiter'

const MINUTE = 60 * 1000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/** コードを送る数。メールアドレスごと（人に迷惑なメールを送らせない）・IP ごと */
export const START_PER_EMAIL: readonly Window[] = [{ windowMs: 10 * MINUTE, max: 3 }, { windowMs: DAY, max: 20 }]
export const START_PER_IP: readonly Window[] = [{ windowMs: HOUR, max: 20 }, { windowMs: DAY, max: 100 }]
/** コードを確かめる数。IP ごと・メールアドレスごと（1つのコードは CLOUD_LIMITS.codeAttempts 回まで） */
export const VERIFY_PER_IP: readonly Window[] = [{ windowMs: HOUR, max: 30 }, { windowMs: DAY, max: 200 }]
export const VERIFY_PER_EMAIL: readonly Window[] = [{ windowMs: HOUR, max: 20 }, { windowMs: DAY, max: 60 }]
/** 招待のメールを送る数。人ごと */
export const INVITE_PER_USER: readonly Window[] = [{ windowMs: HOUR, max: 30 }, { windowMs: DAY, max: 100 }]
/** 指摘を送る数。人ごと（アプリは変わったときにまとめて送る） */
export const UPLOAD_PER_USER: readonly Window[] = [{ windowMs: HOUR, max: 600 }, { windowMs: DAY, max: 5000 }]

/** GET /v1/feedback で返す数（自分の分・チームごと） */
export const READ_LIMIT = 5000
/** 1人が持てるセッション（新しい順にこの数まで残す） */
export const SESSIONS_PER_USER = 50
/** 1回の INSERT に入れる指摘の JSON の大きさ（D1 の1つの値は 2MB まで） */
export const INSERT_CHUNK_BYTES = 900_000

export const COOKIE_NAME = '__Host-ferret_session'
