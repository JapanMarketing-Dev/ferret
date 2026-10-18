import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { whichSync } from '@video/toolchain';
import { FFMPEG_TESTS } from '../ffmpegTests.js';
import { Sandbox, fakeNodeCli } from './helpers.js';

// Synthetic media via ffmpeg lavfi. Skipped when ffmpeg is not installed (CI installs it).
const ffmpeg = process.env.FERRET_VIDEO_FFMPEG ?? whichSync('ffmpeg');
// ffmpeg で書き出す結合テストは FERRET_VIDEO_FFMPEG_TESTS=1 のときだけ（../ffmpegTests.ts）
const hasFfmpeg = FFMPEG_TESTS && !!ffmpeg && !!(process.env.FERRET_VIDEO_FFPROBE ?? whichSync('ffprobe'));
if (!hasFfmpeg) console.warn('[ferret-video] skipping CLI media pipeline tests (FERRET_VIDEO_FFMPEG_TESTS=1 and ffmpeg/ffprobe to run them)');

// speech-like tone in [0.5,3], [4.5,7], [8,9.5]; silence elsewhere (10 s)
const VOICE = "if(between(t,0.5,3)+between(t,4.5,7)+between(t,8,9.5),0.4*sin(2*PI*330*t)*(0.6+0.4*sin(2*PI*3*t)),0)";

function makeClip(out: string, o: { audio: boolean; dur?: number; size?: string }) {
  const dur = String(o.dur ?? 10);
  const args = ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `testsrc2=size=${o.size ?? '640x360'}:rate=30:duration=${dur}`];
  if (o.audio) args.push('-f', 'lavfi', '-i', `aevalsrc='${VOICE}':s=48000:d=${dur}`);
  args.push('-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-g', '30');
  if (o.audio) args.push('-c:a', 'aac', '-shortest');
  args.push(out);
  execFileSync(ffmpeg!, args);
}

function makeWav(out: string, delaySec: number) {
  execFileSync(ffmpeg!, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `aevalsrc='${VOICE.replace(/t\b/g, `(t+${delaySec})`)}':s=48000:d=${10 - delaySec}`, '-c:a', 'pcm_s16le', out]);
}

