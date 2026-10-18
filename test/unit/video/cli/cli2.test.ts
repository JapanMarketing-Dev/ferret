import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { progress, progressDone, type Ctx } from '@video/cli/ctx.js';
import { main } from '@video/cli';
import { createMcpServer } from '@video/cli/mcp.js';
import { Sandbox } from './helpers.js';

let sb: Sandbox;
let dir: string;
beforeEach(async () => {
  sb = new Sandbox();
  dir = join(sb.root, 'video');
  const r = await sb.run(['init', dir, '--template', 'talk-youtube', '--title', '設定のコツ', '--no-git', '--json']);
  expect(r.code).toBe(0);
});
afterEach(() => sb.dispose());

const run = (args: string[]) => sb.run([...args, '--json'], { cwd: dir });
const timeline = () => JSON.parse(readFileSync(join(dir, 'timeline.json'), 'utf8'));
const decided = { by: 'agent', reason: 't' };
const cam = { kind: 'camera', path: 'media/a.mp4', take: 'take_1', role: 'front', fps: { num: 30, den: 1 }, size: { width: 1920, height: 1080 }, offset: 0 };
const bgmAsset = { kind: 'asset', path: 'assets/bgm.mp3', assetId: 'maou-1', license: { id: 'maou', credit: '音楽: 魔王魂' } };
const sfxAsset = { kind: 'asset', path: 'assets/pop.wav', assetId: 'oto-1', license: { id: 'OtoLogic-CC-BY-4.0', credit: '効果音: OtoLogic' } };
const seg = (id: string, from: number, to: number, chapter = 'ch_1') => ({ id, range: { start: 0, end: 0 }, src: { from, to, take: 'take_1' }, text: id, chapter, role: 'explain', video: { layout: 'camera-full', camera: 'cam' }, decided });

/** 3 chapters of 20 s each, a BGM and an sfx with credits. */
async function seed() {
  const ops = [
    { op: 'addSource', id: 'cam', source: cam },
    { op: 'addSource', id: 'bgm1', source: bgmAsset },
    { op: 'addSource', id: 'pop', source: sfxAsset },
    { op: 'setOutline', outline: [
      { id: 'ch_1', title: 'はじめに', start: 0, end: 600, points: [], importance: 'core' },
      { id: 'ch_2', title: '設定ファイル', start: 600, end: 1200, points: [], importance: 'core' },
      { id: 'ch_3', title: 'まとめ', start: 1200, end: 1800, points: [], importance: 'core' },
    ] },
    { op: 'addSegment', segment: seg('seg_1', 0, 600) },
    { op: 'addSegment', segment: seg('seg_2', 600, 1200, 'ch_2') },
    { op: 'addSegment', segment: seg('seg_3', 1200, 1800, 'ch_3') },
    { op: 'setBgm', bgm: [{ id: 'bgm_1', asset: 'bgm1', range: { start: 0, end: 1800 }, gainDb: -24, duckDb: -12, fadeIn: 0, fadeOut: 0, decided }] },
    { op: 'addSfx', sfx: { id: 'sfx_1', asset: 'pop', at: 600, gainDb: -12, trigger: 'section', decided } },
    { op: 'addScene', scene: { id: 'scn_1', pattern: { id: 'big-number', version: '1' }, range: { start: 900, end: 960 }, slots: { value: { kind: 'number', value: 3 } }, decided } },
  ];
  const r = await run(['edit', '--ops', JSON.stringify(ops)]);
  expect(r.json, r.stdout).toMatchObject({ ok: true });
}

