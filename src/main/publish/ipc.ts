/**
 * 発信（X とブログへの投稿）の IPC ハンドラ。index.ts の registerIpc の dispatcher に混ぜて登録する
 * （アプリの窓の本体のフレームからだけ受ける。security-5 [1]）。
 *
 * - 下書きは store.ts（1つだけ作って共有する）、AI の生成は background.ts を必ず通す（同時に1つだけ）
 * - メディアの実パスは main だけが持つ。画面へは見本（サムネイル）と名前だけを返す
 * - X へは X API で投稿する。利用者が自分の Client ID を入れ、既定のブラウザで X にログインして許可する（OAuth 2.0 PKCE）。
 *   トークンは connections.ts（暗号化）だけが持ち、画面へは @ユーザー名だけを返す
 * - ブログ（WordPress・EmDash）は、接続を確かめてから登録する。秘密は URL と一緒にしか登録できない
 * - 投稿する本文は main が保存した下書きから作る（画面から届いた文をそのまま送らない）
 */
import { lstat, realpath } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import type { IpcRequests } from '@shared/ipc'
import {
  PUBLISH_LIMITS, X_OAUTH, mediaKindOf, xCallbackUrl, xMediaProblem,
  type PostBlogResult, type PostDraftPatch, type PostXResult, type PublishConnectionsInfo, type PublishGenerateRequest
} from '@shared/publish'
import { splitForThread } from '@shared/xPost'
import { t } from '@shared/i18n'
import { UserFacingError } from '@shared/errors'
import type { PublishBackground } from './background'
import { publishText, type PublishStore, type ThumbnailMaker } from './store'
import type { PublishConnections } from './connections'
import { readBlogInput } from './connections'
import type { CallbackOptions, CallbackWaiter } from './xAuthServer'
import {
  XAuthError, XClient, authorizeUrl, exchangeCode, fetchMe, freshTokens, makePkce, postThread, postUrl, revokeToken,
  type ChunkReader, type Fetcher
} from './xApi'
import { postToBlog, testBlog, type BlogDeps } from './blogApi'

type Channel = 'publish:list' | 'publish:generate' | 'publish:create' | 'publish:update' | 'publish:remove' | 'publish:pickMedia'
  | 'publish:addProjectMedia' | 'publish:setBackground' | 'publish:connections' | 'publish:setXClientId' | 'publish:connectX'
  | 'publish:cancelConnectX' | 'publish:disconnectX' | 'publish:addBlog' | 'publish:removeBlog' | 'publish:postX' | 'publish:postBlog'

export interface PublishIpcDeps {
  projectId: () => string | null
  projectDir: () => string | null
  store: PublishStore
  background: PublishBackground
  thumbnail: ThumbnailMaker
  connections: PublishConnections
  /** 外向きの HTTP（main の net.fetch。リダイレクトは追わない） */
  fetcher: Fetcher
  /** 既定のブラウザで開く */
  openExternal: (url: string) => Promise<void>
  waitForCallback: (options: CallbackOptions) => CallbackWaiter
  readChunk?: ChunkReader
  readFile?: BlogDeps['readFile']
  /** 画像・動画を選ばせる（絶対パス。選ばなければ空） */
  pickFiles: () => Promise<string[]>
  notifyChanged: () => void
}

const str = (v: unknown, max: number): string | undefined => (typeof v === 'string' ? v.slice(0, max) : undefined)

/** 画面から来た生成の指示を確かめる */
export function readGenerateRequest(raw: unknown): PublishGenerateRequest {
  const r = (raw ?? {}) as Record<string, unknown>
  const text = str(r.text, PUBLISH_LIMITS.sourceTextChars)?.trim()
  const textLabel = str(r.textLabel, 200)?.trim()
  const intent = str(r.intent, PUBLISH_LIMITS.intentChars)?.trim()
  return { ...(text ? { text } : {}), ...(text && textLabel ? { textLabel } : {}), ...(intent ? { intent } : {}) }
}

/** 画面から来た下書きの変更を確かめる（長さ・状態の移り方は store が確かめる） */
export function readDraftPatch(raw: unknown): PostDraftPatch {
  const r = (raw ?? {}) as Record<string, unknown>
  const patch: PostDraftPatch = {}
  if (typeof r.title === 'string') patch.title = r.title
  if (typeof r.text === 'string') patch.text = r.text
  if (typeof r.articleTitle === 'string') patch.articleTitle = r.articleTitle
  if (typeof r.articleBody === 'string') patch.articleBody = r.articleBody
  if (r.status === 'new' || r.status === 'posted' || r.status === 'dismissed') patch.status = r.status
  if (Array.isArray(r.mediaOrder)) patch.mediaOrder = r.mediaOrder.filter((id): id is string => typeof id === 'string').slice(0, 20)
  return patch
}

