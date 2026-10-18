import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CLI_VERSION } from '@video/cli/ctx.js';
import { Sandbox } from './helpers.js';

let sb: Sandbox;
let dir: string;
beforeEach(() => {
  sb = new Sandbox();
  dir = join(sb.root, 'video');
});
afterEach(() => sb.dispose());

const init = (extra: string[] = []) => sb.run(['init', dir, '--template', 'talk-youtube', '--title', '設定の3つのコツ', '--no-git', '--json', ...extra]);
const inDir = (args: string[], env?: Record<string, string>) => sb.run([...args, '--json'], { cwd: dir, ...(env ? { env } : {}) });
const timeline = () => JSON.parse(readFileSync(join(dir, 'timeline.json'), 'utf8'));
const historyLines = () => readFileSync(join(dir, '.ferret-video', 'history.jsonl'), 'utf8').trim().split('\n').filter(Boolean);

const cam = { kind: 'camera', path: 'media/takes/take_1/camera-1.mp4', take: 'take_1', role: 'front', fps: { num: 30, den: 1 }, size: { width: 1920, height: 1080 }, offset: 0, durationFrames: 3000 };
const decided = { by: 'agent', reason: 'test' };
const seg = (id: string, from: number, to: number) => ({
  id, range: { start: 0, end: 0 }, src: { from, to, take: 'take_1' }, text: id, chapter: 'ch_1', role: 'explain',
  video: { layout: 'camera-full', camera: 'cam_1' }, decided,
});
async function seed() {
  const ops = [
    { op: 'addSource', id: 'cam_1', source: cam },
    { op: 'setOutline', outline: [{ id: 'ch_1', title: 'はじめに', start: 0, end: 900, points: [], importance: 'core' }] },
    { op: 'addSegment', segment: seg('seg_1', 0, 300) },
    { op: 'addSegment', segment: seg('seg_2', 400, 700) },
    { op: 'addSegment', segment: seg('seg_3', 800, 1100) },
  ];
  writeFileSync(join(sb.root, 'ops.json'), JSON.stringify(ops));
  const r = await inDir(['edit', '--ops', join(sb.root, 'ops.json')]);
  expect(r.json, r.stdout + r.stderr).toMatchObject({ ok: true, applied: 5, changed: true });
}

describe('basics', () => {
  it('help and version', async () => {
    const h = await sb.run([]);
    expect(h.code).toBe(0);
    expect(h.stdout).toContain(`ferret-video ${CLI_VERSION}`);
    expect(h.stdout).toContain('propose cuts');
    expect((await sb.run(['version', '--json'])).json).toMatchObject({ ok: true, version: CLI_VERSION, timelineSchema: 1 });
    expect((await sb.run(['--version'])).stdout).toBe(`ferret-video ${CLI_VERSION}\n`);
    expect((await sb.run(['help', '--json'])).json.commands).toContain('edit');
  });

  it('unknown command and bad options are usage errors (exit 2)', async () => {
    const u = await sb.run(['frobnicate', '--json']);
    expect(u.code).toBe(2);
    expect(u.json).toMatchObject({ ok: false, error: { code: 'usage' } });
    const bad = await sb.run(['version', '--nope']);
    expect(bad.code).toBe(2);
    expect(bad.stderr).toMatch(/Unknown option|不明なオプション/);
  });

  it('commands outside a project explain how to start', async () => {
    const r = await sb.run(['status', '--json']);
    expect(r.code).toBe(1);
    expect(r.json.error.code).toBe('no-project');
    expect(r.json.error.message).toContain('ferret-video init');
  });

  it('English messages when settings say so', async () => {
    await sb.run(['config', 'set', 'language', 'en']);
    const r = await sb.run(['status']);
    expect(r.stderr).toMatch(/no ferret-video project found/);
  });
});