describe('meta (publish.json)', () => {
  const pub = () => JSON.parse(readFileSync(join(dir, 'publish.json'), 'utf8'));
  const stepState = (step: string) => JSON.parse(readFileSync(join(dir, '.ferret-video', 'status.json'), 'utf8')).find((s: { step: string }) => s.step === step)?.state;

  it('set writes publish.json: title, tags, description with chapters and credits added once; the metadata step is done', async () => {
    await seed();
    const r = await run(['meta', 'set', '--title', ' 設定は3つだけ ', '--description', 'Claude Code の設定のコツ。', '--tags', '#claude, 設定 ,AI,claude']);
    expect(r.json, r.stdout).toMatchObject({ ok: true, file: 'publish.json', valid: true });
    const p = pub();
    expect(p).toMatchObject({ video: 'renders/youtube/final.mp4', title: '設定は3つだけ', tags: ['claude', '設定', 'AI'] });
    expect(p.youtube).toMatchObject({ privacy: 'private', categoryId: '28', madeForKids: false, chapters: true });
    expect(p.tiktok).toMatchObject({ enabled: false, privacy: 'SELF_ONLY' });
    expect(p.description).toBe('Claude Code の設定のコツ。\n\n00:00 はじめに\n00:20 設定ファイル\n00:40 まとめ\n\nクレジット:\n音楽: 魔王魂\n効果音: OtoLogic');
    expect(stepState('metadata')).toBe('done');
    // setting the same description again does not duplicate chapters or credits
    await run(['meta', 'set', '--description', p.description]);
    expect(pub().description).toBe(p.description);
    // a partial update keeps the rest; no per-target files any more
    await run(['meta', 'set', '--privacy', 'unlisted', '--tiktok', '--tiktok-caption', 'みじかい']);
    expect(pub()).toMatchObject({ title: '設定は3つだけ', youtube: { privacy: 'unlisted', chapters: true }, tiktok: { enabled: true, caption: 'みじかい' } });
    expect(existsSync(join(dir, 'renders', 'youtube', 'metadata.md'))).toBe(false);
    const show = await run(['meta', 'show']);
    expect(show.json).toMatchObject({ exists: true, valid: true, publish: { title: '設定は3つだけ' } });
    expect(show.json.chapters.text).toContain('00:40 まとめ');
    expect(show.json.credits).toEqual(['音楽: 魔王魂', '効果音: OtoLogic']);
  });

  it('--no-chapters leaves the chapter list out; unknown fields the agent wrote by hand are kept', async () => {
    await seed();
    writeFileSync(join(dir, 'publish.json'), JSON.stringify({ video: 'renders/youtube/final.mp4', title: 'A', description: '', tags: [], notes: 'keep me' }));
    await run(['meta', 'set', '--description', '本文', '--no-chapters']);
    expect(pub().description).toBe('本文\n\nクレジット:\n音楽: 魔王魂\n効果音: OtoLogic');
    expect(pub().notes).toBe('keep me');
    expect(pub().youtube.chapters).toBe(false);
  });

  it('--file takes publish.json itself or the older per-target shape', async () => {
    writeFileSync(join(sb.root, 'p.json'), JSON.stringify({ title: 'From file', tags: ['a', '#b', 'a'], youtube: { privacy: 'public' } }));
    expect((await run(['meta', 'set', '--file', join(sb.root, 'p.json')])).json.ok).toBe(true);
    expect(pub()).toMatchObject({ title: 'From file', tags: ['a', 'b'], youtube: { privacy: 'public', categoryId: '28' } });
    writeFileSync(join(sb.root, 'old.json'), JSON.stringify({ youtube: { title: 'Old shape', tags: ['x'], titleCandidates: ['c'] }, tiktok: { title: 'ignored' } }));
    expect((await run(['meta', 'set', '--file', join(sb.root, 'old.json')])).json.ok).toBe(true);
    expect(pub()).toMatchObject({ title: 'Old shape', tags: ['x'] });
    expect(pub().titleCandidates).toBeUndefined();
    expect((await run(['meta', 'set', '--file', join(sb.root, 'nope.json')])).json.error.code).toBe('not-found');
    writeFileSync(join(sb.root, 'arr.json'), '[1]');
    expect((await run(['meta', 'set', '--file', join(sb.root, 'arr.json')])).code).toBe(2);
    writeFileSync(join(sb.root, 'broken.json'), '{');
    expect((await run(['meta', 'set', '--file', join(sb.root, 'broken.json')])).json.error.code).toBe('invalid-json');
  });

  it('boundaries: 100-char title is fine, 101 is not valid; bad privacy / video path / publishAt are refused', async () => {
    const ok = await run(['meta', 'set', '--title', 'あ'.repeat(100), '--description', 'd', '--tags', 'a']);
    expect(ok.json).toMatchObject({ ok: true, valid: true });
    const long = await run(['meta', 'set', '--title', 'あ'.repeat(101)]);
    expect(long.json).toMatchObject({ ok: true, valid: false }); // written (the agent fixes it next), but not done
    expect(stepState('metadata')).toBe('running');
    expect((await run(['meta', 'check'])).json.error.code).toBe('invalid-publish');
    expect((await run(['meta', 'set', '--privacy', 'friends'])).json.error.code).toBe('invalid-publish');
    expect((await run(['meta', 'set', '--video', '../../etc/passwd.mp4'])).json.error.code).toBe('invalid-publish');
    expect((await run(['meta', 'set', '--publish-at', '2001-01-01T00:00:00Z'])).json.error.code).toBe('invalid-publish');
    expect((await run(['meta', 'set', '--publish-at', 'tomorrow'])).json.error.code).toBe('invalid-publish');
    expect((await run(['meta', 'set', '--category', 'gaming'])).json.error.code).toBe('invalid-publish');
    expect((await run(['meta', 'set', '--target', 'myspace', '--title', 'x'])).code).toBe(2);
    expect((await run(['meta', 'set', '--chapters', '--no-chapters'])).code).toBe(2);
    expect((await run(['meta', 'set', '--tiktok', '--no-tiktok'])).code).toBe(2);
    expect(pub().youtube.privacy).toBe('private'); // refused sets changed nothing
  });

  it('check: missing file, broken JSON, valid file; a broken publish.json is never overwritten by set', async () => {
    expect((await run(['meta', 'check'])).json.error.code).toBe('no-publish');
    expect((await run(['meta', 'show'])).json).toMatchObject({ ok: true, exists: false });
    writeFileSync(join(dir, 'publish.json'), '{ nope');
    expect((await run(['meta', 'check'])).json.error.code).toBe('invalid-publish');
    expect((await run(['meta', 'set', '--title', 'x'])).json.error.code).toBe('invalid-publish');
    expect(readFileSync(join(dir, 'publish.json'), 'utf8')).toBe('{ nope');
    writeFileSync(join(dir, 'publish.json'), JSON.stringify({ video: 'renders/youtube/final.mp4', title: 'T', description: 'D', tags: ['t'] }));
    const c = await run(['meta', 'check']);
    expect(c.json).toMatchObject({ ok: true, valid: true });
    expect(c.json.problems.some((p: { field: string }) => p.field === 'video')).toBe(true); // not rendered yet: a warning
    expect(stepState('metadata')).toBe('done');
  });

  it('next: metadata passes by publish.json alone; thumbnail by an existing image in it', async () => {
    const all = ['ingest', 'sync', 'analyze', 'transcribe', 'rough-cut', 'multicam', 'captions', 'sfx', 'layout', 'preview', 'check', 'final'];
    for (const s of all) await run(['step', s, 'done']);
    mkdirSync(join(dir, 'derived', 'transcripts'), { recursive: true });
    writeFileSync(join(dir, 'derived', 'transcripts', 'main.json'), '{"words":[]}');
    await run(['edit', '--ops', JSON.stringify([{ op: 'addSource', id: 'cam', source: cam }])]);
    expect((await run(['next'])).json.step).toBe('thumbnail');
    writeFileSync(join(dir, 'publish.json'), JSON.stringify({ video: 'renders/youtube/final.mp4', title: 'T', description: 'D', tags: ['t'], thumbnail: 'thumbnails/thumb-1.png' }));
    expect((await run(['next'])).json).toMatchObject({ step: 'thumbnail', state: 'ready' });
    mkdirSync(join(dir, 'thumbnails'), { recursive: true });
    writeFileSync(join(dir, 'thumbnails', 'thumb-1.png'), Buffer.alloc(100, 1));
    expect((await run(['next'])).json).toMatchObject({ step: 'done', state: 'done' });
    writeFileSync(join(dir, 'publish.json'), JSON.stringify({ video: 'renders/youtube/final.mp4', title: '', description: 'D', tags: ['t'], thumbnail: 'thumbnails/thumb-1.png' }));
    const n = await run(['next']);
    expect(n.json).toMatchObject({ step: 'metadata', state: 'ready' });
    expect(n.json.why).toContain('title');
  });

  it('thumb pick sets publish.json "thumbnail" (inside the project, PNG/JPEG only) and finishes the step', async () => {
    await seed();
    mkdirSync(join(dir, 'thumbnails'), { recursive: true });
    writeFileSync(join(dir, 'thumbnails', 'a.png'), Buffer.alloc(100, 1));
    writeFileSync(join(dir, 'thumbnails', 'a.gif'), Buffer.alloc(100, 1));
    const r = await run(['thumb', 'pick', join(dir, 'thumbnails', 'a.png')]);
    expect(r.json, r.stdout).toMatchObject({ ok: true });
    expect(pub()).toMatchObject({ thumbnail: 'thumbnails/a.png', video: 'renders/youtube/final.mp4', title: '設定のコツ' });
    expect(stepState('thumbnail')).toBe('done');
    expect((await run(['thumb', 'pick', join(dir, 'thumbnails', 'a.gif')])).code).toBe(2);
    writeFileSync(join(sb.root, 'outside.png'), Buffer.alloc(100, 1));
    expect((await run(['thumb', 'pick', join(sb.root, 'outside.png')])).code).toBe(2);
    // a sibling folder whose name starts like the project is still outside
    mkdirSync(`${dir}-other`, { recursive: true });
    writeFileSync(join(`${dir}-other`, 'x.png'), Buffer.alloc(100, 1));
    expect((await run(['thumb', 'pick', join(`${dir}-other`, 'x.png')])).code).toBe(2);
    expect(pub().thumbnail).toBe('thumbnails/a.png');
  });

  it('thumb gen refuses paid image APIs', async () => {
    await seed();
    for (const prov of ['openai', 'gemini']) {
      const r = await run(['thumb', 'gen', '--frame', '10', '--provider', prov]);
      expect(r.code, prov).toBe(2);
      expect(r.json.error.message).toMatch(/codex|frame/);
    }
  });
});

