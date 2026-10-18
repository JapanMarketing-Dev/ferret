import { existsSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { frameToSeconds, type LicenseRef, type Output, type Target, type Timeline } from '@video/core';
import { CliError, emit, opts, t, type Ctx } from '../ctx.js';
import { openProject, readTimeline, setStep, writeAtomic, type Project } from '../project.js';
import {
  PUBLISH_FILE, cleanTags, composeDescription, defaultPublish, fillPrivacy, mergePublish, privacyDefaults, projectFileExists, publishStatus, readPublish, safeRelPath,
  validatePublish, type PublishJson,
} from '../publishJson.js';

// The post (SPEC 「publish.json」, docs/14): the agent writes title / description / tags (and YouTube / TikTok options) to
// <project>/publish.json; the CLI adds the chapter list and asset credits to the description and checks the limits.
// The human approves it in the app's Publish screen, which uploads that one video.

export const TARGETS = ['youtube', 'youtube-shorts', 'tiktok', 'instagram-reels'] as const;
const VERTICAL = new Set<Target>(['youtube-shorts', 'tiktok', 'instagram-reels']);

/** YouTube chapters "00:00 Title" from the outline; null with the reason when YouTube would reject them. */
export function youtubeChapters(tl: Timeline): { text: string | null; reason?: string } {
  const ch = [...tl.outline].sort((a, b) => a.start - b.start);
  if (ch.length < 3) return { text: null, reason: 'YouTube needs at least 3 chapters' };
  if (ch[0]!.start !== 0) return { text: null, reason: 'the first chapter must start at 00:00' };
  const fps = tl.canvas.fps;
  const end = tl.segments.reduce((m, s) => Math.max(m, s.range.end), 0);
  for (let i = 0; i < ch.length; i++) {
    const next = ch[i + 1]?.start ?? end;
    if (frameToSeconds(next - ch[i]!.start, fps) < 10) return { text: null, reason: `chapter "${ch[i]!.title}" is shorter than 10 seconds` };
  }
  const clock = (f: number) => {
    const s = Math.floor(frameToSeconds(f, fps));
    const h = Math.floor(s / 3600);
    const mm = String(Math.floor((s % 3600) / 60)).padStart(h ? 2 : 2, '0');
    const ss = String(s % 60).padStart(2, '0');
    return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
  };
  return { text: ch.map((c) => `${clock(c.start)} ${c.title}`).join('\n') };
}

/** Asset sources actually used by the timeline. */
export function usedAssets(tl: Timeline): { id: string; path: string; license: LicenseRef }[] {
  const ids = new Set<string>();
  for (const b of tl.audio.bgm) ids.add(b.asset);
  for (const s of tl.audio.sfx) ids.add(s.asset);
  for (const o of tl.overlays) if (o.kind === 'image' || o.kind === 'logo') ids.add(o.asset);
  for (const sc of tl.scenes) for (const v of Object.values(sc.slots)) if (v.kind === 'image') ids.add(v.asset);
  const out: { id: string; path: string; license: LicenseRef }[] = [];
  for (const id of [...ids].sort()) {
    const s = tl.sources[id];
    if (s?.kind === 'asset') out.push({ id, path: s.path, license: s.license });
  }
  return out;
}

/** Credit lines (unique, in first-use order) for assets whose license requires attribution. */
export function creditLines(tl: Timeline): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const a of usedAssets(tl)) {
    const line = a.license.credit?.trim();
    if (line && !seen.has(line)) {
      seen.add(line);
      out.push(line);
    }
  }
  return out;
}

export function emptyOutput(tl: Timeline, target: Target): Output {
  const vertical = VERTICAL.has(target);
  const canvas = vertical === tl.canvas.height > tl.canvas.width ? tl.canvas : { ...tl.canvas, width: vertical ? 1080 : 1920, height: vertical ? 1920 : 1080 };
  return { target, canvas, preset: target, metadata: { title: tl.meta.title, titleCandidates: [], description: '', tags: [], chapters: !vertical } };
}

interface MetaInput { title?: string; description?: string; tags?: string[]; chapters?: boolean }

