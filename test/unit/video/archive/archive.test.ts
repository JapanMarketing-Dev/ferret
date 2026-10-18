import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { emptyTimeline, type Segment, type Timeline } from '@video/core';
import {
  ArchiveError, archiveDir, compareStats, computeStats, getArchive, listArchive, readIndex, rebuildIndex, registerProject,
  searchArchive, tokenize,
} from '@video/archive';

let home: string;
const saved = process.env.FERRET_VIDEO_HOME;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'ferret-video-arc-'));
  process.env.FERRET_VIDEO_HOME = join(home, 'h');
});
afterEach(() => {
  if (saved === undefined) delete process.env.FERRET_VIDEO_HOME;
  else process.env.FERRET_VIDEO_HOME = saved;
  rmSync(home, { recursive: true, force: true });
});

const decided = { by: 'rule' as const, reason: 'test' };

function seg(id: string, from: number, to: number, start: number, extra: Partial<Segment> = {}): Segment {
  return {
    id, range: { start, end: start + (to - from) }, src: { from, to, take: 'take_1' }, text: '', chapter: 'ch_1', role: 'explain',
    video: { layout: 'camera-full', camera: 'cam_front' }, decided, ...extra,
  };
}

function timeline(o: { title?: string; goal?: string; kind?: 'tech' | 'talk'; template?: string; captions?: string[] } = {}): Timeline {
  const t = emptyTimeline({
    title: o.title ?? 'Claude Code の設定 3つのコツ', kind: o.kind ?? 'tech', template: { id: o.template ?? 'tech-tutorial', version: '1' },
    canvas: { width: 1920, height: 1080, fps: { num: 30, den: 1 } }, language: 'ja', targets: ['youtube'],
  });
  t.meta.goal = o.goal ?? '設定のコツを伝える';
  t.meta.audience = 'Claude Code を使い始めたエンジニア';
  t.sources.cam_front = { kind: 'camera', path: 'media/takes/take_1/camera-1.mp4', take: 'take_1', role: 'front', fps: { num: 30, den: 1 }, size: { width: 1920, height: 1080 }, offset: 0 };
  t.sources.cam_close = { kind: 'camera', path: 'media/takes/take_1/camera-2.mp4', take: 'take_1', role: 'close', fps: { num: 30, den: 1 }, size: { width: 1920, height: 1080 }, offset: 0 };
  t.outline = [{ id: 'ch_1', title: 'はじめに', start: 0, end: 900, points: ['設定ファイルの場所'], importance: 'core' }];
  t.segments = [
    seg('seg_1', 0, 300, 0, { role: 'hook', removedNeighbors: [{ kind: 'silence', src: { from: 300, to: 330 }, decided }] }),
    seg('seg_2', 330, 600, 300, { transitionIn: { kind: 'jump-zoom', frames: 0 }, video: { layout: 'camera-full', camera: 'cam_close' }, removedNeighbors: [{ kind: 'filler', src: { from: 600, to: 660 }, decided }] }),
    seg('seg_3', 660, 960, 570, { decided: { ...decided, needsReview: true } }),
  ];
  t.captions = (o.captions ?? ['この設定を変えると速くなります', 'まずはファイルを開きます']).map((text, i) => ({
    id: `cap_${i + 1}`, range: { start: i * 60, end: i * 60 + 50 }, text, spoken: text, words: [], lines: [text], emphasis: i === 0 ? [{ word: '速く', style: 'color' as const }] : [],
    style: 'youtube-clean', position: { anchor: 'bottom' as const, y: 0.9 }, decided,
  }));
  t.audio.sfx = [{ id: 'sfx_1', asset: 'cam_front', at: 10, gainDb: -12, trigger: 'section', decided }];
  t.audio.bgm = [{ id: 'bgm_1', asset: 'cam_front', range: { start: 0, end: 870 }, gainDb: -24, duckDb: -12, fadeIn: 0, fadeOut: 0, decided }];
  t.scenes = [{ id: 'scn_1', pattern: { id: 'big-number', version: '1' }, range: { start: 0, end: 30 }, slots: {}, decided }];
  return t;
}

function project(name: string, t: Timeline, id = `prj_${name}`): string {
  const dir = join(home, name);
  mkdirSync(join(dir, 'renders'), { recursive: true });
  writeFileSync(join(dir, 'ferret-video.json'), JSON.stringify({ schema: 1, id, title: t.meta.title, template: t.meta.template, language: 'ja', created: '2026-10-01T00:00:00.000Z' }));
  writeFileSync(join(dir, 'timeline.json'), JSON.stringify(t));
  return dir;
}

