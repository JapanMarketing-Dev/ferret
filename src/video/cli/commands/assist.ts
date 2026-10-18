import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { basename, dirname, extname, join, relative, resolve } from 'node:path';
import {
  applyTracks, benchmarkProfile, cameraMaterial, centerPerson, personCamera, suggestCameras, checkCameraSwitches, fpsValue, frameToTimecode, overlaysFromInputLogs,
  profileToTemplatePatch, sfxFromRules, type BenchmarkSample, type LicenseRef, type Mask, type Op, type SfxLibraryItem,
  type StyleProfile, type Timeline,
} from '@video/core';
import { loadTemplate } from '@video/templates';
import { videoHome } from '@video/toolchain';
import { loadAnalysis } from '../analysis.js';
import { piiMaskOps, type PiiFile } from '../pii.js';
import { CliError, emit, opts, progress, progressDone, t, type Ctx } from '../ctx.js';
import { DEFAULT_TEMPLATE } from './basic.js';
import { applyEdit, openProject, projectTemplate, readJsonFile, readTimeline, setStep, writeAtomic, writeTemplateOverride, type Project } from '../project.js';
import { media, readTranscript } from './media.js';

// CLI for the engine's round-5 helpers: template sfx rules, PII masks, multicam material, tracked zoom / input
// overlays and benchmark profiles. Each command computes ops with core and applies them as one undoable edit.

const by = (ctx: Ctx) => ({ by: ctx.by, ...(ctx.agent ? { agent: ctx.agent } : {}) });
const relp = (p: Project, f: string) => relative(p.dir, f).split('\\').join('/');

/** Apply ops (or only validate with --dry-run); returns whether anything changed. */
async function apply(ctx: Ctx, p: Project, ops: Op[], note: string, dryRun: boolean): Promise<{ changed: boolean; warnings: string[] }> {
  if (!ops.length) return { changed: false, warnings: [] };
  const r = await applyEdit(p, ops, { ...by(ctx), note, dryRun });
  return { changed: r.changed, warnings: r.issues.map((i) => `${i.level}: ${i.path}: ${i.message}`) };
}

// ---------- sfx apply ----------

const AUDIO_EXT = new Set(['.wav', '.mp3', '.ogg', '.m4a', '.flac', '.aac']);

interface Sidecar { id?: string; kind?: string; category?: string; features?: { durationMs?: number }; license?: { spdx?: string; url?: string }; author?: string; sourceUrl?: string; title?: string }

function walk(dir: string, depth = 3): string[] {
  if (!existsSync(dir) || depth < 0) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    if (name.startsWith('.')) continue;
    const f = join(dir, name);
    if (statSync(f).isDirectory()) out.push(...walk(f, depth - 1));
    else if (AUDIO_EXT.has(extname(name).toLowerCase())) out.push(f);
  }
  return out;
}

const safeId = (s: string) => s.normalize('NFKC').replace(/[^A-Za-z0-9_.-]+/g, '-').replace(/^[^A-Za-z0-9]+/, '').slice(0, 60) || 'x';

/** ~/.ferret/video/sfx/builtin: the synthesized, license-free set (@video/media ensureBuiltinSfx). */
export const builtinSfxDir = () => join(videoHome(), 'sfx', 'builtin');

/**
 * Sound effects the rules can pick from: sfx already in the timeline (asset sources whose id / assetId looks like
 * `sfx_<category>_…`), the project's assets/sfx/<category>/ files and the downloaded library cache
 * (~/.ferret/video/library/cache/sfx/<category>/), and the built-in set (~/.ferret/video/sfx/builtin/<category>/). A `<file>.json` sidecar (docs/16) gives id, category, duration and
 * license. Files outside the project are copied into assets/library/ when used.
 */
