import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyProcessDefaults, runVideoCli, setVideoCliBaseEnvForTest } from '../../../../src/video/app/main/cli/run';
import { VIDEO_BIN_ENV } from '@video/names';

// runVideoCli: main の中で CLI を同じプロセスで動かす（撮影・動画タブ・投稿の作業者が使う）
let dir: string;
let saved: NodeJS.ProcessEnv;
beforeEach(() => {
  saved = { ...process.env };
  dir = mkdtempSync(join(tmpdir(), 'ferret-video-run-'));
  process.env.FERRET_VIDEO_HOME = join(dir, 'home');
  process.env.FERRET_VIDEO_DECISION_PROVIDER = 'off';
  mkdirSync(join(dir, 'fonts'));
  process.env.FERRET_VIDEO_FONTS = join(dir, 'fonts');
  for (const k of ['CLAUDECODE', 'CODEX_SANDBOX', 'GEMINI_CLI', 'FERRET_VIDEO_AGENT', 'FERRET_VIDEO_BY']) delete process.env[k];
});
afterEach(() => {
  setVideoCliBaseEnvForTest(null);
  for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
  for (const [k, v] of Object.entries(saved)) process.env[k] = v;
  rmSync(dir, { recursive: true, force: true });
});

describe('runVideoCli', () => {
  it('help and version: code 0, output collected, nothing on stderr', async () => {
    const h = await runVideoCli(['--help'], { cwd: dir });
    expect(h.code).toBe(0);
    expect(h.stdout.startsWith('ferret-video ')).toBe(true);
    expect(h.stderr).toBe('');
    const v = await runVideoCli(['version', '--json'], { cwd: dir });
    expect(JSON.parse(v.stdout)).toMatchObject({ ok: true, version: expect.any(String), templatesDir: expect.stringMatching(/builtin-templates$/) });
  });

  it('usage errors are code 2, other errors code 1 with { ok: false } in --json', async () => {
    const u = await runVideoCli(['nope'], { cwd: dir });
    expect(u).toMatchObject({ code: 2, stdout: '' });
    expect(u.stderr).toContain('ferret-video: ');
    const s = await runVideoCli(['status', '--json'], { cwd: dir });
    expect(s.code).toBe(1);
    expect(JSON.parse(s.stdout).error.code).toBe('no-project');
  });

  it('init → status --json → takes --json in a video folder (cwd and --project)', async () => {
    const v = join(dir, 'channel', 'v1');
    const i = await runVideoCli(['init', v, '--title', 'はじめての動画', '--no-git', '--json'], { cwd: dir });
    expect(i.code, i.stdout + i.stderr).toBe(0);
    expect(JSON.parse(i.stdout).project).toMatchObject({ dir: v, title: 'はじめての動画', template: { id: 'tech' } });
    expect(existsSync(join(v, 'ferret-video.json'))).toBe(true);
    const st = JSON.parse((await runVideoCli(['status', '--json'], { cwd: v })).stdout);
    expect(st).toMatchObject({ ok: true, project: { dir: v } });
    expect(Array.isArray(st.steps)).toBe(true);
    const tk = JSON.parse((await runVideoCli(['takes', '--json', '--project', v], { cwd: dir })).stdout);
    expect(tk).toMatchObject({ ok: true, takes: [], imports: [], sources: [] });
    const ing = JSON.parse((await runVideoCli(['ingest', '--json'], { cwd: v })).stdout);
    expect(ing).toMatchObject({ ok: true, added: [] });
  });

  it('options.env reaches the CLI (agent attribution) and undefined removes a variable', async () => {
    const v = join(dir, 'v');
    await runVideoCli(['init', v, '--no-git', '--json'], { cwd: dir });
    process.env.FERRET_VIDEO_AGENT = 'from-process';
    await runVideoCli(['config', 'set', 'language', 'en', '--json'], { cwd: v, env: { FERRET_VIDEO_AGENT: 'codex' } });
    await runVideoCli(['config', 'set', 'language', 'ja', '--json'], { cwd: v, env: { FERRET_VIDEO_AGENT: undefined } });
    const settings = JSON.parse(readFileSync(join(dir, 'home', 'settings.json'), 'utf8'));
    expect(settings.language).toBe('ja');
    const changes = readFileSync(join(dir, 'home', 'settings.history.jsonl'), 'utf8');
    expect(changes.trim().split('\n').map((l) => JSON.parse(l).by)).toEqual(['codex', 'user']);
    expect(process.env.FERRET_VIDEO_AGENT).toBe('from-process'); // process.env は変えない
  });

  it('onStderr gets the --json progress lines as they come', async () => {
    const chunks: string[] = [];
    const r = await runVideoCli(['nope', '--json'], { cwd: dir, onStderr: (c) => chunks.push(c) });
    expect(r.code).toBe(2);
    const plain = await runVideoCli(['nope'], { cwd: dir, onStderr: (c) => chunks.push(c) });
    expect(chunks.join('')).toBe(plain.stderr);
  });

  it('calls in parallel do not mix their output', async () => {
    const dirs = [0, 1, 2, 3].map((i) => join(dir, `p${i}`));
    const rs = await Promise.all(dirs.map((d, i) => runVideoCli(['init', d, '--title', `t${i}`, '--no-git', '--json'], { cwd: dir })));
    rs.forEach((r, i) => expect(JSON.parse(r.stdout).project.title).toBe(`t${i}`));
  });

  it('an old Solocut folder gives legacy-project; after migrate it works', async () => {
    const v = join(dir, 'old');
    await runVideoCli(['init', v, '--no-git', '--json'], { cwd: dir });
    renameSync(join(v, 'ferret-video.json'), join(v, 'solocut.json'));
    renameSync(join(v, '.ferret-video'), join(v, '.solocut'));
    expect(JSON.parse((await runVideoCli(['status', '--json'], { cwd: v })).stdout).error.code).toBe('legacy-project');
    expect(JSON.parse((await runVideoCli(['migrate', '--json'], { cwd: v })).stdout).migrated).toHaveLength(1);
    expect(JSON.parse((await runVideoCli(['status', '--json'], { cwd: v })).stdout).ok).toBe(true);
  });

  it('the app-wide values fill process.env only where it has none', async () => {
    process.env.FERRET_VIDEO_WHISPER_CLI = '/mine';
    setVideoCliBaseEnvForTest({ FERRET_VIDEO_WHISPER_CLI: '/ferret', FERRET_VIDEO_WHISPER_MODEL: '/model', [VIDEO_BIN_ENV]: '/bin' });
    await runVideoCli(['version'], { cwd: dir });
    expect(process.env.FERRET_VIDEO_WHISPER_CLI).toBe('/mine');
    expect(process.env.FERRET_VIDEO_WHISPER_MODEL).toBe('/model');
    expect(process.env[VIDEO_BIN_ENV]).toBeUndefined();
  });
});

describe('applyProcessDefaults', () => {
  it('fills missing and empty values, keeps set ones, never the bin variable', () => {
    const target: NodeJS.ProcessEnv = { A: 'keep', B: '' };
    applyProcessDefaults({ A: 'x', B: 'y', C: 'z', [VIDEO_BIN_ENV]: '/b' }, target);
    expect(target).toEqual({ A: 'keep', B: 'y', C: 'z' });
  });
});
