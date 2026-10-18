declare global {
  namespace Cloudflare {
    interface Env {
      DB: D1Database
      /** 版の情報（Sentry の release に使う） */
      CF_VERSION_METADATA?: WorkerVersionMetadata
      /** 管理 API の Bearer トークン（32 文字以上。未設定・短いときは管理 API をすべて拒否） */
      ADMIN_TOKEN?: string
      /** 訪問者ハッシュ用の秘密（32 文字以上。未設定なら計測と関心表明の受付を止める） */
      HASH_SALT?: string
      /** Sentry の DSN（未設定なら Sentry は何もしない） */
      SENTRY_DSN?: string
      /** PostHog のプロジェクトキー（未設定なら第三者スクリプトを出さない） */
      POSTHOG_KEY?: string
      /** PostHog の送信先（例: https://us.i.posthog.com） */
      POSTHOG_HOST?: string
    }
  }
}

export type Env = Cloudflare.Env

export const MIN_SECRET_LENGTH = 32

export function hashSalt(env: Env): string | null {
  const salt = env.HASH_SALT
  return typeof salt === 'string' && salt.length >= MIN_SECRET_LENGTH ? salt : null
}