async function sfxLibrary(p: Project, tl: Timeline, warnings: string[]): Promise<{ items: SfxLibraryItem[]; copies: Map<string, string> }> {
  const items: SfxLibraryItem[] = [];
  const copies = new Map<string, string>();   // project-relative destination → absolute source
  const seen = new Set<string>();
  const m = await media();
  const durationMs = async (file: string): Promise<number | null> => {
    try {
      return Math.round((await m.probe(file)).durationSec * 1000);
    } catch {
      warnings.push(`cannot read ${file}`);
      return null;
    }
  };
  for (const [id, s] of Object.entries(tl.sources)) {
    if (s.kind !== 'asset') continue;
    const cat = /^sfx[_-]([a-z]+)/i.exec(s.assetId)?.[1] ?? /^sfx[_-]([a-z]+)/i.exec(id)?.[1];
    if (!cat) continue;
    const f = join(p.dir, s.path);
    const d = existsSync(f) ? await durationMs(f) : null;
    if (d === null) continue;
    items.push({ id, kind: cat.toLowerCase(), durationMs: d });
    seen.add(resolve(f));
  }
  // the built-in set (synthesized with ffmpeg on first use, CC0) means there is always something to place
  const builtin = builtinSfxDir();
  try {
    await m.ensureBuiltinSfx(builtin);
  } catch (e) {
    warnings.push(`built-in sfx: ${(e as Error).message}`);
  }
  const roots: { dir: string; inProject: boolean }[] = [
    { dir: join(p.dir, 'assets', 'sfx'), inProject: true },
    { dir: join(videoHome(), 'library', 'cache', 'sfx'), inProject: false },
    { dir: builtin, inProject: false },
  ];
  for (const root of roots) {
    for (const f of walk(root.dir)) {
      if (seen.has(resolve(f))) continue;
      seen.add(resolve(f));
      let side: Sidecar = {};
      for (const sc of [`${f}.json`, join(dirname(f), `${basename(f, extname(f))}.json`)]) {
        if (!existsSync(sc)) continue;
        try {
          side = JSON.parse(readFileSync(sc, 'utf8')) as Sidecar;
        } catch {
          warnings.push(`${sc}: invalid JSON`);
        }
        break;
      }
      if (side.kind && side.kind !== 'sfx') continue;
      const relDir = relative(root.dir, dirname(f)).split('\\').join('/');
      const kind = (side.category ?? (relDir && relDir !== '.' ? relDir.split('/')[0]! : basename(f, extname(f)).split(/[_-]/)[0]!)).toLowerCase();
      const d = side.features?.durationMs ?? (await durationMs(f));
      if (d === null || !(d > 0)) continue;
      const id = side.id && /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(side.id) ? side.id : `sfx_${safeId(kind)}_${safeId(basename(f, extname(f)))}`;
      if (tl.sources[id]) continue;
      const path = root.inProject ? relp(p, f) : `assets/library/${id}${extname(f).toLowerCase()}`;
      if (!root.inProject) copies.set(path, f);
      const credit = side.author ? `${side.title ?? id} — ${side.author}${side.license?.spdx ? ` (${side.license.spdx})` : ''}` : undefined;
      const license: LicenseRef = { id: side.license?.spdx ?? (root.inProject ? 'user-import' : 'unknown'), ...(credit ? { credit } : {}), ...(side.sourceUrl ? { sourceUrl: side.sourceUrl } : {}) };
      items.push({ id, kind, durationMs: d, path, license });
    }
  }
  return { items, copies };
}

const sfx0 = (ops: Op[]) => ops.some((o) => o.op === 'addSfx');

async function cmdSfxApply(ctx: Ctx, args: string[]): Promise<void> {
  const { values } = opts(args, { seed: { type: 'string' }, 'dry-run': { type: 'boolean' }, keep: { type: 'boolean' } }, { max: 0 });
  const p = openProject(ctx);
  const tl = readTimeline(p);
  const tpl = projectTemplate(p);
  if (!tpl.sfx?.rules.length) {
    throw new CliError('no-rules', t(ctx, `テンプレート ${tpl.id} に sfx.rules がありません。ferret-video edit addSfx で入れてください`, `template ${tpl.id} has no sfx.rules; add effects with ferret-video edit addSfx`));
  }
  const warnings: string[] = [];
  const { items, copies } = await sfxLibrary(p, tl, warnings);
  // earlier template-placed sfx are replaced (re-running is idempotent); human/agent-placed ones stay and count
  const old = values.keep ? [] : tl.audio.sfx.filter((s) => s.decided?.by === 'template');
  const base: Timeline = { ...tl, audio: { ...tl.audio, sfx: tl.audio.sfx.filter((s) => !old.includes(s)) } };
  const maxPerMin = tpl.sfx.maxPerMin ?? tpl.audio.sfx?.maxPerMinute;
  const gainDb = tpl.sfx.gainDb ?? tpl.audio.sfx?.gainDb;
  const added = sfxFromRules(base, {
    rules: tpl.sfx.rules, seed: values.seed ?? p.file.id,
    ...(maxPerMin !== undefined ? { maxPerMin } : {}), ...(gainDb !== undefined ? { gainDb } : {}),
    ...(tpl.sfx.minSpacingMs !== undefined ? { minSpacingMs: tpl.sfx.minSpacingMs } : {}),
  }, items);
  const kinds = [...new Set(tpl.sfx.rules.filter((r) => r.kind !== 'none').map((r) => r.kind))];
  const missing = kinds.filter((k) => !items.some((i) => i.kind === k));
  if (missing.length) warnings.push(t(ctx, `ライブラリに無い種類: ${missing.join(', ')}（assets/sfx/<種類>/ に置くと使います）`, `no library sound for: ${missing.join(', ')} (put files in assets/sfx/<kind>/)`));
  const ops: Op[] = [...old.map((s) => ({ op: 'removeSfx' as const, id: s.id })), ...added];
  const dryRun = !!values['dry-run'];
  if (!dryRun) {
    for (const op of added) {
      if (op.op !== 'addSource' || op.source.kind !== 'asset') continue;
      const src = copies.get(op.source.path);
      if (src) {
        mkdirSync(dirname(join(p.dir, op.source.path)), { recursive: true });
        copyFileSync(src, join(p.dir, op.source.path));
      }
    }
  }
  const r = await apply(ctx, p, ops, 'sfx apply', dryRun);
  if (!dryRun && !p.variant) setStep(p, 'sfx', 'done', sfx0(added) ? undefined : t(ctx, 'ライブラリに合う効果音がなかった', 'no matching sound in the library'));
  const fps = tl.canvas.fps;
  const sfx = added.flatMap((o) => (o.op === 'addSfx' ? [{ id: o.sfx.id, at: o.sfx.at, timecode: frameToTimecode(o.sfx.at, fps), trigger: o.sfx.trigger ?? null, asset: o.sfx.asset, gainDb: o.sfx.gainDb }] : []));
  emit(ctx, { variant: p.variant ?? 'main', added: sfx.length, removed: old.length, sfx, library: items.length, dryRun, changed: r.changed, warnings: [...warnings, ...r.warnings] }, () => [
    t(ctx, `効果音を ${sfx.length} 個入れました（前のテンプレートの効果音 ${old.length} 個は入れ替え）${dryRun ? '（確認のみ）' : ''}`, `added ${sfx.length} sound effect(s), replaced ${old.length} template one(s)${dryRun ? ' (dry run)' : ''}`),
    ...sfx.map((s) => `  ${s.timecode} ${s.trigger ?? ''} ${s.asset} ${s.gainDb} dB`),
    ...[...warnings, ...r.warnings].map((w) => `! ${w}`),
  ]);
}

