import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadAnalysis } from '@video/cli/analysis.js';
import { trackChecks } from '@video/cli/commands/media.js';
import { fnv36, piiMaskId } from '@video/cli/pii.js';
import { createMcpServer } from '@video/cli/mcp.js';
import { readTimeline, type Project } from '@video/cli/project.js';
import { Sandbox } from './helpers.js';

// sfx apply / masks from-analysis / multicam material / edit split-for-switch / tracks apply / bench / track checks.
// No ffmpeg needed: library sounds carry their duration in a sidecar and analysis files are written by hand.

let sb: Sandbox;
let dir: string;
beforeEach(async () => {
  sb = new Sandbox();
  dir = join(sb.root, 'video');
  const r = await sb.run(['init', dir, '--template', 'tech', '--title', '設定のコツ', '--no-git', '--json']);
  expect(r.code).toBe(0);
});
afterEach(() => sb.dispose());

const run = (args: string[]) => sb.run([...args, '--json'], { cwd: dir });
const timeline = () => JSON.parse(readFileSync(join(dir, 'timeline.json'), 'utf8'));
const decided = { by: 'agent', reason: 't' };
const fps = { num: 30, den: 1 };
const scr = { kind: 'screen', path: 'media/takes/take_1/screen.mp4', take: 'take_1', display: 'main', fps, size: { width: 1920, height: 1080 }, offset: 0 };
const cam = { kind: 'camera', path: 'media/takes/take_1/camera-1.mp4', take: 'take_1', role: 'front', fps, size: { width: 1920, height: 1080 }, offset: 0 };
const cam2 = { ...cam, path: 'media/takes/take_1/camera-2.mp4', role: 'side' };
const wipe = { shape: 'circle', corner: 'br', style: 'plain' };
const seg = (id: string, from: number, to: number, chapter: string, video: object = { layout: 'screen-with-wipe', screen: 'scr', camera: 'cam', wipe }) =>
  ({ id, range: { start: 0, end: 0 }, src: { from, to, take: 'take_1' }, text: id, chapter, role: 'explain', video, decided });

/** 3 chapters × 10 s of screen recording with a face wipe (two cameras when `twoCams`). */
async function seed(o: { twoCams?: boolean } = {}) {
  const ops = [
    { op: 'addSource', id: 'scr', source: scr },
    { op: 'addSource', id: 'cam', source: cam },
    ...(o.twoCams ? [{ op: 'addSource', id: 'cam2', source: cam2 }] : []),
    { op: 'setOutline', outline: [
      { id: 'ch_1', title: 'はじめに', start: 0, end: 300, points: [], importance: 'core' },
      { id: 'ch_2', title: '設定', start: 300, end: 600, points: [], importance: 'core' },
      { id: 'ch_3', title: 'まとめ', start: 600, end: 900, points: [], importance: 'core' },
    ] },
    { op: 'addSegment', segment: seg('seg_1', 0, 300, 'ch_1') },
    { op: 'addSegment', segment: seg('seg_2', 300, 600, 'ch_2') },
    { op: 'addSegment', segment: seg('seg_3', 600, 900, 'ch_3', { layout: 'camera-full', camera: 'cam' }) },
  ];
  const r = await run(['edit', '--ops', JSON.stringify(ops)]);
  expect(r.json, r.stdout + r.stderr).toMatchObject({ ok: true });
}

/** A library sound (dummy bytes) with a docs/16 sidecar. */
function sound(root: string, kind: string, name: string, extra: object = {}) {
  mkdirSync(join(root, kind), { recursive: true });
  writeFileSync(join(root, kind, name), 'RIFF');
  writeFileSync(join(root, kind, `${name}.json`), JSON.stringify({ kind: 'sfx', category: kind, features: { durationMs: 300 }, license: { spdx: 'CC0-1.0' }, author: 'Kenney', title: name, ...extra }));
}

