import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import type { Segment, Timeline } from '@video/core';
import { applyOps, chaptersForDescription, emptyTimeline, exportClips, fcpTime, toEdl, toFcpxml, toOtio } from '@video/core';
import { D } from './fixtures.js';

const F30 = { num: 30, den: 1 };
const seg = (id: string, from: number, to: number, video: Segment['video']): Segment => ({
  id, range: { start: 0, end: 0 }, src: { from, to, take: 'take_1' }, text: '', chapter: 'ch_1', role: 'explain', video, decided: D,
});

function tl(fps = F30): Timeline {
  const e = emptyTimeline({ title: '設定 & <コツ>', kind: 'tech', template: { id: 'tech', version: '1' }, canvas: { width: 1920, height: 1080, fps }, language: 'ja', targets: ['youtube'] });
  return applyOps({
    ...e,
    sources: {
      cam: { kind: 'camera', path: 'media/takes/t1/camera 1.mp4', take: 'take_1', role: 'front', fps, size: { width: 1920, height: 1080 }, offset: 15, durationFrames: 9000 },
      scr: { kind: 'screen', path: 'media/takes/t1/screen.mp4', take: 'take_1', display: 'main', fps, size: { width: 1920, height: 1080 }, offset: 0, audio: false },
      mic: { kind: 'mic', path: 'media/takes/t1/mic-1.wav', take: 'take_1', sampleRate: 48000, offset: 0 },
    },
    outline: [
      { id: 'ch_1', title: 'はじめに', start: 0, end: 600, points: [], importance: 'core' },
      { id: 'ch_2', title: '設定', start: 600, end: 1200, points: [], importance: 'core' },
    ],
  }, [
    { op: 'setSegments', segments: [
      seg('seg_a', 0, 300, { layout: 'camera-full', camera: 'cam' }),
      seg('seg_b', 400, 700, { layout: 'screen-with-wipe', screen: 'scr', camera: 'cam', wipe: { shape: 'circle', corner: 'br', style: 'plain' } }),
      seg('seg_c', 800, 1400, { layout: 'split-v', top: 'scr', bottom: 'cam' }),
    ] },
    { op: 'addScene', scene: { id: 'scn_1', pattern: { id: 'title-card', version: '1' }, range: { start: 0, end: 30 }, slots: { title: { kind: 'text', text: 'x' } }, decided: D } },
    { op: 'addSegment', segment: { ...seg('seg_t', 1400, 1430, { layout: 'scene', scene: 'scn_1' }), chapter: 'ch_2' } },
    { op: 'addMarker', marker: { kind: 'ng', at: 100, srcAt: 100, from: 'hotkey' } },
    { op: 'addMarker', marker: { kind: 'note', at: 650, text: 'ここ確認', by: 'human' } },
  ]).timeline;
}

describe('exportClips', () => {
  it('places main picture, insets and voice on tracks with source-local times', () => {
    const c = exportClips(tl());
    expect(c.filter((x) => x.track === 'V1').map((x) => [x.segment, x.source, x.start, x.end])).toEqual([
      ['seg_a', 'cam', 0, 300], ['seg_b', 'scr', 300, 600], ['seg_c', 'scr', 600, 1200],
    ]);
    expect(c.filter((x) => x.track === 'V2').map((x) => [x.segment, x.source])).toEqual([['seg_b', 'cam'], ['seg_c', 'cam']]);
    expect(c.filter((x) => x.track === 'A1').every((x) => x.source === 'mic')).toBe(true);
    // camera offset 15 frames → +0.5 s
    expect(c.find((x) => x.segment === 'seg_a' && x.source === 'cam')!.srcStartSec).toBeCloseTo(0.5, 6);
    expect(c.find((x) => x.segment === 'seg_b' && x.source === 'scr')!.srcStartSec).toBeCloseTo(400 / 30, 6);
  });
});