export async function cmdSfx(ctx: Ctx, args: string[]): Promise<void> {
  const [sub, ...rest] = args;
  if (sub === 'apply') return cmdSfxApply(ctx, rest);
  throw new CliError('usage', 'usage: ferret-video sfx apply [--seed s] [--keep] [--dry-run]');
}

// ---------- masks from-analysis ----------

const MASK_KINDS = ['pixelate', 'blur', 'fill'] as const;

async function cmdMasksFromAnalysis(ctx: Ctx, args: string[]): Promise<void> {
  const { values } = opts(args, { source: { type: 'string' }, kinds: { type: 'string' }, kind: { type: 'string' }, 'dry-run': { type: 'boolean' } }, { max: 0 });
  const kind = (values.kind ?? 'pixelate') as Mask['kind'];
  if (!(MASK_KINDS as readonly string[]).includes(kind)) throw new CliError('usage', `--kind must be one of ${MASK_KINDS.join(', ')}`);
  const p = openProject(ctx);
  const tl = readTimeline(p);
  const an = loadAnalysis(p.dir, tl);
  if (values.source && !tl.sources[values.source]) throw new CliError('not-found', `unknown source: ${values.source}`);
  const ids = Object.keys(an.pii).filter((id) => !values.source || id === values.source).sort();
  // same ids as the desktop app (pii.ts): masks it (or an earlier run) already added are skipped, never replaced
  const existing = new Set(tl.masks.map((mk) => mk.id));
  const before = existing.size;
  const added: Op[] = [];
  for (const id of ids) {
    const s = tl.sources[id]!;
    if (s.kind !== 'camera' && s.kind !== 'screen') continue;
    added.push(...piiMaskOps(an.pii[id] as PiiFile, id, existing, {
      size: s.size, sourceFps: fpsValue(s.fps), maskKind: kind,
      ...(values.kinds ? { kinds: values.kinds.split(',').map((k) => k.trim()).filter(Boolean) } : {}),
    }));
  }
  const dryRun = !!values['dry-run'];
  const r = await apply(ctx, p, added, 'masks from-analysis', dryRun);
  const warnings = [...an.warnings, ...r.warnings];
  if (!ids.length) warnings.push(t(ctx, '個人情報の解析ファイル（derived/analysis/pii.<素材>.json）がありません', 'no PII analysis (derived/analysis/pii.<source>.json)'));
  if (!dryRun && !p.variant) setStep(p, 'masks', 'done', ids.length ? (added.length ? t(ctx, `${added.length} 個のモザイクは要確認`, `${added.length} mask(s) need review`) : undefined) : t(ctx, '解析ファイルなし', 'no analysis files'));
  const masks = added.flatMap((o) => (o.op === 'addMask' ? [{ id: o.mask.id, source: o.mask.source, reason: o.mask.reason, kind: o.mask.kind, from: o.mask.track[0]!.frame, to: o.mask.track.at(-1)!.frame, keyframes: o.mask.track.length }] : []));
  emit(ctx, { variant: p.variant ?? 'main', added: masks.length, existing: before, masks, sources: ids, files: an.files, dryRun, changed: r.changed, warnings }, () => [
    t(ctx, `モザイクを ${masks.length} 個入れました（要確認）`, `added ${masks.length} mask(s) (marked for review)`),
    ...masks.map((mk) => `  ${mk.id} ${mk.reason} ${mk.source} ${mk.from}–${mk.to}`),
    ...warnings.map((w) => `! ${w}`),
  ]);
}

