import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ensureTool, ffmpegHasLibass, filtersHaveLibass, fontsDir, legacyToolsDir, resetLibassCache, resolveToolSync, toolStatus, toolsDir,
  type Platform, type ToolManifest,
} from '@video/toolchain';
import { Sandbox } from '../cli/helpers.js';

// 旧 ~/.solocut/tools のツールを読むだけで使う／PATH の ffmpeg は libass 入りを先に使う
const WIN = process.platform === 'win32';
const PLAT: Platform = { os: 'mac', arch: 'arm64' };
const LIBASS = `Filters:\n  T.. = Timeline support\n ------\n TS aap               AA->A      Apply Affine Projection.\n .. ass               V->V       Render ASS subtitles onto input video using the libass library.\n .. subtitles         V->V       Render text subtitles onto input video using the libass library.\n`;
const NO_LIBASS = `Filters:\n ------\n .. scale             V->V       Scale the input video size and/or convert the image format.\n .. drawtext          V->V       Draw text on top of video frames (not ass).\n`;

let tmp: string;
const saved = { ...process.env };
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'ferret-video-legacy-'));
  process.env.FERRET_VIDEO_HOME = join(tmp, 'home');
  process.env.FERRET_VIDEO_LEGACY_TOOLS = join(tmp, 'solocut', 'tools');
  for (const k of ['FERRET_VIDEO_FFMPEG', 'FERRET_VIDEO_FFPROBE', 'FERRET_VIDEO_WHISPER_CLI', 'FERRET_VIDEO_WHISPER_MODEL', 'FERRET_VIDEO_WHISPER_MODEL_SMALL', 'FERRET_VIDEO_FONTS']) delete process.env[k];
  setPath(join(tmp, 'emptybin'));
  resetLibassCache();
});
afterEach(() => {
  for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
  for (const [k, v] of Object.entries(saved)) process.env[k] = v;
  rmSync(tmp, { recursive: true, force: true });
});

function setPath(p: string): void {
  for (const k of Object.keys(process.env)) if (k.toUpperCase() === 'PATH') delete process.env[k];
  process.env.PATH = p;
  process.env.PATHEXT = '.COM;.EXE;.BAT;.CMD';
}

/** tools/<key>/<version>/ に実行ファイルと目印を置く（旧 Solocut は .solocut-tool.json） */
function install(root: string, key: string, version: string, bins: Record<string, string>, marker = '.solocut-tool.json'): Record<string, string> {
  const dir = join(root, key, version);
  mkdirSync(dir, { recursive: true });
  const out: Record<string, string> = {};
  for (const [tool, rel] of Object.entries(bins)) {
    const p = join(dir, rel);
    mkdirSync(join(p, '..'), { recursive: true });
    writeFileSync(p, '#!/bin/sh\necho hi\n');
    chmodSync(p, 0o755);
    out[tool] = p;
  }
  writeFileSync(join(dir, marker), JSON.stringify({ tool: key, version, url: 'x', sha256: '0'.repeat(64), bins, installedAt: '2026-10-11T00:00:00Z' }));
  return out;
}

/** PATH の偽の ffmpeg。-filters に filters を返す */
function fakeFfmpeg(dir: string, filters: string): string {
  mkdirSync(dir, { recursive: true });
  if (WIN) {
    const p = join(dir, 'ffmpeg.cmd');
    writeFileSync(p, `@echo off\r\n${filters.split('\n').map((l) => `echo.${l}`).join('\r\n')}\r\n`);
    return p;
  }
  const p = join(dir, 'ffmpeg');
  writeFileSync(join(dir, 'filters.txt'), filters);
  writeFileSync(p, `#!/bin/sh\n/bin/cat "${join(dir, 'filters.txt')}"\n`);
  chmodSync(p, 0o755);
  return p;
}

const manifest = (key: string, version: string, bin: Record<string, string>, url = 'http://127.0.0.1:9/never'): ToolManifest => ({
  schema: 1, tools: { [key]: { version, assets: [{ ...PLAT, url, sha256: 'a'.repeat(64), kind: 'zip', bin }] } },
});

describe('legacyToolsDir', () => {
  it('defaults to ~/.solocut/tools only when FERRET_VIDEO_HOME is not changed', () => {
    delete process.env.FERRET_VIDEO_LEGACY_TOOLS;
    expect(legacyToolsDir()).toBeNull();
    delete process.env.FERRET_VIDEO_HOME;
    expect(legacyToolsDir()).toBe(join(homedir(), '.solocut', 'tools'));
    process.env.FERRET_VIDEO_HOME = '   ';
    expect(legacyToolsDir()).toBe(join(homedir(), '.solocut', 'tools'));
  });
  it('FERRET_VIDEO_LEGACY_TOOLS overrides it; empty turns it off', () => {
    expect(legacyToolsDir()).toBe(join(tmp, 'solocut', 'tools'));
    process.env.FERRET_VIDEO_LEGACY_TOOLS = '  ';
    expect(legacyToolsDir()).toBeNull();
  });
});

