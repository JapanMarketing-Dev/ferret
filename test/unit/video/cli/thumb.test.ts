import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { WindowsFs } from '@video/toolchain/windowsCmdShim';
import {
  PROVIDERS, THUMB_SIZES, ThumbError, agentSpawn, generateBases, generateCodex, layoutTitle, pickCandidates, scoreGray,
  titleAss, titleSvg, type GenRequest,
} from '@video/cli/thumb.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ferret-video-thumb-'));
  writeFileSync(join(dir, 'frame.png'), Buffer.alloc(200, 7));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const req = (o: Partial<GenRequest> = {}): GenRequest => ({ frame: join(dir, 'frame.png'), prompt: 'a thumbnail', n: 2, format: 'youtube', outDir: dir, ...o });

function gray(w: number, h: number, f: (x: number, y: number) => number): Uint8Array {
  const a = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) a[y * w + x] = Math.max(0, Math.min(255, Math.round(f(x, y))));
  return a;
}

describe('scoreGray', () => {
  it('prefers sharp, well-exposed frames over flat, dark or blurry ones', () => {
    const sharp = scoreGray(gray(64, 36, (x, y) => ((x >> 2) + (y >> 2)) % 2 ? 200 : 60), 64, 36);
    const blurry = scoreGray(gray(64, 36, (x) => 60 + (140 * x) / 63), 64, 36);
    const dark = scoreGray(gray(64, 36, () => 5), 64, 36);
    expect(sharp.score).toBeGreaterThan(blurry.score);
    expect(blurry.score).toBeGreaterThan(dark.score);
    expect(dark.sharpness).toBe(0);
    for (const s of [sharp, blurry, dark]) for (const v of Object.values(s)) expect(v).toBeGreaterThanOrEqual(0);
  });
  it('rejects tiny or short buffers', () => {
    expect(() => scoreGray(new Uint8Array(4), 2, 2)).toThrow();
    expect(() => scoreGray(new Uint8Array(10), 4, 4)).toThrow();
  });
});

describe('pickCandidates', () => {
  it('takes the best ones at least minGap apart', () => {
    const s = [{ frame: 0, score: 0.9 }, { frame: 10, score: 0.95 }, { frame: 100, score: 0.5 }, { frame: 200, score: 0.8 }];
    expect(pickCandidates(s, 3, 50).map((x) => x.frame)).toEqual([10, 200, 100]);
    expect(pickCandidates(s, 10, 0)).toHaveLength(4);
    expect(pickCandidates([], 3, 10)).toEqual([]);
  });
});

describe('title layout', () => {
  it.each(['youtube', 'shorts'] as const)('%s: the text block and band stay inside the canvas', (fmt) => {
    for (const lines of [['設定は3つだけ'], ['Claude Code', '設定のコツ'], ['とても長いタイトルの一行目になる文章です', '二行目', '三行目'], ['a', 'b', 'c', 'd']]) {
      const l = layoutTitle(lines, fmt);
      const { width: W, height: H } = THUMB_SIZES[fmt];
      expect(l.lines.length).toBeLessThanOrEqual(3);
      expect(l.band.x).toBeGreaterThanOrEqual(0);
      expect(l.band.y).toBeGreaterThanOrEqual(0);
      expect(l.band.x + l.band.w).toBeLessThanOrEqual(W);
      expect(l.band.y + l.band.h).toBeLessThanOrEqual(H);
      expect(l.fontSize).toBeGreaterThan(20);
    }
  });

  it('youtube is bottom-left, shorts is centered in the upper third', () => {
    const y = layoutTitle(['見出し'], 'youtube');
    expect(y.anchor).toBe('start');
    expect(y.y).toBeGreaterThan(360);
    const s = layoutTitle(['見出し'], 'shorts');
    expect(s.anchor).toBe('middle');
    expect(s.y).toBeLessThan(1920 / 3);
  });

  it('SVG escapes text and puts the accent on the first line', () => {
    const svg = titleSvg(layoutTitle(['<A&B>', '二行目'], 'youtube'), 'youtube');
    expect(svg).toContain('&lt;A&amp;B&gt;');
    expect(svg).not.toContain('<A&B>');
    expect(svg).toMatch(/fill="#FFE600"[^>]*>&lt;A/);
    expect(svg).toContain('width="1280" height="720"');
    expect(svg).toContain('paint-order="stroke"');
  });

  it('ASS has the band drawing, both lines and escapes braces', () => {
    const ass = titleAss(layoutTitle(['{x}', '二行目'], 'shorts'), 'shorts');
    expect(ass).toContain('PlayResX: 1080');
    expect(ass).toMatch(/\\p1\}m \d+ \d+ l/);
    expect(ass).toContain('\\{x\\}');
    expect(ass).toContain('二行目');
    expect(ass).toContain('\\1c&H00E6FF&');
  });
});