export async function cmdMasks(ctx: Ctx, args: string[]): Promise<void> {
  const [sub, ...rest] = args;
  if (sub === 'from-analysis') return cmdMasksFromAnalysis(ctx, rest);
  throw new CliError('usage', 'usage: ferret-video masks from-analysis [--source id] [--kinds email,phone,token] [--kind pixelate|blur|fill] [--dry-run]');
}

// ---------- multicam material ----------

/** Transcript words by take (take seconds), for camera material and switch checks. */
export function wordsByTake(p: Project): Record<string, { w: string; start: number; end: number }[]> {
  const tr = readTranscript(p);
  return tr ? { [tr.take]: tr.words.map(({ w, start, end }) => ({ w, start, end })) } : {};
}

async function cmdMulticamMaterial(ctx: Ctx, args: string[]): Promise<void> {
  opts(args, {}, { max: 0 });
  const p = openProject(ctx);
  const tl = readTimeline(p);
  const tpl = projectTemplate(p);
  const an = loadAnalysis(p.dir, tl);
  const words = wordsByTake(p);
  const segments = cameraMaterial(tl, an.tracks, words);
  const cameras = Object.entries(tl.sources).filter(([, s]) => s.kind === 'camera').map(([id, s]) => ({ id, role: s.kind === 'camera' ? s.role : 'other', take: 'take' in s ? s.take ?? null : null }));
  const check = checkCameraSwitches(tl, { words, ...(tpl.multicam ? { maxShotSec: tpl.multicam.maxShotSec, minShotSec: tpl.multicam.minShotSec } : {}) });
  // the person camera (take.json role main → front) and a deterministic choice per segment: no decision model needed
  const person = personCamera(tl, segments);
  const suggestions = suggestCameras(segments, person);
  const warnings = [...an.warnings];
  if (!an.tracks.faces) warnings.push(t(ctx, '顔の解析（derived/analysis/faces.<素材>.json）がないので、顔の映り具合は分かりません', 'no face tracks (derived/analysis/faces.<source>.json): face visibility is unknown'));
  emit(ctx, {
    variant: p.variant ?? 'main', cameras, person, suggestions, segments, check,
    rules: { maxShotSec: tpl.multicam?.maxShotSec ?? null, minShotSec: tpl.multicam?.minShotSec ?? null, prompt: tpl.promptFiles.multicam ?? null },
    files: an.files, warnings,
  }, () => [
    t(ctx, `カメラ ${cameras.length} 台、区間 ${segments.length}。人物のカメラ: ${person ?? '-'}。切り替えの判断は prompts/multicam.md に沿って`, `${cameras.length} camera(s), ${segments.length} segment(s). Person camera: ${person ?? '-'}. Decide the switches following prompts/multicam.md`),
    ...segments.map((s) => `  ${s.segment} ${s.durationSec.toFixed(1)}s ${s.current ?? '-'} ${s.speaking ? t(ctx, '発話あり', 'speaking') : ''} ${s.cameras.map((c) => `${c.id}:${c.faceVisible === null ? '?' : Math.round(c.faceVisible * 100) + '%'}`).join(' ')}`),
    `${check.status === 'pass' ? '✓' : check.status === 'fail' ? '✗' : '!'} camera-switch: ${check.note}`,
    ...warnings.map((w) => `! ${w}`),
  ]);
}

export async function cmdMulticam(ctx: Ctx, args: string[]): Promise<void> {
  const [sub, ...rest] = args;
  if (sub === 'material') return cmdMulticamMaterial(ctx, rest);
  throw new CliError('usage', 'usage: ferret-video multicam material');
}

// ---------- tracks apply ----------