describe('toOtio', () => {
  const o = toOtio(tl(), { projectDir: '/Users/me/My Video', srtPath: 'captions/main.srt' }) as Record<string, any>;
  it('has the OTIO schema structure', () => {
    expect(o.OTIO_SCHEMA).toBe('Timeline.1');
    expect(o.tracks.OTIO_SCHEMA).toBe('Stack.1');
    expect(o.tracks.children.map((t: any) => [t.OTIO_SCHEMA, t.name, t.kind])).toEqual([
      ['Track.1', 'V1', 'Video'], ['Track.1', 'V2', 'Video'], ['Track.1', 'A1', 'Audio'],
    ]);
    expect(o.metadata.ferret.captions).toBe('captions/main.srt');
    expect(JSON.parse(JSON.stringify(o))).toEqual(o); // plain JSON
  });
  it('tracks fill the whole duration with clips and gaps', () => {
    for (const track of o.tracks.children) {
      const sum = track.children.reduce((n: number, c: any) => n + c.source_range.duration.value * (30 / c.source_range.duration.rate), 0);
      expect(Math.round(sum)).toBe(1230);
    }
    const v1 = o.tracks.children[0].children;
    expect(v1.map((c: any) => c.OTIO_SCHEMA)).toEqual(['Clip.2', 'Clip.2', 'Clip.2', 'Gap.1']); // scene segment → gap
    const v2 = o.tracks.children[1].children;
    expect(v2.map((c: any) => c.OTIO_SCHEMA)).toEqual(['Gap.1', 'Clip.2', 'Clip.2', 'Gap.1']);
  });
  it('clips reference absolute file URLs with available ranges', () => {
    const clip = o.tracks.children[0].children[0];
    expect(clip.media_references.DEFAULT_MEDIA.target_url).toBe('file:///Users/me/My%20Video/media/takes/t1/camera%201.mp4');
    expect(clip.media_references.DEFAULT_MEDIA.available_range.duration.value).toBe(9000);
    expect(clip.source_range.start_time).toEqual({ OTIO_SCHEMA: 'RationalTime.1', rate: 30, value: 15 });
    expect(clip.active_media_reference_key).toBe('DEFAULT_MEDIA');
  });
  it('chapters and markers are stack markers', () => {
    expect(o.tracks.markers.map((m: any) => [m.name, m.color, m.marked_range.start_time.value])).toEqual([
      ['はじめに', 'PURPLE', 0], ['NG', 'RED', 100], ['設定', 'PURPLE', 600], ['ここ確認', 'GREEN', 650],
    ]);
  });
  it('relative paths stay relative without projectDir', () => {
    const r = toOtio(tl()) as Record<string, any>;
    expect(r.tracks.children[0].children[0].media_references.DEFAULT_MEDIA.target_url).toBe('media/takes/t1/camera 1.mp4');
  });
});

