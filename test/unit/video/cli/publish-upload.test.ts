import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RESULT_FILE, REQUEST_FILE, parseTargets, readHandoffResult, waitForResult, withdrawRequest, type HandoffResult } from '@video/cli/commands/publish.js';
import { Sandbox } from './helpers.js';

let sb: Sandbox;
let dir: string;

beforeEach(async () => {
  sb = new Sandbox();
  dir = join(sb.root, 'video');
  let r = await sb.run(['init', dir, '--no-git', '--json']);
  if (r.code !== 0) r = await sb.run(['init', dir, '--template', 'talk-youtube', '--no-git', '--json']);
  expect(r.code, r.stdout + r.stderr).toBe(0);
});
afterEach(() => sb.dispose());

const writeResult = (o: unknown) => {
  mkdirSync(join(dir, '.ferret-video'), { recursive: true });
  writeFileSync(join(dir, RESULT_FILE), typeof o === 'string' ? o : JSON.stringify(o));
};
const readRequest = () => JSON.parse(readFileSync(join(dir, REQUEST_FILE), 'utf8')) as { id: string; targets: string[]; at: string; force?: boolean };
const publishJson = () => writeFileSync(join(dir, 'publish.json'), JSON.stringify({ video: 'renders/youtube/final.mp4', title: 't', description: '', tags: [] }));

/** A fake app: waits for the request, then runs the script with its id. */
function fakeApp(script: (id: string) => Promise<void> | void): Promise<void> {
  return (async () => {
    for (let i = 0; i < 400; i++) {
      if (existsSync(join(dir, REQUEST_FILE))) return script(readRequest().id);
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error('no request');
  })();
}

describe('publish upload (CLI side of the hand-off)', () => {
  it('needs publish.json', async () => {
    const r = await sb.run(['publish', 'upload', '--json'], { cwd: dir });
    expect(r.code).toBe(1);
    expect(r.json.error.code).toBe('not-found');
    expect(existsSync(join(dir, REQUEST_FILE))).toBe(false);
  });

  it('rejects unknown targets and bad timeouts (usage, exit 2)', async () => {
    publishJson();
    expect((await sb.run(['publish', 'upload', '--target', 'instagram'], { cwd: dir })).code).toBe(2);
    expect((await sb.run(['publish', 'upload', '--timeout', '0'], { cwd: dir })).code).toBe(2);
    expect((await sb.run(['publish', 'upload', '--timeout', 'soon'], { cwd: dir })).code).toBe(2);
    expect((await sb.run(['publish', 'nope'], { cwd: dir })).code).toBe(2);
  });

  it('app not running: clear message, non-zero exit, request withdrawn', async () => {
    publishJson();
    const r = await sb.run(['publish', 'upload', '--timeout', '1', '--json'], { cwd: dir });
    expect(r.code).toBe(1);
    expect(r.json.error.code).toBe('app-not-running');
    expect(r.json.error.message).toMatch(/Ferret/);
    expect(existsSync(join(dir, REQUEST_FILE))).toBe(false);
  });

  it('writes the request and prints the result with the same id', async () => {
    publishJson();
    const app = fakeApp(async (id) => {
      writeResult({ id, state: 'running', at: '', results: [], progress: { target: 'youtube', phase: 'upload', fraction: 0.5 } });
      await new Promise((r) => setTimeout(r, 50));
      writeResult({ id, state: 'done', at: '', results: [{ target: 'youtube', ok: true, url: 'https://youtu.be/x', status: 'published' }] });
    });
    const r = await sb.run(['publish', 'upload', '--target', 'youtube', '--force', '--json'], { cwd: dir });
    await app;
    expect(r.code, r.stdout).toBe(0);
    expect(r.json).toMatchObject({ ok: true, results: [{ target: 'youtube', ok: true, url: 'https://youtu.be/x' }] });
    const req = readRequest();
    expect(req).toMatchObject({ id: r.json.id, targets: ['youtube'], force: true });
    expect(Number.isNaN(Date.parse(req.at))).toBe(false);
  });

  it('human output lists each target', async () => {
    publishJson();
    const app = fakeApp((id) =>
      writeResult({ id, results: [{ target: 'youtube', ok: true, url: 'https://youtu.be/y', alreadyPublished: true }, { target: 'tiktok', ok: true, status: 'inbox', warnings: ['finish in app'] }] }),
    );
    const r = await sb.run(['publish', 'upload'], { cwd: dir });
    await app;
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/✓ youtube: .*https:\/\/youtu\.be\/y/);
    expect(r.stdout).toMatch(/✓ tiktok: inbox/);
    expect(r.stdout).toMatch(/! tiktok: finish in app/);
  });

  it('a failed target → exit 1 with the result in details', async () => {
    publishJson();
    const app = fakeApp((id) => writeResult({ id, state: 'done', results: [{ target: 'youtube', ok: true, url: 'https://youtu.be/z' }, { target: 'tiktok', ok: false, error: 'not connected' }] }));
    const r = await sb.run(['publish', 'upload', '--json'], { cwd: dir });
    await app;
    expect(r.code).toBe(1);
    expect(r.json.error.code).toBe('publish-failed');
    expect(r.json.error.message).toMatch(/tiktok/);
    expect(r.json.error.details.results).toHaveLength(2);
  });

  it('an empty result with an error (no publish target) fails', async () => {
    publishJson();
    const app = fakeApp((id) => writeResult({ id, state: 'done', results: [], error: 'no target is turned on in publish.json' }));
    const r = await sb.run(['publish', 'upload', '--json'], { cwd: dir });
    await app;
    expect(r.code).toBe(1);
    expect(r.json.error.message).toMatch(/no target/);
  });

  it('ignores a stale result of another id and malformed files until the real answer comes', async () => {
    publishJson();
    writeResult({ id: 'old-request-1', state: 'done', results: [{ target: 'youtube', ok: false, error: 'old' }] });
    const app = fakeApp(async (id) => {
      writeResult('{"id": "' + id + '", "state": "do');
      await new Promise((r) => setTimeout(r, 600));
      writeResult({ id, state: 'done', results: [{ target: 'youtube', ok: true }] });
    });
    const r = await sb.run(['publish', 'upload', '--json'], { cwd: dir });
    await app;
    expect(r.code, r.stdout).toBe(0);
  });

  it('picked up but not finished → timeout', async () => {
    publishJson();
    const app = fakeApp((id) => writeResult({ id, state: 'running', results: [] }));
    const r = await sb.run(['publish', 'upload', '--timeout', '1', '--json'], { cwd: dir });
    await app;
    expect(r.code).toBe(1);
    expect(r.json.error.code).toBe('timeout');
    expect(existsSync(join(dir, REQUEST_FILE))).toBe(true); // the app is working on it: keep it
  });

  it('publish record still works', async () => {
    const r = await sb.run(['publish', 'record', '--target', 'youtube', '--status', 'draft', '--json'], { cwd: dir });
    expect(r.code, r.stdout).toBe(0);
  });
});