describe.skipIf(!hasFfmpeg)('media pipeline (ffmpeg)', () => {
  let sb: Sandbox;
  let dir: string;
  const run = (args: string[]) => sb.run([...args, '--json'], { cwd: dir });
  const timeline = () => JSON.parse(readFileSync(join(dir, 'timeline.json'), 'utf8'));

  beforeAll(async () => {
    sb = new Sandbox();
    dir = join(sb.root, 'p');
    const r = await sb.run(['init', dir, '--template', 'talk-youtube', '--title', 'Pipeline', '--no-git', '--json']);
    expect(r.code).toBe(0);
    makeClip(join(sb.root, 'cam.mp4'), { audio: true });
  }, 60_000);
  afterAll(() => sb?.dispose());

  it('import → propose cuts → render preview → check → frame → final render + archive', async () => {
    const imp = await run(['import', join(sb.root, 'cam.mp4'), '--role', 'front']);
    expect(imp.json, imp.stdout + imp.stderr).toMatchObject({ ok: true, id: 'imp1', take: 'take_imp1', source: { kind: 'camera', role: 'front' } });
    expect(existsSync(join(dir, 'media', 'imports', 'imp1', 'cam.mp4'))).toBe(true);
    expect(timeline().sources.imp1.durationFrames).toBeGreaterThanOrEqual(299);

    const dry = await run(['propose', 'cuts', '--dry-run']);
    expect(dry.json.ok, dry.stdout).toBe(true);
    expect(dry.json.dryRun).toBe(true);
    expect(timeline().segments).toEqual([]);

    const pc = await run(['propose', 'cuts']);
    expect(pc.json, pc.stdout).toMatchObject({ ok: true, segments: 3 });
    expect(pc.json.cutRatio).toBeGreaterThan(0.2);
    expect(pc.json.cutRatio).toBeLessThan(0.5);
    const tl = timeline();
    expect(tl.segments).toHaveLength(3);
    expect(tl.segments[0].src.from).toBeGreaterThanOrEqual(10); // leading silence (0.5 s) removed, minus the pad
    expect(tl.segments[0].removedNeighbors[0]).toMatchObject({ kind: 'silence', decided: { by: 'rule' } });
    expect(tl.segments[2].transitionIn).toEqual({ kind: 'jump-zoom', frames: 0 }); // talk-youtube jumpZoom every 2
    expect(tl.outline).toHaveLength(1);
    expect((await run(['propose', 'cuts'])).json.error.code).toBe('segments-exist');
    expect((await run(['next'])).json.step).toBe('sync'); // ingest was marked done by import
    const st = JSON.parse(readFileSync(join(dir, '.ferret-video', 'status.json'), 'utf8'));
    expect(st.find((s: { step: string }) => s.step === 'rough-cut').state).toBe('running');

    const rp = await run(['render', '--preview']);
    expect(rp.json, rp.stdout + rp.stderr).toMatchObject({ ok: true, output: 'renders/youtube/preview.mp4', quality: 'preview' });
    expect(existsSync(join(dir, 'renders', 'youtube', 'preview.mp4'))).toBe(true);
    expect(existsSync(join(dir, 'renders', 'preview.mp4'))).toBe(true);   // compatibility copy
    const again = await run(['render', '--preview']);
    expect(again.json.rendered).toBe(0); // all chunks reused

    const ck = await run(['check']);
    expect(ck.json, ck.stdout + ck.stderr).toMatchObject({ ok: true });
    expect(ck.json.run).toMatch(/^chk_/);
    expect(existsSync(join(dir, ck.json.report))).toBe(true);
    expect(timeline().review.lastCheck).toMatchObject({ run: ck.json.run });

    const fr = await run(['frame', '--at', '00:00:01:00']);
    expect(fr.json).toMatchObject({ ok: true, frame: 30 });
    expect(existsSync(fr.json.path)).toBe(true);

    const fin = await run(['render', '--final', '--target', 'youtube']);
    expect(fin.json, fin.stdout + fin.stderr).toMatchObject({ ok: true, target: 'youtube' });
    expect(fin.json.output).toBe('renders/youtube/final.mp4');
    expect(existsSync(join(dir, fin.json.output))).toBe(true);
    expect(timeline().outputs[0]).toMatchObject({ target: 'youtube', render: { path: fin.json.output } });
    const past = await sb.run(['past', 'list', '--json']);
    expect(past.json.entries[0]).toMatchObject({ title: 'Pipeline', reason: 'export' });
  }, 240_000);

  it('ingest reads take.json: clock offsets, roles and NG markers', async () => {
    const d2 = join(sb.root, 'p2');
    await sb.run(['init', d2, '--template', 'talk-youtube', '--no-git', '--json']);
    const take = join(d2, 'media', 'takes', 'take_20261011-120000');
    mkdirSync(take, { recursive: true });
    makeClip(join(take, 'camera-1.mp4'), { audio: false, dur: 4 });
    makeWav(join(take, 'mic-1.wav'), 0.5);
    writeFileSync(join(take, 'take.json'), JSON.stringify({
      schema: 1, id: 'take_20261011-120000', createdAt: '2026-10-11T12:00:00Z', timeOrigin: 0, startedAtMs: 1000,
      tracks: [
        { file: 'camera-1.mp4', kind: 'camera', fps: 30, width: 640, height: 360, firstFrameMs: 1000 },
        { file: 'mic-1.wav', kind: 'mic', sampleRate: 48000, firstFrameMs: 1500 },
        { file: 'system.wav', kind: 'system' },
      ],
      markers: [{ kind: 'ng', atMs: 3000, sinceStartMs: 2000 }],
      app: { version: '0.1.0', os: 'mac' }, complete: true,
    }));
    const r = await sb.run(['ingest', '--json'], { cwd: d2 });
    expect(r.json, r.stdout + r.stderr).toMatchObject({ ok: true, markers: 1 });
    expect(r.json.added.sort()).toEqual(['take_20261011-120000.camera-1', 'take_20261011-120000.mic-1']);
    const tl = JSON.parse(readFileSync(join(d2, 'timeline.json'), 'utf8'));
    expect(tl.sources['take_20261011-120000.camera-1']).toMatchObject({ kind: 'camera', role: 'front', offset: 0, take: 'take_20261011-120000', audio: false, sync: { method: 'clock' } });
    expect(tl.sources['take_20261011-120000.mic-1']).toMatchObject({ kind: 'mic', offset: -24000, sampleRate: 48000 });
    expect(tl.markers).toEqual([{ kind: 'ng', at: 60, srcAt: 60, from: 'hotkey' }]);
    // idempotent
    expect((await sb.run(['ingest', '--json'], { cwd: d2 })).json.added).toEqual([]);
    const takes = await sb.run(['takes', '--json'], { cwd: d2 });
    expect(takes.json.takes[0]).toMatchObject({ id: 'take_20261011-120000', ingested: true, markers: 1 });
  }, 120_000);

  it('transcript → propose cuts drops fillers → captions keep every kept word', async () => {
    const d3 = join(sb.root, 'p3');
    await sb.run(['init', d3, '--template', 'talk-youtube', '--no-git', '--json']);
    await sb.run(['import', join(sb.root, 'cam.mp4'), '--json'], { cwd: d3 });
    // speech in [0.5,3], [4.5,7], [8,9.5]; a filler said at the start of the second phrase
    const words = [
      { w: '今日は', start: 0.55, end: 1.4 }, { w: '設定の', start: 1.4, end: 2.2 }, { w: '話です。', start: 2.2, end: 2.95 },
      { w: 'えー', start: 4.5, end: 5.0 }, { w: '次に', start: 5.0, end: 6.0 }, { w: '開きます。', start: 6.0, end: 6.95 },
      { w: '押します。', start: 8.05, end: 9.45 },
    ];
    mkdirSync(join(d3, 'derived', 'transcripts'), { recursive: true });
    writeFileSync(join(d3, 'derived', 'transcripts', 'main.json'), JSON.stringify({ schema: 1, engine: 'whisper.cpp', model: 'test', language: 'ja', take: 'take_imp1', source: 'imp1', words }));
    const pc = await sb.run(['propose', 'cuts', '--json'], { cwd: d3 });
    expect(pc.json, pc.stdout).toMatchObject({ ok: true, removed: { filler: 1 } });
    const tl = JSON.parse(readFileSync(join(d3, 'timeline.json'), 'utf8'));
    expect(tl.segments.map((s: { text: string }) => s.text).join('')).toBe('今日は設定の話です。次に開きます。押します。');
    const cb = await sb.run(['captions', 'build', '--json'], { cwd: d3 });
    expect(cb.json, cb.stdout).toMatchObject({ ok: true });
    const caps = JSON.parse(readFileSync(join(d3, 'timeline.json'), 'utf8')).captions as { text: string; range: { start: number; end: number } }[];
    expect(caps.map((c) => c.text).join('')).toBe('今日は設定の話です。次に開きます。押します。');
    for (let i = 1; i < caps.length; i++) expect(caps[i]!.range.start).toBeGreaterThanOrEqual(caps[i - 1]!.range.end);
    expect(readFileSync(join(d3, 'captions', 'main.srt'), 'utf8')).toContain('次に開きます。');
    expect(existsSync(join(d3, 'captions', 'main.ass'))).toBe(true);
    // rebuilding the cuts clears the now-stale captions and asks for a rebuild
    const again = await sb.run(['propose', 'cuts', '--replace', '--json'], { cwd: d3 });
    expect(again.json.warnings.join(' ')).toContain('captions build');
    expect(JSON.parse(readFileSync(join(d3, 'timeline.json'), 'utf8')).captions).toEqual([]);
  }, 120_000);

  it('import rejects a file without video as camera and cleans up', async () => {
    const wav = join(sb.root, 'voice.wav');
    makeWav(wav, 0);
    const r = await sb.run(['import', wav, '--kind', 'camera', '--json'], { cwd: dir });
    expect(r.json.error.code).toBe('no-video');
    const m = await sb.run(['import', wav, '--kind', 'mic', '--take', 'take_imp1', '--json'], { cwd: dir });
    expect(m.json, m.stdout).toMatchObject({ ok: true, source: { kind: 'mic' }, needsSync: true });
    // the camera's own audio is the same signal: sync finds ~0 s against the mic
    const sy = await sb.run(['sync', '--json'], { cwd: dir });
    expect(sy.json, sy.stdout + sy.stderr).toMatchObject({ ok: true });
    const r0 = sy.json.results.find((x: { source: string }) => x.source === 'imp1');
    expect(r0).toBeDefined();
    expect(Math.abs(r0.offsetSec)).toBeLessThan(0.05);
    expect(existsSync(join(dir, 'derived', 'analysis', 'sync.json'))).toBe(true);
    expect(JSON.parse(readFileSync(join(dir, 'timeline.json'), 'utf8')).sources.imp1.sync).toMatchObject({ method: 'xcorr' });
  }, 60_000);
});