/** プロジェクトの中の普通のファイル（シンボリックリンクで外へ出ない）の実パス。外なら null */
export async function projectFile(projectDir: string, relPath: string): Promise<{ path: string; bytes: number; ref: string } | null> {
  if (!relPath || isAbsolute(relPath) || relPath.split(/[\\/]/).includes('..')) return null
  try {
    const root = await realpath(projectDir)
    const real = await realpath(resolve(root, relPath))
    const rel = relative(root, real)
    if (!rel || rel.startsWith('..') || isAbsolute(rel) || rel.split(sep).includes('..')) return null
    const info = await lstat(real)
    return info.isFile() ? { path: real, bytes: info.size, ref: rel.split(sep).join('/') } : null
  } catch {
    return null
  }
}

export function publishHandlers(deps: PublishIpcDeps): { [C in Channel]: (...args: Parameters<IpcRequests[C]>) => unknown } {
  const project = (): string => {
    const id = deps.projectId()
    if (!id) throw new UserFacingError(t('errors.openProjectFolder'))
    return id
  }
  const draftId = (id: unknown): string => {
    if (typeof id !== 'string' || !id) throw new UserFacingError(t('publish.errors.draftNotFound'))
    return id
  }
  const changed = <T>(value: T): T => { deps.notifyChanged(); return value }
  /** 今待っている X の認証（同時に1つだけ） */
  let pendingAuth: CallbackWaiter | null = null

  const connectX = async (): Promise<PublishConnectionsInfo> => {
    const clientId = (await deps.connections.x()).clientId
    if (!clientId) throw new UserFacingError(publishText('publish.errors.xClientIdMissing'))
    pendingAuth?.cancel()
    const pkce = makePkce()
    const redirectUri = xCallbackUrl()
    const waiter = deps.waitForCallback({
      host: X_OAUTH.host, port: X_OAUTH.port, path: X_OAUTH.path, state: pkce.state, timeoutMs: X_OAUTH.waitMs,
      doneMessage: publishText('publish.x.authDonePage'), failedMessage: publishText('publish.x.authFailedPage')
    })
    pendingAuth = waiter
    try {
      await waiter.ready
      await deps.openExternal(authorizeUrl({ clientId, redirectUri, state: pkce.state, challenge: pkce.challenge }))
      const code = await waiter.code
      const tokens = await exchangeCode(deps.fetcher, { clientId, code, verifier: pkce.verifier, redirectUri })
      const user = await fetchMe(deps.fetcher, tokens.accessToken)
      // 認証のあいだに Client ID が変わっていたら、そのトークンは使わない
      if (!(await deps.connections.setXTokens(clientId, tokens, user))) throw new UserFacingError(publishText('publish.errors.xClientIdChanged'))
    } finally {
      if (pendingAuth === waiter) pendingAuth = null
      waiter.cancel()
    }
    return changed(await deps.connections.info())
  }

  /** 投稿に使える X のトークン（切れかけなら更新して保存する） */
  const xAccess = async (): Promise<{ accessToken: string; username: string }> => {
    const x = await deps.connections.x()
    if (!x.clientId || !x.tokens || !x.user) throw new UserFacingError(publishText('publish.errors.xNotConnected'))
    try {
      const { tokens, refreshed } = await freshTokens(deps.fetcher, x.clientId, x.tokens)
      if (refreshed) await deps.connections.setXTokens(x.clientId, tokens, x.user)
      return { accessToken: tokens.accessToken, username: x.user.username }
    } catch (err) {
      if (err instanceof XAuthError) await deps.connections.clearXTokens()
      throw err
    }
  }

  return {
    'publish:list': async () => {
      const id = project()
      return deps.store.snapshot(id, deps.thumbnail, deps.background.isRunning(id))
    },
    'publish:generate': async (request) => {
      const id = project()
      return deps.background.runNow(id, readGenerateRequest(request))
    },
    'publish:create': async (text) => {
      const [draft] = await deps.store.add(project(), [{ source: 'manual', title: '', text: str(text, PUBLISH_LIMITS.textChars) ?? '' }])
      if (!draft) throw new UserFacingError(t('publish.errors.draftNotFound'))
      return changed(draft.id)
    },
    'publish:update': async (id, patch) => {
      await deps.store.update(project(), draftId(id), readDraftPatch(patch))
      changed(undefined)
    },
    'publish:remove': async (id) => {
      await deps.store.remove(project(), draftId(id))
      changed(undefined)
    },
    'publish:pickMedia': async (id) => {
      const projectId = project()
      const target = draftId(id)
      const picked = await deps.pickFiles()
      const dir = deps.projectDir()
      const files: Array<{ path: string; bytes: number; ref?: string }> = []
      for (const path of picked.slice(0, PUBLISH_LIMITS.xImages)) {
        if (!isAbsolute(path)) continue
        if (!mediaKindOf(path)) throw new UserFacingError(t('publish.errors.mediaUnsupported', { name: path.split(/[\\/]/).pop() ?? path }))
        const info = await lstat(path).catch(() => null)
        if (!info?.isFile()) continue
        // プロジェクトの中のファイルなら、記事の本文から相対パスで指せるようにする
        const inside = dir ? await projectFile(dir, relative(dir, path)).catch(() => null) : null
        files.push({ path, bytes: info.size, ...(inside ? { ref: inside.ref } : {}) })
      }
      if (!files.length) return 0
      await deps.store.addMedia(projectId, target, files)
      return changed(files.length)
    },
    'publish:addProjectMedia': async (id, relPaths) => {
      const projectId = project()
      const target = draftId(id)
      const dir = deps.projectDir()
      if (!dir) throw new UserFacingError(t('errors.openProjectFolder'))
      const list = Array.isArray(relPaths) ? relPaths.filter((p): p is string => typeof p === 'string').slice(0, PUBLISH_LIMITS.xImages) : []
      const files: Array<{ path: string; bytes: number; ref: string }> = []
      for (const rel of list) {
        const file = await projectFile(dir, rel)
        if (!file) throw new UserFacingError(t('publish.errors.mediaOutside'))
        files.push(file)
      }
      if (!files.length) return 0
      await deps.store.addMedia(projectId, target, files)
      return changed(files.length)
    },
    'publish:setBackground': async (enabled) => {
      await deps.store.setBackground(project(), { enabled: enabled === true })
      changed(undefined)
    },
    'publish:connections': () => deps.connections.info(),
    'publish:setXClientId': async (clientId) => {
      const value = typeof clientId === 'string' ? clientId.trim() : ''
      await deps.connections.setXClientId(value || null)
      return changed(await deps.connections.info())
    },
    'publish:connectX': () => connectX(),
    'publish:cancelConnectX': () => {
      pendingAuth?.cancel()
      pendingAuth = null
    },
    'publish:disconnectX': async () => {
      const x = await deps.connections.x()
      if (x.clientId && x.tokens) await revokeToken(deps.fetcher, { clientId: x.clientId, token: x.tokens.refreshToken ?? x.tokens.accessToken })
      await deps.connections.clearXTokens()
      return changed(await deps.connections.info())
    },
    'publish:addBlog': async (raw) => {
      const input = readBlogInput(raw)
      // 登録の前に、その接続先で使えるかを確かめる
      await testBlog({ fetcher: deps.fetcher }, { id: '0'.repeat(16), ...input })
      await deps.connections.addBlog(input)
      return changed(await deps.connections.info())
    },
    'publish:removeBlog': async (id) => {
      if (typeof id === 'string') await deps.connections.removeBlog(id)
      return changed(await deps.connections.info())
    },
    'publish:postX': async (id): Promise<PostXResult> => {
      const projectId = project()
      const target = draftId(id)
      const draft = await deps.store.stored(projectId, target)
      const { parts } = splitForThread(draft.text)
      if (!parts.length) throw new UserFacingError(t('publish.empty'))
      const problem = xMediaProblem(draft.media)
      if (problem) throw new UserFacingError(publishText(`publish.mediaProblem.${problem}`))
      const { accessToken, username } = await xAccess()
      const client = new XClient({ fetcher: deps.fetcher, accessToken, ...(deps.readChunk ? { readChunk: deps.readChunk } : {}) })
      let result
      try {
        result = await postThread(client, parts, draft.media)
      } catch (err) {
        if (err instanceof XAuthError) await deps.connections.clearXTokens()
        throw err
      }
      const url = postUrl(username, result.ids[0])
      await deps.store.recordResult(projectId, target, { kind: 'x', targetName: `@${username}`, url })
      return changed({ url, posted: result.ids.length, parts: parts.length, ...(result.error ? { error: result.error } : {}) })
    },
    'publish:postBlog': async (id, blogId, asDraft): Promise<PostBlogResult> => {
      const projectId = project()
      const target = draftId(id)
      if (typeof blogId !== 'string') throw new UserFacingError(publishText('publish.errors.blogNotFound'))
      const blog = await deps.connections.blog(blogId)
      const draft = await deps.store.stored(projectId, target)
      const result = await postToBlog({ fetcher: deps.fetcher, ...(deps.readFile ? { readFile: deps.readFile } : {}) }, blog, {
        title: draft.article.title.trim() || draft.title,
        markdown: draft.article.body.trim() || draft.text,
        media: draft.media,
        draft: asDraft === true
      })
      await deps.store.recordResult(projectId, target, { kind: blog.kind, targetId: blog.id, targetName: blog.name, ...(result.url ? { url: result.url } : {}), ...(result.draft ? { draft: true } : {}) })
      return changed(result)
    }
  }
}