async function cmdTracksApply(ctx: Ctx, args: string[]): Promise<void> {
  const { values } = opts(args, {
    'follow-clicks': { type: 'boolean' }, 'no-follow-clicks': { type: 'boolean' }, 'no-overlays': { type: 'boolean' }, 'dry-run': { type: 'boolean' },
    center: { type: 'boolean' }, 'no-center': { type: 'boolean' },
  }, { max: 0 });
  if (values['follow-clicks'] && values['no-follow-clicks']) throw new CliError('usage', 'choose --follow-clicks or --no-follow-clicks');
  if (values.center && values['no-center']) throw new CliError('usage', 'choose --center or --no-center');
  const p = openProject(ctx);
  const tl = readTimeline(p);
  const tpl = projectTemplate(p);
  const an = loadAnalysis(p.dir, tl);
  const followClicks = values['no-follow-clicks'] ? false : values['follow-clicks'] ? (tpl.zoom?.followClicks || true) : (tpl.zoom?.followClicks ?? false);
  // the person's face stays centred in the camera's frame (template features.faceReframe; --no-center keeps hand-made crops)
  const center = values['no-center'] ? false : values.center || tpl.features.faceReframe;
  const centered = center ? centerPerson(tl, an.tracks) : null;
  const segments = applyTracks(centered ? { ...tl, segments: centered.segments } : tl, an.tracks, { followClicks });
  const ops: Op[] = [];
  if (JSON.stringify(segments) !== JSON.stringify(tl.segments)) ops.push({ op: 'setSegments', segments });
  // click rings and keystroke badges come from the input logs; earlier generated ones (ov_click_* / ov_key_*) are rebuilt
  const clicks = tpl.features.cursorHighlight;
  const keys = tpl.features.keystrokes;
  let overlays = 0;
  let removed = 0;
  if (!values['no-overlays'] && (clicks || keys)) {
    const old = tl.overlays.filter((o) => (o.kind === 'click-ring' || o.kind === 'keystroke') && /^ov_(click|key)_/.test(o.id));
    removed = old.length;
    const base: Timeline = { ...tl, segments, overlays: tl.overlays.filter((o) => !old.includes(o)) };
    const add = overlaysFromInputLogs(base, an.tracks, { clicks, keys });
    overlays = add.length;
    ops.push(...old.map((o) => ({ op: 'removeOverlay' as const, id: o.id })), ...add.map((overlay) => ({ op: 'addOverlay' as const, overlay })));
  }
  const dryRun = !!values['dry-run'];
  const r = await apply(ctx, p, ops, 'tracks apply', dryRun);
  const zooms = segments.reduce((n, s) => n + (s.zoom?.length ?? 0), 0) - tl.segments.reduce((n, s) => n + (s.zoom?.length ?? 0), 0);
  const warnings = [...an.warnings, ...r.warnings];
  if (!an.files.length) warnings.push(t(ctx, '解析ファイル（顔・カーソル・キー）がありません', 'no analysis files (faces, cursor, keys)'));
  emit(ctx, {
    variant: p.variant ?? 'main', segmentsChanged: ops.some((o) => o.op === 'setSegments'), zoomKeyframesAdded: zooms, followClicks: !!followClicks,
    center: centered ? centered.report : false,
    overlays, removedOverlays: removed, files: an.files, dryRun, changed: r.changed, warnings,
  }, () => [
    t(ctx, `追従ズームを反映しました（キーフレーム ${zooms >= 0 ? '+' : ''}${zooms}）。クリック・キー表示 ${overlays} 個`, `applied tracked zoom (${zooms >= 0 ? '+' : ''}${zooms} keyframes); ${overlays} click/key overlay(s)`),
    ...(centered ? [t(ctx, `人物の顔を中央に: ${centered.report.centered.length} 区間（顔が見えない ${centered.report.noFace.length}・顔の解析なし ${centered.report.noTrack.length}）`, `face centred in ${centered.report.centered.length} segment(s) (no face ${centered.report.noFace.length}, no face track ${centered.report.noTrack.length})`)] : []),
    ...warnings.map((w) => `! ${w}`),
  ]);
}

export async function cmdTracks(ctx: Ctx, args: string[]): Promise<void> {
  const [sub, ...rest] = args;
  if (sub === 'apply') return cmdTracksApply(ctx, rest);
  throw new CliError('usage', 'usage: ferret-video tracks apply [--center|--no-center] [--follow-clicks|--no-follow-clicks] [--no-overlays] [--dry-run]');
}

// ---------- bench profile / apply ----------

function validSamples(raw: unknown): BenchmarkSample[] {
  const list = Array.isArray(raw) ? raw : raw && typeof raw === 'object' && Array.isArray((raw as { samples?: unknown }).samples) ? (raw as { samples: unknown[] }).samples : null;
  if (!list) throw new CliError('invalid-samples', 'samples must be an array (or { samples: [...] })');
  if (!list.length) throw new CliError('invalid-samples', 'no samples');
  list.forEach((s, i) => {
    const x = s as Partial<BenchmarkSample>;
    if (!x || typeof x !== 'object' || typeof x.t !== 'number' || !Array.isArray(x.captionBoxes) || !Array.isArray(x.cutTimes)
      || typeof x.loudness !== 'number' || !Array.isArray(x.sfxOnsets) || typeof x.charsPerMin !== 'number') {
      throw new CliError('invalid-samples', `sample #${i + 1} needs t, captionBoxes[], cutTimes[], loudness, sfxOnsets[], charsPerMin`);
    }
  });
  return list as BenchmarkSample[];
}

