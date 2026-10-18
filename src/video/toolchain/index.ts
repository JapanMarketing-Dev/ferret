import { spawn, execFile, execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { accessSync, constants as fsc, createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { chmod, copyFile, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, delimiter, dirname, join, resolve, sep } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { LEGACY_HOME_PARTS, LEGACY_TOOL_MARKER, VIDEO_HOME_DEFAULT_PARTS, VIDEO_HOME_ENV, VIDEO_LEGACY_TOOLS_ENV } from '@video/names';
import { extractZip } from './zip.js';
import { ToolchainError } from './errors.js';

export { ToolchainError } from './errors.js';
export { extractZip } from './zip.js';
import { DEFAULT_MANIFEST, TOOL_NAMES, type ToolArch, type ToolAsset, type ToolManifest, type ToolName, type ToolOs } from './manifest.js';

export * from './manifest.js';

/** $FERRET_VIDEO_HOME or ~/.ferret/video */
export function videoHome(): string {
  const env = process.env[VIDEO_HOME_ENV];
  return env && env.trim() ? resolve(env) : join(homedir(), ...VIDEO_HOME_DEFAULT_PARTS);
}

export function toolsDir(): string {
  return join(videoHome(), 'tools');
}

/**
 * 旧 Solocut が落としたツールの置き場（~/.solocut/tools）。新しい置き場に無いツールだけ、ここから読み取り専用で使う
 * （再ダウンロードを避ける。書き込み・インストールは toolsDir() だけ）。
 * $FERRET_VIDEO_LEGACY_TOOLS で変えられ、空なら使わない。FERRET_VIDEO_HOME を変えているときは既定では見ない。
 */
export function legacyToolsDir(): string | null {
  const env = process.env[VIDEO_LEGACY_TOOLS_ENV];
  if (env !== undefined) return env.trim() ? resolve(env) : null;
  if (process.env[VIDEO_HOME_ENV]?.trim()) return null;
  return join(homedir(), ...LEGACY_HOME_PARTS, 'tools');
}

export interface Platform { os: ToolOs; arch: ToolArch }


/** The platform of this process; throws `unsupported-platform` for anything we have no builds for. */
export function currentPlatform(p: string = process.platform, a: string = process.arch): Platform {
  const os: ToolOs | undefined = p === 'darwin' ? 'mac' : p === 'win32' ? 'win' : p === 'linux' ? 'linux' : undefined;
  const arch: ToolArch | undefined = a === 'x64' ? 'x64' : a === 'arm64' ? 'arm64' : undefined;
  if (!os || !arch) throw new ToolchainError('unsupported-platform', `unsupported platform: ${p}/${a}`);
  return { os, arch };
}

const ENV_VARS: Record<ToolName, string> = {
  ffmpeg: 'FERRET_VIDEO_FFMPEG',
  ffprobe: 'FERRET_VIDEO_FFPROBE',
  'whisper-cli': 'FERRET_VIDEO_WHISPER_CLI',
  'whisper-model': 'FERRET_VIDEO_WHISPER_MODEL',
  'whisper-model-small': 'FERRET_VIDEO_WHISPER_MODEL_SMALL',
  fonts: 'FERRET_VIDEO_FONTS',
};

/** Executable names looked up on PATH (models are never on PATH). */
const PATH_NAMES: Record<ToolName, string[]> = {
  ffmpeg: ['ffmpeg'],
  ffprobe: ['ffprobe'],
  'whisper-cli': ['whisper-cli', 'whisper-cpp'],
  'whisper-model': [],
  'whisper-model-small': [],
  fonts: [],
};

export interface AssetMatch { toolKey: string; version: string; asset: ToolAsset }

/** The manifest entry that provides `name` on `plat`: the tool's own entry first, then any archive that bundles it. */
export function findAsset(manifest: ToolManifest, name: ToolName, plat: Platform): AssetMatch | null {
  const keys = [name, ...Object.keys(manifest.tools).filter((k) => k !== name)];
  for (const key of keys) {
    const tool = manifest.tools[key];
    if (!tool) continue;
    const asset = tool.assets.find((a) => a.os === plat.os && a.arch === plat.arch && a.bin[name]);
    if (asset) return { toolKey: key, version: tool.version, asset };
  }
  return null;
}

const MARKER = '.ferret-video-tool.json';
interface Marker { tool: string; version: string; url: string; sha256: string; bins: Record<string, string>; installedAt: string }

function readMarker(dir: string, names: readonly string[] = [MARKER]): Marker | null {
  for (const n of names) {
    try {
      return JSON.parse(readFileSync(join(dir, n), 'utf8')) as Marker;
    } catch {
      /* next name */
    }
  }
  return null;
}

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

function isExecutable(p: string): boolean {
  if (!isFile(p)) return false;
  if (process.platform === 'win32') return true;
  try {
    accessSync(p, fsc.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** PATH from an env object, whatever its case ("Path" on Windows when the env is a plain copy). */
export function envPath(env: NodeJS.ProcessEnv = process.env): string {
  const key = Object.keys(env).find((k) => k.toUpperCase() === 'PATH');
  return (key ? env[key] : '') ?? '';
}

/** Search PATH for an executable. On Windows only names with a PATHEXT extension count (as cmd.exe does). */
export function whichSync(cmd: string, env: NodeJS.ProcessEnv = process.env, platform: string = process.platform): string | null {
  const dirs = envPath(env).split(platform === 'win32' ? ';' : delimiter).filter(Boolean);
  const pathextKey = Object.keys(env).find((k) => k.toUpperCase() === 'PATHEXT');
  // PATHEXT is upper case but files are usually named .cmd/.exe: try the lower-case spelling first so the returned path
  // matches the file (and a case-sensitive file system finds it at all)
  const exts = platform === 'win32' ? [...new Set(((pathextKey ? env[pathextKey] : undefined) ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean).flatMap((e) => [e.toLowerCase(), e]))] : [''];
  // a name that already has an extension (claude.cmd) is looked up as is
  const names = platform === 'win32' && /\.[A-Za-z0-9]+$/.test(cmd) ? [cmd, ...exts.map((e) => cmd + e)] : exts.map((e) => cmd + e);
  for (const d of dirs) {
    for (const n of names) {
      const p = join(d, n);
      if (platform === 'win32' ? isFile(p) && exts.some((e) => p.toUpperCase().endsWith(e.toUpperCase())) : isExecutable(p)) return p;
    }
  }
  return null;
}

/** A managed install of `name`: the new tools dir first, then the old Solocut one (read only). */
function managedPath(name: ToolName, manifest: ToolManifest, plat: Platform | null): { path: string; version: string; legacy: boolean } | null {
  const own = installedIn(toolsDir(), [MARKER], name, manifest, plat);
  if (own) return { ...own, legacy: false };
  const legacy = legacyToolsDir();
  const old = legacy && resolve(legacy) !== resolve(toolsDir()) ? installedIn(legacy, [LEGACY_TOOL_MARKER, MARKER], name, manifest, plat) : null;
  return old ? { ...old, legacy: true } : null;
}

/** An install of `name` under root (the manifest version first, then any other installed version, newest first). */
function installedIn(root: string, markers: readonly string[], name: ToolName, manifest: ToolManifest, plat: Platform | null): { path: string; version: string } | null {
  if (plat) {
    const m = findAsset(manifest, name, plat);
    if (m) {
      const dir = join(root, m.toolKey, m.version);
      const marker = readMarker(dir, markers);
      const rel = m.asset.bin[name]!;
      if (marker && isFile(join(dir, rel))) return { path: join(dir, rel), version: m.version };
    }
  }
  // any other installed version that provides `name`
  let keys: string[] = [];
  try {
    keys = readdirSync(root).filter((k) => !k.startsWith('.'));
  } catch {
    return null;
  }
  for (const key of keys) {
    let versions: string[] = [];
    try {
      versions = readdirSync(join(root, key)).sort().reverse();
    } catch {
      continue;
    }
    for (const v of versions) {
      const marker = readMarker(join(root, key, v), markers);
      const rel = marker?.bins[name];
      if (rel && isFile(join(root, key, v, rel))) return { path: join(root, key, v, rel), version: marker.version };
    }
  }
  return null;
}

/** env: FERRET_VIDEO_<TOOL>、managed: ~/.ferret/video/tools、legacy: 旧 ~/.solocut/tools（読むだけ）、path: PATH */
export type ToolSource = 'env' | 'managed' | 'legacy' | 'path';

export function resolveToolSync(
  name: ToolName,
  o: { manifest?: ToolManifest; platform?: Platform | null; probe?: (path: string) => string | null } = {},
): { path: string; source: ToolSource; version?: string } | null {
  const env = process.env[ENV_VARS[name]];
  if (env && (name === 'fonts' ? existsSync(env) : isFile(env))) return { path: env, source: 'env' };
  let plat: Platform | null = null;
  if (o.platform !== undefined) plat = o.platform;
  else {
    try {
      plat = currentPlatform();
    } catch {
      plat = null;
    }
  }
  const managed = managedPath(name, o.manifest ?? DEFAULT_MANIFEST, plat);
  if (managed) return { path: managed.path, source: managed.legacy ? 'legacy' : 'managed', version: managed.version };
  // ffmpeg は PATH に何本あっても、字幕を描ける（libass 入りの）ものを先に使う。無ければ最初のもの（書き出しの時に入れ方を案内する）
  const found = PATH_NAMES[name].flatMap((cmd) => whichAll(cmd));
  if (name === 'ffmpeg' && found.length > 1) {
    const withLibass = found.find((p) => ffmpegHasLibass(p, o.probe ? { probe: o.probe } : {}));
    if (withLibass) return { path: withLibass, source: 'path' };
  }
  return found[0] ? { path: found[0], source: 'path' } : null;
}

/** PATH 上の cmd を全部（前から順に） */
function whichAll(cmd: string, env: NodeJS.ProcessEnv = process.env): string[] {
  const out: string[] = [];
  for (const d of envPath(env).split(process.platform === 'win32' ? ';' : delimiter).filter(Boolean)) {
    const p = whichSync(cmd, { PATH: d, ...(process.platform === 'win32' && env.PATHEXT ? { PATHEXT: env.PATHEXT } : {}) });
    if (p && !out.includes(p)) out.push(p);
  }
  return out;
}

// ---------- libass（字幕・図解・テロップの描画）を持つ ffmpeg か ----------

/** `ffmpeg -filters` の出力に subtitles か ass のフィルタがあるか */
export function filtersHaveLibass(filters: string): boolean {
  return /^\s*\S+\s+(?:subtitles|ass)\s+\S+->\S+/m.test(filters);
}

const libassMemo = new Map<string, boolean | null>();
interface LibassCacheEntry { mtimeMs: number; size: number; libass: boolean }

function libassCacheFile(): string {
  return join(videoHome(), 'cache', 'ffmpeg-libass.json');
}

function readLibassCache(): Record<string, LibassCacheEntry> {
  try {
    const o = JSON.parse(readFileSync(libassCacheFile(), 'utf8')) as unknown;
    return o && typeof o === 'object' && !Array.isArray(o) ? (o as Record<string, LibassCacheEntry>) : {};
  } catch {
    return {};
  }
}

/**
 * この ffmpeg が字幕を描けるか（libass 入りか）。`ffmpeg -hide_banner -filters` で確かめ、ファイルの更新時刻と大きさごとに
 * $FERRET_VIDEO_HOME/cache/ffmpeg-libass.json と memory に覚える。実行できなければ null（分からない）。
 * probe はテスト用（-filters の出力を返す。失敗は null）。
 */
export function ffmpegHasLibass(path: string, o: { probe?: (path: string) => string | null } = {}): boolean | null {
  let st: { mtimeMs: number; size: number };
  try {
    const s = statSync(path);
    st = { mtimeMs: Math.round(s.mtimeMs), size: s.size };
  } catch {
    return null;
  }
  const key = `${path}\0${st.mtimeMs}\0${st.size}`;
  if (libassMemo.has(key)) return libassMemo.get(key)!;
  const cache = readLibassCache();
  const hit = cache[path];
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size && typeof hit.libass === 'boolean') {
    libassMemo.set(key, hit.libass);
    return hit.libass;
  }
  const probe = o.probe ?? ((p: string) => {
    try {
      // ffmpeg is an .exe (never a .cmd shim), so it runs directly without a shell
      return execFileSync(p, ['-hide_banner', '-filters'], { encoding: 'utf8', timeout: 10_000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      return null;
    }
  });
  const out = probe(path);
  if (out === null) {
    libassMemo.set(key, null);
    return null;
  }
  const libass = filtersHaveLibass(out);
  libassMemo.set(key, libass);
  try {
    mkdirSync(dirname(libassCacheFile()), { recursive: true });
    writeFileSync(libassCacheFile(), JSON.stringify({ ...cache, [path]: { ...st, libass } }, null, 2) + '\n');
  } catch {
    /* キャッシュに書けなくても判定は使える */
  }
  return libass;
}

/** テスト用: memory の判定を忘れる */
export function resetLibassCache(): void {
  libassMemo.clear();
}

/** env FERRET_VIDEO_<TOOL> → ~/.ferret/video/tools/<tool>/<version>/ → 旧 ~/.solocut/tools（読むだけ）→ PATH（ffmpeg は libass 入りを先に）→ null */
export async function resolveTool(name: ToolName, o: { manifest?: ToolManifest; platform?: Platform | null } = {}): Promise<string | null> {
  return resolveToolSync(name, o)?.path ?? null;
}

export function sha256File(path: string): Promise<string> {
  return new Promise((res, rej) => {
    const h = createHash('sha256');
    createReadStream(path)
      .on('data', (c) => h.update(c))
      .on('error', rej)
      .on('end', () => res(h.digest('hex')));
  });
}

export interface EnsureOptions {
  onProgress?: (p: { received: number; total?: number }) => void;
  manifest?: ToolManifest;
  platform?: Platform;
  signal?: AbortSignal;
}

const inflight = new Map<string, Promise<string>>();

/** Make sure a managed copy of `name` exists: download, verify sha256, extract, chmod +x, atomic rename. Returns its path. */
export function ensureTool(name: ToolName, o: EnsureOptions = {}): Promise<string> {
  const manifest = o.manifest ?? DEFAULT_MANIFEST;
  const plat = o.platform ?? currentPlatform();
  const match = findAsset(manifest, name, plat);
  if (!match) {
    // no build for this platform (e.g. whisper-cli on macOS): fall back to PATH
    for (const cmd of PATH_NAMES[name]) {
      const p = whichSync(cmd);
      if (p) return Promise.resolve(p);
    }
    const hint = name === 'whisper-cli' && plat.os === 'mac' ? ' (install it with `brew install whisper-cpp`)' : '';
    return Promise.reject(new ToolchainError('no-asset', `no download of ${name} for ${plat.os}/${plat.arch}${hint}`));
  }
  const dir = join(toolsDir(), match.toolKey, match.version);
  const rel = match.asset.bin[name]!;
  if (readMarker(dir) && isFile(join(dir, rel))) return Promise.resolve(join(dir, rel));
  // 旧 Solocut の置き場に同じ版が入っていれば、それを読むだけで使う（落とし直さない）
  const legacy = legacyToolsDir();
  if (legacy && resolve(legacy) !== resolve(toolsDir())) {
    const old = join(legacy, match.toolKey, match.version);
    if (readMarker(old, [LEGACY_TOOL_MARKER, MARKER]) && isFile(join(old, rel))) return Promise.resolve(join(old, rel));
  }
  const hashes = match.asset.kind === 'bundle' ? (match.asset.parts ?? []).map((x) => [x.url, x.sha256] as const) : [[match.asset.url, match.asset.sha256] as const];
  const bad = hashes.find(([, h]) => !/^[0-9a-fA-F]{64}$/.test(h));
  if (bad || (match.asset.kind === 'bundle' && !hashes.length)) {
    return Promise.reject(new ToolchainError('checksum', `the manifest has no valid sha256 for ${bad?.[0] ?? match.asset.url} ("${bad?.[1] ?? ''}"); refusing to install`));
  }
  const key = dir;
  let p = inflight.get(key);
  if (!p) {
    p = install(match, dir, o).finally(() => inflight.delete(key));
    inflight.set(key, p);
  }
  return p.then((d) => join(d, rel));
}

async function download(url: string, dest: string, o: EnsureOptions): Promise<{ sha256: string; received: number }> {
  let res: Response;
  try {
    res = await fetch(url, { signal: o.signal, redirect: 'follow' });
  } catch (e) {
    if (o.signal?.aborted) throw new ToolchainError('aborted', 'download aborted');
    throw new ToolchainError('download', `download failed: ${url}: ${(e as Error).message}`);
  }
  if (!res.ok || !res.body) throw new ToolchainError('download', `download failed: ${url}: HTTP ${res.status}`);
  const lenHeader = res.headers.get('content-length');
  const total = lenHeader && /^\d+$/.test(lenHeader) ? Number(lenHeader) : undefined;
  const h = createHash('sha256');
  let received = 0;
  let lastReport = 0;
  const meter = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      received += chunk.length;
      h.update(chunk);
      const now = Date.now();
      if (o.onProgress && (now - lastReport > 100 || received === total)) {
        lastReport = now;
        o.onProgress(total === undefined ? { received } : { received, total });
      }
      cb(null, chunk);
    },
  });
  try {
    await pipeline(Readable.fromWeb(res.body as import('node:stream/web').ReadableStream), meter, createWriteStream(dest));
  } catch (e) {
    if (o.signal?.aborted) throw new ToolchainError('aborted', 'download aborted');
    throw new ToolchainError('download', `download interrupted after ${received} bytes: ${(e as Error).message}`);
  }
  if (total !== undefined && received !== total) {
    throw new ToolchainError('download', `download incomplete: ${received} of ${total} bytes`);
  }
  o.onProgress?.(total === undefined ? { received } : { received, total });
  return { sha256: h.digest('hex'), received };
}

function runTar(archive: string, dest: string): Promise<void> {
  return new Promise((res, rej) => {
    const p = spawn('tar', ['-xf', archive, '-C', dest], { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d) => (err += String(d)));
    p.on('error', (e) => rej(new ToolchainError('extract', `tar not available: ${e.message}`)));
    p.on('close', (code) => (code === 0 ? res() : rej(new ToolchainError('extract', `tar exited ${code}: ${err.trim()}`))));
  });
}

async function install(m: AssetMatch, finalDir: string, o: EnsureOptions): Promise<string> {
  const staging = join(toolsDir(), '.staging', `${m.toolKey}-${randomBytes(6).toString('hex')}`);
  const root = join(staging, 'root');
  await mkdir(root, { recursive: true });
  try {
    const a = m.asset;
    if (a.kind === 'bundle') {
      // several archives → one flat folder of the listed files
      const parts = a.parts ?? [];
      const total = parts.every((x) => x.size) ? parts.reduce((n, x) => n + x.size!, 0) : undefined;
      let done = 0;
      for (const [i, part] of parts.entries()) {
        const file = join(staging, `part-${i}.${part.kind}`);
        const { sha256, received } = await download(part.url, file, {
          ...o, onProgress: o.onProgress ? (pr) => o.onProgress!(total === undefined ? { received: done + pr.received } : { received: done + pr.received, total }) : undefined,
        } as EnsureOptions);
        done += received;
        if (sha256 !== part.sha256.toLowerCase()) throw new ToolchainError('checksum', `sha256 mismatch for ${part.url}: expected ${part.sha256}, got ${sha256}`);
        const out = join(staging, `part-${i}`);
        await mkdir(out, { recursive: true });
        if (part.kind === 'zip') await extractZip(file, out);
        else await runTar(file, out);
        for (const [dest, src] of Object.entries(part.files)) {
          if (dest !== basename(dest) || dest.startsWith('.')) throw new ToolchainError('extract', `invalid bundle file name: ${dest}`);
          const from = join(out, src);
          if (!isFile(from)) throw new ToolchainError('missing-bin', `${src} not found in ${part.url}`);
          await copyFile(from, join(root, dest));
        }
      }
    } else {
      const file = a.kind === 'file' ? join(root, Object.values(a.bin)[0]!) : join(staging, `download.${a.kind}`);
      const { sha256 } = await download(a.url, file, o);
      if (sha256 !== a.sha256.toLowerCase()) {
        throw new ToolchainError('checksum', `sha256 mismatch for ${a.url}: expected ${a.sha256}, got ${sha256}`);
      }
      if (a.kind === 'zip') await extractZip(file, root);
      else if (a.kind !== 'file') await runTar(file, root);
    }
    for (const rel of Object.values(a.bin)) {
      const p = join(root, rel);
      if (!isFile(p)) throw new ToolchainError('missing-bin', `${rel} not found in ${a.url}`);
      if (a.kind !== 'file' && a.kind !== 'bundle' && process.platform !== 'win32') await chmod(p, 0o755);
    }
    const marker: Marker = { tool: m.toolKey, version: m.version, url: a.url, sha256: a.sha256, bins: a.bin, installedAt: new Date().toISOString() };
    await writeFile(join(root, MARKER), JSON.stringify(marker, null, 2));
    await mkdir(dirname(finalDir), { recursive: true });
    if (existsSync(finalDir)) {
      if (readMarker(finalDir)) return finalDir; // another process won the race
      await rm(finalDir, { recursive: true, force: true }); // half-installed leftovers
    }
    await rename(root, finalDir);
    return finalDir;
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

export interface ToolState {
  installed: boolean;
  path?: string;
  version?: string;
  source?: ToolSource;
  /** ffmpeg だけ: 字幕を描けるか（libass 入りか）。確かめられなければ無し */
  libass?: boolean;
}

function execVersion(bin: string): Promise<string | undefined> {
  // ffmpeg / ffprobe / whisper are executables (never .cmd shims), so they run directly without a shell
  return new Promise((res) => {
    try {
      execFile(bin, ['-version'], { timeout: 5000, windowsHide: true }, (err, stdout) => {
        if (err) return res(undefined);
        const m = /version\s+(\S+)/.exec(String(stdout));
        res(m?.[1]);
      });
    } catch {
      // Windows refuses to start a .cmd / .bat without a shell (EINVAL, thrown before any callback): no version
      res(undefined);
    }
  });
}

/** Folder of the managed fonts (or $FERRET_VIDEO_FONTS), or null when not installed. */
export function fontsDir(): string | null {
  const r = resolveToolSync('fonts');
  if (!r) return null;
  return r.source === 'env' ? r.path : dirname(r.path);
}

export async function toolStatus(o: { manifest?: ToolManifest; probeVersions?: boolean } = {}): Promise<Record<ToolName, ToolState>> {
  const out = {} as Record<ToolName, ToolState>;
  for (const name of TOOL_NAMES) {
    const r = resolveToolSync(name, o.manifest ? { manifest: o.manifest } : {});
    if (!r) {
      out[name] = { installed: false };
      continue;
    }
    let version = r.version;
    if (!version && o.probeVersions !== false && (name === 'ffmpeg' || name === 'ffprobe')) version = await execVersion(r.path);
    const libass = name === 'ffmpeg' && o.probeVersions !== false ? ffmpegHasLibass(r.path) : null;
    out[name] = { installed: true, path: r.path, source: r.source, ...(version ? { version } : {}), ...(libass !== null ? { libass } : {}) };
  }
  return out;
}

/** Remove a managed tool (all versions). */
export async function removeTool(toolKey: string): Promise<void> {
  const dir = join(toolsDir(), toolKey);
  if (!dir.startsWith(toolsDir() + sep)) throw new Error('invalid tool key');
  await rm(dir, { recursive: true, force: true });
}
