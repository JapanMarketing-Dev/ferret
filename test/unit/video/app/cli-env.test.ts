import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildVideoEnv, cmdWrapper, ferretWhisperModels, posixWrapper, resetVideoCliEnvForTest, shQuote, videoCliBaseEnv, videoCliPaths,
  videoTerminalEnv, writeVideoCliWrappers,
  VIDEO_TEMPLATES_ENV, VIDEO_WHISPER_CLI_ENV, VIDEO_WHISPER_MODEL_ENV, VIDEO_WHISPER_MODEL_SMALL_ENV
} from '../../../../src/video/app/main/cli/env';
import type { VideoMainContext } from '../../../../src/video/app/main/context';
import { TEMPLATES_DIR_ENV } from '@video/templates';
import { VIDEO_BIN_ENV, VIDEO_ELECTRON_ENV } from '@video/names';

const posix = process.platform !== 'win32';
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ferret-video-env-'));
  resetVideoCliEnvForTest();
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function ctx(over: Partial<VideoMainContext> = {}): VideoMainContext {
  return {
    folderPath: () => null, project: () => null, send: () => undefined, mainWindow: () => null,
    userDataDir: join(dir, 'userData'), appOutDir: join(dir, 'out'), isPackaged: false,
    sendToAgent: async () => ({ ok: false, message: '' }), reportHandled: vi.fn(), ...over
  }
}

describe('names of the variables', () => {
  it('the templates variable is the one the CLI reads', () => {
    expect(VIDEO_TEMPLATES_ENV).toBe(TEMPLATES_DIR_ENV);
    expect([VIDEO_WHISPER_CLI_ENV, VIDEO_WHISPER_MODEL_ENV, VIDEO_WHISPER_MODEL_SMALL_ENV]).toEqual(['FERRET_VIDEO_WHISPER_CLI', 'FERRET_VIDEO_WHISPER_MODEL', 'FERRET_VIDEO_WHISPER_MODEL_SMALL']);
  });
});

describe('videoCliPaths', () => {
  it('bundle and templates in out/video-cli, wrappers in userData', () => {
    expect(videoCliPaths({ appOutDir: '/A/out', userDataDir: '/U' })).toEqual({
      bundle: join('/A/out', 'video-cli', 'ferret-video.mjs'), templatesDir: join('/A/out', 'video-cli', 'templates'), binDir: join('/U', 'video-cli', 'bin')
    });
  });
});

describe('shQuote / posixWrapper', () => {
  it.each([['plain', "'plain'"], ['', "''"], ["it's", "'it'\\''s'"], ['a b$c`d"e', "'a b$c`d\"e'"]])('quotes %j', (s, q) => {
    expect(shQuote(s)).toBe(q);
  });

  it('prefers FERRET_VIDEO_ELECTRON with ELECTRON_RUN_AS_NODE=1, else node', () => {
    const w = posixWrapper('/Apps/Ferret.app/x/ferret-video.mjs');
    expect(w.startsWith('#!/bin/sh\n')).toBe(true);
    expect(w).toContain(`SCRIPT='/Apps/Ferret.app/x/ferret-video.mjs'`);
    expect(w).toContain(`ELECTRON_RUN_AS_NODE=1 exec "$${VIDEO_ELECTRON_ENV}" "$SCRIPT" "$@"`);
    expect(w).toContain('exec node "$SCRIPT" "$@"');
    expect(w).not.toContain('\r');
  });

  it.skipIf(!posix)('runs: a fake Electron gets ELECTRON_RUN_AS_NODE and the args; without it node runs the script', () => {
    const odd = join(dir, "it's a dir");
    mkdirSync(odd);
    const script = join(odd, 'cli.mjs');
    writeFileSync(script, 'console.log(JSON.stringify({ via: "node", args: process.argv.slice(2) }))\n');
    const fake = join(dir, 'electron');
    writeFileSync(fake, '#!/bin/sh\necho "electron:$ELECTRON_RUN_AS_NODE:$1:$2:$3"\n');
    execFileSync('chmod', ['755', fake]);
    const bin = join(dir, 'bin');
    return writeVideoCliWrappers(bin, script, 'darwin').then(() => {
      const sh = join(bin, 'ferret-video');
      const withElectron = spawnSync(sh, ['a b', '--json'], { encoding: 'utf8', env: { ...process.env, [VIDEO_ELECTRON_ENV]: fake } });
      expect(withElectron.stdout.trim()).toBe(`electron:1:${script}:a b:--json`);
      // 実行できない FERRET_VIDEO_ELECTRON は使わない
      const nodeDir = join(dir, 'nodebin');
      mkdirSync(nodeDir);
      writeFileSync(join(nodeDir, 'node'), `#!/bin/sh\nexec "${process.execPath}" "$@"\n`);
      execFileSync('chmod', ['755', join(nodeDir, 'node')]);
      for (const e of [undefined, join(dir, 'missing'), '']) {
        const env: NodeJS.ProcessEnv = { ...process.env, PATH: `${nodeDir}:/usr/bin:/bin` };
        delete env[VIDEO_ELECTRON_ENV];
        if (e !== undefined) env[VIDEO_ELECTRON_ENV] = e;
        const r = spawnSync(sh, ['x'], { encoding: 'utf8', env });
        expect(JSON.parse(r.stdout), r.stderr).toEqual({ via: 'node', args: ['x'] });
      }
    });
  });
});

