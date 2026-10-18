import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { availableParallelism, cpus } from 'node:os';
import { dirname, join } from 'node:path';
import { videoHome } from '@video/toolchain';
import { runTool, toolPath } from './run.js';

export type HwEncoder = 'h264_videotoolbox' | 'h264_nvenc' | 'h264_qsv' | 'h264_amf';

const CANDIDATES: Partial<Record<NodeJS.Platform, HwEncoder[]>> = {
  darwin: ['h264_videotoolbox'],
  win32: ['h264_nvenc', 'h264_qsv', 'h264_amf'],
  linux: ['h264_nvenc', 'h264_qsv'],
};

const memo = new Map<string, HwEncoder | null>();

function cacheFile(): string {
  return join(videoHome(), 'cache', 'hwenc.json');
}

/** Parse `ffmpeg -encoders` output into the set of encoder names. */
export function parseEncoders(text: string): Set<string> {
  const out = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*[VAS.][F.][S.][X.][B.][D.]\s+([A-Za-z0-9_][\w.-]*)\s/.exec(line); // skips the legend ("V..... = Video")
    if (m) out.add(m[1]!);
  }
  return out;
}

/**
 * The hardware H.264 encoder to use for previews, or null: env FERRET_VIDEO_HWENC ('off' or an encoder name) wins;
 * otherwise each platform candidate listed by `ffmpeg -encoders` is tried with a 1-frame encode (drivers can be
 * missing even when the encoder is compiled in). The result is cached per ffmpeg binary (memory and
 * ~/.ferret/video/cache/hwenc.json).
 */
export async function detectHwEncoder(o: { refresh?: boolean; platform?: NodeJS.Platform } = {}): Promise<HwEncoder | null> {
  const env = process.env.FERRET_VIDEO_HWENC?.trim();
  if (env === 'off' || env === 'none') return null;
  const bin = await toolPath('ffmpeg');
  if (env) return env as HwEncoder;
  let key = bin;
  try {
    key = `${bin}@${statSync(bin).mtimeMs}`;
  } catch {
    // PATH lookup name: keep the name
  }
  if (!o.refresh && memo.has(key)) return memo.get(key)!;
  const file = cacheFile();
  let disk: Record<string, HwEncoder | null> = {};
  try {
    disk = JSON.parse(readFileSync(file, 'utf8')) as Record<string, HwEncoder | null>;
  } catch {
    disk = {};
  }
  if (!o.refresh && key in disk) {
    memo.set(key, disk[key]!);
    return disk[key]!;
  }
  let found: HwEncoder | null = null;
  const chunks: Buffer[] = [];
  try {
    await runTool('ffmpeg', bin, ['-hide_banner', '-encoders'], { onStdout: (c) => chunks.push(c) });
  } catch {
    // treat as none
  }
  const listed = parseEncoders(Buffer.concat(chunks).toString('utf8'));
  for (const enc of CANDIDATES[o.platform ?? process.platform] ?? []) {
    if (!listed.has(enc)) continue;
    try {
      await runTool('ffmpeg', bin, ['-hide_banner', '-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'color=black:s=320x240:r=30:d=0.2',
        '-frames:v', '1', ...hwEncodeArgs(enc), '-f', 'null', '-']);
      found = enc;
      break;
    } catch {
      // listed but unusable (no GPU / driver): try the next
    }
  }
  memo.set(key, found);
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ ...disk, [key]: found }, null, 2));
  } catch {
    // cache is optional
  }
  return found;
}

/** Forget cached detection (tests). */
export function resetHwEncoderCache(): void {
  memo.clear();
}

/** Encoder arguments for preview quality on a hardware encoder. */
export function hwEncodeArgs(enc: HwEncoder): string[] {
  switch (enc) {
    case 'h264_videotoolbox':
      return ['-c:v', 'h264_videotoolbox', '-b:v', '4000k', '-maxrate', '6000k', '-profile:v', 'high', '-pix_fmt', 'yuv420p', '-allow_sw', '1'];
    case 'h264_nvenc':
      return ['-c:v', 'h264_nvenc', '-preset', 'p4', '-rc', 'vbr', '-cq', '28', '-b:v', '0', '-profile:v', 'high', '-pix_fmt', 'yuv420p'];
    case 'h264_qsv':
      return ['-c:v', 'h264_qsv', '-global_quality', '28', '-look_ahead', '0', '-pix_fmt', 'nv12'];
    case 'h264_amf':
      return ['-c:v', 'h264_amf', '-quality', 'speed', '-rc', 'cqp', '-qp_i', '24', '-qp_p', '28', '-pix_fmt', 'nv12'];
  }
}

/**
 * Swap the x264 settings of a compiled chunk for a hardware encoder: everything from `-c:v` up to `-g` is replaced,
 * B-frames are turned off (not every hardware encoder supports them). Args without x264 are returned unchanged.
 */
export function withEncoder(args: string[], enc: HwEncoder): string[] {
  const c = args.indexOf('-c:v');
  if (c < 0 || args[c + 1] !== 'libx264') return args;
  const g = args.indexOf('-g', c);
  const end = g < 0 ? args.indexOf('-an', c) : g;
  if (end < 0) return args;
  const out = [...args.slice(0, c), ...hwEncodeArgs(enc), ...args.slice(end)];
  const bf = out.indexOf('-bf');
  if (bf >= 0) out[bf + 1] = '0';
  const sc = out.indexOf('-sc_threshold');
  if (sc >= 0) out.splice(sc, 2);
  return out;
}

export function cpuCount(): number {
  try {
    return availableParallelism();
  } catch {
    return cpus().length || 1;
  }
}

/**
 * Default chunk parallelism and x264 threads per chunk: about a third of the cores run chunks in parallel (each
 * chunk also decodes and filters), the rest is shared as encoder threads. Hardware encoders: at most 4 sessions (consumer NVENC allows 5–8).
 */
export function renderConcurrency(o: { hardware: boolean; cpus?: number }): { chunks: number; threads: number } {
  const n = Math.max(1, o.cpus ?? cpuCount());
  const chunks = o.hardware ? Math.max(1, Math.min(4, Math.floor(n / 3))) : Math.max(1, Math.min(6, Math.floor(n / 3)));
  return { chunks, threads: Math.max(1, Math.ceil(n / chunks)) };
}

