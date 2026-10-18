import { spawn } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { delimiter, join } from 'node:path';

export class MediaError extends Error {
  constructor(message: string, public readonly detail?: string) {
    super(message);
    this.name = 'MediaError';
  }
}

export class FfmpegError extends MediaError {
  constructor(public readonly tool: string, public readonly code: number | null, public readonly stderrTail: string, args: string[]) {
    super(`${tool} failed (exit ${code ?? 'signal'}): ${lastLines(stderrTail, 4)}`, `args: ${args.join(' ')}\n${stderrTail}`);
    this.name = 'FfmpegError';
  }
}

function lastLines(s: string, n: number): string {
  return s.trim().split(/\r?\n/).slice(-n).join(' | ');
}

type Tool = 'ffmpeg' | 'ffprobe';
const ENV: Record<Tool, string> = { ffmpeg: 'FERRET_VIDEO_FFMPEG', ffprobe: 'FERRET_VIDEO_FFPROBE' };
const cache = new Map<Tool, string>();

function onPath(cmd: string): string | null {
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', ''] : [''];
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const p = join(dir, cmd + ext);
      try {
        if (existsSync(p) && statSync(p).isFile()) return p;
      } catch {
        // unreadable PATH entry
      }
    }
  }
  return null;
}

/** Resolve ffmpeg/ffprobe: env FERRET_VIDEO_FFMPEG/FERRET_VIDEO_FFPROBE → @video/toolchain resolveTool → PATH. */
export async function toolPath(tool: Tool): Promise<string> {
  const env = process.env[ENV[tool]];
  if (env) return env;
  const hit = cache.get(tool);
  if (hit) return hit;
  let p: string | null = null;
  try {
    const tc = await import('@video/toolchain');
    p = await tc.resolveTool(tool);
  } catch {
    p = null;
  }
  p ??= onPath(tool);
  if (!p) throw new MediaError(`${tool} not found. Run \`ferret-video doctor\` to install it, or set ${ENV[tool]}.`);
  cache.set(tool, p);
  return p;
}

/** Forget cached tool paths (tests). */
export function resetToolCache(): void {
  cache.clear();
}

export interface RunOptions {
  cwd?: string;
  signal?: AbortSignal;
  /** Called with each stdout chunk. */
  onStdout?: (chunk: Buffer) => void;
  /** Keep the whole stderr (analysis filters log there). Otherwise only the tail is kept. */
  captureStderr?: boolean;
}

const TAIL = 16 * 1024;

/** Spawn a tool; resolves with stderr text (full when captureStderr, else the tail). */
export function runTool(tool: Tool, bin: string, args: string[], o: RunOptions = {}): Promise<{ stderr: string }> {
  return new Promise((resolve, reject) => {
    if (o.signal?.aborted) {
      reject(abortError());
      return;
    }
    const child = spawn(bin, args, { cwd: o.cwd, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (d: string) => {
      stderr += d;
      if (!o.captureStderr && stderr.length > TAIL * 2) stderr = stderr.slice(-TAIL);
    });
    child.stdout.on('data', (d: Buffer) => o.onStdout?.(d));
    let settled = false;
    const onAbort = () => {
      killTree(child.pid, () => child.kill('SIGKILL'));
      // Settle right away: on Windows the process may take a moment to go after taskkill.
      settled = true;
      reject(abortError());
    };
    o.signal?.addEventListener('abort', onAbort, { once: true });
    child.on('error', (e) => {
      o.signal?.removeEventListener('abort', onAbort);
      if (!settled) reject(new MediaError(`could not start ${tool} (${bin}): ${e.message}`));
    });
    child.on('close', (code) => {
      o.signal?.removeEventListener('abort', onAbort);
      if (settled) return;
      if (o.signal?.aborted) reject(abortError());
      else if (code === 0) resolve({ stderr });
      else reject(new FfmpegError(tool, code, stderr.slice(-TAIL), args));
    });
  });
}

/**
 * Kill a process and its children. On Windows a signal does not stop ffmpeg (or its children), so use
 * `taskkill /T /F`; elsewhere SIGKILL. `fallback` runs if taskkill cannot be started.
 */
export function killTree(pid: number | undefined, fallback: () => void, platform: NodeJS.Platform = process.platform): void {
  if (pid === undefined) return fallback();
  if (platform === 'win32') {
    const k = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    k.on('error', fallback);
    k.on('exit', (code) => { if (code !== 0) fallback(); });
    return;
  }
  fallback();
}

function abortError(): Error {
  const e = new Error('aborted');
  e.name = 'AbortError';
  return e;
}

export const FFMPEG_GLOBAL = ['-hide_banner', '-nostdin', '-y'];

/**
 * Run ffmpeg with `args` (global flags and `-progress pipe:1` are added). `onProgress` receives the output time in
 * seconds as ffmpeg reports it.
 */
export async function runFfmpeg(args: string[], o: { cwd?: string; onProgress?: (sec: number) => void; signal?: AbortSignal } = {}): Promise<void> {
  const bin = await toolPath('ffmpeg');
  let buf = '';
  const opts: RunOptions = {
    onStdout: (chunk) => {
      buf += chunk.toString('utf8');
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        const sec = parseProgressLine(line);
        if (sec !== null) o.onProgress?.(sec);
      }
    },
  };
  if (o.cwd) opts.cwd = o.cwd;
  if (o.signal) opts.signal = o.signal;
  await runTool('ffmpeg', bin, [...FFMPEG_GLOBAL, '-progress', 'pipe:1', '-nostats', ...args], opts);
}

