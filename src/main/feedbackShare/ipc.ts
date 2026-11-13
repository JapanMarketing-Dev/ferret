/**
 * 共有リンク（ログイン無しで誰でも指摘を送れる）の IPC ハンドラ。index.ts の registerIpc の dispatcher に混ぜて登録する
 * （アプリの窓の本体のフレームからだけ受ける。security-5 [1]）。
 *
 * - 共有は「見てほしいページの URL」で作る（静止画は上げない）。相手は元のページをライブで開き、アプリのフィードバックと同じ道具で録画して送る
 * - 共有ボタンを押したら、開いているページの共有（同じプロジェクトで同じ URL の、期限内のもの）を使い、無ければ作る。リンクは画面がコピーする
 * - メモとパスワード: パスワードがあれば、メモは main が暗号化して暗号文だけを送り、Worker にはパスワードの確認の値（証明の SHA-256）だけを送る
 *   （@shared/shareCrypto）。パスワードは画面へ返さず、コピーは main がクリップボードへ写す
 * - 持ち主のトークンは main だけが持つ（store.ts）
 * - 届いた録画は mtg の取り込みと同じ流れでレビューにする（meeting/import.ts の importShareRecording。送った人の名前付き）。
 *   取り込んだら Worker の側も「取り込み済み」にする
 */
import { clipboard, safeStorage } from 'electron'
import { open } from 'node:fs/promises'
import { join } from 'node:path'
import type { IpcRequests } from '@shared/ipc'
import {
  SHARE_LIMITS,
  cleanText,
  sanitizeShareUrls,
  sharePasswordProblem,
  type ShareEventsFile,
  type ShareMemo,
  type ShareRecording,
  type ShareSettingsInput
} from '@shared/feedbackShare'
import { t } from '@shared/i18n'
import { UserFacingError } from '@shared/errors'
import type { ReviewData } from '@shared/review'
import { ShareApiError, ShareClient, type ShareFetch, type SharePatch } from './client'
import type { ShareStore, StoredShare } from './store'

type Channel = 'share:list' | 'share:forPage' | 'share:create' | 'share:settings' | 'share:update' | 'share:copyPassword' | 'share:open' | 'share:setStatus' | 'share:import' | 'share:delete'

export interface FeedbackShareDeps {
  projectId: () => string | null
  projectDir: () => string | null
  fetch: ShareFetch
  /** Worker の場所。省略時は share.ferretade.dev（開発版だけ手元の Worker に向けられる。index.ts） */
  base?: string
  userAgent: string
  installId: () => string | null
  userDataDir: () => string
  isPackaged: boolean
  /** 届いた録画を mtg と同じ流れでレビューにする（index.ts が meeting/import.ts の importShareRecording に設定の文字起こしなどを付けて渡す） */
  importRecording: (input: { projectDir: string; recording: ShareRecording; events: ShareEventsFile | null; download: (dest: string) => Promise<void> }) => Promise<ReviewData>
  /** 平文をクリップボードへ（テストでは差し替える） */
  writeClipboard?: (text: string) => void
}

/** 画面から来た設定を確かめる。合わなければ UserFacingError */
export function readSettingsInput(raw: unknown): ShareSettingsInput {
  const r = (raw ?? {}) as Record<string, unknown>
  const title = cleanText(r.title ?? '', SHARE_LIMITS.titleChars)
  if (title === null) throw new UserFacingError(t('share.errors.tooLong'))
  const urls = sanitizeShareUrls(r.urls)
  if (!urls) throw new UserFacingError(t('share.errors.urls'))
  const memo = cleanText(r.memo ?? '', SHARE_LIMITS.memoChars, { multiline: true })
  if (memo === null) throw new UserFacingError(t('share.errors.tooLong'))
  let password: string | null | undefined
  if (r.password === null) password = null
  else if (typeof r.password === 'string') {
    const problem = sharePasswordProblem(r.password)
    if (problem) throw new UserFacingError(t(problem === 'short' ? 'share.errors.passwordShort' : 'share.errors.passwordLong', { min: SHARE_LIMITS.passwordMinChars, max: SHARE_LIMITS.passwordMaxChars }))
    password = r.password
  }
  return { title, urls, memo, ...(password !== undefined ? { password } : {}) }
}

