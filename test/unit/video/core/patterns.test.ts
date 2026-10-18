import { describe, expect, it } from 'vitest';
import type { PatternDef, Scene, Timeline } from '@video/core';
import {
  applyOp, applyOps, compile, emptyTimeline, fitText, jaPhrases, PATTERN_RENDERERS, PATTERNS, renderScene, renderScenes, resolvePattern,
  textWidthEm, validateSceneSlots, validateTimeline, wrapText,
} from '@video/core';
import { D } from './fixtures.js';
import { SAMPLE_SLOTS } from './pattern-samples.js';

function tl(width: number, height: number): Timeline {
  const e = emptyTimeline({ title: 'p', kind: 'talk', template: { id: 't', version: '1' }, canvas: { width, height, fps: { num: 30, den: 1 } }, language: 'ja', targets: [] });
  return applyOps({
    ...e,
    sources: {
      scr: { kind: 'screen', path: 'scr.mp4', take: 'take_1', display: 'm', fps: { num: 30, den: 1 }, size: { width: 1280, height: 720 }, offset: 0 },
      cam_side: { kind: 'camera', path: 'side.mp4', take: 'take_1', role: 'side', fps: { num: 30, den: 1 }, size: { width: 640, height: 480 }, offset: 0 },
      cam: { kind: 'camera', path: 'cam.mp4', take: 'take_1', role: 'front', fps: { num: 30, den: 1 }, size: { width: 640, height: 480 }, offset: 15 },
      mic: { kind: 'mic', path: 'mic.wav', take: 'take_1', sampleRate: 48000, offset: 0 },
      ill: { kind: 'asset', path: 'ill.png', assetId: 'ill', license: { id: 'CC0-1.0' } },
    },
    outline: [{ id: 'ch_1', title: 'c', start: 0, end: 300, points: [], importance: 'core' }],
  }, [{ op: 'addSegment', segment: { id: 'seg_1', range: { start: 0, end: 0 }, src: { from: 30, to: 330, take: 'take_1' }, text: '', chapter: 'ch_1', role: 'explain', video: { layout: 'screen-full', screen: 'scr' }, decided: D } }]).timeline;
}

const scene = (pattern: string, slots: Scene['slots'], range = { start: 30, end: 120 }): Scene =>
  ({ id: 'scn_1', pattern: { id: pattern, version: '1' }, range, slots, decided: D });

const dialogues = (lines: string[]) => lines.map((l) => {
  const m = /^Dialogue: (\d+),([\d:.]+),([\d:.]+),/.exec(l)!;
  const sec = (s: string) => { const [h, mi, se] = s.split(':').map(Number); return h! * 3600 + mi! * 60 + se!; };
  return { layer: Number(m[1]), start: sec(m[2]!), end: sec(m[3]!), text: l };
});

