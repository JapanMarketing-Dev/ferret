import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_VIDEO, YT_DESCRIPTION_MAX_BYTES, cleanTags, composeDescription, defaultPublish, mergePublish, projectFileExists, publishStatus, readPublish,
  safeRelPath, tagsLength, validatePublish,
} from '@video/cli/publishJson.js';
import { patchFromFile } from '@video/cli/commands/meta.js';
import { ruleJudge } from '@video/cli/commands/media.js';

const ok = { video: DEFAULT_VIDEO, title: 'T', description: 'D', tags: ['a'] };
const errors = (raw: unknown, o: Parameters<typeof validatePublish>[1] = {}) => validatePublish(raw, o).problems.filter((p) => p.level === 'error').map((p) => p.field);

describe('safeRelPath', () => {
  it('keeps paths inside the project, normalized with /', () => {
    expect(safeRelPath('renders/youtube/final.mp4')).toBe('renders/youtube/final.mp4');
    expect(safeRelPath('./a//b/../c.png')).toBe('a/c.png');
    expect(safeRelPath('a\\b.png')).toBe('a/b.png');
    expect(safeRelPath(' x.png ')).toBe('x.png');
  });
  it('rejects absolute, drive, escaping, empty and NUL paths', () => {
    for (const p of ['/etc/x.png', 'C:/x.png', 'c:\\x.png', '../x.png', 'a/../../x.png', '', '   ', '.', 'a\0b.png']) expect(safeRelPath(p), p).toBeNull();
  });
});

describe('cleanTags / tagsLength', () => {
  it('splits on , 、 and newlines, strips #, drops empties and case-insensitive duplicates', () => {
    expect(cleanTags('#claude, 設定 、AI\n,Claude,,  ')).toEqual(['claude', '設定', 'AI']);
    expect(cleanTags(['a', 3, '#b', 'A', ' '] as unknown[])).toEqual(['a', 'b']);
    expect(cleanTags('')).toEqual([]);
  });
  it('counts like YouTube: commas between tags, quotes around tags with spaces', () => {
    expect(tagsLength([])).toBe(0);
    expect(tagsLength(['ab'])).toBe(2);
    expect(tagsLength(['ab', 'cd'])).toBe(5);
    expect(tagsLength(['a b'])).toBe(5);
    expect(tagsLength(['日本語'])).toBe(3);
  });
});

