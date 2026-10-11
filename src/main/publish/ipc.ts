/**
 * 発信（X への投稿の下書き）の IPC ハンドラ。index.ts の registerIpc の dispatcher に混ぜて登録する
 * （アプリの窓の本体のフレームからだけ受ける。security-5 [1]）。
 *
 * - 下書きは store.ts（1つだけ作って共有する）、AI の生成は background.ts を必ず通す（同時に1つだけ）
 * - メディアの実パスは main だけが持つ。画面へは見本（サムネイル）と名前だけを返す
 * - X への投稿は内蔵ブラウザの新しいタブで X の投稿画面を開き、本文とメディアを入れる（xComposer.ts）。
 *   入れられなければ本文だけの投稿画面（intent）を同じタブで開く。「ポスト」は利用者が押す
 */
import { lstat, realpath } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import type { IpcRequests } from '@shared/ipc'
import { PUBLISH_LIMITS, mediaKindOf, type PostDraftPatch, type PublishGenerateRequest, type XComposeResult } from '@shared/publish'
import { X_MAX_PARTS } from '@shared/xPost'
import { t } from '@shared/i18n'
import { UserFacingError } from '@shared/errors'
import type { PublishBackground } from './background'
import type { PublishStore, ThumbnailMaker } from './store'
import type { ComposerContents } from './xComposer'

type Channel = 'publish:list' | 'publish:generate' | 'publish:create' | 'publish:update' | 'publish:remove' | 'publish:pickMedia'
  | 'publish:addProjectMedia' | 'publish:setBackground' | 'publish:composeX'

export interface PublishIpcDeps {
  projectId: () => string | null
  projectDir: () => string | null
  store: PublishStore
  background: PublishBackground
  thumbnail: ThumbnailMaker
  /** 画像・動画を選ばせる（絶対パス。選ばなければ空） */
  pickFiles: () => Promise<string[]>
  /** 内蔵ブラウザに空のタブを開いて前に出し、その中身を返す */
  openComposerTab: () => Promise<ComposerContents | null>
  fillComposer: (contents: ComposerContents, input: { parts: string[]; mediaPaths: string[] }) => Promise<XComposeResult>
  fallbackUrl: (parts: readonly string[]) => string
  notifyChanged: () => void
}

const str = (v: unknown, max: number): string | undefined => (typeof v === 'string' ? v.slice(0, max) : undefined)

/** 画面から来た生成の指示を確かめる */
export function readGenerateRequest(raw: unknown): PublishGenerateRequest {
  const r = (raw ?? {}) as Record<string, unknown>
  const text = str(r.text, PUBLISH_LIMITS.sourceTextChars)?.trim()
  const textLabel = str(r.textLabel, 200)?.trim()
  const hint = str(r.hint, PUBLISH_LIMITS.hintChars)?.trim()
  return { ...(text ? { text } : {}), ...(text && textLabel ? { textLabel } : {}), ...(hint ? { hint } : {}) }
}

/** 画面から来た下書きの変更を確かめる（長さ・状態の移り方は store が確かめる） */
export function readDraftPatch(raw: unknown): PostDraftPatch {
  const r = (raw ?? {}) as Record<string, unknown>
  const patch: PostDraftPatch = {}
  if (typeof r.title === 'string') patch.title = r.title
  if (typeof r.text === 'string') patch.text = r.text
  if (r.status === 'new' || r.status === 'posted' || r.status === 'dismissed') patch.status = r.status
  if (Array.isArray(r.mediaOrder)) patch.mediaOrder = r.mediaOrder.filter((id): id is string => typeof id === 'string').slice(0, 20)
  return patch
}

/** 投稿に入れる本文（画面がスレッドに分けたもの）を確かめる */
export function readParts(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  return raw.filter((p): p is string => typeof p === 'string' && p.trim().length > 0).slice(0, X_MAX_PARTS).map((p) => p.slice(0, 2000))
}

/** プロジェクトの中の普通のファイル（シンボリックリンクで外へ出ない）の実パス。外なら null */
export async function projectFile(projectDir: string, relPath: string): Promise<{ path: string; bytes: number } | null> {
  if (!relPath || isAbsolute(relPath) || relPath.split(/[\\/]/).includes('..')) return null
  try {
    const root = await realpath(projectDir)
    const real = await realpath(resolve(root, relPath))
    const rel = relative(root, real)
    if (!rel || rel.startsWith('..') || isAbsolute(rel) || rel.split(sep).includes('..')) return null
    const info = await lstat(real)
    return info.isFile() ? { path: real, bytes: info.size } : null
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
      const files: Array<{ path: string; bytes: number }> = []
      for (const path of picked.slice(0, PUBLISH_LIMITS.xImages)) {
        if (!isAbsolute(path)) continue
        if (!mediaKindOf(path)) throw new UserFacingError(t('publish.errors.mediaUnsupported', { name: path.split(/[\\/]/).pop() ?? path }))
        const info = await lstat(path).catch(() => null)
        if (info?.isFile()) files.push({ path, bytes: info.size })
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
      const files: Array<{ path: string; bytes: number }> = []
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
    'publish:composeX': async (id, rawParts) => {
      const projectId = project()
      const target = draftId(id)
      const parts = readParts(rawParts)
      if (!parts.length) throw new UserFacingError(t('publish.empty'))
      const mediaPaths = await deps.store.mediaPaths(projectId, target)
      const contents = await deps.openComposerTab()
      if (!contents) throw new UserFacingError(t('publish.errors.noBrowser'))
      const result = await deps.fillComposer(contents, { parts, mediaPaths })
      if (result.status === 'fallback' && !contents.isDestroyed()) await contents.loadURL(deps.fallbackUrl(parts)).catch(() => undefined)
      return result
    }
  }
}