describe('old Solocut tools are used read-only', () => {
  const legacy = () => join(tmp, 'solocut', 'tools');

  it('resolves ffmpeg, ffprobe, whisper-cli, models and fonts from the old place (source legacy)', () => {
    const ff = install(legacy(), 'ffmpeg', '9.0.2', { ffmpeg: 'ffmpeg' });
    const fp = install(legacy(), 'ffprobe', '9.0.2', { ffprobe: 'ffprobe' });
    const wc = install(legacy(), 'whisper-cli', '1.9.5', { 'whisper-cli': 'whisper/whisper-cli' });
    const wm = install(legacy(), 'whisper-model', 'large-v3-turbo-q5_0', { 'whisper-model': 'ggml-large-v3-turbo-q5_0.bin' });
    const fo = install(legacy(), 'fonts', 'noto', { fonts: 'NotoSansJP-Bold.otf' });
    expect(resolveToolSync('ffmpeg', { platform: PLAT })).toEqual({ path: ff.ffmpeg, source: 'legacy', version: '9.0.2' });
    expect(resolveToolSync('ffprobe', { platform: PLAT })?.path).toBe(fp.ffprobe);
    expect(resolveToolSync('whisper-cli', { platform: PLAT })).toEqual({ path: wc['whisper-cli'], source: 'legacy', version: '1.9.5' });
    expect(resolveToolSync('whisper-model', { platform: PLAT })?.path).toBe(wm['whisper-model']);
    expect(fontsDir()).toBe(join(legacy(), 'fonts', 'noto'));
    expect(fo.fonts).toContain('noto');
  });

  it('the new place wins over the old one; env wins over both; the old one wins over PATH', () => {
    install(legacy(), 'ffmpeg', '9.0.2', { ffmpeg: 'ffmpeg' });
    const onPath = fakeFfmpeg(join(tmp, 'bin'), LIBASS);
    setPath(join(tmp, 'bin'));
    expect(resolveToolSync('ffmpeg', { platform: PLAT })?.source).toBe('legacy');
    const own = install(toolsDir(), 'ffmpeg', '9.0.2', { ffmpeg: 'ffmpeg' }, '.ferret-video-tool.json');
    expect(resolveToolSync('ffmpeg', { platform: PLAT })).toEqual({ path: own.ffmpeg, source: 'managed', version: '9.0.2' });
    process.env.FERRET_VIDEO_FFMPEG = onPath;
    expect(resolveToolSync('ffmpeg', { platform: PLAT })).toEqual({ path: onPath, source: 'env' });
  });

  it('a folder without a marker, or a marker without the file, is not used', () => {
    mkdirSync(join(legacy(), 'ffmpeg', '9.0.2'), { recursive: true });
    writeFileSync(join(legacy(), 'ffmpeg', '9.0.2', 'ffmpeg'), 'x');
    install(legacy(), 'ffprobe', '9.0.2', { ffprobe: 'ffprobe' });
    rmSync(join(legacy(), 'ffprobe', '9.0.2', 'ffprobe'));
    expect(resolveToolSync('ffmpeg', { platform: PLAT })).toBeNull();
    expect(resolveToolSync('ffprobe', { platform: PLAT })).toBeNull();
  });

  it('is not read when turned off', () => {
    install(legacy(), 'ffmpeg', '9.0.2', { ffmpeg: 'ffmpeg' });
    process.env.FERRET_VIDEO_LEGACY_TOOLS = '';
    expect(resolveToolSync('ffmpeg', { platform: PLAT })).toBeNull();
  });

  it('ensureTool returns the old copy of the same version without downloading or writing anything', async () => {
    const old = install(legacy(), 'ffmpeg', '9.0.2', { ffmpeg: 'ffmpeg' });
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const before = readdirSync(join(legacy(), 'ffmpeg', '9.0.2')).sort();
    expect(await ensureTool('ffmpeg', { manifest: manifest('ffmpeg', '9.0.2', { ffmpeg: 'ffmpeg' }), platform: PLAT })).toBe(old.ffmpeg);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
    expect(existsSync(toolsDir())).toBe(false);
    expect(readdirSync(join(legacy(), 'ffmpeg', '9.0.2')).sort()).toEqual(before);
  });

  it('ensureTool downloads into the new place when the old version differs', async () => {
    install(legacy(), 'ffmpeg', '8.0', { ffmpeg: 'ffmpeg' });
    await expect(ensureTool('ffmpeg', { manifest: manifest('ffmpeg', '9.0.2', { ffmpeg: 'ffmpeg' }), platform: PLAT })).rejects.toThrow(/download failed/);
    expect(existsSync(join(legacy(), 'ffmpeg', '9.0.2'))).toBe(false);
  });
});

