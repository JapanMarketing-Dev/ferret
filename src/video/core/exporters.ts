// Export to other editors (docs/12): OpenTimelineIO JSON, FCPXML 1.11 (Final Cut Pro / DaVinci Resolve), CMX3600 EDL.
// Pure: paths are written as given, or as file:// URLs when `projectDir` (absolute) is passed.
import { voiceSource } from './compile.js';
import type { Frame, Rational, Source, Timeline } from './schema.js';
import { fpsValue, frameToTimecode, nominalFps } from './time.js';
import { durationFrames, sourceLocalSeconds, takeFrameToSeconds } from './timeline.js';

export interface ExportOptions {
  /** Absolute project folder: media paths become file:// URLs (editors need absolute paths). */
  projectDir?: string;
  /** Captions sidecar to reference (e.g. "captions/main.srt", relative to the project). */
  srtPath?: string;
  /** Sequence / project name (default: meta.title). */
  name?: string;
}

/** One clip on a track: timeline range and the source range it plays. */
interface Placed { segment: string; source: string; track: 'V1' | 'V2' | 'A1'; start: Frame; end: Frame; srcStartSec: number; srcDurSec: number }

function absUrl(path: string, o: ExportOptions): string {
  if (/^[a-z]+:\/\//i.test(path)) return path;
  const isAbs = path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path);
  const full = isAbs ? path : o.projectDir ? `${o.projectDir.replace(/[\\/]+$/, '')}/${path}` : path;
  if (!o.projectDir && !isAbs) return full;
  const norm = full.replace(/\\/g, '/');
  return `file://${norm.startsWith('/') ? '' : '/'}${norm.split('/').map((p, i) => (i === 0 && /^[A-Za-z]:$/.test(p) ? p : encodeURIComponent(p))).join('/')}`;
}

/** Clips per track: V1 = main picture, V2 = the inset (wipe camera / split-v bottom), A1 = voice. */
export function exportClips(t: Timeline): Placed[] {
  const F = fpsValue(t.canvas.fps);
  const out: Placed[] = [];
  for (const seg of t.segments) {
    const a = takeFrameToSeconds(t, seg.src.take, seg.src.from);
    const b = takeFrameToSeconds(t, seg.src.take, seg.src.to);
    const place = (source: string, track: Placed['track']) => {
      const src = t.sources[source];
      if (!src) return;
      const la = sourceLocalSeconds(t, src, a);
      const lb = sourceLocalSeconds(t, src, b);
      out.push({ segment: seg.id, source, track, start: seg.range.start, end: seg.range.end, srcStartSec: Math.max(0, la), srcDurSec: Math.max(1 / F, lb - la) });
    };
    const v = seg.video;
    if (v.layout === 'camera-full') place(v.camera, 'V1');
    else if (v.layout === 'screen-full') place(v.screen, 'V1');
    else if (v.layout === 'screen-with-wipe') { place(v.screen, 'V1'); place(v.camera, 'V2'); }
    else if (v.layout === 'split-v') { place(v.top, 'V1'); place(v.bottom, 'V2'); }
    const voice = voiceSource(t, seg);
    if (voice) place(voice, 'A1');
  }
  return out;
}

const sourceRate = (s: Source, fallback: Rational): number => (s.kind === 'screen' || s.kind === 'camera' ? fpsValue(s.fps) : fpsValue(fallback));
const fileName = (p: string) => p.split(/[\\/]/).pop() ?? p;

/** Chapters, markers (and, for reference, caption count) as timeline points. */
function timelineMarkers(t: Timeline): { at: Frame; dur: Frame; label: string; kind: 'chapter' | 'ng' | 'important' | 'note' }[] {
  const out: { at: Frame; dur: Frame; label: string; kind: 'chapter' | 'ng' | 'important' | 'note' }[] = [];
  for (const c of t.outline) out.push({ at: c.start, dur: 1, label: c.title, kind: 'chapter' });
  for (const m of t.markers) {
    if (m.kind === 'chapter') { if (!t.outline.some((c) => c.start === m.at)) out.push({ at: m.at, dur: 1, label: m.label, kind: 'chapter' }); }
    else if (m.kind === 'note') out.push({ at: m.at, dur: 1, label: m.text, kind: 'note' });
    else out.push({ at: m.at, dur: 1, label: m.kind === 'ng' ? 'NG' : 'Important', kind: m.kind });
  }
  return out.sort((a, b) => a.at - b.at);
}

