import type { Timeline } from './schema.js';
import { TimelineSchema } from './schema.js';
import type { PatternDef } from './patterns/defs.js';
import { validateSceneSlots } from './patterns/render.js';
import { convertFrames } from './time.js';
import { durationFrames, segmentLength, sourceRate, takeFps, videoSources } from './timeline.js';

export interface Issue {
  level: 'error' | 'warning';
  path: string;
  message: string;
}

/** Known per-work usage limits of asset licenses (license.limitKey → max distinct assets per video). */
export const LICENSE_LIMITS: Record<string, number> = { irasutoya: 20 };

function zodPath(path: readonly PropertyKey[]): string {
  let out = '';
  for (const p of path) out += typeof p === 'number' ? `[${p}]` : out === '' ? String(p) : `.${String(p)}`;
  return out || '(root)';
}

/** Schema + semantic validation. Errors make the timeline unusable; warnings are reported but allowed. */
export function validateTimeline(input: unknown, o: { patterns?: Record<string, PatternDef> } = {}):
  | { ok: true; timeline: Timeline; issues: Issue[] }
  | { ok: false; issues: Issue[] } {
  const parsed = TimelineSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.error.issues.map((i) => ({ level: 'error' as const, path: zodPath(i.path), message: i.message })),
    };
  }
  const t = parsed.data;
  const issues = semanticIssues(t, o);
  if (issues.some((i) => i.level === 'error')) return { ok: false, issues };
  return { ok: true, timeline: t, issues };
}

