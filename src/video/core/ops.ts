import type {
  Bgm, Caption, Chapter, Decided, Marker, Mask, Meta, Output, Overlay, RemovedKind, ReviewState, Scene, Segment, Sfx,
  Source, SourceFrame, Target, Timeline, TranscriptRef, VideoChoice, Voice,
} from './schema.js';
import { allIds, freshId, repackSegments, segmentLength } from './timeline.js';

/**
 * Edit operations. Contract ops plus a few extensions used for exact inverses:
 * `removeSource`, `setSegments`, `setMarkers`, `removeOutput`, `setVoice`, optional `index` on add ops and
 * optional `kind` on `cutText` (what the cut is recorded as in `removedNeighbors`, default 'off-topic').
 */
export type Op =
  | { op: 'addSource'; id: string; source: Source }
  | { op: 'removeSource'; id: string }
  | { op: 'updateSource'; id: string; patch: Record<string, unknown> }
  | { op: 'setTranscript'; transcript?: TranscriptRef | null }
  | { op: 'setDecided'; target: string; decided: Decided }
  | { op: 'addSegment'; segment: Segment; index?: number }
  | { op: 'removeSegment'; id: string; decided: Decided }
  | { op: 'trimSegment'; id: string; from?: SourceFrame; to?: SourceFrame; decided: Decided }
  | { op: 'splitSegment'; id: string; atSource: SourceFrame; newId: string }
  | { op: 'moveSegment'; id: string; index: number }
  | { op: 'setSegments'; segments: Segment[] }
  | { op: 'setVideo'; id: string; video: VideoChoice; decided: Decided }
  | { op: 'setCamera'; id: string; camera: string; decided: Decided }
  | { op: 'cutText'; from: SourceFrame; to: SourceFrame; take: string; decided: Decided; kind?: RemovedKind }
  | { op: 'setCaptions'; captions: Caption[] }
  | { op: 'updateCaption'; id: string; patch: Partial<Caption> }
  | { op: 'addOverlay'; overlay: Overlay; index?: number }
  | { op: 'removeOverlay'; id: string }
  | { op: 'addScene'; scene: Scene; index?: number }
  | { op: 'removeScene'; id: string }
  | { op: 'addSfx'; sfx: Sfx; index?: number }
  | { op: 'removeSfx'; id: string }
  | { op: 'setBgm'; bgm: Bgm[] }
  | { op: 'setVoice'; patch: Partial<Voice> }
  | { op: 'addMask'; mask: Mask; index?: number }
  | { op: 'removeMask'; id: string }
  | { op: 'setMeta'; patch: Partial<Meta> }
  | { op: 'setOutline'; outline: Chapter[] }
  | { op: 'addMarker'; marker: Marker }
  | { op: 'setMarkers'; markers: Marker[] }
  | { op: 'setOutput'; output: Output }
  | { op: 'removeOutput'; target: Target }
  | { op: 'setReview'; patch: Partial<ReviewState> };

export type OpName = Op['op'];

export class OpError extends Error {
  constructor(public readonly op: OpName, message: string) {
    super(`${op}: ${message}`);
    this.name = 'OpError';
  }
}

const UNDO: Decided = { by: 'rule', reason: 'undo' };

const clone = <T>(v: T): T => structuredClone(v);

function indexOf<T extends { id: string }>(arr: readonly T[], id: string, op: OpName, what: string): number {
  const i = arr.findIndex((x) => x.id === id);
  if (i < 0) throw new OpError(op, `${what} not found: ${id}`);
  return i;
}

function insertAt<T>(arr: readonly T[], item: T, index: number | undefined): T[] {
  const out = arr.slice();
  const i = index === undefined ? out.length : Math.max(0, Math.min(out.length, Math.trunc(index)));
  out.splice(i, 0, item);
  return out;
}

function removeAt<T>(arr: readonly T[], i: number): T[] {
  const out = arr.slice();
  out.splice(i, 1);
  return out;
}