// ---------- OpenTimelineIO ----------

const rt = (value: number, rate: number) => ({ OTIO_SCHEMA: 'RationalTime.1', rate, value: Math.round(value * 1e6) / 1e6 });
const tr = (start: number, dur: number, rate: number) => ({ OTIO_SCHEMA: 'TimeRange.1', start_time: rt(start, rate), duration: rt(dur, rate) });

/** OpenTimelineIO (.otio JSON): a Stack with V1, V2 (insets) and A1 tracks; chapters/markers as markers on the stack. */
export function toOtio(t: Timeline, o: ExportOptions = {}): object {
  const fps = fpsValue(t.canvas.fps);
  const clips = exportClips(t);
  const total = durationFrames(t);
  const track = (name: string, kind: 'Video' | 'Audio', placed: Placed[]) => {
    const children: object[] = [];
    let at = 0;
    for (const p of placed.sort((a, b) => a.start - b.start)) {
      if (p.start > at) children.push({ OTIO_SCHEMA: 'Gap.1', name: '', source_range: tr(0, p.start - at, fps), effects: [], markers: [], metadata: {} });
      const src = t.sources[p.source]!;
      const rate = sourceRate(src, t.canvas.fps);
      children.push({
        OTIO_SCHEMA: 'Clip.2',
        name: `${p.segment} (${p.source})`,
        source_range: tr(p.srcStartSec * rate, (p.end - p.start) / fps * rate, rate),
        media_references: {
          DEFAULT_MEDIA: {
            OTIO_SCHEMA: 'ExternalReference.1', name: fileName(src.path), target_url: absUrl(src.path, o), metadata: {},
            available_range: 'durationFrames' in src && src.durationFrames !== undefined ? tr(0, src.durationFrames, rate) : null,
          },
        },
        active_media_reference_key: 'DEFAULT_MEDIA',
        effects: [], markers: [], enabled: true,
        metadata: { ferret: { segment: p.segment, source: p.source } },
      });
      at = p.end;
    }
    if (at < total) children.push({ OTIO_SCHEMA: 'Gap.1', name: '', source_range: tr(0, total - at, fps), effects: [], markers: [], metadata: {} });
    return { OTIO_SCHEMA: 'Track.1', name, kind, children, source_range: null, effects: [], markers: [], enabled: true, metadata: {} };
  };
  const colors = { chapter: 'PURPLE', ng: 'RED', important: 'YELLOW', note: 'GREEN' } as const;
  return {
    OTIO_SCHEMA: 'Timeline.1',
    name: o.name ?? t.meta.title,
    global_start_time: rt(0, fps),
    metadata: { ferret: { schema: t.schema, template: t.meta.template, canvas: { width: t.canvas.width, height: t.canvas.height }, ...(o.srtPath ? { captions: o.srtPath } : {}) } },
    tracks: {
      OTIO_SCHEMA: 'Stack.1', name: 'tracks', source_range: null, effects: [], enabled: true, metadata: {},
      markers: timelineMarkers(t).map((m) => ({ OTIO_SCHEMA: 'Marker.2', name: m.label, color: colors[m.kind], marked_range: tr(m.at, m.dur, fps), comment: '', metadata: { ferret: { kind: m.kind } } })),
      children: [
        track('V1', 'Video', clips.filter((c) => c.track === 'V1')),
        track('V2', 'Video', clips.filter((c) => c.track === 'V2')),
        track('A1', 'Audio', clips.filter((c) => c.track === 'A1')),
      ],
    },
  };
}

