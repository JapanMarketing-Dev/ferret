import { assDialogue, assHeader, assStyleLine, frameToTimecode, query, type Caption, type Overlay, type Rational, type Segment, type Timeline } from '@video/core';

// Video feedback (docs/04 「動画フィードバック」). The app records a session folder: pen strokes stamped with timeline
// frames, playback events and the reviewer's voice. Pure helpers here; the command does I/O.

export interface FeedbackSession {
  schema: 1;
  createdAt?: string;
  /** Voice recording in the session folder (wav), and when it started on the session clock (ms). */
  audio?: string;
  audioStartMs?: number;
  /** Playback state changes and seeks, on the session clock. */
  playback?: { atMs: number; state: 'playing' | 'paused'; frame: number }[];
  /** Pen strokes; points are normalized to the video picture (0..1, origin top-left). */
  strokes?: { id?: string; startMs: number; endMs: number; frame?: number; color?: string; width?: number; points: [number, number][] }[];
  /** Typed notes. */
  notes?: { atMs: number; text: string; frame?: number }[];
  /** Already transcribed words (seconds since audioStartMs); skips whisper. */
  words?: { w: string; start: number; end: number }[];
}

export type Stroke = NonNullable<FeedbackSession['strokes']>[number];

/** The desktop app's session format: one event list, times in ms since the mic started. */
export interface AppSession {
  schema: 1;
  id?: string;
  createdAt?: string;
  fps?: { num: number; den: number };
  video?: { path: string; durationSec?: number };
  micFile?: string;
  micStartMs?: number;
  events: { t_ms: number; kind: 'play' | 'pause' | 'seek' | 'stroke' | 'box' | 'text'; frame: number; videoTime?: number; data?: Record<string, unknown> }[];
}

const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Convert the app's event list into a FeedbackSession (boxes become closed strokes, text becomes notes). */
export function fromAppSession(a: AppSession): FeedbackSession {
  const playback: NonNullable<FeedbackSession['playback']> = [];
  const strokes: Stroke[] = [];
  const notes: NonNullable<FeedbackSession['notes']> = [];
  let state: 'playing' | 'paused' = 'paused';
  for (const e of [...a.events].sort((x, y) => x.t_ms - y.t_ms)) {
    if (!num(e.t_ms) || !num(e.frame)) throw new Error('every event needs numeric t_ms and frame');
    const d = e.data ?? {};
    if (e.kind === 'play' || e.kind === 'pause' || e.kind === 'seek') {
      if (e.kind !== 'seek') state = e.kind === 'play' ? 'playing' : 'paused';
      playback.push({ atMs: e.t_ms, state, frame: e.frame });
    } else if (e.kind === 'stroke') {
      const pts = d.points;
      if (!Array.isArray(pts)) throw new Error('stroke events need data.points');
      strokes.push({ startMs: e.t_ms, endMs: e.t_ms, frame: e.frame, points: pts as [number, number][] });
    } else if (e.kind === 'box') {
      const { x, y, w, h } = d as { x?: unknown; y?: unknown; w?: unknown; h?: unknown };
      if (!num(x) || !num(y) || !num(w) || !num(h)) throw new Error('box events need data.x, y, w, h');
      strokes.push({ startMs: e.t_ms, endMs: e.t_ms, frame: e.frame, points: [[x, y], [x + w, y], [x + w, y + h], [x, y + h], [x, y]] });
    } else if (e.kind === 'text') {
      if (typeof d.text === 'string' && d.text.trim()) notes.push({ atMs: e.t_ms, text: d.text, frame: e.frame });
    }
  }
  return {
    schema: 1, ...(a.createdAt ? { createdAt: a.createdAt } : {}), ...(a.micFile ? { audio: a.micFile } : {}), audioStartMs: 0,
    playback, strokes, notes,
  };
}

/** Timeline frame shown at session time `ms`. */
export function frameAt(s: FeedbackSession, ms: number, fps: Rational): number {
  const ev = [...(s.playback ?? [])].sort((a, b) => a.atMs - b.atMs);
  if (!ev.length) return 0;
  let cur = ev[0]!;
  for (const e of ev) if (e.atMs <= ms) cur = e;
  if (ms < cur.atMs || cur.state === 'paused') return Math.max(0, cur.frame);
  return Math.max(0, cur.frame + Math.floor(((ms - cur.atMs) / 1000) * (fps.num / fps.den)));
}