describe('validatePublish', () => {
  it('a minimal valid post', () => {
    expect(validatePublish(ok)).toMatchObject({ valid: true, thumbnail: false });
    // a fresh file (made by thumb pick) is not a written post yet
    expect(validatePublish(defaultPublish('題名'))).toMatchObject({ valid: false });
    expect(validatePublish({ ...defaultPublish('題名'), description: '本文' })).toMatchObject({ valid: true });
  });

  it('not an object / missing title / non-string description / bad tags are errors', () => {
    expect(validatePublish(null).valid).toBe(false);
    expect(validatePublish([]).valid).toBe(false);
    expect(validatePublish('x').valid).toBe(false);
    expect(errors({ ...ok, title: '   ' })).toEqual(['title']);
    expect(errors({ ...ok, title: 3 })).toEqual(['title']);
    expect(errors({ ...ok, description: undefined })).toEqual(['description']);
    expect(errors({ ...ok, tags: 'a,b' })).toEqual(['tags']);
    expect(errors({ ...ok, tags: ['a', 1] })).toEqual(['tags']);
  });

  it('boundaries: title 100 code points ok, 101 not; emoji count as one', () => {
    expect(validatePublish({ ...ok, title: 'あ'.repeat(100) }).valid).toBe(true);
    expect(validatePublish({ ...ok, title: 'あ'.repeat(101) }).valid).toBe(false);
    expect(validatePublish({ ...ok, title: '😀'.repeat(100) }).valid).toBe(true);
  });

  it('boundaries: description 5000 UTF-8 bytes ok, 5001 not (Japanese is 3 bytes a char)', () => {
    expect(validatePublish({ ...ok, description: 'a'.repeat(YT_DESCRIPTION_MAX_BYTES) }).valid).toBe(true);
    expect(validatePublish({ ...ok, description: 'a'.repeat(YT_DESCRIPTION_MAX_BYTES + 1) }).valid).toBe(false);
    expect(validatePublish({ ...ok, description: 'あ'.repeat(1666) + 'aa' }).valid).toBe(true); // 5000 bytes
    expect(validatePublish({ ...ok, description: 'あ'.repeat(1667) }).valid).toBe(false); // 5001 bytes
  });

  it('boundaries: tags 500 ok, 501 not; < and > are refused everywhere', () => {
    const tags = (n: number) => [`${'x'.repeat(n)}`];
    expect(validatePublish({ ...ok, tags: tags(500) }).valid).toBe(true);
    expect(validatePublish({ ...ok, tags: tags(501) }).valid).toBe(false);
    expect(errors({ ...ok, title: 'a<b' })).toEqual(['title']);
    expect(errors({ ...ok, description: 'x > y' })).toEqual(['description']);
    expect(errors({ ...ok, tags: ['<a>'] })).toEqual(['tags']);
  });

  it('no tags is only a warning; an empty description means the post is not written yet', () => {
    const r = validatePublish({ ...ok, tags: [] });
    expect(r.valid).toBe(true);
    expect(r.problems.map((p) => [p.level, p.field])).toEqual([['warning', 'tags']]);
    expect(errors({ ...ok, description: '  \n' })).toEqual(['description']);
  });

  it('video: relative video file required; missing render is a warning only', () => {
    expect(errors({ ...ok, video: '/abs/final.mp4' })).toEqual(['video']);
    expect(errors({ ...ok, video: '../final.mp4' })).toEqual(['video']);
    expect(errors({ ...ok, video: 'renders/youtube/final.txt' })).toEqual(['video']);
    expect(errors({ ...ok, video: undefined })).toEqual(['video']);
    const r = validatePublish(ok, { exists: () => false });
    expect(r.valid).toBe(true);
    expect(r.problems).toEqual([expect.objectContaining({ level: 'warning', field: 'video' })]);
  });

  it('thumbnail: needs an existing PNG/JPEG inside the project; its problems never block the post text', () => {
    const exists = (rel: string) => rel === 'thumbnails/a.png' || rel === 'renders/youtube/final.mp4';
    expect(validatePublish({ ...ok, thumbnail: 'thumbnails/a.png' }, { exists })).toMatchObject({ valid: true, thumbnail: true });
    expect(validatePublish({ ...ok, thumbnail: 'thumbnails/missing.png' }, { exists })).toMatchObject({ valid: true, thumbnail: false });
    expect(validatePublish({ ...ok, thumbnail: 'thumbnails/a.gif' }, { exists: () => true })).toMatchObject({ valid: true, thumbnail: false });
    expect(validatePublish({ ...ok, thumbnail: '../a.png' }, { exists: () => true })).toMatchObject({ valid: true, thumbnail: false });
    expect(validatePublish({ ...ok, thumbnail: 'A.JPEG' }, { exists: () => true }).thumbnail).toBe(true);
    // without a file check the thumbnail is never "ready"
    expect(validatePublish({ ...ok, thumbnail: 'thumbnails/a.png' }).thumbnail).toBe(false);
    expect(validatePublish({ ...ok, thumbnail: '' }, { exists }).problems).toEqual([]);
  });

  it('youtube / tiktok options: enums, booleans, future publishAt, numeric category, caption length', () => {
    const now = new Date('2026-10-11T00:00:00Z');
    expect(errors({ ...ok, youtube: { privacy: 'friends' } })).toEqual(['youtube.privacy']);
    expect(errors({ ...ok, youtube: { categoryId: 28 } })).toEqual(['youtube.categoryId']);
    expect(errors({ ...ok, youtube: { categoryId: '1234' } })).toEqual(['youtube.categoryId']);
    expect(errors({ ...ok, youtube: { madeForKids: 'no' } })).toEqual(['youtube.madeForKids']);
    expect(errors({ ...ok, youtube: { publishAt: '2026-10-12T00:00:00Z' } }, { now })).toEqual([]);
    expect(errors({ ...ok, youtube: { publishAt: '2026-10-11T00:00:00Z' } }, { now })).toEqual(['youtube.publishAt']); // not in the future
    expect(errors({ ...ok, youtube: { publishAt: 'soon' } }, { now })).toEqual(['youtube.publishAt']);
    expect(errors({ ...ok, youtube: { publishAt: '' } }, { now })).toEqual([]);
    expect(errors({ ...ok, youtube: 'public' })).toEqual(['youtube']);
    expect(errors({ ...ok, tiktok: { privacy: 'PUBLIC' } })).toEqual(['tiktok.privacy']);
    expect(errors({ ...ok, tiktok: { enabled: 1 } })).toEqual(['tiktok.enabled']);
    expect(errors({ ...ok, tiktok: { caption: 'x'.repeat(2200) } })).toEqual([]);
    expect(errors({ ...ok, tiktok: { caption: 'x'.repeat(2201) } })).toEqual(['tiktok.caption']);
    expect(errors({ ...ok, tiktok: [] })).toEqual(['tiktok']);
  });

  it('messages follow the language', () => {
    expect(validatePublish({ ...ok, title: '' }, { lang: 'en' }).problems[0]!.message).toBe('title is empty');
    expect(validatePublish({ ...ok, title: '' }).problems[0]!.message).toBe('タイトルがありません');
  });
});

