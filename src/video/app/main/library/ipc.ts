import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { basename, join } from 'node:path'
import type { VideoIpcHandlers, VideoMainContext } from '../context'
import type { VideoLibraryIpc } from '../../shared/ipc/library'
import {
  cliFailure, inVideoFolder, withUiLang, parseCliJson, parseNext, parseSteps, parseTemplates, videoFolderName,
  type VideoDetail, type VideoTemplateInfo
} from '../../shared/library'
import { getLocale } from '@shared/i18n'
import { LEGACY_STATE_DIR, VIDEO_PROJECT_FILE, VIDEO_STATE_DIR } from '@video/names'
import { channelRelative, isVideoChannel, latestRender, listVideos, readVideo, resolveVideoDir, uniqueChild } from './videos'

/** 新しい動画の既定のテンプレート（CLI の init と同じ） */
const DEFAULT_TEMPLATE = 'tech'

/** `ferret-video` を呼ぶ。画面に文を出すコマンドには画面の言語（--lang）を付ける */
export async function cli(argv: string[], cwd: string) {
  const { runVideoCli } = await import('../cli/run')
  return runVideoCli(withUiLang(argv, getLocale()), { cwd })
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return undefined
  }
}

/** 動画のプロジェクトの言語（ferret-video.json の language。無ければ ja） */
export function videoLanguage(dir: string): 'ja' | 'en' {
  const j = readJson(join(dir, VIDEO_PROJECT_FILE)) as { language?: unknown } | undefined
  return j?.language === 'en' ? 'en' : 'ja'
}

function root(ctx: VideoMainContext): string {
  const folder = ctx.folderPath()
  if (!folder) throw new Error('no project is open')
  return folder
}

/** 動画の一覧・新しい動画（担当: 動画タブ） */
export function libraryHandlers(ctx: VideoMainContext): VideoIpcHandlers<VideoLibraryIpc> {
  return {
    'video:isChannel': (folderPath) => typeof folderPath === 'string' && isVideoChannel(folderPath),

    'video:list': () => {
      const folder = ctx.folderPath()
      return folder ? listVideos(folder) : { root: '', exists: false, videos: [] }
    },

    'video:templates': async (): Promise<VideoTemplateInfo[]> => {
      const r = await cli(['templates', '--json'], ctx.folderPath() ?? process.cwd())
      const list = r.code === 0 ? parseTemplates(parseCliJson(r.stdout)) : []
      if (list.length) return list
      // CLI がまだ動かないときは内蔵のテンプレートを直に読む
      try {
        const { listTemplates } = await import('@video/templates')
        return parseTemplates(listTemplates().map((x) => ({ id: x.id, name: x.name, description: x.description, kind: x.kind })))
      } catch (err) {
        ctx.reportHandled(err, { area: 'video', op: 'list templates' })
        return []
      }
    },

    'video:create': async (input) => {
      const title = typeof input?.title === 'string' ? input.title.trim().slice(0, 200) : ''
      const template = typeof input?.template === 'string' && /^[a-z0-9][a-z0-9-]*$/.test(input.template) ? input.template : DEFAULT_TEMPLATE
      const parent = root(ctx)
      const dir = uniqueChild(parent, videoFolderName(title))
      mkdirSync(dir, { recursive: true })
      const name = basename(dir)
      const r = await cli(['init', '--template', template, '--title', title || name, '--json'], dir)
      if (r.code !== 0 || !existsSync(join(dir, VIDEO_PROJECT_FILE))) {
        // 作ったばかりで空のフォルダだけを片付ける（途中まで書けたものは残して調べられるようにする）
        try {
          if (readdirSync(dir).length === 0) rmSync(dir, { recursive: true, force: true })
        } catch {
          /* 片付けられなくても失敗を返す */
        }
        return { ok: false, error: cliFailure(r) }
      }
      ctx.send('video:changed')
      return { ok: true, name, dir }
    },

    'video:detail': async (name): Promise<VideoDetail> => {
      const parent = root(ctx)
      const dir = resolveVideoDir(parent, name)
      const entry = readVideo(dir, name)
      const rendered = latestRender(dir)
      const render = rendered ? channelRelative(parent, dir, rendered) : null
      if (entry.legacy) {
        return { entry, steps: parseSteps(readJson(join(dir, LEGACY_STATE_DIR, 'status.json'))), render, error: 'legacy' }
      }
      const r = await cli(['status', '--json'], dir)
      const json = r.code === 0 ? parseCliJson(r.stdout) : undefined
      if (json !== undefined) {
        const detail: VideoDetail = { entry, steps: parseSteps(json), render }
        const next = parseNext(json)
        if (next) detail.next = next
        return detail
      }
      // CLI が動かなくても、最後に書かれた手順の状態は出す
      return { entry, steps: parseSteps(readJson(join(dir, VIDEO_STATE_DIR, 'status.json'))), render, error: cliFailure(r) }
    },

    'video:finishPrompt': async (name) => {
      const dir = resolveVideoDir(root(ctx), name)
      const entry = readVideo(dir, name)
      const lang = videoLanguage(dir)
      const { loadSettings, renderPromptById } = await import('@video/settings')
      const { text } = renderPromptById('finish', { project: entry.title, template: entry.template ?? DEFAULT_TEMPLATE }, lang, loadSettings())
      return inVideoFolder(dir, text, lang)
    },

    'video:openFolder': async (name) => {
      const dir = resolveVideoDir(root(ctx), name)
      const { shell } = await import('electron')
      const err = await shell.openPath(dir)
      if (err) throw new Error(err)
    },

    'video:migrate': async (name) => {
      const dir = resolveVideoDir(root(ctx), name)
      const r = await cli(['migrate', '--json'], dir)
      if (r.code !== 0) return { ok: false, message: cliFailure(r) }
      ctx.send('video:changed')
      return { ok: true, message: '' }
    }
  }
}
