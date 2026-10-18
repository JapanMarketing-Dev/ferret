import { spawn } from 'node:child_process';
import { constants as fsc, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join, relative, resolve } from 'node:path';
import {
  checkCameraSwitches, checkCaptionFaceOverlap, checkCaptionSafeArea, checkMosaicTracking, type CheckFinding,
  compile, durationFrames, frameToSeconds, frameToTimecode, repackSegments, secondsToFrame, sourceRate,
  takeFps, takeFrameToTimeline, timecodeToFrame, type Caption, type Marker, type Op, type Rational, type Segment, type Source,
  type Target, type Timeline, type VideoChoice,
} from '@video/core';
import { band, decide, DecideError, type Question } from '@video/decide';
import { loadSettings } from '@video/settings';
import type { Template } from '@video/templates';
import { resolveTool } from '@video/toolchain';
import { registerProject } from '@video/archive';
import { CLI_VERSION, CliError, emit, info, intOpt, opts, progress, progressDone, t, type Ctx } from '../ctx.js';
import { alignWordsToSpeech } from '../align.js';
import { correctText, initialPrompt, projectTerms, type Term } from '../glossary.js';
import { cameraCount, loadAnalysis } from '../analysis.js';
import { decisionSetup, isSkip } from '../decision.js';
import { ensureFonts } from '../fonts.js';
import { cutCandidates, planKeeps, textIn, type Removal } from '../cuts.js';
import { cameraRoles, editFps, takeOffsets } from '../ingest.js';
import {
  VARIANTS, applyEdit, listDirs, openProject, paths, projectTemplate, readJsonFile, readTimeline, setStep, variantExists, vpaths, writeAtomic, type Project,
} from '../project.js';

type Media = typeof import('@video/media');
type Captions = typeof import('@video/captions');

export async function media(): Promise<Media> {
  try {
    return await import('@video/media');
  } catch (e) {
    throw new CliError('engine-unavailable', `@video/media is not available: ${(e as Error).message}`);
  }
}
export async function captionsLib(): Promise<Captions> {
  try {
    return await import('@video/captions');
  } catch (e) {
    throw new CliError('engine-unavailable', `@video/captions is not available: ${(e as Error).message}`);
  }
}

const rel = (p: Project, abs: string) => relative(p.dir, abs).split('\\').join('/');
const abs = (p: Project, path: string) => resolve(p.dir, path);

function by(ctx: Ctx) {
  return { by: ctx.by, ...(ctx.agent ? { agent: ctx.agent } : {}) };
}

// ---------- takes / ingest / import ----------

interface TakeTrack { file: string; kind: 'screen' | 'camera' | 'mic' | 'system'; fps?: number; width?: number; height?: number; sampleRate?: number; firstFrameMs?: number; recorderStartMs?: number; role?: string }
interface TakeMeta { id: string; startedAtMs: number; tracks: TakeTrack[]; markers: { kind: 'ng' | 'important'; atMs: number; sinceStartMs: number }[]; complete?: boolean }

function readTake(dir: string): TakeMeta | null {
  try {
    const m = JSON.parse(readFileSync(join(dir, 'take.json'), 'utf8')) as TakeMeta;
    return m && Array.isArray(m.tracks) ? { ...m, markers: Array.isArray(m.markers) ? m.markers : [] } : null;
  } catch {
    return null;
  }
}

export async function cmdTakes(ctx: Ctx, args: string[]): Promise<void> {
  opts(args, {}, { max: 0 });
  const p = openProject(ctx);
  const tl = readTimeline(p);
  const takes = listDirs(join(p.dir, 'media', 'takes')).map((id) => {
    const m = readTake(join(p.dir, 'media', 'takes', id));
    const files = readdirSync(join(p.dir, 'media', 'takes', id)).filter((f) => f !== 'take.json');
    return { id, files, complete: m?.complete ?? null, markers: m?.markers.length ?? 0, ingested: Object.values(tl.sources).some((s) => 'take' in s && s.take === id) };
  });
  const imports = listDirs(join(p.dir, 'media', 'imports')).map((id) => ({ id, files: readdirSync(join(p.dir, 'media', 'imports', id)) }));
  const sources = Object.entries(tl.sources).map(([id, s]) => ({ id, kind: s.kind, path: s.path, ...('take' in s && s.take ? { take: s.take } : {}), ...(s.kind === 'camera' ? { role: s.role, sync: s.sync } : {}) }));
  emit(ctx, { takes, imports, sources }, () => [
    ...takes.map((x) => `${x.ingested ? '✓' : '·'} ${x.id}  ${x.files.join(', ')}${x.markers ? `  (${t(ctx, '目印', 'markers')} ${x.markers})` : ''}`),
    ...imports.map((x) => `  ${x.id}  ${x.files.join(', ')}`),
    ...(takes.length + imports.length === 0 ? [t(ctx, 'テイクも取り込んだ素材もありません', 'no takes or imports yet')] : []),
  ]);
}

/** Probe a file and build a Source for it. */
async function sourceFor(p: Project, m: Media, file: string, o: { kind?: 'camera' | 'screen' | 'mic'; take?: string; role?: Extract<Source, { kind: 'camera' }>['role']; offsetSec?: number; fpsHint?: number; proxy?: boolean; /** remake an existing proxy (ingest --force) */ reproxy?: boolean }): Promise<{ source: Source; proxied: boolean }> {
  const pr = await m.probe(file);
  const v = pr.streams.find((s) => s.type === 'video');
  const a = pr.streams.find((s) => s.type === 'audio');
  const kind = o.kind ?? (v ? 'camera' : 'mic');
  if ((kind === 'camera' || kind === 'screen') && !v) throw new CliError('no-video', `${basename(file)} has no video stream; import audio-only files with --kind mic`);
  if (kind === 'mic' && !a) throw new CliError('no-audio', `${file} has no audio stream`);
  const offsetSec = o.offsetSec ?? 0;
  if (kind === 'mic') {
    const sr = a!.sampleRate ?? 48000;
    return { source: { kind: 'mic', path: rel(p, file), ...(o.take ? { take: o.take } : {}), sampleRate: sr, offset: -Math.round(offsetSec * sr) }, proxied: false };
  }
  // the recorder's requested rate wins over a VFR file's average (a still screen averages ~6 fps)
  const fps = editFps(v!.fps, o.fpsHint, v!.vfr);
  let path = rel(p, file);
  let proxied = false;
  if (o.proxy !== false && (v!.vfr || /\.webm$/i.test(file))) {
    // MediaRecorder output is VFR: edit from a CFR copy (docs/03 「収録後の正規化」)
    const out = join(p.dir, 'derived', 'proxies', basename(dirname(file)), `${basename(file, extname(file))}.mp4`);
    if (!existsSync(out) || o.reproxy) {
      mkdirSync(dirname(out), { recursive: true });
      await m.makeCfrProxy(file, out, { fps });
    }
    path = rel(p, out);
    proxied = true;
  }
  const rate = fps.num / fps.den;
  const common = {
    path, fps, size: { width: v!.width ?? 1920, height: v!.height ?? 1080 }, offset: -Math.round(offsetSec * rate),
    durationFrames: Math.max(0, Math.floor(pr.durationSec * rate)), ...(a ? {} : { audio: false }),
  };
  if (kind === 'screen') {
    if (!o.take) throw new CliError('usage', 'a screen source needs a take');
    return { source: { kind: 'screen', take: o.take, display: 'main', ...common }, proxied };
  }
  return { source: { kind: 'camera', ...(o.take ? { take: o.take } : {}), role: o.role ?? 'front', ...common }, proxied };
}

