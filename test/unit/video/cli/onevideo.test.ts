import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Sandbox } from './helpers.js';

// One template, one 16:9 video, no decision model (requests 3, 10, 12, 16).

let sb: Sandbox;
let dir: string;
beforeEach(async () => {
  sb = new Sandbox();
  dir = join(sb.root, 'video');
  const r = await sb.run(['init', dir, '--title', '設定のコツ', '--no-git', '--json']);
  expect(r.json, r.stdout).toMatchObject({ ok: true });
});
afterEach(() => sb.dispose());

const run = (args: string[], env?: Record<string, string>) => sb.run([...args, '--json'], { cwd: dir, ...(env ? { env } : {}) });
const timeline = () => JSON.parse(readFileSync(join(dir, 'timeline.json'), 'utf8'));
const decided = { by: 'agent', reason: 't' };
const cam = (path: string, role = 'front') => ({ kind: 'camera', path, take: 'take_1', role, fps: { num: 30, den: 1 }, size: { width: 1920, height: 1080 }, offset: 0 });
const scr = { kind: 'screen', path: 'media/s.mp4', take: 'take_1', display: 'main', fps: { num: 30, den: 1 }, size: { width: 1920, height: 1080 }, offset: 0 };
const seg = (id: string, from: number, to: number, video: object) => ({ id, range: { start: 0, end: 0 }, src: { from, to, take: 'take_1' }, text: id, chapter: 'ch_1', role: 'explain', video, decided });

/** A face track as the desktop writes it (5 samples a second, f in source frames). */
function faces(sec: number, x: number, y: number) {
  return {
    schema: 1, source: 'cam', fps: 5, sourceFps: 30, width: 1920, height: 1080,
    frames: Array.from({ length: sec * 5 + 1 }, (_, i) => ({ f: i * 6, t: i / 5, faces: [{ x: x - 0.05, y: y - 0.09, w: 0.1, h: 0.18, score: 0.9 }] })),
  };
}

describe('init: the one template', () => {
  it('uses tech by default: one youtube target, no derive / publish steps, AGENTS.md about publish.json', async () => {
    const p = JSON.parse(readFileSync(join(dir, 'ferret-video.json'), 'utf8'));
    expect(p.template.id).toBe('tech');
    expect(timeline().meta.targets).toEqual(['youtube']);
    const st = (await run(['status'])).json.steps.map((s: { step: string }) => s.step);
    expect(st).toEqual(['ingest', 'sync', 'analyze', 'transcribe', 'rough-cut', 'multicam', 'captions', 'layout', 'sfx', 'masks', 'preview', 'check', 'final', 'thumbnail', 'metadata']);
    const md = readFileSync(join(dir, 'AGENTS.md'), 'utf8');
    expect(md).toContain('publish.json');
    expect(md).not.toMatch(/ferret-video derive|--variant/);
  });

  it('the derive command and --variant hints are gone from help; the CLI still answers', async () => {
    expect((await sb.run(['derive', '--target', 'tiktok', '--json'], { cwd: dir })).code).toBe(2);
    const help = await sb.run(['help']);
    expect(help.stdout).not.toMatch(/derive|--variant|3本/);
    expect(help.stdout).toContain('publish.json');
  });
});

describe('no decision model: `next --autopilot` reaches done with one video', () => {
  it('walks every step to done (the agent marks steps, writes publish.json and picks a thumbnail)', async () => {
    await run(['edit', '--ops', JSON.stringify([{ op: 'addSource', id: 'cam', source: cam('media/c.mp4') }, { op: 'addSource', id: 'scr', source: scr }])]);
    mkdirSync(join(dir, 'derived', 'transcripts'), { recursive: true });
    writeFileSync(join(dir, 'derived', 'transcripts', 'main.json'), JSON.stringify({ take: 'take_1', words: [] }));
    const seen: string[] = [];
    for (let i = 0; i < 40; i++) {
      const n = (await run(['next', '--autopilot'])).json;
      expect(n.ok, JSON.stringify(n)).toBe(true);
      if (n.state === 'done') break;
      expect(n.state, JSON.stringify(n)).toBe('ready');
      expect(n.commands.length).toBeGreaterThan(0);
      seen.push(n.step);
      if (n.step === 'metadata') {
        expect((await run(['meta', 'set', '--title', '設定は3つだけ', '--description', '要点', '--tags', 'claude,設定'])).json.valid).toBe(true);
      } else if (n.step === 'thumbnail') {
        mkdirSync(join(dir, 'thumbnails'), { recursive: true });
        writeFileSync(join(dir, 'thumbnails', 'thumb-1.png'), Buffer.alloc(64, 1));
        expect((await run(['thumb', 'pick', join(dir, 'thumbnails', 'thumb-1.png')])).json.ok).toBe(true);
      } else {
        await run(['step', n.step, 'done']);
      }
    }
    // one camera → multicam passes by itself; nothing derived, nothing published
    expect(seen).toEqual(['ingest', 'sync', 'analyze', 'transcribe', 'rough-cut', 'captions', 'layout', 'sfx', 'masks', 'preview', 'check', 'final', 'thumbnail', 'metadata']);
    const last = (await run(['next', '--autopilot'])).json;
    expect(last).toMatchObject({ step: 'done', state: 'done' });
    expect(last.do).toContain('投稿はしないでください');
    // nothing called a decision model
    expect(readFileSync(join(dir, '.ferret-video', 'decisions.jsonl'), 'utf8')).toBe('');
  });

  it('a check the agent cannot fix is parked as needs-human and autopilot still finishes', async () => {
    await run(['edit', '--ops', JSON.stringify([{ op: 'addSource', id: 'cam', source: cam('media/c.mp4') }, { op: 'setReview', patch: { lastCheck: { run: 'chk_1', passed: 5, failed: 1, needsHuman: 0, at: '2026-10-11T00:00:00Z' } } }])]);
    mkdirSync(join(dir, 'derived', 'transcripts'), { recursive: true });
    writeFileSync(join(dir, 'derived', 'transcripts', 'main.json'), '{"take":"take_1","words":[]}');
    for (const s of ['ingest', 'sync', 'analyze', 'transcribe', 'rough-cut', 'captions', 'layout', 'sfx', 'masks', 'preview', 'check']) await run(['step', s, 'done']);
    const n = (await run(['next', '--autopilot'])).json;
    expect(n).toMatchObject({ step: 'check', state: 'ready' });
    expect(n.do).toContain('needs-human');
    await run(['step', 'check', 'needs-human', '--note', 'マイクの音が小さい']);
    expect((await run(['next', '--autopilot'])).json.step).toBe('final');
    expect((await run(['next'])).json).toMatchObject({ step: 'check', state: 'needs-human', why: 'マイクの音が小さい' });
  });
});