describe('providers', () => {
  it('only subscription-based generation exists: no API-key providers (openai / gemini)', () => {
    expect(Object.keys(PROVIDERS)).toEqual(['codex']);
  });

  it('codex: runs codex exec with the frame and picks up new files from $CODEX_HOME/generated_images', async () => {
    const home = join(dir, 'codexhome');
    const imgs = join(home, 'generated_images', 'session');
    mkdirSync(imgs, { recursive: true });
    const old = join(imgs, 'old.png');
    writeFileSync(old, 'old');
    utimesSync(old, new Date(2020, 0, 1), new Date(2020, 0, 1));
    const calls: string[][] = [];
    let k = 0;
    const inputs: string[] = [];
    const run = async (cmd: string, args: string[], o: { input?: string }) => {
      calls.push([cmd, ...args]);
      inputs.push(o.input ?? '');
      writeFileSync(join(imgs, `gen-${k++}.png`), `img${k}`);
      return { code: 0, stdout: '', stderr: '' };
    };
    const out = await generateCodex(req(), { env: { CODEX_HOME: home }, run });
    expect(out).toHaveLength(2);
    expect(readFileSync(out[0]!, 'utf8')).toBe('img1');
    expect(readFileSync(out[1]!, 'utf8')).toBe('img2');
    expect(calls[0]).toEqual(['codex', 'exec', '--skip-git-repo-check', '-', '-i', join(dir, 'frame.png')]);
    expect(inputs[0]).toMatch(/^\$imagegen /);
    expect(inputs[0]).toContain('Do not draw any text');
  });

  it('codex: failure, rate limit and no new image', async () => {
    const home = join(dir, 'h');
    const fail = async () => ({ code: 1, stdout: '', stderr: 'ERROR: 429 Too Many Requests' });
    await expect(generateCodex(req(), { env: { CODEX_HOME: home }, run: fail })).rejects.toThrow(/rate limited/);
    const nothing = async () => ({ code: 0, stdout: 'done', stderr: '' });
    await expect(generateCodex(req(), { env: { CODEX_HOME: home }, run: nothing })).rejects.toThrow(/no image appeared/);
  });

  it('generateBases fails over in order and falls back to the frame', async () => {
    const fail = async () => ({ code: 1, stdout: '', stderr: 'boom' });
    const r = await generateBases(['codex'], req(), { env: { CODEX_HOME: join(dir, 'h') }, run: fail });
    expect(r.provider).toBe('frame');
    expect(r.images).toEqual([join(dir, 'frame.png'), join(dir, 'frame.png')]);
    expect(r.errors).toHaveLength(1);
    // an old settings value naming an API provider is reported, never called
    const r2 = await generateBases(['openai' as never, 'gemini' as never], req(), { env: { OPENAI_API_KEY: 'k', GEMINI_API_KEY: 'g' } });
    expect(r2.provider).toBe('frame');
    expect(r2.errors).toEqual(['openai: unknown provider', 'gemini: unknown provider']);
    expect((await generateBases(['frame'], req(), { env: {} })).errors).toEqual([]);
    expect(new ThumbError('codex', 'x').message).toBe('codex: x');
  });
});