describe('pattern registry', () => {
  it('every built-in pattern from docs/15 has a definition and a renderer', () => {
    const expected = ['explain-illust-bubbles', 'title-card', 'bullet-points', 'compare-2col', 'ranking', 'big-number', 'quote', 'code-focus', 'terminal-typing', 'screen-zoom-callout', 'cta-subscribe'];
    expect(Object.keys(PATTERNS).sort()).toEqual([...expected].sort());
    expect([...PATTERN_RENDERERS].sort()).toEqual([...expected].sort());
    for (const p of Object.values(PATTERNS)) {
      expect(p.version).toBe('1');
      expect(Object.keys(p.slots).length).toBeGreaterThan(0);
      expect(p.aspect.length).toBeGreaterThan(0);
    }
    expect(Object.keys(SAMPLE_SLOTS).sort()).toEqual([...expected].sort());
  });
  it('explain-illust-bubbles matches docs/15 pattern.json', () => {
    const p = PATTERNS['explain-illust-bubbles']!;
    expect(p.slots).toEqual({
      illustration: { kind: 'image', required: true, hint: '人物の線画。黒背景で見えるもの' },
      bubbleLeft: { kind: 'text', maxChars: 30, hint: '発言の要点（15字以内が目安）' },
      bubbleRight: { kind: 'text', maxChars: 30 },
      wipe: { kind: 'video', default: 'camera:front' },
    });
    expect(p.style).toEqual({ background: 'waves-dark', frame: 'gradient-orange-red', bubble: 'white-rounded', wipe: 'circle-gradient' });
    expect(p.animation).toEqual({ in: ['bubbles-pop', 'frame-draw'], out: ['fade'] });
  });
  it('custom patterns extend built-ins (theme and slots merge); bad chains resolve to null', () => {
    const mine: PatternDef = { ...PATTERNS['title-card']!, id: 'my-title', extends: 'title-card', theme: { accentFrom: '#00FF00' }, slots: { title: { kind: 'text', required: true, maxChars: 10 } } };
    const deeper: PatternDef = { ...mine, id: 'my-title-2', extends: 'my-title', theme: { accentTo: '#0000FF' } };
    const custom = { 'my-title': mine, 'my-title-2': deeper };
    const r = resolvePattern('my-title-2', custom)!;
    expect(r.renderer).toBe('title-card');
    expect(r.theme.accentFrom).toBe('#00FF00');
    expect(r.theme.accentTo).toBe('#0000FF');
    expect(r.def.slots.title!.maxChars).toBe(10);
    expect(r.def.slots.subtitle).toBeDefined();
    expect(resolvePattern('nope')).toBeNull();
    expect(resolvePattern('x', { x: { ...mine, id: 'x', extends: 'ghost' } })).toBeNull();
    expect(resolvePattern('a', { a: { ...mine, id: 'a', extends: 'b' }, b: { ...mine, id: 'b', extends: 'a' } })).toBeNull();
    expect(resolvePattern('solo', { solo: { ...mine, id: 'solo', extends: undefined } as PatternDef })).toBeNull();
    // overriding a built-in id with extends to itself works
    expect(resolvePattern('quote', { quote: { ...PATTERNS.quote!, extends: 'quote', theme: { text: '#FF0000' } } })!.theme.text).toBe('#FF0000');
    // the theme shows up in the ASS
    const ass = renderScene(scene('my-title', { title: { kind: 'text', text: 'A' } }), tl(1920, 1080), custom)!;
    expect(ass.front.join('\n')).toContain('\\1c&H00FF00&');
  });
});

describe('slot validation', () => {
  const t = tl(1920, 1080);
  const v = (pattern: string, slots: Scene['slots']) => validateSceneSlots(scene(pattern, slots), t, 'scenes[0]');
  it('samples are valid for every pattern', () => {
    for (const [id, slots] of Object.entries(SAMPLE_SLOTS)) expect(v(id, slots), id).toEqual([]);
  });
  it('missing required, wrong kind, unknown slot, empty text', () => {
    expect(v('explain-illust-bubbles', {})).toEqual([{ level: 'error', path: 'scenes[0].slots.illustration', message: 'required image slot "illustration" is missing' }]);
    expect(v('title-card', { title: { kind: 'list', items: [] } })[0]!.message).toMatch(/must be text, got list/);
    expect(v('title-card', { title: { kind: 'text', text: 'x' }, bogus: { kind: 'text', text: 'y' } })[0]!.message).toMatch(/no slot "bogus"/);
    expect(v('title-card', { title: { kind: 'text', text: '  ' } })[0]).toMatchObject({ level: 'error', message: 'slot "title" is empty' });
    expect(v('bullet-points', { items: { kind: 'list', items: [] } })[0]).toMatchObject({ level: 'error' });
    // a required slot with a default may be omitted
    expect(v('compare-2col', { left: { kind: 'list', items: ['a'] }, right: { kind: 'list', items: ['b'] } })).toEqual([]);
  });
  it('limits are warnings', () => {
    const w = v('explain-illust-bubbles', { illustration: { kind: 'image', asset: 'ill' }, bubbleLeft: { kind: 'text', text: 'あ'.repeat(31) } });
    expect(w).toEqual([{ level: 'warning', path: 'scenes[0].slots.bubbleLeft.text', message: '31 characters; the pattern allows 30' }]);
    expect(v('bullet-points', { items: { kind: 'list', items: ['1', '2', '3', '4', '5', '6'] } })[0]).toMatchObject({ level: 'warning', message: '6 items; the pattern shows at most 5' });
    expect(v('ranking', { items: { kind: 'list', items: ['x'.repeat(30)] } })[0]!.path).toBe('scenes[0].slots.items.items[0]');
    expect(v('code-focus', { code: { kind: 'code', language: 'js', code: Array(20).fill('x').join('\n') } })[0]!.level).toBe('warning');
  });
  it('code highlight lines and source refs', () => {
    expect(v('code-focus', { code: { kind: 'code', language: 'js', code: 'a\nb', highlight: [3] } })[0]).toMatchObject({ level: 'error', message: 'line 3 does not exist (1..2)' });
    expect(v('explain-illust-bubbles', { illustration: { kind: 'image', asset: 'nope' } })[0]!.message).toMatch(/unknown source/);
    expect(v('explain-illust-bubbles', { illustration: { kind: 'image', asset: 'cam' } })[0]!.message).toMatch(/expected asset/);
    expect(v('explain-illust-bubbles', { illustration: { kind: 'image', asset: 'ill' }, wipe: { kind: 'video', source: 'mic', from: 0 } })[0]!.message).toMatch(/has no video/);
  });
  it('unknown patterns and version mismatches warn', () => {
    expect(v('mystery', {})[0]).toMatchObject({ level: 'warning', message: 'unknown pattern "mystery"; it cannot be rendered' });
    const s = { ...scene('quote', SAMPLE_SLOTS.quote!), pattern: { id: 'quote', version: '2' } };
    expect(validateSceneSlots(s, t, 'x')[0]!.message).toMatch(/version 1, scene uses 2/);
  });
  it('validateTimeline reports slot errors (once) and accepts custom patterns', () => {
    const bad = applyOp(t, { op: 'addScene', scene: scene('explain-illust-bubbles', { illustration: { kind: 'image', asset: 'ghost' } }) }).timeline;
    const r = validateTimeline(bad);
    expect(r.ok).toBe(false);
    expect(r.issues.filter((i) => /ghost/.test(i.message))).toHaveLength(1);
    const custom = applyOp(t, { op: 'addScene', scene: scene('mine', { title: { kind: 'text', text: 'x' } }) }).timeline;
    expect(validateTimeline(custom).issues.some((i) => /unknown pattern "mine"/.test(i.message))).toBe(true);
    expect(validateTimeline(custom, { patterns: { mine: { ...PATTERNS['title-card']!, id: 'mine', extends: 'title-card' } } }).issues).toEqual([]);
  });
});