describe('past reuse', () => {
  it('turns scenes, sfx and caption style of a past video into ops and a template patch', async () => {
    await seed();
    await run(['edit', '--ops', JSON.stringify([{ op: 'setCaptions', captions: [{ id: 'cap_1', range: { start: 0, end: 30 }, text: 'a', spoken: 'a', words: [], lines: ['a'], emphasis: [], style: 'tiktok-bold', position: { anchor: 'bottom', y: 0.9 }, decided }] }])]);
    const id = (await run(['past', 'register'])).json.entry.id as string;
    // a new project with the same take but no scenes/sfx/bgm, different caption style
    const d2 = join(sb.root, 'v2');
    await sb.run(['init', d2, '--template', 'talk-youtube', '--no-git', '--json']);
    const ops2 = [
      { op: 'addSource', id: 'cam', source: cam },
      { op: 'setOutline', outline: [{ id: 'ch_1', title: 'a', start: 0, end: 450, points: [], importance: 'core' }, { id: 'ch_2', title: 'b', start: 450, end: 900, points: [], importance: 'core' }] },
      { op: 'addSegment', segment: seg('seg_1', 0, 450) },
      { op: 'addSegment', segment: seg('seg_2', 450, 900, 'ch_2') },
      { op: 'setCaptions', captions: [{ id: 'cap_1', range: { start: 0, end: 30 }, text: 'b', spoken: 'b', words: [], lines: ['b'], emphasis: [], style: 'youtube-clean', position: { anchor: 'bottom', y: 0.9 }, decided }] },
    ];
    await sb.run(['edit', '--ops', JSON.stringify(ops2), '--json'], { cwd: d2 });
    const dry = await sb.run(['past', 'reuse', id, '--what', 'scenes,sfx,captions,pacing,thumbnail-style', '--json'], { cwd: d2 });
    expect(dry.json, dry.stdout).toMatchObject({ ok: true, applied: false, templatePatch: { captions: { style: 'tiktok-bold' } } });
    const opNames = dry.json.ops.map((o: { op: string }) => o.op);
    expect(opNames, JSON.stringify(dry.json.ops.filter((o: { op: string }) => o.op === 'addSfx'))).toEqual(['addSource', 'setMeta', 'addScene', 'updateCaption', 'addSfx']);
    const scene = dry.json.ops.find((o: { op: string }) => o.op === 'addScene').scene;
    expect(scene.range).toEqual({ start: 450, end: 510 }); // same relative position (50 %)
    expect(scene.decided.needsReview).toBe(true);
    expect(dry.json.ops.filter((o: { op: string }) => o.op === 'addSfx').map((o: { sfx: { at: number } }) => o.sfx.at)).toEqual([0]); // past: 1 section sfx per 3 chapters → every 3rd chapter
    const before = readFileSync(join(d2, 'timeline.json'), 'utf8');
    expect(readFileSync(join(d2, 'timeline.json'), 'utf8')).toBe(before);
    const ap = await sb.run(['past', 'reuse', id, '--what', 'scenes,sfx,captions', '--apply', '--json'], { cwd: d2 });
    expect(ap.json, ap.stdout).toMatchObject({ ok: true, applied: true, templateFile: 'templates/talk-youtube/template.yaml' });
    const t2 = JSON.parse(readFileSync(join(d2, 'timeline.json'), 'utf8'));
    expect(t2.meta.references[0]).toMatchObject({ archive: id, use: ['scenes', 'sfx', 'captions'] });
    expect(t2.sources.pop.kind).toBe('asset');
    expect(t2.captions[0].style).toBe('tiktok-bold');
    // the project template override is used by the CLI
    const tpl = await sb.run(['next', '--json'], { cwd: d2 });
    expect(tpl.json.ok).toBe(true);
    expect(readFileSync(join(d2, 'templates', 'talk-youtube', 'template.yaml'), 'utf8')).toContain('"extends": "talk-youtube"');
    expect((await sb.run(['past', 'reuse', id, '--what', 'colors', '--json'], { cwd: d2 })).code).toBe(2);
    expect((await sb.run(['past', 'reuse', 'arc_nope', '--json'], { cwd: d2 })).json.error.code).toBe('archive');
  });
});