// Real transcription needs whisper-cli and a model; set FERRET_VIDEO_WHISPER_MODEL to run it.
const hasWhisper = hasFfmpeg && !!process.env.FERRET_VIDEO_WHISPER_MODEL && existsSync(process.env.FERRET_VIDEO_WHISPER_MODEL) && process.env.FERRET_VIDEO_WHISPER_MODEL.endsWith('.bin') && !!(process.env.FERRET_VIDEO_WHISPER_CLI ?? whichSync('whisper-cli'));
describe.skipIf(!hasWhisper)('transcribe (whisper.cpp)', () => {
  it('writes derived/transcripts/main.json in take time', async () => {
    const sb = new Sandbox();
    try {
      const dir = join(sb.root, 'w');
      await sb.run(['init', dir, '--template', 'talk-youtube', '--no-git', '--json']);
      makeClip(join(sb.root, 'cam.mp4'), { audio: true, dur: 4 });
      await sb.run(['import', join(sb.root, 'cam.mp4'), '--json'], { cwd: dir });
      const r = await sb.run(['transcribe', '--json'], { cwd: dir });
      expect(r.json, r.stdout + r.stderr).toMatchObject({ ok: true, path: 'derived/transcripts/main.json' });
      expect(JSON.parse(readFileSync(join(dir, 'derived', 'transcripts', 'main.json'), 'utf8'))).toMatchObject({ schema: 1, engine: 'whisper.cpp', take: 'take_imp1' });
      expect(JSON.parse(readFileSync(join(dir, 'timeline.json'), 'utf8')).transcript).toMatchObject({ path: 'derived/transcripts/main.json', engine: 'whisper.cpp' });
    } finally {
      sb.dispose();
    }
  }, 300_000);
});