describe('cmdWrapper', () => {
  it('is CRLF, escapes % and falls back to node', () => {
    const w = cmdWrapper('C:\\Program Files\\Ferret\\100%\\ferret-video.mjs');
    expect(w.split('\r\n')[0]).toBe('@echo off');
    expect(w.replace(/\r\n/g, '')).not.toContain('\n');
    expect(w).toContain('set "SCRIPT=C:\\Program Files\\Ferret\\100%%\\ferret-video.mjs"');
    expect(w).toContain(`if not defined ${VIDEO_ELECTRON_ENV} goto node`);
    expect(w).toContain(`"%${VIDEO_ELECTRON_ENV}%" "%SCRIPT%" %*`);
    expect(w).toContain('node "%SCRIPT%" %*');
    expect(w.endsWith('\r\n')).toBe(true);
  });
});

describe('writeVideoCliWrappers', () => {
  it.skipIf(!posix)('writes both wrappers (sh executable) and overwrites them', async () => {
    const bin = join(dir, 'b', 'c');
    await writeVideoCliWrappers(bin, '/old.mjs', 'darwin');
    await writeVideoCliWrappers(bin, '/new.mjs', 'darwin');
    expect(statSync(join(bin, 'ferret-video')).mode & 0o777).toBe(0o755);
    expect(readFileSync(join(bin, 'ferret-video'), 'utf8')).toContain("SCRIPT='/new.mjs'");
    expect(readFileSync(join(bin, 'ferret-video.cmd'), 'utf8')).toContain('set "SCRIPT=/new.mjs"');
  });

  it('on Windows writes only the .cmd', async () => {
    const bin = join(dir, 'w');
    await writeVideoCliWrappers(bin, 'C:\\x.mjs', 'win32');
    expect(existsSync(join(bin, 'ferret-video.cmd'))).toBe(true);
    expect(existsSync(join(bin, 'ferret-video'))).toBe(false);
  });
});

describe('buildVideoEnv', () => {
  it('only sets what is known', () => {
    expect(buildVideoEnv({})).toEqual({});
    expect(buildVideoEnv({ binDir: '', electron: null, templatesDir: undefined, whisper: { cli: null, model: '', modelSmall: undefined } })).toEqual({});
    expect(buildVideoEnv({ binDir: '/b', electron: '/e', templatesDir: '/t', whisper: { cli: '/w', model: '/m', modelSmall: '/s' } })).toEqual({
      [VIDEO_BIN_ENV]: '/b', [VIDEO_ELECTRON_ENV]: '/e', FERRET_VIDEO_TEMPLATES_DIR: '/t',
      FERRET_VIDEO_WHISPER_CLI: '/w', FERRET_VIDEO_WHISPER_MODEL: '/m', FERRET_VIDEO_WHISPER_MODEL_SMALL: '/s'
    });
  });
});

