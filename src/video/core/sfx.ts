import { sha256Hex } from './hash.js';
import type { Op } from './ops.js';
import type { Frame, LicenseRef, Sfx, Timeline } from './schema.js';
import { fpsValue } from './time.js';
import { allIds, durationFrames, freshId } from './timeline.js';

/** Where a template sfx rule fires (docs/09). */
export type SfxEvent = 'emphasis' | 'section' | 'cut' | 'scene-in' | 'caption-in' | 'zoom-in';

export interface SfxRule {
  on: SfxEvent;
  /** Library category ('pop', 'whoosh', 'ding', …); 'none' disables the event. */
  kind: string;
  /** 0..1, decided deterministically per event (seeded hash). Default 1. */
  probability?: number;
  gainDb?: number;
}

export interface SfxRules {
  rules: SfxRule[];
  /** Cap per sliding 60 s window, counting sfx already in the timeline. */
  maxPerMin?: number;
  /** Default gain relative to the voice (dB). */
  gainDb?: number;
  /** Minimum spacing between any two sfx (ms). Default 400. */
  minSpacingMs?: number;
  /** Seed for the probability and asset choice (same seed → same result). */
  seed?: string;
}

/** An sfx in the library. `id` is a source id; when it is not in the timeline yet, `path` + `license` add it. */
export interface SfxLibraryItem { id: string; kind: string; durationMs: number; path?: string; license?: LicenseRef }

/** Speech onsets to keep clear: timeline frames. */
export interface SpeechWord { start: Frame; end: Frame }

const PRIORITY: Record<SfxEvent, number> = { section: 0, 'scene-in': 1, 'zoom-in': 2, emphasis: 3, 'caption-in': 4, cut: 5 };

function unit(seed: string, key: string): number {
  return parseInt(sha256Hex(`${seed}\0${key}`).slice(0, 8), 16) / 0x100000000;
}

/** Timeline moments for each event kind. */
export function sfxEvents(t: Timeline): { on: SfxEvent; at: Frame; key: string }[] {
  const out: { on: SfxEvent; at: Frame; key: string }[] = [];
  t.segments.slice(1).forEach((s) => out.push({ on: 'cut', at: s.range.start, key: `cut:${s.id}` }));
  for (const c of t.outline) if (c.start > 0) out.push({ on: 'section', at: c.start, key: `section:${c.id}` });
  for (const m of t.markers) if (m.kind === 'chapter' && m.at > 0 && !t.outline.some((c) => c.start === m.at)) out.push({ on: 'section', at: m.at, key: `section:m${m.at}` });
  for (const s of t.scenes) out.push({ on: 'scene-in', at: s.range.start, key: `scene:${s.id}` });
  // punch-ins: a zoom keyframe that scales up from the one before (or from 1 at the segment start), and jump-zooms
  for (const s of t.segments) {
    const keys = [...(s.zoom ?? [])].sort((a, b) => a.at - b.at);
    let prev = 1;
    for (const k of keys) {
      if (k.value.scale > prev + 0.05 && s.range.start + k.at < s.range.end) out.push({ on: 'zoom-in', at: s.range.start + k.at, key: `zoom:${s.id}:${k.at}` });
      prev = k.value.scale;
    }
    if (s.transitionIn?.kind === 'jump-zoom' && !keys.length) out.push({ on: 'zoom-in', at: s.range.start, key: `zoom:${s.id}:jump` });
  }
  for (const c of t.captions) {
    out.push({ on: 'caption-in', at: c.range.start, key: `caption:${c.id}` });
    for (const e of c.emphasis) {
      const w = c.words.find((x) => x.text.includes(e.word) || e.word.includes(x.text));
      out.push({ on: 'emphasis', at: w ? w.start : c.range.start, key: `emph:${c.id}:${e.word}` });
    }
  }
  return out.sort((a, b) => a.at - b.at || PRIORITY[a.on] - PRIORITY[b.on]);
}

/**
 * Template sfx rules → addSfx ops (plus addSource for library items not in the timeline). Deterministic: the
 * probability roll and the asset pick come from a seeded hash of the event. Higher-priority events win the
 * per-minute budget and spacing (section > scene-in > emphasis > caption-in > cut). With `words`, cut/section/scene
 * sfx are moved earlier (≤ 250 ms) so they end before a speech onset, or 6 dB quieter when they cannot move.
 */
