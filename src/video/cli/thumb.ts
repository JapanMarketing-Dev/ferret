import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { extname, join } from 'node:path';
import { assDialogue, assEscape, assHeader, assStyleLine, assTagColor } from '@video/core';
import { resolveWindowsCmdShim, type WindowsFs } from '@video/toolchain/windowsCmdShim';
import { whichSync } from '@video/toolchain';

// Thumbnails (docs/10): candidate frames by simple image heuristics, base images from an image-generation provider,
// and the Japanese title typeset by Ferret itself (SVG layer, or the same layout as ASS when ffmpeg has no SVG decoder).

// ---------- candidate scoring ----------

export interface FrameScore { sharpness: number; exposure: number; contrast: number; score: number }

/** Heuristic quality of a grayscale frame (w×h, 8-bit): mean |Laplacian| for sharpness, mid-tone mean, spread. */
export function scoreGray(px: Uint8Array, w: number, h: number): FrameScore {
  if (px.length < w * h || w < 3 || h < 3) throw new RangeError('frame buffer too small');
  let sum = 0;
  let sum2 = 0;
  for (let i = 0; i < w * h; i++) {
    sum += px[i]!;
    sum2 += px[i]! * px[i]!;
  }
  const n = w * h;
  const mean = sum / n;
  const std = Math.sqrt(Math.max(0, sum2 / n - mean * mean));
  let lap = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      lap += Math.abs(4 * px[i]! - px[i - 1]! - px[i + 1]! - px[i - w]! - px[i + w]!);
    }
  }
  const sharpRaw = lap / ((w - 2) * (h - 2));
  const sharpness = Math.min(1, sharpRaw / 40);
  const exposure = Math.max(0, 1 - Math.abs(mean - 120) / 120);
  const contrast = Math.min(1, std / 64);
  const score = Math.round((0.55 * sharpness + 0.25 * exposure + 0.2 * contrast) * 1000) / 1000;
  return { sharpness: round3(sharpness), exposure: round3(exposure), contrast: round3(contrast), score };
}

const round3 = (n: number) => Math.round(n * 1000) / 1000;

/** Best `n` samples, at least `minGap` frames apart. */
export function pickCandidates<T extends { frame: number; score: number }>(samples: T[], n: number, minGap: number): T[] {
  const out: T[] = [];
  for (const s of [...samples].sort((a, b) => b.score - a.score || a.frame - b.frame)) {
    if (out.length >= n) break;
    if (out.every((o) => Math.abs(o.frame - s.frame) >= minGap)) out.push(s);
  }
  return out;
}

// ---------- title typesetting ----------

export type ThumbFormat = 'youtube' | 'shorts';
export const THUMB_SIZES: Record<ThumbFormat, { width: number; height: number }> = {
  youtube: { width: 1280, height: 720 },
  shorts: { width: 1080, height: 1920 },
};

export interface TitleStyle { font: string; color: string; accent: string; stroke: string; band: string }
export const DEFAULT_TITLE_STYLE: TitleStyle = { font: 'Noto Sans JP', color: '#FFFFFF', accent: '#FFE600', stroke: '#000000', band: '#000000A0' };

export interface TitleLayout { lines: string[]; fontSize: number; x: number; y: number; lineHeight: number; band: { x: number; y: number; w: number; h: number }; anchor: 'start' | 'middle' }

const visualLen = (s: string) => [...s].reduce((a, c) => a + (/[\x20-\x7e]/.test(c) ? 0.55 : 1), 0);

/**
 * Lay out title lines: YouTube = bottom-left block, Shorts = centered block in the upper third (clear of the UI).
 * The font size shrinks so the longest line fits ~62 % (YouTube) / 86 % (Shorts) of the width.
 */
export function layoutTitle(lines: string[], format: ThumbFormat): TitleLayout {
  const { width: W, height: H } = THUMB_SIZES[format];
  const clean = lines.map((l) => l.trim()).filter(Boolean).slice(0, 3);
  const longest = Math.max(1, ...clean.map(visualLen));
  const maxW = format === 'youtube' ? W * 0.62 : W * 0.86;
  const fontSize = Math.round(Math.min(format === 'youtube' ? H * 0.17 : W * 0.13, maxW / longest));
  const lineHeight = Math.round(fontSize * 1.18);
  const pad = Math.round(fontSize * 0.35);
  const blockH = lineHeight * clean.length;
  const blockW = Math.round(longest * fontSize);
  if (format === 'youtube') {
    const x = Math.round(W * 0.05);
    const y = Math.round(H - H * 0.07 - blockH);
    return { lines: clean, fontSize, x, y, lineHeight, anchor: 'start', band: { x: x - pad, y: y - pad, w: blockW + 2 * pad, h: blockH + 2 * pad } };
  }
  const x = Math.round(W / 2);
  const y = Math.round(H * 0.16);
  return { lines: clean, fontSize, x, y, lineHeight, anchor: 'middle', band: { x: Math.round(x - blockW / 2 - pad), y: y - pad, w: blockW + 2 * pad, h: blockH + 2 * pad } };
}