async function cmdBenchProfile(ctx: Ctx, args: string[]): Promise<void> {
  const { values, positionals } = opts(args, { out: { type: 'string' }, url: { type: 'string' }, platform: { type: 'string' } }, { min: 1, max: 1, usage: 'ferret-video bench profile <samples.json> [--out profile.json] [--url <reference url>] [--platform youtube|tiktok|…]' });
  const raw = readJsonFile<unknown>(resolve(ctx.io.cwd, positionals[0]!));
  const samples = validSamples(raw);
  const given = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as { source?: StyleProfile['source'] }).source : undefined;
  const source = { ...given, ...(values.url ? { url: values.url } : {}), ...(values.platform ? { platform: values.platform } : {}), analyzed: new Date().toISOString() };
  const profile = benchmarkProfile(samples, { source });
  const now = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '-');
  const out = values.out ? resolve(ctx.io.cwd, values.out) : join(videoHome(), 'benchmarks', `bench_${now}.json`);
  writeAtomic(out, JSON.stringify(profile, null, 2) + '\n');
  const patch = profileToTemplatePatch(profile);
  emit(ctx, { path: out, profile, patch }, () => [
    t(ctx, `参考動画の傾向を保存しました: ${out}`, `saved the style profile: ${out}`),
    t(ctx, `テンプレートに入れるには: ferret-video bench apply ${out}`, `to use it: ferret-video bench apply ${out}`),
  ]);
}

/**
 * Merge a profile into a template override. Scope: inside a project its own template (project override, this video
 * only); `global` (or outside a project) the user override in ~/.ferret/video/templates (every new video). The default
 * template is `tech`. The CLI loads overrides by itself, so the finish flow uses the result without anything else.
 */
function applyProfile(ctx: Ctx, profile: StyleProfile, note: string, o: { template?: string; global?: boolean; dryRun?: boolean }) {
  let p: Project | null = null;
  try {
    p = openProject(ctx);
  } catch {
    p = null;
  }
  const id = o.template ?? p?.file.template.id ?? DEFAULT_TEMPLATE;
  if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) throw new CliError('usage', `invalid template id: ${id}`);
  const patch = profileToTemplatePatch(profile) as Record<string, unknown>;
  const inProject = !o.global && !!p && p.file.template.id === id;
  const scope = inProject ? 'project' as const : 'user' as const;
  if (o.dryRun) return { template: id, scope, patch, dryRun: true as const };
  const root = inProject ? join(p!.dir, 'templates') : join(videoHome(), 'templates');
  // a profile applied before is taken out first, so profiles never pile up
  const prev = readBenchRecord(root, id);
  if (prev) removeBenchPatch(root, id, prev.patch, inProject ? { project: p!.dir } : {});
  const r = writeTemplateOverride(root, id, patch, note, inProject ? { project: p!.dir } : {});
  writeAtomic(benchRecordPath(root, id), JSON.stringify({ at: new Date().toISOString(), note, ...(profile.source ? { source: profile.source } : {}), patch }, null, 2) + '\n');
  return { template: id, scope, patch, dryRun: false as const, file: r.file, captions: { style: r.template.captions.style, maxCharsPerLine: r.template.captions.maxCharsPerLine, maxLines: r.template.captions.maxLines } };
}

/** <root>/<id>/.benchmark.json: what `bench apply` merged into the override (for `bench unapply`). */
const benchRecordPath = (root: string, id: string) => join(root, id, '.benchmark.json');

function readBenchRecord(root: string, id: string): { patch: Record<string, unknown>; source?: unknown } | null {
  const f = benchRecordPath(root, id);
  if (!existsSync(f)) return null;
  try {
    const v = JSON.parse(readFileSync(f, 'utf8')) as { patch?: unknown };
    return v && typeof v.patch === 'object' && v.patch && !Array.isArray(v.patch) ? (v as { patch: Record<string, unknown> }) : null;
  } catch {
    return null;
  }
}

const isPlainObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * Remove a patch from an override (pure): every leaf the patch set is deleted when the override still holds that same
 * value (a later hand edit of the same key is kept); emptied objects go too.
 */
export function subtractPatch(current: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...current };
  for (const [k, v] of Object.entries(patch)) {
    if (!(k in out)) continue;
    if (isPlainObj(v) && isPlainObj(out[k])) {
      const sub = subtractPatch(out[k] as Record<string, unknown>, v);
      if (Object.keys(sub).length) out[k] = sub;
      else delete out[k];
    } else if (JSON.stringify(out[k]) === JSON.stringify(v)) delete out[k];
  }
  return out;
}

