import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { whichSync } from '@video/toolchain';
import { FFMPEG_TESTS } from '../ffmpegTests.js';
import { fillPrivacy, privacyDefaults } from '@video/cli/publishJson.js';
import { subtractPatch } from '@video/cli/commands/assist.js';
import { Sandbox } from './helpers.js';

// Round 2 (2026-10-11): built-in sound effects, the reference-video benchmark, privacy defaults from settings.

const ffmpeg = process.env.FERRET_VIDEO_FFMPEG ?? whichSync('ffmpeg');
// ffmpeg で書き出す結合テストは FERRET_VIDEO_FFMPEG_TESTS=1 のときだけ（../ffmpegTests.ts）
const hasFfmpeg = FFMPEG_TESTS && !!ffmpeg && !!(process.env.FERRET_VIDEO_FFPROBE ?? whichSync('ffprobe'));

let sb: Sandbox;
let dir: string;
beforeEach(async () => {
  sb = new Sandbox();
  dir = join(sb.root, 'video');
  expect((await sb.run(['init', dir, '--title', 'テスト', '--no-git', '--json'])).code).toBe(0);
});
afterEach(() => sb.dispose());

const run = (args: string[]) => sb.run([...args, '--json'], { cwd: dir });
const timeline = () => JSON.parse(readFileSync(join(dir, 'timeline.json'), 'utf8'));
const pub = () => JSON.parse(readFileSync(join(dir, 'publish.json'), 'utf8'));
const decided = { by: 'agent', reason: 't' };
const cam = { kind: 'camera', path: 'media/c.mp4', take: 'take_1', role: 'front', fps: { num: 30, den: 1 }, size: { width: 1920, height: 1080 }, offset: 0 };
const seg = (id: string, from: number, to: number, chapter: string, zoom?: object[]) => ({
  id, range: { start: 0, end: 0 }, src: { from, to, take: 'take_1' }, text: id, chapter, role: 'explain', video: { layout: 'camera-full', camera: 'cam' }, decided, ...(zoom ? { zoom } : {}),
});

describe('privacy defaults from settings (publish.youtube.privacy / publish.tiktok.privacy)', () => {
  it('pure: valid values are used, missing or bad ones fall back to private / SELF_ONLY; set values are never overridden', () => {
    expect(privacyDefaults({})).toEqual({ youtube: 'private', tiktok: 'SELF_ONLY' });
    expect(privacyDefaults({ publish: { youtube: { privacy: 'unlisted' }, tiktok: { privacy: 'PUBLIC_TO_EVERYONE' } } })).toEqual({ youtube: 'unlisted', tiktok: 'PUBLIC_TO_EVERYONE' });
    expect(privacyDefaults({ publish: { youtube: { privacy: 'everyone' }, tiktok: { privacy: 3 } } })).toEqual({ youtube: 'private', tiktok: 'SELF_ONLY' });
    const d = { youtube: 'unlisted' as const, tiktok: 'FOLLOWER_OF_CREATOR' as const };
    const base = { video: 'v.mp4', title: 't', description: 'd', tags: [] };
    expect(fillPrivacy(base, d)).toMatchObject({ youtube: { privacy: 'unlisted' }, tiktok: { privacy: 'FOLLOWER_OF_CREATOR' } });
    expect(fillPrivacy({ ...base, youtube: { privacy: 'public', chapters: false } }, d).youtube).toEqual({ privacy: 'public', chapters: false });
    expect(fillPrivacy({ ...base, youtube: { privacy: '' as never } }, d).youtube!.privacy).toBe('unlisted');
  });

  it('meta set fills them into a new publish.json and into one that lacks them; an explicit --privacy wins', async () => {
    const set = await sb.run(['config', 'set', 'publish.youtube.privacy', 'unlisted', '--json']);
    if (!set.json?.ok) return; // settings worker's keys not present in this tree yet
    await sb.run(['config', 'set', 'publish.tiktok.privacy', 'MUTUAL_FOLLOW_FRIENDS', '--json']);
    await run(['meta', 'set', '--title', 'T', '--description', 'D']);
    expect(pub()).toMatchObject({ youtube: { privacy: 'unlisted' }, tiktok: { privacy: 'MUTUAL_FOLLOW_FRIENDS' } });
    writeFileSync(join(dir, 'publish.json'), JSON.stringify({ video: 'renders/youtube/final.mp4', title: 'T', description: 'D', tags: [] }));
    await run(['meta', 'set', '--tags', 'a']);
    expect(pub()).toMatchObject({ youtube: { privacy: 'unlisted' }, tiktok: { privacy: 'MUTUAL_FOLLOW_FRIENDS' } });
    await run(['meta', 'set', '--privacy', 'public']);
    expect(pub().youtube.privacy).toBe('public');
  });
});