export interface Remark { startMs: number; endMs: number; text: string }

const SENTENCE_END = /[。．！？!?.]$/;

/** Group words into remarks: a pause > gapMs, or a sentence end followed by a pause > 300 ms, starts a new one. */
export function splitRemarks(words: { w: string; start: number; end: number }[], audioStartMs: number, lang: 'ja' | 'en', gapMs = 800): Remark[] {
  const out: Remark[] = [];
  let cur: { startMs: number; endMs: number; parts: string[] } | null = null;
  for (const w of [...words].sort((a, b) => a.start - b.start)) {
    const s = audioStartMs + w.start * 1000;
    const e = audioStartMs + w.end * 1000;
    const text = w.w.trim();
    if (!text) continue;
    const prev = cur?.parts.at(-1) ?? '';
    if (cur && (s - cur.endMs > gapMs || (SENTENCE_END.test(prev) && s - cur.endMs > 300))) {
      out.push({ startMs: cur.startMs, endMs: cur.endMs, text: join(cur.parts, lang) });
      cur = null;
    }
    if (!cur) cur = { startMs: s, endMs: e, parts: [] };
    cur.parts.push(text);
    cur.endMs = Math.max(cur.endMs, e);
  }
  if (cur) out.push({ startMs: cur.startMs, endMs: cur.endMs, text: join(cur.parts, lang) });
  return out;
}

const join = (parts: string[], lang: 'ja' | 'en') => (lang === 'ja' ? parts.join('') : parts.join(' ').replace(/\s+([,.!?])/g, '$1'));

export interface FeedbackItem {
  index: number;
  atMs: number;
  frame: number;
  speech: string;
  strokes: Stroke[];
  notes: string[];
  targets: { kind: string; id: string; label: string }[];
  title?: string;
  request?: string;
}

/** Remarks + strokes + notes → items (a stroke or note joins the remark it overlaps or is nearest to within 4 s). */
export function buildItems(s: FeedbackSession, remarks: Remark[], fps: Rational): Omit<FeedbackItem, 'index' | 'targets'>[] {
  const items: (Omit<FeedbackItem, 'index' | 'targets' | 'frame'> & { frame?: number; endMs: number })[] = remarks.map((r) => ({ atMs: r.startMs, endMs: r.endMs, speech: r.text, strokes: [], notes: [] }));
  const nearest = (a: number, b: number) => {
    let best = -1;
    let bestD = Infinity;
    items.forEach((it, i) => {
      const d = b < it.atMs ? it.atMs - b : a > it.endMs ? a - it.endMs : 0;
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    });
    return bestD <= 4000 ? best : -1;
  };
  for (const st of [...(s.strokes ?? [])].sort((a, b) => a.startMs - b.startMs)) {
    if (!st.points?.length) continue;
    const i = nearest(st.startMs, st.endMs);
    if (i >= 0) items[i]!.strokes.push(st);
    else items.push({ atMs: st.startMs, endMs: st.endMs, speech: '', strokes: [st], notes: [] });
  }
  for (const n of [...(s.notes ?? [])].sort((a, b) => a.atMs - b.atMs)) {
    if (!n.text.trim()) continue;
    const i = nearest(n.atMs, n.atMs);
    if (i >= 0) items[i]!.notes.push(n.text.trim());
    else items.push({ atMs: n.atMs, endMs: n.atMs, speech: '', strokes: [], notes: [n.text.trim()], ...(n.frame !== undefined ? { frame: n.frame } : {}) });
  }
  return items
    .sort((a, b) => a.atMs - b.atMs)
    .map(({ endMs: _e, ...it }) => ({ ...it, frame: it.strokes[0]?.frame ?? it.frame ?? frameAt(s, it.strokes[0]?.startMs ?? it.atMs, fps) }));
}

// ---------- what is under the pen ----------

export interface Box { x: number; y: number; w: number; h: number }

