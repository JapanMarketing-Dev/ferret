import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { loadSettings } from '@video/settings';

// <project>/publish.json: the post the agent writes and the human approves in the app (SPEC 「Publish metadata file」).
// The app parses it with apps/desktop/src/shared/publish.ts; the CLI checks the same limits so `ferret-video next` can tell
// the agent what is missing. Pure functions + two small file readers.

export const PUBLISH_FILE = 'publish.json';
export const DEFAULT_VIDEO = 'renders/youtube/final.mp4';
export const YT_TITLE_MAX = 100; // code points
export const YT_DESCRIPTION_MAX_BYTES = 5000;
export const YT_TAGS_MAX = 500; // characters as YouTube counts them
export const TIKTOK_CAPTION_MAX = 2200;
export const YT_PRIVACY = ['private', 'unlisted', 'public'] as const;
export const TIKTOK_PRIVACY = ['SELF_ONLY', 'MUTUAL_FOLLOW_FRIENDS', 'FOLLOWER_OF_CREATOR', 'PUBLIC_TO_EVERYONE'] as const;
const IMAGE = /\.(png|jpe?g)$/i;
const VIDEO = /\.(mp4|mov|webm|m4v)$/i;

export interface PublishJson {
  video: string;
  thumbnail?: string;
  title: string;
  description: string;
  tags: string[];
  youtube?: { categoryId?: string; privacy?: (typeof YT_PRIVACY)[number]; publishAt?: string; madeForKids?: boolean; containsSyntheticMedia?: boolean; chapters?: boolean; [k: string]: unknown };
  tiktok?: { enabled?: boolean; caption?: string; privacy?: (typeof TIKTOK_PRIVACY)[number]; allowComment?: boolean; allowDuet?: boolean; allowStitch?: boolean; isAigc?: boolean; [k: string]: unknown };
  [k: string]: unknown;
}