// ---------- FCPXML 1.11 ----------

const xmlEsc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function gcd(a: number, b: number): number {
  a = Math.abs(a); b = Math.abs(b);
  while (b) [a, b] = [b, a % b];
  return a || 1;
}

/** FCPXML rational time for a frame count at a rate: "N/Ds" (reduced), "0s" for zero. */
export function fcpTime(frames: number, fps: Rational): string {
  if (frames === 0) return '0s';
  const n = Math.round(frames) * fps.den;
  const d = fps.num;
  const g = gcd(n, d);
  return d / g === 1 ? `${n / g}s` : `${n / g}/${d / g}s`;
}

/**
 * FCPXML 1.11 (Final Cut Pro, DaVinci Resolve): format + one asset per media file (with media-rep src and duration,
 * which Resolve requires), a sequence whose spine holds V1 clips; insets as connected clips (lane 1), voice as
 * connected audio (lane -1); chapters as chapter-markers, markers as markers; scene segments as gaps.
 */
export function toFcpxml(t: Timeline, o: ExportOptions = {}): string {
  const fps = t.canvas.fps;
  const F = fpsValue(fps);
  const clips = exportClips(t);
  const total = durationFrames(t);
  const r = nominalFps(fps);
  const fmtName = `FFVideoFormat${t.canvas.height}p${fps.den === 1 ? r : F.toFixed(2).replace('.', '')}`;
  // assets: one per source used; duration = known length or the furthest use (in timeline frames)
  const used = [...new Set(clips.map((c) => c.source))].sort();
  const assetId = new Map(used.map((s, i) => [s, `r${i + 2}`]));
  const assetLen = (id: string): number => {
    const s = t.sources[id]!;
    if ((s.kind === 'screen' || s.kind === 'camera') && s.durationFrames !== undefined) return Math.round((s.durationFrames / fpsValue(s.fps)) * F);
    return Math.ceil(Math.max(...clips.filter((c) => c.source === id).map((c) => (c.srcStartSec + c.srcDurSec) * F)) + F);
  };
  const resources = [
    `<format id="r1" name="${fmtName}" frameDuration="${fcpTime(1, fps)}" width="${t.canvas.width}" height="${t.canvas.height}" colorSpace="1-1-1 (Rec. 709)"/>`,
    ...used.map((id) => {
      const s = t.sources[id]!;
      const video = s.kind === 'screen' || s.kind === 'camera';
      const audio = s.kind === 'mic' || (video && s.audio !== false) || s.kind === 'asset';
      return `<asset id="${assetId.get(id)}" name="${xmlEsc(id)}" uid="ferret-${xmlEsc(id)}" start="0s" duration="${fcpTime(assetLen(id), fps)}" hasVideo="${video ? 1 : 0}" hasAudio="${audio ? 1 : 0}"${video ? ' format="r1"' : ''}${audio ? ' audioSources="1" audioChannels="2" audioRate="48000"' : ''}>`
        + `<media-rep kind="original-media" src="${xmlEsc(absUrl(s.path, o))}"/></asset>`;
    }),
  ];
  const marks = timelineMarkers(t);
  /** Spine clips sit at their timeline offset; connected clips (lane) at the parent's local time `offset`. */
  const clipXml = (p: Placed, at: { lane?: number; offset: number }): string => {
    const startF = Math.round(p.srcStartSec * F);
    const dur = p.end - p.start;
    const laneAttr = at.lane !== undefined ? ` lane="${at.lane}"` : '';
    const offset = at.offset;
    return `<asset-clip ref="${assetId.get(p.source)}"${laneAttr} name="${xmlEsc(`${p.segment} ${p.source}`)}" offset="${fcpTime(offset, fps)}" start="${fcpTime(startF, fps)}" duration="${fcpTime(dur, fps)}" tcFormat="NDF"${p.track === 'A1' ? ' audioRole="dialogue"' : ''}/>`;
  };
  const spine: string[] = [];
  for (const seg of t.segments) {
    const main = clips.find((c) => c.segment === seg.id && c.track === 'V1');
    const inner: string[] = [];
    const parentStart = main ? Math.round(main.srcStartSec * F) : 0;
    for (const c of clips.filter((x) => x.segment === seg.id && x.track !== 'V1')) {
      // connected clips start with their parent: offset = the parent's local start time
      inner.push(clipXml(c, { lane: c.track === 'V2' ? 1 : -1, offset: main ? parentStart : 0 }));
    }
    for (const m of marks.filter((x) => x.at >= seg.range.start && x.at < seg.range.end)) {
      const local = fcpTime(parentStart + (m.at - seg.range.start), fps);
      inner.push(m.kind === 'chapter'
        ? `<chapter-marker start="${local}" duration="${fcpTime(1, fps)}" value="${xmlEsc(m.label)}" posterOffset="0s"/>`
        : `<marker start="${local}" duration="${fcpTime(1, fps)}" value="${xmlEsc(m.label)}"${m.kind === 'ng' ? ' completed="0"' : ''}/>`);
    }
    if (main) {
      const head = clipXml(main, { offset: main.start }).replace(/\/>$/, inner.length ? '>' : '/>');
      spine.push(inner.length ? `${head}${inner.join('')}</asset-clip>` : head);
    } else {
      spine.push(`<gap name="${xmlEsc(seg.id)}" offset="${fcpTime(seg.range.start, fps)}" start="0s" duration="${fcpTime(seg.range.end - seg.range.start, fps)}">${inner.join('')}</gap>`);
    }
  }
  const name = xmlEsc(o.name ?? t.meta.title);
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE fcpxml>',
    '<fcpxml version="1.11">',
    `<resources>${resources.join('')}</resources>`,
    `<library><event name="Ferret"><project name="${name}">`,
    `<sequence format="r1" duration="${fcpTime(total, fps)}" tcStart="0s" tcFormat="NDF" audioLayout="stereo" audioRate="48k">`,
    `<spine>${spine.join('')}</spine>`,
    '</sequence></project></event></library>',
    '</fcpxml>',
    '',
  ].join('\n');
}