describe('sfx apply', () => {
  it('places sfx from the template rules, copies library sounds into the project, and re-runs idempotently', async () => {
    await seed();
    sound(join(sb.home, 'library', 'cache', 'sfx'), 'whoosh', 'swish.wav', { id: 'sfx_whoosh_kenney1' });
    sound(join(dir, 'assets', 'sfx'), 'pop', 'p1.wav');
    const r = await run(['sfx', 'apply']);
    expect(r.json, r.stdout + r.stderr).toMatchObject({ ok: true, removed: 0, changed: true });
    // the two files plus the built-in set (made with ffmpeg on first use)
    expect(r.json.library).toBeGreaterThanOrEqual(2);
    const section = r.json.sfx.filter((s: { trigger: string }) => s.trigger === 'section');
    expect(section.length).toBeGreaterThanOrEqual(1);
    expect(section.every((s: { asset: string }) => s.asset.startsWith('sfx_whoosh'))).toBe(true);
    // files from outside the project (cache, built-in set) were copied in; the project file is used where it is
    const tl = timeline();
    for (const [id, src] of Object.entries(tl.sources) as [string, { kind: string; path: string }][]) {
      if (src.kind === 'asset' && id.startsWith('sfx_')) expect(existsSync(join(dir, src.path)), id).toBe(true);
    }
    if (tl.sources.sfx_whoosh_kenney1) {
      expect(tl.sources.sfx_whoosh_kenney1).toMatchObject({ kind: 'asset', path: 'assets/library/sfx_whoosh_kenney1.wav', license: { id: 'CC0-1.0', credit: 'swish.wav — Kenney (CC0-1.0)' } });
    }
    expect(tl.audio.sfx.every((s: { decided: { by: string } }) => s.decided.by === 'template')).toBe(true);
    // a human sfx stays; re-running replaces only the template ones
    const anyAsset = tl.audio.sfx[0].asset;
    const mine = await run(['edit', 'addSfx', '--sfx', JSON.stringify({ id: 'sfx_mine', asset: anyAsset, at: 450, gainDb: -10, trigger: 'manual', decided: { by: 'human', reason: 'ここで鳴らす' } })]);
    expect(mine.json, mine.stdout + mine.stderr).toMatchObject({ ok: true });
    const again = await run(['sfx', 'apply']);
    expect(again.json.removed).toBe(r.json.added);
    const after = timeline().audio.sfx;
    expect(after.some((s: { id: string }) => s.id === 'sfx_mine')).toBe(true);
    expect(after.filter((s: { decided: { by: string } }) => s.decided.by === 'template').length).toBe(again.json.added);
    // the cap counts the human one: never more than maxPerMin (6) in any minute of this 30 s video
    expect(after.length).toBeLessThanOrEqual(6);
  });

  it('dry run writes nothing; missing kinds are reported; --keep adds on top', async () => {
    await seed();
    sound(join(dir, 'assets', 'sfx'), 'whoosh', 'w.wav');
    const before = JSON.stringify(timeline());
    const d = await run(['sfx', 'apply', '--dry-run']);
    expect(d.json, d.stdout + d.stderr).toMatchObject({ ok: true, dryRun: true });
    expect(d.json.added).toBeGreaterThan(0);
    expect(JSON.stringify(timeline())).toBe(before);
    // the built-in set covers every kind the template uses: nothing is reported missing
    expect(d.json.warnings.join(' ')).not.toMatch(/no library sound|ライブラリに無い/);
    const first = await run(['sfx', 'apply']);
    const kept = await run(['sfx', 'apply', '--keep']);
    expect(kept.json.removed).toBe(0);
    expect(timeline().audio.sfx.length).toBeGreaterThanOrEqual(first.json.added);
  });

  it('an empty library is filled by the built-in set (no download); same seed → same placement', async () => {
    await seed();
    const r = await run(['sfx', 'apply']);
    expect(r.json).toMatchObject({ ok: true });
    expect(r.json.library).toBeGreaterThanOrEqual(21);
    expect(r.json.added).toBeGreaterThan(0);
    expect(r.json.sfx.every((x: { asset: string }) => /_builtin_/.test(x.asset))).toBe(true);
    sound(join(dir, 'assets', 'sfx'), 'whoosh', 'a.wav');
    sound(join(dir, 'assets', 'sfx'), 'pop', 'b.wav');
    const a = await run(['sfx', 'apply', '--seed', 'x', '--dry-run']);
    const b = await run(['sfx', 'apply', '--seed', 'x', '--dry-run']);
    expect(a.json.sfx).toEqual(b.json.sfx);
  });

  it('a template without rules is an error; unknown subcommand is usage', async () => {
    await seed();
    mkdirSync(join(dir, 'templates', 'tech'), { recursive: true });
    writeFileSync(join(dir, 'templates', 'tech', 'template.yaml'), JSON.stringify({ id: 'tech', extends: 'tech', sfx: { rules: [] } }));
    expect((await run(['sfx', 'apply'])).json.error.code).toBe('no-rules');
    expect((await run(['sfx', 'nope'])).code).toBe(2);
    expect((await run(['sfx', 'apply', 'extra'])).code).toBe(2);
  });

  it('a broken sidecar is reported and the file still counts by its folder', async () => {
    await seed();
    mkdirSync(join(dir, 'assets', 'sfx', 'whoosh'), { recursive: true });
    writeFileSync(join(dir, 'assets', 'sfx', 'whoosh', 'x.wav'), 'RIFF');
    writeFileSync(join(dir, 'assets', 'sfx', 'whoosh', 'x.wav.json'), '{broken');
    const r = await run(['sfx', 'apply', '--dry-run']);
    expect(r.json.warnings.join(' ')).toContain('invalid JSON');
  });
});

