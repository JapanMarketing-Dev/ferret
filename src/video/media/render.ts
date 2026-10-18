import { createHash } from 'node:crypto';
import type { Dirent } from 'node:fs';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import type { HwEncoder } from './hwenc.js';
import { cpuCount, detectHwEncoder, renderConcurrency, withEncoder } from './hwenc.js';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import type { FastAudio, FramePlan, RenderPlan } from '@video/core';
import { ffFilterValue, LOUDNORM_TOKEN } from '@video/core';
import { videoHome } from '@video/toolchain';
import { measuredLoudnorm, parseLoudnormLog } from './analyze.js';
import { atomicOutput } from './proxy.js';
import { ffmpegStderr, MediaError, runFfmpeg } from './run.js';

const FONT_EXT = /\.(ttf|otf|ttc|otc)$/i;

/** The folder with the most font files under `root` (depth ≤ 4), or null. */
function fontFolder(root: string): string | null {
  let best: { dir: string; n: number } | null = null;
  const walk = (dir: string, depth: number) => {
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    const n = entries.filter((e) => e.isFile() && FONT_EXT.test(e.name)).length;
    if (n > 0 && (!best || n > best.n)) best = { dir, n };
    if (depth < 4) for (const e of entries) if (e.isDirectory()) walk(join(dir, e.name), depth + 1);
  };
  walk(root, 0);
  return (best as { dir: string; n: number } | null)?.dir ?? null;
}

/**
 * Fonts for libass: env FERRET_VIDEO_FONTS, else the toolchain's ~/.ferret/video/tools/fonts (or $FERRET_VIDEO_HOME/tools/fonts)
 * when it holds font files. Returns the folder containing them, or null.
 */
export function defaultFontsDir(): string | null {
  const env = process.env.FERRET_VIDEO_FONTS;
  if (env) return existsSync(env) ? fontFolder(env) : null;
  const root = join(videoHome(), 'tools', 'fonts');
  return existsSync(root) ? fontFolder(root) : null;
}

/** Add `fontsdir` to every `subtitles` filter in a filter graph that has none (plans compiled without fontsDir). */
export function withFontsDir(args: string[], dir: string): string[] {
  const i = args.indexOf('-filter_complex');
  if (i < 0) return args;
  const fc = args[i + 1]!;
  const next = fc.replace(/subtitles=filename=(.*?):original_size=/g, (m, name: string) =>
    name.includes(':fontsdir=') ? m : `subtitles=filename=${name}:fontsdir=${ffFilterValue(dir)}:original_size=`);
  if (next === fc) return args;
  const out = args.slice();
  out[i + 1] = next;
  return out;
}

export interface ExecuteOptions {
  projectDir: string;
  cacheDir: string;
  output: string;
  onProgress?: (p: { chunk: string; done: number; total: number }) => void;
  /** Parallel chunks (default from the CPU count, see renderConcurrency). */
  concurrency?: number;
  /**
   * Video encoder for preview plans: 'auto' (default) = the detected hardware encoder when there is one, 'x264' =
   * always software, or a specific hardware encoder. Final plans always use x264.
   */
  encoder?: 'auto' | 'x264' | HwEncoder;
  signal?: AbortSignal;
  /** Fonts folder for libass when the plan has none: default `defaultFontsDir()`; false = do not add. */
  fontsDir?: string | false;
  /** Preview audio from cached per-segment stems when the plan has them (default true); false = the full graph. */
  fastAudio?: boolean;
}

/** Integrated loudness (LUFS) from the `ebur128` summary in an ffmpeg log, or null (no summary / below the gate). */
export function parseEbur128Integrated(log: string): number | null {
  const at = log.lastIndexOf('Integrated loudness:');
  if (at < 0) return null;
  const m = /I:\s*(-?\d+(?:\.\d+)?|-?inf|nan)\s*LUFS/.exec(log.slice(at));
  if (!m) return null;
  const v = Number(m[1]);
  return Number.isFinite(v) && v > -70 ? v : null;
}

/**
 * Gain filter for fast preview audio: the stems' loudness combined by duration-weighted energy (an approximation
 * of the integrated loudness of the whole voice), a gain to `target.I` (clamped to ±30 dB) and a peak limiter at
 * `target.TP`. Silent stems (null) are ignored; all silent → no gain.
 */