describe('mcp end to end', () => {
  it('serves real CLI commands for a project', async () => {
    await seed();
    const server = createMcpServer(async (argv) => {
      let stdout = '';
      let stderr = '';
      const code = await main(argv, { cwd: sb.root, env: { ...process.env, FERRET_VIDEO_HOME: sb.home }, stdout: (x) => (stdout += x), stderr: (x) => (stderr += x) });
      return { code, stdout, stderr };
    }, { defaultProject: dir });
    const next = (await server.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'next', arguments: {} } })) as { result: { content: { text: string }[]; isError: boolean } };
    if (next.result.isError) throw new Error(next.result.content[0]!.text);
    expect(JSON.parse(next.result.content[0]!.text).step).toBe('ingest');
    const show = (await server.handle({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'tl_show', arguments: { id: 'seg_2' } } })) as { result: { content: { text: string }[] } };
    expect(JSON.parse(show.result.content[0]!.text).element.id).toBe('seg_2');
    const edit = (await server.handle({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'edit', arguments: { ops: [{ op: 'setMeta', patch: { goal: 'MCP から' } }] } } })) as { result: { isError: boolean } };
    expect(edit.result.isError).toBe(false);
    expect(timeline().meta.goal).toBe('MCP から');
    // an edit that would leave the BGM past the end is rejected and reported as a tool error
    const bad = (await server.handle({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'edit', arguments: { ops: [{ op: 'removeSegment', id: 'seg_3', decided: { by: 'agent', reason: 'x' } }] } } })) as { result: { isError: boolean; content: { text: string }[] } };
    expect(bad.result.isError).toBe(true);
    expect(JSON.parse(bad.result.content[0]!.text).error.code).toBe('invalid-result');
  });

  it('`ferret-video mcp` reads JSON-RPC lines from stdin', async () => {
    let out = '';
    async function* lines() {
      yield JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
      yield JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' });
      yield JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'status', arguments: {} } });
    }
    const code = await main(['mcp', '--project', dir], { cwd: sb.root, env: { ...process.env, FERRET_VIDEO_HOME: sb.home }, stdout: (x) => (out += x), stderr: () => {}, stdinLines: lines });
    expect(code).toBe(0);
    const msgs = out.trim().split('\n').map((l) => JSON.parse(l));
    expect(msgs).toHaveLength(2);
    expect(msgs[0].result.serverInfo.name).toBe('ferret-video');
    expect(JSON.parse(msgs[1].result.content[0].text).steps).toHaveLength(14);
  });
});