describe('libass detection', () => {
  it('filtersHaveLibass reads the ffmpeg -filters table', () => {
    expect(filtersHaveLibass(LIBASS)).toBe(true);
    expect(filtersHaveLibass(LIBASS.replace(/.*\bsubtitles\b.*\n/, ''))).toBe(true); // ass だけでも描ける
    expect(filtersHaveLibass(NO_LIBASS)).toBe(false);
    expect(filtersHaveLibass('')).toBe(false);
    expect(filtersHaveLibass(' .. assplit  V->V  x')).toBe(false);
  });

  it('probes once per file and remembers it on disk until the file changes', () => {
    const f = join(tmp, 'ff');
    writeFileSync(f, 'v1');
    const probe = vi.fn(() => LIBASS);
    expect(ffmpegHasLibass(f, { probe })).toBe(true);
    expect(ffmpegHasLibass(f, { probe })).toBe(true);
    expect(probe).toHaveBeenCalledTimes(1);
    const cache = JSON.parse(readFileSync(join(tmp, 'home', 'cache', 'ffmpeg-libass.json'), 'utf8'));
    expect(cache[f]).toMatchObject({ libass: true, size: 2 });
    // memory を忘れても、ファイルのキャッシュで実行しない
    resetLibassCache();
    const again = vi.fn(() => NO_LIBASS);
    expect(ffmpegHasLibass(f, { probe: again })).toBe(true);
    expect(again).not.toHaveBeenCalled();
    // 入れ替えたら確かめ直す
    writeFileSync(f, 'version2');
    utimesSync(f, new Date(), new Date(Date.now() + 5000));
    expect(ffmpegHasLibass(f, { probe: again })).toBe(false);
    expect(again).toHaveBeenCalledTimes(1);
  });

  it('missing file or a failing probe → null (unknown), not written to the cache', () => {
    expect(ffmpegHasLibass(join(tmp, 'nope'), { probe: () => LIBASS })).toBeNull();
    const f = join(tmp, 'broken');
    writeFileSync(f, 'x');
    expect(ffmpegHasLibass(f, { probe: () => null })).toBeNull();
    expect(existsSync(join(tmp, 'home', 'cache', 'ffmpeg-libass.json'))).toBe(false);
  });

  it('a broken cache file is ignored and rewritten', () => {
    mkdirSync(join(tmp, 'home', 'cache'), { recursive: true });
    writeFileSync(join(tmp, 'home', 'cache', 'ffmpeg-libass.json'), '[not json');
    const f = join(tmp, 'ff');
    writeFileSync(f, 'x');
    expect(ffmpegHasLibass(f, { probe: () => NO_LIBASS })).toBe(false);
    expect(JSON.parse(readFileSync(join(tmp, 'home', 'cache', 'ffmpeg-libass.json'), 'utf8'))[f].libass).toBe(false);
  });

  it.skipIf(WIN)('runs the real binary when no probe is given', () => {
    expect(ffmpegHasLibass(fakeFfmpeg(join(tmp, 'a'), LIBASS))).toBe(true);
    expect(ffmpegHasLibass(fakeFfmpeg(join(tmp, 'b'), NO_LIBASS))).toBe(false);
  });

  it.skipIf(WIN)('PATH: an ffmpeg with libass later on PATH wins over one without; none → the first', () => {
    const plain = fakeFfmpeg(join(tmp, 'brew'), NO_LIBASS);
    const good = fakeFfmpeg(join(tmp, 'good'), LIBASS);
    setPath([join(tmp, 'brew'), join(tmp, 'good')].join(':'));
    expect(resolveToolSync('ffmpeg', { platform: PLAT })).toEqual({ path: good, source: 'path' });
    rmSync(good);
    expect(resolveToolSync('ffmpeg', { platform: PLAT })).toEqual({ path: plain, source: 'path' });
  });

  it.skipIf(WIN)('toolStatus says libass; doctor tells how to get a build with it', async () => {
    const plain = fakeFfmpeg(join(tmp, 'brew'), NO_LIBASS);
    setPath(join(tmp, 'brew'));
    expect((await toolStatus({ probeVersions: true })).ffmpeg).toMatchObject({ installed: true, path: plain, source: 'path', libass: false });
    expect((await toolStatus({ probeVersions: false })).ffmpeg.libass).toBeUndefined();
    const sb = new Sandbox();
    try {
      process.env.FERRET_VIDEO_LEGACY_TOOLS = '';
      const r = await sb.run(['doctor', '--json'], { env: { PATH: join(tmp, 'brew') } });
      expect(r.json.tools.ffmpeg.libass).toBe(false);
      expect(r.json.problems.join('\n')).toContain("libass がありません）: `ferret-video lib install ffmpeg`");
    } finally {
      sb.dispose();
    }
  });
});
