import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32, deflateRawSync } from 'node:zlib';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_MANIFEST, ToolchainError, currentPlatform, ensureTool, extractZip, findAsset, resolveTool, resolveToolSync, sha256File,
  envPath, fontsDir, videoHome, toolStatus, toolsDir, whichSync, type ToolManifest,
} from '@video/toolchain';

const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
const WIN = process.platform === 'win32';

/** Point PATH (whatever its case on this OS) at `p` only. */
function setPath(p: string): void {
  for (const k of Object.keys(process.env)) if (k.toUpperCase() === 'PATH') delete process.env[k];
  process.env['PATH'] = p;
  process.env.PATHEXT = '.COM;.EXE;.BAT;.CMD';
}

/** A fake executable printing `out`: a .cmd on Windows, a sh script elsewhere. */
function fakeExe(dir: string, name: string, out = ''): string {
  if (WIN) {
    const p = join(dir, `${name}.cmd`);
    writeFileSync(p, `@echo off\r\n${out ? `echo ${out}\r\n` : ''}`);
    return p;
  }
  const p = join(dir, name);
  writeFileSync(p, `#!/bin/sh\n${out ? `echo "${out}"\n` : ''}`);
  chmodSync(p, 0o755);
  return p;
}

/** Restore the environment in place (assigning a plain object to process.env breaks Windows' case-insensitive env). */
function restoreEnv(saved: NodeJS.ProcessEnv): void {
  for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
  for (const [k, v] of Object.entries(saved)) process.env[k] = v;
}

let tmp: string;
let server: Server;
let base: string;
const routes = new Map<string, (res: import('node:http').ServerResponse) => void>();
const hits = new Map<string, number>();
const saved = { ...process.env };

beforeAll(async () => {
  server = createServer((req, res) => {
    const url = req.url ?? '';
    hits.set(url, (hits.get(url) ?? 0) + 1);
    const r = routes.get(url);
    if (typeof r !== 'function') {
      res.statusCode = 404;
      res.end('nope');
      return;
    }
    r(res);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'ferret-video-tc-'));
  process.env.FERRET_VIDEO_HOME = join(tmp, 'home');
  // the suite may run with a managed ffmpeg in the environment; resolution-order tests need a clean slate
  for (const k of ['FERRET_VIDEO_FFMPEG', 'FERRET_VIDEO_FFPROBE', 'FERRET_VIDEO_WHISPER_CLI', 'FERRET_VIDEO_WHISPER_MODEL', 'FERRET_VIDEO_WHISPER_MODEL_SMALL', 'FERRET_VIDEO_FONTS']) delete process.env[k];
  routes.clear();
  hits.clear();
});
afterEach(() => {
  restoreEnv(saved);
  rmSync(tmp, { recursive: true, force: true });
});

function serve(path: string, body: Buffer, o: { lie?: number } = {}) {
  routes.set(path, (res) => {
    res.setHeader('content-length', String(o.lie ?? body.length));
    if (o.lie) {
      res.write(body.subarray(0, Math.min(10, body.length)));
      setTimeout(() => res.destroy(), 20);
      return;
    }
    res.end(body);
  });
}

/** Builds a tar.gz with bin/fakeffmpeg (a shell script) and bin/fakeprobe. */
function makeArchive(): Buffer {
  const src = join(tmp, 'src');
  mkdirSync(join(src, 'pkg', 'bin'), { recursive: true });
  writeFileSync(join(src, 'pkg', 'bin', 'ffmpeg'), '#!/bin/sh\necho "ffmpeg version 9.9.9-test"\n');
  writeFileSync(join(src, 'pkg', 'bin', 'ffprobe'), '#!/bin/sh\necho "ffprobe version 9.9.9-test"\n');
  const out = join(tmp, 'a.tar.gz');
  execFileSync('tar', ['-czf', out, '-C', src, 'pkg']);
  return readFileSync(out);
}

const plat = { os: 'linux' as const, arch: 'x64' as const };

function manifestFor(url: string, sha256: string, kind: 'tar.gz' | 'file' = 'tar.gz', bin?: Record<string, string>): ToolManifest {
  return {
    schema: 1,
    tools: {
      ffmpeg: {
        version: '9.9.9',
        assets: [{ os: 'linux', arch: 'x64', url, sha256, kind, bin: bin ?? { ffmpeg: 'pkg/bin/ffmpeg', ffprobe: 'pkg/bin/ffprobe' } }],
      },
    },
  };
}