/** 送るメモとパスワードの確認の値。パスワードがあればメモは暗号文だけ */
async function sealed(memo: string, password: string | undefined): Promise<{ memo: ShareMemo | null; auth: SharePatch['auth'] }> {
  const { makeAuthVerifier, sealMemo } = await import('@shared/shareCrypto')
  if (!password) return { memo: memo ? { kind: 'plain', text: memo } : null, auth: null }
  return { memo: memo ? { kind: 'sealed', sealed: await sealMemo(password, memo) } : null, auth: await makeAuthVerifier(password) }
}

export function feedbackShareHandlers(deps: FeedbackShareDeps): { [C in Channel]: (...args: Parameters<IpcRequests[C]>) => unknown } {
  const client = new ShareClient({ fetch: deps.fetch, userAgent: deps.userAgent, ...(deps.base ? { base: deps.base } : {}) })
  const writeClipboard = deps.writeClipboard ?? ((text: string) => clipboard.writeText(text))
  let store: ShareStore | null = null
  const shares = async (): Promise<ShareStore> => {
    if (!store) {
      const [{ ShareStore: Store }, { chooseKeyCipher }] = await Promise.all([import('./store'), import('../pipeline/stt/keys')])
      store = new Store(join(deps.userDataDir(), 'feedback-share', 'shares.bin'), chooseKeyCipher({ isPackaged: deps.isPackaged, safeStorage }))
    }
    return store
  }
  const summarize = async (share: StoredShare) => (await import('./store')).summarize(share)
  const project = (): string => {
    const id = deps.projectId()
    if (!id) throw new UserFacingError(t('errors.openProjectFolder'))
    return id
  }
  const owned = async (shareId: unknown): Promise<StoredShare> => {
    if (typeof shareId !== 'string') throw new UserFacingError(t('share.errors.notFound'))
    const share = await (await shares()).get(project(), shareId)
    if (!share) throw new UserFacingError(t('share.errors.notFound'))
    return share
  }
  /** Worker の失敗を、利用者に見せる文にする（トークン・本文は出さない） */
  const friendly = async <T>(work: () => Promise<T>, shareId?: string): Promise<T> => {
    try {
      return await work()
    } catch (err) {
      if (!(err instanceof ShareApiError)) throw err
      // 期限切れ・消えた共有は控えからも消す
      if (shareId && (err.code === 'gone' || err.code === 'not_found' || err.code === 'unauthorized')) await (await shares()).remove(shareId).catch(() => undefined)
      const key = err.code === 'network' ? 'share.errors.network'
        : err.code === 'rate_limited' ? 'share.errors.rateLimited'
          : err.code === 'gone' || err.code === 'not_found' || err.code === 'unauthorized' ? 'share.errors.notFound'
            : err.code === 'full' ? 'share.errors.full'
              : err.code === 'too_large' || err.code === 'bad_media' ? 'share.errors.media' : 'share.errors.failed'
      throw new UserFacingError(t(key))
    }
  }
  const create = async (input: ShareSettingsInput): Promise<StoredShare> => {
    const projectId = project()
    const password = input.password ?? undefined
    const { memo, auth } = await sealed(input.memo, password)
    return friendly(async () => {
      const title = input.title || input.urls[0]!.title || input.urls[0]!.url
      const created = await client.create({ title, urls: input.urls, ...(memo ? { memo } : {}), ...(auth ? { auth } : {}), ...(deps.installId() ? { installId: deps.installId()! } : {}) })
      const share: StoredShare = {
        id: created.id, projectId, title, url: created.url, createdAt: new Date().toISOString(), expiresAt: created.expiresAt,
        ownerToken: created.ownerToken, urls: input.urls, memo: input.memo, ...(password ? { password } : {})
      }
      await (await shares()).add(share)
      return share
    })
  }

  return {
    'share:list': async () => {
      const store = await shares()
      return { shares: deps.projectId() ? await store.list(deps.projectId()!) : [], persisted: store.persisted() }
    },
    'share:forPage': async (page) => {
      const urls = sanitizeShareUrls([page])
      if (!urls) throw new UserFacingError(t('share.errors.noPage'))
      const projectId = project()
      const store = await shares()
      // 同じプロジェクトで同じページの、期限まで1日以上ある共有はそのまま使う（押すたびに増やさない）
      const soon = Date.now() + 24 * 60 * 60 * 1000
      const mine = await store.list(projectId)
      const found = mine.find((s) => Date.parse(s.expiresAt) > soon && s.urls.some((u) => u.url === urls[0]!.url))
      if (found) return { share: found, created: false }
      return { share: await summarize(await create({ title: '', urls, memo: '' })), created: true }
    },
    'share:create': async (input) => summarize(await create(readSettingsInput(input))),
    'share:settings': async (shareId) => {
      const share = await owned(shareId)
      return { title: share.title, urls: share.urls, memo: share.memo, protected: !!share.password, hasPassword: !!share.password }
    },
    'share:update': async (shareId, input) => {
      const share = await owned(shareId)
      const next = readSettingsInput(input)
      const password = next.password === undefined ? share.password : next.password ?? undefined
      const { memo, auth } = await sealed(next.memo, password)
      const title = next.title || next.urls[0]!.title || next.urls[0]!.url
      // パスワードを変えないときは確認の値を送り直さない（相手の確認済みの状態を保つ）。メモはパスワードの有無に合わせて送り直す
      const passwordChanged = next.password !== undefined && next.password !== (share.password ?? null)
      await friendly(() => client.update(share.id, share.ownerToken, { title, urls: next.urls, memo, ...(passwordChanged ? { auth } : {}) }), share.id)
      const updated: StoredShare = { ...share, title, urls: next.urls, memo: next.memo }
      if (password) updated.password = password
      else delete updated.password
      await (await shares()).replace(updated)
      return summarize(updated)
    },
    'share:copyPassword': async (shareId) => {
      const share = await owned(shareId)
      if (!share.password) throw new UserFacingError(t('share.errors.noPassword'))
      writeClipboard(share.password)
    },
    'share:open': async (shareId) => {
      const share = await owned(shareId)
      return friendly(async () => {
        const snapshot = await client.snapshot(share.id, share.ownerToken)
        const thumbnails: Record<string, string> = {}
        // サムネイルは新しいものから、数を限って取る（多い共有で待たせない）
        const wanted = [...snapshot.recordings].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).filter((r) => r.hasThumbnail).slice(0, 30)
        await Promise.all(wanted.map(async (rec) => {
          const bytes = await client.thumbnail(share.id, share.ownerToken, rec)
          if (bytes) thumbnails[rec.id] = `data:image/jpeg;base64,${Buffer.from(bytes).toString('base64')}`
        }))
        return { snapshot, thumbnails }
      }, share.id)
    },
    'share:setStatus': async (shareId, recordingId, status) => {
      const share = await owned(shareId)
      if (typeof recordingId !== 'string' || (status !== 'new' && status !== 'rejected')) throw new UserFacingError(t('share.errors.failed'))
      await friendly(() => client.setStatus(share.id, share.ownerToken, recordingId, status), share.id)
    },
    'share:import': async (shareId, recordingId) => {
      const share = await owned(shareId)
      const dir = deps.projectDir()
      if (!dir) throw new UserFacingError(t('errors.openProjectFolder'))
      if (typeof recordingId !== 'string') throw new UserFacingError(t('share.errors.failed'))
      const { recording, events } = await friendly(async () => {
        const snapshot = await client.snapshot(share.id, share.ownerToken)
        const recording = snapshot.recordings.find((r) => r.id === recordingId)
        if (!recording) throw new UserFacingError(t('share.errors.notFound'))
        return { recording, events: await client.events(share.id, share.ownerToken, recording) }
      }, share.id)
      const review = await deps.importRecording({
        projectDir: dir, recording, events,
        // 録画は新しいファイルとして書く（既にある名前・リンクには書かない）
        download: (dest) => friendly(async () => {
          const file = await open(dest, 'wx', 0o600)
          try {
            await client.media(share.id, share.ownerToken, recording, async (chunk) => { await file.write(chunk) })
          } finally {
            await file.close()
          }
        }, share.id)
      })
      // 取り込んだ印を付ける（失敗しても取り込みは済んでいる。次に開いたときにまた選べる）
      await client.setStatus(share.id, share.ownerToken, recording.id, 'imported').catch(() => undefined)
      return review
    },
    'share:delete': async (shareId) => {
      const share = await owned(shareId)
      try {
        await client.remove(share.id, share.ownerToken)
      } catch (err) {
        // 期限切れなどで Worker に無いものは、控えから消せば済む。通信の失敗などは知らせる（Worker に残したまま控えだけ消さない）
        const missing = err instanceof ShareApiError && (err.code === 'gone' || err.code === 'not_found' || err.code === 'unauthorized')
        if (!missing) return friendly(() => Promise.reject(err))
      }
      await (await shares()).remove(share.id)
    }
  }
}