/** Parse one `-progress` line; returns seconds for out_time_us / out_time_ms / out_time, else null. */
export function parseProgressLine(line: string): number | null {
  const eq = line.indexOf('=');
  if (eq < 0) return null;
  const k = line.slice(0, eq);
  const v = line.slice(eq + 1).trim();
  if (k === 'out_time_us' || k === 'out_time_ms') {
    // Both are microseconds in practice (out_time_ms is misnamed in ffmpeg).
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? n / 1e6 : null;
  }
  if (k === 'out_time') {
    const m = /^(-)?(\d+):(\d{2}):(\d{2}(?:\.\d+)?)$/.exec(v);
    if (!m || m[1]) return null;
    return Number(m[2]) * 3600 + Number(m[3]) * 60 + Number(m[4]);
  }
  return null;
}

/** Run ffmpeg for analysis and return the full stderr (info level). */
export async function ffmpegStderr(args: string[], o: { cwd?: string; signal?: AbortSignal } = {}): Promise<string> {
  const bin = await toolPath('ffmpeg');
  const opts: RunOptions = { captureStderr: true };
  if (o.cwd) opts.cwd = o.cwd;
  if (o.signal) opts.signal = o.signal;
  const r = await runTool('ffmpeg', bin, [...FFMPEG_GLOBAL, '-nostats', ...args], opts);
  return r.stderr;
}

/** Run ffmpeg and collect stdout as one buffer. */
export async function ffmpegStdout(args: string[], o: { cwd?: string; signal?: AbortSignal } = {}): Promise<Buffer> {
  const bin = await toolPath('ffmpeg');
  const chunks: Buffer[] = [];
  const opts: RunOptions = { onStdout: (c) => chunks.push(c) };
  if (o.cwd) opts.cwd = o.cwd;
  if (o.signal) opts.signal = o.signal;
  await runTool('ffmpeg', bin, [...FFMPEG_GLOBAL, '-nostats', '-v', 'error', ...args], opts);
  return Buffer.concat(chunks);
}

export async function ffprobeJson(args: string[]): Promise<unknown> {
  const bin = await toolPath('ffprobe');
  const chunks: Buffer[] = [];
  await runTool('ffprobe', bin, ['-v', 'error', '-print_format', 'json', ...args], { onStdout: (c) => chunks.push(c) });
  const text = Buffer.concat(chunks).toString('utf8');
  try {
    return JSON.parse(text);
  } catch {
    throw new MediaError('ffprobe returned invalid JSON', text.slice(0, 500));
  }
}