export function previewGainFilter(stems: { lufs: number | null; durationSec: number }[], target: { I: number; TP: number }): string {
  let e = 0;
  let d = 0;
  for (const s of stems) {
    if (s.lufs === null || !(s.durationSec > 0)) continue;
    e += s.durationSec * 10 ** (s.lufs / 10);
    d += s.durationSec;
  }
  const gain = d > 0 ? Math.max(-30, Math.min(30, target.I - 10 * Math.log10(e / d))) : 0;
  const limit = Math.max(0.0625, Math.min(1, 10 ** (target.TP / 20)));
  return `volume=${gain.toFixed(2)}dB,alimiter=limit=${limit.toFixed(4)}:level=0`;
}

function sub(args: string[], map: Record<string, string>): string[] {
  return args.map((a) => (a in map ? map[a]! : a));
}

/** Values following each `-i` (input files). */
export function inputsOf(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length - 1; i++) {
    if (args[i] === '-i' && !(args[i - 2] === '-f' && args[i - 1] === 'lavfi')) out.push(args[i + 1]!);
  }
  return out;
}

/** Which of `candidates` (project-relative ASS paths) a chunk's filter graph burns in. */
export function subtitleFilesOf(args: string[], candidates: string[]): string[] {
  const i = args.indexOf('-filter_complex');
  const fc = i >= 0 ? args[i + 1] : undefined;
  if (!fc) return [];
  return candidates.filter((p) => fc.includes(`subtitles=filename=${ffFilterValue(p)}`));
}

/** Cache key: plan hash + identity (size, mtime) of every input file + content of referenced subtitle files. */
function cacheKey(hash: string, args: string[], projectDir: string, subs: string[]): string {
  const h = createHash('sha256').update(hash);
  for (const p of inputsOf(args)) {
    if (p.startsWith('{')) continue;
    const abs = isAbsolute(p) ? p : resolve(projectDir, p);
    try {
      const st = statSync(abs);
      h.update(`\0${p}\0${st.size}\0${Math.floor(st.mtimeMs)}`);
    } catch {
      throw new MediaError(`input not found: ${p}`);
    }
  }
  for (const s of subtitleFilesOf(args, subs)) {
    const abs = isAbsolute(s) ? s : resolve(projectDir, s);
    if (!existsSync(abs)) throw new MediaError(`subtitle file not found: ${s}`);
    h.update('\0ass\0').update(readFileSync(abs));
  }
  return h.digest('hex').slice(0, 32);
}