describe('ffPath (filter option paths, Windows-safe)', () => {
  it('relative with "/" when possible, else quoted with the colon escaped', async () => {
    const { ffPath } = await import('@video/cli/commands/thumb.js');
    const root = join(tmpdir(), 'ffp');
    expect(ffPath(join(root, 'fonts'), join(root, 'p', 'renders'))).toBe('../../fonts');
    expect(ffPath(join(root, 'p', 'f'), join(root, 'p'))).toBe('f');
    expect(ffPath(join(root, 'a:b', 'fonts'), root)).toMatch(/^'.*a\\:b\/fonts'$/);
    expect(ffPath(join(root, "it's"), root)).toMatch(/^'.*it'\\''s'$/);
  });
});

describe('agentSpawn', () => {
  const fakeFs = (files: Record<string, string>): WindowsFs => {
    const table = new Map(Object.entries(files).map(([p, body]) => [p.toLowerCase(), body]));
    return { fileSize: (p) => (table.has(p.toLowerCase()) ? table.get(p.toLowerCase())!.length || 1 : null), readText: (p) => table.get(p.toLowerCase()) ?? null };
  };
  const npm = 'C:\\Users\\me\\AppData\\Roaming\\npm';
  const shim = [
    '@ECHO off', 'GOTO start', ':find_dp0', 'SET dp0=%~dp0', 'EXIT /b', ':start', 'SETLOCAL', 'CALL :find_dp0', '',
    'IF EXIST "%dp0%\\node.exe" (', '  SET "_prog=%dp0%\\node.exe"', ') ELSE (', '  SET "_prog=node"', '  SET PATHEXT=%PATHEXT:;.JS;=;%', ')', '',
    'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*', '',
  ].join('\r\n');
  const env = { Path: `${npm};C:\\Program Files\\nodejs`, PATHEXT: '.COM;.EXE;.BAT;.CMD' };

  it('leaves non-Windows and .exe programs as they are', () => {
    expect(agentSpawn('codex', ['exec', '-'], { PATH: join(dir, 'none') }, 'darwin')).toEqual({ file: 'codex', args: ['exec', '-'], env: { PATH: join(dir, 'none') } });
    expect(agentSpawn('C:\\x\\claude.exe', ['-p'], env, 'win32', fakeFs({}))?.file).toBe('C:\\x\\claude.exe');
  });

  it('runs an npm .cmd shim as node + script without a shell', () => {
    const fs = fakeFs({
      [`${npm}\\codex.cmd`]: shim,
      [`${npm}\\node_modules\\@openai\\codex\\bin\\codex.js`]: '//',
      'C:\\Program Files\\nodejs\\node.exe': 'MZ',
    });
    const sp = agentSpawn(`${npm}\\codex.cmd`, ['exec', '-', '100%', 'a "b"'], env, 'win32', fs);
    expect(sp).toEqual({ file: 'C:\\Program Files\\nodejs\\node.exe', args: [`${npm}\\node_modules\\@openai\\codex\\bin\\codex.js`, 'exec', '-', '100%', 'a "b"'], env });
  });

  it('refuses a .cmd that is not an npm shim, a missing script and an over-sized file', () => {
    expect(agentSpawn(`${npm}\\tool.cmd`, [], env, 'win32', fakeFs({ [`${npm}\\tool.cmd`]: '@echo off\r\ncall something.bat %*' }))).toBeNull();
    expect(agentSpawn(`${npm}\\codex.cmd`, [], env, 'win32', fakeFs({ [`${npm}\\codex.cmd`]: shim, 'C:\\Program Files\\nodejs\\node.exe': 'MZ' }))).toBeNull();
    expect(agentSpawn(`${npm}\\codex.bat`, [], env, 'win32', fakeFs({ [`${npm}\\codex.bat`]: 'x'.repeat(65 * 1024) }))).toBeNull();
  });
});