describe('tokenize', () => {
  it('makes CJK bigrams and lowercase latin words', () => {
    expect(tokenize('Claude Code の設定')).toEqual(['claude', 'code', 'の設', '設定']);
    expect(tokenize('設')).toEqual(['設']);
    expect(tokenize('ＡＢＣ１２３')).toEqual(['abc123']); // NFKC
    expect(tokenize('a 1 x2')).toEqual(['1', 'x2']);
    expect(tokenize('カタカナとひらがな')).toContain('カタ');
    expect(tokenize('!!!')).toEqual([]);
  });
});

describe('computeStats', () => {
  it('computes pacing and style stats', () => {
    const s = computeStats(timeline());
    expect(s.segments).toBe(3);
    expect(s.durationFrames).toBe(870);
    expect(s.durationSec).toBe(29);
    expect(s.avgSegmentSec).toBeCloseTo(9.67, 2);
    expect(s.cutRatio).toBeCloseTo(90 / 960, 3);
    expect(s.removedByKind).toEqual({ silence: 1, filler: 2 });
    expect(s.jumpCuts).toBe(2);
    expect(s.zooms).toBe(1);
    expect(s.captions).toBe(2);
    expect(s.emphasisRatio).toBe(0.5);
    expect(s.sfx).toBe(1);
    expect(s.bgmLevelDb).toBe(-24);
    expect(s.scenes).toEqual({ 'big-number': 1 });
    expect(s.cameraSwitches).toBe(2);
    expect(s.roles).toEqual({ hook: 1, explain: 2 });
    expect(s.needsReview).toBe(1);
    expect(s.chapters).toBe(1);
  });

  it('handles an empty timeline without dividing by zero', () => {
    const t = emptyTimeline({ title: 'x', kind: 'talk', template: { id: 'talk-youtube', version: '1' }, canvas: { width: 1920, height: 1080, fps: { num: 30, den: 1 } }, language: 'ja', targets: ['youtube'] });
    const s = computeStats(t);
    expect(s).toMatchObject({ segments: 0, durationSec: 0, avgSegmentSec: 0, cutRatio: 0, captionsPerMin: 0, emphasisRatio: 0, bgmLevelDb: null });
  });

  it('compareStats lists differences', () => {
    const a = computeStats(timeline());
    const b = { ...a, avgSegmentSec: a.avgSegmentSec + 2 };
    expect(compareStats(a, b).find((x) => x.key === 'avgSegmentSec')!.diff).toBe(2);
  });
});