export async function cmdIngest(ctx: Ctx, args: string[]): Promise<void> {
  const { values } = opts(args, { 'no-proxy': { type: 'boolean' }, force: { type: 'boolean' } }, { max: 0 });
  const p = openProject(ctx);
  const tl = readTimeline(p);
  const m = await media();
  const ops: Op[] = [];
  const markers: Marker[] = [...tl.markers];
  const added: string[] = [];
  for (const takeId of listDirs(join(p.dir, 'media', 'takes'))) {
    if (!/^take_[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(takeId)) continue;
    const dir = join(p.dir, 'media', 'takes', takeId);
    const meta = readTake(dir);
    if (!meta) continue;
    const tracks = meta.tracks.filter((tr) => tr.kind !== 'system' && existsSync(join(dir, tr.file)));
    // each track's start on the shared clock (a first-sample time on another clock falls back to the recorder start)
    const { t0, offsets } = takeOffsets(tracks, meta.startedAtMs);
    const roles = cameraRoles(tracks);
    let takeRate: Rational | null = null;
    for (const tr of tracks) {
      const id = `${takeId}.${basename(tr.file, extname(tr.file))}`;
      if (tl.sources[id] && !values.force) continue;
      const kind = tr.kind === 'camera' ? 'camera' : tr.kind === 'screen' ? 'screen' : 'mic';
      const { source } = await sourceFor(p, m, join(dir, tr.file), {
        kind, take: takeId, offsetSec: offsets[tr.file] ?? 0, ...(tr.fps ? { fpsHint: tr.fps } : {}), proxy: !values['no-proxy'], reproxy: !!values.force,
        ...(kind === 'camera' ? { role: roles[tr.file] ?? 'other' } : {}),
      });
      if (source.kind === 'camera') source.sync = { method: 'clock', confidence: 1 };
      if ((source.kind === 'screen' || source.kind === 'camera') && (!takeRate || source.kind === 'screen')) takeRate = source.fps;
      ops.push({ op: 'addSource', id, source });
      added.push(id);
    }
    const rate = takeRate ?? tl.canvas.fps;
    for (const mk of meta.markers) {
      const sec = Math.max(0, (mk.atMs - t0) / 1000);
      const srcAt = secondsToFrame(sec, rate);
      if (markers.some((x) => x.kind === mk.kind && 'srcAt' in x && x.srcAt === srcAt)) continue;
      markers.push({ kind: mk.kind, at: secondsToFrame(sec, tl.canvas.fps), srcAt, from: 'hotkey' });
    }
  }
  if (markers.length !== tl.markers.length) ops.push({ op: 'setMarkers', markers });
  if (ops.length) await applyEdit(p, ops, by(ctx));
  const after = readTimeline(p);
  const hasSources = Object.values(after.sources).some((s) => s.kind !== 'asset');
  if (hasSources) setStep(p, 'ingest', 'done');
  emit(ctx, { added, markers: markers.length - tl.markers.length }, () =>
    added.length ? t(ctx, `${added.length} 個の素材を登録しました: ${added.join(', ')}`, `registered ${added.length} source(s): ${added.join(', ')}`)
      : t(ctx, '新しい素材はありません', 'no new media'));
}

export async function cmdImport(ctx: Ctx, args: string[]): Promise<void> {
  const { values, positionals } = opts(args, {
    take: { type: 'string' }, kind: { type: 'string' }, role: { type: 'string' }, id: { type: 'string' }, link: { type: 'boolean' }, 'no-proxy': { type: 'boolean' },
  }, { min: 1, max: 1, usage: 'ferret-video import <file> [--take <take>] [--kind camera|screen|mic] [--role front|close|wide|side|other] [--id <source-id>]' });
  const p = openProject(ctx);
  const src = resolve(ctx.io.cwd, positionals[0]!);
  if (!existsSync(src) || !statSync(src).isFile()) throw new CliError('not-found', t(ctx, `ファイルがありません: ${src}`, `file not found: ${src}`));
  const kind = values.kind as 'camera' | 'screen' | 'mic' | undefined;
  if (kind && !['camera', 'screen', 'mic'].includes(kind)) throw new CliError('usage', '--kind must be camera, screen or mic');
  const role = values.role as Extract<Source, { kind: 'camera' }>['role'] | undefined;
  if (role && !['front', 'close', 'wide', 'side', 'other'].includes(role)) throw new CliError('usage', '--role must be front, close, wide, side or other');
  const tl = readTimeline(p);
  const existingImports = listDirs(join(p.dir, 'media', 'imports'));
  let n = existingImports.length + 1;
  while (existingImports.includes(`imp${n}`)) n++;
  const impId = `imp${n}`;
  const id = values.id ?? impId;
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(id)) throw new CliError('usage', `invalid source id: ${id}`);
  if (tl.sources[id]) throw new CliError('exists', t(ctx, `その id の素材はすでにあります: ${id}`, `source ${id} already exists`));
  const takes = [...new Set(Object.values(tl.sources).map((s) => ('take' in s ? s.take : undefined)).filter((x): x is string => !!x))];
  const take = values.take ?? takes[0] ?? `take_${impId}`;
  if (!/^take_[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(take)) throw new CliError('usage', `invalid take id: ${take} (take_…)`);
  const destDir = join(p.dir, 'media', 'imports', impId);
  mkdirSync(destDir, { recursive: true });
  const dest = join(destDir, basename(src));
  try {
    copyFileSync(src, dest, fsc.COPYFILE_FICLONE);
  } catch (e) {
    rmSync(destDir, { recursive: true, force: true });
    throw new CliError('copy-failed', (e as Error).message);
  }
  const m = await media();
  let source: Source;
  try {
    ({ source } = await sourceFor(p, m, dest, { ...(kind ? { kind } : {}), take, ...(role ? { role } : {}), proxy: !values['no-proxy'] }));
  } catch (e) {
    rmSync(destDir, { recursive: true, force: true });
    throw e instanceof CliError ? e : new CliError('probe-failed', (e as Error).message);
  }
  await applyEdit(p, [{ op: 'addSource', id, source }], by(ctx));
  setStep(p, 'ingest', 'done');
  const needsSync = takes.includes(take);
  if (needsSync) setStep(p, 'sync', 'todo', t(ctx, `${id} を取り込みました。同期が必要です`, `${id} imported; needs sync`));
  emit(ctx, { id, take, source, needsSync }, () => [
    t(ctx, `取り込みました: ${id}（${source.kind}、テイク ${take}）`, `imported ${id} (${source.kind}, take ${take})`),
    ...(needsSync ? [t(ctx, '次: ferret-video sync', 'next: ferret-video sync')] : []),
  ]);
}

// ---------- sync ----------

/** --take must name a take of the timeline. */
export function checkTake(ctx: Ctx, tl: Timeline, take: string | undefined): void {
  if (take === undefined || takesOf(tl).includes(take)) return;
  throw new CliError('not-found', t(ctx, `テイクがありません: ${take}（あるもの: ${takesOf(tl).join(', ') || 'なし'}。ferret-video takes で確認）`, `no such take: ${take} (have: ${takesOf(tl).join(', ') || 'none'}; see ferret-video takes)`));
}

export function takesOf(tl: Timeline): string[] {
  return [...new Set(Object.values(tl.sources).map((s) => ('take' in s ? s.take : undefined)).filter((x): x is string => !!x))].sort();
}

/** The voice track of a take: its mic, else a camera with audio. */
export function voiceOf(tl: Timeline, take: string): [string, Source] | null {
  const entries = Object.entries(tl.sources).filter(([, s]) => 'take' in s && s.take === take).sort(([a], [b]) => a.localeCompare(b));
  return entries.find(([, s]) => s.kind === 'mic') ?? entries.find(([, s]) => s.kind === 'camera' && s.audio !== false) ?? entries.find(([, s]) => s.kind === 'screen' && s.audio !== false) ?? null;
}

export async function cmdSync(ctx: Ctx, args: string[]): Promise<void> {
  const { values } = opts(args, { take: { type: 'string' }, 'min-confidence': { type: 'string' } }, { max: 0 });
  const p = openProject(ctx);
  const tl = readTimeline(p);
  const minConf = values['min-confidence'] ? Number(values['min-confidence']) : 0.5;
  const takes = values.take ? [values.take] : takesOf(tl);
  checkTake(ctx, tl, values.take);
  if (!takes.length) throw new CliError('no-takes', t(ctx, '同期する素材がありません。先に ferret-video ingest / import', 'nothing to sync; run ferret-video ingest / import first'));
  const m = await media();
  const ops: Op[] = [];
  const results: { take: string; ref: string; source: string; offsetSec: number; confidence: number; drift?: number; ok: boolean }[] = [];
  for (const take of takes) {
    const ref = voiceOf(tl, take);
    if (!ref) continue;
    const [refId, refSrc] = ref;
    const refOffsetSec = refSrc.kind === 'asset' ? 0 : refSrc.offset / (sourceRate(tl, refSrc).num / sourceRate(tl, refSrc).den);
    for (const [id, s] of Object.entries(tl.sources)) {
      if (id === refId || !('take' in s) || s.take !== take || s.kind === 'mic' || s.audio === false) continue;
      if (s.kind === 'camera' && s.sync?.method === 'manual') continue;
      let r;
      try {
        r = await m.syncFiles(abs(p, refSrc.path), abs(p, s.path), { maxLagSec: 600 });
      } catch (e) {
        results.push({ take, ref: refId, source: id, offsetSec: 0, confidence: 0, ok: false });
        info(ctx, `! ${id}: ${(e as Error).message}`);
        continue;
      }
      // other local time = drift · ref local time + offsetSec, and ref local = take + refOffsetSec
      const drift = r.drift ?? 1;
      const localAtTake0 = drift * refOffsetSec + r.offsetSec;
      const rate = s.fps.num / s.fps.den;
      const ok = r.confidence >= minConf;
      const patch: Record<string, unknown> = { offset: Math.round(localAtTake0 * rate) };
      if (s.kind === 'camera') {
        patch.sync = { method: 'xcorr', confidence: Math.max(0, Math.min(1, r.confidence)) };
        patch.drift = r.drift && Math.abs(r.drift - 1) > 1e-6 ? r.drift : undefined;
      }
      if (ok) ops.push({ op: 'updateSource', id, patch });
      results.push({ take, ref: refId, source: id, offsetSec: localAtTake0, confidence: r.confidence, ...(r.drift ? { drift: r.drift } : {}), ok });
    }
  }
  mkdirSync(paths(p.dir).analysis, { recursive: true });
  writeAtomic(join(paths(p.dir).analysis, 'sync.json'), JSON.stringify({ at: new Date().toISOString(), results }, null, 2));
  if (ops.length) await applyEdit(p, ops, by(ctx));
  const low = results.filter((r) => !r.ok);
  if (low.length) setStep(p, 'sync', 'needs-human', t(ctx, `同期の信頼度が低い素材があります: ${low.map((r) => `${r.source}（${r.confidence.toFixed(2)}）`).join(', ')}`, `low sync confidence: ${low.map((r) => `${r.source} (${r.confidence.toFixed(2)})`).join(', ')}`));
  else setStep(p, 'sync', results.length ? 'done' : 'skipped', results.length ? undefined : t(ctx, '同期する素材が1つだけでした', 'only one track; nothing to sync'));
  emit(ctx, { results }, () => results.length
    ? results.map((r) => `${r.ok ? '✓' : '!'} ${r.source} → ${r.ref}: ${r.offsetSec.toFixed(3)}s (${t(ctx, '信頼度', 'confidence')} ${r.confidence.toFixed(2)})`)
    : [t(ctx, '同期する素材が1つだけでした', 'only one track; nothing to sync')]);
}

// ---------- transcribe ----------

interface TranscriptFile {
  schema: 1;
  engine: 'whisper.cpp';
  model: string;
  language: string;
  take: string;
  source: string;
  /** Word times were fitted into the speech regions (see align.ts). */
  aligned?: boolean;
  /** Word times in seconds of the take clock. */
  words: { w: string; start: number; end: number; conf?: number; speaker?: string }[];
  createdAt: string;
}

export function readTranscript(p: Project): TranscriptFile | null {
  const f = paths(p.dir).transcript;
  if (!existsSync(f)) return null;
  try {
    return JSON.parse(readFileSync(f, 'utf8')) as TranscriptFile;
  } catch {
    return null;
  }
}

export function runProcess(bin: string, args: string[], o: { cwd?: string; env?: NodeJS.ProcessEnv; onLine?: (l: string) => void } = {}): Promise<{ code: number | null; stderr: string }> {
  return new Promise((res, rej) => {
    const c = spawn(bin, args, { cwd: o.cwd, env: o.env ?? process.env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let stderr = '';
    c.stdout.on('data', (d) => o.onLine?.(String(d)));
    c.stderr.on('data', (d) => {
      stderr += String(d);
      if (stderr.length > 200_000) stderr = stderr.slice(-100_000);
      o.onLine?.(String(d));
    });
    c.on('error', rej);
    c.on('close', (code) => res({ code, stderr }));
  });
}

/** Filler words as an initial prompt make whisper keep them (docs/05 note). */
const INITIAL_PROMPT: Record<'ja' | 'en', string> = {
  ja: 'えーと、あのー、まあ、今日はですね、えー、この設定について話します。',
  en: 'Um, so, uh, today I want to, you know, talk about this setting.',
};

/** Glossary terms of the project (main timeline meta.glossary, template glossary, script.md). */
export function glossaryOf(p: Project): Term[] {
  let meta: Term[] = [];
  try {
    meta = readTimeline({ dir: p.dir, variant: null }).meta.glossary;
  } catch {
    /* no timeline yet */
  }
  let tplTerms: Term[] = [];
  try {
    tplTerms = projectTemplate(p).glossary ?? [];
  } catch {
    /* template errors are reported elsewhere */
  }
  return projectTerms(p.dir, meta, tplTerms);
}

/** whisper.cpp word timestamps (seconds in the file) for any audio/video file. */
export async function whisperWords(ctx: Ctx, p: Project, file: string, o: { lang: string; model?: string; threads?: string; name: string }): Promise<{ words: { w: string; start: number; end: number; conf?: number; speaker?: string }[]; model: string }> {
  const settings = loadSettings();
  const modelKey = (o.model ?? settings.transcription.model) === 'small' ? 'whisper-model-small' : 'whisper-model';
  const [cli, model] = await Promise.all([resolveTool('whisper-cli'), resolveTool(modelKey)]);
  if (!cli) throw new CliError('tool-missing', t(ctx, 'whisper-cli がありません。Ferret の内蔵ターミナルから実行するか、`brew install whisper-cpp` などで入れてください（FERRET_VIDEO_WHISPER_CLI で場所も指定できます）', 'whisper-cli not found. Run this from a Ferret terminal, or install it (`brew install whisper-cpp`…) or set FERRET_VIDEO_WHISPER_CLI'));
  if (!model) throw new CliError('tool-missing', t(ctx, '文字起こしのモデルがありません。`ferret-video lib install whisper`', 'whisper model not found: `ferret-video lib install whisper`'));
  const m = await media();
  const wav = join(paths(p.dir).cache, `${o.name}.wav`);
  mkdirSync(dirname(wav), { recursive: true });
  info(ctx, t(ctx, '音声を取り出しています…', 'extracting audio…'));
  await m.runFfmpeg(['-hide_banner', '-nostdin', '-y', '-i', file, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', wav]);
  const outBase = join(paths(p.dir).cache, `${o.name}.whisper`);
  const prompt = initialPrompt(INITIAL_PROMPT[p.file.language], glossaryOf(p), p.file.language);
  const whisperArgs = ['-m', model, '-f', wav, '-l', o.lang, '-ml', '1', '-sow', '-ojf', '-of', outBase, '-np', '--prompt', prompt];
  if (o.threads) whisperArgs.push('-t', o.threads);
  info(ctx, t(ctx, '文字起こししています（長い素材では数分かかります）…', 'transcribing (may take minutes for long media)…'));
  const env = { ...process.env };
  if (process.platform === 'linux') env.LD_LIBRARY_PATH = [dirname(cli), env.LD_LIBRARY_PATH].filter(Boolean).join(':');
  const r = await runProcess(cli, whisperArgs, { env, onLine: (l) => {
    const mm = /progress\s*=\s*(\d+)%/.exec(l);
    if (mm) progress(ctx, 'whisper', Number(mm[1]) / 100, t(ctx, '文字起こし', 'transcribing'));
  } });
  progressDone(ctx, 'whisper');
  rmSync(wav, { force: true });
  if (r.code !== 0 || !existsSync(`${outBase}.json`)) throw new CliError('whisper-failed', `whisper-cli failed (${r.code}): ${r.stderr.trim().split('\n').slice(-3).join(' ')}`);
  const cap = await captionsLib();
  const words = cap.wordsFromWhisperJson(JSON.parse(readFileSync(`${outBase}.json`, 'utf8')));
  rmSync(`${outBase}.json`, { force: true });
  return { words, model };
}

export async function cmdTranscribe(ctx: Ctx, args: string[]): Promise<void> {
  const { values } = opts(args, { take: { type: 'string' }, source: { type: 'string' }, model: { type: 'string' }, language: { type: 'string' }, threads: { type: 'string' }, 'no-align': { type: 'boolean' } }, { max: 0 });
  const p = openProject(ctx);
  const tl = readTimeline(p);
  const settings = loadSettings();
  checkTake(ctx, tl, values.take);
  if (values.model !== undefined && values.model !== 'small' && values.model !== 'large-v3-turbo-q5') throw new CliError('usage', t(ctx, `--model は small か large-v3-turbo-q5 です（${values.model} は使えません）`, `--model is small or large-v3-turbo-q5 (not ${values.model})`));
  const take = values.take ?? takesOf(tl)[0];
  if (!take) throw new CliError('no-takes', t(ctx, '文字起こしする素材がありません。先に ferret-video ingest / import', 'nothing to transcribe; run ferret-video ingest / import first'));
  const voice = values.source ? ([values.source, tl.sources[values.source]] as const) : voiceOf(tl, take);
  if (!voice || !voice[1]) throw new CliError('no-audio', t(ctx, `テイク ${take} に音声の素材がありません`, `take ${take} has no audio source`));
  const [sourceId, src] = voice as [string, Source];
  const lang = values.language ?? (settings.transcription.language === 'auto' ? 'auto' : p.file.language);
  const m = await media();
  const { words, model } = await whisperWords(ctx, p, abs(p, src.path), { lang, ...(values.model ? { model: values.model } : {}), ...(values.threads ? { threads: values.threads } : {}), name: `transcribe-${sourceId.replace(/[^A-Za-z0-9_.-]/g, '_')}` });
  // whisper times are local to the source file; convert to the take clock (local = take·drift + offset/rate)
  const rate = sourceRate(tl, src);
  const offsetSec = src.kind === 'asset' ? 0 : src.offset * rate.den / rate.num;
  const drift = src.kind === 'camera' && src.drift ? src.drift : 1;
  const toTake = (sec: number) => Math.max(0, (sec - offsetSec) / drift);
  let takeWords = words.map((w) => ({ ...w, start: toTake(w.start), end: toTake(w.end) }));
  let aligned = false;
  if (!values['no-align'] && takeWords.length) {
    // whisper word times drift; fit them into the speech regions found by silencedetect (same params as the cuts)
    const tpl = projectTemplate(p);
    const voicePath = abs(p, src.path);
    const [sil, pr] = await Promise.all([m.detectSilence(voicePath, { noiseDb: tpl.cut.silence.noiseDb, minMs: Math.min(300, tpl.cut.silence.minMs) }), m.probe(voicePath)]);
    takeWords = alignWordsToSpeech(takeWords, sil.map((x) => ({ start: toTake(x.start), end: toTake(x.end) })), toTake(pr.durationSec));
    aligned = true;
  }
  const file: TranscriptFile = {
    schema: 1, engine: 'whisper.cpp', model: basename(model), language: lang, take, source: sourceId, aligned,
    words: takeWords, createdAt: new Date().toISOString(),
  };
  writeAtomic(paths(p.dir).transcript, JSON.stringify(file) + '\n');
  await applyEdit(p, [{ op: 'setTranscript', transcript: { path: 'derived/transcripts/main.json', engine: 'whisper.cpp', model: file.model, summary: tl.transcript?.summary ?? '' } }], by(ctx));
  setStep(p, 'transcribe', 'done');
  const text = textIn(file.words, 0, Number.POSITIVE_INFINITY, p.file.language);
  emit(ctx, { path: 'derived/transcripts/main.json', take, source: sourceId, words: file.words.length, model: file.model, preview: text.slice(0, 200) }, () => [
    t(ctx, `文字起こししました: ${file.words.length} 語（derived/transcripts/main.json）`, `transcribed ${file.words.length} words (derived/transcripts/main.json)`),
    text.slice(0, 120) + (text.length > 120 ? '…' : ''),
  ]);
}

// ---------- analyze ----------

export async function cmdAnalyze(ctx: Ctx, args: string[]): Promise<void> {
  const { values } = opts(args, { take: { type: 'string' } }, { max: 0 });
  const p = openProject(ctx);
  const tl = readTimeline(p);
  const tpl = projectTemplate(p);
  const m = await media();
  const out: Record<string, unknown> = {};
  checkTake(ctx, tl, values.take);
  for (const take of values.take ? [values.take] : takesOf(tl)) {
    const voice = voiceOf(tl, take);
    const entry: Record<string, unknown> = {};
    if (voice) {
      const path = abs(p, voice[1].path);
      entry.voice = voice[0];
      entry.silence = await m.detectSilence(path, { noiseDb: tpl.cut.silence.noiseDb, minMs: tpl.cut.silence.minMs });
      entry.loudness = await m.measureLoudness(path);
    }
    const video: Record<string, unknown> = {};
    for (const [id, s] of Object.entries(tl.sources)) {
      if (!('take' in s) || s.take !== take || (s.kind !== 'camera' && s.kind !== 'screen')) continue;
      video[id] = { black: await m.detectBlack(abs(p, s.path), { minSec: 0.5 }), freeze: await m.detectFreeze(abs(p, s.path), { minSec: 2 }) };
    }
    entry.video = video;
    out[take] = entry;
    writeAtomic(join(paths(p.dir).analysis, `${take}.json`), JSON.stringify({ at: new Date().toISOString(), ...entry }, null, 2));
  }
  if (!p.variant && !values.take) setStep(p, 'analyze', 'done');
  emit(ctx, { analysis: out }, () => Object.entries(out).map(([take, e]) => {
    const x = e as { silence?: unknown[]; loudness?: { integrated: number } };
    return `${take}: ${t(ctx, '無音', 'silences')} ${x.silence?.length ?? 0}, ${x.loudness ? `${x.loudness.integrated.toFixed(1)} LUFS` : ''}`;
  }));
}

// ---------- propose cuts ----------

function chooseVideo(tl: Timeline, tpl: Template, take: string): VideoChoice {
  const entries = Object.entries(tl.sources).filter(([, s]) => 'take' in s && s.take === take).sort(([a], [b]) => a.localeCompare(b));
  const cams = entries.filter(([, s]) => s.kind === 'camera') as [string, Extract<Source, { kind: 'camera' }>][];
  const camera = (cams.find(([, s]) => s.role === 'front') ?? cams[0])?.[0];
  const screen = entries.find(([, s]) => s.kind === 'screen')?.[0];
  const wipe = tpl.layouts.wipe ?? { shape: 'circle' as const, corner: 'br' as const, style: 'default' };
  const want = tpl.layouts.default;
  if (want === 'screen-with-wipe' && screen && camera) return { layout: 'screen-with-wipe', screen, camera, wipe };
  if (want === 'split-v' && screen && camera) return { layout: 'split-v', top: screen, bottom: camera };
  if ((want === 'screen-full' || want === 'screen-with-wipe' || want === 'split-v') && screen) return { layout: 'screen-full', screen };
  if (camera) return { layout: 'camera-full', camera };
  if (screen) return { layout: 'screen-full', screen };
  throw new CliError('no-video', `take ${take} has no camera or screen source`);
}

function takeDurationSec(tl: Timeline, take: string): number {
  let best = 0;
  for (const s of Object.values(tl.sources)) {
    if (!('take' in s) || s.take !== take || (s.kind !== 'camera' && s.kind !== 'screen') || s.durationFrames === undefined) continue;
    // source local frames → take seconds
    const local = s.durationFrames * s.fps.den / s.fps.num;
    const offsetSec = s.offset * s.fps.den / s.fps.num;
    best = Math.max(best, (local - offsetSec) / (s.kind === 'camera' && s.drift ? s.drift : 1));
  }
  return best;
}

/**
 * Without a decision model the rules decide: every candidate is cut, and retakes (the rule cannot tell which take is
 * better) are marked needsReview on the removed span, so the agent re-reads them (prompts/rough-cut.md). Nothing
 * waits for a human.
 */
export function ruleJudge(cands: Removal[]): { cut: Removal[]; review: Removal[] } {
  return { cut: cands.map((c) => (c.kind === 'retake' ? { ...c, needsReview: true } : c)), review: [] };
}

/**
 * Ask the decision model about filler/retake candidates, many per call (agent CLIs are slow and counted in calls).
 * Failures fall back to the rule for the rest.
 */
async function judge(ctx: Ctx, p: Project, tpl: Template, cands: Removal[], words: TranscriptFile['words'], warnings: string[]): Promise<{ cut: Removal[]; review: Removal[] }> {
  const ask = cands.filter((c) => c.kind === 'filler' || c.kind === 'retake');
  const rest = cands.filter((c) => !(c.kind === 'filler' || c.kind === 'retake'));
  if (!ask.length) return { cut: cands, review: [] };
  const setup = decisionSetup(ctx, p, 'cut');
  if (isSkip(setup)) {
    if (setup.skip === 'consent') warnings.push(t(ctx, 'クラウドの判定モデルへの送信に同意していないため、規則で決めました（設定 decision.cloudConsent）', 'cloud decision model not consented (decision.cloudConsent); used the rules'));
    return ruleJudge(cands);
  }
  const cut: Removal[] = [...rest];
  const review: Removal[] = [];
  const thresholds = tpl.decisions.cutKeep;
  const BATCH = 40;
  for (let i = 0; i < ask.length; i += BATCH) {
    const batch = ask.slice(i, i + BATCH);
    const state = {
      template_rules: tpl.prompts['rough-cut']?.slice(0, 1500) ?? '',
      candidates: batch.map((c, j) => ({
        id: `c${i + j}`, kind: c.kind, before: textIn(words, c.start - 6, c.start, p.file.language),
        candidate: c.text ?? textIn(words, c.start, c.end, p.file.language), after: textIn(words, c.end, c.end + 6, p.file.language),
      })),
    };
    const questions: Question[] = batch.map((_, j) => ({
      id: `c${i + j}`, kind: 'yesno',
      text: t(ctx, `候補 c${i + j} を切っても、話の流れは自然につながるか`, `Does the speech still flow naturally if candidate c${i + j} is cut?`),
    }));
    try {
      const answers = await decide({ state, questions }, setup.options);
      const byId = new Map(answers.map((a) => [a.id, a.p ?? 0.5]));
      batch.forEach((c, j) => {
        const pr = byId.get(`c${i + j}`) ?? 0.5;
        const b = band(pr, thresholds);
        if (b === 'yes') cut.push({ ...c, by: 'decision-model', confidence: pr });
        else if (b === 'ask') review.push({ ...c, by: 'decision-model', confidence: pr, needsReview: true });
        // 'no': keep the words (not cut)
      });
    } catch (e) {
      if (e instanceof DecideError && e.code === 'budget') warnings.push(t(ctx, '判定モデルの上限に達したため、残りは規則で決めました', 'decision budget reached; the rest used the rules'));
      else warnings.push(`decision model: ${(e as Error).message}`);
      cut.push(...ask.slice(i));
      return { cut, review };
    }
  }
  return { cut, review };
}

export async function cmdPropose(ctx: Ctx, args: string[]): Promise<void> {
  const [what, ...rest] = args;
  if (what !== 'cuts') throw new CliError('usage', 'usage: ferret-video propose cuts [--take <take>] [--replace] [--dry-run]');
  const { values } = opts(rest, { take: { type: 'string' }, replace: { type: 'boolean' }, 'dry-run': { type: 'boolean' } }, { max: 0 });
  const p = openProject(ctx);
  const tl = readTimeline(p);
  const tpl = projectTemplate(p);
  const transcript = readTranscript(p);
  const take = values.take ?? transcript?.take ?? takesOf(tl)[0];
  if (!take) throw new CliError('no-takes', t(ctx, '素材がありません。先に ferret-video ingest / import', 'no media; run ferret-video ingest / import first'));
  if (tl.segments.length && !values.replace && !values['dry-run']) {
    throw new CliError('segments-exist', t(ctx, `すでに区間が ${tl.segments.length} 個あります。作り直すなら --replace`, `the timeline already has ${tl.segments.length} segments; use --replace to rebuild`));
  }
  const voice = voiceOf(tl, take);
  if (!voice) throw new CliError('no-audio', t(ctx, `テイク ${take} に音声がありません`, `take ${take} has no audio`));
  const m = await media();
  const cap = await captionsLib();
  const words = transcript && transcript.take === take ? transcript.words : [];
  const rate = takeFps(tl, take);
  let durationSec = takeDurationSec(tl, take);
  const vSrc = voice[1];
  // silence is measured on the voice file; convert to the take clock
  const vRate = sourceRate(tl, vSrc);
  const vOffsetSec = vSrc.kind === 'asset' ? 0 : vSrc.offset * vRate.den / vRate.num;
  const silencesLocal = await m.detectSilence(abs(p, vSrc.path), { noiseDb: tpl.cut.silence.noiseDb, minMs: tpl.cut.silence.minMs });
  const silences = silencesLocal.map((s) => ({ start: Math.max(0, s.start - vOffsetSec), end: Math.max(0, s.end - vOffsetSec) }));
  if (!durationSec) durationSec = (await m.probe(abs(p, vSrc.path))).durationSec - vOffsetSec;
  const ngMarkers = tl.markers.filter((mk): mk is Extract<Marker, { kind: 'ng' }> => mk.kind === 'ng').map((mk) => frameToSeconds(mk.srcAt, rate));
  const warnings: string[] = [];
  if (!words.length) warnings.push(t(ctx, '文字起こしがないため、無音と NG の目印だけで切りました', 'no transcript: cut by silence and NG markers only'));
  const cands = cutCandidates({
    durationSec, silences, ngMarkers, lang: p.file.language,
    fillers: words.length ? cap.findFillers(words, tpl.cut.fillers) : [],
    retakes: words.length && tpl.cut.retakes !== 'off' ? cap.findRetakes(words) : [],
    rules: { silence: tpl.cut.silence, retakes: tpl.cut.retakes, ngMarkers: tpl.cut.ngMarkers, minKeepMs: tpl.cut.minKeepMs },
  });
  const judged = await judge(ctx, p, tpl, cands, words, warnings);
  const { keeps, trailing } = planKeeps(durationSec, judged.cut, tpl.cut.minKeepMs, p.file.language, { words });
  if (!keeps.length) throw new CliError('nothing-left', t(ctx, 'すべて無音と判定されました。音声の素材とテンプレートの silence.noiseDb を確認してください', 'everything was cut as silence; check the voice source and silence.noiseDb'));
  const video = chooseVideo(tl, tpl, take);
  const toFrame = (sec: number) => secondsToFrame(sec, rate);
  const ruleRef = `templates/${tpl.id}/template.yaml#cut`;
  const decidedOf = (r: Removal) => ({
    by: r.by, reason: r.reason, ...(r.confidence !== undefined ? { confidence: Math.round(r.confidence * 1000) / 1000 } : {}),
    ...(r.needsReview ? { needsReview: true } : {}), ...(r.by === 'rule' ? { ruleRef } : {}),
  });
  const removedOf = (list: Removal[]) => list.map((r) => ({ kind: r.kind, src: { from: toFrame(r.start), to: Math.max(toFrame(r.start), toFrame(r.end)) }, decided: decidedOf(r) })).filter((r) => r.src.to > r.src.from);
  const jump = tpl.cut.jumpZoom;
  let segments: Segment[] = keeps.map((k, i) => {
    const from = toFrame(k.start);
    const to = Math.max(from + 1, toFrame(k.end));
    const review = judged.review.filter((r) => r.start >= k.start && r.end <= k.end);
    const seg: Segment = {
      id: `seg_${String(i + 1).padStart(3, '0')}`,
      range: { start: 0, end: 0 },
      src: { from, to, take },
      text: textIn(words, k.start, k.end, p.file.language),
      chapter: 'ch_1',
      role: 'explain',
      video,
      decided: {
        by: 'rule', ruleRef,
        reason: t(ctx, '無音・言いよどみ・言い直しを除いて残した区間', 'kept after removing silence, fillers and retakes'),
        ...(review.length ? { needsReview: true } : {}),
      },
    };
    const removed = removedOf(i === keeps.length - 1 ? [...k.removedBefore, ...trailing] : k.removedBefore);
    if (removed.length) seg.removedNeighbors = removed;
    if (jump && jump.every > 0 && i > 0 && i % jump.every === 0 && video.layout === 'camera-full') {
      seg.transitionIn = { kind: 'jump-zoom', frames: 0 };
      seg.zoom = [{ at: 0, value: { scale: jump.scale, focus: 'face' } }];
    }
    return seg;
  });
  segments = repackSegments(tl, segments);
  const total = segments.at(-1)!.range.end;
  const reviewItems = segments.filter((s) => s.decided.needsReview).map((s) => {
    const r = judged.review.find((x) => x.start >= frameToSeconds(s.src.from, rate) - 1e-6 && x.end <= frameToSeconds(s.src.to, rate) + 1e-6);
    return { ref: s.id, kind: 'decision' as const, summary: r ? t(ctx, `「${r.text ?? ''}」を切るか（確率 ${r.confidence?.toFixed(2)}）`, `cut "${r.text ?? ''}"? (p=${r.confidence?.toFixed(2)})`) : t(ctx, '切るかどうか要確認', 'cut or keep?') };
  });
  const ops: Op[] = [
    { op: 'setOutline', outline: [{ id: 'ch_1', title: tl.meta.title, start: 0, end: total, points: [], importance: 'core' }] },
    { op: 'setSegments', segments },
    { op: 'setReview', patch: { openItems: [...tl.review.openItems.filter((i) => i.kind !== 'decision'), ...reviewItems] } },
  ];
  // Rebuilding segments moves every timeline frame: captions are rebuilt from the transcript, and timed elements
  // past the new end are dropped (reported), so the result stays valid.
  if (tl.captions.length) {
    ops.push({ op: 'setCaptions', captions: [] });
    warnings.push(t(ctx, '区間を作り直したので字幕を消しました。`ferret-video captions build` で作り直してください', 'captions were cleared because segments changed; run `ferret-video captions build`'));
  }
  const past = (r: { start: number; end: number }) => r.end > total;
  for (const o of tl.overlays) if (o.kind === 'click-ring' ? o.at >= total : past(o.range)) ops.push({ op: 'removeOverlay', id: o.id });
  for (const sc of tl.scenes) if (past(sc.range)) ops.push({ op: 'removeScene', id: sc.id });
  for (const x of tl.audio.sfx) if (x.at >= total) ops.push({ op: 'removeSfx', id: x.id });
  if (tl.audio.bgm.some((b) => past(b.range))) {
    ops.push({ op: 'setBgm', bgm: tl.audio.bgm.filter((b) => b.range.start < total).map((b) => ({ ...b, range: { start: b.range.start, end: Math.min(b.range.end, total) } })) });
  }
  if (tl.markers.some((mk) => mk.at >= total)) ops.push({ op: 'setMarkers', markers: tl.markers.map((mk) => (mk.at >= total ? { ...mk, at: Math.max(0, total - 1) } : mk)) });
  const dropped = ops.filter((o) => o.op === 'removeOverlay' || o.op === 'removeScene' || o.op === 'removeSfx').map((o) => (o as { id: string }).id);
  if (dropped.length) warnings.push(t(ctx, `新しい長さを超える要素を外しました: ${dropped.join(', ')}`, `removed elements past the new end: ${dropped.join(', ')}`));
  const keptSec = keeps.reduce((a, k) => a + (k.end - k.start), 0);
  const stats = {
    take, segments: segments.length, sourceSec: Math.round(durationSec * 100) / 100, keptSec: Math.round(keptSec * 100) / 100,
    cutRatio: durationSec > 0 ? Math.round((1 - keptSec / durationSec) * 1000) / 1000 : 0,
    removed: judged.cut.reduce<Record<string, number>>((a, r) => ((a[r.kind] = (a[r.kind] ?? 0) + 1), a), {}),
    review: reviewItems.map((r) => r.ref), duration: frameToTimecode(total, tl.canvas.fps),
  };
  if (!values['dry-run']) {
    await applyEdit(p, ops, { ...by(ctx), note: 'propose cuts' });
    if (tl.captions.length) setStep(p, 'captions', 'todo', t(ctx, '区間を作り直したので字幕を作り直す', 'segments changed: rebuild captions'));
    setStep(p, 'rough-cut', 'running', t(ctx, '候補で区間を作りました。prompts/rough-cut.md に沿って見直し、終わったら `ferret-video step rough-cut done`', 'segments built from candidates; review them per prompts/rough-cut.md, then `ferret-video step rough-cut done`'));
  }
  emit(ctx, { ...stats, dryRun: !!values['dry-run'], warnings, ...(values['dry-run'] ? { proposed: segments } : {}) }, () => [
    t(ctx, `${stats.segments} 区間（${stats.duration}）。元の ${stats.sourceSec} 秒のうち ${Math.round(stats.cutRatio * 100)}% を切りました`, `${stats.segments} segments (${stats.duration}); cut ${Math.round(stats.cutRatio * 100)}% of ${stats.sourceSec}s`),
    ...Object.entries(stats.removed).map(([k, n]) => `  ${k}: ${n}`),
    ...(stats.review.length ? [t(ctx, `要確認: ${stats.review.join(', ')}`, `to review: ${stats.review.join(', ')}`)] : []),
    ...warnings.map((w) => `! ${w}`),
    ...(values['dry-run'] ? [t(ctx, '（確認のみ。書き込んでいません）', '(dry run; nothing written)')] : []),
  ]);
}

// ---------- captions ----------

/** Build captions for the opened timeline (main or variant) from the transcript, and write its ASS/SRT. */
/**
 * Strings buildCaptions / layoutLines must keep whole: the glossary terms plus every misheard span of the transcript
 * that the glossary pass will respell (found on the joined text, so a span across words is caught too).
 */
export function captionGlossary(words: string[], terms: Term[], language: 'ja' | 'en'): string[] {
  if (!terms.length) return [];
  const text = words.join(language === 'ja' ? '' : ' ');
  const misheard = correctText(text, terms).corrections.map((c) => c.from);
  const out = new Map<string, string>();   // glossary matching is case-insensitive: one entry per spelling
  for (const x of [...terms.map((t) => t.term), ...misheard]) if (!out.has(x.toLowerCase())) out.set(x.toLowerCase(), x);
  return [...out.values()];
}

export async function buildCaptionsFor(ctx: Ctx, p: Project, o: { style?: string } = {}): Promise<{ captions: number; style: string; files: string[] }> {
  const tl = readTimeline(p);
  const tpl = projectTemplate(p);
  const tr = readTranscript(p);
  if (!tr) throw new CliError('no-transcript', t(ctx, '文字起こしがありません。先に ferret-video transcribe', 'no transcript; run ferret-video transcribe first'));
  if (!tl.segments.length) throw new CliError('no-segments', t(ctx, '区間がありません。先に ferret-video propose cuts', 'no segments; run ferret-video propose cuts first'));
  const cap = await captionsLib();
  // an older project's vertical variant keeps the vertical style, sized by the style itself
  const style = o.style ?? (p.variant ? 'tiktok-bold' : tpl.captions.style);
  if (o.style && !cap.CAPTION_STYLES[o.style]) throw new CliError('usage', t(ctx, `字幕のスタイルがありません: ${o.style}（${Object.keys(cap.CAPTION_STYLES).join(', ')}）`, `unknown caption style: ${o.style} (${Object.keys(cap.CAPTION_STYLES).join(', ')})`));
  // a benchmark (ferret-video bench apply) may have measured the look of a reference: size and colors follow it
  const styleDef = cap.styleWithLook(cap.CAPTION_STYLES[style] ?? Object.values(cap.CAPTION_STYLES)[0]!, p.variant ? undefined : tpl.captionLook);
  const maxCharsPerLine = p.variant ? styleDef.maxCharsPerLine[p.file.language] : tpl.captions.maxCharsPerLine;
  const maxLines = p.variant ? styleDef.maxLines : tpl.captions.maxLines;
  const position = p.variant ? styleDef.position : tpl.captions.position;
  const rate = takeFps(tl, tr.take);
  // A word belongs to the timeline when its middle is in a kept segment (the same rule as `propose cuts`);
  // kept words are clamped into their segment so a word straddling a cut edge is never lost.
  const kept = tl.segments.filter((sg) => sg.src.take === tr.take).map((sg) => [frameToSeconds(sg.src.from, rate), frameToSeconds(sg.src.to, rate)] as const);
  const words = tr.words.flatMap((w) => {
    const mid = (w.start + w.end) / 2;
    const r = kept.find(([a, b]) => mid >= a && mid < b);
    if (!r) return [];
    const start = Math.min(Math.max(w.start, r[0]), r[1] - 1e-6);
    return [{ ...w, start, end: Math.max(start, Math.min(w.end, r[1] - 1e-6)) }];
  });
  const terms = glossaryOf(p);
  // glossary terms (and the misheard spans that will be respelled as them) are never split across captions or lines
  const glossary = captionGlossary(words.map((w) => w.w), terms, p.file.language);
  const F = tl.canvas.fps.num / tl.canvas.fps.den;
  const autoEmphasis = !p.variant && tpl.captions.emphasis === 'auto';
  const built = cap.buildCaptions(words, {
    fps: tl.canvas.fps, maxCharsPerLine, maxLines, language: p.file.language, style, glossary, endFrame: durationFrames(tl),
    mapTime: (sec: number) => takeFrameToTimeline(tl, tr.take, secondsToFrame(sec, rate)),
    ...(tpl.captions.minDurationMs ? { minFrames: Math.round((tpl.captions.minDurationMs / 1000) * F) } : {}),
    ...(tpl.captions.maxDurationMs ? { maxDurationMs: tpl.captions.maxDurationMs } : {}),
    // key terms in the accent color without a decision model (template captions.emphasis: auto)
    ...(autoEmphasis ? { emphasis: { auto: true } } : {}),
  });
  // glossary pass: near-misses of the project's terms are respelled; the original stays in `spoken`
  const captions: Caption[] = built.map((c) => {
    const fixed = terms.length ? correctText(c.text, terms) : { text: c.text, corrections: [] };
    if (!fixed.corrections.length) return { ...c, position };
    return {
      ...c, position, text: fixed.text, lines: cap.layoutLines(fixed.text, maxCharsPerLine, p.file.language, glossary),
      ...(autoEmphasis ? { emphasis: cap.pickEmphasis(fixed.text, { language: p.file.language, glossary: [...glossary, ...terms.map((x) => x.term)] }).map((word) => ({ word, style: 'color' as const })) } : {}),
      corrections: [...(c.corrections ?? []), ...fixed.corrections.map((x) => ({
        from: x.from, to: x.to, decided: { by: 'rule' as const, reason: `glossary: "${x.from}" → "${x.to}"`, confidence: x.score, ruleRef: 'meta.glossary' },
      }))],
    };
  });
  await applyEdit(p, [{ op: 'setCaptions', captions }], by(ctx));
  const vp = vpaths(p);
  mkdirSync(join(p.dir, 'captions'), { recursive: true });
  writeAtomic(join(p.dir, vp.ass), cap.toAss(captions, styleDef, tl.canvas, tl.canvas.fps));
  writeAtomic(join(p.dir, vp.srt), cap.toSrt(captions, tl.canvas.fps));
  return { captions: captions.length, style, files: [vp.ass, vp.srt] };
}

export async function cmdCaptions(ctx: Ctx, args: string[]): Promise<void> {
  const [sub, ...rest] = args;
  if (sub !== 'build') throw new CliError('usage', 'usage: ferret-video captions build [--style <style>]');
  const { values } = opts(rest, { style: { type: 'string' } }, { max: 0 });
  const p = openProject(ctx);
  const r = await buildCaptionsFor(ctx, p, values.style ? { style: values.style } : {});
  if (!p.variant) setStep(p, 'captions', 'done');
  emit(ctx, { ...r, variant: p.variant ?? 'main' }, () =>
    t(ctx, `字幕を ${r.captions} 個作りました（${r.files.join('、')}）`, `built ${r.captions} captions (${r.files.join(', ')})`));
}

// ---------- render / frame / check ----------

async function renderTimeline(ctx: Ctx, p: Project, tl: Timeline, o: { quality: 'preview' | 'final'; target?: Target; output: string }): Promise<{ output: string; reused: number; rendered: number; warnings: string[] }> {
  const m = await media();
  const tpl = projectTemplate(p);
  const ass = join(p.dir, vpaths(p).ass);
  const fontWarnings: string[] = [];
  const needsFonts = tl.captions.length > 0 || tl.scenes.length > 0 || tl.overlays.some((o) => o.kind === 'telop' || o.kind === 'keystroke');
  const fontsDir = needsFonts ? await ensureFonts(ctx, fontWarnings) : null;
  let plan;
  try {
    plan = compile(tl, {
      ...(fontsDir ? { fontsDir } : {}),
      quality: o.quality, ...(o.target ? { target: o.target } : {}), projectDir: p.dir,
      ...(tl.captions.length && (p.variant || tpl.captions.burnIn) && existsSync(ass) ? { assPath: vpaths(p).ass } : {}),
    });
  } catch (e) {
    throw new CliError('compile-failed', (e as Error).message);
  }
  const r = await m.executeRenderPlan(plan, {
    projectDir: p.dir, cacheDir: join('derived', 'cache', 'render'), output: o.output, ...(fontsDir ? { fontsDir } : {}),
    // previews use the hardware H.264 encoder when there is one (settings.export.hwEncodePreview); finals stay x264
    encoder: loadSettings().export.hwEncodePreview ? 'auto' : 'x264',
    onProgress: ({ done, total }) => progress(ctx, 'render', total ? done / total : 1, `${t(ctx, '書き出し中', 'rendering')} ${done}/${total}`),
  });
  progressDone(ctx, 'render');
  return { ...r, warnings: [...fontWarnings, ...plan.warnings] };
}

/** Main + every derived variant that exists (for --all). */
export function allTimelines(p: Project): Project[] {
  return [{ ...p, variant: null }, ...VARIANTS.filter((v) => variantExists(p.dir, v)).map((v) => ({ ...p, variant: v }))];
}

async function renderOne(ctx: Ctx, p: Project, o: { quality: 'preview' | 'final'; target?: string; out?: string }): Promise<Record<string, unknown> & { warnings: string[]; output: string }> {
  const tl = readTimeline(p);
  // a variant renders for its own target (docs/18); the main video for the given or first target
  const target = (p.variant ?? o.target ?? (o.quality === 'final' ? tl.meta.targets[0] : undefined)) as Target | undefined;
  if (target && !['youtube', 'youtube-shorts', 'tiktok', 'instagram-reels'].includes(target)) throw new CliError('usage', `unknown target: ${target}`);
  const output = o.out ? resolve(ctx.io.cwd, o.out) : o.quality === 'preview' ? vpaths(p).preview : join(p.dir, 'renders', target!, 'final.mp4');
  const started = Date.now();
  const r = await renderTimeline(ctx, p, tl, { quality: o.quality, ...(target ? { target } : {}), output });
  const out = rel(p, r.output);
  if (o.quality === 'final' && target) {
    const prev = tl.outputs.find((x) => x.target === target);
    const ffmpeg = await resolveTool('ffmpeg');
    const output = prev ?? {
      target, canvas: tl.canvas, preset: target,
      metadata: { title: tl.meta.title, titleCandidates: [], description: '', tags: [], chapters: tl.outline.length > 1 },
    };
    await applyEdit(p, [{ op: 'setOutput', output: { ...output, render: { path: out, hash: String(statSync(r.output).size), at: new Date().toISOString(), toolVersions: { 'ferret-video': CLI_VERSION, ...(ffmpeg ? { ffmpeg: basename(ffmpeg) } : {}) } } } }], by(ctx));
    setStep(p, p.variant ? `final:${p.variant}` : 'final', 'done');
    if (!p.variant && loadSettings().archive.autoRegister.includes('export')) {
      try {
        await registerProject(p.dir, { reason: 'export' });
      } catch (e) {
        r.warnings.push(`archive: ${(e as Error).message}`);
      }
    }
  } else if (!o.out && !p.variant) {
    // compatibility copy for readers of the old location
    copyFileSync(r.output, join(p.dir, 'renders', 'preview.mp4'));
    setStep(p, 'preview', 'done');
  }
  return { variant: p.variant ?? 'main', output: out, quality: o.quality, ...(target ? { target } : {}), reused: r.reused, rendered: r.rendered, seconds: Math.round((Date.now() - started) / 100) / 10, warnings: r.warnings };
}

export async function cmdRender(ctx: Ctx, args: string[]): Promise<void> {
  const { values } = opts(args, { preview: { type: 'boolean' }, final: { type: 'boolean' }, target: { type: 'string' }, out: { type: 'string' }, all: { type: 'boolean' } }, { max: 0 });
  if (values.preview && values.final) throw new CliError('usage', 'choose --preview or --final');
  if (values.all && (values.out || values.target || ctx.variant)) throw new CliError('usage', '--all renders every video; do not combine it with --out, --target or --variant');
  const quality = values.final ? 'final' : 'preview';
  const p = openProject(ctx);
  const line = (r: Record<string, unknown> & { warnings: string[]; output: string }) => [
    t(ctx, `書き出しました: ${r.output}（作り直し ${r.rendered}、再利用 ${r.reused}）`, `rendered ${r.output} (${r.rendered} rendered, ${r.reused} reused)`),
    ...r.warnings.map((w) => `! ${w}`),
  ];
  if (values.all) {
    const results: Awaited<ReturnType<typeof renderOne>>[] = [];
    for (const x of allTimelines(p)) {
      info(ctx, `${x.variant ?? 'main'}:`);
      results.push(await renderOne(ctx, x, { quality }));
    }
    emit(ctx, { results }, () => results.flatMap(line));
    return;
  }
  const r = await renderOne(ctx, p, { quality, ...(values.target ? { target: values.target } : {}), ...(values.out ? { out: values.out } : {}) });
  emit(ctx, r, () => line(r));
}

/** The preview, re-rendered when timeline.json is newer. */
export async function freshPreview(ctx: Ctx, p: Project, tl: Timeline): Promise<string> {
  const prev = vpaths(p).preview;
  if (existsSync(prev) && statSync(prev).mtimeMs >= statSync(vpaths(p).timeline).mtimeMs) return prev;
  info(ctx, t(ctx, 'プレビューを書き出しています…', 'rendering the preview…'));
  await renderTimeline(ctx, p, tl, { quality: 'preview', output: prev });
  return prev;
}

export async function cmdFrame(ctx: Ctx, args: string[]): Promise<void> {
  const { values } = opts(args, { at: { type: 'string' }, out: { type: 'string' }, width: { type: 'string' } }, { max: 0, usage: 'ferret-video frame --at <frame|timecode> [--out file.png]' });
  if (!values.at) throw new CliError('usage', 'usage: ferret-video frame --at <frame|timecode> [--out file.png]');
  const p = openProject(ctx);
  const tl = readTimeline(p);
  let frame: number;
  try {
    frame = /^\d+$/.test(values.at) ? Number(values.at) : timecodeToFrame(values.at, tl.canvas.fps);
  } catch (e) {
    throw new CliError('usage', (e as Error).message);
  }
  const total = durationFrames(tl);
  if (frame < 0 || frame >= total) throw new CliError('out-of-range', t(ctx, `フレーム ${frame} は範囲外です（0〜${total - 1}）`, `frame ${frame} is out of range (0–${total - 1})`));
  const width = intOpt(values.width, 'width');
  const m = await media();
  const preview = await freshPreview(ctx, p, tl);
  const out = values.out ? resolve(ctx.io.cwd, values.out) : join(p.dir, 'checks', 'frames', `${frame}.png`);
  mkdirSync(dirname(out), { recursive: true });
  await m.extractFrame(preview, frameToSeconds(frame, tl.canvas.fps), out, width ? { width } : {});
  emit(ctx, { frame, timecode: frameToTimecode(frame, tl.canvas.fps), path: out }, () => out);
}

/**
 * Previews render at reduced size: the spec check judges their aspect ratio, not the delivery size (that is checked on
 * the final render with `check --input renders/<target>/final.mp4`).
 */
export function previewSpec(f: CheckFinding): CheckFinding {
  if (f.check !== 'spec' || f.status !== 'fail') return f;
  const problems = f.note.split('; ');
  const kept = problems.filter((x) => {
    const m = /^size (\d+)x(\d+) \(expected (\d+)x(\d+)\)$/.exec(x);
    if (!m) return true;
    const [w, h, ew, eh] = m.slice(1).map(Number) as [number, number, number, number];
    return Math.abs(w / h - ew / eh) > 0.01;
  });
  if (kept.length === problems.length) return f;
  return kept.length
    ? { ...f, note: kept.join('; ') }
    : { ...f, status: 'pass', note: 'preview: aspect ratio matches (delivery size is checked on the final render)' };
}

/**
 * Timeline-based checks the template asks for (core round 5), run when their inputs exist: caption safe area (always,
 * per target), caption/face overlap (face tracks), mosaic tracking (PII analysis), camera switches (≥ 2 cameras).
 */
export function trackChecks(p: Project, tl: Timeline, target: Target | undefined): CheckFinding[] {
  const tpl = projectTemplate(p);
  const want = new Set<string>(tpl.checks);
  const an = loadAnalysis(p.dir, tl);
  const out: CheckFinding[] = [];
  if (want.has('caption-safe-area') && target && tl.captions.length) out.push(checkCaptionSafeArea(tl, target));
  if (want.has('caption-face-overlap') && an.tracks.faces && tl.captions.length) out.push(checkCaptionFaceOverlap(tl, an.tracks));
  if (want.has('mosaic-tracking') && Object.keys(an.pii).length) out.push(checkMosaicTracking(tl, an.pii));
  if (want.has('camera-switch') && cameraCount(tl) >= 2) {
    const tr = readTranscript(p);
    out.push(checkCameraSwitches(tl, {
      ...(tr ? { words: { [tr.take]: tr.words } } : {}),
      ...(tpl.multicam ? { maxShotSec: tpl.multicam.maxShotSec, minShotSec: tpl.multicam.minShotSec } : {}),
    }));
  }
  return out;
}

async function checkOne(ctx: Ctx, p: Project, o: { input?: string; target?: string; only?: string }): Promise<{ variant: string; run: string; passed: number; failed: number; needsHuman: number; report: string; findings: unknown[] }> {
  const tl = readTimeline(p);
  const m = await media();
  const input = o.input ? resolve(ctx.io.cwd, o.input) : await freshPreview(ctx, p, tl);
  const target = (p.variant ?? o.target ?? tl.meta.targets[0]) as Target | undefined;
  let findings: CheckFinding[] = await m.runMachineChecks(input, target ? { target } : {});
  if (!o.input) findings = findings.map(previewSpec);
  findings.push(...trackChecks(p, tl, target));
  if (o.only === 'failed' && tl.review.lastCheck) {
    const prev = readJsonFile<{ findings: { check: string; status: string }[] }>(join(p.dir, 'checks', tl.review.lastCheck.run, 'report.json'));
    const failedSet = new Set(prev.findings.filter((f) => f.status !== 'pass').map((f) => f.check));
    findings = findings.filter((f) => failedSet.has(f.check));
  }
  const now = new Date();
  const run = `chk_${now.toISOString().replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '-')}${p.variant ? `-${p.variant}` : ''}`;
  const dir = join(p.dir, 'checks', run);
  mkdirSync(dir, { recursive: true });
  const passed = findings.filter((f) => f.status === 'pass').length;
  const failed = findings.filter((f) => f.status === 'fail').length;
  const needsHuman = findings.filter((f) => f.status === 'needs-human').length;
  const fmt = (sec: number) => frameToTimecode(secondsToFrame(sec, tl.canvas.fps), tl.canvas.fps);
  const md = [
    `# ${t(ctx, 'チェック結果', 'Check report')} ${run}${p.variant ? ` (${p.variant})` : ''}`,
    '',
    `- ${t(ctx, '対象', 'input')}: \`${rel(p, input)}\`${target ? ` (${target})` : ''}`,
    `- ${t(ctx, '合格', 'passed')} ${passed} / ${t(ctx, '不合格', 'failed')} ${failed} / ${t(ctx, '要確認', 'needs human')} ${needsHuman}`,
    '',
    ...findings.map((f) => [
      `## ${f.status === 'pass' ? '✓' : f.status === 'fail' ? '✗' : '!'} ${f.check}`,
      '',
      f.note,
      ...(f.ranges?.length ? ['', ...f.ranges.map((r) => `- ${fmt(r.start)} – ${fmt(r.end)}`)] : []),
      '',
    ].join('\n')),
  ].join('\n');
  writeFileSync(join(dir, 'report.md'), md + '\n');
  writeFileSync(join(dir, 'report.json'), JSON.stringify({ run, at: now.toISOString(), variant: p.variant ?? 'main', input: rel(p, input), target, findings }, null, 2));
  await applyEdit(p, [{ op: 'setReview', patch: { lastCheck: { run: run as `chk_${string}`, passed, failed, needsHuman, at: now.toISOString() } } }], by(ctx));
  setStep(p, p.variant ? `check:${p.variant}` : 'check', 'done', failed ? t(ctx, `${failed} 件が不合格`, `${failed} failed`) : undefined);
  return { variant: p.variant ?? 'main', run, passed, failed, needsHuman, report: `checks/${run}/report.md`, findings };
}

export async function cmdCheck(ctx: Ctx, args: string[]): Promise<void> {
  const { values } = opts(args, { input: { type: 'string' }, target: { type: 'string' }, only: { type: 'string' }, all: { type: 'boolean' } }, { max: 0 });
  if (values.all && (values.input || ctx.variant)) throw new CliError('usage', '--all checks every video; do not combine it with --input or --variant');
  const p = openProject(ctx);
  const o = { ...(values.input ? { input: values.input } : {}), ...(values.target ? { target: values.target } : {}), ...(values.only ? { only: values.only } : {}) };
  const lines = (r: Awaited<ReturnType<typeof checkOne>>) => [
    ...(r.findings as { check: string; status: string; note: string }[]).map((f) => `${f.status === 'pass' ? '✓' : f.status === 'fail' ? '✗' : '!'} ${f.check}: ${f.note}`),
    t(ctx, `レポート: ${r.report}`, `report: ${r.report}`),
  ];
  if (values.all) {
    const results: Awaited<ReturnType<typeof checkOne>>[] = [];
    for (const x of allTimelines(p)) results.push(await checkOne(ctx, x, o));
    emit(ctx, { results, failed: results.reduce((a, r) => a + r.failed, 0) }, () => results.flatMap((r) => [`[${r.variant}]`, ...lines(r)]));
    return;
  }
  const r = await checkOne(ctx, p, o);
  emit(ctx, r, () => lines(r));
}