describe('toFcpxml', () => {
  const x = toFcpxml(tl(), { projectDir: '/Users/me/My Video' });
  const attrs = (tag: string) => [...x.matchAll(new RegExp(`<${tag}\\s([^>]*?)/?>`, 'g'))].map((m) => Object.fromEntries([...m[1]!.matchAll(/(\w+)="([^"]*)"/g)].map((a) => [a[1], a[2]])));
  it('is FCPXML 1.11 with the elements DaVinci Resolve requires', () => {
    expect(x.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE fcpxml>\n<fcpxml version="1.11">')).toBe(true);
    expect(attrs('format')[0]).toMatchObject({ id: 'r1', frameDuration: '1/30s', width: '1920', height: '1080' });
    const assets = attrs('asset');
    expect(assets.map((a) => a.name)).toEqual(['cam', 'mic', 'scr']);
    for (const a of assets) {
      expect(a.start).toBe('0s');
      expect(a.duration).toMatch(/^\d+(\/\d+)?s$/);
    }
    expect(assets[0]).toMatchObject({ hasVideo: '1', hasAudio: '1', format: 'r1', duration: '300s' });
    expect(assets[1]).toMatchObject({ hasVideo: '0', hasAudio: '1' });
    expect(assets[2]).toMatchObject({ hasVideo: '1', hasAudio: '0' });
    expect(attrs('media-rep')[0]!.src).toBe('file:///Users/me/My%20Video/media/takes/t1/camera%201.mp4');
    expect(attrs('sequence')[0]).toMatchObject({ format: 'r1', duration: '41s', tcStart: '0s', tcFormat: 'NDF' });
  });
  it('the spine is contiguous and connected clips sit on lanes', () => {
    const spineOffsets = [...x.matchAll(/<spine>(.*)<\/spine>/gs)][0]![1]!;
    const top = [...spineOffsets.matchAll(/<(asset-clip|gap) (?![^>]*lane=)[^>]*offset="([^"]+)"[^>]*duration="([^"]+)"/g)].map((m) => [m[1], m[2], m[3]]);
    expect(top).toEqual([['asset-clip', '0s', '10s'], ['asset-clip', '10s', '10s'], ['asset-clip', '20s', '20s'], ['gap', '40s', '1s']]);
    const lanes = attrs('asset-clip').filter((a) => a.lane);
    expect(lanes.map((a) => a.lane).sort()).toEqual(['-1', '-1', '-1', '-1', '1', '1']); // voice under all 4 segments (also the scene gap)
    // a connected clip starts with its parent (offset = parent's start)
    const b = x.match(/<asset-clip ref="r4" name="seg_b scr" offset="10s" start="(\d+\/?\d*s)"[^>]*>(.*?)<\/asset-clip>/s)!;
    expect(b[2]).toContain(`lane="1" name="seg_b cam" offset="${b[1]}"`);
  });
  it('chapters and markers are inside the clip that contains them', () => {
    expect(x).toContain('<chapter-marker start="1/2s" duration="1/30s" value="はじめに" posterOffset="0s"/>');
    expect(x).toContain('value="NG" completed="0"');
    expect(x).toMatch(/<chapter-marker start="[^"]+" duration="1\/30s" value="設定"/);
    expect(x).toContain('<project name="設定 &amp; &lt;コツ&gt;">');
  });
  it('is well-formed XML (xmllint when available)', () => {
    const r = spawnSync('xmllint', ['--noout', '-'], { input: x, encoding: 'utf8' });
    if (r.error) return; // xmllint not installed
    expect(r.status, r.stderr).toBe(0);
  });
  it('fcpTime reduces rationals', () => {
    expect(fcpTime(0, F30)).toBe('0s');
    expect(fcpTime(30, F30)).toBe('1s');
    expect(fcpTime(15, F30)).toBe('1/2s');
    expect(fcpTime(1, { num: 30000, den: 1001 })).toBe('1001/30000s');
    expect(fcpTime(30, { num: 30000, den: 1001 })).toBe('1001/1000s');
  });
});

describe('toEdl', () => {
  const e = toEdl(tl(), { srtPath: 'captions/main.srt' });
  const events = e.split('\n').filter((l) => /^\d{3} /.test(l));
  it('writes CMX3600 events with source and record timecodes', () => {
    expect(e.startsWith('TITLE: 設定 & <コツ>\nFCM: NON-DROP FRAME\n')).toBe(true);
    expect(events[0]).toBe('001  AX       V     C        00:00:00:15 00:00:10:15 00:00:00:00 00:00:10:00');
    expect(events[1]).toBe('002  AX       A     C        00:00:00:00 00:00:10:00 00:00:00:00 00:00:10:00');
    expect(events.find((l) => l.includes(' BL '))).toMatch(/^00\d  BL       V     C        00:00:00:00 00:00:01:00 00:00:40:00 00:00:41:00$/); // scene segment
    for (const l of events) expect(l).toMatch(/^\d{3}  (AX|BL)       [VAB] {4,5}C {8}(\d\d:\d\d:\d\d:\d\d ){3}\d\d:\d\d:\d\d:\d\d$/);
    expect(e).toContain('* FROM CLIP NAME: camera 1.mp4');
    expect(e).toContain('* LOC: 00:00:20:00 PURPLE 設定');
    expect(e).toContain('* CAPTIONS: captions/main.srt');
    // record timecodes are contiguous across V events
    const rec = events.filter((l) => / V {5}/.test(l)).map((l) => l.split(/\s+/).slice(-2));
    for (let i = 1; i < rec.length; i++) expect(rec[i]![0]).toBe(rec[i - 1]![1]);
  });
  it('uses B (video+audio) when the voice comes from the same file', () => {
    const t = tl();
    const noMic = { ...t, sources: Object.fromEntries(Object.entries(t.sources).filter(([k]) => k !== 'mic')) } as Timeline;
    expect(toEdl(noMic).split('\n').find((l) => l.startsWith('001'))).toMatch(/^001 {2}AX {7}B {5}C/);
  });
});

describe('chaptersForDescription', () => {
  const base = tl();
  const withOutline = (outline: Timeline['outline']) => ({ ...base, outline });
  const ch = (id: string, title: string, start: number) => ({ id, title, start, end: start + 1, points: [], importance: 'core' as const });
  it('writes "0:00 Title" lines for ≥ 3 chapters of ≥ 10 s', () => {
    const r = chaptersForDescription(withOutline([ch('ch_1', 'はじめに', 0), ch('ch_2', '設定', 450), ch('ch_3', 'まとめ', 900)]));
    expect(r).toEqual({ ok: true, text: '0:00 はじめに\n0:15 設定\n0:30 まとめ', chapters: expect.any(Array), notes: [] });
  });
  it('snaps the first chapter to 0:00 and merges short ones', () => {
    // 30 fps, 41 s timeline: A 2–11.7 s (moved to 0), B 11.7–23.3 s, "short" 1.7 s, C 25–41 s
    const r = chaptersForDescription(withOutline([ch('ch_1', 'A', 60), ch('ch_2', 'B', 350), ch('ch_3', 'short', 700), ch('ch_4', 'C', 750)]));
    expect(r.ok).toBe(true);
    expect(r.text).toBe('0:00 A\n0:11 B\n0:25 C');
    expect(r.notes[0]).toMatch(/first chapter moved/);
    expect(r.notes.some((n) => /"short" is shorter than 10 s/.test(n))).toBe(true);
  });
  it('fails clearly with fewer than 3 usable chapters; falls back to chapter markers', () => {
    expect(chaptersForDescription(withOutline([ch('ch_1', 'A', 0), ch('ch_2', 'B', 600)]))).toMatchObject({ ok: false, text: '' });
    const markers = { ...withOutline([]), markers: [{ kind: 'chapter' as const, at: 0, label: 'X' }, { kind: 'chapter' as const, at: 400, label: 'Y' }, { kind: 'chapter' as const, at: 800, label: 'Z' }] };
    expect(chaptersForDescription(markers).text).toBe('0:00 X\n0:13 Y\n0:26 Z');
  });
  it('uses h:mm:ss for videos of an hour or more', () => {
    const long = { ...base, segments: [{ ...base.segments[0]!, range: { start: 0, end: 30 * 3700 } }] } as Timeline;
    const r = chaptersForDescription({ ...long, outline: [ch('ch_1', 'A', 0), ch('ch_2', 'B', 30 * 1800), ch('ch_3', 'C', 30 * 3600)] });
    expect(r.text).toBe('0:00:00 A\n0:30:00 B\n1:00:00 C');
  });
});
