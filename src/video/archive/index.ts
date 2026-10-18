import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Timeline } from '@video/core';
import { VIDEO_PROJECT_FILE } from '@video/names';
import { videoHome } from '@video/toolchain';

// Archive of finished projects (docs/17_archive.md). The index is a JSON inverted index (no native sqlite):
// ASCII words + CJK character bigrams, so Japanese search works without a tokenizer.

export interface ArchiveEntry {
  id: string;
  projectId: string;
  title: string;
  kind: 'tech' | 'talk';
  template: { id: string; version: string };
  targets: string[];
  language: 'ja' | 'en';
  durationSec: number;
  createdAt: string;
  registeredAt: string;
  reason: 'export' | 'publish' | 'manual';
  projectDir: string;
  goal: string;
  audience: string;
  chapters: { title: string; points: string[]; startSec: number }[];
  tags: string[];
  thumbnail?: string;
  renders: { target: string; path: string }[];
  publish: { target: string; url?: string; status: string }[];
  versions: number;
}

export interface ArchiveStats {
  fps: number;
  durationFrames: number;
  durationSec: number;
  segments: number;
  avgSegmentSec: number;
  /** removed source time / (kept + removed) — 0..1 */
  cutRatio: number;
  removedByKind: Record<string, number>;
  jumpCuts: number;
  jumpCutsPerMin: number;
  zooms: number;
  zoomsPerMin: number;
  captions: number;
  captionsPerMin: number;
  /** captions with at least one emphasized word / captions */
  emphasisRatio: number;
  sfx: number;
  sfxPerMin: number;
  bgmTracks: number;
  /** mean (gainDb) of BGM relative to the voice loudness target, dB */
  bgmLevelDb: number | null;
  scenes: Record<string, number>;
  cameraSwitches: number;
  roles: Record<string, number>;
  chapters: number;
  layouts: Record<string, number>;
  needsReview: number;
}

export interface ArchiveIndex {
  schema: 1;
  entries: Record<string, ArchiveEntry>;
  /** term → { entry id → count } */
  terms: Record<string, Record<string, number>>;
}

export function archiveDir(): string {
  return join(videoHome(), 'archive');
}
function indexPath(): string {
  return join(archiveDir(), 'index.json');
}

export class ArchiveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ArchiveError';
  }
}

function writeAtomic(path: string, content: string): void {
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, content);
  renameSync(tmp, path);
}

export function readIndex(): ArchiveIndex {
  try {
    const raw = JSON.parse(readFileSync(indexPath(), 'utf8')) as ArchiveIndex;
    if (raw && raw.schema === 1 && raw.entries && raw.terms) return raw;
  } catch {
    /* missing or broken: rebuild below */
  }
  return rebuildIndex();
}

/** Rebuild index.json from the per-entry folders (used when the index is missing or corrupt). */
export function rebuildIndex(): ArchiveIndex {
  const idx: ArchiveIndex = { schema: 1, entries: {}, terms: {} };
  const dir = archiveDir();
  if (!existsSync(dir)) return idx;
  for (const id of readdirSync(dir)) {
    const f = join(dir, id, 'summary.json');
    if (!existsSync(f)) continue;
    try {
      const entry = JSON.parse(readFileSync(f, 'utf8')) as ArchiveEntry;
      const tl = readJson<Timeline>(join(dir, id, 'timeline.json'));
      addToIndex(idx, entry, tl);
    } catch {
      /* skip broken entry */
    }
  }
  mkdirSync(dir, { recursive: true });
  writeAtomic(indexPath(), JSON.stringify(idx));
  return idx;
}

function readJson<T>(p: string): T | null {
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as T;
  } catch {
    return null;
  }
}

// ---------- tokenization ----------

const CJK = /[぀-ヿ㐀-䶿一-鿿豈-﫿ｦ-ﾟ가-힯]/;

/** Lowercased ASCII/latin words (≥2 chars, or digits) + CJK character bigrams (unigram for a lone char). */
export function tokenize(text: string): string[] {
  const out: string[] = [];
  const norm = text.normalize('NFKC').toLowerCase();
  let latin = '';
  let cjk = '';
  const flushLatin = () => {
    if (latin.length >= 2 || /^\d+$/.test(latin)) out.push(latin);
    latin = '';
  };
  const flushCjk = () => {
    if (cjk.length === 1) out.push(cjk);
    for (let i = 0; i + 1 < cjk.length; i++) out.push(cjk.slice(i, i + 2));
    cjk = '';
  };
  for (const ch of norm) {
    if (CJK.test(ch)) {
      flushLatin();
      cjk += ch;
    } else if (/[\p{L}\p{N}]/u.test(ch)) {
      flushCjk();
      latin += ch;
    } else {
      flushLatin();
      flushCjk();
    }
  }
  flushLatin();
  flushCjk();
  return out;
}