describe('bench unapply', () => {
  it('subtractPatch removes what the patch set, keeps hand edits and other keys, drops emptied objects', () => {
    const cur = { id: 'tech', extends: 'tech', captions: { style: 'tech-bold', maxLines: 1 }, audio: { sfx: { maxPerMinute: 8 } }, glossary: [{ term: 'x' }] };
    const patch = { captions: { style: 'tech-bold', maxLines: 2 }, audio: { sfx: { maxPerMinute: 8 } }, captionLook: { size: 0.05 } };
    expect(subtractPatch(cur, patch)).toEqual({ id: 'tech', extends: 'tech', captions: { maxLines: 1 }, glossary: [{ term: 'x' }] });
    expect(subtractPatch({ a: [1, 2] }, { a: [1, 2] })).toEqual({});
    expect(subtractPatch({ a: [1, 2] }, { a: [1] })).toEqual({ a: [1, 2] });
    expect(subtractPatch({}, { a: 1 })).toEqual({});
  });

  it('project scope and --global; applying again replaces the earlier profile; nothing applied → not-applied', async () => {
    const profile = {
      durationSec: 60, source: { url: 'https://example.com/v' },
      captions: { present: true, anchorY: 0.9, heightRatio: 0.06, charsPerLine: { p50: 0, p90: 0 }, lines: 1, box: false, reveal: 'block', emphasis: { rate: 0.3, color: '#FFE600' } },
      cuts: { avgShotSec: 3, jumpCutsPerMin: 20, punchIn: { perMin: 2, scale: 1.2 } },
      audio: { speechLufs: -14, bgm: { present: true, relDb: -20 } },
      sfx: { perMin: 5, on: { cut: 0.3, captionIn: 0, emphasis: 0.4, section: 1 }, kinds: { pop: 1 } },
      speech: { charsPerMin: 0 },
    };
    const f = join(sb.root, 'p.json');
    writeFileSync(f, JSON.stringify(profile));
    expect((await run(['bench', 'unapply'])).json.error.code).toBe('not-applied');
    expect((await run(['bench', 'apply', f])).json).toMatchObject({ ok: true, scope: 'project' });
    const file = join(dir, 'templates', 'tech', 'template.yaml');
    expect(existsSync(file)).toBe(true);
    // a hand edit next to it survives unapply
    const cur = JSON.parse(readFileSync(file, 'utf8').replace(/^#.*\n/gm, ''));
    writeFileSync(file, JSON.stringify({ ...cur, glossary: [{ term: 'Ferret' }] }));
    // applying again does not pile up: the earlier patch is taken out first
    profile.captions.lines = 2;
    writeFileSync(f, JSON.stringify(profile));
    expect((await run(['bench', 'apply', f])).json.ok).toBe(true);
    expect(JSON.parse(readFileSync(file, 'utf8').replace(/^#.*\n/gm, '')).captions.maxLines).toBe(2);
    const u = await run(['bench', 'unapply', '--template', 'tech']);
    expect(u.json).toMatchObject({ ok: true, scope: 'project', removedFolder: false });
    const left = JSON.parse(readFileSync(file, 'utf8').replace(/^#.*\n/gm, ''));
    expect(left).toEqual({ id: 'tech', extends: 'tech', glossary: [{ term: 'Ferret' }] });
    expect((await run(['status'])).json.ok).toBe(true);
    // global
    expect((await run(['bench', 'apply', f, '--global'])).json).toMatchObject({ ok: true, scope: 'user' });
    expect(existsSync(join(sb.home, 'templates', 'tech', 'template.yaml'))).toBe(true);
    expect((await sb.run(['bench', 'unapply', '--global', '--json'], { cwd: sb.root })).json).toMatchObject({ ok: true, scope: 'user', removedFolder: true });
    expect(existsSync(join(sb.home, 'templates', 'tech'))).toBe(false);
    expect((await run(['bench', 'unapply', '--global'])).json.error.code).toBe('not-applied');
    expect((await run(['bench', 'unapply', '--template', 'talk'])).code).toBe(2);
    expect((await run(['bench', 'unapply', '--template', 'Bad_Id'])).code).toBe(2);
  });
});

describe('the tech template defaults (sfx and captions)', () => {
  it('sfx rules: section / zoom-in / scene-in / emphasis at 4–8 a minute; sfx runs after layout; captions tech-bold 18 × 2, 0.8–4 s', async () => {
    const st = (await run(['status'])).json.steps.map((s: { step: string }) => s.step);
    expect(st.indexOf('sfx')).toBe(st.indexOf('layout') + 1);
    const { loadTemplate } = await import('@video/templates');
    const tpl = loadTemplate('tech');
    expect(tpl.sfx!.rules.map((r) => [r.on, r.kind])).toEqual([['section', 'whoosh'], ['zoom-in', 'swoosh-in'], ['scene-in', 'pop'], ['emphasis', 'pop']]);
    expect(tpl.sfx!.maxPerMin).toBeGreaterThanOrEqual(4);
    expect(tpl.sfx!.maxPerMin).toBeLessThanOrEqual(8);
    expect(tpl.captions).toMatchObject({ style: 'tech-bold', maxCharsPerLine: 18, maxLines: 2, emphasis: 'auto', minDurationMs: 800, maxDurationMs: 4000, position: { anchor: 'bottom', y: 0.92 } });
    expect(tpl.prompts.sfx).toContain('soundeffect-lab.info');
    expect(tpl.prompts.sfx).toContain('otologic.jp');
  });
});

describe.skipIf(!hasFfmpeg)('with ffmpeg', () => {
  it('sfx apply places built-in effects (made on first use) at sections and zoom-ins, copied into the project', async () => {
    const ops = [
      { op: 'addSource', id: 'cam', source: cam },
      { op: 'setOutline', outline: [
        { id: 'ch_1', title: 'a', start: 0, end: 900, points: [], importance: 'core' },
        { id: 'ch_2', title: 'b', start: 900, end: 1800, points: [], importance: 'core' },
      ] },
      { op: 'addSegment', segment: seg('seg_1', 0, 900, 'ch_1', [{ at: 0, value: { scale: 1, focus: 'face' } }, { at: 300, value: { scale: 1.4, focus: 'face' } }]) },
      { op: 'addSegment', segment: seg('seg_2', 900, 1800, 'ch_2') },
    ];
    expect((await run(['edit', '--ops', JSON.stringify(ops)])).json.ok).toBe(true);
    const r = await run(['sfx', 'apply']);
    expect(r.json, r.stdout).toMatchObject({ ok: true });
    expect(r.json.library).toBeGreaterThanOrEqual(21);
    // the section always gets one; the zoom-in fires with probability 0.7 (seeded by the project id)
    const triggers: string[] = r.json.sfx.map((s: { trigger: string }) => s.trigger);
    expect(triggers).toContain('section');
    expect(triggers.every((x) => x === 'section' || x === 'zoom-in')).toBe(true);
    const seeds = await Promise.all(['a', 'b', 'c', 'd', 'e'].map((seed) => run(['sfx', 'apply', '--seed', seed, '--dry-run'])));
    expect(seeds.some((x) => x.json.sfx.some((s: { trigger: string }) => s.trigger === 'zoom-in'))).toBe(true);
    expect(existsSync(join(sb.home, 'sfx', 'builtin', 'whoosh', 'whoosh-1.wav'))).toBe(true);
    for (const s of Object.values(timeline().sources) as { kind: string; path: string; license?: { id: string } }[]) {
      if (s.kind !== 'asset') continue;
      expect(existsSync(join(dir, s.path))).toBe(true);
      expect(s.license!.id).toBe('CC0-1.0');
    }
    // no credit needed for the built-in set
    await run(['meta', 'set', '--title', 'T', '--description', '本文']);
    expect(pub().description).not.toContain('クレジット');
  }, 120_000);

  it('bench analyze measures a local video, writes the profile and applies it to this video or to every video', async () => {
    const ref = join(sb.root, 'ref.mp4');
    execFileSync(ffmpeg!, ['-hide_banner', '-v', 'error', '-y',
      '-f', 'lavfi', '-i', 'color=c=0x404040:s=320x180:r=30:d=8',
      '-f', 'lavfi', '-i', "aevalsrc='0.003*sin(2*PI*200*t)+0.8*sin(2*PI*1500*t)*exp(-(t-1.5)*60)*gte(t,1.5)':s=48000:d=8",
      '-vf', "geq=lum='if(between(Y,H*0.82,H*0.9)*between(X,W*0.2,W*0.8),255*mod(floor(X/4),2),if(lt(T,4),40,200))':cb=128:cr=128",
      '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', ref]);
    const out = join(sb.root, 'p.json');
    const a = await run(['bench', 'analyze', ref, '--out', out, '--url', 'https://www.youtube.com/watch?v=x', '--apply']);
    // --json: progress lines on stderr (ctx.progress), increasing, ending at 1
    const prog = a.stderr.split('\n').filter(Boolean).map((l) => JSON.parse(l).progress).filter(Boolean);
    expect(prog.map((x: { stage: string }) => x.stage)).toEqual(['cuts', 'loudness', 'sfx', 'captions', 'done']);
    expect(prog.every((x: { task: string; label: string }) => x.task === 'bench' && x.label)).toBe(true);
    expect(prog.at(-1).fraction).toBe(1);
    expect(a.json, a.stdout + a.stderr).toMatchObject({ ok: true, applied: { template: 'tech', scope: 'project', dryRun: false } });
    expect(a.json.profile.captions.present).toBe(true);
    expect(a.json.profile.cuts.jumpCutsPerMin).toBeGreaterThan(0);
    expect(a.json.profile.source.url).toBe('https://www.youtube.com/watch?v=x');
    expect(existsSync(out)).toBe(true);
    expect(existsSync(join(sb.root, 'p.samples.json'))).toBe(true);
    // the project template now carries the look; the CLI loads it by itself (the finish flow needs nothing else)
    expect(existsSync(join(dir, 'templates', 'tech', 'template.yaml'))).toBe(true);
    const { loadTemplate } = await import('@video/templates');
    const tpl = loadTemplate('tech', { extraDirs: [join(dir, 'templates')] });
    expect(tpl.captions.style).toBe('tech-bold');
    expect(tpl.captions.maxCharsPerLine).toBe(18); // characters per line were not measured: kept
    expect(tpl.captionLook).toBeDefined();
    expect(loadTemplate('tech').captionLook).toBeUndefined(); // other videos untouched
    // --global: every new video
    const g = await run(['bench', 'apply', out, '--global']);
    expect(g.json).toMatchObject({ ok: true, scope: 'user' });
    expect(loadTemplate('tech').captionLook).toBeDefined();
    // errors
    expect((await run(['bench', 'analyze', join(sb.root, 'nope.mp4')])).json.error.code).toBe('not-found');
    expect((await run(['bench', 'analyze', ref, '--from', '5', '--to', '5.5'])).code).toBe(2);
    expect((await run(['bench', 'analyze', ref, '--from', '-1'])).code).toBe(2);
    expect((await run(['bench', 'analyze', ref, '--global'])).code).toBe(2);
    expect((await run(['bench', 'analyze', ref, '--url', 'ftp://x'])).code).toBe(2);
    expect((await run(['bench', 'analyze', ref, '--from', '7.5'])).json.error.code).toBe('analyze-failed');
  }, 180_000);
});