describe.skipIf(!hasFfmpeg)('thumbnails and feedback (ffmpeg)', () => {
  let sb: Sandbox;
  let dir: string;
  let bin: string;
  let env: Record<string, string>;
  const run = (args: string[], extra: Record<string, string> = {}) => sb.run([...args, '--json'], { cwd: dir, env: { ...env, ...extra } });
  const timeline = () => JSON.parse(readFileSync(join(dir, 'timeline.json'), 'utf8'));
  // the describe body runs even when the suite is skipped (no ffmpeg), so ffmpeg is only asked inside the hooks and tests
  let canTypeset = false;
  const probeSize = (f: string) => execFileSync(process.env.FERRET_VIDEO_FFPROBE ?? whichSync('ffprobe')!, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', f]).toString().trim();

  beforeAll(async () => {
    const filters = execFileSync(ffmpeg!, ['-hide_banner', '-filters']).toString();
    const decoders = execFileSync(ffmpeg!, ['-hide_banner', '-decoders']).toString();
    canTypeset = /\sass\s/.test(filters) || /\s(svg|librsvg)\s/.test(decoders);
    sb = new Sandbox();
    dir = join(sb.root, 'p');
    bin = join(sb.root, 'fakebin');
    mkdirSync(bin);
    // fake `codex`: drops a generated image into $CODEX_HOME/generated_images (reads the prompt from stdin)
    execFileSync(ffmpeg!, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=1536x1024', '-frames:v', '1', join(sb.root, 'gen.png')]);
    fakeNodeCli(bin, 'codex', `const fs = require('fs'), path = require('path');
const dir = path.join(process.env.CODEX_HOME, 'generated_images', 's');
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, 'img-' + process.pid + '-' + Date.now() + '.png'), fs.readFileSync(${JSON.stringify(join(sb.root, 'gen.png'))}));
console.log('done');
`);
    // fake \`claude -p --output-format json\`: organizes feedback item 1
    fakeNodeCli(bin, 'claude', `process.stdout.write(JSON.stringify({ type: 'result', result: JSON.stringify({ items: [{ index: 1, title: '字幕が顔にかかっている', request: '字幕を下へずらす' }] }) }));
`);
    env = { PATH: `${bin}${delimiter}${process.env.PATH ?? process.env.Path ?? ''}`, CODEX_HOME: join(sb.root, 'codexhome') };
    await sb.run(['init', dir, '--template', 'talk-youtube', '--title', 'Thumbs', '--no-git', '--json']);
    makeClip(join(sb.root, 'cam.mp4'), { audio: true, size: '1280x720' });
    await run(['import', join(sb.root, 'cam.mp4')]);
    expect((await run(['propose', 'cuts'])).json.ok).toBe(true);
  }, 120_000);
  afterAll(() => sb?.dispose());

  it('thumb candidates scores frames and keeps the best ones apart', async () => {
    const r = await run(['thumb', 'candidates', '--n', '3']);
    expect(r.json, r.stdout + r.stderr).toMatchObject({ ok: true });
    expect(r.json.candidates.length).toBeGreaterThan(0);
    expect(r.json.candidates.length).toBeLessThanOrEqual(3);
    for (const c of r.json.candidates) {
      expect(c.image).toMatch(/^checks\/thumbs\/cand-\d+\.jpg$/);
      expect(existsSync(join(dir, c.image))).toBe(true);
    }
    expect(existsSync(join(dir, 'checks', 'thumbs', 'candidates.json'))).toBe(true);
  }, 120_000);

  it('thumb gen --provider frame --no-title: 1280x720 JPEG ≤ 2 MB, recorded on the output', async () => {
    const r = await run(['thumb', 'gen', '--provider', 'frame', '--no-title', '--n', '1']);
    expect(r.json, r.stdout + r.stderr).toMatchObject({ ok: true, typeset: 'none' });
    const f = join(dir, 'renders', 'thumbnails', 'youtube-1.jpg');
    expect(probeSize(f)).toBe('1280,720');
    expect(statSync(f).size).toBeLessThanOrEqual(2 * 1024 * 1024);
    expect(timeline().outputs[0].thumbnail).toMatchObject({ path: 'renders/thumbnails/youtube-1.jpg', generatedBy: 'frame' });
    // the post the human approves points at it, so the thumbnail step is done
    expect(JSON.parse(readFileSync(join(dir, 'publish.json'), 'utf8')).thumbnail).toBe('renders/thumbnails/youtube-1.jpg');
    expect(JSON.parse(readFileSync(join(dir, '.ferret-video', 'status.json'), 'utf8')).find((x: { step: string }) => x.step === 'thumbnail').state).toBe('done');
  }, 120_000);

  it('thumb gen with a title typesets it (or explains the missing ffmpeg feature)', async () => {
    const r = await run(['thumb', 'gen', '--frame', '00:00:01:00', '--provider', 'frame', '--title', '設定は3つだけ', '--n', '1', '--formats', 'youtube,shorts']);
    if (!canTypeset) {
      expect(r.json.error.code).toBe('ffmpeg-features');
      return;
    }
    expect(r.json, r.stdout + r.stderr).toMatchObject({ ok: true, frame: 30 });
    expect(probeSize(join(dir, 'renders', 'thumbnails', 'shorts-1.jpg'))).toBe('1080,1920');
    expect(readFileSync(join(dir, 'renders', 'thumbnails', 'title-youtube.svg'), 'utf8')).toContain('設定は3つだけ');
  }, 120_000);

  it('thumb gen via codex (fake) uses the generated image; unknown providers are rejected', async () => {
    const r = await run(['thumb', 'gen', '--frame', '30', '--provider', 'codex', '--no-title', '--n', '2']);
    expect(r.json, r.stdout + r.stderr).toMatchObject({ ok: true });
    expect(r.json.thumbnails.map((x: { provider: string }) => x.provider)).toEqual(['codex', 'codex']);
    expect(existsSync(join(dir, 'renders', 'thumbnails', 'youtube-2.jpg'))).toBe(true);
    expect((await run(['thumb', 'gen', '--frame', '30', '--provider', 'dalle'])).code).toBe(2);
    expect((await run(['thumb', 'gen', '--frame', '99999'])).json.error.code).toBe('out-of-range');
    expect((await run(['thumb', 'dance'])).code).toBe(2);
    const pick = await run(['thumb', 'pick', join(dir, 'renders', 'thumbnails', 'youtube-2.jpg')]);
    expect(pick.json, pick.stdout).toMatchObject({ ok: true, target: 'youtube', thumbnail: { path: 'renders/thumbnails/youtube-2.jpg' } });
    expect(timeline().outputs[0].thumbnail.path).toBe('renders/thumbnails/youtube-2.jpg');
    expect((await run(['thumb', 'pick', join(sb.root, 'gen.png')])).code).toBe(2); // outside the project
    expect(r.json.images[0]).toMatchObject({ path: 'renders/thumbnails/youtube-1.jpg', provider: 'codex', size: '1280x720' });
  }, 120_000);

  it('feedback import → feedback.md + images + review state; organize via claude; list/show/done', async () => {
    const s = join(sb.root, 'session');
    mkdirSync(s);
    writeFileSync(join(s, 'session.json'), JSON.stringify({
      schema: 1, createdAt: '2026-10-11T12:00:00Z', audioStartMs: 0,
      playback: [{ atMs: 0, state: 'playing', frame: 0 }, { atMs: 1500, state: 'paused', frame: 45 }],
      words: [{ w: 'ここ、', start: 1.6, end: 2.0 }, { w: '字幕が', start: 2.0, end: 2.4 }, { w: '顔に', start: 2.4, end: 2.7 }, { w: 'かぶってる。', start: 2.7, end: 3.2 }],
      strokes: [{ startMs: 2000, endMs: 2600, points: [[0.3, 0.8], [0.5, 0.95], [0.7, 0.85]] }],
      notes: [{ atMs: 20_000, text: '最後をもう少し短く', frame: 200 }],
    }));
    const r = await run(['feedback', 'import', s, '--organize', 'claude', '--id', 'fb_test1']);
    expect(r.json, r.stdout + r.stderr).toMatchObject({ ok: true, id: 'fb_test1', dir: 'feedback/fb_test1', count: 2, organizedBy: 'claude' });
    expect(r.json.items[0]).toMatchObject({ n: 1, frame: 45, timecode: '00:00:01:15', image: 'feedback/fb_test1/01.png', spoken: 'ここ、字幕が顔にかぶってる。', request: '字幕を下へずらす' });
    expect(r.json.items[0].targets[0]).toMatchObject({ kind: 'segment' });
    const md = readFileSync(join(dir, 'feedback', 'fb_test1', 'feedback.md'), 'utf8');
    expect(md).toContain('## 1. [00:00:01:15] 字幕が顔にかかっている');
    expect(md).toContain('- 要望: 字幕を下へずらす');
    expect(md).toContain('- 発話（原文）: 「ここ、字幕が顔にかぶってる。」');
    expect(md).toContain('区間 seg_');
    expect(md).toContain('## 2. [00:00:06:20] 最後をもう少し短く');
    for (const f of ['01.png', '02.png', 'items.json', 'session.json']) expect(existsSync(join(dir, 'feedback', 'fb_test1', f)), f).toBe(true);
    const tl = timeline();
    expect(tl.review.feedback).toEqual([{ id: 'fb_test1', status: 'open', items: 2 }]);
    expect(tl.review.openItems.some((o: { ref: string }) => o.ref === 'fb_test1')).toBe(true);
    expect((await run(['feedback', 'list'])).json.feedback).toEqual([{ id: 'fb_test1', status: 'open', items: 2, path: 'feedback/fb_test1/feedback.md' }]);
    expect((await run(['feedback', 'show', 'fb_test1'])).json.items).toHaveLength(2);
    expect((await run(['feedback', 'import', s, '--id', 'fb_test1'])).json.error.code).toBe('exists');
    // the app edits the list: drop item 1, rename item 2 → reindexed with its image
    writeFileSync(join(sb.root, 'edited.json'), JSON.stringify([{ index: 2, title: '最後を短く', request: '最後の10秒を切る' }]));
    const set = await run(['feedback', 'set', 'fb_test1', '--items', join(sb.root, 'edited.json')]);
    expect(set.json, set.stdout).toMatchObject({ ok: true, count: 1, items: [{ n: 1, request: '最後の10秒を切る', image: 'feedback/fb_test1/01.png' }] });
    expect(existsSync(join(dir, 'feedback', 'fb_test1', '02.png'))).toBe(false);
    expect(readFileSync(join(dir, 'feedback', 'fb_test1', 'feedback.md'), 'utf8')).toContain('## 1. [00:00:06:20] 最後を短く');
    expect(timeline().review.feedback[0].items).toBe(1);
    writeFileSync(join(sb.root, 'bad.json'), JSON.stringify([{ index: 9 }]));
    expect((await run(['feedback', 'set', 'fb_test1', '--items', join(sb.root, 'bad.json')])).code).toBe(2);
    expect((await run(['feedback', 'done', 'fb_test1'])).json.status).toBe('done');
    expect(timeline().review.openItems.some((o: { ref: string }) => o.ref === 'fb_test1')).toBe(false);
    expect((await run(['feedback', 'list', '--open'])).json.feedback).toEqual([]);
    // the desktop app's event-list format, on a variant
    const s2 = join(dir, 'feedback', 'inbox', 'fb_app1');
    mkdirSync(s2, { recursive: true });
    writeFileSync(join(s2, 'session.json'), JSON.stringify({
      schema: 1, id: 'fb_app1', createdAt: '2026-10-11T13:00:00Z', fps: { num: 30, den: 1 }, video: { path: 'renders/preview.mp4' }, micFile: 'mic.wav', micStartMs: 0,
      events: [
        { t_ms: 0, kind: 'play', frame: 0, videoTime: 0 },
        { t_ms: 1000, kind: 'pause', frame: 30, videoTime: 1 },
        { t_ms: 1200, kind: 'box', frame: 30, videoTime: 1, data: { x: 0.2, y: 0.7, w: 0.6, h: 0.2 } },
        { t_ms: 1500, kind: 'text', frame: 30, videoTime: 1, data: { x: 0.5, y: 0.5, text: 'ここを明るく' } },
      ],
    }));
    const app = await run(['feedback', 'import', s2]);
    expect(app.json, app.stdout + app.stderr).toMatchObject({ ok: true, id: 'fb_app1', count: 1, items: [{ n: 1, frame: 30, spoken: '' }] });
    expect(app.json.items[0].notes).toEqual(['ここを明るく']);
    expect(existsSync(join(dir, 'feedback', 'fb_app1', '01.png'))).toBe(true);
    writeFileSync(join(s2, 'session.json'), JSON.stringify({ schema: 1, events: [{ t_ms: 1, kind: 'box', frame: 0, data: { x: 'a' } }] }));
    expect((await run(['feedback', 'import', s2, '--id', 'fb_app2'])).json.error.code).toBe('invalid-session');
    // broken sessions are rejected
    writeFileSync(join(s, 'session.json'), JSON.stringify({ schema: 1, strokes: [{ startMs: 0, endMs: 1, points: [[0.1]] }] }));
    expect((await run(['feedback', 'import', s])).json.error.code).toBe('invalid-session');
    writeFileSync(join(s, 'session.json'), JSON.stringify({ schema: 1 }));
    expect((await run(['feedback', 'import', s])).json.error.code).toBe('empty');
    // a failure while transcribing (here: broken audio / no whisper) leaves no feedback folder and no work folder
    writeFileSync(join(s, 'session.json'), JSON.stringify({ schema: 1, audio: 'mic.wav', notes: [{ atMs: 0, text: 'x', frame: 0 }] }));
    writeFileSync(join(s, 'mic.wav'), 'not audio');
    const bad = await run(['feedback', 'import', s, '--id', 'fb_broken']);
    expect(bad.code).toBe(1);
    expect(existsSync(join(dir, 'feedback', 'fb_broken'))).toBe(false);
    expect(readdirSync(join(dir, 'feedback')).filter((d) => d.startsWith('.tmp-'))).toEqual([]);
    expect((await run(['feedback', 'show', 'fb_none'])).json.error.code).toBe('not-found');
  }, 120_000);
});