describe('progress output', () => {
  const ctx = (isTTY: boolean, json = false) => {
    let err = '';
    const c = { io: { cwd: '/', env: {}, stdout: () => {}, stderr: (s: string) => (err += s), isTTY }, json, lang: 'ja', by: 'human' } as unknown as Ctx;
    return { c, err: () => err };
  };
  it('non-TTY: at most one line per 10 %', () => {
    const { c, err } = ctx(false);
    for (let i = 0; i <= 100; i++) progress(c, 'k', i / 100, 'dl');
    progressDone(c, 'k');
    const lines = err().trim().split('\n');
    expect(lines).toHaveLength(11);
    expect(lines[0]).toBe('dl 0%');
    expect(lines.at(-1)).toBe('dl 100%');
    expect(err()).not.toContain('\r');
  });
  it('TTY: redraws one line', () => {
    const t = ctx(true);
    progress(t.c, 'k', 0.5, 'dl');
    progressDone(t.c, 'k');
    expect(t.err()).toMatch(/^\rdl \[#{12}\.{12}\] 50% {3}\n$/);
  });
  it('--json: NDJSON on stderr, at most one line per 1 %', () => {
    const j = ctx(false, true);
    for (let i = 0; i <= 1000; i++) progress(j.c, 'lib:ffmpeg', i / 1000, 'ffmpeg', { tool: 'ffmpeg', received: i, total: 1000 });
    progressDone(j.c, 'lib:ffmpeg');
    const lines = j.err().trim().split('\n').map((l) => JSON.parse(l));
    expect(lines).toHaveLength(101);
    expect(lines[50]).toEqual({ progress: { task: 'lib:ffmpeg', fraction: 0.5, label: 'ffmpeg', tool: 'ffmpeg', received: 500, total: 1000 } });
  });
});