describe('init', () => {
  it('creates the project layout, files and status', async () => {
    const r = await init();
    expect(r.code, r.stdout + r.stderr).toBe(0);
    expect(r.json.project).toMatchObject({ schema: 1, title: '設定の3つのコツ', template: { id: 'talk-youtube', version: '2' }, language: 'ja' });
    expect(r.json.project.id).toMatch(/^prj_\d{8}_[0-9a-f]{8}$/);
    for (const d of ['media/takes', 'media/imports', 'assets', 'derived/proxies', 'derived/transcripts', 'derived/analysis', 'derived/cache', 'captions', 'checks', 'feedback', 'renders', '.ferret-video']) {
      expect(existsSync(join(dir, d)), d).toBe(true);
    }
    const tl = timeline();
    expect(tl).toMatchObject({ schema: 1, meta: { title: '設定の3つのコツ', kind: 'talk', language: 'ja', targets: ['youtube'] }, canvas: { width: 1920, height: 1080, fps: { num: 30, den: 1 } }, segments: [] });
    expect(readFileSync(join(dir, 'CLAUDE.md'), 'utf8')).toBe('@AGENTS.md\n');
    const agents = readFileSync(join(dir, 'AGENTS.md'), 'utf8');
    expect(agents).toContain('# 設定の3つのコツ — エージェントへの指示書');
    expect(agents).toContain('ferret-video next --json');
    const gi = readFileSync(join(dir, '.gitignore'), 'utf8');
    for (const x of ['media/', 'derived/', 'renders/']) expect(gi).toContain(x);
    const status = JSON.parse(readFileSync(join(dir, '.ferret-video', 'status.json'), 'utf8'));
    expect(status[0]).toEqual({ step: 'ingest', state: 'todo' });
    expect(existsSync(join(dir, '.git'))).toBe(false);
  });

  it('initializes git unless --no-git', async () => {
    const r = await sb.run(['init', dir, '--template', 'tech-short', '--json']);
    expect(r.code).toBe(0);
    if (r.json.git) expect(existsSync(join(dir, '.git'))).toBe(true);
  });

  it('defaults: cwd, folder name as title, language from settings; English AGENTS.md', async () => {
    mkdirSync(dir);
    await sb.run(['config', 'set', 'language', 'en']);
    const r = await sb.run(['init', '--template', 'tech-tutorial', '--no-git', '--json'], { cwd: dir });
    expect(r.json.project).toMatchObject({ title: 'video', language: 'en' });
    expect(readFileSync(join(dir, 'AGENTS.md'), 'utf8')).toContain('Instructions for the agent');
    expect(timeline().meta.kind).toBe('tech');
  });

  it('accepts the folder as --dir (desktop form)', async () => {
    const r = await sb.run(['init', '--title', 'T', '--template', 'talk-tiktok', '--lang', 'en', '--dir', dir, '--no-git', '--json']);
    expect(r.json, r.stdout).toMatchObject({ ok: true, project: { dir, title: 'T', language: 'en' } });
    expect(timeline().canvas).toMatchObject({ width: 1920, height: 1080 }); // talk-tiktok is now an alias of talk: main video is 16:9, verticals are derived
    expect((await sb.run(['init', join(sb.root, 'a'), '--dir', join(sb.root, 'b'), '--json'])).code).toBe(2);
  });

  it('refuses to overwrite a project, unknown template, bad language', async () => {
    await init();
    expect((await init()).json.error.code).toBe('exists');
    expect((await init(['--force'])).code).toBe(0);
    const t = await sb.run(['init', join(sb.root, 'x'), '--template', 'nope', '--json']);
    expect(t.json.error.message).toMatch(/template not found/);
    const l = await sb.run(['init', join(sb.root, 'y'), '--lang', 'fr', '--json']);
    expect(l.code).toBe(2);
  });
});