describe('composeDescription', () => {
  const ch = '00:00 はじめに\n00:20 本題\n00:40 まとめ';
  it('text, then chapters, then credits; nothing added twice', () => {
    const once = composeDescription('本文', ch, ['音楽: 魔王魂']);
    expect(once).toBe(`本文\n\n${ch}\n\nクレジット:\n音楽: 魔王魂`);
    expect(composeDescription(once, ch, ['音楽: 魔王魂'])).toBe(once);
  });
  it('no chapters / no credits / empty text / English label', () => {
    expect(composeDescription('本文', null, [])).toBe('本文');
    expect(composeDescription('', ch, [])).toBe(ch);
    expect(composeDescription('  ', null, [])).toBe('');
    expect(composeDescription('x', null, ['a'], 'en')).toBe('x\n\nCredits:\na');
  });
  it('a new credit adds the block again only when some credit is missing', () => {
    const a = composeDescription('x', null, ['A']);
    expect(composeDescription(a, null, ['A', 'B'])).toContain('B');
  });
});

describe('mergePublish / defaultPublish / patchFromFile', () => {
  it('top-level keys replace, youtube / tiktok merge; undefined is ignored; unknown keys survive', () => {
    const base = { ...defaultPublish('t'), notes: 'keep' };
    const m = mergePublish(base, { title: 'n', youtube: { privacy: 'public' }, tiktok: { enabled: true }, description: undefined });
    expect(m).toMatchObject({ title: 'n', description: '', notes: 'keep', youtube: { privacy: 'public', categoryId: '28', chapters: true }, tiktok: { enabled: true, privacy: 'SELF_ONLY' } });
    expect(mergePublish(base, { tags: ['x'] }).tags).toEqual(['x']);
  });
  it('defaults: private, not for kids, TikTok off, the final render', () => {
    expect(defaultPublish('t')).toMatchObject({ video: 'renders/youtube/final.mp4', youtube: { privacy: 'private', madeForKids: false }, tiktok: { enabled: false } });
  });
  it('patchFromFile: publish.json shape as is; older per-target shape → the youtube entry; chapters move under youtube', () => {
    expect(patchFromFile({ title: 'a', tags: ['x'] })).toEqual({ title: 'a', tags: ['x'] });
    expect(patchFromFile({ youtube: { title: 'Y', description: 'd', tags: ['t'], titleCandidates: ['c'], chapters: false }, tiktok: { title: 'T' } }))
      .toEqual({ title: 'Y', description: 'd', tags: ['t'], youtube: { chapters: false } });
    expect(patchFromFile({ title: 'a', chapters: true, titleCandidates: ['x'] })).toEqual({ title: 'a', youtube: { chapters: true } });
    // a real publish.json with a youtube block of options stays as is
    expect(patchFromFile({ title: 'a', youtube: { privacy: 'public' } })).toEqual({ title: 'a', youtube: { privacy: 'public' } });
  });
});

describe('files: readPublish / publishStatus / projectFileExists', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ferret-video-pub-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('missing, broken, BOM, valid with an existing thumbnail', () => {
    expect(readPublish(dir)).toBeNull();
    expect(publishStatus(dir)).toMatchObject({ valid: false, thumbnail: false, problems: ['publish.json がありません'] });
    expect(publishStatus(dir, 'en').problems).toEqual(['publish.json does not exist']);
    writeFileSync(join(dir, 'publish.json'), '{');
    expect(readPublish(dir)!.error).toBeTruthy();
    expect(publishStatus(dir).valid).toBe(false);
    writeFileSync(join(dir, 'publish.json'), '\uFEFF' + JSON.stringify({ ...ok, thumbnail: 'thumbnails/a.png' }));
    expect(publishStatus(dir)).toEqual({ valid: true, thumbnail: false, problems: [] });
    mkdirSync(join(dir, 'thumbnails'));
    writeFileSync(join(dir, 'thumbnails', 'a.png'), '');
    expect(publishStatus(dir).thumbnail).toBe(false); // an empty file is not an image
    writeFileSync(join(dir, 'thumbnails', 'a.png'), 'png');
    expect(publishStatus(dir).thumbnail).toBe(true);
    expect(projectFileExists(dir, 'thumbnails')).toBe(false); // a folder
  });
});

describe('ruleJudge (no decision model)', () => {
  it('cuts every candidate; retakes are marked needsReview for the agent, fillers and silence are not', () => {
    const c = (kind: 'filler' | 'retake' | 'silence') => ({ start: 0, end: 1, kind, reason: kind, by: 'rule' as const });
    const r = ruleJudge([c('filler'), c('retake'), c('silence')]);
    expect(r.review).toEqual([]);
    expect(r.cut.map((x) => [x.kind, !!x.needsReview])).toEqual([['filler', false], ['retake', true], ['silence', false]]);
    expect(ruleJudge([])).toEqual({ cut: [], review: [] });
  });
});