function searchableText(entry: ArchiveEntry, t: Timeline | null): string {
  const parts = [entry.title, entry.goal, entry.audience, entry.template.id, entry.kind, ...entry.tags];
  for (const c of entry.chapters) parts.push(c.title, ...c.points);
  if (t) {
    for (const c of t.captions ?? []) parts.push(c.text);
    for (const o of t.outputs ?? []) parts.push(o.metadata.title, o.metadata.description, ...o.metadata.tags);
    if (t.transcript?.summary) parts.push(t.transcript.summary);
  }
  return parts.filter(Boolean).join('\n');
}

function removeFromIndex(idx: ArchiveIndex, id: string): void {
  delete idx.entries[id];
  for (const [term, posting] of Object.entries(idx.terms)) {
    if (posting[id] !== undefined) {
      delete posting[id];
      if (Object.keys(posting).length === 0) delete idx.terms[term];
    }
  }
}

function addToIndex(idx: ArchiveIndex, entry: ArchiveEntry, t: Timeline | null): void {
  removeFromIndex(idx, entry.id);
  idx.entries[entry.id] = entry;
  for (const term of tokenize(searchableText(entry, t))) {
    const posting = (idx.terms[term] ??= {});
    posting[entry.id] = (posting[entry.id] ?? 0) + 1;
  }
}

// ---------- stats ----------

const fpsOf = (t: Timeline) => t.canvas.fps.num / t.canvas.fps.den;

function takeFpsOf(t: Timeline, take: string): number {
  const ids = Object.keys(t.sources).sort();
  for (const kind of ['screen', 'camera'] as const) {
    for (const id of ids) {
      const s = t.sources[id]!;
      if (s.kind === kind && s.take === take) return s.fps.num / s.fps.den;
    }
  }
  return fpsOf(t);
}

const round = (n: number, d = 2) => Math.round(n * 10 ** d) / 10 ** d;

/** Pacing and style statistics of a timeline (docs/17 「統計」). */
export function computeStats(t: Timeline): ArchiveStats {
  const fps = fpsOf(t);
  const segs = t.segments;
  const durationFrames = segs.reduce((m, s) => Math.max(m, s.range.end), 0);
  const durationSec = durationFrames / fps;
  const minutes = durationSec / 60;
  const perMin = (n: number) => (minutes > 0 ? round(n / minutes) : 0);

  let keptSec = 0;
  let removedSec = 0;
  const removedByKind: Record<string, number> = {};
  let jumpCuts = 0;
  let zooms = 0;
  let cameraSwitches = 0;
  const roles: Record<string, number> = {};
  const layouts: Record<string, number> = {};
  let needsReview = 0;
  let prevCam: string | null = null;
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i]!;
    const tf = takeFpsOf(t, s.src.take);
    keptSec += (s.src.to - s.src.from) / tf;
    for (const r of s.removedNeighbors ?? []) {
      const sec = (r.src.to - r.src.from) / tf;
      removedSec += sec;
      removedByKind[r.kind] = round((removedByKind[r.kind] ?? 0) + sec);
    }
    const prev = segs[i - 1];
    // a jump cut: consecutive segments of the same take with a gap in the source
    if (prev && prev.src.take === s.src.take && s.src.from > prev.src.to) jumpCuts++;
    if (s.transitionIn?.kind === 'jump-zoom') zooms++;
    else if (s.zoom?.some((k) => k.value.scale > 1.001)) zooms++;
    roles[s.role] = (roles[s.role] ?? 0) + 1;
    layouts[s.video.layout] = (layouts[s.video.layout] ?? 0) + 1;
    const cam = s.video.layout === 'camera-full' ? s.video.camera : s.video.layout === 'screen-with-wipe' ? `${s.video.screen}+${s.video.camera}` : s.video.layout === 'screen-full' ? s.video.screen : s.video.layout === 'split-v' ? `${s.video.top}/${s.video.bottom}` : `scene:${s.video.scene}`;
    if (prevCam !== null && cam !== prevCam) cameraSwitches++;
    prevCam = cam;
    if (s.decided.needsReview) needsReview++;
  }
  const scenes: Record<string, number> = {};
  for (const sc of t.scenes) scenes[sc.pattern.id] = (scenes[sc.pattern.id] ?? 0) + 1;
  const captions = t.captions.length;
  const emphasized = t.captions.filter((c) => c.emphasis.length > 0).length;
  const bgm = t.audio.bgm;
  return {
    fps: round(fps, 3),
    durationFrames,
    durationSec: round(durationSec),
    segments: segs.length,
    avgSegmentSec: segs.length ? round(durationSec / segs.length) : 0,
    cutRatio: keptSec + removedSec > 0 ? round(removedSec / (keptSec + removedSec), 3) : 0,
    removedByKind,
    jumpCuts,
    jumpCutsPerMin: perMin(jumpCuts),
    zooms,
    zoomsPerMin: perMin(zooms),
    captions,
    captionsPerMin: perMin(captions),
    emphasisRatio: captions ? round(emphasized / captions, 3) : 0,
    sfx: t.audio.sfx.length,
    sfxPerMin: perMin(t.audio.sfx.length),
    bgmTracks: bgm.length,
    bgmLevelDb: bgm.length ? round(bgm.reduce((a, b) => a + b.gainDb, 0) / bgm.length, 1) : null,
    scenes,
    cameraSwitches,
    roles,
    chapters: t.outline.length,
    layouts,
    needsReview,
  };
}

