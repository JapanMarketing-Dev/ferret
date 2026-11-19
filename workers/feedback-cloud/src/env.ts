/**
 * Worker が受け取る env と、使う Cloudflare の API の最小限の型（feedback-share と同じ考え方）。
 * @cloudflare/workers-types に頼らず、使う分だけを書く（単体テストの偽の env も同じ形で作る）。
 */
import type { LimiterNamespace } from '../../feedback-relay/src/env'

export type { LimiterNamespace }

export type D1Value = string | number | null

export interface D1Result<T = Record<string, unknown>> {
  results: T[]
  meta?: { changes?: number }
}

export interface D1PreparedStatement {
  bind(...values: D1Value[]): D1PreparedStatement
  first<T = Record<string, unknown>>(): Promise<T | null>
  all<T = Record<string, unknown>>(): Promise<D1Result<T>>
  run(): Promise<D1Result>
}

/** D1（batch は1つのトランザクションで流れる。途中で失敗すれば全部が戻る） */
export interface D1Database {
  prepare(sql: string): D1PreparedStatement
  batch(statements: D1PreparedStatement[]): Promise<D1Result[]>
}

/** Cloudflare Email Service の send_email binding。失敗は code の付いた例外 */
export interface EmailSender {
  send(message: { from: { email: string; name: string }; to: string; subject: string; text: string; html?: string }): Promise<unknown>
}

export interface Env {
  /** ログインのコードの HMAC の秘密。wrangler secret put で入れる */
  AUTH_SECRET: string
  /** 頻度の上限の鍵（IP・メールアドレスの HMAC）の秘密。wrangler secret put で入れる */
  RATE_LIMIT_SALT: string
  /** この Worker の公開 URL（末尾の / なし）。Origin の確認と招待のリンクに使う */
  PUBLIC_BASE: string
  /** 送り元のアドレス（send_email の allowed_sender_addresses と同じ） */
  MAIL_FROM: string
  DB: D1Database
  EMAIL: EmailSender
  /** 頻度の上限（feedback-relay の FeedbackLimiter） */
  LIMITER: LimiterNamespace
}