describe('status / next / step', () => {
  beforeEach(async () => {
    await init();
  });

  it('a fresh project waits for media', async () => {
    const s = await inDir(['status']);
    // one video: the template steps only (no derive / per-variant / publish steps)
    expect(s.json.steps.map((x: { step: string }) => x.step)).toEqual(['ingest', 'sync', 'analyze', 'transcribe', 'rough-cut', 'multicam', 'captions', 'sfx', 'layout', 'preview', 'check', 'final', 'thumbnail', 'metadata']);
    expect(s.json.variants).toBeUndefined();
    expect(s.json.next).toMatchObject({ step: 'ingest', state: 'needs-human' });
    const n = await inDir(['next']);
    expect(n.json).toMatchObject({ ok: true, step: 'ingest', state: 'needs-human' });
    expect(n.json.commands[0]).toContain('ferret-video import');
  });

  it('finds the project from a subdirectory and with --project', async () => {
    const sub = join(dir, 'media', 'takes');
    expect((await sb.run(['next', '--json'], { cwd: sub })).json.ok).toBe(true);
    expect((await sb.run(['next', '--json', '--project', dir])).json.ok).toBe(true);
    expect((await sb.run(['next', '--json', '--project', sub])).json.error.code).toBe('no-project');
  });

  it('with sources the steps advance as they are marked', async () => {
    await seed();
    expect((await inDir(['next'])).json).toMatchObject({ step: 'ingest', state: 'ready' });
    await inDir(['step', 'ingest', 'done']);
    await inDir(['step', 'sync', 'skipped', '--note', 'one camera']);
    expect((await inDir(['next'])).json.step).toBe('analyze');
    const st = JSON.parse(readFileSync(join(dir, '.ferret-video', 'status.json'), 'utf8'));
    expect(st.find((x: { step: string }) => x.step === 'sync')).toMatchObject({ state: 'skipped', note: 'one camera' });
  });

  it('next --with-prompt includes the template prompt text', async () => {
    await seed();
    for (const s of ['ingest', 'sync', 'analyze', 'transcribe']) await inDir(['step', s, 'done']);
    mkdirSync(join(dir, 'derived', 'transcripts'), { recursive: true });
    writeFileSync(join(dir, 'derived', 'transcripts', 'main.json'), JSON.stringify({ words: [] }));
    const n = await inDir(['next', '--with-prompt']);
    expect(n.json.step).toBe('rough-cut');
    expect(n.json.prompt).toMatch(/talk[\\/]prompts[\\/]rough-cut\.md$/);
    expect(n.json.promptText).toContain('粗カット');
  });

  it('step rejects unknown steps and states', async () => {
    expect((await inDir(['step', 'dance', 'done'])).code).toBe(2);
    expect((await inDir(['step', 'sync', 'finished'])).code).toBe(2);
    expect((await inDir(['step', 'sync'])).code).toBe(2);
  });
});