// ---------- CMX3600 EDL ----------

/**
 * CMX3600 EDL of the main picture track (V1) with the voice as an audio event when it comes from another file.
 * Source timecodes are source-local times at the timeline rate (non-drop). Reels are named AX with
 * `* FROM CLIP NAME:` comments; chapters and markers become `* LOC:` lines.
 */
export function toEdl(t: Timeline, o: ExportOptions = {}): string {
  const fps = t.canvas.fps;
  const F = fpsValue(fps);
  const lines = [`TITLE: ${(o.name ?? t.meta.title).replace(/[\r\n]/g, ' ').slice(0, 70)}`, 'FCM: NON-DROP FRAME', ''];
  let n = 0;
  const tc = (f: number) => frameToTimecode(Math.max(0, Math.round(f)), fps);
  const clips = exportClips(t);
  for (const seg of t.segments) {
    const v = clips.find((c) => c.segment === seg.id && c.track === 'V1');
    const a = clips.find((c) => c.segment === seg.id && c.track === 'A1');
    const recIn = tc(seg.range.start);
    const recOut = tc(seg.range.end);
    const event = (c: Placed | undefined, kind: 'V' | 'A' | 'B') => {
      n++;
      const num = String(n).padStart(3, '0');
      if (!c) {
        lines.push(`${num}  BL       ${kind}     C        00:00:00:00 ${tc(seg.range.end - seg.range.start)} ${recIn} ${recOut}`);
        return;
      }
      const sIn = c.srcStartSec * F;
      const sOut = sIn + (seg.range.end - seg.range.start);
      lines.push(`${num}  AX       ${kind.padEnd(5)} C        ${tc(sIn)} ${tc(sOut)} ${recIn} ${recOut}`);
      lines.push(`* FROM CLIP NAME: ${fileName(t.sources[c.source]!.path)}`);
      lines.push(`* FERRET SEGMENT: ${seg.id}`);
    };
    if (v && a && a.source === v.source) event(v, 'B');
    else {
      event(v, 'V');
      if (a) event(a, 'A');
    }
  }
  const colors = { chapter: 'PURPLE', ng: 'RED', important: 'YELLOW', note: 'GREEN' } as const;
  if (timelineMarkers(t).length) lines.push('');
  for (const m of timelineMarkers(t)) lines.push(`* LOC: ${tc(m.at)} ${colors[m.kind]} ${m.label.replace(/[\r\n]/g, ' ')}`);
  if (o.srtPath) lines.push(`* CAPTIONS: ${o.srtPath}`);
  return `${lines.join('\n')}\n`;
}