describe('masks from-analysis (same ids as the desktop app)', () => {
  // the desktop format: f = source frame, 2 samples per second of a 30 fps source
  const pii = (frames: number[], box = { x: 0.1, y: 0.1, w: 0.2, h: 0.04 }, kind = 'email') =>
    ({ schema: 1, source: 'scr', fps: 2, sourceFps: 30, width: 1920, height: 1080, frames: frames.map((f) => ({ f, t: f / 30, changed: true, boxes: [{ ...box, kind, label: 'メールアドレス', text: 'a@b.jp' }] })) });

  it('builds masks with the app recipe, marks the step, and skips ids already in the timeline', async () => {
    await seed();
    mkdirSync(join(dir, 'derived', 'analysis'), { recursive: true });
    writeFileSync(join(dir, 'derived', 'analysis', 'pii.scr.json'), JSON.stringify(pii([30, 45, 60, 300])));
    const r = await run(['masks', 'from-analysis']);
    expect(r.json, r.stdout + r.stderr).toMatchObject({ ok: true, existing: 0, sources: ['scr'], files: ['derived/analysis/pii.scr.json'] });
    // 30 → 45 → 60 link (gap ≤ 2 × 15 frames); 300 starts a new track
    expect(r.json.added).toBe(2);
    const [m1, m2] = timeline().masks;
    expect(m1.id).toBe(piiMaskId('scr', 'email', 30, { x: 0.1, y: 0.1 }));
    expect(m1.id).toMatch(/^mask_pii_[0-9a-z]+$/);
    expect(m1).toMatchObject({ kind: 'pixelate', source: 'scr', reason: 'pii:email', decided: { by: 'rule', reason: 'OCR found メールアドレス on screen', confidence: 0.8, needsReview: true } });
    expect(m1.track.map((k: { frame: number }) => k.frame)).toEqual([30, 45, 60, 74]);   // held until the next sample
    expect(m1.track[0]).toEqual({ frame: 30, box: { x: 192, y: 108, w: 384, h: 43 }, confidence: 0.8 });
    expect(m2.track.map((k: { frame: number }) => k.frame)).toEqual([300, 314]);
    const st = JSON.parse(readFileSync(join(dir, '.ferret-video', 'status.json'), 'utf8'));
    expect(st.find((s: { step: string }) => s.step === 'masks').state).toBe('done');
    // re-running (or after the app added them) adds nothing
    const again = await run(['masks', 'from-analysis', '--kind', 'blur']);
    expect(again.json).toMatchObject({ added: 0, existing: 2 });
    expect(timeline().masks).toHaveLength(2);
  });

  it('the FNV-1a id recipe matches the desktop values', () => {
    expect(fnv36('')).toBe((2166136261).toString(36));
    expect(fnv36('a')).toBe((0xe40c292c).toString(36));
    expect(piiMaskId('scr', 'email', 30, { x: 0.104, y: 0.096 })).toBe(`mask_pii_${fnv36('scr:email:30:10:10')}`);
  });

  it('status treats the step as done when the app already added PII masks', async () => {
    await seed();
    const mask = { id: 'mask_pii_abc', kind: 'pixelate', source: 'scr', reason: 'pii:email', track: [{ frame: 0, box: { x: 0, y: 0, w: 10, h: 10 }, confidence: 0.8 }], decided: { by: 'rule', reason: 'OCR', needsReview: true } };
    expect((await run(['edit', 'addMask', '--mask', JSON.stringify(mask)])).json.ok).toBe(true);
    const st = await run(['status']);
    expect(st.json.steps.find((s: { step: string }) => s.step === 'masks')).toMatchObject({ state: 'done' });
  });

  it('filters, validation and missing / broken files', async () => {
    await seed();
    expect((await run(['masks', 'from-analysis', '--kind', 'emoji'])).code).toBe(2);
    expect((await run(['masks', 'from-analysis', '--pad', '0.1'])).code).toBe(2);   // not an option any more
    expect((await run(['masks', 'from-analysis', '--source', 'nope'])).json.error.code).toBe('not-found');
    const none = await run(['masks', 'from-analysis']);
    expect(none.json).toMatchObject({ ok: true, added: 0 });
    expect(none.json.warnings.join(' ')).toContain('pii');
    mkdirSync(join(dir, 'derived', 'analysis'), { recursive: true });
    writeFileSync(join(dir, 'derived', 'analysis', 'pii.cam.json'), '{"frames": "x"}');
    writeFileSync(join(dir, 'derived', 'analysis', 'pii.scr.json'), JSON.stringify(pii([10, 20])));
    const r = await run(['masks', 'from-analysis', '--kinds', 'phone']);
    expect(r.json.added).toBe(0);   // only phone numbers wanted
    expect(r.json.warnings.join(' ')).toContain('pii.cam.json');
    writeFileSync(join(dir, 'derived', 'analysis', 'pii.scr.json'), JSON.stringify(pii([10], undefined, 'face')));
    expect((await run(['masks', 'from-analysis'])).json.added).toBe(0);   // unknown kinds are ignored
    writeFileSync(join(dir, 'derived', 'analysis', 'pii.scr.json'), JSON.stringify(pii([10, 20])));
    const d = await run(['masks', 'from-analysis', '--dry-run']);
    expect(d.json).toMatchObject({ dryRun: true, added: 1 });
    expect(timeline().masks).toHaveLength(0);
    expect((await run(['masks'])).code).toBe(2);
  });
});