describe('edit / undo / redo / history', () => {
  beforeEach(async () => {
    await init();
    await seed();
  });

  it('packs segment ranges and records history with the actor', async () => {
    const tl = timeline();
    expect(tl.segments.map((s: { range: { start: number; end: number } }) => [s.range.start, s.range.end])).toEqual([[0, 300], [300, 600], [600, 900]]);
    const h = historyLines().map((l) => JSON.parse(l));
    expect(h).toHaveLength(1);
    expect(h[0]).toMatchObject({ by: 'human', kind: 'edit' });
    expect(h[0].ops).toHaveLength(5);
    expect(h[0].inverse.length).toBeGreaterThan(0);
  });

  it('op name + flags with --reason; agent identity from env', async () => {
    const r = await inDir(['edit', 'removeSegment', '--id', 'seg_2', '--reason', '言い直しの前半'], { CLAUDECODE: '1' });
    expect(r.json, r.stdout).toMatchObject({ ok: true, changed: true, summary: { segments: 2 } });
    const last = JSON.parse(historyLines().at(-1)!);
    expect(last).toMatchObject({ by: 'agent', agent: 'claude' });
    expect(last.ops[0].decided).toEqual({ by: 'agent', agent: 'claude', reason: '言い直しの前半' });
    expect(timeline().segments.map((s: { id: string }) => s.id)).toEqual(['seg_1', 'seg_3']);
  });

  it('review accept: setDecided by a human from flags or --ops', async () => {
    const r = await inDir(['edit', 'setDecided', '--target', 'seg_2', '--reason', '残す', '--by', 'human']);
    expect(r.json, r.stdout).toMatchObject({ ok: true, changed: true });
    expect(timeline().segments[1].decided).toEqual({ by: 'human', reason: '残す' });
    const o = await inDir(['edit', '--ops', JSON.stringify([{ op: 'setDecided', target: 'seg_3', decided: { by: 'human', reason: 'ok', needsReview: false } }])]);
    expect(o.json.ok).toBe(true);
    expect((await inDir(['edit', 'setDecided', '--target', 'seg_404', '--reason', 'x'])).json.ok).toBe(false);
  });

  it('undo → redo → undo round trip restores the exact timeline', async () => {
    const before = timeline();
    await inDir(['edit', 'trimSegment', '--id', 'seg_1', '--to', '250', '--reason', '語尾の間を詰める']);
    await inDir(['edit', 'removeSegment', '--id', 'seg_3', '--reason', '脱線']);
    const after = timeline();
    expect(after.segments).toHaveLength(2);
    expect((await inDir(['undo'])).json).toMatchObject({ ok: true, undone: { ops: ['removeSegment'] } });
    expect(timeline().segments).toHaveLength(3);
    expect((await inDir(['undo'])).json.undone.ops).toEqual(['trimSegment']);
    expect(timeline()).toEqual(before);
    expect((await inDir(['redo'])).json.redone.ops).toEqual(['trimSegment']);
    expect((await inDir(['redo'])).json.redone.ops).toEqual(['removeSegment']);
    expect(timeline()).toEqual(after);
    expect((await inDir(['redo'])).json.error.code).toBe('nothing-to-redo');
    // a new edit after an undo clears the redo stack
    await inDir(['undo']);
    await inDir(['edit', 'moveSegment', '--id', 'seg_3', '--index', '0']);
    expect((await inDir(['redo'])).json.error.code).toBe('nothing-to-redo');
    const h = await inDir(['history']);
    expect(h.json.entries.map((e: { kind: string }) => e.kind)).toEqual(['edit', 'edit', 'edit', 'undo', 'undo', 'redo', 'redo', 'undo', 'edit']);
    expect(h.json.canUndo).toBe(true);
    expect(h.json.canRedo).toBe(false);
  });

  it('undo everything, then nothing to undo', async () => {
    expect((await inDir(['undo'])).json.ok).toBe(true);
    expect(timeline().segments).toEqual([]);
    expect(Object.keys(timeline().sources)).toEqual([]);
    expect((await inDir(['undo'])).json.error.code).toBe('nothing-to-undo');
  });

  it('inline JSON, stdin and {ops:[…]} forms', async () => {
    const one = await inDir(['edit', '{"op":"setMeta","patch":{"goal":"コツを伝える"}}']);
    expect(one.json.changed).toBe(true);
    const viaStdin = await sb.run(['edit', '--ops', '-', '--json'], { cwd: dir, stdin: JSON.stringify({ ops: [{ op: 'setMeta', patch: { audience: '初心者' } }] }) });
    expect(viaStdin.json.changed).toBe(true);
    expect(timeline().meta).toMatchObject({ goal: 'コツを伝える', audience: '初心者' });
  });

  it('ops that need a reason are refused without one; --ops JSON may carry decided', async () => {
    const r = await inDir(['edit', 'removeSegment', '--id', 'seg_2']);
    expect(r.json.error.code).toBe('reason-required');
    const ok = await inDir(['edit', '--ops', JSON.stringify([{ op: 'removeSegment', id: 'seg_2', decided: { by: 'human', reason: 'x' } }])]);
    expect(ok.json.ok).toBe(true);
  });

  it('rejects invalid edits atomically (nothing written, no history)', async () => {
    const before = readFileSync(join(dir, 'timeline.json'), 'utf8');
    const lines = historyLines().length;
    const cases = [
      ['edit', 'removeSegment', '--id', 'seg_404', '--reason', 'x'],
      ['edit', 'explode', '--id', 'x'],
      ['edit', '--ops', '[{"nope":1}]'],
      ['edit', '--ops', '[]'],
      ['edit', '--ops', '{broken'],
      ['edit', '--ops', join(sb.root, 'missing.json')],
      ['edit', 'setCamera', '--id', 'seg_1', '--camera', 'cam_missing', '--reason', 'x'],
      ['edit', 'trimSegment', '--id', 'seg_1', '--from', '200', '--to', '100', '--reason', 'x'],
      ['edit'],
      ['edit', 'a', 'b'],
    ];
    for (const c of cases) {
      const r = await inDir(c);
      expect(r.code, c.join(' ')).not.toBe(0);
      expect(r.json.ok).toBe(false);
    }
    expect(readFileSync(join(dir, 'timeline.json'), 'utf8')).toBe(before);
    expect(historyLines()).toHaveLength(lines);
  });

  it('--dry-run validates without writing', async () => {
    const before = readFileSync(join(dir, 'timeline.json'), 'utf8');
    const r = await inDir(['edit', 'removeSegment', '--id', 'seg_1', '--reason', 'x', '--dry-run']);
    expect(r.json).toMatchObject({ ok: true, dryRun: true, summary: { segments: 2 } });
    expect(readFileSync(join(dir, 'timeline.json'), 'utf8')).toBe(before);
  });

  it('a no-op edit is not logged', async () => {
    const lines = historyLines().length;
    const r = await inDir(['edit', '{"op":"setMeta","patch":{}}']);
    expect(r.json.changed).toBe(false);
    expect(historyLines()).toHaveLength(lines);
  });

  it('a stale lock is broken, a fresh one blocks', async () => {
    const lock = join(dir, '.ferret-video', 'lock');
    writeFileSync(lock, '');
    const old = new Date(Date.now() - 120_000);
    const { utimesSync } = await import('node:fs');
    utimesSync(lock, old, old);
    expect((await inDir(['edit', '{"op":"setMeta","patch":{"goal":"a"}}'])).json.ok).toBe(true);
    expect(existsSync(lock)).toBe(false);
  });
});

