/**
 * 投稿画面のデータ: publish.json（読み込みと問題）、それが指すファイル、受け渡しの頼みと結果、投稿の記録、thumbnails/ の画像。
 * サムネイル・公開範囲を選ぶと publish.json を書き換える（ほかの項目・知らない項目はそのまま残す）。
 */
import { readFileSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { UserFacingError } from '@shared/errors'
import { t } from '@shared/i18n'
import {
  BUILTIN_DEFAULTS,
  PUBLISH_FILE,
  PUBLISH_TARGETS,
  alreadyPublished,
  chaptersFromDescription,
  chaptersValid,
  parsePublishJson,
  safeRelPath,
  withPrivacy,
  withThumbnail,
  type PublishDefaults,
  type PublishTargetId,
  type VideoPublishState,
  type VideoThumbFile
} from '../../shared/publish'
import { LEGACY_PROJECT_FILE, VIDEO_PROJECT_FILE } from '@video/names'
import { containedFile, readLog, readRequest, readResult, readText, writeJsonAtomic } from './handoff'

export const THUMBS_DIR = 'thumbnails'

/**
 * 画面から来た動画のフォルダを確かめる。今開いているチャンネルの直下のフォルダ（絶対パスかフォルダ名）だけを受ける。
 * 返すのはチャンネルの実体の中の絶対パス
 */
export function resolveVideoDir(channel: string | null, videoDir: unknown): string {
  if (!channel || typeof videoDir !== 'string' || !videoDir.trim() || videoDir.includes('\0')) throw new UserFacingError(t('video.publish.errors.videoDir'))
  try {
    const root = realpathSync(channel)
    const abs = isAbsolute(videoDir) ? videoDir : join(channel, videoDir)
    const real = realpathSync(abs)
    if (dirname(real) !== root || basename(real).startsWith('.') || !statSync(real).isDirectory()) throw new Error('outside')
    return real
  } catch {
    throw new UserFacingError(t('video.publish.errors.videoDir'))
  }
}

/** 動画のフォルダの中のファイル → 今開いているチャンネルからの相対パス（ade-media://project/ で見せる） */
function mediaRel(channel: string, abs: string): string {
  try {
    return relative(realpathSync(channel), realpathSync(abs)).split(sep).join('/')
  } catch {
    return relative(channel, abs).split(sep).join('/')
  }
}

export function loadState(channel: string, dir: string, now = new Date(), defaults: PublishDefaults = BUILTIN_DEFAULTS): VideoPublishState {
  const text = readText(join(dir, PUBLISH_FILE))
  const { spec, issues } = text === null ? { spec: null, issues: [] } : parsePublishJson(text, now, defaults)
  const state: VideoPublishState = { exists: text !== null, spec, issues, request: readRequest(dir), result: readResult(dir), log: readLog(dir), published: {} }
  if (spec) {
    const video = containedFile(dir, spec.video)
    if (video) {
      const size = statSync(video).size
      state.videoMedia = mediaRel(channel, video)
      state.videoSize = size
      for (const target of PUBLISH_TARGETS) {
        const e = alreadyPublished(state.log, target, spec.video, size)
        if (e) state.published[target] = e
      }
    } else if (!issues.some((i) => i.field === 'video' && i.level === 'error')) issues.push({ level: 'error', field: 'video', code: 'missing', detail: spec.video })
    if (spec.thumbnail) {
      const thumb = containedFile(dir, spec.thumbnail)
      if (thumb) state.thumbnailMedia = mediaRel(channel, thumb)
      else issues.push({ level: 'warning', field: 'thumbnail', code: 'missing', detail: spec.thumbnail })
    }
    if (spec.youtube.enabled && spec.youtube.chapters && !chaptersValid(chaptersFromDescription(spec.description))) {
      issues.push({ level: 'warning', field: 'youtube.chapters', code: 'chapters' })
    }
  }
  return state
}

/** 動画のフォルダの中のファイルの相対パス（/ 区切り）。外は null */
export function videoRel(dir: string, path: string): string | null {
  const abs = isAbsolute(path) ? path : resolve(dir, path)
  return safeRelPath(relative(resolve(dir), abs))
}

function readOriginal(dir: string): { ok: true; value: unknown } | { ok: false; error: string } {
  const text = readText(join(dir, PUBLISH_FILE))
  if (text === null) return { ok: true, value: {} }
  try {
    return { ok: true, value: JSON.parse(text.replace(/^﻿/, '')) }
  } catch {
    return { ok: false, error: t('video.publish.errors.brokenJson') }
  }
}

/** publish.json の thumbnail を変える（null で外す）。publish.json が無ければ作る */
export function setThumbnail(dir: string, path: string | null): void {
  let rel: string | null = null
  if (path) {
    rel = videoRel(dir, path)
    if (!rel) throw new UserFacingError(t('video.publish.errors.thumbOutside'))
    if (!/\.(png|jpe?g)$/i.test(rel)) throw new UserFacingError(t('video.publish.errors.thumbNotImage'))
    if (!containedFile(dir, rel)) throw new UserFacingError(t('video.publish.errors.thumbMissing', { path: rel }))
  }
  const original = readOriginal(dir)
  if (!original.ok) throw new UserFacingError(original.error)
  writeJsonAtomic(join(dir, PUBLISH_FILE), withThumbnail(original.value, rel))
}

/** この動画の publish.json の youtube.privacy / tiktok.privacy を変える（ほかの項目は残す） */
export function setPrivacy(dir: string, target: unknown, value: unknown): void {
  if (!(PUBLISH_TARGETS as readonly unknown[]).includes(target)) throw new UserFacingError(t('video.publish.errors.privacy'))
  if (readText(join(dir, PUBLISH_FILE)) === null) throw new UserFacingError(t('video.publish.errors.noFile'))
  const original = readOriginal(dir)
  if (!original.ok) throw new UserFacingError(original.error)
  const next = typeof value === 'string' ? withPrivacy(original.value, target as PublishTargetId, value) : null
  if (!next) throw new UserFacingError(t('video.publish.errors.privacy'))
  writeJsonAtomic(join(dir, PUBLISH_FILE), next)
}

/** thumbnails/ の PNG / JPEG（1 階層下まで）。新しい順 */
export function listThumbnails(channel: string, dir: string, limit = 200): VideoThumbFile[] {
  const out: VideoThumbFile[] = []
  const walk = (rel: string, depth: number) => {
    let entries
    try {
      entries = readdirSync(join(dir, rel), { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue
      const r = `${rel}/${e.name}`
      if (e.isDirectory()) {
        if (depth < 1) walk(r, depth + 1)
      } else if (e.isFile() && /\.(png|jpe?g)$/i.test(e.name)) {
        try {
          out.push({ rel: r, media: mediaRel(channel, join(dir, r)), mtimeMs: statSync(join(dir, r)).mtimeMs })
        } catch {
          // 見ている間に消えた（想定内）
        }
      }
    }
  }
  walk(THUMBS_DIR, 0)
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs || a.rel.localeCompare(b.rel)).slice(0, limit)
}

/** ferret-video.json の title / template（無ければフォルダ名・空） */
export function videoProjectInfo(dir: string): { title: string; template: string } {
  for (const file of [VIDEO_PROJECT_FILE, LEGACY_PROJECT_FILE]) {
    try {
      const j = JSON.parse(readFileSync(join(dir, file), 'utf8')) as { title?: unknown; template?: unknown }
      return { title: typeof j.title === 'string' && j.title.trim() ? j.title.trim() : basename(dir), template: typeof j.template === 'string' ? j.template : '' }
    } catch {
      // 無い・壊れた: 次を見る（想定内）
    }
  }
  return { title: basename(dir), template: '' }
}