describe('ferretWhisperModels', () => {
  const U = '/U';
  const H = '/H';
  const large = join(U, 'models', 'ggml-large-v3-turbo.bin');
  const small = join(H, '.cache', 'ade-movie', 'models', 'ggml-small.bin');
  const has = (...p: string[]) => (x: string) => p.includes(x);

  it('nothing found → nothing', () => {
    expect(ferretWhisperModels({ userDataDir: U, home: H, exists: () => false })).toEqual({});
  });
  it('the downloaded large model and the cached small one go to their slots', () => {
    expect(ferretWhisperModels({ userDataDir: U, home: H, exists: has(large, small) })).toEqual({ model: large, modelSmall: small });
  });
  it('ADE_WHISPER_MODEL wins its slot; a missing one is ignored', () => {
    expect(ferretWhisperModels({ adeWhisperModel: '/x/ggml-medium.bin', userDataDir: U, home: H, exists: has('/x/ggml-medium.bin', large) })).toEqual({ model: '/x/ggml-medium.bin' });
    expect(ferretWhisperModels({ adeWhisperModel: '/x/My-SMALL.bin', userDataDir: U, home: H, exists: has('/x/My-SMALL.bin', small, large) })).toEqual({ model: large, modelSmall: '/x/My-SMALL.bin' });
    expect(ferretWhisperModels({ adeWhisperModel: '/gone.bin', userDataDir: U, home: H, exists: has(small) })).toEqual({ modelSmall: small });
  });
  it('only the file name decides small (a folder called small does not)', () => {
    expect(ferretWhisperModels({ adeWhisperModel: '/small/ggml-large.bin', userDataDir: U, home: H, exists: has('/small/ggml-large.bin') })).toEqual({ model: '/small/ggml-large.bin' });
  });
});

describe('videoTerminalEnv', () => {
  it.skipIf(!posix)('writes the wrappers once, returns bin + Electron (+ templates when built)', async () => {
    const c = ctx();
    mkdirSync(join(dir, 'out', 'video-cli', 'templates'), { recursive: true });
    const a = await videoTerminalEnv(c);
    expect(a[VIDEO_BIN_ENV]).toBe(join(dir, 'userData', 'video-cli', 'bin'));
    expect(a[VIDEO_ELECTRON_ENV]).toBe(process.execPath);
    expect(a.FERRET_VIDEO_TEMPLATES_DIR).toBe(join(dir, 'out', 'video-cli', 'templates'));
    expect(readFileSync(join(a[VIDEO_BIN_ENV]!, 'ferret-video'), 'utf8')).toContain(join(dir, 'out', 'video-cli', 'ferret-video.mjs'));
    rmSync(join(a[VIDEO_BIN_ENV]!, 'ferret-video'));
    const b = await videoTerminalEnv(c);
    expect(b).toEqual(a);
    expect(b).not.toBe(a); // 呼び出し側が書き換えても共有の値は変わらない
    expect(existsSync(join(a[VIDEO_BIN_ENV]!, 'ferret-video'))).toBe(false); // 2回目は書き直さない
  });

  it('no templates yet (not built) → no templates variable; a write failure is reported and bin is left out', async () => {
    const blocker = join(dir, 'userData');
    writeFileSync(blocker, 'a file where the folder should be');
    const c = ctx();
    const env = await videoCliBaseEnv(c);
    expect(env[VIDEO_BIN_ENV]).toBeUndefined();
    expect(env.FERRET_VIDEO_TEMPLATES_DIR).toBeUndefined();
    expect(env[VIDEO_ELECTRON_ENV]).toBe(process.execPath);
    expect(c.reportHandled).toHaveBeenCalledWith(expect.anything(), { area: 'video', op: 'cli-wrappers' });
  });
});