const xmlEscape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function svgColor(hex: string): { color: string; opacity: number } {
  const m = /^#?([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(hex);
  if (!m) throw new Error(`invalid color: ${hex}`);
  return { color: `#${m[1]}`, opacity: m[2] ? Math.round((parseInt(m[2], 16) / 255) * 100) / 100 : 1 };
}

/** The title as its own SVG layer (transparent background). First line in the accent color. */
export function titleSvg(layout: TitleLayout, format: ThumbFormat, style: TitleStyle = DEFAULT_TITLE_STYLE): string {
  const { width: W, height: H } = THUMB_SIZES[format];
  const band = svgColor(style.band);
  const strokeW = Math.max(2, Math.round(layout.fontSize * 0.12));
  const texts = layout.lines.map((line, i) => {
    const fill = i === 0 ? style.accent : style.color;
    const y = layout.y + layout.lineHeight * i + Math.round(layout.fontSize * 0.88);
    return `<text x="${layout.x}" y="${y}" text-anchor="${layout.anchor}" font-family="${xmlEscape(style.font)}, sans-serif" font-weight="900" font-size="${layout.fontSize}" fill="${fill}" stroke="${style.stroke}" stroke-width="${strokeW}" stroke-linejoin="round" paint-order="stroke">${xmlEscape(line)}</text>`;
  });
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`,
    `<rect x="${layout.band.x}" y="${layout.band.y}" width="${layout.band.w}" height="${layout.band.h}" rx="${Math.round(layout.fontSize * 0.15)}" fill="${band.color}" fill-opacity="${band.opacity}"/>`,
    ...texts,
    '</svg>',
    '',
  ].join('\n');
}

/** The same layout as ASS (libass), for ffmpeg builds without an SVG decoder. */
export function titleAss(layout: TitleLayout, format: ThumbFormat, style: TitleStyle = DEFAULT_TITLE_STYLE): string {
  const size = THUMB_SIZES[format];
  const fps = { num: 1, den: 1 };
  const strokeW = Math.max(2, layout.fontSize * 0.12);
  const header = assHeader(size, [
    assStyleLine({ name: 'Band', font: style.font, size: 10, primary: style.band, outline: '#00000000', outlineWidth: 0, alignment: 7 }),
    assStyleLine({ name: 'Title', font: style.font, size: layout.fontSize, primary: style.color, outline: style.stroke, bold: true, outlineWidth: strokeW, shadow: 0, alignment: 7 }),
  ]);
  const b = layout.band;
  const events = [assDialogue(0, 0, 3600, fps, 'Band', `{\\pos(0,0)\\p1}m ${b.x} ${b.y} l ${b.x + b.w} ${b.y} ${b.x + b.w} ${b.y + b.h} ${b.x} ${b.y + b.h}{\\p0}`)];
  layout.lines.forEach((line, i) => {
    const y = layout.y + layout.lineHeight * i;
    const color = i === 0 ? `\\1c${assTagColor(style.accent)}` : '';
    const an = layout.anchor === 'middle' ? 8 : 7;
    events.push(assDialogue(1, 0, 3600, fps, 'Title', `{\\an${an}\\pos(${layout.x},${y})${color}}${assEscape(line)}`));
  });
  return `${header}\n${events.join('\n')}\n`;
}

// ---------- image generation providers ----------

/**
 * 'codex': Codex CLI on the user's ChatGPT subscription; 'frame': no generation (the frame itself). Paid image APIs
 * (API keys) are never called (SPEC: image generation happens inside the subscriptions).
 */
export type ThumbProvider = 'codex' | 'frame';

export interface GenRequest { frame: string; prompt: string; n: number; format: ThumbFormat; outDir: string; /** Style references (e.g. a past thumbnail). */ references?: string[] }
export interface GenContext {
  env: NodeJS.ProcessEnv;
  /** Runs a command (tests inject a fake). `input` is written to stdin. */
  run?: RunFn;
  model?: string;
}

export class ThumbError extends Error {
  constructor(public readonly provider: ThumbProvider, message: string) {
    super(`${provider}: ${message}`);
    this.name = 'ThumbError';
  }
}

export type RunFn = (cmd: string, args: string[], o: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number; input?: string }) => Promise<{ code: number | null; stdout: string; stderr: string }>;

/**
 * How to start an agent CLI without a shell: resolved on PATH; on Windows npm / pnpm install .cmd shims, which are read
 * and run as `node <script>` (or the .exe they wrap). Null for a .cmd / .bat that is not such a shim.
 */
export function agentSpawn(cmd: string, args: string[], env: NodeJS.ProcessEnv, platform: string = process.platform, fs?: WindowsFs): { file: string; args: string[]; env: NodeJS.ProcessEnv } | null {
  const file = whichSync(cmd, env, platform) ?? cmd;
  if (platform !== 'win32' || !/\.(cmd|bat)$/i.test(file)) return { file, args, env };
  const shim = resolveWindowsCmdShim(file, env, fs);
  return shim ? { file: shim.program, args: [...shim.prefixArgs, ...args], env: shim.env ?? env } : null;
}

/** Run an agent CLI (see agentSpawn); long prompts go on stdin so no shell ever sees them. */
export const defaultRun: RunFn = (cmd, args, o) => {
  const sp = agentSpawn(cmd, args, o.env);
  if (!sp) return Promise.resolve({ code: null, stdout: '', stderr: `${cmd}: not an npm / pnpm .cmd shim; cannot start it without a shell` });
  return new Promise((res) => {
    const c = spawn(sp.file, sp.args, { cwd: o.cwd, env: sp.env, stdio: [o.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'], windowsHide: true });
    if (o.input !== undefined) {
      c.stdin!.on('error', () => undefined);
      c.stdin!.end(o.input);
    }
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => c.kill(), o.timeoutMs);
    c.stdout!.on('data', (d) => (stdout += String(d)));
    c.stderr!.on('data', (d) => (stderr += String(d)));
    c.on('error', (e) => {
      clearTimeout(timer);
      res({ code: null, stdout, stderr: stderr + e.message });
    });
    c.on('close', (code) => {
      clearTimeout(timer);
      res({ code, stdout, stderr });
    });
  });
};

const IMG = /\.(png|jpe?g|webp)$/i;

function newestImages(dir: string, since: number): string[] {
  if (!existsSync(dir)) return [];
  const out: { p: string; m: number }[] = [];
  const walk = (d: string, depth: number) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory() && depth < 3) walk(p, depth + 1);
      else if (e.isFile() && IMG.test(e.name)) {
        // Windows keeps a copied file's write time; its creation time is new
        const st = statSync(p);
        const m = Math.max(st.mtimeMs, st.birthtimeMs || 0);
        if (m >= since) out.push({ p, m });
      }
    }
  };
  walk(dir, 0);
  return out.sort((a, b) => b.m - a.m).map((x) => x.p);
}

/** Codex: `codex exec -i <frame> '$imagegen …'` per image; images are picked up from $CODEX_HOME/generated_images. */
export async function generateCodex(req: GenRequest, ctx: GenContext): Promise<string[]> {
  const run = ctx.run ?? defaultRun;
  const home = ctx.env.CODEX_HOME ?? join(ctx.env.HOME ?? homedir(), '.codex');
  const imagesDir = join(home, 'generated_images');
  const aspect = req.format === 'youtube' ? '16:9 (1536x1024)' : '9:16 (1024x1536)';
  const out: string[] = [];
  for (let i = 0; i < req.n; i++) {
    const since = Date.now() - 1000;
    const prompt = `$imagegen ${req.prompt}\nAspect ratio ${aspect}. Use the attached frame as the reference for the person; keep their face unchanged. Do not draw any text or letters.`;
    // prompt on stdin ("-") and before the images: -i takes several values and would swallow a trailing prompt
    const r = await run('codex', ['exec', '--skip-git-repo-check', '-', '-i', req.frame, ...(req.references ?? []).flatMap((x) => ['-i', x])], { cwd: req.outDir, env: ctx.env, timeoutMs: 10 * 60_000, input: prompt });
    if (r.code !== 0) {
      const msg = `${r.stderr}\n${r.stdout}`.trim().split('\n').slice(-2).join(' ');
      throw new ThumbError('codex', /429|usage limit|rate limit/i.test(msg) ? `rate limited: ${msg}` : `codex exec failed (${r.code}): ${msg}`);
    }
    const found = newestImages(imagesDir, since).filter((p) => !out.includes(p))[0];
    if (!found) throw new ThumbError('codex', `no image appeared in ${imagesDir}`);
    const dest = join(req.outDir, `codex-${Date.now()}-${i}${extname(found)}`);
    copyFileSync(found, dest);
    out.push(dest);
  }
  return out;
}

export const PROVIDERS: Record<Exclude<ThumbProvider, 'frame'>, (req: GenRequest, ctx: GenContext) => Promise<string[]>> = {
  codex: generateCodex,
};

/** Try providers in order; the first one that returns images wins. 'frame' (no generation) always succeeds. */
export async function generateBases(order: ThumbProvider[], req: GenRequest, ctx: GenContext): Promise<{ provider: ThumbProvider; images: string[]; errors: string[] }> {
  const errors: string[] = [];
  for (const p of order) {
    if (p === 'frame') return { provider: 'frame', images: Array.from({ length: req.n }, () => req.frame), errors };
    const gen = PROVIDERS[p];
    if (!gen) {
      errors.push(`${p}: unknown provider`);
      continue;
    }
    try {
      const images = await gen(req, ctx);
      if (images.length) return { provider: p, images: images.slice(0, req.n), errors };
      errors.push(`${p}: no images`);
    } catch (e) {
      errors.push((e as Error).message);
    }
  }
  return { provider: 'frame', images: Array.from({ length: req.n }, () => req.frame), errors };
}