async function pool<T>(items: T[], n: number, fn: (item: T) => Promise<void>, signal?: AbortSignal): Promise<void> {
  let next = 0;
  let failed: unknown = null;
  const worker = async () => {
    while (next < items.length && failed === null) {
      if (signal?.aborted) {
        failed ??= Object.assign(new Error('aborted'), { name: 'AbortError' });
        break;
      }
      const item = items[next++]!;
      try {
        await fn(item);
      } catch (e) {
        failed ??= e;
      }
    }
  };
  // wait for every worker (their ffmpeg is killed by the signal and their temp files removed) before rejecting
  await Promise.allSettled(Array.from({ length: Math.max(1, Math.min(n, items.length)) }, worker));
  if (signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
  if (failed !== null) throw failed;
}

/** Concat demuxer list line with the path quoted for the demuxer. */
export function concatLine(path: string): string {
  return `file '${path.replace(/'/g, "'\\''")}'`;
}

/**
 * Render a plan: chunks in parallel (cached by content in `cacheDir`), the audio mix (cached), then concat + mux.
 * ffmpeg runs with cwd = projectDir so plan paths stay relative.
 */
export async function executeRenderPlan(plan: RenderPlan, o: ExecuteOptions): Promise<{ output: string; reused: number; rendered: number; encoder: string }> {
  const projectDir = resolve(o.projectDir);
  const cacheDir = resolve(projectDir, o.cacheDir);
  const output = resolve(projectDir, o.output);
  mkdirSync(join(cacheDir, 'chunks'), { recursive: true });
  mkdirSync(join(cacheDir, 'audio'), { recursive: true });
  if (plan.chunks.length === 0) throw new MediaError('render plan has no chunks');

  for (const w of plan.writes ?? []) {
    const abs = resolve(projectDir, w.path);
    if (existsSync(abs) && readFileSync(abs, 'utf8') === w.content) continue;
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, w.content);
  }

  const subs = [...(plan.subtitles ? [plan.subtitles.assPath] : []), ...(plan.writes ?? []).map((w) => w.path).filter((p) => p.endsWith('.ass'))];
  const fonts = o.fontsDir === false ? null : o.fontsDir ?? defaultFontsDir();
  const hw: HwEncoder | null = plan.quality !== 'preview' || o.encoder === 'x264' ? null
    : o.encoder && o.encoder !== 'auto' ? o.encoder : await detectHwEncoder();
  const par = renderConcurrency({ hardware: !!hw });
  const conc = o.concurrency ?? par.chunks;
  const threads = Math.max(1, Math.ceil(cpuCount() / conc));
  const chunks = plan.chunks.map((c) => {
    let args = fonts ? withFontsDir(c.args, fonts) : c.args;
    if (hw) args = withEncoder(args, hw);
    else if (args.includes('libx264') && !args.includes('-threads')) args = [...args.slice(0, -1), '-threads', String(threads), ...args.slice(-1)];
    return { ...c, args, hash: hw ? `${c.hash}\0enc\0${hw}` : c.hash };
  });
  const files = new Map<string, string>();
  const todo: RenderPlan['chunks'] = [];
  let reused = 0;
  for (const c of chunks) {
    const fontKey = c.args.some((a) => a.includes(':fontsdir=')) ? `${c.hash}\0fonts\0${fonts ?? 'plan'}` : c.hash;
    const file = join(cacheDir, 'chunks', `${cacheKey(fontKey, c.args, projectDir, subs)}.mp4`);
    files.set(c.id, file);
    if (existsSync(file) && statSync(file).size > 0) reused++;
    else todo.push(c);
  }
  let audioFile = join(cacheDir, 'audio', `${cacheKey(plan.audio.hash, plan.audio.args, projectDir, [])}.wav`);
  const total = plan.chunks.length;
  let done = reused;
  if (reused) o.onProgress?.({ chunk: '(cache)', done, total });
  const run = (args: string[]) => runFfmpeg(args, o.signal ? { cwd: projectDir, signal: o.signal } : { cwd: projectDir });
  const rendering = new Set<string>();
  await pool(todo, conc, async (c) => {
    const file = files.get(c.id)!;
    if (rendering.has(file)) return; // identical chunk content appears twice
    rendering.add(file);
    await atomicOutput(file, (tmp) => run(sub(c.args, { '{out}': tmp })));
    done++;
    o.onProgress?.({ chunk: c.id, done, total });
  }, o.signal);
  // Duplicated chunks rendered once count as rendered once; the rest were waiting on the same file.
  for (const c of todo) {
    if (!existsSync(files.get(c.id)!)) throw new MediaError(`chunk ${c.id} was not rendered`);
  }

  const fast = plan.audio.fast && o.fastAudio !== false ? plan.audio.fast : null;
  if (fast) audioFile = await fastAudioMix(fast, { cacheDir, projectDir, run, ...(o.signal ? { signal: o.signal } : {}) });
  else if (!existsSync(audioFile)) {
    let args = plan.audio.args;
    const m = plan.audio.measure;
    if (m) {
      // 2-pass loudness: measure the mix, then normalize linearly with the measured values.
      const log = await ffmpegStderr(m.args, o.signal ? { cwd: projectDir, signal: o.signal } : { cwd: projectDir });
      const filter = measuredLoudnorm(parseLoudnormLog(log), m.target);
      args = args.map((a) => a.replaceAll(LOUDNORM_TOKEN, filter));
    }
    await atomicOutput(audioFile, (tmp) => run(sub(args, { '{out}': tmp })));
  }

  const list = plan.chunks.map((c) => concatLine(files.get(c.id)!)).join('\n') + '\n';
  const listFile = join(cacheDir, `${createHash('sha256').update(list).digest('hex').slice(0, 16)}-${plan.concat.listFile}`);
  writeFileSync(listFile, list);
  await atomicOutput(output, (tmp) => run(sub(plan.final.args, { '{concat}': listFile, '{audio}': audioFile, '{out}': tmp })));
  return { output, reused, rendered: rendering.size, encoder: hw ?? 'libx264' };
}