/** Apply `patch` to a copy of `obj`; keys whose value is `undefined` are deleted. Returns the inverse patch. */
function patchObject<T extends object>(obj: T, patch: Partial<T>): { next: T; inverse: Partial<T> } {
  const next = { ...obj } as Record<string, unknown>;
  const inverse: Record<string, unknown> = {};
  const src = obj as Record<string, unknown>;
  for (const [k, v] of Object.entries(patch)) {
    inverse[k] = k in src ? clone(src[k]) : undefined;
    if (v === undefined) delete next[k];
    else next[k] = clone(v);
  }
  return { next: next as T, inverse: inverse as Partial<T> };
}

function withSegments(t: Timeline, segments: Segment[]): Timeline {
  return reanchor({ ...t, segments: repackSegments(t, segments) });
}

/**
 * Move anchored scenes to `segment.start + offset` (keeping their length). Scenes whose segment no longer exists keep
 * their last range (validation warns).
 */
export function reanchor(t: Timeline): Timeline {
  if (!t.scenes.some((s) => s.anchor)) return t;
  const starts = new Map(t.segments.map((s) => [s.id, s.range.start]));
  let changed = false;
  const scenes = t.scenes.map((sc) => {
    const base = sc.anchor ? starts.get(sc.anchor.segment) : undefined;
    if (base === undefined) return sc;
    const start = base + sc.anchor!.offset;
    if (start === sc.range.start) return sc;
    changed = true;
    return { ...sc, range: { start, end: start + (sc.range.end - sc.range.start) } };
  });
  return changed ? { ...t, scenes } : t;
}

function checkRange(op: OpName, from: number, to: number): void {
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to <= from) {
    throw new OpError(op, `invalid source range [${from}, ${to})`);
  }
}

function shiftZoom(seg: Segment, offset: number): Segment['zoom'] {
  if (!seg.zoom || seg.zoom.length === 0) return seg.zoom ? [] : undefined;
  const sorted = [...seg.zoom].sort((a, b) => a.at - b.at);
  const after = sorted.filter((k) => k.at >= offset).map((k) => ({ ...k, at: k.at - offset }));
  const before = sorted.filter((k) => k.at < offset).at(-1);
  if (before && (after.length === 0 || after[0]!.at > 0)) after.unshift({ ...before, at: 0 });
  return after;
}

/** Replace `decided` on the element with id `target` (segments, scenes, captions, overlays with a decision, bgm, sfx, masks). */
function setDecidedOn(t: Timeline, target: string, decided: Decided): { timeline: Timeline; prev: Decided } | null {
  const swap = <T extends { id: string }>(arr: readonly T[]): { arr: T[]; prev: Decided } | null => {
    const i = arr.findIndex((x) => x.id === target && 'decided' in x);
    if (i < 0) return null;
    const out = arr.slice();
    const prev = (arr[i] as T & { decided: Decided }).decided;
    out[i] = { ...arr[i]!, decided } as T;
    return { arr: out, prev: clone(prev) };
  };
  let r;
  if ((r = swap(t.segments))) return { timeline: { ...t, segments: r.arr }, prev: r.prev };
  if ((r = swap(t.scenes))) return { timeline: { ...t, scenes: r.arr }, prev: r.prev };
  if ((r = swap(t.captions))) return { timeline: { ...t, captions: r.arr }, prev: r.prev };
  if ((r = swap(t.overlays))) return { timeline: { ...t, overlays: r.arr }, prev: r.prev };
  if ((r = swap(t.masks))) return { timeline: { ...t, masks: r.arr }, prev: r.prev };
  if ((r = swap(t.audio.bgm))) return { timeline: { ...t, audio: { ...t.audio, bgm: r.arr } }, prev: r.prev };
  if ((r = swap(t.audio.sfx))) return { timeline: { ...t, audio: { ...t.audio, sfx: r.arr } }, prev: r.prev };
  return null;
}