describe('multicam material and split-for-switch', () => {
  it('lists cameras per segment with face data when tracked', async () => {
    await seed({ twoCams: true });
    const r = await run(['multicam', 'material']);
    expect(r.json, r.stdout + r.stderr).toMatchObject({ ok: true, variant: 'main' });
    expect(r.json.cameras.map((c: { id: string }) => c.id)).toEqual(['cam', 'cam2']);
    expect(r.json.segments).toHaveLength(3);
    expect(r.json.segments[0].cameras.every((c: { faceVisible: unknown }) => c.faceVisible === null)).toBe(true);
    expect(r.json.warnings.join(' ')).toContain('faces');
    expect(r.json.check.check).toBe('camera-switch');
    expect(r.json.rules).toMatchObject({ maxShotSec: 90, minShotSec: 3 });
    mkdirSync(join(dir, 'derived', 'analysis'), { recursive: true });
    writeFileSync(join(dir, 'derived', 'analysis', 'faces.cam.json'), JSON.stringify({ fps: 30, frames: Array.from({ length: 30 }, (_, i) => ({ f: i * 30, faces: [{ x: 0.4, y: 0.2, w: 0.2, h: 0.3, score: 0.9 }] })) }));
    const r2 = await run(['multicam', 'material']);
    expect(r2.json.files).toEqual(['derived/analysis/faces.cam.json']);
    const c = r2.json.segments[0].cameras.find((x: { id: string }) => x.id === 'cam');
    expect(c.faceVisible).toBeGreaterThan(0.5);
    expect((await run(['multicam'])).code).toBe(2);
  });

  it('splits a segment at source frames; bad input is rejected', async () => {
    await seed({ twoCams: true });
    const r = await run(['edit', 'split-for-switch', '--segment', 'seg_1', '--at', '100,200', '--reason', '話者が変わる']);
    expect(r.json, r.stdout + r.stderr).toMatchObject({ ok: true, applied: 2 });
    expect(timeline().segments.map((s: { id: string }) => s.id).slice(0, 3)).toEqual(['seg_1', 'seg_1_s1', 'seg_1_s2']);
    await run(['undo']);
    expect(timeline().segments).toHaveLength(3);
    expect((await run(['edit', 'split-for-switch', '--segment', 'seg_1', '--at', 'x'])).code).toBe(2);
    expect((await run(['edit', 'split-for-switch', '--at', '100'])).code).toBe(2);
    expect((await run(['edit', 'split-for-switch', '--segment', 'seg_9', '--at', '100'])).json.error.code).toBe('not-found');
    const out = await run(['edit', 'split-for-switch', '--segment', 'seg_1', '--at', '5000']);
    expect(out.code).toBe(1);
    expect(timeline().segments).toHaveLength(3);
  });

  it('status skips multicam with a single camera', async () => {
    await seed();
    const st = await run(['status']);
    expect(st.json.next.step).not.toBe('multicam');
    for (const s of ['ingest', 'sync', 'analyze', 'transcribe']) await run(['step', s, 'done']);
    writeFileSync(join(dir, 'derived', 'transcripts', 'main.json'), JSON.stringify({ schema: 1, take: 'take_1', words: [] }));
    await run(['step', 'rough-cut', 'done']);
    expect((await run(['next'])).json.step).toBe('captions');
  });
});