function readJsonArg(ctx: Ctx, path: string): Record<string, unknown> {
  const abs = resolve(ctx.io.cwd, path);
  if (!existsSync(abs)) throw new CliError('not-found', t(ctx, `ファイルがありません: ${path}`, `file not found: ${path}`));
  let v: unknown;
  try {
    v = JSON.parse(readFileSync(abs, 'utf8').replace(/^\uFEFF/, ''));
  } catch (e) {
    throw new CliError('invalid-json', `${path}: ${(e as Error).message}`);
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new CliError('usage', t(ctx, `${path} は { … } の JSON にしてください`, `${path} must be a JSON object`));
  return v as Record<string, unknown>;
}

/**
 * A --file argument as a publish.json patch. Accepts publish.json itself, or the older per-target shape
 * ({ "youtube": { "title": … } }), whose youtube entry becomes the post text.
 */
export function patchFromFile(raw: Record<string, unknown>): Record<string, unknown> {
  const yt = raw.youtube as Record<string, unknown> | undefined;
  if (yt && typeof yt === 'object' && ('title' in yt || 'description' in yt || 'tags' in yt) && !('title' in raw)) {
    const { title, description, tags, titleCandidates: _c, chapters, ...rest } = yt as MetaInput & Record<string, unknown>;
    return { ...(title !== undefined ? { title } : {}), ...(description !== undefined ? { description } : {}), ...(tags !== undefined ? { tags } : {}),
      youtube: { ...rest, ...(chapters !== undefined ? { chapters } : {}) } };
  }
  const { titleCandidates: _c, chapters, ...rest } = raw as Record<string, unknown> & { chapters?: unknown };
  return chapters !== undefined ? { ...rest, youtube: { ...((rest.youtube as object | undefined) ?? {}), chapters } } : rest;
}

/** Done when publish.json is valid (title, description, tags, video…); running with the reason otherwise. */
export function updateMetadataStep(p: Project): { valid: boolean; problems: string[] } {
  const st = publishStatus(p.dir, p.file.language);
  setStep(p, 'metadata', st.valid ? 'done' : 'running', st.valid ? undefined : st.problems.slice(0, 3).join(' / '));
  return st;
}

function chaptersOf(tl: Timeline, on: boolean): string | null {
  return on ? youtubeChapters(tl).text : null;
}

function writePublish(p: Project, v: PublishJson): void {
  writeAtomic(join(p.dir, PUBLISH_FILE), JSON.stringify(v, null, 2) + '\n');
}

/** publish.json as it is now, or a fresh one (title from the timeline). A broken file is an error, not overwritten. */
function currentPublish(ctx: Ctx, p: Project, tl: Timeline): PublishJson {
  const r = readPublish(p.dir);
  if (!r) return defaultPublish(tl.meta.title, privacyDefaults());
  if (r.error || !r.raw || typeof r.raw !== 'object' || Array.isArray(r.raw)) {
    throw new CliError('invalid-publish', t(ctx, `publish.json が壊れています（${r.error ?? '{ … } ではありません'}）。直すか消してください`, `publish.json is broken (${r.error ?? 'not an object'}); fix or delete it`));
  }
  return r.raw as PublishJson;
}

function view(ctx: Ctx, p: Project, v: unknown) {
  const res = validatePublish(v, { exists: (rel) => projectFileExists(p.dir, rel), lang: ctx.lang });
  return { valid: res.valid, thumbnailReady: res.thumbnail, problems: res.problems };
}

export async function cmdMeta(ctx: Ctx, args: string[]): Promise<void> {
  const [sub, ...rest] = args;
  const p = openProject(ctx);
  if (sub === 'set') {
    const { values } = opts(rest, {
      title: { type: 'string' }, description: { type: 'string' }, 'description-file': { type: 'string' }, tags: { type: 'string' },
      chapters: { type: 'boolean' }, 'no-chapters': { type: 'boolean' }, file: { type: 'string' }, video: { type: 'string' }, thumbnail: { type: 'string' },
      privacy: { type: 'string' }, category: { type: 'string' }, 'publish-at': { type: 'string' },
      tiktok: { type: 'boolean' }, 'no-tiktok': { type: 'boolean' }, 'tiktok-caption': { type: 'string' }, 'tiktok-privacy': { type: 'string' },
      target: { type: 'string', multiple: true }, candidates: { type: 'string', multiple: true },
    }, { max: 0, usage: 'ferret-video meta set --title … [--description …|--description-file f] [--tags a,b] [--privacy private|unlisted|public] [--tiktok] [--thumbnail img] | --file publish.json' });
    if (values.chapters && values['no-chapters']) throw new CliError('usage', 'choose --chapters or --no-chapters');
    if (values.tiktok && values['no-tiktok']) throw new CliError('usage', 'choose --tiktok or --no-tiktok');
    if (values.target?.some((x) => x !== 'youtube' && x !== 'tiktok')) throw new CliError('usage', t(ctx, '動画は1本です。--target は使いません（TikTok には --tiktok で同じ動画を出します）', 'there is one video; --target is not used (post the same video to TikTok with --tiktok)'));
    const tl = readTimeline({ ...p, variant: null });
    let patch: Record<string, unknown> = values.file ? patchFromFile(readJsonArg(ctx, values.file)) : {};
    const description = values['description-file'] ? readFileSync(resolve(ctx.io.cwd, values['description-file']), 'utf8') : values.description;
    const yt: Record<string, unknown> = {};
    if (values.privacy !== undefined) yt.privacy = values.privacy;
    if (values.category !== undefined) yt.categoryId = values.category;
    if (values['publish-at'] !== undefined) yt.publishAt = values['publish-at'];
    if (values.chapters) yt.chapters = true;
    if (values['no-chapters']) yt.chapters = false;
    const tt: Record<string, unknown> = {};
    if (values.tiktok) tt.enabled = true;
    if (values['no-tiktok']) tt.enabled = false;
    if (values['tiktok-caption'] !== undefined) tt.caption = values['tiktok-caption'];
    if (values['tiktok-privacy'] !== undefined) tt.privacy = values['tiktok-privacy'];
    const relIn = (v: string) => {
      const abs = resolve(ctx.io.cwd, v);
      const rel = relative(p.dir, abs).split('\\').join('/');
      return safeRelPath(rel) ?? v;
    };
    patch = {
      ...patch,
      ...(values.title !== undefined ? { title: values.title } : {}),
      ...(description !== undefined ? { description } : {}),
      ...(values.tags !== undefined ? { tags: cleanTags(values.tags) } : {}),
      ...(values.video !== undefined ? { video: relIn(values.video) } : {}),
      ...(values.thumbnail !== undefined ? { thumbnail: relIn(values.thumbnail) } : {}),
      ...(Object.keys(yt).length ? { youtube: { ...((patch.youtube as object | undefined) ?? {}), ...yt } } : {}),
      ...(Object.keys(tt).length ? { tiktok: { ...((patch.tiktok as object | undefined) ?? {}), ...tt } } : {}),
    };
    if (Array.isArray(patch.tags)) patch.tags = cleanTags(patch.tags);
    if (typeof patch.title === 'string') patch.title = patch.title.trim();
    // visibility the post does not set comes from settings (publish.youtube.privacy / publish.tiktok.privacy)
    let next = fillPrivacy(mergePublish(currentPublish(ctx, p, tl), patch), privacyDefaults());
    // the description as posted: chapters (YouTube) and credits are added by the CLI, once
    if (typeof next.description === 'string' && (description !== undefined || 'description' in patch || yt.chapters !== undefined)) {
      next = { ...next, description: composeDescription(next.description, chaptersOf(tl, next.youtube?.chapters !== false), creditLines(tl), p.file.language) };
    }
    const check = view(ctx, p, next);
    const hard = check.problems.filter((x) => x.level === 'error' && x.field !== 'title' && x.field !== 'description' && x.field !== 'tags' && x.field !== 'thumbnail');
    if (hard.length) throw new CliError('invalid-publish', t(ctx, `publish.json に書けません: ${hard.map((x) => x.message).join(' / ')}`, `cannot write publish.json: ${hard.map((x) => x.message).join(' / ')}`), { problems: hard });
    writePublish(p, next);
    updateMetadataStep(p);
    emit(ctx, { file: PUBLISH_FILE, publish: next, ...check }, () => [
      t(ctx, `publish.json を保存しました: ${next.title || '（タイトル未設定）'}`, `saved publish.json: ${next.title || '(no title)'}`),
      ...check.problems.map((x) => `${x.level === 'error' ? '!' : '-'} ${x.field}: ${x.message}`),
    ]);
    return;
  }
  if (sub === 'show' || sub === undefined) {
    opts(rest, { target: { type: 'string' } }, { max: 0 });
    const tl = readTimeline({ ...p, variant: null });
    const r = readPublish(p.dir);
    const pub = r && !r.error ? r.raw : null;
    const check = r ? (r.error ? { valid: false, thumbnailReady: false, problems: [{ level: 'error' as const, field: '$', message: r.error }] } : view(ctx, p, r.raw)) : null;
    emit(ctx, { exists: !!r, publish: pub, ...(check ?? { valid: false, thumbnailReady: false, problems: [] }), defaults: { privacy: privacyDefaults() }, chapters: youtubeChapters(tl), credits: creditLines(tl), assets: usedAssets(tl) }, () => {
      if (!r) return t(ctx, 'publish.json はまだありません（ferret-video meta set --title … で作る）', 'no publish.json yet (create it with ferret-video meta set --title …)');
      const x = pub as Partial<PublishJson> | null;
      return [
        `${x?.title || t(ctx, '（タイトル未設定）', '(no title)')}`,
        `video: ${x?.video ?? '-'}  thumbnail: ${x?.thumbnail ?? '-'}  tags: ${(x?.tags ?? []).join(', ')}`,
        ...check!.problems.map((q) => `${q.level === 'error' ? '!' : '-'} ${q.field}: ${q.message}`),
      ];
    });
    return;
  }
  if (sub === 'check') {
    opts(rest, {}, { max: 0 });
    const r = readPublish(p.dir);
    if (!r) throw new CliError('no-publish', t(ctx, 'publish.json がありません（ferret-video meta set --title … で作る）', 'no publish.json (create it with ferret-video meta set --title …)'));
    if (r.error) throw new CliError('invalid-publish', `publish.json: ${r.error}`);
    const check = view(ctx, p, r.raw);
    updateMetadataStep(p);
    if (!check.valid) {
      throw new CliError('invalid-publish', t(ctx, `publish.json に直すところがあります（${check.problems.filter((x) => x.level === 'error').length} 件）`, `publish.json needs fixes (${check.problems.filter((x) => x.level === 'error').length})`), { problems: check.problems });
    }
    emit(ctx, check, () => [t(ctx, 'publish.json は投稿できる形です', 'publish.json is ready to post'), ...check.problems.map((x) => `- ${x.field}: ${x.message}`)]);
    return;
  }
  throw new CliError('usage', 'usage: ferret-video meta show | set … | check');
}