describe('hand-off helpers', () => {
  it('parseTargets', () => {
    expect(parseTargets(undefined)).toEqual([]);
    expect(parseTargets(['youtube,TikTok', 'youtube', ' '])).toEqual(['youtube', 'tiktok']);
    expect(() => parseTargets(['x'])).toThrow(/youtube or tiktok/);
  });
  it('readHandoffResult: id match, defaults, junk', () => {
    expect(readHandoffResult(dir, 'abc')).toBeNull();
    writeResult('nope');
    expect(readHandoffResult(dir, 'abc')).toBeNull();
    writeResult({ id: 'other', results: [] });
    expect(readHandoffResult(dir, 'abc')).toBeNull();
    writeResult({ id: 'abc', results: [{ target: 'youtube', ok: true }, { target: 'x', ok: true }, { target: 'tiktok' }, 1] });
    expect(readHandoffResult(dir, 'abc')).toEqual({ id: 'abc', state: 'done', at: '', results: [{ target: 'youtube', ok: true }] });
    writeResult({ id: 'abc', state: 'running', progress: { target: 'youtube', phase: 'upload' }, error: '' });
    expect(readHandoffResult(dir, 'abc')).toEqual({ id: 'abc', state: 'running', at: '', results: [], progress: { target: 'youtube', phase: 'upload' } });
  });
  it('withdrawRequest removes only our request', () => {
    mkdirSync(join(dir, '.ferret-video'), { recursive: true });
    writeFileSync(join(dir, REQUEST_FILE), JSON.stringify({ id: 'mine' }));
    withdrawRequest(dir, 'theirs');
    expect(existsSync(join(dir, REQUEST_FILE))).toBe(true);
    withdrawRequest(dir, 'mine');
    expect(existsSync(join(dir, REQUEST_FILE))).toBe(false);
    withdrawRequest(dir, 'mine'); // already gone: no throw
  });
  it('waitForResult with a fake clock: pickup, progress, done, timeout', async () => {
    let t = 0;
    const clock = { now: () => t, sleep: async (ms: number) => void (t += ms) };
    expect(await waitForResult(dir, 'id1', { pickupMs: 1000, timeoutMs: 5000, pollMs: 100, ...clock })).toEqual({ kind: 'no-app' });

    t = 0;
    writeResult({ id: 'id1', state: 'running', results: [] });
    const out = await waitForResult(dir, 'id1', { pickupMs: 1000, timeoutMs: 5000, pollMs: 100, ...clock });
    expect(out.kind).toBe('timeout');
    expect(t).toBeGreaterThanOrEqual(5000);

    t = 0;
    const seen: HandoffResult[] = [];
    let step = 0;
    const sleep = async (ms: number) => {
      t += ms;
      step++;
      if (step === 2) writeResult({ id: 'id1', state: 'running', results: [], progress: { target: 'youtube', phase: 'upload', fraction: 0.4 } });
      if (step === 4) writeResult({ id: 'id1', state: 'done', results: [{ target: 'youtube', ok: true }] });
    };
    const done = await waitForResult(dir, 'id1', { pickupMs: 1000, timeoutMs: 5000, pollMs: 100, now: () => t, sleep, onProgress: (r) => void seen.push(r) });
    expect(done).toMatchObject({ kind: 'done', result: { state: 'done' } });
    expect(seen.map((r) => r.progress?.fraction)).toEqual([undefined, 0.4]); // progress reported once per change
  });
});