// ---------- register / list / search / get ----------

function slug(s: string): string {
  const ascii = s.normalize('NFKD').replace(/[^\x00-\x7f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return ascii.slice(0, 40).replace(/-+$/, '');
}

interface ProjectFile { id?: string; title?: string; created?: string; template?: { id: string; version: string }; language?: 'ja' | 'en' }

/** Register (or update) a project in ~/.ferret/video/archive. Re-registering the same project keeps its id and versions. */
export async function registerProject(projectDir: string, o: { reason: 'export' | 'publish' | 'manual'; now?: Date }): Promise<ArchiveEntry> {
  const proj = readJson<ProjectFile>(join(projectDir, VIDEO_PROJECT_FILE));
  if (!proj) throw new ArchiveError(`not a ferret-video project (ferret-video.json missing): ${projectDir}`);
  const t = readJson<Timeline>(join(projectDir, 'timeline.json'));
  if (!t || t.schema !== 1) throw new ArchiveError(`timeline.json missing or invalid: ${projectDir}`);
  const now = o.now ?? new Date();
  const idx = readIndex();
  const projectId = proj.id ?? `prj_${slug(projectDir)}`;
  const existing = Object.values(idx.entries).find((e) => e.projectId === projectId);
  const id = existing?.id ?? uniqueId(idx, `arc_${now.toISOString().slice(0, 10)}_${slug(t.meta.title) || projectId.replace(/^prj_/, '')}`);
  const dir = join(archiveDir(), id);
  mkdirSync(join(dir, 'versions'), { recursive: true });
  let versions = existing?.versions ?? 0;
  if (existing && existsSync(join(dir, 'timeline.json'))) {
    copyFileSync(join(dir, 'timeline.json'), join(dir, 'versions', `${versions}.json`));
  }
  versions++;
  const fps = fpsOf(t);
  const stats = computeStats(t);
  let thumbnail: string | undefined;
  const thumbSrc = [...t.outputs.map((x) => x.thumbnail?.path).filter((p): p is string => !!p), 'renders/thumbnail.jpg', 'renders/thumbnail.png']
    .map((p) => join(projectDir, p))
    .find((p) => existsSync(p));
  if (thumbSrc) {
    thumbnail = `thumbnail${thumbSrc.slice(thumbSrc.lastIndexOf('.'))}`;
    copyFileSync(thumbSrc, join(dir, thumbnail));
  }
  const entry: ArchiveEntry = {
    id,
    projectId,
    title: t.meta.title,
    kind: t.meta.kind,
    template: t.meta.template,
    targets: [...t.meta.targets],
    language: t.meta.language,
    durationSec: stats.durationSec,
    createdAt: proj.created ?? existing?.createdAt ?? now.toISOString(),
    registeredAt: now.toISOString(),
    reason: o.reason,
    projectDir,
    goal: t.meta.goal,
    audience: t.meta.audience,
    chapters: t.outline.map((c) => ({ title: c.title, points: c.points, startSec: round(c.start / fps) })),
    tags: [...new Set(t.outputs.flatMap((x) => x.metadata.tags))],
    ...(thumbnail ? { thumbnail } : {}),
    renders: t.outputs.filter((x) => x.render).map((x) => ({ target: x.target, path: x.render!.path })),
    publish: t.outputs.filter((x) => x.publish).map((x) => ({ target: x.target, status: x.publish!.status, ...(x.publish!.url ? { url: x.publish!.url } : {}) })),
    versions,
  };
  writeFileSync(join(dir, 'timeline.json'), JSON.stringify(t, null, 2));
  writeFileSync(join(dir, 'summary.json'), JSON.stringify(entry, null, 2));
  writeFileSync(join(dir, 'stats.json'), JSON.stringify(stats, null, 2));
  addToIndex(idx, entry, t);
  writeAtomic(indexPath(), JSON.stringify(idx));
  return entry;
}

function uniqueId(idx: ArchiveIndex, base: string): string {
  if (!idx.entries[base] && !existsSync(join(archiveDir(), base))) return base;
  for (let n = 2; ; n++) {
    const id = `${base}-${n}`;
    if (!idx.entries[id] && !existsSync(join(archiveDir(), id))) return id;
  }
}

/** Newest first, filtered by kind / template. */
export function listArchive(o: { kind?: string; template?: string; target?: string; limit?: number } = {}): ArchiveEntry[] {
  let list = Object.values(readIndex().entries);
  if (o.kind) list = list.filter((e) => e.kind === o.kind);
  if (o.template) list = list.filter((e) => e.template.id === o.template);
  if (o.target) list = list.filter((e) => e.targets.includes(o.target!));
  list.sort((a, b) => b.registeredAt.localeCompare(a.registeredAt) || b.id.localeCompare(a.id));
  return o.limit !== undefined ? list.slice(0, Math.max(0, o.limit)) : list;
}

/** Full-text search: every query term must match (AND); ranked by term frequency, then recency. */
export function searchArchive(q: string, o: { limit?: number } = {}): ArchiveEntry[] {
  const idx = readIndex();
  const terms = [...new Set(tokenize(q))];
  if (!terms.length) return [];
  let scores: Map<string, number> | null = null;
  for (const term of terms) {
    const posting = idx.terms[term] ?? {};
    const next = new Map<string, number>();
    for (const [id, n] of Object.entries(posting)) {
      if (scores === null || scores.has(id)) next.set(id, (scores?.get(id) ?? 0) + n);
    }
    scores = next;
    if (!scores.size) return [];
  }
  const out = [...scores!.entries()]
    .map(([id, score]) => ({ e: idx.entries[id]!, score }))
    .filter((x) => x.e)
    .sort((a, b) => b.score - a.score || b.e.registeredAt.localeCompare(a.e.registeredAt))
    .map((x) => x.e);
  return o.limit !== undefined ? out.slice(0, o.limit) : out;
}

export function getArchive(id: string): { entry: ArchiveEntry; timeline: Timeline; stats: ArchiveStats } {
  if (!/^arc_[A-Za-z0-9_.-]+$/.test(id)) throw new ArchiveError(`invalid archive id: ${id}`);
  const dir = join(archiveDir(), id);
  const entry = readJson<ArchiveEntry>(join(dir, 'summary.json'));
  const timeline = readJson<Timeline>(join(dir, 'timeline.json'));
  if (!entry || !timeline) throw new ArchiveError(`archive entry not found: ${id}`);
  const stats = readJson<ArchiveStats>(join(dir, 'stats.json')) ?? computeStats(timeline);
  return { entry, timeline, stats };
}

/** Differences between two stat sets (for `past compare`). */
export function compareStats(a: ArchiveStats, b: ArchiveStats): { key: string; a: number; b: number; diff: number }[] {
  const keys: (keyof ArchiveStats)[] = ['durationSec', 'segments', 'avgSegmentSec', 'cutRatio', 'jumpCutsPerMin', 'zoomsPerMin', 'captionsPerMin', 'emphasisRatio', 'sfxPerMin', 'cameraSwitches', 'chapters'];
  return keys.map((k) => ({ key: k, a: a[k] as number, b: b[k] as number, diff: round((b[k] as number) - (a[k] as number), 3) }));
}
