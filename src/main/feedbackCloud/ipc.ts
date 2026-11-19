/**
 * Ferret アカウント（メールのコードでログイン・指摘を PC とチームで共有）の IPC ハンドラ。index.ts の registerIpc の dispatcher に混ぜて登録する
 * （アプリの窓の本体のフレームからだけ受ける。security-5 [1]）。
 * トークンは main だけが持つ（store.ts）。画面へはメールアドレスと数だけを返す。チームの管理は Web（account.ferretade.dev）で行う
 */
import type { IpcRequests } from '@shared/ipc'
import { CLOUD_BASE } from '@shared/feedbackCloud'
import { t } from '@shared/i18n'
import { UserFacingError } from '@shared/errors'
import { CloudApiError } from './client'
import type { CloudService } from './service'

type Channel = 'cloud:status' | 'cloud:start' | 'cloud:verify' | 'cloud:logout' | 'cloud:openWeb' | 'cloud:syncNow'

export interface FeedbackCloudDeps {
  service: () => Promise<CloudService>
  /** Web の画面を既定のブラウザで開く */
  openExternal: (url: string) => Promise<void>
  /** Worker の場所（開発版だけ手元の Worker に向けられる。index.ts） */
  base?: string
  /** 今すぐ同期する（この PC の指摘を集めて送り、読んだ分で feedback.md を書き直す）。失敗は CloudApiError で投げる */
  syncNow: () => Promise<void>
}

/** Worker の失敗を、利用者に見せる文にする（トークン・本文は出さない） */
export function cloudErrorMessage(err: CloudApiError): string {
  switch (err.code) {
    case 'bad_email': return t('cloud.errors.badEmail')
    case 'bad_code': return t('cloud.errors.badCode')
    case 'code_expired': return t('cloud.errors.codeExpired')
    case 'rate_limited': return t('cloud.errors.rateLimited')
    case 'network': return t('cloud.errors.network')
    case 'unauthorized': return t('cloud.errors.signedOut')
    case 'mail_failed': return t('cloud.errors.mailFailed')
    default: return t('cloud.errors.failed')
  }
}

async function friendly<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work()
  } catch (err) {
    if (err instanceof CloudApiError) throw new UserFacingError(cloudErrorMessage(err))
    throw err
  }
}

export function feedbackCloudHandlers(deps: FeedbackCloudDeps): { [C in Channel]: (...args: Parameters<IpcRequests[C]>) => unknown } {
  return {
    'cloud:status': async () => (await deps.service()).status(),
    'cloud:start': async (email) => {
      if (typeof email !== 'string') throw new UserFacingError(t('cloud.errors.badEmail'))
      const service = await deps.service()
      await friendly(() => service.start(email))
    },
    'cloud:verify': async (code) => {
      if (typeof code !== 'string' || !/^\d{6}$/.test(code.replace(/\s+/g, ''))) throw new UserFacingError(t('cloud.errors.badCode'))
      const service = await deps.service()
      const status = await friendly(() => service.verify(code))
      // ログインしたらすぐ送って読む（失敗しても次の書き直しでまた試す）
      void deps.syncNow().catch(() => undefined)
      return status
    },
    'cloud:logout': async () => {
      await (await deps.service()).logout()
      return (await deps.service()).status()
    },
    'cloud:openWeb': () => deps.openExternal(deps.base ?? CLOUD_BASE),
    'cloud:syncNow': async () => {
      const service = await deps.service()
      if (!(await service.status()).loggedIn) throw new UserFacingError(t('cloud.errors.signedOut'))
      await friendly(() => deps.syncNow())
      return service.status()
    }
  }
}