describe('paths and platform', () => {
  it('videoHome honours FERRET_VIDEO_HOME and falls back to ~/.ferret/video', () => {
    expect(videoHome()).toBe(join(tmp, 'home'));
    expect(toolsDir()).toBe(join(tmp, 'home', 'tools'));
    process.env.FERRET_VIDEO_HOME = '  ';
    expect(videoHome().endsWith(join('.ferret', 'video'))).toBe(true);
    delete process.env.FERRET_VIDEO_HOME;
    expect(videoHome().endsWith(join('.ferret', 'video'))).toBe(true);
  });

  it('maps node platforms and rejects unknown ones', () => {
    expect(currentPlatform('darwin', 'arm64')).toEqual({ os: 'mac', arch: 'arm64' });
    expect(currentPlatform('win32', 'x64')).toEqual({ os: 'win', arch: 'x64' });
    expect(currentPlatform('linux', 'arm64')).toEqual({ os: 'linux', arch: 'arm64' });
    expect(() => currentPlatform('freebsd', 'x64')).toThrow(ToolchainError);
    expect(() => currentPlatform('linux', 'ia32')).toThrow(/unsupported platform/);
  });
});

describe('DEFAULT_MANIFEST', () => {
  it('has well-formed pinned entries', () => {
    for (const [key, tool] of Object.entries(DEFAULT_MANIFEST.tools)) {
      expect(tool.version, key).toBeTruthy();
      for (const a of tool.assets) {
        for (const x of a.kind === 'bundle' ? a.parts ?? [] : [a]) {
          expect(x.sha256, x.url).toMatch(/^[0-9a-f]{64}$/);
          expect(x.url).toMatch(/^https:\/\//);
          expect(x.url).not.toMatch(/\/latest\//);
        }
        expect(Object.keys(a.bin).length).toBeGreaterThan(0);
      }
    }
  });

  it('provides ffmpeg, ffprobe and models on every platform', () => {
    for (const os of ['mac', 'win', 'linux'] as const) {
      for (const arch of ['x64', 'arm64'] as const) {
        for (const name of ['ffmpeg', 'ffprobe', 'whisper-model', 'whisper-model-small'] as const) {
          expect(findAsset(DEFAULT_MANIFEST, name, { os, arch }), `${name} ${os}/${arch}`).not.toBeNull();
        }
      }
    }
  });

  it('finds ffprobe inside the ffmpeg archive on win/linux and as its own zip on mac', () => {
    expect(findAsset(DEFAULT_MANIFEST, 'ffprobe', { os: 'linux', arch: 'x64' })?.toolKey).toBe('ffmpeg');
    expect(findAsset(DEFAULT_MANIFEST, 'ffprobe', { os: 'win', arch: 'arm64' })?.asset.bin.ffprobe).toMatch(/ffprobe\.exe$/);
    expect(findAsset(DEFAULT_MANIFEST, 'ffprobe', { os: 'mac', arch: 'arm64' })?.toolKey).toBe('ffprobe');
  });

  it('has no whisper-cli download (Ferret passes its own whisper-cli in)', () => {
    for (const os of ['mac', 'win', 'linux'] as const) {
      for (const arch of ['x64', 'arm64'] as const) expect(findAsset(DEFAULT_MANIFEST, 'whisper-cli', { os, arch }), `${os}/${arch}`).toBeNull();
    }
    expect(JSON.stringify(DEFAULT_MANIFEST)).not.toMatch(/solocut|ferret-video\.app/);
  });
});

describe('ensureTool', () => {
  it('downloads, verifies, extracts, chmods and installs atomically', async () => {
    const body = makeArchive();
    serve('/ff.tar.gz', body);
    const m = manifestFor(`${base}/ff.tar.gz`, sha(body));
    const progress: { received: number; total?: number }[] = [];
    const p = await ensureTool('ffmpeg', { manifest: m, platform: plat, onProgress: (x) => progress.push(x) });
    expect(p).toBe(join(toolsDir(), 'ffmpeg', '9.9.9', 'pkg/bin/ffmpeg'));
    if (WIN) expect(readFileSync(p, 'utf8')).toContain('9.9.9-test'); // a sh script cannot run on Windows
    else expect(execFileSync(p).toString()).toContain('9.9.9-test');
    expect(progress.at(-1)).toEqual({ received: body.length, total: body.length });
    // staging is cleaned up
    expect(readdirSync(join(toolsDir(), '.staging'))).toEqual([]);
    // second call: already installed, no new request; ffprobe comes from the same archive
    const probe = await ensureTool('ffprobe', { manifest: m, platform: plat });
    expect(probe).toBe(join(toolsDir(), 'ffmpeg', '9.9.9', 'pkg/bin/ffprobe'));
    expect(hits.get('/ff.tar.gz')).toBe(1);
    expect(resolveToolSync('ffmpeg', { manifest: m, platform: plat })).toMatchObject({ source: 'managed', version: '9.9.9' });
  });

  it('dedupes concurrent installs of the same archive', async () => {
    const body = makeArchive();
    serve('/ff.tar.gz', body);
    const m = manifestFor(`${base}/ff.tar.gz`, sha(body));
    const [a, b] = await Promise.all([ensureTool('ffmpeg', { manifest: m, platform: plat }), ensureTool('ffprobe', { manifest: m, platform: plat })]);
    expect(a).not.toBe(b);
    expect(hits.get('/ff.tar.gz')).toBe(1);
  });

  it('rejects a sha256 mismatch and leaves nothing installed', async () => {
    const body = makeArchive();
    serve('/ff.tar.gz', body);
    const m = manifestFor(`${base}/ff.tar.gz`, '0'.repeat(64));
    await expect(ensureTool('ffmpeg', { manifest: m, platform: plat })).rejects.toMatchObject({ code: 'checksum' });
    expect(existsSync(join(toolsDir(), 'ffmpeg', '9.9.9'))).toBe(false);
    expect(readdirSync(join(toolsDir(), '.staging'))).toEqual([]);
  });

  it('rejects an interrupted download', async () => {
    const body = makeArchive();
    serve('/ff.tar.gz', body, { lie: body.length + 1000 });
    const m = manifestFor(`${base}/ff.tar.gz`, sha(body));
    await expect(ensureTool('ffmpeg', { manifest: m, platform: plat })).rejects.toMatchObject({ code: 'download' });
    expect(existsSync(join(toolsDir(), 'ffmpeg', '9.9.9'))).toBe(false);
  });

  it('rejects HTTP errors', async () => {
    const m = manifestFor(`${base}/missing.tar.gz`, '0'.repeat(64));
    await expect(ensureTool('ffmpeg', { manifest: m, platform: plat })).rejects.toThrow(/HTTP 404/);
  });

  it('rejects an unreachable host', async () => {
    const m = manifestFor('http://127.0.0.1:1/x.tar.gz', '0'.repeat(64));
    await expect(ensureTool('ffmpeg', { manifest: m, platform: plat })).rejects.toMatchObject({ code: 'download' });
  });

  it('rejects an archive that lacks the declared binary', async () => {
    const body = makeArchive();
    serve('/ff.tar.gz', body);
    const m = manifestFor(`${base}/ff.tar.gz`, sha(body), 'tar.gz', { ffmpeg: 'pkg/bin/nothere' });
    await expect(ensureTool('ffmpeg', { manifest: m, platform: plat })).rejects.toMatchObject({ code: 'missing-bin' });
  });

  it('rejects a corrupt archive', async () => {
    const body = Buffer.from('this is not a tarball');
    serve('/ff.tar.gz', body);
    const m = manifestFor(`${base}/ff.tar.gz`, sha(body));
    await expect(ensureTool('ffmpeg', { manifest: m, platform: plat })).rejects.toMatchObject({ code: 'extract' });
  });

  it('stores plain files (models) without extraction', async () => {
    const body = Buffer.from('fake-model-bytes');
    serve('/model.bin', body);
    const m: ToolManifest = {
      schema: 1,
      tools: { 'whisper-model': { version: 'v1', assets: [{ ...plat, url: `${base}/model.bin`, sha256: sha(body), kind: 'file', bin: { 'whisper-model': 'm.bin' } }] } },
    };
    const p = await ensureTool('whisper-model', { manifest: m, platform: plat });
    expect(readFileSync(p, 'utf8')).toBe('fake-model-bytes');
    expect(await sha256File(p)).toBe(sha(body));
  });

  it('falls back to PATH when the platform has no build, else explains how to install', async () => {
    const m: ToolManifest = { schema: 1, tools: {} };
    setPath(join(tmp, 'emptybin'));
    await expect(ensureTool('whisper-cli', { manifest: m, platform: { os: 'mac', arch: 'arm64' } })).rejects.toThrow(/brew install whisper-cpp/);
    const bin = join(tmp, 'bin');
    mkdirSync(bin);
    const fake = fakeExe(bin, 'whisper-cli');
    setPath(bin);
    expect(await ensureTool('whisper-cli', { manifest: m, platform: { os: 'mac', arch: 'arm64' } })).toBe(fake);
  });

  it('reports no-asset for a platform the manifest does not cover', async () => {
    setPath(join(tmp, 'emptybin'));
    await expect(ensureTool('ffmpeg', { platform: { os: 'solaris' as never, arch: 'x64' } })).rejects.toMatchObject({ code: 'no-asset' });
  });
});

describe('resolveTool', () => {
  it('prefers the env override when the file exists', async () => {
    const f = join(tmp, 'myffmpeg');
    writeFileSync(f, '');
    process.env.FERRET_VIDEO_FFMPEG = f;
    expect(await resolveTool('ffmpeg')).toBe(f);
    process.env.FERRET_VIDEO_FFMPEG = join(tmp, 'does-not-exist');
    setPath(join(tmp, 'emptybin'));
    expect(await resolveTool('ffmpeg', { platform: null })).toBeNull();
  });

  it('finds executables on PATH (and the old whisper-cpp name)', async () => {
    const bin = join(tmp, 'bin');
    mkdirSync(bin);
    const fake = fakeExe(bin, 'whisper-cpp');
    writeFileSync(join(bin, 'ffprobe'), 'not executable'); // no exec bit / no PATHEXT extension
    setPath(bin);
    expect(await resolveTool('whisper-cli', { platform: null })).toBe(fake);
    expect(await resolveTool('ffprobe', { platform: null })).toBeNull();
    expect(whichSync('whisper-cpp')).toBe(fake);
  });

  it('never looks for models on PATH', async () => {
    expect(await resolveTool('whisper-model', { platform: null })).toBeNull();
  });

  it('finds another installed version when the manifest moved on', async () => {
    const dir = join(toolsDir(), 'ffmpeg', '8.0.0');
    mkdirSync(join(dir, 'bin'), { recursive: true });
    writeFileSync(join(dir, 'bin', 'ffmpeg'), '');
    writeFileSync(join(dir, '.ferret-video-tool.json'), JSON.stringify({ tool: 'ffmpeg', version: '8.0.0', bins: { ffmpeg: 'bin/ffmpeg' } }));
    expect(resolveToolSync('ffmpeg', { platform: plat })).toMatchObject({ source: 'managed', version: '8.0.0' });
  });

  it('ignores a half-installed directory without a marker', async () => {
    const dir = join(toolsDir(), 'ffmpeg', DEFAULT_MANIFEST.tools.ffmpeg!.version);
    mkdirSync(dir, { recursive: true });
    setPath(join(tmp, 'emptybin'));
    expect(await resolveTool('ffmpeg', { platform: plat })).toBeNull();
  });
});

describe('toolStatus', () => {
  it('reports every tool with its source and version', async () => {
    const bin = join(tmp, 'bin');
    mkdirSync(bin);
    const fake = fakeExe(bin, 'ffmpeg', 'ffmpeg version 7.1-test Copyright');
    setPath(bin);
    const s = await toolStatus();
    expect(Object.keys(s).sort()).toEqual(['ffmpeg', 'ffprobe', 'fonts', 'whisper-cli', 'whisper-model', 'whisper-model-small']);
    // the Windows fake is a .cmd, which is never started without a shell, so its version and filters stay unknown there
    expect(s.ffmpeg).toEqual(WIN ? { installed: true, path: fake, source: 'path' } : { installed: true, path: fake, source: 'path', version: '7.1-test', libass: false });
    expect(s.ffprobe.installed).toBe(false);
  });
});

/** Minimal zip writer for tests: entries stored (method 0) or deflated (8). */
function makeZip(entries: { name: string; data?: string; deflate?: boolean }[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let off = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name);
    const raw = Buffer.from(e.data ?? '');
    const body = e.deflate ? deflateRawSync(raw) : raw;
    const h = Buffer.alloc(30);
    h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(e.deflate ? 8 : 0, 8);
    h.writeUInt32LE(crc32(raw), 14); h.writeUInt32LE(body.length, 18); h.writeUInt32LE(raw.length, 22); h.writeUInt16LE(name.length, 26);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(e.deflate ? 8 : 0, 10);
    c.writeUInt32LE(crc32(raw), 16); c.writeUInt32LE(body.length, 20); c.writeUInt32LE(raw.length, 24); c.writeUInt16LE(name.length, 28); c.writeUInt32LE(off, 42);
    locals.push(h, name, body);
    centrals.push(c, name);
    off += 30 + name.length + body.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(off, 16);
  return Buffer.concat([...locals, cd, end]);
}

describe('zip', () => {
  it('extracts stored and deflated entries with folders', async () => {
    const zip = join(tmp, 'a.zip');
    writeFileSync(zip, makeZip([{ name: 'whisper/' }, { name: 'whisper/whisper-cli', data: '#!/bin/sh\necho ok\n', deflate: true }, { name: 'whisper/LICENSE.txt', data: 'MIT' }]));
    const out = join(tmp, 'out');
    mkdirSync(out);
    await extractZip(zip, out);
    expect(readFileSync(join(out, 'whisper', 'whisper-cli'), 'utf8')).toContain('echo ok');
    expect(readFileSync(join(out, 'whisper', 'LICENSE.txt'), 'utf8')).toBe('MIT');
  });

  it('rejects path traversal, corrupt and non-zip files', async () => {
    const out = join(tmp, 'out');
    mkdirSync(out);
    writeFileSync(join(tmp, 'evil.zip'), makeZip([{ name: '../evil.txt', data: 'x' }]));
    await expect(extractZip(join(tmp, 'evil.zip'), out)).rejects.toThrow(/escapes/);
    expect(existsSync(join(tmp, 'evil.txt'))).toBe(false);
    writeFileSync(join(tmp, 'not.zip'), 'hello');
    await expect(extractZip(join(tmp, 'not.zip'), out)).rejects.toMatchObject({ code: 'extract' });
    const bad = makeZip([{ name: 'f', data: 'abcdef', deflate: true }]);
    bad[31] = 0xff; bad[32] = 0xff; // damage the compressed data
    writeFileSync(join(tmp, 'bad.zip'), bad);
    await expect(extractZip(join(tmp, 'bad.zip'), out)).rejects.toMatchObject({ code: 'extract' });
  });

  it('ensureTool installs a zip asset (whisper-cli layout) and makes it executable', async () => {
    const body = makeZip([{ name: 'whisper/whisper-cli', data: '#!/bin/sh\necho whisper\n', deflate: true }]);
    serve('/w.zip', body);
    const m: ToolManifest = { schema: 1, tools: { 'whisper-cli': { version: '1.9.5', assets: [{ ...plat, url: `${base}/w.zip`, sha256: sha(body), kind: 'zip', bin: { 'whisper-cli': 'whisper/whisper-cli' } }] } } };
    const p = await ensureTool('whisper-cli', { manifest: m, platform: plat });
    if (WIN) expect(readFileSync(p, 'utf8')).toContain('echo whisper');
    else expect(execFileSync(p).toString()).toBe('whisper\n');
  });

  it('refuses an asset whose sha256 is not 64 hex characters (e.g. "TBD")', async () => {
    const m: ToolManifest = { schema: 1, tools: { 'whisper-cli': { version: '1', assets: [{ ...plat, url: `${base}/w.zip`, sha256: 'TBD', kind: 'zip', bin: { 'whisper-cli': 'w' } }] } } };
    await expect(ensureTool('whisper-cli', { manifest: m, platform: plat })).rejects.toThrow(/no valid sha256/);
    expect(hits.get('/w.zip')).toBeUndefined();
  });
});

describe('Windows lookup rules (simulated)', () => {
  it('whichSync: PATHEXT names only, any PATH case, ";" separators', () => {
    const bin = join(tmp, 'winbin');
    mkdirSync(bin);
    writeFileSync(join(bin, 'claude'), '');
    writeFileSync(join(bin, 'claude.cmd'), '');
    writeFileSync(join(bin, 'ffmpeg.exe'), '');
    const env = { Path: `C:\\nowhere;${bin}`, PATHEXT: '.EXE;.CMD' };
    // the lower-case spelling is tried first, so the path matches the file on any file system
    expect(whichSync('claude', env, 'win32')).toBe(join(bin, 'claude.cmd'));
    expect(whichSync('ffmpeg', env, 'win32')).toBe(join(bin, 'ffmpeg.exe'));
    expect(whichSync('claude.cmd', env, 'win32')).toBe(join(bin, 'claude.cmd'));
    expect(whichSync('nothing', env, 'win32')).toBeNull();
    expect(envPath({ path: 'a' })).toBe('a');
  });
});

describe('fonts bundle', () => {
  it('pins Noto Sans JP and JetBrains Mono (OFL) for every platform', () => {
    for (const os of ['mac', 'win', 'linux'] as const) for (const arch of ['x64', 'arm64'] as const) {
      const m = findAsset(DEFAULT_MANIFEST, 'fonts', { os, arch })!;
      expect(m.asset.kind).toBe('bundle');
      const files = (m.asset.parts ?? []).flatMap((x) => Object.keys(x.files));
      for (const f of ['NotoSansJP-Bold.otf', 'NotoSansJP-Black.otf', 'LICENSE-NotoSansJP.txt', 'JetBrainsMono-Regular.ttf', 'OFL-JetBrainsMono.txt']) expect(files).toContain(f);
    }
  });

  it('installs several archives into one flat folder; fontsDir() and $FERRET_VIDEO_FONTS', async () => {
    const a = makeZip([{ name: 'NotoSansJP-Bold.otf', data: 'otf' }, { name: 'LICENSE', data: 'OFL' }]);
    const b = makeZip([{ name: 'fonts/ttf/Mono.ttf', data: 'ttf', deflate: true }]);
    serve('/a.zip', a);
    serve('/b.zip', b);
    const m: ToolManifest = { schema: 1, tools: { fonts: { version: 'v1', assets: [{ ...plat, url: 'bundle:fonts', sha256: '0'.repeat(64), kind: 'bundle', bin: { fonts: 'NotoSansJP-Bold.otf' }, parts: [
      { url: `${base}/a.zip`, sha256: sha(a), kind: 'zip', size: a.length, files: { 'NotoSansJP-Bold.otf': 'NotoSansJP-Bold.otf', 'LICENSE-Noto.txt': 'LICENSE' } },
      { url: `${base}/b.zip`, sha256: sha(b), kind: 'zip', size: b.length, files: { 'Mono.ttf': 'fonts/ttf/Mono.ttf' } },
    ] }] } } };
    const progressSeen: number[] = [];
    const p = await ensureTool('fonts', { manifest: m, platform: plat, onProgress: (x) => progressSeen.push(x.received) });
    const dir = join(toolsDir(), 'fonts', 'v1');
    expect(p).toBe(join(dir, 'NotoSansJP-Bold.otf'));
    expect(readdirSync(dir).sort()).toEqual(['.ferret-video-tool.json', 'LICENSE-Noto.txt', 'Mono.ttf', 'NotoSansJP-Bold.otf']);
    expect(progressSeen.at(-1)).toBe(a.length + b.length);
    expect(readFileSync(join(dir, 'Mono.ttf'), 'utf8')).toBe('ttf');
    process.env.FERRET_VIDEO_FONTS = join(tmp, 'myfonts');
    mkdirSync(join(tmp, 'myfonts'));
    expect(fontsDir()).toBe(join(tmp, 'myfonts'));
  });

  it('a wrong part hash installs nothing; a missing file is reported', async () => {
    const a = makeZip([{ name: 'X.otf', data: 'x' }]);
    serve('/a.zip', a);
    const mk = (sha256: string, files: Record<string, string>): ToolManifest => ({ schema: 1, tools: { fonts: { version: 'v2', assets: [{ ...plat, url: 'bundle:fonts', sha256: '0'.repeat(64), kind: 'bundle', bin: { fonts: 'X.otf' }, parts: [{ url: `${base}/a.zip`, sha256, kind: 'zip', files }] }] } } });
    await expect(ensureTool('fonts', { manifest: mk('1'.repeat(64), { 'X.otf': 'X.otf' }), platform: plat })).rejects.toMatchObject({ code: 'checksum' });
    await expect(ensureTool('fonts', { manifest: mk(sha(a), { 'X.otf': 'Y.otf' }), platform: plat })).rejects.toMatchObject({ code: 'missing-bin' });
    await expect(ensureTool('fonts', { manifest: mk(sha(a), { '../X.otf': 'X.otf' }), platform: plat })).rejects.toMatchObject({ code: 'extract' });
    await expect(ensureTool('fonts', { manifest: mk('TBD', { 'X.otf': 'X.otf' }), platform: plat })).rejects.toThrow(/no valid sha256/);
    expect(existsSync(join(toolsDir(), 'fonts', 'v2'))).toBe(false);
  });
});