describe('person centred (tracks apply)', () => {
  async function seedCamera(video: object) {
    const ops = [
      { op: 'addSource', id: 'cam', source: cam('media/c.mp4') },
      { op: 'addSource', id: 'scr', source: scr },
      { op: 'setOutline', outline: [{ id: 'ch_1', title: 'a', start: 0, end: 300, points: [], importance: 'core' }] },
      { op: 'addSegment', segment: seg('seg_1', 0, 150, video) },
      { op: 'addSegment', segment: seg('seg_2', 150, 300, { layout: 'screen-full', screen: 'scr' }) },
    ];
    expect((await run(['edit', '--ops', JSON.stringify(ops)])).json.ok).toBe(true);
  }

  it('the template turns centring on: an off-centre face gets a magnified crop toward it', async () => {
    await seedCamera({ layout: 'camera-full', camera: 'cam' });
    mkdirSync(join(dir, 'derived', 'analysis'), { recursive: true });
    writeFileSync(join(dir, 'derived', 'analysis', 'faces.cam.json'), JSON.stringify(faces(12, 0.7, 0.4)));
    const r = await run(['tracks', 'apply']);
    expect(r.json, r.stdout).toMatchObject({ ok: true, center: { centered: ['seg_1'], noFace: [], noTrack: [] } });
    const v = timeline().segments[0].video;
    expect(v.scale).toBeGreaterThan(1);
    expect(v.focus.x ?? v.focus[0].x).toBeGreaterThan(0.5);
    expect(timeline().segments[1].video).toEqual({ layout: 'screen-full', screen: 'scr' });
    expect((await run(['validate'])).json.ok).toBe(true);
    // undo restores the plain crop in one step
    await run(['undo']);
    expect(timeline().segments[0].video).toEqual({ layout: 'camera-full', camera: 'cam' });
  });

  it('the wipe camera is centred too; --no-center leaves crops alone; no face file → reported', async () => {
    await seedCamera({ layout: 'screen-with-wipe', screen: 'scr', camera: 'cam', wipe: { shape: 'circle', corner: 'br', style: 'plain' } });
    const none = await run(['tracks', 'apply']);
    expect(none.json.center).toEqual({ centered: [], noFace: [], noTrack: ['seg_1'] });
    mkdirSync(join(dir, 'derived', 'analysis'), { recursive: true });
    writeFileSync(join(dir, 'derived', 'analysis', 'faces.cam.json'), JSON.stringify(faces(12, 0.65, 0.4)));
    expect((await run(['tracks', 'apply', '--no-center'])).json.center).toBe(false);
    expect(timeline().segments[0].video.cameraFocus).toBeUndefined();
    await run(['tracks', 'apply']);
    expect(timeline().segments[0].video.cameraFocus).toBeDefined();
    expect((await run(['tracks', 'apply', '--center', '--no-center'])).code).toBe(2);
  });

  it('multicam material names the person camera and a deterministic choice per segment', async () => {
    const ops = [
      { op: 'addSource', id: 'cam_a', source: cam('media/a.mp4', 'other') },
      { op: 'addSource', id: 'cam_b', source: cam('media/b.mp4', 'front') },
      { op: 'setOutline', outline: [{ id: 'ch_1', title: 'a', start: 0, end: 300, points: [], importance: 'core' }] },
      { op: 'addSegment', segment: seg('seg_1', 0, 300, { layout: 'camera-full', camera: 'cam_a' }) },
    ];
    await run(['edit', '--ops', JSON.stringify(ops)]);
    const m = await run(['multicam', 'material']);
    expect(m.json, m.stdout).toMatchObject({ ok: true, person: 'cam_b', suggestions: [{ segment: 'seg_1', camera: 'cam_b', reason: 'person', needsReview: false }] });
    expect(existsSync(join(dir, '.ferret-video', 'decisions.jsonl'))).toBe(true);
  });
});