describe('tracks apply', () => {
  function logs() {
    const t = join(dir, 'media', 'takes', 'take_1');
    mkdirSync(t, { recursive: true });
    writeFileSync(join(t, 'cursor.jsonl'), [
      { t_ms: 1000, x: 0.3, y: 0.3 }, { t_ms: 2000, x: 0.6, y: 0.4, click: true }, { t_ms: 12000, x: 0.5, y: 0.5, click: true },
      { t_ms: 25000, x: 0.5, y: 0.5, click: true },   // during the camera-only segment: no ring
    ].map((x) => JSON.stringify(x)).join('\n') + '\n{"torn":');
    writeFileSync(join(t, 'keys.jsonl'), [{ t_ms: 3000, keys: ['cmd', 's'] }, { t_ms: 4000, keys: ['a'] }].map((x) => JSON.stringify(x)).join('\n'));
  }

  it('adds click rings and shortcut badges only on screen segments and rebuilds them on re-run', async () => {
    await seed();
    logs();
    const r = await run(['tracks', 'apply']);
    expect(r.json, r.stdout + r.stderr).toMatchObject({ ok: true, followClicks: true, removedOverlays: 0 });
    expect(r.json.files).toEqual(['media/takes/take_1/cursor.jsonl', 'media/takes/take_1/keys.jsonl']);
    const ov = timeline().overlays;
    expect(ov.filter((o: { kind: string }) => o.kind === 'click-ring')).toHaveLength(2);
    expect(ov.filter((o: { kind: string }) => o.kind === 'keystroke').map((o: { keys: string[] }) => o.keys)).toEqual([['cmd', 's']]);
    expect(r.json.overlays).toBe(3);
    expect(r.json.zoomKeyframesAdded).toBeGreaterThan(0);   // follow clicks punches in on the screen segments
    const again = await run(['tracks', 'apply']);
    expect(again.json).toMatchObject({ overlays: 3, removedOverlays: 3 });
    expect(timeline().overlays).toHaveLength(3);
    const no = await run(['tracks', 'apply', '--no-overlays', '--no-follow-clicks']);
    expect(no.json).toMatchObject({ overlays: 0, followClicks: false });
  });

  it('works from derived/analysis too; flags and missing files', async () => {
    await seed();
    expect((await run(['tracks', 'apply', '--follow-clicks', '--no-follow-clicks'])).code).toBe(2);
    const none = await run(['tracks', 'apply']);
    expect(none.json).toMatchObject({ ok: true, overlays: 0 });
    expect(none.json.warnings.join(' ')).toMatch(/解析|analysis/);
    mkdirSync(join(dir, 'derived', 'analysis'), { recursive: true });
    writeFileSync(join(dir, 'derived', 'analysis', 'keys.take_1.jsonl'), JSON.stringify({ t_ms: 5000, keys: ['ctrl', 'c'] }));
    const r = await run(['tracks', 'apply', '--dry-run']);
    expect(r.json).toMatchObject({ dryRun: true, overlays: 1 });
    expect(timeline().overlays).toHaveLength(0);
    expect((await run(['tracks'])).code).toBe(2);
  });
});