describe('register / list / search / get', () => {
  it('registers a project with timeline, summary, stats and thumbnail', async () => {
    const t = timeline();
    t.outputs = [{
      target: 'youtube', canvas: t.canvas, preset: 'youtube', thumbnail: { path: 'renders/thumb.png', frame: 0 },
      metadata: { title: 't', titleCandidates: [], description: 'Claude Code の便利な使い方', tags: ['claude', 'AI'], chapters: true },
    }];
    const dir = project('p1', t);
    writeFileSync(join(dir, 'renders', 'thumb.png'), 'png');
    const e = await registerProject(dir, { reason: 'export', now: new Date('2026-10-11T00:00:00Z') });
    expect(e.id).toBe('arc_2026-10-11_claude-code-3');
    expect(e).toMatchObject({ projectId: 'prj_p1', kind: 'tech', reason: 'export', versions: 1, thumbnail: 'thumbnail.png', tags: ['claude', 'AI'] });
    expect(e.chapters).toEqual([{ title: 'はじめに', points: ['設定ファイルの場所'], startSec: 0 }]);
    for (const f of ['timeline.json', 'summary.json', 'stats.json', 'thumbnail.png']) expect(existsSync(join(archiveDir(), e.id, f)), f).toBe(true);
    const got = getArchive(e.id);
    expect(got.entry.title).toBe(t.meta.title);
    expect(got.stats.segments).toBe(3);
    expect(got.timeline.segments).toHaveLength(3);
  });

  it('re-registering the same project keeps the id and stores the previous version', async () => {
    const t = timeline();
    const dir = project('p1', t);
    const a = await registerProject(dir, { reason: 'export', now: new Date('2026-10-11T00:00:00Z') });
    t.meta.title = '新しいタイトル';
    writeFileSync(join(dir, 'timeline.json'), JSON.stringify(t));
    const b = await registerProject(dir, { reason: 'publish', now: new Date('2026-10-12T00:00:00Z') });
    expect(b.id).toBe(a.id);
    expect(b.versions).toBe(2);
    expect(JSON.parse(readFileSync(join(archiveDir(), a.id, 'versions', '1.json'), 'utf8')).meta.title).toBe('Claude Code の設定 3つのコツ');
    expect(listArchive()).toHaveLength(1);
    // the old title no longer matches; the new one does
    expect(searchArchive('新しい')).toHaveLength(1);
    expect(searchArchive('3つの').length).toBe(0);
  });

  it('different projects with the same title get distinct ids', async () => {
    const now = new Date('2026-10-11T00:00:00Z');
    const a = await registerProject(project('a', timeline(), 'prj_a'), { reason: 'manual', now });
    const b = await registerProject(project('b', timeline(), 'prj_b'), { reason: 'manual', now });
    expect(a.id).not.toBe(b.id);
    expect(b.id).toBe(`${a.id}-2`);
  });

  it('Japanese search via bigrams over title, goal, chapters and captions; AND semantics', async () => {
    await registerProject(project('a', timeline()), { reason: 'export', now: new Date('2026-10-01T00:00:00Z') });
    await registerProject(project('b', timeline({ title: 'カメラの選び方', goal: 'カメラ選びを伝える', kind: 'talk', template: 'talk-youtube', captions: ['レンズは明るいものを'] })), { reason: 'export', now: new Date('2026-10-02T00:00:00Z') });
    expect(searchArchive('コツ').map((e) => e.title)).toEqual(['Claude Code の設定 3つのコツ']);
    expect(searchArchive('設定')).toHaveLength(2); // chapter points of both
    expect(searchArchive('claude コツ')).toHaveLength(1);
    expect(searchArchive('CLAUDE')).toHaveLength(2); // case-insensitive (audience of both)
    expect(searchArchive('レンズ').map((e) => e.title)).toEqual(['カメラの選び方']); // caption text
    expect(searchArchive('ファイルの場所')).toHaveLength(2); // chapter points
    expect(searchArchive('エンジニア')).toHaveLength(2); // audience (both)
    expect(searchArchive('コツ レンズ')).toEqual([]); // AND
    expect(searchArchive('存在しない語')).toEqual([]);
    expect(searchArchive('  ')).toEqual([]);
    expect(searchArchive('エンジニア', { limit: 1 })).toHaveLength(1);
  });

  it('lists newest first with filters', async () => {
    await registerProject(project('a', timeline()), { reason: 'export', now: new Date('2026-10-01T00:00:00Z') });
    await registerProject(project('b', timeline({ title: 'Talk', kind: 'talk', template: 'talk-youtube' })), { reason: 'export', now: new Date('2026-10-02T00:00:00Z') });
    expect(listArchive().map((e) => e.title)).toEqual(['Talk', 'Claude Code の設定 3つのコツ']);
    expect(listArchive({ kind: 'tech' })).toHaveLength(1);
    expect(listArchive({ template: 'talk-youtube' })[0]!.title).toBe('Talk');
    expect(listArchive({ limit: 1 })).toHaveLength(1);
    expect(listArchive({ limit: 0 })).toHaveLength(0);
    expect(listArchive({ target: 'tiktok' })).toHaveLength(0);
  });

  it('rebuilds a corrupt index from the entry folders', async () => {
    await registerProject(project('a', timeline()), { reason: 'export' });
    writeFileSync(join(archiveDir(), 'index.json'), '{broken');
    expect(searchArchive('設定')).toHaveLength(1);
    expect(readIndex().schema).toBe(1);
    expect(Object.keys(rebuildIndex().entries)).toHaveLength(1);
  });

  it('an empty archive lists nothing', () => {
    expect(listArchive()).toEqual([]);
    expect(searchArchive('x1')).toEqual([]);
  });

  it('errors: not a project, invalid timeline, unknown or invalid id', async () => {
    await expect(registerProject(join(home, 'nothing'), { reason: 'manual' })).rejects.toThrow(ArchiveError);
    const dir = project('bad', timeline());
    writeFileSync(join(dir, 'timeline.json'), '{"schema": 2}');
    await expect(registerProject(dir, { reason: 'manual' })).rejects.toThrow(/timeline.json/);
    expect(() => getArchive('arc_nope')).toThrow(/not found/);
    expect(() => getArchive('../../etc')).toThrow(/invalid archive id/);
  });
});
