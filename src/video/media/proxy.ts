import { existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';
import type { Rational } from '@video/core';
import { MediaError, runFfmpeg } from './run.js';

/** Temp path next to `out` keeping the extension (ffmpeg picks the muxer from it). */
export function tempPath(out: string): string {
  const ext = extname(out);
  return join(dirname(out), `.${basename(out, ext)}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}${ext}`);
}

/** Run ffmpeg into a temp file and move it into place only on success. */
export async function atomicOutput(out: string, run: (tmp: string) => Promise<void>): Promise<void> {
  mkdirSync(dirname(out), { recursive: true });
  const tmp = tempPath(out);
  try {
    await run(tmp);
    if (!existsSync(tmp) || statSync(tmp).size === 0) throw new MediaError(`ffmpeg produced no output for ${out}`);
    renameSync(tmp, out);
  } finally {
    try {
      rmSync(tmp, { force: true });
    } catch {
      // still locked by a process being killed (Windows); it is a dot-file and harmless
    }
  }
}

/**
 * Constant-frame-rate edit proxy (H.264, short closed GOP for fast seeking, AAC 48 kHz). Keeps audio when present.
 */
export async function makeCfrProxy(input: string, output: string, o: { fps: Rational; height?: number; gopSec?: number; crf?: number; signal?: AbortSignal }): Promise<void> {
  if (!(o.fps.num > 0 && o.fps.den > 0)) throw new RangeError('fps must be positive');
  if (o.height !== undefined && !(o.height >= 2)) throw new RangeError('height must be >= 2');
  const gop = Math.max(1, Math.round((o.fps.num / o.fps.den) * (o.gopSec ?? 1)));
  const vf = [`fps=${o.fps.num}/${o.fps.den}`];
  if (o.height) vf.push(`scale=-2:${Math.round(o.height / 2) * 2}`);
  vf.push('format=yuv420p');
  await atomicOutput(output, (tmp) => runFfmpeg([
    '-i', input, '-map', '0:v:0', '-map', '0:a:0?', '-vf', vf.join(','), '-fps_mode', 'cfr',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', String(o.crf ?? 18), '-g', String(gop), '-keyint_min', String(gop),
    '-sc_threshold', '0', '-flags', '+cgop', '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-movflags', '+faststart', tmp,
  ], o.signal ? { signal: o.signal } : {}));
}

/** One frame at `atSec` as an image (format from the output extension). */
export async function extractFrame(input: string, atSec: number, output: string, o: { width?: number } = {}): Promise<void> {
  if (!(atSec >= 0)) throw new RangeError('atSec must be >= 0');
  const args = ['-ss', String(atSec), '-i', input, '-frames:v', '1', '-an'];
  if (o.width) args.push('-vf', `scale=${Math.round(o.width / 2) * 2}:-2`);
  args.push('-update', '1');
  await atomicOutput(output, (tmp) => runFfmpeg([...args, tmp])).catch((e: unknown) => {
    if (e instanceof MediaError && /no output/.test(e.message)) throw new MediaError(`no frame at ${atSec}s in ${input} (past the end?)`);
    throw e;
  });
}