export interface PublishProblem {
  /** error: the post cannot go out as written. warning: shown, not blocking. */
  level: 'error' | 'warning';
  field: string;
  message: string;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const codePoints = (s: string) => [...s].length;
const utf8Bytes = (s: string) => Buffer.byteLength(s, 'utf8');

/** Tag length as YouTube counts it: tags with spaces count their quotes, plus a comma between tags. */
export function tagsLength(tags: string[]): number {
  return tags.reduce((n, t, i) => n + codePoints(t) + (/\s/.test(t) ? 2 : 0) + (i > 0 ? 1 : 0), 0);
}

/** Tags from "a, b、#c" or a list: trimmed, no leading '#', no duplicates (case-insensitive), no empties. */
export function cleanTags(raw: string | unknown[]): string[] {
  const list = typeof raw === 'string' ? raw.split(/[,、\n]/) : raw;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const r of list) {
    if (typeof r !== 'string') continue;
    const t = r.trim().replace(/^#+/, '').trim();
    if (t && !seen.has(t.toLowerCase())) {
      seen.add(t.toLowerCase());
      out.push(t);
    }
  }
  return out;
}

/** A project-relative path that stays inside the project ('/' separated); null when absolute, empty or escaping. */
export function safeRelPath(p: string): string | null {
  const s = p.trim().replace(/\\/g, '/');
  if (!s || s.startsWith('/') || /^[a-zA-Z]:/.test(s) || s.includes('\0')) return null;
  const parts: string[] = [];
  for (const seg of s.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (!parts.length) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.length ? parts.join('/') : null;
}

export interface ValidateOptions {
  /** Whether a project-relative file exists (checks video and thumbnail when given). */
  exists?: (rel: string) => boolean;
  now?: Date;
  lang?: 'ja' | 'en';
}

/**
 * Check publish.json. `valid` (no errors outside `thumbnail`) is what the metadata step needs; `thumbnail` is true when
 * it names an existing PNG/JPEG (only known with `exists`). Never throws.
 */
export function validatePublish(raw: unknown, o: ValidateOptions = {}): { valid: boolean; thumbnail: boolean; problems: PublishProblem[] } {
  const ja = (o.lang ?? 'ja') === 'ja';
  const problems: PublishProblem[] = [];
  const err = (field: string, j: string, e: string) => problems.push({ level: 'error', field, message: ja ? j : e });
  const warn = (field: string, j: string, e: string) => problems.push({ level: 'warning', field, message: ja ? j : e });
  if (!isObj(raw)) {
    err('$', 'publish.json が { … } の形ではありません', 'publish.json is not a JSON object');
    return { valid: false, thumbnail: false, problems };
  }
  // video
  if (typeof raw.video !== 'string' || !safeRelPath(raw.video)) err('video', '動画のファイルをプロジェクトからの相対パスで書いてください', 'video must be a path relative to the project');
  else if (!VIDEO.test(raw.video)) err('video', '動画ファイル（.mp4 など）ではありません', 'video is not a video file (.mp4 …)');
  else if (o.exists && !o.exists(safeRelPath(raw.video)!)) warn('video', `動画がまだありません: ${raw.video}（ferret-video render --final）`, `video not rendered yet: ${raw.video} (ferret-video render --final)`);
  // thumbnail
  let thumbnail = false;
  if (raw.thumbnail !== undefined && raw.thumbnail !== null && raw.thumbnail !== '') {
    const rel = typeof raw.thumbnail === 'string' ? safeRelPath(raw.thumbnail) : null;
    if (!rel) err('thumbnail', 'サムネイルはプロジェクトの中の画像を相対パスで書いてください', 'thumbnail must be a path inside the project');
    else if (!IMAGE.test(rel)) err('thumbnail', 'サムネイルは PNG か JPEG にしてください', 'thumbnail must be a PNG or JPEG');
    else if (o.exists && !o.exists(rel)) err('thumbnail', `サムネイルの画像がありません: ${rel}`, `thumbnail image not found: ${rel}`);
    else thumbnail = !!o.exists;
  }
  // text
  const title = typeof raw.title === 'string' ? raw.title.trim() : '';
  if (raw.title !== undefined && typeof raw.title !== 'string') err('title', 'タイトルは文字列です', 'title must be a string');
  else if (!title) err('title', 'タイトルがありません', 'title is empty');
  else if (codePoints(title) > YT_TITLE_MAX) err('title', `タイトルが長すぎます（${codePoints(title)}/${YT_TITLE_MAX} 字）`, `title is too long (${codePoints(title)}/${YT_TITLE_MAX})`);
  if (/[<>]/.test(title)) err('title', 'タイトルに < と > は使えません', 'title may not contain < or >');
  if (typeof raw.description !== 'string') err('description', '説明文（description）を書いてください', 'description must be a string');
  else {
    // the metadata step is the agent writing the post: an empty description means it has not been written yet
    if (!raw.description.trim()) err('description', '説明文がありません', 'description is empty');
    if (utf8Bytes(raw.description) > YT_DESCRIPTION_MAX_BYTES) err('description', `説明文が長すぎます（${utf8Bytes(raw.description)}/${YT_DESCRIPTION_MAX_BYTES} バイト）`, `description is too long (${utf8Bytes(raw.description)}/${YT_DESCRIPTION_MAX_BYTES} bytes)`);
    if (/[<>]/.test(raw.description)) err('description', '説明文に < と > は使えません', 'description may not contain < or >');
  }
  if (!Array.isArray(raw.tags) || raw.tags.some((x) => typeof x !== 'string')) err('tags', 'タグは文字列のリストです', 'tags must be a list of strings');
  else {
    if (!raw.tags.length) warn('tags', 'タグがありません', 'no tags');
    if (tagsLength(raw.tags as string[]) > YT_TAGS_MAX) err('tags', `タグが長すぎます（${tagsLength(raw.tags as string[])}/${YT_TAGS_MAX}）`, `tags are too long (${tagsLength(raw.tags as string[])}/${YT_TAGS_MAX})`);
    if ((raw.tags as string[]).some((x) => /[<>]/.test(x))) err('tags', 'タグに < と > は使えません', 'tags may not contain < or >');
  }
  // youtube
  if (raw.youtube !== undefined) {
    if (!isObj(raw.youtube)) err('youtube', 'youtube は { … } です', 'youtube must be an object');
    else {
      const y = raw.youtube;
      if (y.privacy !== undefined && !(YT_PRIVACY as readonly unknown[]).includes(y.privacy)) err('youtube.privacy', `公開範囲は ${YT_PRIVACY.join(' / ')} のどれかです`, `privacy must be one of ${YT_PRIVACY.join(', ')}`);
      if (y.categoryId !== undefined && !(typeof y.categoryId === 'string' && /^\d{1,3}$/.test(y.categoryId))) err('youtube.categoryId', 'categoryId は数字の文字列です（例 "28"）', 'categoryId must be a numeric string (e.g. "28")');
      if (y.publishAt !== undefined && y.publishAt !== '') {
        const at = typeof y.publishAt === 'string' ? Date.parse(y.publishAt) : NaN;
        if (Number.isNaN(at)) err('youtube.publishAt', '予約日時は ISO 形式で書いてください', 'publishAt must be an ISO time');
        else if (at <= (o.now ?? new Date()).getTime()) err('youtube.publishAt', '予約日時が過ぎています', 'publishAt is in the past');
      }
      for (const k of ['madeForKids', 'containsSyntheticMedia', 'chapters'] as const) {
        if (y[k] !== undefined && typeof y[k] !== 'boolean') err(`youtube.${k}`, `${k} は true か false です`, `${k} must be true or false`);
      }
    }
  }
  // tiktok
  if (raw.tiktok !== undefined) {
    if (!isObj(raw.tiktok)) err('tiktok', 'tiktok は { … } です', 'tiktok must be an object');
    else {
      const tt = raw.tiktok;
      if (tt.privacy !== undefined && !(TIKTOK_PRIVACY as readonly unknown[]).includes(tt.privacy)) err('tiktok.privacy', `TikTok の公開範囲は ${TIKTOK_PRIVACY.join(' / ')} のどれかです`, `tiktok.privacy must be one of ${TIKTOK_PRIVACY.join(', ')}`);
      if (tt.caption !== undefined && typeof tt.caption !== 'string') err('tiktok.caption', 'caption は文字列です', 'caption must be a string');
      else if (typeof tt.caption === 'string' && tt.caption.length > TIKTOK_CAPTION_MAX) err('tiktok.caption', `TikTok の文が長すぎます（${tt.caption.length}/${TIKTOK_CAPTION_MAX}）`, `tiktok caption is too long (${tt.caption.length}/${TIKTOK_CAPTION_MAX})`);
      for (const k of ['enabled', 'allowComment', 'allowDuet', 'allowStitch', 'isAigc'] as const) {
        if (tt[k] !== undefined && typeof tt[k] !== 'boolean') err(`tiktok.${k}`, `${k} は true か false です`, `${k} must be true or false`);
      }
    }
  }
  // a bad thumbnail is the thumbnail step's problem; the post text can still be valid
  return { valid: !problems.some((p) => p.level === 'error' && p.field !== 'thumbnail'), thumbnail, problems };
}

/** A fresh publish.json for a project (title from the timeline, private, TikTok off; the description is still to write). */
export function defaultPublish(title: string, privacy: PrivacyDefaults = { youtube: 'private', tiktok: 'SELF_ONLY' }): PublishJson {
  return {
    video: DEFAULT_VIDEO,
    title,
    description: '',
    tags: [],
    youtube: { categoryId: '28', privacy: privacy.youtube, madeForKids: false, containsSyntheticMedia: false, chapters: true },
    tiktok: { enabled: false, caption: '', privacy: privacy.tiktok, allowComment: false, allowDuet: false, allowStitch: false, isAigc: false },
  };
}

export interface PrivacyDefaults { youtube: (typeof YT_PRIVACY)[number]; tiktok: (typeof TIKTOK_PRIVACY)[number] }

/** settings publish.youtube.privacy / publish.tiktok.privacy (defaults private / SELF_ONLY; bad values fall back). */
export function privacyDefaults(settings: { publish?: { youtube?: { privacy?: unknown }; tiktok?: { privacy?: unknown } } } = loadSettings()): PrivacyDefaults {
  const yt = settings.publish?.youtube?.privacy;
  const tt = settings.publish?.tiktok?.privacy;
  return {
    youtube: (YT_PRIVACY as readonly unknown[]).includes(yt) ? (yt as PrivacyDefaults['youtube']) : 'private',
    tiktok: (TIKTOK_PRIVACY as readonly unknown[]).includes(tt) ? (tt as PrivacyDefaults['tiktok']) : 'SELF_ONLY',
  };
}

/** Fill youtube.privacy / tiktok.privacy from the defaults where publish.json does not set them (never overrides). */
export function fillPrivacy(v: PublishJson, d: PrivacyDefaults): PublishJson {
  const yt: Record<string, unknown> = isObj(v.youtube) ? v.youtube : {};
  const tt: Record<string, unknown> = isObj(v.tiktok) ? v.tiktok : {};
  const unset = (x: unknown) => x === undefined || x === null || x === '';
  return {
    ...v,
    youtube: { ...yt, ...(unset(yt.privacy) ? { privacy: d.youtube } : {}) },
    tiktok: { ...tt, ...(unset(tt.privacy) ? { privacy: d.tiktok } : {}) },
  };
}

/** Merge a partial publish.json into a base: top-level keys replace, youtube / tiktok merge key by key. */
export function mergePublish(base: PublishJson, patch: Record<string, unknown>): PublishJson {
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    if ((k === 'youtube' || k === 'tiktok') && isObj(v)) out[k] = { ...(isObj(base[k]) ? base[k] : {}), ...v };
    else out[k] = v;
  }
  return out as PublishJson;
}

/**
 * The description as posted: the agent's text, then the chapter list, then the credits. Blocks already present are
 * not added again, so running it twice gives the same text.
 */
export function composeDescription(text: string, chapters: string | null, credits: string[], lang: 'ja' | 'en' = 'ja'): string {
  const parts = [text.trim()];
  const has = (block: string) => parts[0]!.includes(block.trim());
  if (chapters && !has(chapters)) parts.push(chapters.trim());
  if (credits.length) {
    const block = (lang === 'ja' ? 'クレジット:\n' : 'Credits:\n') + credits.join('\n');
    if (!credits.every((c) => has(c))) parts.push(block);
  }
  return parts.filter(Boolean).join('\n\n');
}

/** Read <project>/publish.json: null when missing; `error` when it is not JSON. */
export function readPublish(dir: string): { raw: unknown; error?: string } | null {
  const f = join(dir, PUBLISH_FILE);
  if (!existsSync(f)) return null;
  try {
    return { raw: JSON.parse(readFileSync(f, 'utf8').replace(/^﻿/, '')) as unknown };
  } catch (e) {
    return { raw: null, error: (e as Error).message };
  }
}

/** A project-relative file exists (and is a non-empty file). */
export function projectFileExists(dir: string, rel: string): boolean {
  try {
    const s = statSync(join(dir, rel));
    return s.isFile() && s.size > 0;
  } catch {
    return false;
  }
}

/** What `ferret-video next` needs: metadata valid, thumbnail present. */
export function publishStatus(dir: string, lang: 'ja' | 'en' = 'ja'): { valid: boolean; thumbnail: boolean; problems: string[] } {
  const r = readPublish(dir);
  if (!r) return { valid: false, thumbnail: false, problems: [lang === 'ja' ? 'publish.json がありません' : 'publish.json does not exist'] };
  if (r.error) return { valid: false, thumbnail: false, problems: [`publish.json: ${r.error}`] };
  const v = validatePublish(r.raw, { exists: (rel) => projectFileExists(dir, rel), lang });
  return { valid: v.valid, thumbnail: v.thumbnail, problems: v.problems.filter((p) => p.level === 'error' && p.field !== 'thumbnail').map((p) => `${p.field}: ${p.message}`) };
}