export function sfxFromRules(t: Timeline, rules: SfxRules, library: SfxLibraryItem[], o: { words?: SpeechWord[] } = {}): Op[] {
  const F = fpsValue(t.canvas.fps);
  const total = durationFrames(t);
  const seed = rules.seed ?? 'ferret-video';
  const spacing = Math.round(((rules.minSpacingMs ?? 400) / 1000) * F);
  const perMin = rules.maxPerMin ?? Number.POSITIVE_INFINITY;
  const minute = Math.round(60 * F);
  const words = o.words ?? t.captions.flatMap((c) => c.words.map((w) => ({ start: w.start, end: w.end })));
  const onsets = [...new Set(words.map((w) => w.start))].sort((a, b) => a - b);

  type Cand = { on: SfxEvent; at: Frame; key: string; rule: SfxRule; ruleIndex: number; item: SfxLibraryItem; gainDb: number };
  const cands: Cand[] = [];
  for (const ev of sfxEvents(t)) {
    const ri = rules.rules.findIndex((r) => r.on === ev.on);
    const rule = rules.rules[ri];
    if (!rule || rule.kind === 'none') continue;
    if (unit(seed, `p:${ev.key}`) >= (rule.probability ?? 1)) continue;
    const items = library.filter((l) => l.kind === rule.kind).sort((a, b) => a.id.localeCompare(b.id));
    if (!items.length) continue;
    const item = items[Math.floor(unit(seed, `pick:${ev.key}`) * items.length)]!;
    if (!t.sources[item.id] && !item.path) continue;
    let at = ev.at;
    let gainDb = rule.gainDb ?? rules.gainDb ?? -8;
    if (ev.on !== 'emphasis' && ev.on !== 'caption-in' && onsets.length) {
      const dur = Math.max(1, Math.round((item.durationMs / 1000) * F));
      const hit = onsets.find((x) => x > at && x < at + dur);
      if (hit !== undefined) {
        const shift = at + dur - hit + Math.round(0.05 * F);
        if (shift <= Math.round(0.25 * F) && at - shift >= 0) at -= shift;
        else gainDb -= 6;
      }
    }
    if (at < 0 || at >= total) continue;
    cands.push({ on: ev.on, at, key: ev.key, rule, ruleIndex: ri, item, gainDb });
  }

  // budget: existing sfx count too; best events first
  const chosen: Frame[] = t.audio.sfx.map((s) => s.at);
  const picked: Cand[] = [];
  const ordered = [...cands].sort((a, b) => PRIORITY[a.on] - PRIORITY[b.on] || a.at - b.at);
  for (const c of ordered) {
    if (chosen.some((x) => Math.abs(x - c.at) < spacing)) continue;
    // the busiest 60 s window always starts at some sfx: check those
    const next = [...chosen, c.at];
    if (next.some((st) => next.filter((x) => x >= st && x < st + minute).length > perMin)) continue;
    chosen.push(c.at);
    picked.push(c);
  }
  picked.sort((a, b) => a.at - b.at);

  const ops: Op[] = [];
  const taken = allIds(t);
  const added = new Set<string>();
  picked.forEach((c, i) => {
    if (!t.sources[c.item.id] && !added.has(c.item.id)) {
      added.add(c.item.id);
      ops.push({ op: 'addSource', id: c.item.id, source: { kind: 'asset', path: c.item.path!, assetId: c.item.id, license: c.item.license ?? { id: 'unknown' } } });
    }
    const id = taken.has(`sfx_auto_${i + 1}`) ? freshId(`sfx_auto_${i + 1}_`, taken) : `sfx_auto_${i + 1}`;
    taken.add(id);
    const sfx: Sfx = {
      id, asset: c.item.id, at: c.at, gainDb: c.gainDb, trigger: c.on, ruleRef: `sfx.rules[${c.ruleIndex}]`,
      decided: { by: 'template', reason: `template rule: ${c.on} → ${c.rule.kind}`, ruleRef: `sfx.rules[${c.ruleIndex}]` },
    };
    ops.push({ op: 'addSfx', sfx });
  });
  return ops;
}