/** Take a benchmark patch out of <root>/<id>/template.yaml; the folder goes when nothing of our own is left. */
function removeBenchPatch(root: string, id: string, patch: Record<string, unknown>, o: { project?: string }): { removedFolder: boolean } {
  const file = join(root, id, 'template.yaml');
  rmSync(benchRecordPath(root, id), { force: true });
  if (!existsSync(file)) return { removedFolder: false };
  let current: Record<string, unknown>;
  try {
    current = JSON.parse(readFileSync(file, 'utf8').replace(/^#.*\n/gm, '')) as Record<string, unknown>;
  } catch {
    throw new CliError('template-override', `${file} is not machine-written; remove the benchmark settings by hand`);
  }
  const left = subtractPatch(current, patch);
  const own = Object.keys(left).filter((k) => k !== 'id' && k !== 'extends');
  if (!own.length) {
    rmSync(join(root, id), { recursive: true, force: true });
    return { removedFolder: true };
  }
  writeAtomic(file, `# template override (bench unapply). JSON is valid YAML.\n${JSON.stringify(left, null, 2)}\n`);
  // the rest must still load
  loadTemplate(id, { extraDirs: o.project ? [join(o.project, 'templates')] : [] });
  return { removedFolder: false };
}

/** `bench unapply [--template id] [--global]`: remove what `bench apply` put into the override of that scope. */
async function cmdBenchUnapply(ctx: Ctx, args: string[]): Promise<void> {
  const { values } = opts(args, { template: { type: 'string' }, global: { type: 'boolean' } }, { max: 0, usage: 'ferret-video bench unapply [--template tech] [--global]' });
  let p: Project | null = null;
  try {
    p = openProject(ctx);
  } catch {
    p = null;
  }
  const id = values.template ?? p?.file.template.id ?? DEFAULT_TEMPLATE;
  if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) throw new CliError('usage', `invalid template id: ${id}`);
  const inProject = !values.global && !!p && p.file.template.id === id;
  if (!values.global && !inProject && p) throw new CliError('usage', t(ctx, `このプロジェクトのテンプレートは ${p.file.template.id} です。すべての動画から外すなら --global`, `this project uses ${p.file.template.id}; use --global for every video`));
  const root = inProject ? join(p!.dir, 'templates') : join(videoHome(), 'templates');
  const rec = readBenchRecord(root, id);
  if (!rec) throw new CliError('not-applied', t(ctx, `お手本は適用されていません（${inProject ? 'この動画' : 'すべての動画'}・${id}）`, `no reference is applied (${inProject ? 'this video' : 'every video'}, ${id})`));
  const r = removeBenchPatch(root, id, rec.patch, inProject ? { project: p!.dir } : {});
  emit(ctx, { template: id, scope: inProject ? 'project' : 'user', removed: true, removedFolder: r.removedFolder }, () =>
    t(ctx, `テンプレート ${id} からお手本の設定を外しました（${inProject ? 'この動画' : 'すべての動画'}）`, `removed the reference settings from template ${id} (${inProject ? 'this video' : 'every video'})`));
}

function appliedLines(ctx: Ctx, r: ReturnType<typeof applyProfile>): string[] {
  if (r.dryRun) return [JSON.stringify(r.patch, null, 2)];
  return [
    t(ctx, `テンプレート ${r.template} に参考動画の傾向を入れました（${r.scope === 'project' ? 'この動画' : 'これからのすべての動画'}）: ${r.file}`,
      `merged the style profile into template ${r.template} (${r.scope === 'project' ? 'this video' : 'every new video'}): ${r.file}`),
    `  captions: ${r.captions!.style}, ${r.captions!.maxCharsPerLine} × ${r.captions!.maxLines}`,
  ];
}

function readProfile(file: string, label: string): StyleProfile {
  const profile = readJsonFile<StyleProfile>(file);
  if (!profile || typeof profile !== 'object' || typeof profile.durationSec !== 'number' || !profile.captions || typeof profile.captions !== 'object') {
    throw new CliError('invalid-profile', `${label} is not a style profile (ferret-video bench profile / bench analyze write one)`);
  }
  return profile;
}

async function cmdBenchApply(ctx: Ctx, args: string[]): Promise<void> {
  const { values, positionals } = opts(args, { template: { type: 'string' }, global: { type: 'boolean' }, 'dry-run': { type: 'boolean' } }, { min: 1, max: 1, usage: 'ferret-video bench apply <profile.json> [--global] [--template tech] [--dry-run]' });
  const file = resolve(ctx.io.cwd, positionals[0]!);
  const profile = readProfile(file, positionals[0]!);
  const r = applyProfile(ctx, profile, `ferret-video bench apply ${basename(file)}`, { ...(values.template ? { template: values.template } : {}), global: !!values.global, dryRun: !!values['dry-run'] });
  emit(ctx, r, () => appliedLines(ctx, r));
}

/** `bench analyze <video>`: measure a local reference video with ffmpeg → samples + profile (+ apply). */
async function cmdBenchAnalyze(ctx: Ctx, args: string[]): Promise<void> {
  const { values, positionals } = opts(args, {
    from: { type: 'string' }, to: { type: 'string' }, url: { type: 'string' }, platform: { type: 'string' }, out: { type: 'string' },
    apply: { type: 'boolean' }, global: { type: 'boolean' }, template: { type: 'string' },
  }, { min: 1, max: 1, usage: 'ferret-video bench analyze <video file> [--from s] [--to s] [--url <source url>] [--apply [--global]]' });
  const num = (v: string | undefined, name: string) => {
    if (v === undefined) return undefined;
    const x = Number(v);
    if (!Number.isFinite(x) || x < 0) throw new CliError('usage', `--${name} must be seconds ≥ 0`);
    return x;
  };
  const from = num(values.from, 'from');
  const to = num(values.to, 'to');
  if (from !== undefined && to !== undefined && to - from < 1) throw new CliError('usage', t(ctx, '--to は --from より 1 秒以上あとにしてください', '--to must be at least 1 s after --from'));
  if (values.url && !/^https?:\/\/\S+$/.test(values.url)) throw new CliError('usage', `invalid --url: ${values.url}`);
  if (values.global && !values.apply) throw new CliError('usage', '--global goes with --apply');
  const video = resolve(ctx.io.cwd, positionals[0]!);
  if (!existsSync(video) || !statSync(video).isFile()) throw new CliError('not-found', t(ctx, `動画がありません: ${positionals[0]}`, `video not found: ${positionals[0]}`));
  const m = await media();
  let res: Awaited<ReturnType<typeof m.analyzeReference>>;
  try {
    const labels = { cuts: t(ctx, 'カットを測っています', 'measuring cuts'), loudness: t(ctx, '音量を測っています', 'measuring loudness'), sfx: t(ctx, '効果音を探しています', 'finding sound effects'), captions: t(ctx, '字幕を探しています', 'finding captions'), done: t(ctx, '完了', 'done') };
    // --json: {"progress":{"task":"bench","fraction":…,"label":…,"stage":…}} lines on stderr (ctx.progress)
    res = await m.analyzeReference(video, {
      ...(from !== undefined ? { fromSec: from } : {}), ...(to !== undefined ? { toSec: to } : {}),
      onProgress: (f, stage) => progress(ctx, 'bench', f, labels[stage], { stage }),
    });
  } catch (e) {
    throw new CliError('analyze-failed', (e as Error).message);
  } finally {
    progressDone(ctx, 'bench');
  }
  const source = { ...(values.url ? { url: values.url } : {}), ...(values.platform ? { platform: values.platform } : {}), analyzed: new Date().toISOString() };
  const profile = benchmarkProfile(res.samples, { source });
  const now = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '-');
  const out = values.out ? resolve(ctx.io.cwd, values.out) : join(videoHome(), 'benchmarks', `bench_${now}.json`);
  writeAtomic(out, JSON.stringify(profile, null, 2) + '\n');
  writeAtomic(out.replace(/\.json$/i, '') + '.samples.json', JSON.stringify({ source, samples: res.samples }, null, 2) + '\n');
  const applied = values.apply
    ? applyProfile(ctx, profile, `ferret-video bench analyze ${basename(video)}`, { ...(values.template ? { template: values.template } : {}), global: !!values.global })
    : null;
  emit(ctx, { path: out, profile, patch: profileToTemplatePatch(profile), applied, warnings: res.warnings }, () => [
    t(ctx, `お手本の傾向を測りました（${Math.round(res.durationSec)} 秒）: ${out}`, `measured the reference (${Math.round(res.durationSec)} s): ${out}`),
    t(ctx, `  1ショット ${profile.cuts.avgShotSec} 秒・効果音 ${profile.sfx.perMin} 回/分・字幕 ${profile.captions.present ? 'あり' : 'なし'}`, `  shot ${profile.cuts.avgShotSec} s · sfx ${profile.sfx.perMin}/min · captions ${profile.captions.present ? 'yes' : 'no'}`),
    ...(applied ? appliedLines(ctx, applied) : [t(ctx, `テンプレートに入れるには: ferret-video bench apply ${out}`, `to use it: ferret-video bench apply ${out}`)]),
    ...res.warnings.map((w) => `! ${w}`),
  ]);
}

export async function cmdBench(ctx: Ctx, args: string[]): Promise<void> {
  const [sub, ...rest] = args;
  if (sub === 'profile') return cmdBenchProfile(ctx, rest);
  if (sub === 'apply') return cmdBenchApply(ctx, rest);
  if (sub === 'analyze') return cmdBenchAnalyze(ctx, rest);
  if (sub === 'unapply') return cmdBenchUnapply(ctx, rest);
  throw new CliError('usage', 'usage: ferret-video bench analyze <video> [--apply [--global]] | bench profile <samples.json> | bench apply <profile.json> [--global] | bench unapply [--global]');
}

