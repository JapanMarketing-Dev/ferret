import { describe, expect, it } from 'vitest';
import type { Timeline } from '@video/core';
import { applyOp, applyOps, LOUDNORM_TOKEN, assColor, assEscape, assTime, compile, emptyTimeline, ffFilterValue, overlaysToAss, PRESETS, presetBitrate, voiceSource } from '@video/core';
import { D, fixture } from './fixtures.js';

const fc = (args: string[]) => args[args.indexOf('-filter_complex') + 1]!;
const opts = { quality: 'preview' as const, projectDir: '/p' };

describe('compile: structure', () => {
  it('one chunk per segment, contiguous ranges, placeholders', () => {
    const p = compile(fixture(), opts);
    expect(p.chunks.map((c) => [c.id, ...c.range])).toEqual([['seg_a.0', 0, 90], ['seg_b.0', 90, 270], ['seg_c.0', 270, 330]]);
    expect(p.durationFrames).toBe(330);
    for (const c of p.chunks) {
      expect(c.args.at(-1)).toBe('{out}');
      expect(c.args).toContain('-frames:v');
      expect(c.args[c.args.indexOf('-frames:v') + 1]).toBe(String(c.range[1] - c.range[0]));
      expect(c.hash).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(p.audio.args.at(-1)).toBe('{out}');
    expect(p.final.args).toEqual(expect.arrayContaining(['{concat}', '{audio}', '{out}', '-c:v', 'copy']));
    expect(p.inputs.map((i) => i.id)).toEqual(['cam', 'mic', 'scr']);
  });
  it('preview scales the short side to 540 and keeps even sizes', () => {
    expect(compile(fixture(), opts).canvas).toMatchObject({ width: 960, height: 540 });
    const v = { ...fixture(), canvas: { ...fixture().canvas, width: 1080, height: 1920 } };
    expect(compile(v, opts).canvas).toMatchObject({ width: 540, height: 960 });
    const small = { ...fixture(), canvas: { ...fixture().canvas, width: 640, height: 360 } };
    expect(compile(small, opts).canvas).toMatchObject({ width: 640, height: 360 });
  });
  it('final uses preset size when the aspect matches, otherwise warns', () => {
    const v: Timeline = { ...fixture(), canvas: { ...fixture().canvas, width: 720, height: 1280 } };
    const p = compile(v, { quality: 'final', target: 'tiktok', projectDir: '/p' });
    expect(p.canvas).toMatchObject({ width: 1080, height: 1920 });
    expect(p.chunks[0]!.args).toEqual(expect.arrayContaining(['-b:v', '10000k']));
    const p2 = compile(fixture(), { quality: 'final', target: 'tiktok', projectDir: '/p' });
    expect(p2.canvas).toMatchObject({ width: 1920, height: 1080 });
    expect(p2.warnings.join()).toMatch(/aspect/);
    const yt = compile(fixture(), { quality: 'final', target: 'youtube', projectDir: '/p' });
    expect(yt.chunks[0]!.args).toEqual(expect.arrayContaining(['-b:v', '8000k', '-bf', '2', '-g', '15']));
    expect(yt.final.args).toEqual(expect.arrayContaining(['-b:a', '384k']));
  });
  it('splits long segments into chunks of maxChunkFrames', () => {
    const p = compile(fixture(), { ...opts, maxChunkFrames: 50 });
    expect(p.chunks.map((c) => c.range)).toEqual([[0, 50], [50, 90], [90, 140], [140, 190], [190, 240], [240, 270], [270, 320], [320, 330]]);
    // the second piece of seg_b seeks 50 frames (1.667 s) further into the screen source
    const second = p.chunks[3]!.args;
    const ss = Number(second[second.indexOf('-ss') + 1]);
    expect(ss).toBeCloseTo((120 + 50) / 30, 5);
  });
  it('throws on an empty timeline', () => {
    const e = emptyTimeline({ title: 'x', kind: 'tech', template: { id: 'a', version: '1' }, canvas: { width: 640, height: 360, fps: { num: 30, den: 1 } }, language: 'en', targets: [] });
    expect(() => compile(e, opts)).toThrow(/nothing to render/);
  });
  it('throws on a missing video source', () => {
    const t = applyOp(fixture(), { op: 'setVideo', id: 'seg_a', video: { layout: 'camera-full', camera: 'ghost' }, decided: D }).timeline;
    expect(() => compile(t, opts)).toThrow(/ghost/);
  });
});

describe('compile: hashing', () => {
  it('is deterministic', () => {
    expect(compile(fixture(), opts)).toEqual(compile(fixture(), opts));
  });
  it('changing one segment changes only its chunk hash when nothing time-dependent overlaps', () => {
    const a = compile(fixture(), opts);
    const t = applyOp(fixture(), { op: 'setVideo', id: 'seg_b', video: { layout: 'split-v', top: 'scr', bottom: 'cam' }, decided: D }).timeline;
    const b = compile(t, opts);
    expect(a.chunks.map((c) => c.hash === b.chunks.find((x) => x.id === c.id)!.hash)).toEqual([true, false, true]);
    // moving a segment keeps the hashes of all chunks (content is position-independent)
    const m = compile(applyOp(fixture(), { op: 'moveSegment', id: 'seg_c', index: 0 }).timeline, opts);
    expect(new Set(m.chunks.map((c) => c.hash))).toEqual(new Set(a.chunks.map((c) => c.hash)));
    // audio changes whenever the order changes
    expect(m.audio.hash).not.toBe(a.audio.hash);
  });
  it('quality and target change all hashes', () => {
    const a = compile(fixture(), opts);
    const b = compile(fixture(), { quality: 'final', target: 'youtube', projectDir: '/p' });
    for (let i = 0; i < a.chunks.length; i++) expect(a.chunks[i]!.hash).not.toBe(b.chunks[i]!.hash);
  });
});

describe('compile: video graph', () => {
  it('camera-full covers, screen-full fits', () => {
    const p = compile(fixture(), opts);
    expect(fc(p.chunks[0]!.args)).toMatch(/force_original_aspect_ratio=increase,crop=960:540/);
    expect(fc(p.chunks[1]!.args)).toMatch(/force_original_aspect_ratio=decrease.*pad=960:540/);
  });
  it('screen-with-wipe uses a geq alpha shape and corner placement', () => {
    for (const [shape, corner, xy] of [['circle', 'br', 'x=776:y=356'], ['rounded', 'tl', 'x=22:y=22']] as const) {
      const t = applyOp(fixture(), { op: 'setVideo', id: 'seg_a', video: { layout: 'screen-with-wipe', screen: 'scr', camera: 'cam', wipe: { shape, corner, style: 'x' } }, decided: D }).timeline;
      const g = fc(compile(t, opts).chunks[0]!.args);
      expect(g).toMatch(/geq=lum='lum\(X,Y\)'/);
      expect(g).toContain(shape === 'circle' ? 'hypot(X-W/2,Y-H/2)' : 'max(0,abs(X-W/2)');
      expect(g).toContain(`overlay=${xy}`);
      expect(compile(t, opts).chunks[0]!.args.filter((a) => a === '-i')).toHaveLength(2);
    }
  });
  it('split-v stacks two halves', () => {
    const t = applyOp(fixture(), { op: 'setVideo', id: 'seg_a', video: { layout: 'split-v', top: 'scr', bottom: 'cam' }, decided: D }).timeline;
    expect(fc(compile(t, opts).chunks[0]!.args)).toMatch(/crop=960:270.*crop=960:270.*vstack=inputs=2/);
  });
  it('scene layout uses a neutral base under the scene layers; unknown patterns warn', () => {
    let t = applyOp(fixture(), { op: 'addScene', scene: { id: 'scn_1', pattern: { id: 'title-card', version: '1' }, range: { start: 0, end: 90 }, slots: { title: { kind: 'text', text: '見出し' } }, decided: D } }).timeline;
    t = applyOp(t, { op: 'setVideo', id: 'seg_a', video: { layout: 'scene', scene: 'scn_1' }, decided: D }).timeline;
    const p = compile(t, opts);
    expect(p.chunks[0]!.args.includes('-i')).toBe(false);
    expect(fc(p.chunks[0]!.args)).toMatch(/^color=/);
    expect(fc(p.chunks[0]!.args)).toContain('subtitles=filename=derived/cache/generated/scenes-front-');
    expect(p.warnings).toEqual([]);
    const u = applyOp(t, { op: 'addScene', scene: { id: 'scn_2', pattern: { id: 'my-own', version: '1' }, range: { start: 0, end: 30 }, slots: {}, decided: D } }).timeline;
    expect(compile(u, opts).warnings.join()).toMatch(/scn_2: unknown pattern "my-own"/);
  });
  it('static zoom crops, animated zoom uses zoompan, jump-zoom and fade transitions', () => {
    const base = fixture();
    const withSeg = (patch: Partial<Timeline['segments'][number]>) => applyOp(base, { op: 'setSegments', segments: base.segments.map((s) => (s.id === 'seg_a' ? { ...s, ...patch } : s)) }).timeline;
    const st = fc(compile(withSeg({ zoom: [{ at: 0, value: { scale: 2, focus: { x: 1920, y: 1080 } } }] }), opts).chunks[0]!.args);
    expect(st).toContain('crop=480:270:480:270,scale=960:540');
    const an = fc(compile(withSeg({ zoom: [{ at: 0, value: { scale: 1, focus: 'face' } }, { at: 30, value: { scale: 1.5, focus: 'face' } }] }), opts).chunks[0]!.args);
    expect(an).toMatch(/zoompan=z='if\(lt\(\(in\+0\),0\),1,if\(lt\(\(in\+0\),30\),1\+\(0\.5\)/);
    const jz = fc(compile(withSeg({ transitionIn: { kind: 'jump-zoom', frames: 6 } }), opts).chunks[0]!.args);
    expect(jz).toContain('*if(lt((in+0),6),1.12,1)');
    const fd = fc(compile(withSeg({ transitionIn: { kind: 'fade', frames: 10 } }), opts).chunks[0]!.args);
    expect(fd).toContain('fade=t=in:s=0:n=10');
  });
  it('masks are applied in source coordinates before scaling, only when active in the piece', () => {
    const mask = { id: 'mask_1', kind: 'pixelate' as const, source: 'scr', reason: 'pii:email' as const, decided: D,
      track: [{ frame: 150, box: { x: 100, y: 50, w: 200, h: 40 }, confidence: 0.9 }, { frame: 180, box: { x: 160, y: 50, w: 200, h: 40 }, confidence: 0.9 }] };
    const t = applyOp(fixture(), { op: 'addMask', mask }).timeline;
    const p = compile(t, opts);
    const g = fc(p.chunks[1]!.args);
    expect(g.indexOf('crop=w=200:h=40')).toBeGreaterThan(-1);
    expect(g.indexOf('crop=w=200:h=40')).toBeLessThan(g.indexOf('fps=30/1'));
    expect(g).toContain('scale=1920:1080,setsar=1'); // normalized to the declared source size first
    expect(g).toMatch(/enable='between\(t,1,2\.033333\)'/); // 150/30 - 4 s ... 180/30 - 4 + 1/30
    expect(g).toContain('flags=neighbor');
    // seg_a uses the camera: no mask there
    expect(fc(p.chunks[0]!.args)).not.toContain('crop=w=');
    for (const kind of ['blur', 'fill'] as const) {
      const g2 = fc(compile(applyOp(fixture(), { op: 'addMask', mask: { ...mask, kind } }).timeline, opts).chunks[1]!.args);
      expect(g2).toContain(kind === 'blur' ? 'boxblur=' : 'drawbox=x=0:y=0:w=iw:h=ih:color=black:t=fill');
    }
    // mask outside the piece's time window is skipped
    const late = applyOp(fixture(), { op: 'addMask', mask: { ...mask, track: [{ frame: 5000, box: mask.track[0]!.box, confidence: 1 }] } }).timeline;
    expect(fc(compile(late, opts).chunks[1]!.args)).not.toContain('crop=w=');
  });
  it('source offsets and drift move the seek point; negative local time pads', () => {
    const t = structuredClone(fixture());
    (t.sources.cam as { offset: number }).offset = 15; // +0.5 s
    expect(compile(t, opts).chunks[0]!.args.slice(0, 2)).toEqual(['-ss', '0.5']);
    (t.sources.cam as { offset: number }).offset = -15;
    const a = compile(t, opts).chunks[0]!.args;
    expect(a.slice(0, 2)).toEqual(['-ss', '0']);
    expect(fc(a)).toContain('tpad=start_mode=add:start_duration=0.5');
    (t.sources.cam as { offset: number; drift?: number }).offset = 0;
    (t.sources.cam as { drift?: number }).drift = 1.001;
    const c = compile(t, opts).chunks[2]!.args; // seg_c from 400 → 13.333 s * 1.001
    expect(Number(c[1])).toBeCloseTo((400 / 30) * 1.001, 5);
    expect(fc(c)).toContain('setpts=(PTS-STARTPTS)/1.001');
  });
  it('image and logo overlays add looped inputs and timed overlays', () => {
    const t = applyOps(fixture(), [
      { op: 'addOverlay', overlay: { kind: 'image', id: 'ov_1', range: { start: 30, end: 60 }, asset: 'logo', position: { x: 100, y: 100, w: 400, h: 200 }, decided: D } },
      { op: 'addOverlay', overlay: { kind: 'logo', id: 'ov_2', range: { start: 0, end: 330 }, asset: 'logo', corner: 'tr' } },
    ]).timeline;
    const p = compile(t, opts);
    const a = p.chunks[0]!.args;
    expect(a).toEqual(expect.arrayContaining(['-loop', '1']));
    expect(fc(a)).toContain("overlay=x=50:y=50:enable='between(t,1,2)'");
    expect(fc(a)).toContain('main_w-overlay_w-22');
    expect(fc(p.chunks[1]!.args)).not.toContain('between(t,1,2)');
    expect(p.inputs.map((i) => i.id)).toContain('logo');
  });
});

describe('compile: captions and text overlays', () => {
  const cap = (id: string, start: number, end: number) => ({
    id, range: { start, end }, text: 'x', spoken: 'x', words: [], lines: ['x'], emphasis: [], style: 'tiktok-bold',
    position: { anchor: 'bottom' as const, y: 0.85 }, decided: D,
  });
  it('burns captions only into chunks that overlap a caption, with a time shift', () => {
    const t = applyOp(fixture(), { op: 'setCaptions', captions: [cap('cap_1', 100, 120)] }).timeline;
    const p = compile(t, { ...opts, assPath: 'captions/main.ass', fontsDir: '/Fonts Dir/a:b' });
    expect(fc(p.chunks[0]!.args)).not.toContain('subtitles=');
    const g = fc(p.chunks[1]!.args);
    expect(g).toContain('setpts=PTS+3/TB,subtitles=filename=captions/main.ass');
    expect(g).toContain('fontsdir=/Fonts Dir/a\\\\:b');
    expect(p.subtitles).toEqual({ assPath: 'captions/main.ass' });
  });
  it('writes an overlays ASS for telops and references it', () => {
    const t = applyOps(fixture(), [
      { op: 'addOverlay', overlay: { kind: 'telop', id: 'ov_1', range: { start: 280, end: 300 }, text: '3つの{コツ}', style: 'big', position: { x: 960, y: 200 }, decided: D } },
      { op: 'addOverlay', overlay: { kind: 'click-ring', id: 'ov_2', at: 10, position: { x: 50, y: 50 } } },
    ]).timeline;
    const p = compile(t, opts);
    expect(p.writes).toHaveLength(1);
    expect(p.writes[0]!.path).toMatch(/^derived\/cache\/generated\/overlays-[0-9a-f]{16}\.ass$/);
    expect(p.writes[0]!.content).toContain('3つの\\{コツ\\}');
    expect(fc(p.chunks[0]!.args)).toContain('subtitles=filename=derived/cache/generated/overlays-');
    expect(fc(p.chunks[1]!.args)).not.toContain('subtitles=');
    expect(fc(p.chunks[2]!.args)).toContain('subtitles=');
  });
});

describe('compile: audio graph', () => {
  it('uses the take mic, trims each segment and normalizes loudness', () => {
    const p = compile(fixture(), opts);
    const g = fc(p.audio.args);
    expect(p.audio.args.filter((a) => a === '-i')).toHaveLength(1);
    expect(g).toContain('asplit=3');
    expect(g).toContain('atrim=start=4:end=10');
    expect(g).toContain('concat=n=3:v=0:a=1');
    expect(g).toContain('loudnorm=I=-14:TP=-1');
    expect(g).toContain('afftdn'); // light denoise by default
    expect(g).toContain('highpass=f=80');
    expect(g).toMatch(/apad=whole_dur=11,atrim=duration=11\[aout\]$/);
  });
  it('falls back to the camera, then silence', () => {
    const t = structuredClone(fixture());
    delete (t.sources as Record<string, unknown>).mic;
    expect(voiceSource(t, t.segments[0]!)).toBe('cam');
    expect(voiceSource(t, t.segments[1]!)).toBe('cam'); // screen-full: camera of the take still preferred over screen
    (t.sources.cam as { audio?: boolean }).audio = false;
    expect(voiceSource(t, t.segments[1]!)).toBe('scr');
    (t.sources.scr as { audio?: boolean }).audio = false;
    expect(voiceSource(t, t.segments[0]!)).toBeNull();
    expect(fc(compile(t, opts).audio.args)).toContain('anullsrc=r=48000:cl=stereo');
  });
  it('bgm is looped, faded, delayed and ducked by the voice; sfx is delayed', () => {
    const t = applyOps(fixture(), [
      { op: 'setBgm', bgm: [{ id: 'bgm_1', asset: 'music', range: { start: 30, end: 330 }, gainDb: -18, duckDb: -12, fadeIn: 15, fadeOut: 30, decided: D }] },
      { op: 'addSfx', sfx: { id: 'sfx_1', asset: 'pop', at: 90, gainDb: -3, trigger: 'cut', decided: D } },
    ]).timeline;
    const p = compile(t, opts);
    const g = fc(p.audio.args);
    expect(p.audio.args).toEqual(expect.arrayContaining(['-stream_loop', '-1']));
    expect(g).toContain('volume=-18dB');
    expect(g).toContain('afade=t=in:d=0.5');
    expect(g).toContain('adelay=1000|1000');
    expect(g).toContain('sidechaincompress=threshold=0.02:ratio=6');
    expect(g).toContain('adelay=3000|3000');
    expect(g).toContain('amix=inputs=3:duration=first:normalize=0');
  });
  it('preview carries fast audio: one seeked stem per segment and a master over the stem list', () => {
    const p = compile(fixture(), opts);
    const f = p.audio.fast!;
    expect(f.stems.map((s) => s.id)).toEqual(['seg_a', 'seg_b', 'seg_c']);
    expect(f.stems.map((s) => s.durationSec)).toEqual([3, 6, 2]);
    expect(f.stems[0]!.args.slice(0, 3)).toEqual(['-t', '3', '-i']); // starts at 0: no -ss
    expect(f.stems[1]!.args.slice(0, 5)).toEqual(['-ss', '4', '-t', '6', '-i']);
    for (const s of f.stems) {
      const af = s.args[s.args.indexOf('-af') + 1]!;
      expect(af).toMatch(/highpass=f=80,afftdn=.*apad=whole_dur=.*,atrim=duration=.*afade=t=out.*,ebur128=framelog=quiet$/);
      expect(s.args.at(-1)).toBe('{out}');
      expect(s.hash).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(f.args.slice(0, 6)).toEqual(['-f', 'concat', '-safe', '0', '-i', '{voice}']);
    expect(fc(f.args)).toContain(LOUDNORM_TOKEN);
    expect(fc(f.args)).not.toContain('loudnorm=');
    expect(fc(f.args)).toMatch(/apad=whole_dur=11,atrim=duration=11\[aout\]$/);
    expect(f.target).toEqual({ I: -14, TP: -1 });
    expect(compile(fixture(), { quality: 'final', target: 'youtube', projectDir: '/p' }).audio.fast).toBeUndefined();
  });
  it('fast audio: an edit changes only that segment\'s stem hash; silence, negative offset and drift', () => {
    const a = compile(fixture(), opts).audio.fast!;
    const b = compile(applyOp(fixture(), { op: 'trimSegment', id: 'seg_b', to: 250, decided: D }).timeline, opts).audio.fast!;
    expect(a.stems.map((s, i) => s.hash === b.stems[i]!.hash)).toEqual([true, false, true]);
    expect(b.args).not.toEqual(a.args); // master length changes
    const t = structuredClone(fixture());
    delete (t.sources as Record<string, unknown>).mic;
    (t.sources.cam as { offset: number }).offset = -60; // camera started 2 s into the take (source-local = take − 2 s)
    (t.sources.cam as { drift?: number }).drift = 1.0001;
    (t.sources.scr as { audio?: boolean }).audio = false;
    const f = compile(t, opts).audio.fast!;
    const af0 = f.stems[0]!.args[f.stems[0]!.args.indexOf('-af') + 1]!;
    expect(f.stems[0]!.args.slice(0, 2)).toEqual(['-t', expect.any(String)]);
    expect(af0).toMatch(/asetrate=192019,.*adelay=/);
    (t.sources.cam as { audio?: boolean }).audio = false;
    const silent = compile(t, opts).audio.fast!;
    for (const s of silent.stems) expect(s.args.slice(0, 4)).toEqual(['-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo']);
  });
  it('bgm without ducking discards the sidechain', () => {
    const t = applyOp(fixture(), { op: 'setBgm', bgm: [{ id: 'bgm_1', asset: 'music', range: { start: 0, end: 330 }, gainDb: -20, duckDb: 0, fadeIn: 0, fadeOut: 0, decided: D }] }).timeline;
    const g = fc(compile(t, opts).audio.args);
    expect(g).toContain('anullsink');
    expect(g).not.toContain('sidechaincompress');
  });
});

describe('helpers', () => {
  it('ffFilterValue escapes for option and graph levels', () => {
    expect(ffFilterValue('a/b.ass')).toBe('a/b.ass');
    expect(ffFilterValue("C:\\x'y")).toBe("C\\\\:\\\\\\\\x\\\\\\'y");
    expect(ffFilterValue('a[b],c;d')).toBe('a\\[b\\]\\,c\\;d');
  });
  it('assTime/assColor/assEscape', () => {
    expect(assTime(0, { num: 30, den: 1 })).toBe('0:00:00.00');
    expect(assTime(30 * 3661 + 15, { num: 30, den: 1 })).toBe('1:01:01.50');
    expect(assColor('#FF8800')).toBe('&H000088FF');
    expect(assColor('#FFFFFF80')).toBe('&H7FFFFFFF');
    expect(() => assColor('red')).toThrow();
    expect(assEscape('a{b}c\\Nd\ne')).toBe('a\\{b\\}c\\\u2060Nd\\Ne');
  });
  it('overlaysToAss returns null without text overlays', () => {
    expect(overlaysToAss([], fixture().canvas, fixture().canvas.fps)).toBeNull();
    const ass = overlaysToAss([{ kind: 'keystroke', id: 'ov_1', range: { start: 0, end: 30 }, keys: ['⌘', 'K'] }], fixture().canvas, fixture().canvas.fps)!;
    expect(ass).toContain('PlayResX: 1920');
    expect(ass).toContain('⌘ + K');
  });
  it('presets follow docs/06', () => {
    expect(PRESETS.youtube.audio.bitrateKbps).toBe(384);
    expect(PRESETS.tiktok.size).toEqual({ width: 1080, height: 1920 });
    expect(PRESETS.tiktok.maxDurationSec).toBe(600);
    expect(PRESETS['youtube-shorts'].maxDurationSec).toBe(180);
    expect(PRESETS['instagram-reels'].safeArea).toEqual({ top: 220, bottom: 440, left: 80, right: 180 });
    expect(presetBitrate(PRESETS.youtube, 1080, 30)).toBe(8000);
    expect(presetBitrate(PRESETS.youtube, 1080, 60)).toBe(12000);
    expect(presetBitrate(PRESETS.youtube, 2160, 30)).toBe(40000);
    expect(presetBitrate(PRESETS.preview, 540, 30)).toBeUndefined();
    for (const p of Object.values(PRESETS)) expect(p.loudness).toMatchObject({ integrated: -14, truePeak: -1 });
  });
});