export function strokesBox(strokes: Stroke[], W: number, H: number): Box | null {
  const pts = strokes.flatMap((s) => s.points);
  if (!pts.length) return null;
  const xs = pts.map((p) => p[0] * W);
  const ys = pts.map((p) => p[1] * H);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, w: Math.max(1, Math.max(...xs) - x), h: Math.max(1, Math.max(...ys) - y) };
}

const overlaps = (a: Box, b: Box, m: number) => a.x - m < b.x + b.w && b.x - m < a.x + a.w && a.y - m < b.y + b.h && b.y - m < a.y + a.h;

/** Approximate on-screen box of a caption (centered block; font ≈ 6 % of the short side per line). */
export function captionBox(c: Caption, W: number, H: number): Box {
  const font = Math.min(W, H) * 0.06;
  const lines = Math.max(1, c.lines.length || 1);
  const chars = Math.max(1, ...((c.lines.length ? c.lines : [c.text]).map((l) => [...l].length)));
  const w = Math.min(W * 0.92, chars * font);
  const h = lines * font * 1.3;
  const anchorY = c.position.y * H;
  const y = c.position.anchor === 'bottom' ? anchorY - h : c.position.anchor === 'top' ? anchorY : anchorY - h / 2;
  return { x: (W - w) / 2, y, w, h };
}

export function overlayBox(o: Overlay, W: number, H: number): Box {
  switch (o.kind) {
    case 'image': return { ...o.position };
    case 'telop': return { x: o.position.x - W * 0.25, y: o.position.y - H * 0.06, w: W * 0.5, h: H * 0.12 };
    case 'keystroke': return { x: W * 0.3, y: H * 0.82, w: W * 0.4, h: H * 0.1 };
    case 'click-ring': return { x: o.position.x - W * 0.04, y: o.position.y - W * 0.04, w: W * 0.08, h: W * 0.08 };
    case 'logo': {
      const s = Math.min(W, H) * 0.14;
      return { x: o.corner.endsWith('l') ? 0 : W - s, y: o.corner.startsWith('t') ? 0 : H - s, w: s, h: s };
    }
  }
}

const short = (s: string, n = 24) => ([...s].length > n ? `${[...s].slice(0, n).join('')}…` : s);

/** Timeline elements at `frame` under the strokes (captions/overlays by geometry; the segment and scenes always). */
export function targetsAt(tl: Timeline, frame: number, strokes: Stroke[], lang: 'ja' | 'en'): FeedbackItem['targets'] {
  const W = tl.canvas.width;
  const H = tl.canvas.height;
  const box = strokesBox(strokes, W, H);
  const margin = Math.min(W, H) * 0.02;
  const ja = lang === 'ja';
  const out: FeedbackItem['targets'] = [];
  const paren = (x: string) => (ja ? `（${x}）` : ` (${x})`);
  const q = (x: string) => (ja ? `「${short(x)}」` : `"${short(x)}"`);
  for (const r of query(tl, { range: [frame, frame + 1] })) {
    if (!r.id) continue;
    if (r.kind === 'caption') {
      const c = r.item as Caption;
      if (box && !overlaps(box, captionBox(c, W, H), margin)) continue;
      out.push({ kind: 'caption', id: r.id, label: `${ja ? '字幕' : 'caption'} ${r.id}${paren(q(c.text))}` });
    } else if (r.kind === 'overlay') {
      const o = r.item as Overlay;
      if (box && !overlaps(box, overlayBox(o, W, H), margin)) continue;
      out.push({ kind: 'overlay', id: r.id, label: `${ja ? 'オーバーレイ' : 'overlay'} ${r.id}${paren(`${o.kind}${'text' in o ? (ja ? '' : ' ') + q(o.text) : ''}`)}` });
    } else if (r.kind === 'segment') {
      const sg = r.item as Segment;
      out.push({ kind: 'segment', id: r.id, label: `${ja ? '区間' : 'segment'} ${r.id}${paren(`${ja ? 'レイアウト' : 'layout'} ${sg.video.layout}${sg.text ? `${ja ? '、' : ', '}${q(sg.text)}` : ''}`)}` });
    } else if (r.kind === 'scene') {
      out.push({ kind: 'scene', id: r.id, label: `${ja ? 'シーン' : 'scene'} ${r.id}${paren((r.item as { pattern: { id: string } }).pattern.id)}` });
    }
  }
  return out.sort((a, b) => ['caption', 'overlay', 'scene', 'segment'].indexOf(a.kind) - ['caption', 'overlay', 'scene', 'segment'].indexOf(b.kind));
}