// ---------- YouTube chapters ----------

export interface DescriptionChapters {
  ok: boolean;
  /** "0:00 Title" lines (empty when !ok). */
  text: string;
  chapters: { start: Frame; label: string; stamp: string }[];
  /** What was adjusted or why chapters cannot be used. */
  notes: string[];
}

/**
 * YouTube chapter lines for a description: at least 3 chapters, the first at 0:00, each at least 10 s long.
 * Uses the outline (else chapter markers); snaps the first chapter to 0:00 and merges chapters shorter than
 * `minSec` (default 10) into the previous one. `ok: false` when fewer than 3 remain.
 */
export function chaptersForDescription(t: Timeline, o: { minSec?: number } = {}): DescriptionChapters {
  const F = fpsValue(t.canvas.fps);
  const total = durationFrames(t);
  const minF = Math.round((o.minSec ?? 10) * F);
  const notes: string[] = [];
  let ch: { start: Frame; label: string }[] = t.outline.length
    ? [...t.outline].sort((a, b) => a.start - b.start).map((c) => ({ start: c.start, label: c.title }))
    : t.markers.filter((m): m is Extract<typeof m, { kind: 'chapter' }> => m.kind === 'chapter').sort((a, b) => a.at - b.at).map((m) => ({ start: m.at, label: m.label }));
  ch = ch.filter((c) => c.start < total && c.label.trim() !== '');
  if (ch.length && ch[0]!.start !== 0) {
    notes.push(`first chapter moved from ${frameToTimecode(ch[0]!.start, t.canvas.fps)} to 0:00`);
    ch[0] = { ...ch[0]!, start: 0 };
  }
  const merged: typeof ch = [];
  ch.forEach((c, i) => {
    const end = ch[i + 1]?.start ?? total;
    if (end - c.start < minF && merged.length) {
      notes.push(`"${c.label}" is shorter than ${o.minSec ?? 10} s: merged into "${merged[merged.length - 1]!.label}"`);
      return;
    }
    if (merged.length && c.start - merged[merged.length - 1]!.start < minF) {
      notes.push(`"${merged[merged.length - 1]!.label}" is shorter than ${o.minSec ?? 10} s: replaced by "${c.label}"`);
      merged[merged.length - 1] = { start: merged[merged.length - 1]!.start, label: c.label };
      return;
    }
    merged.push(c);
  });
  const long = total / F >= 3600;
  const stamp = (f: Frame) => {
    const s = Math.floor(f / F);
    const h = Math.floor(s / 3600);
    const m = Math.floor(s / 60) % 60;
    const ss = String(s % 60).padStart(2, '0');
    return long ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${Math.floor(s / 60)}:${ss}`;
  };
  const chapters = merged.map((c) => ({ start: c.start, label: c.label.replace(/[\r\n]+/g, ' ').trim(), stamp: stamp(c.start) }));
  if (chapters.length < 3) {
    notes.push(`YouTube needs at least 3 chapters of ${o.minSec ?? 10} s or more (${chapters.length} usable)`);
    return { ok: false, text: '', chapters, notes };
  }
  return { ok: true, text: chapters.map((c) => `${c.stamp} ${c.label}`).join('\n'), chapters, notes };
}