function applyOne(t: Timeline, op: Op): { timeline: Timeline; inverse: Op[] } {
  switch (op.op) {
    case 'addSource': {
      const prev = t.sources[op.id];
      const sources = { ...t.sources, [op.id]: clone(op.source) };
      const tl = { ...t, sources };
      return {
        // Re-pack: a new screen/camera may define a take's clock.
        timeline: withSegments(tl, tl.segments),
        inverse: [prev ? { op: 'addSource', id: op.id, source: clone(prev) } : { op: 'removeSource', id: op.id }],
      };
    }
    case 'updateSource': {
      const prev = t.sources[op.id];
      if (!prev) throw new OpError(op.op, `source not found: ${op.id}`);
      if ('kind' in op.patch && op.patch.kind !== prev.kind) throw new OpError(op.op, 'cannot change a source kind; use addSource');
      const { next, inverse } = patchObject(prev as unknown as Record<string, unknown>, op.patch);
      const tl = { ...t, sources: { ...t.sources, [op.id]: next as unknown as Source } };
      return { timeline: withSegments(tl, tl.segments), inverse: [{ op: 'updateSource', id: op.id, patch: inverse }] };
    }
    case 'setTranscript': {
      const tl = { ...t };
      if (op.transcript) tl.transcript = clone(op.transcript); // null or undefined clears
      else delete tl.transcript;
      return { timeline: tl, inverse: [{ op: 'setTranscript', transcript: t.transcript ? clone(t.transcript) : null }] };
    }
    case 'setDecided': {
      const r = setDecidedOn(t, op.target, clone(op.decided));
      if (!r) throw new OpError(op.op, `no element with a decision has id ${op.target}`);
      return { timeline: r.timeline, inverse: [{ op: 'setDecided', target: op.target, decided: r.prev }] };
    }
    case 'removeSource': {
      const prev = t.sources[op.id];
      if (!prev) throw new OpError(op.op, `source not found: ${op.id}`);
      const sources = { ...t.sources };
      delete sources[op.id];
      const tl = { ...t, sources };
      // Re-pack: removing a source may change a take's clock.
      return { timeline: withSegments(tl, tl.segments), inverse: [{ op: 'addSource', id: op.id, source: clone(prev) }] };
    }
    case 'addSegment': {
      if (t.segments.some((s) => s.id === op.segment.id)) throw new OpError(op.op, `duplicate segment id: ${op.segment.id}`);
      checkRange(op.op, op.segment.src.from, op.segment.src.to);
      const segments = insertAt(t.segments, clone(op.segment), op.index);
      return { timeline: withSegments(t, segments), inverse: [{ op: 'removeSegment', id: op.segment.id, decided: UNDO }] };
    }
    case 'removeSegment': {
      const i = indexOf(t.segments, op.id, op.op, 'segment');
      return {
        timeline: withSegments(t, removeAt(t.segments, i)),
        inverse: [{ op: 'addSegment', segment: clone(t.segments[i]!), index: i }],
      };
    }
    case 'trimSegment': {
      const i = indexOf(t.segments, op.id, op.op, 'segment');
      const seg = t.segments[i]!;
      const from = op.from ?? seg.src.from;
      const to = op.to ?? seg.src.to;
      checkRange(op.op, from, to);
      const segments = t.segments.slice();
      segments[i] = { ...seg, src: { ...seg.src, from, to }, decided: clone(op.decided) };
      return {
        timeline: withSegments(t, segments),
        inverse: [{ op: 'trimSegment', id: op.id, from: seg.src.from, to: seg.src.to, decided: clone(seg.decided) }],
      };
    }
    case 'splitSegment': {
      const i = indexOf(t.segments, op.id, op.op, 'segment');
      const seg = t.segments[i]!;
      if (!(op.atSource > seg.src.from && op.atSource < seg.src.to)) {
        throw new OpError(op.op, `split point ${op.atSource} not inside (${seg.src.from}, ${seg.src.to})`);
      }
      if (allIds(t).has(op.newId)) throw new OpError(op.op, `id already used: ${op.newId}`);
      const first: Segment = { ...seg, src: { ...seg.src, to: op.atSource } };
      const offset = segmentLength(t, first);
      const second: Segment = { ...clone(seg), id: op.newId, src: { ...seg.src, from: op.atSource } };
      delete second.transitionIn;
      delete second.removedNeighbors;
      delete second.checks;
      const zoom = shiftZoom(seg, offset);
      if (zoom) second.zoom = zoom;
      else delete second.zoom;
      const segments = t.segments.slice();
      segments.splice(i, 1, first, second);
      return { timeline: withSegments(t, segments), inverse: [{ op: 'setSegments', segments: clone(t.segments) }] };
    }
    case 'moveSegment': {
      const i = indexOf(t.segments, op.id, op.op, 'segment');
      const segments = removeAt(t.segments, i);
      const j = Math.max(0, Math.min(segments.length, Math.trunc(op.index)));
      segments.splice(j, 0, t.segments[i]!);
      return { timeline: withSegments(t, segments), inverse: [{ op: 'moveSegment', id: op.id, index: i }] };
    }
    case 'setSegments': {
      const ids = new Set<string>();
      for (const s of op.segments) {
        if (ids.has(s.id)) throw new OpError(op.op, `duplicate segment id: ${s.id}`);
        ids.add(s.id);
        checkRange(op.op, s.src.from, s.src.to);
      }
      return { timeline: withSegments(t, clone(op.segments)), inverse: [{ op: 'setSegments', segments: clone(t.segments) }] };
    }
    case 'setVideo': {
      const i = indexOf(t.segments, op.id, op.op, 'segment');
      const seg = t.segments[i]!;
      const segments = t.segments.slice();
      segments[i] = { ...seg, video: clone(op.video), decided: clone(op.decided) };
      return {
        timeline: { ...t, segments },
        inverse: [{ op: 'setVideo', id: op.id, video: clone(seg.video), decided: clone(seg.decided) }],
      };
    }
    case 'setCamera': {
      const i = indexOf(t.segments, op.id, op.op, 'segment');
      const seg = t.segments[i]!;
      const v = seg.video;
      let video: VideoChoice;
      if (v.layout === 'camera-full') video = { ...v, camera: op.camera };
      else if (v.layout === 'screen-with-wipe') video = { ...v, camera: op.camera };
      else if (v.layout === 'split-v') video = { ...v, bottom: op.camera };
      else throw new OpError(op.op, `segment ${op.id} has layout ${v.layout} without a camera; use setVideo`);
      const segments = t.segments.slice();
      segments[i] = { ...seg, video, decided: clone(op.decided) };
      return {
        timeline: { ...t, segments },
        inverse: [{ op: 'setVideo', id: op.id, video: clone(v), decided: clone(seg.decided) }],
      };
    }
    case 'cutText': {
      checkRange(op.op, op.from, op.to);
      const taken = allIds(t);
      const out: Segment[] = [];
      let touched = false;
      const removed = { kind: op.kind ?? ('off-topic' as RemovedKind), src: { from: op.from, to: op.to }, decided: clone(op.decided) };
      const note = (s: Segment): Segment => ({ ...s, removedNeighbors: [...(s.removedNeighbors ?? []), clone(removed)] });
      for (const s of t.segments) {
        const { from, to } = s.src;
        if (s.src.take !== op.take || op.to <= from || op.from >= to) {
          out.push(s);
          continue;
        }
        touched = true;
        if (op.from <= from && op.to >= to) continue; // fully removed
        if (op.from > from && op.to < to) {
          // the cut is strictly inside: split in two
          const id = freshId(`${s.id}_`, taken);
          taken.add(id);
          const left = note({ ...s, src: { ...s.src, to: op.from } });
          const right: Segment = { ...clone(s), id, src: { ...s.src, from: op.to } };
          delete right.transitionIn;
          delete right.removedNeighbors;
          delete right.checks;
          delete right.zoom;
          out.push(left, right);
        } else if (op.from <= from) {
          out.push(note({ ...s, src: { ...s.src, from: op.to } }));
        } else {
          out.push(note({ ...s, src: { ...s.src, to: op.from } }));
        }
      }
      if (!touched) return { timeline: t, inverse: [] };
      return { timeline: withSegments(t, out), inverse: [{ op: 'setSegments', segments: clone(t.segments) }] };
    }
    case 'setCaptions':
      return { timeline: { ...t, captions: clone(op.captions) }, inverse: [{ op: 'setCaptions', captions: clone(t.captions) }] };
    case 'updateCaption': {
      const i = indexOf(t.captions, op.id, op.op, 'caption');
      if ('id' in op.patch && op.patch.id !== op.id) throw new OpError(op.op, 'cannot change a caption id');
      const { next, inverse } = patchObject(t.captions[i]!, op.patch);
      const captions = t.captions.slice();
      captions[i] = next;
      return { timeline: { ...t, captions }, inverse: [{ op: 'updateCaption', id: op.id, patch: inverse }] };
    }
    case 'addOverlay': {
      if (t.overlays.some((o) => o.id === op.overlay.id)) throw new OpError(op.op, `duplicate overlay id: ${op.overlay.id}`);
      return {
        timeline: { ...t, overlays: insertAt(t.overlays, clone(op.overlay), op.index) },
        inverse: [{ op: 'removeOverlay', id: op.overlay.id }],
      };
    }
    case 'removeOverlay': {
      const i = indexOf(t.overlays, op.id, op.op, 'overlay');
      return {
        timeline: { ...t, overlays: removeAt(t.overlays, i) },
        inverse: [{ op: 'addOverlay', overlay: clone(t.overlays[i]!), index: i }],
      };
    }
    case 'addScene': {
      if (t.scenes.some((s) => s.id === op.scene.id)) throw new OpError(op.op, `duplicate scene id: ${op.scene.id}`);
      return {
        timeline: reanchor({ ...t, scenes: insertAt(t.scenes, clone(op.scene), op.index) }),
        inverse: [{ op: 'removeScene', id: op.scene.id }],
      };
    }
    case 'removeScene': {
      const i = indexOf(t.scenes, op.id, op.op, 'scene');
      return {
        timeline: { ...t, scenes: removeAt(t.scenes, i) },
        inverse: [{ op: 'addScene', scene: clone(t.scenes[i]!), index: i }],
      };
    }
    case 'addSfx': {
      if (t.audio.sfx.some((s) => s.id === op.sfx.id)) throw new OpError(op.op, `duplicate sfx id: ${op.sfx.id}`);
      return {
        timeline: { ...t, audio: { ...t.audio, sfx: insertAt(t.audio.sfx, clone(op.sfx), op.index) } },
        inverse: [{ op: 'removeSfx', id: op.sfx.id }],
      };
    }
    case 'removeSfx': {
      const i = indexOf(t.audio.sfx, op.id, op.op, 'sfx');
      return {
        timeline: { ...t, audio: { ...t.audio, sfx: removeAt(t.audio.sfx, i) } },
        inverse: [{ op: 'addSfx', sfx: clone(t.audio.sfx[i]!), index: i }],
      };
    }
    case 'setBgm':
      return {
        timeline: { ...t, audio: { ...t.audio, bgm: clone(op.bgm) } },
        inverse: [{ op: 'setBgm', bgm: clone(t.audio.bgm) }],
      };
    case 'setVoice': {
      const { next, inverse } = patchObject(t.audio.voice, op.patch);
      return { timeline: { ...t, audio: { ...t.audio, voice: next } }, inverse: [{ op: 'setVoice', patch: inverse }] };
    }
    case 'addMask': {
      if (t.masks.some((m) => m.id === op.mask.id)) throw new OpError(op.op, `duplicate mask id: ${op.mask.id}`);
      return { timeline: { ...t, masks: insertAt(t.masks, clone(op.mask), op.index) }, inverse: [{ op: 'removeMask', id: op.mask.id }] };
    }
    case 'removeMask': {
      const i = indexOf(t.masks, op.id, op.op, 'mask');
      return {
        timeline: { ...t, masks: removeAt(t.masks, i) },
        inverse: [{ op: 'addMask', mask: clone(t.masks[i]!), index: i }],
      };
    }
    case 'setMeta': {
      const { next, inverse } = patchObject(t.meta, op.patch);
      return { timeline: { ...t, meta: next }, inverse: [{ op: 'setMeta', patch: inverse }] };
    }
    case 'setOutline':
      return { timeline: { ...t, outline: clone(op.outline) }, inverse: [{ op: 'setOutline', outline: clone(t.outline) }] };
    case 'addMarker':
      return {
        timeline: { ...t, markers: [...t.markers, clone(op.marker)] },
        inverse: [{ op: 'setMarkers', markers: clone(t.markers) }],
      };
    case 'setMarkers':
      return { timeline: { ...t, markers: clone(op.markers) }, inverse: [{ op: 'setMarkers', markers: clone(t.markers) }] };
    case 'setOutput': {
      const i = t.outputs.findIndex((o) => o.target === op.output.target);
      const outputs = t.outputs.slice();
      if (i >= 0) outputs[i] = clone(op.output);
      else outputs.push(clone(op.output));
      return {
        timeline: { ...t, outputs },
        inverse: [i >= 0 ? { op: 'setOutput', output: clone(t.outputs[i]!) } : { op: 'removeOutput', target: op.output.target }],
      };
    }
    case 'removeOutput': {
      const i = t.outputs.findIndex((o) => o.target === op.target);
      if (i < 0) throw new OpError(op.op, `output not found: ${op.target}`);
      return { timeline: { ...t, outputs: removeAt(t.outputs, i) }, inverse: [{ op: 'setOutput', output: clone(t.outputs[i]!) }] };
    }
    case 'setReview': {
      const { next, inverse } = patchObject(t.review, op.patch);
      return { timeline: { ...t, review: next }, inverse: [{ op: 'setReview', patch: inverse }] };
    }
    default: {
      const never: never = op;
      throw new OpError((never as { op: OpName }).op, 'unknown op');
    }
  }
}