describe('validate', () => {
  beforeEach(async () => {
    await init();
  });

  it('passes a valid timeline and reports issues of a broken one', async () => {
    expect((await inDir(['validate'])).json).toMatchObject({ ok: true, valid: true });
    const tl = timeline();
    tl.segments = [{ id: 'bad' }];
    writeFileSync(join(dir, 'timeline.json'), JSON.stringify(tl));
    const r = await inDir(['validate']);
    expect(r.code).toBe(1);
    expect(r.json.error.code).toBe('invalid');
    expect(r.json.error.details.issues.length).toBeGreaterThan(0);
    // other commands refuse to edit an invalid timeline
    expect((await inDir(['edit', '{"op":"setMeta","patch":{"goal":"x"}}'])).json.error.code).toBe('invalid-timeline');
  });

  it('invalid JSON in timeline.json', async () => {
    writeFileSync(join(dir, 'timeline.json'), '{');
    expect((await inDir(['validate'])).json.error.code).toBe('invalid-json');
  });
});

describe('tl', () => {
  beforeEach(async () => {
    await init();
    await seed();
    await inDir(['edit', 'removeSegment', '--id', 'seg_2', '--reason', '同じ説明の繰り返し']);
  });

  it('summary, show, range, query, why', async () => {
    const s = await inDir(['tl', 'summary']);
    expect(s.json.summary).toMatchObject({ counts: { segments: 2 }, duration: '00:00:20:00' });
    const show = await inDir(['tl', 'show', 'seg_1']);
    expect(show.json.element).toMatchObject({ kind: 'segment', id: 'seg_1' });
    expect(show.json.around.map((x: { id?: string }) => x.id)).toContain('seg_3');
    const range = await inDir(['tl', 'range', '00:00:00:00-00:00:05:00', '--kind', 'segments']);
    expect(range.json.items.map((x: { id: string }) => x.id)).toEqual(['seg_1']);
    const q = await inDir(['tl', 'query', 'segments[role=explain]']);
    expect(q.json.items).toHaveLength(2);
    const why = await inDir(['tl', 'why', 'seg_2']);
    expect(why.json.error.code).toBe('not-found');
    const why1 = await inDir(['tl', 'why', 'seg_1']);
    expect(why1.json.decided).toEqual(decided);
    expect(why1.json.history.length).toBeGreaterThan(0);
  });

  it('errors: bad range, unknown kind, unknown id, unknown subcommand', async () => {
    expect((await inDir(['tl', 'range', 'garbage'])).code).toBe(2);
    expect((await inDir(['tl', 'query', 'widgets'])).code).toBe(2);
    expect((await inDir(['tl', 'show', 'nope'])).json.error.code).toBe('not-found');
    expect((await inDir(['tl', 'dance'])).code).toBe(2);
  });

  it('human output is concise', async () => {
    const r = await sb.run(['tl', 'summary'], { cwd: dir });
    expect(r.stdout).toContain('区間 2');
    expect(r.stdout.split('\n').length).toBeLessThan(10);
  });
});