describe('track checks', () => {
  it('runs the template checks whose inputs exist', async () => {
    await seed({ twoCams: true });
    const p: Project = { dir, file: JSON.parse(readFileSync(join(dir, 'ferret-video.json'), 'utf8')), variant: null };
    const tl = readTimeline(p);
    expect(trackChecks(p, tl, 'youtube').map((f) => f.check)).toEqual(['camera-switch']);
    mkdirSync(join(dir, 'derived', 'analysis'), { recursive: true });
    writeFileSync(join(dir, 'derived', 'analysis', 'pii.scr.json'), JSON.stringify({ frames: [{ f: 30, boxes: [{ x: 0.1, y: 0.1, w: 0.2, h: 0.05, kind: 'email' }] }] }));
    const f = trackChecks(p, tl, 'youtube');
    expect(f.map((x) => x.check)).toEqual(['mosaic-tracking', 'camera-switch']);
    expect(f[0]!.status).toBe('fail');   // visible PII without a mask
    expect(loadAnalysis(dir, tl).files).toEqual(['derived/analysis/pii.scr.json']);
  });
});

describe('bench', () => {
  const samples = Array.from({ length: 20 }, (_, i) => ({
    t: i, captionBoxes: [{ x: 0.2, y: 0.8, w: 0.6, h: 0.06, chars: 12, lines: 1 }], cutTimes: i % 3 === 0 ? [i + 0.5] : [],
    loudness: -14, sfxOnsets: i % 10 === 0 ? [i + 0.2] : [], sfxKinds: i % 10 === 0 ? ['pop'] : [], charsPerMin: 300,
  }));

  it('profile → apply merges a validated override into the project template', async () => {
    writeFileSync(join(sb.root, 's.json'), JSON.stringify({ source: { url: 'https://example.com/v' }, samples }));
    const pr = await run(['bench', 'profile', join(sb.root, 's.json'), '--out', join(sb.root, 'p.json'), '--platform', 'youtube']);
    expect(pr.json, pr.stdout + pr.stderr).toMatchObject({ ok: true, path: join(sb.root, 'p.json') });
    expect(pr.json.profile.source).toMatchObject({ url: 'https://example.com/v', platform: 'youtube' });
    expect(pr.json.patch.captions).toBeDefined();
    const dry = await run(['bench', 'apply', join(sb.root, 'p.json'), '--dry-run']);
    expect(dry.json).toMatchObject({ template: 'tech', scope: 'project', dryRun: true });
    expect(existsSync(join(dir, 'templates', 'tech', 'template.yaml'))).toBe(false);
    const ap = await run(['bench', 'apply', join(sb.root, 'p.json'), '--template', 'tech']);
    expect(ap.json, ap.stdout + ap.stderr).toMatchObject({ ok: true, scope: 'project', file: 'templates/tech/template.yaml' });
    const written = JSON.parse(readFileSync(join(dir, 'templates', 'tech', 'template.yaml'), 'utf8').replace(/^#.*\n/gm, ''));
    expect(written).toMatchObject({ id: 'tech', extends: 'tech' });
    // the project still loads its (overridden) template
    expect((await run(['status'])).json.ok).toBe(true);
  });

  it('another template id goes to the user templates; bad input is rejected', async () => {
    writeFileSync(join(sb.root, 's.json'), JSON.stringify(samples));
    await run(['bench', 'profile', join(sb.root, 's.json'), '--out', join(sb.root, 'p.json')]);
    const ap = await sb.run(['bench', 'apply', join(sb.root, 'p.json'), '--template', 'talk', '--json'], { cwd: sb.root });
    expect(ap.json, ap.stdout + ap.stderr).toMatchObject({ ok: true, scope: 'user', file: join(sb.home, 'templates', 'talk', 'template.yaml') });
    // outside a project without --template: the default template, for every new video
    expect((await sb.run(['bench', 'apply', join(sb.root, 'p.json'), '--json'], { cwd: sb.root })).json).toMatchObject({ ok: true, template: 'tech', scope: 'user' });
    expect((await sb.run(['bench', 'apply', join(sb.root, 'p.json'), '--template', 'Bad_Id', '--json'], { cwd: sb.root })).code).toBe(2);
    writeFileSync(join(sb.root, 'bad.json'), JSON.stringify([{ t: 0 }]));
    expect((await run(['bench', 'profile', join(sb.root, 'bad.json')])).json.error.code).toBe('invalid-samples');
    writeFileSync(join(sb.root, 'empty.json'), '[]');
    expect((await run(['bench', 'profile', join(sb.root, 'empty.json')])).json.error.code).toBe('invalid-samples');
    expect((await run(['bench', 'apply', join(sb.root, 'bad.json')])).json.error.code).toBe('invalid-profile');
    // a hand-written override is never overwritten
    mkdirSync(join(dir, 'templates', 'tech'), { recursive: true });
    writeFileSync(join(dir, 'templates', 'tech', 'template.yaml'), 'id: tech\nextends: tech\n');
    expect((await run(['bench', 'apply', join(sb.root, 'p.json')])).json.error.code).toBe('template-override');
    expect((await run(['bench'])).code).toBe(2);
  });
});

describe('mcp tools for round 5', () => {
  it('maps the new tools onto CLI argv', async () => {
    const calls: string[][] = [];
    const server = createMcpServer(async (argv) => {
      calls.push(argv);
      return { code: 0, stdout: '{"ok":true}', stderr: '' };
    }, { defaultProject: '/p' });
    const call = (name: string, args: object) => server.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
    await call('split_for_switch', { segment: 'seg_1', at: [10, 20], reason: 'r' });
    await call('sfx_apply', { dryRun: true });
    await call('tracks_apply', { followClicks: false, overlays: false });
    await call('tracks_apply', { followClicks: true });
    await call('masks_from_analysis', { kind: 'blur' });
    await call('multicam_material', {});
    expect(calls).toEqual([
      ['edit', 'split-for-switch', '--segment', 'seg_1', '--at', '10,20', '--reason', 'r', '--json', '--project', '/p'],
      ['sfx', 'apply', '--dry-run', '--json', '--project', '/p'],
      ['tracks', 'apply', '--no-follow-clicks', '--no-overlays', '--json', '--project', '/p'],
      ['tracks', 'apply', '--follow-clicks', '--json', '--project', '/p'],
      ['masks', 'from-analysis', '--kind', 'blur', '--json', '--project', '/p'],
      ['multicam', 'material', '--json', '--project', '/p'],
    ]);
  });
});