// ---------- output ----------

/** Strokes as an ASS drawing over a W×H frame (a back-and-forth path keeps an open polyline unfilled). */
export function strokesAss(strokes: Stroke[], W: number, H: number): string {
  const header = assHeader({ width: W, height: H }, [assStyleLine({ name: 'Pen', font: 'Arial', size: 10, primary: '#FF3B3000', outline: '#FF3B30', outlineWidth: 4, alignment: 7 })]);
  const fps = { num: 1, den: 1 };
  const ev = strokes.filter((s) => s.points.length).map((s) => {
    const pts = s.points.map(([x, y]) => [Math.round(x * W), Math.round(y * H)] as const);
    const fwd = pts.map(([x, y]) => `${x} ${y}`);
    const path = pts.length === 1 ? `m ${fwd[0]} l ${pts[0]![0] + 1} ${pts[0]![1]}` : `m ${fwd[0]} l ${[...fwd.slice(1), ...fwd.slice(0, -1).reverse()].join(' ')}`;
    const width = Math.max(2, Math.round((s.width ?? 0.005) * Math.min(W, H)));
    const color = /^#[0-9a-f]{6}$/i.test(s.color ?? '') ? s.color! : '#FF3B30';
    const c = `&H${color.slice(5, 7)}${color.slice(3, 5)}${color.slice(1, 3)}&`.toUpperCase();
    return assDialogue(0, 0, 3600, fps, 'Pen', `{\\pos(0,0)\\an7\\bord${width}\\3c${c}\\1a&HFF&\\p1}${path}{\\p0}`);
  });
  return `${header}\n${ev.join('\n')}\n`;
}

export function feedbackMarkdown(id: string, items: FeedbackItem[], tl: Timeline, lang: 'ja' | 'en'): string {
  const ja = lang === 'ja';
  const fps = tl.canvas.fps;
  const lines = [`# ${ja ? 'フィードバック' : 'Feedback'} ${id}`, ''];
  lines.push(ja
    ? '指摘ごとに対応してください。対象の要素は `ferret-video tl show <id>` で確認し、直しは `ferret-video edit` で（decided.feedbackRef に ' + `${id}` + ' を入れる）。終わったら `ferret-video render --preview` と `ferret-video check`、そして `ferret-video feedback done ' + `${id}` + '`。'
    : 'Address each item. Inspect targets with `ferret-video tl show <id>`, fix with `ferret-video edit` (set decided.feedbackRef to ' + `${id}` + '). Then `ferret-video render --preview`, `ferret-video check` and `ferret-video feedback done ' + `${id}` + '`.');
  lines.push('');
  for (const it of items) {
    const nn = String(it.index).padStart(2, '0');
    const heading = it.title ?? (it.speech ? short(it.speech, 28) : it.notes[0] ? short(it.notes[0], 28) : ja ? '（ペンの囲みのみ）' : '(pen only)');
    lines.push(`## ${it.index}. [${frameToTimecode(it.frame, fps)}] ${heading}`);
    lines.push(`- ${ja ? '要望' : 'Request'}: ${it.request ?? (ja ? '（未整理）発話と画像をもとに対応してください' : '(not organized) act on the speech and the image')}`);
    if (it.speech) lines.push(`- ${ja ? '発話（原文）' : 'Speech (verbatim)'}: 「${it.speech}」`);
    for (const n of it.notes) lines.push(`- ${ja ? 'メモ' : 'Note'}: ${n}`);
    lines.push(`- ${ja ? '画像' : 'Image'}: ./${nn}.png${it.strokes.length ? (ja ? '（ペンの囲み入り）' : ' (with pen strokes)') : ''}`);
    lines.push(`- ${ja ? '対象' : 'Targets'}: ${it.targets.length ? it.targets.map((x) => x.label).join('、') : ja ? '（特定できませんでした）' : '(none found)'}`);
    lines.push(`- ${ja ? 'フレーム' : 'Frame'}: ${it.frame}`);
    lines.push('');
  }
  return lines.join('\n');
}