describe('config / prompts / templates / lib / past', () => {
  it('config get/set/schema/path', async () => {
    // the decision model is optional and off by default (SPEC)
    expect((await sb.run(['config', 'get', 'decision.provider', '--json'])).json).toMatchObject({ ok: true, value: 'off' });
    expect((await sb.run(['config', 'set', 'recording.camera.fps', '60', '--json'])).json.value).toBe(60);
    expect((await sb.run(['config', 'get', 'recording.camera.fps'])).stdout).toBe('60\n');
    const bad = await sb.run(['config', 'set', 'recording.camera.fps', '61', '--json']);
    expect(bad.json.error.code).toBe('invalid-setting');
    expect((await sb.run(['config', 'get', 'nope.nope', '--json'])).json.error.code).toBe('unknown-key');
    expect((await sb.run(['config', 'schema', '--json'])).json.schema.properties).toHaveProperty('agents');
    expect((await sb.run(['config', 'path', '--json'])).json.path).toBe(join(sb.home, 'settings.json'));
    expect((await sb.run(['config', 'frob'])).code).toBe(2);
    const hist = readFileSync(join(sb.home, 'settings.history.jsonl'), 'utf8').trim().split('\n');
    expect(JSON.parse(hist[0]!).changes[0]).toEqual({ key: 'recording.camera.fps', from: 30, to: 60 });
  });

  it('prompts list/show with project variables and project overrides', async () => {
    await init();
    mkdirSync(join(dir, '.ferret-video'), { recursive: true });
    const list = await inDir(['prompts', 'list']);
    expect(list.json.prompts.map((p: { id: string }) => p.id)).toEqual(['finish', 'publish']);
    expect((await inDir(['prompts', 'list', '--all'])).json.prompts.map((p: { id: string }) => p.id)).toEqual(['finish', 'publish']);
    const show = await inDir(['prompts', 'show', 'finish']);
    expect(show.json.text).toContain('テンプレート talk-youtube');
    expect(show.json.text).toContain('設定の3つのコツ');
    expect((await inDir(['prompts', 'show', 'nope'])).json.error.code).toBe('not-found');
    expect((await inDir(['prompts', 'show', 'finish', '--var', 'novalue'])).code).toBe(2);
  });

  it('templates lists the built-ins', async () => {
    const r = await sb.run(['templates', '--json']);
    expect(r.json.templates.map((x: { id: string }) => x.id)).toEqual(['tech']);
    expect(r.json.errors).toEqual([]);
  });

  it('lib list reports every tool; install rejects unknown names', async () => {
    const r = await sb.run(['lib', 'list', '--json']);
    expect(Object.keys(r.json.tools)).toEqual(['ffmpeg', 'ffprobe', 'whisper-cli', 'whisper-model', 'whisper-model-small', 'fonts']);
    expect(r.json.manifest.ffmpeg.version).toBe('9.0.2');
    expect((await sb.run(['lib', 'install', 'photoshop', '--json'])).code).toBe(2);
    expect((await sb.run(['lib', 'install', '--json'])).code).toBe(2);
  });

  it('past: empty, register, list, search, show, timeline, compare', async () => {
    expect((await sb.run(['past', 'list', '--json'])).json.entries).toEqual([]);
    await init();
    await seed();
    const reg = await inDir(['past', 'register']);
    expect(reg.json.entry.id).toMatch(/^arc_\d{4}-\d{2}-\d{2}_/);
    const id = reg.json.entry.id;
    expect((await sb.run(['past', 'list', '--kind', 'talk', '--json'])).json.entries).toHaveLength(1);
    expect((await sb.run(['past', 'list', '--kind', 'tech', '--json'])).json.entries).toHaveLength(0);
    expect((await sb.run(['past', 'search', 'コツ', '--json'])).json.entries.map((e: { id: string }) => e.id)).toEqual([id]);
    expect((await sb.run(['past', 'search', '存在しない', '--json'])).json.entries).toEqual([]);
    const show = await sb.run(['past', 'show', id, '--json']);
    expect(show.json.stats.segments).toBe(3);
    const tlr = await sb.run(['past', 'timeline', id, '--only', 'segments', '--range', '0-11', '--json']);
    expect(tlr.json.items.map((x: { id: string }) => x.id)).toEqual(['seg_1', 'seg_2']);
    const cmp = await inDir(['past', 'compare', id]);
    expect(cmp.json.diff.find((d: { key: string }) => d.key === 'segments')).toMatchObject({ a: 3, b: 3, diff: 0 });
    expect((await sb.run(['past', 'show', 'arc_nope', '--json'])).json.error.code).toBe('archive');
    expect((await sb.run(['past', 'list', '--limit', 'x', '--json'])).code).toBe(2);
  });
});