describe('scene rendering (ASS)', () => {
  for (const [w, h] of [[1920, 1080], [1080, 1920]] as const) {
    it(`every pattern renders events inside the scene range at ${w}x${h}`, () => {
      const t = tl(w, h);
      for (const [id, slots] of Object.entries(SAMPLE_SLOTS)) {
        const r = renderScene(scene(id, slots), t)!;
        expect(r, id).not.toBeNull();
        expect(r.front.length, id).toBeGreaterThan(0);
        for (const d of dialogues([...r.back, ...r.front])) {
          expect(d.start, id).toBeGreaterThanOrEqual(1 - 1e-9);
          expect(d.end, id).toBeCloseTo(4, 5);
        }
        for (const m of r.media) {
          expect(m.rect.x, id).toBeGreaterThanOrEqual(0);
          expect(m.rect.y, id).toBeGreaterThanOrEqual(0);
          expect(m.rect.x + m.rect.w, id).toBeLessThanOrEqual(w + 1);
          expect(m.rect.y + m.rect.h, id).toBeLessThanOrEqual(h + 1);
        }
      }
    });
  }
  it('explain-illust-bubbles: waves, gradient frame, popping bubbles, illustration and synced front-camera wipe', () => {
    const r = renderScene(scene('explain-illust-bubbles', SAMPLE_SLOTS['explain-illust-bubbles']!), tl(1920, 1080))!;
    const back = r.back.join('\n');
    expect(back).toContain('\\1c&H100B0A&'); // #0A0B10 background
    const frameSlices = r.back.filter((l) => /\\clip\(/.test(l) && /\\bord/.test(l));
    expect(frameSlices).toHaveLength(14);
    expect(frameSlices[0]).toContain('\\3c&H008AFF&'); // #FF8A00
    expect(frameSlices[13]).toContain('\\3c&H552DFF&'); // #FF2D55
    const front = r.front.join('\n');
    expect(front).toMatch(/AIに全部(\\N)?まかせたい/);
    expect(front).toContain('\\t(0,170,\\fscx108\\fscy108)');
    expect(front.match(/\\1c&HFFFFFF&\\1a&H00&\\bord0\\shad0\\fscx25/g)).toHaveLength(2); // two white bubbles
    expect(r.media).toEqual([
      expect.objectContaining({ slot: 'illustration', kind: 'image', source: 'ill', fit: 'contain', shape: 'rect' }),
      expect.objectContaining({ slot: 'wipe', kind: 'video', source: 'cam', from: 'sync', shape: 'circle', fit: 'cover' }),
    ]);
    // bubbles start after the background: left 0.25 s, right 0.55 s
    const starts = dialogues(r.front.filter((l) => l.includes('\\fscx25'))).map((d) => d.start);
    expect(Math.min(...starts)).toBeCloseTo(1 + 8 / 30, 2);
  });
  it('wipe default falls back to any camera, and is omitted without one', () => {
    const t = tl(1920, 1080);
    const noFront = { ...t, sources: { ...t.sources } };
    delete noFront.sources.cam;
    expect(renderScene(scene('explain-illust-bubbles', SAMPLE_SLOTS['explain-illust-bubbles']!), noFront)!.media[1]!.source).toBe('cam_side');
    delete noFront.sources.cam_side;
    expect(renderScene(scene('explain-illust-bubbles', SAMPLE_SLOTS['explain-illust-bubbles']!), noFront)!.media).toHaveLength(1);
    const explicit = renderScene(scene('explain-illust-bubbles', { ...SAMPLE_SLOTS['explain-illust-bubbles']!, wipe: { kind: 'video', source: 'scr', from: 90 } }), t)!;
    expect(explicit.media[1]).toMatchObject({ source: 'scr', from: 90 });
  });
  it('escapes slot text', () => {
    const r = renderScene(scene('quote', { text: { kind: 'text', text: 'a {b} \\N c' } }), tl(1920, 1080))!;
    expect(r.front.join('\n')).toContain('a \\{b\\} \\⁠N c');
  });
  it('terminal-typing reveals each command character with \\k and hides unsung text', () => {
    const r = renderScene(scene('terminal-typing', SAMPLE_SLOTS['terminal-typing']!), tl(1920, 1080))!;
    const cmd = r.front.find((l) => l.includes('\\2a&HFF&'))!;
    expect(cmd.match(/\{\\k\d+\}/g)).toHaveLength([...'ferret-video render --preview'].length);
    const out = dialogues(r.front.filter((l) => l.includes('rendered')));
    expect(out[0]!.start).toBeGreaterThan(dialogues([cmd])[0]!.start);
  });
  it('code-focus keeps indentation and boxes highlighted lines', () => {
    const r = renderScene(scene('code-focus', SAMPLE_SLOTS['code-focus']!), tl(1920, 1080))!;
    expect(r.front.join('\n')).toContain('\\h\\h"model":\\h"opus",');
    expect(r.back.filter((l) => l.includes('&H40&') || l.includes('\\1a&HBF&'))).toHaveLength(1);
  });
  it('ranking reveals from the last rank to the first', () => {
    const r = renderScene(scene('ranking', SAMPLE_SLOTS.ranking!), tl(1920, 1080))!;
    const at = (label: string) => dialogues(r.front.filter((l) => l.endsWith(`}${label}`)))[0]!.start;
    expect(at('BGM')).toBeLessThan(at('字幕'));
    expect(at('字幕')).toBeLessThan(at('自動カット'));
  });
  it('screen-zoom-callout crops the source region', () => {
    const r = renderScene(scene('screen-zoom-callout', SAMPLE_SLOTS['screen-zoom-callout']!), tl(1920, 1080))!;
    expect(r.media[0]).toMatchObject({ kind: 'video', source: 'scr', from: 0, crop: { x: 0, y: 0, w: 320, h: 180 }, shape: 'rounded' });
  });
  it('renderScenes splits back and front and lists unknown patterns', () => {
    const t = applyOps(tl(1920, 1080), [
      { op: 'addScene', scene: scene('quote', SAMPLE_SLOTS.quote!) },
      { op: 'addScene', scene: { ...scene('cta-subscribe', {}), id: 'scn_2' } },
      { op: 'addScene', scene: { ...scene('mystery', {}), id: 'scn_3' } },
    ]).timeline;
    const r = renderScenes(t);
    expect(r.unknown).toEqual(['scn_3']);
    expect(r.back).toContain('[Events]');
    expect(r.front).toContain('チャンネル登録お願いします');
    expect(r.front).toContain('PlayResX: 1920');
    expect(renderScenes({ ...t, scenes: [] })).toEqual({ back: null, front: null, media: [], unknown: [] });
  });
});

describe('compile with scenes', () => {
  it('adds back ASS → media overlays → front ASS only on overlapping chunks', () => {
    const t = applyOp(tl(1920, 1080), { op: 'addScene', scene: scene('explain-illust-bubbles', SAMPLE_SLOTS['explain-illust-bubbles']!, { start: 60, end: 150 }) }).timeline;
    const p = compile(t, { quality: 'preview', projectDir: '/p', maxChunkFrames: 30 });
    expect(p.writes.map((w) => w.path)).toEqual([
      expect.stringMatching(/scenes-back-[0-9a-f]{16}\.ass$/), expect.stringMatching(/scenes-front-[0-9a-f]{16}\.ass$/),
    ]);
    const fc = (i: number) => p.chunks[i]!.args[p.chunks[i]!.args.indexOf('-filter_complex') + 1]!;
    expect(fc(0)).not.toContain('scenes-');
    expect(fc(5)).not.toContain('scenes-');
    const g = fc(2); // frames 60..90
    expect(g.indexOf('scenes-back')).toBeLessThan(g.indexOf('overlay=x='));
    expect(g.indexOf('overlay=x=')).toBeLessThan(g.indexOf('scenes-front'));
    expect(g).toContain("lte(hypot(X-W/2,Y-H/2),min(W,H)/2)");
    const a = p.chunks[2]!.args;
    expect(a).toEqual(expect.arrayContaining(['-loop', '1', 'ill.png', 'cam.mp4']));
    // synced wipe: take frame 30 + 60 timeline frames → take 3 s; camera offset 15 frames → local 3.5 s
    expect(a[a.indexOf('cam.mp4') - 4]).toBe('3.5');
    // the scene starts mid-chunk? chunk 1 (30..60) does not overlap; chunk 4 (120..150) does
    expect(fc(4)).toContain('scenes-front');
    expect(p.warnings).toEqual([]);
  });
  it('scene starting inside a chunk enables media from its local start', () => {
    const t = applyOp(tl(1920, 1080), { op: 'addScene', scene: scene('explain-illust-bubbles', SAMPLE_SLOTS['explain-illust-bubbles']!, { start: 45, end: 75 }) }).timeline;
    const p = compile(t, { quality: 'preview', projectDir: '/p', maxChunkFrames: 30 });
    const g = p.chunks[1]!.args[p.chunks[1]!.args.indexOf('-filter_complex') + 1]!;
    expect(g).toContain("enable='between(t,0.5,1.5)'");
    expect(g).toContain('fade=t=in:st=0.5');
  });
});

describe('text fitting', () => {
  it('wrapText respects the width and keeps closing punctuation on the line', () => {
    for (const s of ['撮るのは一人でも、編集はチームでできる。', 'The quick brown fox jumps over the lazy dog', 'あ']) {
      for (const em of [3, 5, 8, 12]) {
        const lines = wrapText(s, em);
        expect(lines.join('').replace(/\s/g, '')).toBe(s.replace(/\s/g, ''));
        for (const l of lines) {
          expect(/^[、。]/.test(l)).toBe(false);
          if (!/[、。]$/.test(l) && l.includes(' ') === false && [...l].length > 1) expect(textWidthEm(l)).toBeLessThanOrEqual(em + 1e-9);
        }
      }
    }
    expect(wrapText('一行目\n二行目', 10)).toEqual(['一行目', '二行目']);
  });
  it('Japanese breaks only between BudouX phrases', () => {
    for (const text of ['撮るのは一人でも、編集はチームでできる。', 'Claude Codeの設定画面を開いて右上の歯車を押します', 'AIに全部まかせたい']) {
      const ps = jaPhrases(text);
      const bounds = new Set<number>();
      let at = 0;
      for (const p of ps) bounds.add((at += p.length));
      for (const em of [4, 6, 8, 10]) {
        const lines = wrapText(text, em);
        let pos = 0;
        for (const l of lines.slice(0, -1)) {
          pos = text.indexOf(l, pos) + l.length;
          const inside = ps.find((p, i) => { const st = ps.slice(0, i).join('').length; return st < pos && st + p.length > pos; });
          if (!bounds.has(pos) && text[pos] !== ' ') expect(inside && textWidthEm(inside) > em, `${text} @${em}: "${l}"`).toBe(true);
        }
      }
    }
    expect(wrapText('撮るのは一人でも、編集はチームでできる。', 11)).toEqual(['撮るのは一人でも、', '編集はチームでできる。']);
  });
  it('fitText shrinks to fit and balances lines', () => {
    const f = fitText('設定の3つのコツ', 500, 300, 120, 40);
    expect(f.lines.length * f.size * 1.25).toBeLessThanOrEqual(300);
    for (const l of f.lines) expect(textWidthEm(l) * f.size).toBeLessThanOrEqual(500 + 1e-6);
    if (f.lines.length === 2) expect(Math.abs(textWidthEm(f.lines[0]!) - textWidthEm(f.lines[1]!))).toBeLessThanOrEqual(2);
    expect(fitText('x'.repeat(500), 100, 20, 40, 10).size).toBe(10);
  });
});