export function semanticIssues(t: Timeline, o: { patterns?: Record<string, PatternDef> } = {}): Issue[] {
  const issues: Issue[] = [];
  const err = (path: string, message: string) => issues.push({ level: 'error', path, message });
  const warn = (path: string, message: string) => issues.push({ level: 'warning', path, message });
  const dur = durationFrames(t);

  // Unique ids across element kinds.
  const seen = new Map<string, string>();
  const claim = (id: string, path: string) => {
    const prev = seen.get(id);
    if (prev) err(path, `duplicate id "${id}" (also at ${prev})`);
    else seen.set(id, path);
  };
  t.outline.forEach((c, i) => claim(c.id, `outline[${i}].id`));
  t.segments.forEach((s, i) => claim(s.id, `segments[${i}].id`));
  t.scenes.forEach((s, i) => claim(s.id, `scenes[${i}].id`));
  t.captions.forEach((c, i) => claim(c.id, `captions[${i}].id`));
  t.overlays.forEach((o, i) => claim(o.id, `overlays[${i}].id`));
  t.audio.bgm.forEach((b, i) => claim(b.id, `audio.bgm[${i}].id`));
  t.audio.sfx.forEach((s, i) => claim(s.id, `audio.sfx[${i}].id`));
  t.masks.forEach((m, i) => claim(m.id, `masks[${i}].id`));

  const takes = new Set<string>();
  for (const s of Object.values(t.sources)) if ('take' in s && s.take) takes.add(s.take);
  const chapters = new Set(t.outline.map((c) => c.id));
  const scenes = new Set(t.scenes.map((s) => s.id));

  const sourceOfKind = (path: string, id: string, kinds: string[]) => {
    const s = t.sources[id];
    if (!s) err(path, `unknown source "${id}"`);
    else if (!kinds.includes(s.kind)) err(path, `source "${id}" is ${s.kind}, expected ${kinds.join(' or ')}`);
    return s;
  };

  // Segments: contiguous from 0, consistent with their source length, refs exist, within source bounds.
  let expect = 0;
  t.segments.forEach((s, i) => {
    const p = `segments[${i}]`;
    if (s.src.to <= s.src.from) err(`${p}.src`, `empty or reversed source range [${s.src.from}, ${s.src.to})`);
    if (s.range.end <= s.range.start) err(`${p}.range`, `empty or reversed range [${s.range.start}, ${s.range.end})`);
    if (s.range.start !== expect) {
      err(`${p}.range.start`, s.range.start < expect
        ? `overlaps the previous segment (starts at ${s.range.start}, previous ends at ${expect})`
        : `gap before segment (starts at ${s.range.start}, previous ends at ${expect})`);
    }
    expect = s.range.end;
    const len = segmentLength(t, s);
    if (len > 0 && s.range.end - s.range.start !== len) {
      err(`${p}.range`, `length ${s.range.end - s.range.start} does not match source length (${len} timeline frames)`);
    }
    if (!takes.has(s.src.take)) warn(`${p}.src.take`, `no source belongs to take "${s.src.take}"`);
    if (chapters.size > 0 && !chapters.has(s.chapter)) err(`${p}.chapter`, `unknown chapter "${s.chapter}"`);
    const v = s.video;
    switch (v.layout) {
      case 'camera-full': sourceOfKind(`${p}.video.camera`, v.camera, ['camera']); break;
      case 'screen-full': sourceOfKind(`${p}.video.screen`, v.screen, ['screen']); break;
      case 'screen-with-wipe':
        sourceOfKind(`${p}.video.screen`, v.screen, ['screen']);
        sourceOfKind(`${p}.video.camera`, v.camera, ['camera']);
        break;
      case 'split-v':
        sourceOfKind(`${p}.video.top`, v.top, ['screen', 'camera']);
        sourceOfKind(`${p}.video.bottom`, v.bottom, ['screen', 'camera']);
        break;
      case 'scene':
        if (!scenes.has(v.scene)) err(`${p}.video.scene`, `unknown scene "${v.scene}"`);
        break;
    }
    // Bounds: the used source frames must exist in each video source of known length.
    for (const id of videoSources(v)) {
      const src = t.sources[id];
      if (!src || (src.kind !== 'screen' && src.kind !== 'camera')) continue;
      const tf = takeFps(t, s.src.take);
      const drift = src.kind === 'camera' && src.drift ? src.drift : 1;
      const localFrom = convertFrames(s.src.from, tf, src.fps) * drift + src.offset;
      const localTo = convertFrames(s.src.to, tf, src.fps) * drift + src.offset;
      if (localFrom < 0) {
        warn(`${p}.src`, `starts ${Math.round(-localFrom)} frames before "${id}" begins (rendered as black)`);
      }
      if (src.durationFrames !== undefined && localTo > src.durationFrames) {
        err(`${p}.src`, `uses frames [${Math.round(localFrom)}, ${Math.round(localTo)}) of "${id}" which has ${src.durationFrames}`);
      }
    }
    if (s.zoom) {
      const len2 = s.range.end - s.range.start;
      s.zoom.forEach((k, j) => {
        if (k.at >= len2) warn(`${p}.zoom[${j}].at`, `keyframe at ${k.at} is past the segment length ${len2}`);
      });
    }
    s.removedNeighbors?.forEach((r, j) => {
      if (r.src.to <= r.src.from) err(`${p}.removedNeighbors[${j}].src`, 'empty or reversed range');
    });
  });

  const inTimeline = (path: string, r: { start: number; end: number }, what: string) => {
    if (r.end <= r.start) err(path, `${what} has an empty or reversed range [${r.start}, ${r.end})`);
    else if (r.end > dur) err(path, `${what} ends at ${r.end}, after the timeline end ${dur}`);
  };
  const assetRef = (path: string, id: string, kinds: string[] = ['asset']) => sourceOfKind(path, id, kinds);

  // Outline.
  const sortedCh = [...t.outline].sort((a, b) => a.start - b.start);
  t.outline.forEach((c, i) => {
    if (c.end <= c.start) err(`outline[${i}]`, `chapter "${c.id}" has an empty or reversed range`);
    else if (dur > 0 && c.end > dur) warn(`outline[${i}].end`, `chapter "${c.id}" ends after the timeline end ${dur}`);
  });
  for (let i = 1; i < sortedCh.length; i++) {
    if (sortedCh[i]!.start < sortedCh[i - 1]!.end) {
      warn('outline', `chapters "${sortedCh[i - 1]!.id}" and "${sortedCh[i]!.id}" overlap`);
    }
  }

  // Scenes.
  t.scenes.forEach((s, i) => {
    inTimeline(`scenes[${i}].range`, s.range, `scene "${s.id}"`);
    if (s.anchor) {
      const seg = t.segments.find((x) => x.id === s.anchor!.segment);
      if (!seg) warn(`scenes[${i}].anchor.segment`, `anchor segment "${s.anchor.segment}" does not exist; the scene keeps its last range`);
      else if (s.range.start !== seg.range.start + s.anchor.offset) {
        warn(`scenes[${i}].range.start`, `range does not follow its anchor (expected start ${seg.range.start + s.anchor.offset})`);
      }
    }
    issues.push(...validateSceneSlots(s, t, `scenes[${i}]`, o.patterns).filter((x) => !/unknown source/.test(x.message)));
    for (const [k, v] of Object.entries(s.slots)) {
      if (v.kind === 'image') assetRef(`scenes[${i}].slots.${k}.asset`, v.asset);
      if (v.kind === 'video') assetRef(`scenes[${i}].slots.${k}.source`, v.source, ['screen', 'camera', 'asset']);
    }
  });

  // Captions.
  const caps = t.captions.map((c, i) => ({ c, i })).sort((a, b) => a.c.range.start - b.c.range.start);
  t.captions.forEach((c, i) => {
    const p = `captions[${i}]`;
    inTimeline(`${p}.range`, c.range, `caption "${c.id}"`);
    c.words.forEach((w, j) => {
      if (w.end < w.start) err(`${p}.words[${j}]`, 'word ends before it starts');
      else if (w.start < c.range.start || w.end > c.range.end) warn(`${p}.words[${j}]`, `word "${w.text}" is outside the caption range`);
    });
    if (c.lines.length === 0 && c.text.trim() !== '') warn(`${p}.lines`, 'caption has text but no lines');
  });
  for (let k = 1; k < caps.length; k++) {
    const a = caps[k - 1]!;
    const b = caps[k]!;
    if (b.c.range.start < a.c.range.end) warn(`captions[${b.i}].range`, `overlaps caption "${a.c.id}"`);
  }

  // Overlays.
  t.overlays.forEach((o, i) => {
    const p = `overlays[${i}]`;
    if (o.kind === 'click-ring') {
      if (o.at >= Math.max(dur, 1)) err(`${p}.at`, `click ring at ${o.at} is after the timeline end ${dur}`);
      return;
    }
    inTimeline(`${p}.range`, o.range, `overlay "${o.id}"`);
    if (o.kind === 'image' || o.kind === 'logo') assetRef(`${p}.asset`, o.asset);
  });

  // Audio.
  t.audio.bgm.forEach((b, i) => {
    inTimeline(`audio.bgm[${i}].range`, b.range, `bgm "${b.id}"`);
    assetRef(`audio.bgm[${i}].asset`, b.asset);
    if (b.fadeIn + b.fadeOut > b.range.end - b.range.start) warn(`audio.bgm[${i}]`, 'fades are longer than the bgm range');
  });
  t.audio.sfx.forEach((s, i) => {
    if (s.at >= Math.max(dur, 1)) err(`audio.sfx[${i}].at`, `sfx at ${s.at} is after the timeline end ${dur}`);
    assetRef(`audio.sfx[${i}].asset`, s.asset);
  });

  // Masks.
  t.masks.forEach((m, i) => {
    const src = sourceOfKind(`masks[${i}].source`, m.source, ['screen', 'camera']);
    for (let j = 1; j < m.track.length; j++) {
      if (m.track[j]!.frame <= m.track[j - 1]!.frame) err(`masks[${i}].track[${j}].frame`, 'track frames must be strictly increasing');
    }
    if (src && (src.kind === 'screen' || src.kind === 'camera')) {
      m.track.forEach((k, j) => {
        if (k.box.x < 0 || k.box.y < 0 || k.box.x + k.box.w > src.size.width || k.box.y + k.box.h > src.size.height) {
          warn(`masks[${i}].track[${j}].box`, `box is outside the source frame ${src.size.width}x${src.size.height}`);
        }
        if (src.durationFrames !== undefined && k.frame > src.durationFrames) {
          err(`masks[${i}].track[${j}].frame`, `frame ${k.frame} is past the source length ${src.durationFrames}`);
        }
      });
      // Masks in source coordinates follow the source; it is a bug to mask a source no segment shows.
      const used = t.segments.some((s) => videoSources(s.video).includes(m.source));
      if (!used) warn(`masks[${i}].source`, `source "${m.source}" is not shown by any segment`);
    }
  });

  // Markers.
  t.markers.forEach((m, i) => {
    if (dur > 0 && m.at > dur) err(`markers[${i}].at`, `marker at ${m.at} is after the timeline end ${dur}`);
  });

  // Outputs.
  const targets = new Set<string>();
  t.outputs.forEach((o, i) => {
    if (targets.has(o.target)) err(`outputs[${i}].target`, `duplicate output for ${o.target}`);
    targets.add(o.target);
    if (o.range) inTimeline(`outputs[${i}].range`, o.range, `output ${o.target}`);
    if (o.thumbnail && o.thumbnail.frame > dur) err(`outputs[${i}].thumbnail.frame`, 'thumbnail frame is after the timeline end');
  });

  // Licenses: per-work limits and missing credits.
  const perKey = new Map<string, Set<string>>();
  const usedAssets = new Set<string>();
  t.overlays.forEach((o) => { if (o.kind === 'image' || o.kind === 'logo') usedAssets.add(o.asset); });
  t.audio.bgm.forEach((b) => usedAssets.add(b.asset));
  t.audio.sfx.forEach((s) => usedAssets.add(s.asset));
  t.scenes.forEach((s) => Object.values(s.slots).forEach((v) => { if (v.kind === 'image') usedAssets.add(v.asset); }));
  for (const id of usedAssets) {
    const s = t.sources[id];
    if (!s || s.kind !== 'asset') continue;
    if (s.license.limitKey) {
      const set = perKey.get(s.license.limitKey) ?? new Set<string>();
      set.add(s.assetId);
      perKey.set(s.license.limitKey, set);
    }
    if (/BY/i.test(s.license.id) && !s.license.credit) warn(`sources.${id}.license.credit`, `license ${s.license.id} requires a credit line`);
  }
  for (const [key, set] of perKey) {
    const max = LICENSE_LIMITS[key];
    if (max !== undefined && set.size > max) err('sources', `license "${key}" allows ${max} assets per video; ${set.size} used`);
  }

  // Sanity on sources.
  for (const [id, s] of Object.entries(t.sources)) {
    if (s.kind === 'mic' && sourceRate(t, s).num < 8000) warn(`sources.${id}.sampleRate`, 'sample rate below 8 kHz');
  }
  return issues;
}