/** Apply one op immutably. `inverse` ops, applied in order, restore the input timeline. Throws OpError. */
export function applyOp(t: Timeline, op: Op): { timeline: Timeline; inverse: Op[] } {
  if (!op || typeof op !== 'object' || typeof (op as { op?: unknown }).op !== 'string') {
    throw new OpError('setMeta' as OpName, 'not an op object');
  }
  return applyOne(t, op);
}

/** Apply ops in order (all or nothing: throws on the first failing op, input untouched). */
export function applyOps(t: Timeline, ops: Op[]): { timeline: Timeline; inverse: Op[] } {
  let cur = t;
  const inverses: Op[][] = [];
  for (const op of ops) {
    const r = applyOp(cur, op);
    cur = r.timeline;
    inverses.push(r.inverse);
  }
  return { timeline: cur, inverse: inverses.reverse().flat() };
}

export const OP_NAMES: readonly OpName[] = [
  'addSource', 'removeSource', 'updateSource', 'setTranscript', 'setDecided', 'addSegment', 'removeSegment', 'trimSegment', 'splitSegment', 'moveSegment', 'setSegments',
  'setVideo', 'setCamera', 'cutText', 'setCaptions', 'updateCaption', 'addOverlay', 'removeOverlay', 'addScene',
  'removeScene', 'addSfx', 'removeSfx', 'setBgm', 'setVoice', 'addMask', 'removeMask', 'setMeta', 'setOutline',
  'addMarker', 'setMarkers', 'setOutput', 'removeOutput', 'setReview',
];