/**
 * Fast preview audio: missing voice stems rendered in parallel (each cached with its loudness in a .json sidecar,
 * written after the stem so a stem without one is rendered again), then the master mix over the concat list, cached
 * by the list, the gain and the inputs. Returns the master file.
 */
async function fastAudioMix(fast: FastAudio, o: { cacheDir: string; projectDir: string; signal?: AbortSignal; run: (args: string[]) => Promise<void> }): Promise<string> {
  const dir = join(o.cacheDir, 'audio');
  const stems = fast.stems.map((st) => ({ ...st, file: join(dir, `stem-${cacheKey(st.hash, st.args, o.projectDir, [])}.wav`) }));
  const meta = (file: string) => `${file}.json`;
  const lufs = new Map<string, number | null>();
  const todo = stems.filter((st) => {
    if (!existsSync(st.file) || !existsSync(meta(st.file))) return true;
    try {
      const v = (JSON.parse(readFileSync(meta(st.file), 'utf8')) as { lufs: number | null }).lufs;
      lufs.set(st.file, typeof v === 'number' ? v : null);
      return false;
    } catch {
      return true;
    }
  });
  const started = new Set<string>();
  await pool(todo, cpuCount(), async (st) => {
    if (started.has(st.file)) return; // identical stems
    started.add(st.file);
    let log = '';
    await atomicOutput(st.file, async (tmp) => {
      log = await ffmpegStderr(sub(st.args, { '{out}': tmp }), o.signal ? { cwd: o.projectDir, signal: o.signal } : { cwd: o.projectDir });
    });
    const v = parseEbur128Integrated(log);
    lufs.set(st.file, v);
    writeFileSync(meta(st.file), JSON.stringify({ lufs: v }));
  }, o.signal);
  const list = stems.map((st) => concatLine(st.file)).join('\n') + '\n';
  const listFile = join(dir, `${createHash('sha256').update(list).digest('hex').slice(0, 16)}-voice.txt`);
  writeFileSync(listFile, list);
  const gain = previewGainFilter(stems.map((st) => ({ lufs: lufs.get(st.file) ?? null, durationSec: st.durationSec })), fast.target);
  const args = fast.args.map((a) => a.replaceAll(LOUDNORM_TOKEN, gain));
  const key = cacheKey(createHash('sha256').update(list).update('\0').update(gain).digest('hex'), args, o.projectDir, []);
  const out = join(dir, `mix-${key}.wav`);
  if (!existsSync(out)) await atomicOutput(out, (tmp) => o.run(sub(args, { '{voice}': listFile, '{out}': tmp })));
  return out;
}

/**
 * Render one frame from `compileFrame` to an image (format from the output extension, e.g. .png / .jpg).
 * Writes the plan's generated files first; ffmpeg runs with cwd = projectDir.
 */
export async function renderFrame(plan: FramePlan, o: { projectDir: string; output: string; signal?: AbortSignal; fontsDir?: string | false }): Promise<{ output: string }> {
  const fonts = o.fontsDir === false ? null : o.fontsDir ?? defaultFontsDir();
  const args = fonts ? withFontsDir(plan.args, fonts) : plan.args;
  const projectDir = resolve(o.projectDir);
  const output = resolve(projectDir, o.output);
  for (const w of plan.writes) {
    const abs = resolve(projectDir, w.path);
    if (existsSync(abs) && readFileSync(abs, 'utf8') === w.content) continue;
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, w.content);
  }
  for (const p of inputsOf(args)) {
    if (!existsSync(isAbsolute(p) ? p : resolve(projectDir, p))) throw new MediaError(`input not found: ${p}`);
  }
  await atomicOutput(output, (tmp) => runFfmpeg(sub(args, { '{out}': tmp }), o.signal ? { cwd: projectDir, signal: o.signal } : { cwd: projectDir }));
  return { output };
}