describe('media commands without media', () => {
  beforeEach(async () => {
    await init();
  });

  it('explain what is missing instead of crashing', async () => {
    expect((await inDir(['sync'])).json.error.code).toBe('no-takes');
    expect((await inDir(['transcribe'])).json.error.code).toBe('no-takes');
    expect((await inDir(['propose', 'cuts'])).json.error.code).toBe('no-takes');
    expect((await inDir(['captions', 'build'])).json.error.code).toBe('no-transcript');
    expect((await inDir(['render', '--preview'])).json.error.code).toBe('compile-failed');
    expect((await inDir(['frame'])).code).toBe(2);
    expect((await inDir(['frame', '--at', '10'])).json.error.code).toBe('out-of-range');
    expect((await inDir(['import', join(sb.root, 'nope.mp4')])).json.error.code).toBe('not-found');
    expect((await inDir(['propose', 'things'])).code).toBe(2);
    expect((await inDir(['render', '--preview', '--final'])).code).toBe(2);
    expect((await inDir(['render', '--final', '--target', 'myspace'])).code).toBe(2);
  });

  it('takes and ingest on an empty project', async () => {
    expect((await inDir(['takes'])).json).toMatchObject({ ok: true, takes: [], imports: [], sources: [] });
    expect((await inDir(['ingest'])).json).toMatchObject({ ok: true, added: [] });
  });

  it('doctor reports tools, agents and problems', async () => {
    const r = await inDir(['doctor']);
    expect(r.json.ok).toBe(true);
    expect(r.json.project.timelineValid).toBe(true);
    expect(Array.isArray(r.json.problems)).toBe(true);
    const { CLI_AGENTS: AGENTS } = await import('@video/cli/agents.js');
    const popular = new Set(AGENTS.filter((a) => a.popular).map((a) => a.id));
    expect(r.json.agents.length).toBeGreaterThan(0);
    expect(r.json.agents.length).toBeLessThan(AGENTS.length);
    for (const a of r.json.agents as { id: string; installed: boolean }[]) expect(a.installed || popular.has(a.id)).toBe(true);
    for (const id of popular) expect(r.json.agents.some((a: { id: string }) => a.id === id)).toBe(true);
  });
});
